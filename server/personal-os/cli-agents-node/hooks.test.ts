// The hook server and hook.mjs, against each other. No Claude Code runs: the
// hook input is what Claude Code writes to stdin, made up here.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliRequestWire, DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { HookError, HookServer, REQUEST_TTL_MS, TurnTracker, locateHookPlugin, platformPlugin, windowsHooksJson } from "./hooks.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, "plugin");
const HOOK = path.join(PLUGIN, "hooks", "hook.mjs");
const REF = "claude:00000000-0000-4000-8000-000000000001";
const OTHER = "claude:00000000-0000-4000-8000-000000000002";

let dir: string;
let servers: HookServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "nex-hooks-"));
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | null | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await wait(10);
  }
}

interface Rig {
  server: HookServer;
  messages: DeviceCliMessage[];
  requests: () => CliRequestWire[];
  state: { active: boolean; link: boolean; live: Set<string> };
  turns: TurnTracker;
}

function rig(options: { ttlMs?: number; dir?: string } = {}): Rig {
  const messages: DeviceCliMessage[] = [];
  const state = { active: true, link: true, live: new Set([REF]) };
  const emit = (message: DeviceCliMessage) => (state.link ? (messages.push(message), true) : false);
  const turns = new TurnTracker(emit);
  const server = new HookServer({
    dir: options.dir ?? dir,
    emit,
    turns,
    active: () => state.active,
    linked: () => state.link,
    isLive: (ref) => state.live.has(ref),
    socketDir: dir,
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
  });
  servers.push(server);
  return { server, messages, requests: () => messages.filter((m): m is Extract<DeviceCliMessage, { type: "cli.request" }> => m.type === "cli.request"), state, turns };
}

interface Conn {
  reply: Promise<Record<string, any> | null>;
  socket: net.Socket;
}

/** Speaks the wire protocol the way hook.mjs does. */
function talk(pipe: string, message: unknown): Conn {
  const socket = net.connect(pipe);
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
  socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
  return { reply, socket };
}

const permission = (token: string, input: Record<string, unknown>) => ({ v: 1, token, event: "permission", input });
const BASH = { hook_event_name: "PermissionRequest", session_id: "s", cwd: "/w", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "npm test" } };
const QUESTION = {
  hook_event_name: "PermissionRequest",
  session_id: "s",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_q",
  tool_input: { questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "SQLite", description: "file" }, { label: "Postgres" }] }] },
};

async function started(options?: Parameters<typeof rig>[0]): Promise<Rig> {
  const r = rig(options);
  await r.server.start();
  return r;
}

describe("tokens and addresses", () => {
  it("derives the same pipe and tokens from the same data directory, and different ones per session", async () => {
    const a = rig();
    const b = rig();
    expect(a.server.pipe).toBe(b.server.pipe);
    expect(a.server.tokenFor(REF)).toBe(b.server.tokenFor(REF));
    expect(a.server.tokenFor(REF)).not.toBe(a.server.tokenFor(OTHER));
    expect(a.server.tokenFor(REF)).toMatch(/^[0-9a-f]{64}\.00000000-0000-4000-8000-000000000001$/);
    const other = mkdtempSync(path.join(os.tmpdir(), "nex-hooks-"));
    try {
      expect(rig({ dir: other }).server.pipe).not.toBe(a.server.pipe);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    expect(a.server.environment(REF, "/usr/bin/node")).toEqual({ NEXBOT_HOOK_NODE: "/usr/bin/node", NEXBOT_HOOK_PIPE: a.server.pipe, NEXBOT_HOOK_TOKEN: a.server.tokenFor(REF) });
  });

  it("keeps the secret private", () => {
    rig();
    const file = path.join(dir, "hook-secret");
    expect(readFileSync(file, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("replaces an unusable secret file", () => {
    writeFileSync(path.join(dir, "hook-secret"), "garbage");
    rig();
    expect(readFileSync(path.join(dir, "hook-secret"), "utf8")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("authentication", () => {
  it("passes a bad token, a token of a session that is not in a terminal, and drops garbage", async () => {
    const r = await started();
    const bad = await talk(r.server.pipe, permission("nope", BASH)).reply;
    expect(bad).toMatchObject({ v: 1, decision: "pass" });
    const forged = `${r.server.tokenFor(OTHER).slice(0, 64)}.00000000-0000-4000-8000-000000000001`;
    expect(await talk(r.server.pipe, permission(forged, BASH)).reply).toMatchObject({ decision: "pass" });
    expect(await talk(r.server.pipe, permission(r.server.tokenFor(OTHER), BASH)).reply).toMatchObject({ decision: "pass" });
    expect(r.server.refusals).toBe(3);
    expect(r.requests()).toHaveLength(0);

    const garbage = net.connect(r.server.pipe);
    garbage.on("error", () => undefined);
    garbage.on("connect", () => garbage.write("not json\n"));
    await new Promise((resolve) => garbage.on("close", resolve));
  });

  it("does not trust a token after the terminal of its session ended", async () => {
    const r = await started();
    r.state.live.delete(REF);
    expect(await talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH)).reply).toMatchObject({ decision: "pass" });
    expect(r.requests()).toHaveLength(0);
  });
});

describe("permission requests", () => {
  it("emits a card and hands the allow decision to the waiting hook", async () => {
    const r = await started();
    const conn = talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH));
    const request = await until(() => r.requests()[0], "cli.request");
    expect(request).toMatchObject({ ref: REF, kind: "permission", tool: "Bash", summary: "npm test" });
    expect(request.expiresAt).toBeGreaterThan(Date.now() + REQUEST_TTL_MS - 5000);
    expect(r.server.pendingCount).toBe(1);

    expect(r.server.answer({ id: request.id, decision: "allow" })).toBe("ok");
    expect(await conn.reply).toEqual({ v: 1, decision: "allow" });
    expect(r.server.pendingCount).toBe(0);
    // Core resolves its own copy when the answer succeeds: nothing else goes to Core.
    expect(r.messages.filter((m) => m.type === "cli.request.resolved")).toHaveLength(0);
    expect(() => r.server.answer({ id: request.id, decision: "allow" })).toThrow(HookError);
  });

  it("carries a deny message", async () => {
    const r = await started();
    const conn = talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH));
    const request = await until(() => r.requests()[0], "cli.request");
    r.server.answer({ id: request.id, decision: "deny", message: "not now" });
    expect(await conn.reply).toEqual({ v: 1, decision: "deny", message: "not now" });
  });

  it("rejects an answer for an unknown request", async () => {
    const r = await started();
    expect(() => r.server.answer({ id: "missing", decision: "allow" })).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("answers a question with the chosen labels and refuses incomplete answers", async () => {
    const r = await started();
    const conn = talk(r.server.pipe, permission(r.server.tokenFor(REF), QUESTION));
    const request = await until(() => r.requests()[0], "cli.request");
    expect(request).toMatchObject({ kind: "question", tool: "AskUserQuestion", summary: "Which database?" });
    expect(request.questions).toEqual([{ question: "Which database?", header: "DB", options: [{ label: "SQLite", description: "file" }, { label: "Postgres" }] }]);

    expect(() => r.server.answer({ id: request.id, decision: "allow" })).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() => r.server.answer({ id: request.id, decision: "allow", answers: { "Other?": "x" } })).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(r.server.pendingCount).toBe(1);

    r.server.answer({ id: request.id, decision: "allow", answers: { "Which database?": "Postgres" } });
    expect(await conn.reply).toEqual({ v: 1, decision: "allow", answers: { "Which database?": "Postgres" } });
  });

  it("leaves a question that Core cannot hold to the terminal", async () => {
    const r = await started();
    const input = { ...QUESTION, tool_input: { questions: [] } };
    expect(await talk(r.server.pipe, permission(r.server.tokenFor(REF), input)).reply).toMatchObject({ decision: "pass" });
    expect(r.requests()).toHaveLength(0);
  });

  it("closes the card when the hook goes away because the prompt was answered in the terminal", async () => {
    const r = await started();
    const conn = talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH));
    const request = await until(() => r.requests()[0], "cli.request");
    conn.socket.destroy();
    await until(() => r.messages.find((m) => m.type === "cli.request.resolved"), "resolved");
    expect(r.messages.at(-1)).toEqual({ type: "cli.request.resolved", id: request.id, by: "terminal" });
    expect(() => r.server.answer({ id: request.id, decision: "allow" })).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("closes the card on PostToolUse of the same tool call", async () => {
    const r = await started();
    const conn = talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH));
    const request = await until(() => r.requests()[0], "cli.request");
    // another tool call does not close it
    const other = talk(r.server.pipe, { v: 1, token: r.server.tokenFor(REF), event: "post", input: { tool_name: "Bash", tool_use_id: "toolu_other", tool_input: { command: "ls" } } });
    expect(await other.reply).toMatchObject({ decision: "pass" });
    expect(r.server.pendingCount).toBe(1);
    const post = talk(r.server.pipe, { v: 1, token: r.server.tokenFor(REF), event: "post", input: { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "npm test" } } });
    expect(await post.reply).toMatchObject({ decision: "pass" });
    expect(r.messages.at(-1)).toEqual({ type: "cli.request.resolved", id: request.id, by: "terminal" });
    expect(await conn.reply).toMatchObject({ decision: "pass" });
  });

  it("pairs PostToolUse by input when the permission request had no tool_use_id", async () => {
    const r = await started();
    const { tool_use_id: _drop, ...noId } = BASH;
    const first = talk(r.server.pipe, permission(r.server.tokenFor(REF), { ...noId, tool_input: { command: "a" } }));
    const second = talk(r.server.pipe, permission(r.server.tokenFor(REF), { ...noId, tool_input: { command: "b" } }));
    await until(() => r.requests().length === 2, "two cards");
    const [a, b] = r.requests();
    expect(a.summary).toBe("a");
    await talk(r.server.pipe, { v: 1, token: r.server.tokenFor(REF), event: "post", input: { tool_name: "Bash", tool_use_id: "toolu_9", tool_input: { command: "b" } } }).reply;
    expect(r.messages.at(-1)).toEqual({ type: "cli.request.resolved", id: b.id, by: "terminal" });
    expect(r.server.pendingCount).toBe(1);
    expect(await second.reply).toMatchObject({ decision: "pass" });
    first.socket.destroy();
  });

  it("expires a request on its own and tells the hook to pass", async () => {
    const r = await started({ ttlMs: 60 });
    const conn = talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH));
    const request = await until(() => r.requests()[0], "cli.request");
    expect(await conn.reply).toMatchObject({ decision: "pass" });
    expect(r.messages.at(-1)).toEqual({ type: "cli.request.resolved", id: request.id, by: "timeout" });
    expect(r.server.pendingCount).toBe(0);
  });

  it("passes when the feature is paused", async () => {
    const r = await started();
    r.state.active = false;
    expect(await talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH)).reply).toMatchObject({ decision: "pass" });
    expect(r.server.pendingCount).toBe(0);
  });

  it("holds a prompt while Core cannot be reached and announces it on relink", async () => {
    const r = await started();
    r.state.link = false;
    const one = talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH));
    await until(() => r.server.pendingCount === 1, "held");
    expect(r.requests()).toHaveLength(0);
    r.state.link = true;
    r.server.relink();
    await until(() => r.requests().length === 1, "card after relink");
    expect(r.server.pendingFor(REF)).toBe(1);
    expect(r.server.answer({ id: r.requests()[0].id, decision: "allow" })).toBe("ok");
    expect(await one.reply).toEqual({ v: 1, decision: "allow" });
  });

  it("keeps waiting hooks across a dropped link and sends them back to the terminal when the server closes", async () => {
    const r = await started();
    const one = talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH));
    await until(() => r.requests().length === 1, "card");
    r.server.linkLost();
    await wait(50);
    expect(r.server.pendingCount).toBe(1);
    r.server.relink();
    await until(() => r.requests().length === 2, "announced again");
    expect(r.requests()[1].id).toBe(r.requests()[0].id);
    await r.server.close();
    expect(await one.reply).toMatchObject({ decision: "pass" });
  });

  it("tells Core on relink about a prompt that was answered in the terminal while the link was down", async () => {
    const r = await started();
    const one = talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH));
    await until(() => r.requests().length === 1, "card");
    r.state.link = false;
    r.server.linkLost();
    one.socket.destroy();
    await until(() => r.server.pendingCount === 0, "closed by the terminal");
    expect(r.messages.some((m) => m.type === "cli.request.resolved")).toBe(false);
    r.state.link = true;
    r.server.relink();
    expect(r.messages.filter((m) => m.type === "cli.request.resolved")).toEqual([{ type: "cli.request.resolved", id: r.requests()[0].id, by: "terminal" }]);
  });

  it("puts the full arguments on the card and offers always only with session suggestions", async () => {
    const r = await started();
    const edit = { ...BASH, tool_name: "Edit", tool_input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" }, permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] };
    const conn = talk(r.server.pipe, permission(r.server.tokenFor(REF), edit));
    await until(() => r.requests().length === 1, "card");
    const card = r.requests()[0];
    expect(card).toMatchObject({ tool: "Edit", summary: "/w/a.ts", always: true });
    expect(JSON.parse(card.detail!)).toEqual(edit.tool_input);
    expect(r.server.answer({ id: card.id, decision: "allow", always: true })).toBe("ok");
    expect(await conn.reply).toEqual({ v: 1, decision: "allow", always: true });
  });

  it("caps the open requests of one session", async () => {
    const r = await started();
    const held: Conn[] = [];
    for (let i = 0; i < 50; i++) held.push(talk(r.server.pipe, permission(r.server.tokenFor(REF), { ...BASH, tool_use_id: `t${i}`, tool_input: { command: `c${i}` } })));
    await until(() => r.server.pendingCount === 50, "50 cards");
    expect(await talk(r.server.pipe, permission(r.server.tokenFor(REF), BASH)).reply).toMatchObject({ decision: "pass" });
    expect(r.server.pendingCount).toBe(50);
    for (const conn of held) conn.socket.destroy();
  });
});

describe("turn ends", () => {
  it("reports the Stop hook once and numbers the turns", async () => {
    const r = await started();
    const stop = () => talk(r.server.pipe, { v: 1, token: r.server.tokenFor(REF), event: "stop", input: { hook_event_name: "Stop" } }).reply;
    expect(await stop()).toMatchObject({ decision: "pass" });
    const turns = () => r.messages.filter((m) => m.type === "cli.turn");
    expect(turns()).toHaveLength(1);
    expect(turns()[0]).toMatchObject({ type: "cli.turn", ref: REF, turn: 1, reason: "end" });
    await wait(5);
    await stop();
    expect(turns().map((m) => (m as { turn: number }).turn)).toEqual([1, 2]);
  });

  it("does not report turns while paused", async () => {
    const r = await started();
    r.state.active = false;
    await talk(r.server.pipe, { v: 1, token: r.server.tokenFor(REF), event: "stop", input: {} }).reply;
    expect(r.messages).toHaveLength(0);
  });
});

describe("TurnTracker", () => {
  const rigTurns = () => {
    const sent: DeviceCliMessage[] = [];
    let now = 1_000_000;
    const tracker = new TurnTracker((m) => (sent.push(m), true), () => now, 10_000);
    return { sent, tracker, advance: (ms: number) => (now += ms) };
  };

  it("sends a turn once per end whatever its source", () => {
    const { sent, tracker, advance } = rigTurns();
    expect(tracker.report(REF, "end", "stop")).toBe(true);
    advance(1500);
    // the status fallback that follows the Stop hook is the same turn
    expect(tracker.report(REF, "end", "status")).toBe(false);
    advance(30_000);
    expect(tracker.report(REF, "end", "status")).toBe(true);
    expect(sent.map((m) => (m as { turn: number }).turn)).toEqual([1, 2]);
  });

  it("lets a Stop hook that follows the fallback replace nothing", () => {
    const { tracker, advance } = rigTurns();
    expect(tracker.report(REF, "end", "status")).toBe(true);
    advance(2000);
    expect(tracker.report(REF, "end", "stop")).toBe(false);
    advance(20_000);
    expect(tracker.report(REF, "end", "stop")).toBe(true);
  });

  it("ignores an end that is not newer than the last one and keeps sessions apart", () => {
    const { sent, tracker } = rigTurns();
    expect(tracker.report(REF, "end", "codex", { endedAt: 5000 })).toBe(true);
    expect(tracker.report(REF, "end", "codex", { endedAt: 5000 })).toBe(false);
    expect(tracker.report(REF, "interrupted", "codex", { endedAt: 6000 })).toBe(true);
    expect(tracker.report(OTHER, "end", "codex", { endedAt: 5000 })).toBe(true);
    expect(sent).toMatchObject([
      { ref: REF, turn: 1, endedAt: 5000, reason: "end" },
      { ref: REF, turn: 2, endedAt: 6000, reason: "interrupted" },
      { ref: OTHER, turn: 1 },
    ]);
  });

  it("does not count a turn that could not be sent", () => {
    const sent: DeviceCliMessage[] = [];
    let open = false;
    const tracker = new TurnTracker((m) => (open ? (sent.push(m), true) : false));
    expect(tracker.report(REF, "end", "stop")).toBe(false);
    open = true;
    expect(tracker.report(REF, "end", "stop")).toBe(true);
    expect(sent[0]).toMatchObject({ turn: 1 });
  });
});

describe("locateHookPlugin", () => {
  it("finds the plugin next to the sources and honours an override", () => {
    expect(locateHookPlugin({ env: {}, moduleUrl: new URL("./bridge.ts", `file:///${here.replace(/\\/g, "/")}/`).href })).toBe(PLUGIN);
    const custom = path.join(dir, "custom");
    mkdirSync(path.join(custom, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(custom, ".claude-plugin", "plugin.json"), "{}");
    expect(locateHookPlugin({ env: { NEX_CLI_PLUGIN_PATH: custom } })).toBe(path.resolve(custom));
  });

  it("finds the packaged layout beside client-node and gives null when there is none", () => {
    const packaged = path.join(dir, "out");
    mkdirSync(path.join(packaged, "client-node"), { recursive: true });
    mkdirSync(path.join(packaged, "cli-agents-plugin", ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(packaged, "cli-agents-plugin", ".claude-plugin", "plugin.json"), "{}");
    const moduleUrl = new URL(`file:///${path.join(packaged, "client-node", "client-node.js").replace(/\\/g, "/")}`).href;
    expect(locateHookPlugin({ env: {}, moduleUrl })).toBe(path.join(packaged, "cli-agents-plugin"));
    const empty = new URL(`file:///${path.join(dir, "client-node", "x.js").replace(/\\/g, "/")}`).href;
    expect(locateHookPlugin({ env: {}, moduleUrl: empty })).toBeNull();
  });
});

describe("the plugin files", () => {
  const read = (...parts: string[]) => JSON.parse(readFileSync(path.join(PLUGIN, ...parts), "utf8"));

  it("declares the nexbot plugin with the three hooks", () => {
    expect(read(".claude-plugin", "plugin.json")).toMatchObject({ name: "nexbot" });
    const hooks = read("hooks", "hooks.json").hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PermissionRequest", "PostToolUse", "Stop"]);
    expect(hooks.PermissionRequest[0]).toMatchObject({ matcher: "*" });
    expect(hooks.PermissionRequest[0].hooks[0]).toMatchObject({ type: "command", timeout: 1800 });
    for (const [event, mode] of [["PermissionRequest", "permission"], ["PostToolUse", "post"], ["Stop", "stop"]] as const) {
      const command: string = hooks[event][0].hooks[0].command;
      expect(command).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs");
      expect(command).toContain(` ${mode}`);
      // without the variables nex_bot sets, the hook must do nothing
      expect(command).toContain('[ -z "$NEXBOT_HOOK_NODE" ] ||');
      expect(command.trim().endsWith("|| true")).toBe(true);
    }
  });

  it("has a Windows copy whose hooks run in PowerShell, do nothing without nex_bot and always exit 0", () => {
    const shipped = read("hooks", "hooks.json").hooks;
    const windows = JSON.parse(windowsHooksJson()).hooks;
    expect(Object.keys(windows).sort()).toEqual(Object.keys(shipped).sort());
    for (const [event, mode] of [["PermissionRequest", "permission"], ["PostToolUse", "post"], ["Stop", "stop"]] as const) {
      const entry = windows[event][0].hooks[0];
      const original = shipped[event][0].hooks[0];
      expect(entry).toMatchObject({ type: "command", shell: "powershell", timeout: original.timeout });
      expect(entry.async).toBe(original.async);
      expect(windows[event][0].matcher).toBe(shipped[event][0].matcher);
      expect(entry.command).toBe(`if ($env:NEXBOT_HOOK_NODE) { $env:ELECTRON_RUN_AS_NODE = '1'; & $env:NEXBOT_HOOK_NODE "\${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs" ${mode} }; exit 0`);
    }
  });

  it("writes the Windows copy into the data directory and leaves other platforms on the shipped plugin", () => {
    expect(platformPlugin(PLUGIN, dir, "darwin")).toBe(PLUGIN);
    expect(platformPlugin(PLUGIN, dir, "linux")).toBe(PLUGIN);
    const copy = platformPlugin(PLUGIN, dir, "win32");
    expect(copy).toBe(path.join(dir, "cli-agents-plugin"));
    expect(readFileSync(path.join(copy, "hooks", "hooks.json"), "utf8")).toBe(windowsHooksJson());
    expect(readFileSync(path.join(copy, "hooks", "hook.mjs"), "utf8")).toBe(readFileSync(HOOK, "utf8"));
    expect(readFileSync(path.join(copy, ".claude-plugin", "plugin.json"), "utf8")).toBe(readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    // a stale copy is brought up to date
    writeFileSync(path.join(copy, "hooks", "hooks.json"), "{}");
    expect(platformPlugin(PLUGIN, dir, "win32")).toBe(copy);
    expect(readFileSync(path.join(copy, "hooks", "hooks.json"), "utf8")).toBe(windowsHooksJson());
    // a source without the plugin files stays as it is
    expect(platformPlugin(path.join(dir, "missing"), dir, "win32")).toBe(path.join(dir, "missing"));
  });
});

// ---------------------------------------------------------------------------
// hook.mjs as Claude Code runs it

interface HookRun {
  stdout: Promise<string>;
  code: Promise<number | null>;
  kill: () => void;
}

function runHook(mode: string, input: unknown, env: Record<string, string | undefined>): HookRun {
  const child = spawn(process.execPath, [HOOK, mode], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => undefined);
  child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  const code = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { stdout: code.then(() => out), code, kill: () => child.kill() };
}

const hookEnv = (server: HookServer, extra: Record<string, string> = {}) => ({ NEXBOT_HOOK_PIPE: server.pipe, NEXBOT_HOOK_TOKEN: server.tokenFor(REF), ...extra });

describe("hook.mjs", () => {
  it("prints the allow decision for a permission request", async () => {
    const r = await started();
    const run = runHook("permission", BASH, hookEnv(r.server));
    const request = await until(() => r.requests()[0], "cli.request");
    expect(request).toMatchObject({ tool: "Bash", summary: "npm test" });
    r.server.answer({ id: request.id, decision: "allow" });
    expect(await run.code).toBe(0);
    expect(JSON.parse(await run.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  });

  it("applies Claude Code's own suggestions for the session when the answer is always", async () => {
    const r = await started();
    const suggestions = [
      { type: "addRules", rules: [{ toolName: "Read", ruleContent: "//c/Temp/**" }], behavior: "allow", destination: "localSettings" },
      "not a rule",
    ];
    const run = runHook("permission", { ...BASH, permission_suggestions: suggestions }, hookEnv(r.server));
    const request = await until(() => r.requests()[0], "cli.request");
    expect(request.always).toBe(true);
    r.server.answer({ id: request.id, decision: "allow", always: true });
    expect(JSON.parse(await run.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Read", ruleContent: "//c/Temp/**" }], behavior: "allow", destination: "session" }] },
      },
    });
  });

  it("prints the deny decision with the message", async () => {
    const r = await started();
    const run = runHook("permission", BASH, hookEnv(r.server));
    const request = await until(() => r.requests()[0], "cli.request");
    r.server.answer({ id: request.id, decision: "deny", message: "Use the test runner" });
    expect(JSON.parse(await run.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Use the test runner" } } });
  });

  it("answers AskUserQuestion with updatedInput: the original input plus answers", async () => {
    const r = await started();
    const run = runHook("permission", QUESTION, hookEnv(r.server));
    const request = await until(() => r.requests()[0], "cli.request");
    r.server.answer({ id: request.id, decision: "allow", answers: { "Which database?": "SQLite" } });
    expect(JSON.parse(await run.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { ...QUESTION.tool_input, answers: { "Which database?": "SQLite" } } },
      },
    });
  });

  it("prints nothing and exits 0 when the variables are missing, the bridge is not there, the token is wrong or the input is not JSON", async () => {
    const r = await started();
    const gone = path.join(dir, "no-such.sock");
    const cases: Array<[string, Record<string, string | undefined>, unknown]> = [
      ["no variables", {}, BASH],
      ["no node variable is a shell matter; no token", { NEXBOT_HOOK_PIPE: r.server.pipe }, BASH],
      ["nobody listens", { NEXBOT_HOOK_PIPE: process.platform === "win32" ? "\\\\.\\pipe\\nexbot-test-absent" : gone, NEXBOT_HOOK_TOKEN: "x.y" }, BASH],
      ["wrong token", { NEXBOT_HOOK_PIPE: r.server.pipe, NEXBOT_HOOK_TOKEN: "x.y" }, BASH],
      ["not json", hookEnv(r.server), "this is not json"],
      ["json that is not an object", hookEnv(r.server), "[1,2]"],
    ];
    for (const [label, env, input] of cases) {
      const run = runHook("permission", input, env);
      expect(await run.code, label).toBe(0);
      expect(await run.stdout, label).toBe("");
    }
    expect(r.requests()).toHaveLength(0);
    // an unknown mode does nothing either
    const odd = runHook("bogus", BASH, hookEnv(r.server));
    expect(await odd.code).toBe(0);
    expect(await odd.stdout).toBe("");
  });

  it("prints nothing when the answer does not fit the question", async () => {
    // A bridge that allows a question without answers must not make Claude Code run the tool unanswered.
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.end(JSON.stringify({ v: 1, decision: "allow" }) + "\n"));
    });
    const pipe = process.platform === "win32" ? `\\\\.\\pipe\\nexbot-test-${process.pid}-${Date.now()}` : path.join(dir, "fake.sock");
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      const run = runHook("permission", QUESTION, { NEXBOT_HOOK_PIPE: pipe, NEXBOT_HOOK_TOKEN: "a.b" });
      expect(await run.code).toBe(0);
      expect(await run.stdout).toBe("");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("gives up by itself after NEXBOT_HOOK_TIMEOUT_MS and leaves the prompt to the terminal", async () => {
    const r = await started();
    const run = runHook("permission", BASH, hookEnv(r.server, { NEXBOT_HOOK_TIMEOUT_MS: "300" }));
    const request = await until(() => r.requests()[0], "cli.request");
    expect(await run.code).toBe(0);
    expect(await run.stdout).toBe("");
    await until(() => r.messages.find((m) => m.type === "cli.request.resolved"), "the card closes");
    expect(r.messages.at(-1)).toEqual({ type: "cli.request.resolved", id: request.id, by: "terminal" });
  });

  it("closes the card when Claude Code ends the hook", async () => {
    const r = await started();
    const run = runHook("permission", BASH, hookEnv(r.server));
    const request = await until(() => r.requests()[0], "cli.request");
    run.kill();
    await run.code;
    await until(() => r.messages.find((m) => m.type === "cli.request.resolved"), "the card closes");
    expect(r.messages.at(-1)).toEqual({ type: "cli.request.resolved", id: request.id, by: "terminal" });
  });

  it("forwards PostToolUse and Stop and prints nothing", async () => {
    const r = await started();
    const run = runHook("permission", BASH, hookEnv(r.server));
    const request = await until(() => r.requests()[0], "cli.request");
    const post = runHook("post", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "npm test" }, tool_response: { huge: "x".repeat(50_000) } }, hookEnv(r.server));
    expect(await post.code).toBe(0);
    expect(await post.stdout).toBe("");
    expect(r.messages.at(-1)).toEqual({ type: "cli.request.resolved", id: request.id, by: "terminal" });
    await run.code;

    const stop = runHook("stop", { hook_event_name: "Stop", session_id: "s" }, hookEnv(r.server));
    expect(await stop.code).toBe(0);
    expect(await stop.stdout).toBe("");
    expect(r.messages.filter((m) => m.type === "cli.turn")).toHaveLength(1);
  });
});
