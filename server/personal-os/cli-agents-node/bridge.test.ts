import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliOp, CliOpArgs, DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { TERM_INPUT, TERM_OUTPUT, decodeTermFrame, encodeTermFrame } from "../../../shared/cli-agent-frames.ts";
import { CliAgentBridge, type CliAgentBridgeOptions } from "./bridge.ts";
import { FakeHc } from "./fake-hc.ts";
import type { CommandRunner } from "./liveness.ts";
import type { OpenLocalPlan } from "./open-local.ts";

const CID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const XID = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const LSTART = "Sun Nov 15 09:00:00 2026";
const run: CommandRunner = async (_file, args) => ({ code: 0, stdout: args[args.length - 1].split(",").map((p) => `${p} ${LSTART}`).join("\n") });

let root: string;
let dataDir: string;
let claudeDir: string;
let codexHome: string;
let workDir: string;
let hc: FakeHc;
const bridges: CliAgentBridge[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "cli-bridge-"));
  dataDir = path.join(root, "data");
  claudeDir = path.join(root, "claude");
  codexHome = path.join(root, "codex");
  workDir = path.join(root, "work");
  for (const dir of [dataDir, claudeDir, codexHome, workDir]) mkdirSync(dir, { recursive: true });
  hc = new FakeHc();
});
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.detach();
  rmSync(root, { recursive: true, force: true });
});

function claudeTranscript(id: string, text: string, ageMs = 60_000, cwd = workDir): string {
  const folder = path.join(claudeDir, "projects", "proj");
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  writeFileSync(
    file,
    JSON.stringify({ type: "user", uuid: `u-${id.slice(-4)}`, timestamp: new Date(Date.now() - ageMs).toISOString(), cwd, message: { role: "user", content: text } }) + "\n",
  );
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(file, mtime, mtime);
  return file;
}

function claudeLive(pid: number, id: string, status: string): void {
  mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
  writeFileSync(path.join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: workDir, entrypoint: "cli", status, procStart: LSTART, updatedAt: Date.now() }));
}

function codexRollout(id: string, text: string, ageMs = 3_600_000, cwd = workDir): string {
  const day = new Date(Date.now() - ageMs);
  const folder = path.join(codexHome, "sessions", String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0"));
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `rollout-2026-11-15T10-00-00-${id}.jsonl`);
  const at = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(
    file,
    [
      JSON.stringify({ timestamp: at, type: "session_meta", payload: { id, cwd, originator: "codex_cli_rs", source: "cli", cli_version: "0.99.0" } }),
      JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "user_message", message: text } }),
    ].join("\n") + "\n",
  );
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(file, mtime, mtime);
  return file;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function setup(extra: Partial<CliAgentBridgeOptions> = {}, options: { writer?: "yes" | "no" | "unknown" } = {}) {
  const messages: DeviceCliMessage[] = [];
  const frames: Uint8Array[] = [];
  const launched: OpenLocalPlan[] = [];
  const bridge = new CliAgentBridge({
    dir: dataDir,
    hc,
    binary: path.resolve("C:\\fake\\herdr-core\\herdr-core.exe"),
    claudeDirs: [claudeDir],
    codexHomes: [codexHome],
    discovery: { claudeLive: { isAlive: () => true, start: { platform: "linux", run } }, codex: { writer: () => options.writer ?? "no" }, coalesceMs: 0, liveMs: 50, historyMs: 100 },
    resolveCli: async (engine) => `/fake/bin/${engine}`,
    cliVersion: async () => "9.9.9",
    homedir: path.join(root, "home"),
    launcher: async (plan) => void launched.push(plan),
    hasWindowsTerminal: false,
    rowWaitMs: 500,
    settleMs: 1000,
    readerPollMs: 40,
    coalesceMs: 5,
    // the exact-argv tests below run without the Claude plugin; the hook tests turn it on
    pluginDir: null,
    ...extra,
  });
  bridges.push(bridge);
  const link = {
    json: (message: DeviceCliMessage) => (messages.push(message), true),
    binary: (frame: Uint8Array) => (frames.push(frame), true),
  };
  let counter = 0;
  const call = async <K extends CliOp>(op: K, args: CliOpArgs[K], opId = `op-${++counter}`, deadlineMs = 10_000) => {
    bridge.handle({ type: "cli.op", opId, op, args, deadlineMs });
    await until(() => messages.some((m) => m.type === "cli.reply" && m.opId === opId));
    return messages.filter((m) => m.type === "cli.reply" && m.opId === opId).at(-1) as Extract<DeviceCliMessage, { type: "cli.reply" }>;
  };
  const sessions = () => bridge.sessions();
  const start = async () => {
    await bridge.prepare();
    bridge.setScope("https://core.test", "ws-1");
    bridge.link(link);
    await until(() => messages.some((m) => m.type === "cli.sessions"));
  };
  return { bridge, messages, frames, launched, link, call, sessions, start };
}

/** The CLI writes its transcript as soon as it starts. */
function claudeWritesTranscript(): void {
  hc.onRun = (terminal) => {
    const index = terminal.argv.findIndex((arg) => arg === "--session-id" || arg === "--resume");
    const id = terminal.argv[index + 1];
    if (terminal.argv.includes("--session-id")) claudeTranscript(id, "new session", 0, terminal.cwd);
  };
}

describe("capability and first report", () => {
  it("reports the engines found and sends every session once linked", async () => {
    claudeTranscript(CID(1), "hello claude");
    codexRollout(XID(1), "hello codex");
    const t = setup();
    await t.bridge.prepare();
    expect(t.bridge.capability()).toMatchObject({ version: 1, engines: ["claude", "codex"], terminal: { name: "herdr-core", ready: true } });
    expect(t.bridge.state().engines).toEqual([
      { engine: "claude", version: "9.9.9" },
      { engine: "codex", version: "9.9.9" },
    ]);
    await t.start();
    const first = t.messages.find((m) => m.type === "cli.sessions") as Extract<DeviceCliMessage, { type: "cli.sessions" }>;
    expect(first.full).toBe(true);
    expect(first.upserts.map((row) => `${row.engine}:${row.nativeId}`).sort()).toEqual([`claude:${CID(1)}`, `codex:${XID(1)}`]);
    expect(first.upserts.every((row) => row.state === "stopped")).toBe(true);
    // herdr-core starts in the background after the link is up
    await until(() => hc.starts > 0);
    expect(hc.subscribes).toBe(1);
  });

  it("says herdr-core is missing when it is not installed", async () => {
    const t = setup({ hc: undefined, binary: null });
    await t.bridge.prepare();
    expect(t.bridge.capability().terminal).toMatchObject({ ready: false });
    expect(t.bridge.state().hc).toBe("error");
    await t.start();
    const reply = await t.call("start", { engine: "claude", cwd: workDir });
    expect(reply).toMatchObject({ ok: false, error: { code: "hc_unavailable" } });
  });

  it("leaves out an engine that is not installed", async () => {
    const t = setup({ resolveCli: async (engine) => (engine === "codex" ? "/fake/bin/codex" : null) });
    await t.bridge.prepare();
    expect(t.bridge.capability().engines).toEqual(["codex"]);
    await t.start();
    expect(await t.call("start", { engine: "claude", cwd: workDir })).toMatchObject({ ok: false, error: { code: "cli_missing" } });
  });

  it("scopes the herdr-core session to the Core and workspace", async () => {
    const seen: string[] = [];
    const t = setup({
      hc: (scope) => {
        seen.push(`${scope.session}|${scope.socket}`);
        return hc;
      },
    });
    await t.start();
    await until(() => seen.length > 0);
    expect(seen[0]).toMatch(/^nexbot-[0-9a-f]{8}\|\\\\\.\\pipe\\nexbot-hc-[0-9a-f]{8}$|^nexbot-[0-9a-f]{8}\|.*[/\\]hc[/\\][0-9a-f]{8}\.sock$/);
  });

  it("puts the herdr-core socket under the data directory, or in the temp directory when that is too long", async () => {
    const scopes: Array<{ session: string; socket: string }> = [];
    const short = setup({ platform: "linux", hc: (scope) => (scopes.push(scope), hc) });
    await short.start();
    await until(() => scopes.length > 0);
    const hash = scopes[0].session.slice("nexbot-".length);
    const inData = `${dataDir.replace(/\\/g, "/")}/hc/${hash}.sock`;
    // a temp directory path decides which side of the 100 byte limit this lands on
    if (Buffer.byteLength(inData) <= 100) expect(scopes[0].socket).toBe(inData);
    else expect(scopes[0].socket).toBe(`${os.tmpdir().replace(/\\/g, "/")}/nexbot-hc-${hash}.sock`);

    const longDir = path.join(root, "a-rather-long-directory-name-".repeat(4));
    mkdirSync(longDir, { recursive: true });
    const far: Array<{ session: string; socket: string }> = [];
    const second = setup({ platform: "linux", dir: longDir, hc: (scope) => (far.push(scope), hc) });
    await second.start();
    await until(() => far.length > 0);
    expect(far[0].socket).toBe(`${os.tmpdir().replace(/\\/g, "/")}/nexbot-hc-${hash}.sock`);
  });
});

describe("read and watch", () => {
  it("pages a transcript and streams new items while watched", async () => {
    const file = claudeTranscript(CID(1), "first question");
    const t = setup();
    await t.start();
    const read = await t.call("read", { ref: `claude:${CID(1)}` });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read.result)).toContain("first question");

    expect(await t.call("watch", { ref: `claude:${CID(1)}` })).toMatchObject({ ok: true });
    const initial = t.messages.find((m) => m.type === "cli.items") as Extract<DeviceCliMessage, { type: "cli.items" }>;
    expect(initial).toMatchObject({ ref: `claude:${CID(1)}`, reset: true });
    expect(JSON.stringify(initial.items)).toContain("first question");

    t.messages.length = 0;
    appendFileSync(
      file,
      JSON.stringify({ type: "assistant", uuid: "a-1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } }) + "\n",
    );
    await until(() => t.messages.some((m) => m.type === "cli.items" && JSON.stringify(m.items).includes("second answer")));

    expect(await t.call("unwatch", { ref: `claude:${CID(1)}` })).toMatchObject({ ok: true });
    t.messages.length = 0;
    appendFileSync(file, JSON.stringify({ type: "user", uuid: "u-2", timestamp: new Date().toISOString(), message: { role: "user", content: "third" } }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(t.messages.filter((m) => m.type === "cli.items")).toEqual([]);
  });

  it("answers not_found for an unknown session and invalid for a garbled message", async () => {
    const t = setup();
    await t.start();
    expect(await t.call("read", { ref: `claude:${CID(9)}` })).toMatchObject({ ok: false, error: { code: "not_found" } });
    t.bridge.handle({ type: "cli.op", opId: "bad-1", op: "read", args: { ref: 42 }, deadlineMs: 1000 });
    await until(() => t.messages.some((m) => m.type === "cli.reply" && m.opId === "bad-1"));
    expect(t.messages.find((m) => m.type === "cli.reply" && m.opId === "bad-1")).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("answers not_found to an answer when no hook waits (hooks off)", async () => {
    const t = setup();
    await t.start();
    expect(await t.call("answer", { id: "x", decision: "allow" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("start", () => {
  it("starts a Claude session in a labelled terminal and lists it as running in nex_bot", async () => {
    claudeWritesTranscript();
    const t = setup();
    await t.start();
    const reply = await t.call("start", { engine: "claude", cwd: workDir, cols: 100, rows: 30 });
    expect(reply.ok).toBe(true);
    const result = reply.result as { ref: string; terminal: string };
    expect(result.ref).toMatch(/^claude:[0-9a-f-]{36}$/);
    const terminal = hc.terminals.get(result.terminal)!;
    expect(terminal.argv).toEqual(["/fake/bin/claude", "--session-id", result.ref.slice("claude:".length)]);
    expect(terminal.cwd).toBe(path.resolve(workDir));
    expect(terminal.labels).toEqual({ nexbot: "1", "nexbot.engine": "claude", "nexbot.native": result.ref.slice("claude:".length) });
    expect(hc.runs[0]).toMatchObject({ size: { cols: 100, rows: 30 }, keep: false });
    expect(t.sessions().find((row) => `claude:${row.nativeId}` === result.ref)).toMatchObject({ liveIn: "nexbot", terminal: result.terminal, state: "idle" });
  });

  it("answers a re-sent opId from the stored reply without starting again", async () => {
    claudeWritesTranscript();
    const t = setup();
    await t.start();
    const first = await t.call("start", { engine: "claude", cwd: workDir }, "same-op");
    t.messages.length = 0;
    t.bridge.handle({ type: "cli.op", opId: "same-op", op: "start", args: { engine: "claude", cwd: workDir }, deadlineMs: 10_000 });
    await until(() => t.messages.some((m) => m.type === "cli.reply"));
    expect(t.messages.find((m) => m.type === "cli.reply")).toEqual(first);
    expect(hc.runs).toHaveLength(1);
  });

  it("starts once when the same opId arrives twice while it is running", async () => {
    claudeWritesTranscript();
    hc.runDelayMs = 80;
    const t = setup();
    await t.start();
    const args = { engine: "claude" as const, cwd: workDir };
    t.bridge.handle({ type: "cli.op", opId: "dup", op: "start", args, deadlineMs: 10_000 });
    t.bridge.handle({ type: "cli.op", opId: "dup", op: "start", args, deadlineMs: 10_000 });
    await until(() => t.messages.filter((m) => m.type === "cli.reply").length === 2);
    expect(hc.runs).toHaveLength(1);
    const replies = t.messages.filter((m) => m.type === "cli.reply");
    expect(replies[0]).toEqual(replies[1]);
  });

  it("refuses a missing working directory", async () => {
    const t = setup();
    await t.start();
    const reply = await t.call("start", { engine: "claude", cwd: path.join(root, "nope") });
    expect(reply).toMatchObject({ ok: false, error: { code: "cwd_missing" } });
    expect(hc.runs).toHaveLength(0);
  });

  it("retries once with a new name when herdr-core says the name is taken", async () => {
    claudeWritesTranscript();
    const t = setup();
    await t.start();
    const original = hc.run.bind(hc);
    let calls = 0;
    hc.run = async (params) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("taken"), { kind: "name_taken" });
      return original(params);
    };
    const reply = await t.call("start", { engine: "claude", cwd: workDir });
    expect(reply.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("reports hc_unavailable when herdr-core cannot start", async () => {
    const { HcError } = await import("./hc.ts");
    hc.unavailable = new HcError("hc_unavailable", "no server");
    const t = setup();
    await t.start();
    expect(await t.call("start", { engine: "claude", cwd: workDir })).toMatchObject({ ok: false, error: { code: "hc_unavailable" } });
    expect(t.bridge.state().hc).toBe("error");
  });
});

describe("Codex session mapping", () => {
  it("claims the new rollout in the same directory, not an older session or another directory", async () => {
    codexRollout(XID(1), "old session in the same directory", 3_600_000);
    const other = path.join(root, "other");
    mkdirSync(other);
    const t = setup();
    await t.start();
    hc.onRun = (_terminal, params) => {
      setTimeout(() => {
        codexRollout(XID(7), "wrong directory", 0, other);
        codexRollout(XID(2), "the new one", 0, params.cwd);
      }, 60);
    };
    const reply = await t.call("start", { engine: "codex", cwd: workDir });
    expect(reply.ok).toBe(true);
    const result = reply.result as { ref: string; terminal: string };
    expect(result.ref).toBe(`codex:${XID(2)}`);
    expect(hc.terminals.get(result.terminal)!.argv).toEqual(["/fake/bin/codex"]);
    expect(hc.terminals.get(result.terminal)!.labels).toMatchObject({ "nexbot.engine": "codex", "nexbot.native": "pending" });
    const rows = Object.fromEntries(t.sessions().map((row) => [row.nativeId, row]));
    expect(rows[XID(2)]).toMatchObject({ liveIn: "nexbot", terminal: result.terminal });
    expect(rows[XID(1)]?.terminal).toBeUndefined();
    expect(rows[XID(7)]?.terminal).toBeUndefined();
  });

  it("answers with a provisional ref when no session file shows up and claims it later", async () => {
    const t = setup();
    await t.start();
    const reply = await t.call("start", { engine: "codex", cwd: workDir }, "late", 4000);
    expect(reply.ok).toBe(true);
    const result = reply.result as { ref: string; terminal: string };
    expect(result.ref).toMatch(/^codex:pending-[0-9a-f]{8}$/);
    expect(hc.terminals.get(result.terminal)!.state).toBe("live");
    // the CLI writes its file after the reply; the terminal is still claimed
    codexRollout(XID(3), "late file", 0);
    await until(() => t.sessions().some((row) => row.nativeId === XID(3) && row.terminal === result.terminal), 8000);
  }, 20_000);

  it("stops waiting for a file after the claim window", async () => {
    const t = setup({ codexClaimMs: 100 });
    await t.start();
    await t.call("start", { engine: "codex", cwd: workDir }, "short", 4000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    codexRollout(XID(4), "too late", 0);
    await t.bridge.refreshSessions();
    expect(t.sessions().find((row) => row.nativeId === XID(4))?.terminal).toBeUndefined();
  }, 20_000);
});

describe("continue", () => {
  it("resumes a stopped Claude session in a terminal and reuses it afterwards", async () => {
    claudeTranscript(CID(1), "resume me");
    const t = setup();
    await t.start();
    const reply = await t.call("continue", { ref: `claude:${CID(1)}` });
    expect(reply.ok).toBe(true);
    const result = reply.result as { ref: string; terminal: string };
    expect(result.ref).toBe(`claude:${CID(1)}`);
    expect(hc.terminals.get(result.terminal)!.argv).toEqual(["/fake/bin/claude", "--resume", CID(1)]);
    expect(t.sessions().find((row) => row.nativeId === CID(1))).toMatchObject({ liveIn: "nexbot", terminal: result.terminal });
    const again = await t.call("continue", { ref: `claude:${CID(1)}` });
    expect((again.result as { terminal: string }).terminal).toBe(result.terminal);
    expect(hc.runs).toHaveLength(1);
  });

  it("resumes Codex with the resume subcommand", async () => {
    codexRollout(XID(1), "resume codex");
    const t = setup();
    await t.start();
    const reply = await t.call("continue", { ref: `codex:${XID(1)}` });
    expect(reply.ok).toBe(true);
    expect(hc.last().argv).toEqual(["/fake/bin/codex", "resume", XID(1)]);
  });

  it("passes a custom config directory to the CLI", async () => {
    claudeTranscript(CID(1), "custom dir");
    const t = setup();
    await t.start();
    await t.call("continue", { ref: `claude:${CID(1)}` });
    expect(hc.last().env).toMatchObject({ CLAUDE_CONFIG_DIR: claudeDir });
  });

  it("refuses with open_elsewhere when another process runs the Claude session", async () => {
    claudeTranscript(CID(1), "busy elsewhere", 1000);
    claudeLive(4242, CID(1), "idle");
    const t = setup();
    await t.start();
    await t.bridge.refreshSessions();
    expect(t.sessions().find((row) => row.nativeId === CID(1))?.state).not.toBe("stopped");
    const reply = await t.call("continue", { ref: `claude:${CID(1)}` });
    expect(reply).toMatchObject({ ok: false, error: { code: "open_elsewhere" } });
    expect(hc.runs).toHaveLength(0);
  });

  it("notices a session that was opened elsewhere after the last report", async () => {
    claudeTranscript(CID(1), "race", 60_000);
    const t = setup();
    await t.start();
    expect(t.sessions().find((row) => row.nativeId === CID(1))?.state).toBe("stopped");
    claudeLive(5151, CID(1), "busy");
    const reply = await t.call("continue", { ref: `claude:${CID(1)}` });
    expect(reply).toMatchObject({ ok: false, error: { code: "open_elsewhere" } });
    expect(hc.runs).toHaveLength(0);
  });

  it("turns an immediate Codex exit with a writer complaint into open_elsewhere", async () => {
    codexRollout(XID(1), "maybe open elsewhere");
    const t = setup({}, { writer: "unknown" });
    await t.start();
    expect(t.sessions().find((row) => row.nativeId === XID(1))).toMatchObject({ writerUnknown: true });
    hc.onRun = (terminal) => {
      setTimeout(() => hc.exit(terminal.address, 1, "Error: session is locked by another writer"), 40);
    };
    const reply = await t.call("continue", { ref: `codex:${XID(1)}` });
    expect(reply).toMatchObject({ ok: false, error: { code: "open_elsewhere" } });
    expect(t.sessions().find((row) => row.nativeId === XID(1))?.terminal).toBeUndefined();
  });

  it("keeps a Codex terminal that survives the settle time", async () => {
    codexRollout(XID(1), "writer unknown but free");
    const t = setup({ settleMs: 300 }, { writer: "unknown" });
    await t.start();
    const reply = await t.call("continue", { ref: `codex:${XID(1)}` });
    expect(reply.ok).toBe(true);
  });

  it("refuses a second continue of the same session while the first is under way", async () => {
    claudeTranscript(CID(1), "double");
    hc.runDelayMs = 150;
    const t = setup();
    await t.start();
    t.bridge.handle({ type: "cli.op", opId: "c-a", op: "continue", args: { ref: `claude:${CID(1)}` }, deadlineMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    t.bridge.handle({ type: "cli.op", opId: "c-b", op: "continue", args: { ref: `claude:${CID(1)}` }, deadlineMs: 10_000 });
    await until(() => t.messages.filter((m) => m.type === "cli.reply").length === 2);
    const byId = Object.fromEntries(t.messages.filter((m) => m.type === "cli.reply").map((m) => [(m as { opId: string }).opId, m]));
    expect(byId["c-b"]).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(byId["c-a"]).toMatchObject({ ok: true });
    expect(hc.runs).toHaveLength(1);
  });
});

describe("send and interrupt", () => {
  async function running() {
    claudeTranscript(CID(1), "running");
    const t = setup();
    await t.start();
    const reply = await t.call("continue", { ref: `claude:${CID(1)}` });
    return { t, address: (reply.result as { terminal: string }).terminal, ref: `claude:${CID(1)}` as const };
  }

  it("sends the text to the terminal", async () => {
    const { t, address, ref } = await running();
    const reply = await t.call("send", { ref, text: "run the tests" });
    expect(reply).toMatchObject({ ok: true, result: { started: true } });
    expect(hc.terminals.get(address)!.sent).toMatchObject([{ text: "run the tests" }]);
  });

  it("refuses with busy while a person has an unsent draft on the computer, and sends nothing", async () => {
    const { t, address, ref } = await running();
    hc.drafts.add(address);
    const reply = await t.call("send", { ref, text: "overwrite?" });
    expect(reply).toMatchObject({ ok: false, error: { code: "busy" } });
    expect((reply.error as { message?: string }).message).toContain("电脑上有人正在输入");
    expect(hc.terminals.get(address)!.sent).toEqual([]);
    hc.drafts.clear();
    expect((await t.call("send", { ref, text: "now fine" })).ok).toBe(true);
  });

  it("does not take a re-sent send twice", async () => {
    const { t, address, ref } = await running();
    await t.call("send", { ref, text: "once" }, "send-1");
    await t.call("send", { ref, text: "once" }, "send-1");
    expect(hc.terminals.get(address)!.sent).toHaveLength(1);
  });

  it("explains why a session cannot take input", async () => {
    claudeTranscript(CID(2), "stopped one");
    claudeTranscript(CID(3), "elsewhere", 1000);
    claudeLive(777, CID(3), "idle");
    const t = setup();
    await t.start();
    await t.bridge.refreshSessions();
    expect(await t.call("send", { ref: `claude:${CID(2)}`, text: "x" })).toMatchObject({ ok: false, error: { code: "stopped" } });
    expect(await t.call("send", { ref: `claude:${CID(3)}`, text: "x" })).toMatchObject({ ok: false, error: { code: "not_in_terminal" } });
    expect(await t.call("send", { ref: `claude:${CID(9)}`, text: "x" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("rejects an empty or oversized text (the parser refuses more than 32 KiB)", async () => {
    const { t, ref } = await running();
    expect(await t.call("send", { ref, text: "" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await t.call("send", { ref, text: "x".repeat(70_000) })).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("interrupts the terminal", async () => {
    const { t, address, ref } = await running();
    expect(await t.call("interrupt", { ref })).toMatchObject({ ok: true, result: { outcome: "interrupted" } });
    expect(hc.terminals.get(address)!.interrupts).toBe(1);
  });

  it("learns that the terminal ended and then reports stopped", async () => {
    const { t, address, ref } = await running();
    hc.exit(address, 0);
    await until(() => t.sessions().find((row) => `claude:${row.nativeId}` === ref)?.liveIn !== "nexbot", 8000);
    expect(await t.call("send", { ref, text: "hello?" })).toMatchObject({ ok: false, error: { code: "stopped" } });
  });
});

describe("terminal streams", () => {
  async function running() {
    claudeTranscript(CID(1), "streaming");
    const t = setup();
    await t.start();
    const reply = await t.call("continue", { ref: `claude:${CID(1)}` });
    return { t, address: (reply.result as { terminal: string }).terminal, ref: `claude:${CID(1)}` as const };
  }
  const open = (t: ReturnType<typeof setup>, ref: string, sid: number, observe: boolean) => {
    t.bridge.handle({ type: "cli.term.open", sid, ref, cols: 100, rows: 30, observe });
    return until(() => t.messages.some((m) => (m.type === "cli.term.opened" || m.type === "cli.term.error") && m.sid === sid));
  };

  it("opens a stream, relays output and input and credit", async () => {
    const { t, address, ref } = await running();
    await open(t, ref, 1, false);
    expect(t.messages.find((m) => m.type === "cli.term.opened")).toMatchObject({ sid: 1, observe: false });
    const stream = hc.streamsOf(address)[0];
    expect(stream.params).toMatchObject({ observe: false, cols: 100, rows: 30 });
    stream.push("prompt> ");
    await until(() => t.frames.length > 0);
    const frame = decodeTermFrame(t.frames[0])!;
    expect(frame).toMatchObject({ type: TERM_OUTPUT, sid: 1 });
    expect(Buffer.from(frame.payload).toString()).toBe("prompt> ");
    t.bridge.binary(encodeTermFrame(TERM_INPUT, 1, Buffer.from("ls\r")));
    expect(stream.text()).toBe("ls\r");
    t.bridge.handle({ type: "cli.term.credit", sid: 1, bytes: 1024 });
    expect(stream.acks).toEqual([1024]);
    t.bridge.handle({ type: "cli.term.resize", sid: 1, cols: 120, rows: 40 });
    expect(stream.resizes).toEqual([[120, 40]]);
    t.bridge.handle({ type: "cli.term.close", sid: 1 });
    expect(stream.closed).toBe(true);
    expect(t.bridge.streamCount()).toBe(0);
    expect(hc.terminals.get(address)!.state).toBe("live");
  });

  it("rejects input on an observing stream", async () => {
    const { t, address, ref } = await running();
    await open(t, ref, 2, true);
    t.bridge.binary(encodeTermFrame(TERM_INPUT, 2, Buffer.from("rm -rf")));
    expect(hc.streamsOf(address)[0].writes).toEqual([]);
    expect(t.messages).toContainEqual({ type: "cli.term.error", sid: 2, code: "read_only" });
  });

  it("answers not_found for an unknown session and not_in_terminal for one outside nex_bot", async () => {
    claudeTranscript(CID(5), "plain stopped");
    const t = setup();
    await t.start();
    await open(t, `claude:${CID(9)}`, 3, false);
    expect(t.messages).toContainEqual({ type: "cli.term.error", sid: 3, code: "not_found" });
    await open(t, `claude:${CID(5)}`, 4, false);
    expect(t.messages).toContainEqual({ type: "cli.term.error", sid: 4, code: "not_in_terminal" });
  });

  it("closes the stream with the exit code when the program exits", async () => {
    const { t, address, ref } = await running();
    await open(t, ref, 5, false);
    hc.exit(address, 3);
    await until(() => t.messages.some((m) => m.type === "cli.term.closed"));
    expect(t.messages.find((m) => m.type === "cli.term.closed")).toMatchObject({ sid: 5, reason: "exited", exitCode: 3 });
  });

  it("ends streams but not terminals when the link drops", async () => {
    const { t, address, ref } = await running();
    await open(t, ref, 6, false);
    t.bridge.unlink();
    expect(t.bridge.streamCount()).toBe(0);
    expect(hc.streamsOf(address)[0].closed).toBe(true);
    expect(hc.terminals.get(address)!.state).toBe("live");
    // no more output reaches a closed link
    t.messages.length = 0;
    t.bridge.link(t.link);
    await until(() => t.messages.some((m) => m.type === "cli.sessions"));
    expect(t.messages.find((m) => m.type === "cli.sessions")).toMatchObject({ full: true });
  });
});

describe("pause and detach", () => {
  it("closes streams and watches and herdr-core connection but never stops a terminal", async () => {
    claudeTranscript(CID(1), "pause me");
    const t = setup();
    await t.start();
    const started = await t.call("continue", { ref: `claude:${CID(1)}` });
    const address = (started.result as { terminal: string }).terminal;
    t.bridge.handle({ type: "cli.term.open", sid: 9, ref: `claude:${CID(1)}`, cols: 80, rows: 24, observe: false });
    await until(() => t.messages.some((m) => m.type === "cli.term.opened"));
    await t.call("watch", { ref: `claude:${CID(1)}` });

    await t.bridge.detach();
    expect(hc.streamsOf(address)[0].closed).toBe(true);
    expect(hc.closed).toBe(true);
    expect(hc.terminals.get(address)!.state).toBe("live");
    expect(hc.terminals.get(address)!.interrupts).toBe(0);

    // a detached bridge ignores everything
    const before = t.messages.length;
    t.bridge.handle({ type: "cli.op", opId: "after", op: "read", args: { ref: `claude:${CID(1)}` }, deadlineMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.messages.length).toBe(before);
  });

  it("finds its own terminals again after a restart", async () => {
    claudeTranscript(CID(1), "persisted");
    const first = setup();
    await first.start();
    const started = await first.call("continue", { ref: `claude:${CID(1)}` });
    const address = (started.result as { terminal: string }).terminal;
    await first.bridge.detach();
    bridges.length = 0;

    const second = setup();
    await second.start();
    await until(() => second.sessions().find((row) => row.nativeId === CID(1))?.terminal === address);
    expect(second.sessions().find((row) => row.nativeId === CID(1))).toMatchObject({ liveIn: "nexbot", state: "idle" });
    const again = await second.call("continue", { ref: `claude:${CID(1)}` });
    expect((again.result as { terminal: string }).terminal).toBe(address);
    expect(hc.runs).toHaveLength(1);
  });
});

describe("open_local", () => {
  it.runIf(process.platform === "win32")("writes an attach file for the same session and starts a window", async () => {
    claudeTranscript(CID(1), "open here");
    const t = setup({ platform: "win32" });
    await t.start();
    const started = await t.call("continue", { ref: `claude:${CID(1)}` });
    const address = (started.result as { terminal: string }).terminal;
    expect(await t.call("open_local", { ref: `claude:${CID(1)}` })).toMatchObject({ ok: true });
    expect(t.launched).toHaveLength(1);
    const plan = t.launched[0];
    expect(plan.command).toBe("cmd.exe");
    const text = readFileSync(plan.file, "utf8");
    expect(existsSync(plan.file)).toBe(true);
    expect(text).toMatch(/set "HC_SESSION=nexbot-[0-9a-f]{8}"/);
    expect(text).toContain(`attach ${address}`);
    expect(text).toContain("herdr-core.exe");
  });

  it("is refused for a session that is not in a terminal", async () => {
    claudeTranscript(CID(2), "stopped");
    const t = setup({ platform: "win32" });
    await t.start();
    expect(await t.call("open_local", { ref: `claude:${CID(2)}` })).toMatchObject({ ok: false, error: { code: "stopped" } });
    expect(t.launched).toHaveLength(0);
  });

});

// ---------------------------------------------------------------------------
// Claude hooks (plan 7.1) and turn ends (plan 7.3)

describe("Claude hooks and turn ends", () => {
  const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin");
  const BASH = { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "npm test" } };

  const hooked = (extra: Partial<CliAgentBridgeOptions> = {}) => setup({ pluginDir: PLUGIN, hookNode: process.execPath, hookSocketDir: root, turnFallbackMs: 60, ...extra });
  type Setup = ReturnType<typeof setup>;
  const requests = (t: Setup) => t.messages.filter((m): m is Extract<DeviceCliMessage, { type: "cli.request" }> => m.type === "cli.request");
  const turns = (t: Setup) => t.messages.filter((m): m is Extract<DeviceCliMessage, { type: "cli.turn" }> => m.type === "cli.turn");

  /** What the hook inside the terminal does: connects with the variables the terminal got. */
  function ask(env: Record<string, string>, event: string, input: unknown): { reply: Promise<Record<string, any> | null>; socket: net.Socket } {
    const socket = net.connect(env.NEXBOT_HOOK_PIPE);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    const reply = new Promise<Record<string, any> | null>((resolve) => {
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end >= 0) resolve(JSON.parse(buffer.slice(0, end)));
      });
      socket.on("close", () => resolve(null));
    });
    socket.on("connect", () => socket.write(JSON.stringify({ v: 1, token: env.NEXBOT_HOOK_TOKEN, event, input }) + "\n"));
    return { reply, socket };
  }

  async function startClaude(t: Setup) {
    claudeWritesTranscript();
    await t.start();
    const reply = await t.call("start", { engine: "claude", cwd: workDir });
    expect(reply.ok).toBe(true);
    const result = reply.result as { ref: string; terminal: string };
    return { ...result, terminal: hc.terminals.get(result.terminal)!, address: result.terminal };
  }

  it("starts Claude with the plugin and the hook variables", async () => {
    const t = hooked();
    const started = await startClaude(t);
    const id = started.ref.slice("claude:".length);
    expect(started.terminal.argv).toEqual(["/fake/bin/claude", "--session-id", id, "--plugin-dir", PLUGIN]);
    expect(started.terminal.env).toMatchObject({ NEXBOT_HOOK_NODE: process.execPath });
    expect(started.terminal.env.NEXBOT_HOOK_TOKEN.endsWith(`.${id}`)).toBe(true);
    expect(started.terminal.env.NEXBOT_HOOK_PIPE).toBeTruthy();
  });

  it("turns a permission prompt into a card and relays the answer to the waiting hook", async () => {
    const t = hooked();
    const started = await startClaude(t);
    const conn = ask(started.terminal.env, "permission", BASH);
    const request = await until(() => requests(t).length === 1).then(() => requests(t)[0]);
    expect(request).toMatchObject({ ref: started.ref, kind: "permission", tool: "Bash", summary: "npm test" });

    const answered = await t.call("answer", { id: request.id, decision: "allow" });
    expect(answered).toMatchObject({ ok: true, result: { outcome: "ok" } });
    expect(await conn.reply).toEqual({ v: 1, decision: "allow" });

    // the request is closed now: a second answer finds nothing
    expect(await t.call("answer", { id: request.id, decision: "allow" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("relays a deny with its message and the answers of a question", async () => {
    const t = hooked();
    const started = await startClaude(t);
    const deny = ask(started.terminal.env, "permission", BASH);
    await until(() => requests(t).length === 1);
    await t.call("answer", { id: requests(t)[0].id, decision: "deny", message: "no" });
    expect(await deny.reply).toEqual({ v: 1, decision: "deny", message: "no" });

    const question = ask(started.terminal.env, "permission", { tool_name: "AskUserQuestion", tool_use_id: "q", tool_input: { questions: [{ question: "Pick?", options: [{ label: "A" }, { label: "B" }] }] } });
    await until(() => requests(t).length === 2);
    const card = requests(t)[1];
    expect(card).toMatchObject({ kind: "question", summary: "Pick?" });
    expect(await t.call("answer", { id: card.id, decision: "allow" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await t.call("answer", { id: card.id, decision: "allow", answers: { "Pick?": "B" } })).toMatchObject({ ok: true });
    expect(await question.reply).toEqual({ v: 1, decision: "allow", answers: { "Pick?": "B" } });
  });

  it("closes the card as terminal when the prompt was answered at the computer", async () => {
    const t = hooked();
    const started = await startClaude(t);
    const conn = ask(started.terminal.env, "permission", BASH);
    await until(() => requests(t).length === 1);
    const post = ask(started.terminal.env, "post", { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "npm test" } });
    await post.reply;
    await until(() => t.messages.some((m) => m.type === "cli.request.resolved"));
    expect(t.messages.find((m) => m.type === "cli.request.resolved")).toEqual({ type: "cli.request.resolved", id: requests(t)[0].id, by: "terminal" });
    expect(await conn.reply).toMatchObject({ decision: "pass" });
  });

  it("sends the hooks back to the terminal when the link to Core drops", async () => {
    const t = hooked();
    const started = await startClaude(t);
    const conn = ask(started.terminal.env, "permission", BASH);
    await until(() => requests(t).length === 1);
    t.bridge.unlink();
    expect(await conn.reply).toMatchObject({ decision: "pass" });
    // and while unlinked nothing is asked
    const later = ask(started.terminal.env, "permission", BASH);
    expect(await later.reply).toMatchObject({ decision: "pass" });
    expect(requests(t)).toHaveLength(1);
  });

  it("ignores a hook of a session whose terminal ended", async () => {
    const t = hooked();
    const started = await startClaude(t);
    hc.exit(started.address, 0);
    await until(() => t.sessions().find((row) => row.nativeId === started.ref.slice(7))?.liveIn !== "nexbot", 8000);
    expect(await ask(started.terminal.env, "permission", BASH).reply).toMatchObject({ decision: "pass" });
    expect(requests(t)).toHaveLength(0);
  });

  it("resumes with the plugin and the token of that session, and keeps Codex free of both", async () => {
    claudeTranscript(CID(1), "resume me");
    codexRollout(XID(1), "resume codex");
    const t = hooked();
    await t.start();
    await t.call("continue", { ref: `claude:${CID(1)}` });
    expect(hc.last().argv).toEqual(["/fake/bin/claude", "--resume", CID(1), "--plugin-dir", PLUGIN]);
    expect(hc.last().env.NEXBOT_HOOK_TOKEN.endsWith(`.${CID(1)}`)).toBe(true);
    await t.call("continue", { ref: `codex:${XID(1)}` });
    expect(hc.last().argv).toEqual(["/fake/bin/codex", "resume", XID(1)]);
    expect(hc.last().env.NEXBOT_HOOK_PIPE).toBeUndefined();
  });

  it("starts without the plugin when it is missing, and the answer operation finds nothing", async () => {
    const t = setup({ pluginDir: path.join(root, "no-plugin") });
    const started = await startClaude(t);
    expect(started.terminal.argv).not.toContain("--plugin-dir");
    expect(started.terminal.env.NEXBOT_HOOK_PIPE).toBeUndefined();
    expect(await t.call("answer", { id: "x", decision: "allow" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("stops listening when the bridge detaches", async () => {
    const t = hooked();
    const started = await startClaude(t);
    const conn = ask(started.terminal.env, "permission", BASH);
    await until(() => requests(t).length === 1);
    await t.bridge.detach();
    expect(await conn.reply).toMatchObject({ decision: "pass" });
    const after = ask(started.terminal.env, "permission", BASH);
    expect(await after.reply).toBeNull();
  });

  it("reports the Stop hook as a turn end", async () => {
    const t = hooked();
    const started = await startClaude(t);
    expect(await ask(started.terminal.env, "stop", { hook_event_name: "Stop" }).reply).toMatchObject({ decision: "pass" });
    expect(turns(t)).toMatchObject([{ ref: started.ref, turn: 1, reason: "end" }]);
  });

  it("falls back to the status change when no Stop hook came, once", async () => {
    const t = hooked();
    const started = await startClaude(t);
    const id = started.ref.slice(7);
    claudeLive(4242, id, "busy");
    await t.bridge.refreshSessions();
    expect(t.sessions().find((row) => row.nativeId === id)?.state).toBe("running");
    claudeLive(4242, id, "idle");
    await t.bridge.refreshSessions();
    await until(() => turns(t).length === 1);
    expect(turns(t)[0]).toMatchObject({ ref: started.ref, turn: 1, reason: "end" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(turns(t)).toHaveLength(1);
  });

  it("does not report the same turn again when the Stop hook came first", async () => {
    const t = hooked();
    const started = await startClaude(t);
    const id = started.ref.slice(7);
    claudeLive(4242, id, "busy");
    await t.bridge.refreshSessions();
    await ask(started.terminal.env, "stop", { hook_event_name: "Stop" }).reply;
    claudeLive(4242, id, "idle");
    await t.bridge.refreshSessions();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(turns(t)).toHaveLength(1);
  });

  it("does not report a turn for a session that is busy again before the fallback fires", async () => {
    const t = hooked({ turnFallbackMs: 200 });
    const started = await startClaude(t);
    const id = started.ref.slice(7);
    claudeLive(4242, id, "busy");
    await t.bridge.refreshSessions();
    claudeLive(4242, id, "idle");
    await t.bridge.refreshSessions();
    claudeLive(4242, id, "busy");
    await t.bridge.refreshSessions();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(turns(t)).toHaveLength(0);
  });

  it("reports Codex turn ends and aborts from the rollout of a session in a nex_bot terminal", async () => {
    const file = codexRollout(XID(1), "codex turns");
    const t = hooked();
    await t.start();
    await t.call("continue", { ref: `codex:${XID(1)}` });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const line = (type: string, at: number) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type, turn_id: `t-${at}` } }) + "\n";
    const now = Date.now();
    appendFileSync(file, line("task_started", now) + line("task_complete", now + 1000));
    await until(() => turns(t).length === 1);
    appendFileSync(file, line("task_started", now + 2000) + line("turn_aborted", now + 3000));
    await until(() => turns(t).length === 2);
    expect(turns(t)).toMatchObject([
      { ref: `codex:${XID(1)}`, turn: 1, reason: "end", endedAt: now + 1000 },
      { ref: `codex:${XID(1)}`, turn: 2, reason: "interrupted", endedAt: now + 3000 },
    ]);
  });
});
