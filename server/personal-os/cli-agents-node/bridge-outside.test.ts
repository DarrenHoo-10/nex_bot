// Sessions that run outside nex_bot's terminals: a Claude inbox, a shared Codex daemon and
// Codex App chats that live only in the App's database. Everything here is synthetic: an
// in-process inbox server, a fake JSON-RPC daemon peer and a sqlite file made for the test.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliOp, CliOpArgs, DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { CliAgentBridge, type CliAgentBridgeOptions } from "./bridge.ts";
import type { DaemonPeer } from "./codex-daemon.ts";
import { FakeHc } from "./fake-hc.ts";
import { keyFileName } from "./inbox.ts";
import type { CommandRunner } from "./liveness.ts";

const CID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const XID = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const LSTART = "Sun Nov 15 09:00:00 2026";
const TOKEN = "bridge-test-token-" + "z".repeat(20);
const run: CommandRunner = async (_file, args) => ({ code: 0, stdout: args[args.length - 1].split(",").map((p) => `${p} ${LSTART}`).join("\n") });

type Rec = Record<string, unknown>;

let root: string;
let claudeDir: string;
let codexHome: string;
let workDir: string;
let servers: net.Server[] = [];
const bridges: CliAgentBridge[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "cli-outside-"));
  claudeDir = path.join(root, "claude");
  codexHome = path.join(root, "codex");
  workDir = path.join(root, "work");
  for (const dir of [path.join(root, "data"), claudeDir, codexHome, workDir]) mkdirSync(dir, { recursive: true });
});
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.detach();
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  servers = [];
  rmSync(root, { recursive: true, force: true });
});

function setup(extra: Partial<CliAgentBridgeOptions> = {}) {
  const messages: DeviceCliMessage[] = [];
  const bridge = new CliAgentBridge({
    dir: path.join(root, "data"),
    hc: new FakeHc(),
    binary: path.resolve("C:\\fake\\herdr-core\\herdr-core.exe"),
    claudeDirs: [claudeDir],
    codexHomes: [codexHome],
    discovery: { claudeLive: { isAlive: () => true, start: { platform: "linux", run } }, codex: { writer: () => "no" }, coalesceMs: 0, liveMs: 50, historyMs: 100 },
    resolveCli: async () => null,
    cliVersion: async () => "9.9.9",
    homedir: path.join(root, "home"),
    hasWindowsTerminal: false,
    readerPollMs: 40,
    coalesceMs: 5,
    pluginDir: null,
    inboxConfirmMs: 1500,
    ...extra,
  });
  bridges.push(bridge);
  const link = { json: (message: DeviceCliMessage) => (messages.push(message), true), binary: () => true };
  let counter = 0;
  const call = async <K extends CliOp>(op: K, args: CliOpArgs[K]) => {
    const opId = `op-${++counter}`;
    bridge.handle({ type: "cli.op", opId, op, args, deadlineMs: 10_000 });
    await until(() => messages.some((m) => m.type === "cli.reply" && m.opId === opId));
    return messages.find((m) => m.type === "cli.reply" && m.opId === opId) as Extract<DeviceCliMessage, { type: "cli.reply" }>;
  };
  const start = async () => {
    await bridge.prepare();
    bridge.setScope("https://core.test", "ws-1");
    bridge.link(link);
    await until(() => messages.some((m) => m.type === "cli.sessions"));
  };
  return { bridge, messages, call, start };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Claude inbox

function inboxName(): string {
  const id = Math.random().toString(16).slice(2, 10);
  return process.platform === "win32" ? `\\\\.\\pipe\\nex-bridge-${id}` : path.join(root, `inbox-${id}.sock`);
}

async function inbox(onLine?: (line: string) => void): Promise<{ socketPath: string; lines: string[] }> {
  const state = { socketPath: inboxName(), lines: [] as string[] };
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        state.lines.push(line);
        onLine?.(line);
        at = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.socketPath, resolve);
  });
  return state;
}

function liveClaude(pid: number, id: string, status: string, extra: Rec = {}): string {
  const folder = path.join(claudeDir, "projects", "proj");
  mkdirSync(folder, { recursive: true });
  const transcript = path.join(folder, `${id}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u-1", timestamp: new Date(Date.now() - 60_000).toISOString(), cwd: workDir, message: { role: "user", content: "earlier" } }) + "\n");
  const old = new Date(Date.now() - 60_000);
  utimesSync(transcript, old, old);
  mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
  writeFileSync(path.join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: workDir, entrypoint: "cli", status, procStart: LSTART, updatedAt: Date.now(), ...extra }));
  return transcript;
}

function writeKey(pid: number, socketPath: string): void {
  writeFileSync(path.join(claudeDir, "sessions", keyFileName(pid, socketPath)), JSON.stringify({ peerToken: TOKEN, procStartFt: "1", pidDomain: "x" }));
}

describe("Claude inbox", () => {
  it("marks a live session in the user's terminal as sendable and keeps the socket off the wire", async () => {
    const socket = await inbox();
    liveClaude(501, CID(1), "idle", { messagingSocketPath: socket.socketPath, peerProtocol: 1 });
    liveClaude(502, CID(2), "idle");
    liveClaude(503, CID(3), "idle", { messagingSocketPath: socket.socketPath, peerProtocol: 2 });
    const t = setup();
    await t.start();
    await until(() => t.bridge.sessions().length === 3);
    const rows = Object.fromEntries(t.bridge.sessions().map((row) => [row.nativeId, row]));
    expect(rows[CID(1)].sendVia).toBe("inbox");
    expect(rows[CID(2)].sendVia).toBeUndefined();
    expect(rows[CID(3)].sendVia).toBeUndefined();
    const wire = JSON.stringify(t.messages.filter((m) => m.type === "cli.sessions"));
    expect(wire).not.toContain(socket.socketPath.replace(/\\/g, "\\\\"));
    expect(wire).not.toContain("messagingSocketPath");
    expect(wire).not.toContain('"route"');
    expect(wire).not.toContain(TOKEN);
  });

  it("sends through the inbox and confirms from the transcript", async () => {
    let transcript = "";
    const socket = await inbox((line) => {
      if (line.includes('"type":"user"')) appendFileSync(transcript, '{"type":"queue-operation","operation":"enqueue"}\n');
    });
    transcript = liveClaude(501, CID(1), "idle", { messagingSocketPath: socket.socketPath, peerProtocol: 1 });
    writeKey(501, socket.socketPath);
    const t = setup();
    await t.start();
    await until(() => t.bridge.sessions().some((row) => row.sendVia === "inbox"));
    const reply = await t.call("send", { ref: `claude:${CID(1)}`, text: "please continue" });
    expect(reply).toMatchObject({ ok: true, result: { turn: 0, started: false, delivery: "confirmed" } });
    expect((reply.result as Rec).waiting).toBeUndefined();
    expect(JSON.parse(socket.lines[0])).toEqual({ type: "auth", token: TOKEN });
    const sent = JSON.parse(socket.lines[1]);
    expect(sent).toMatchObject({ type: "user", session_id: CID(1), priority: "next", msgV: 1 });
    expect(sent.message.content).toContain("please continue");
    expect(sent.message.content).toContain("NexBot remote message");
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
  });

  it("says so when the message could not be confirmed, and when the session waits for an answer", async () => {
    const socket = await inbox();
    liveClaude(501, CID(1), "waiting", { messagingSocketPath: socket.socketPath, peerProtocol: 1, waitingFor: "approve Bash" });
    writeKey(501, socket.socketPath);
    const t = setup({ inboxConfirmMs: 100 });
    await t.start();
    await until(() => t.bridge.sessions().some((row) => row.sendVia === "inbox"));
    const reply = await t.call("send", { ref: `claude:${CID(1)}`, text: "hello" });
    expect(reply).toMatchObject({ ok: true, result: { delivery: "unconfirmed", waiting: true } });
  });

  it("refuses a slash command and a session whose inbox is gone, and sends nothing", async () => {
    const socket = await inbox();
    liveClaude(501, CID(1), "idle", { messagingSocketPath: socket.socketPath, peerProtocol: 1 });
    const gone = inboxName();
    liveClaude(502, CID(2), "idle", { messagingSocketPath: gone, peerProtocol: 1 });
    writeKey(501, socket.socketPath);
    writeKey(502, gone);
    const t = setup();
    await t.start();
    await until(() => t.bridge.sessions().filter((row) => row.sendVia === "inbox").length === 2);
    expect(await t.call("send", { ref: `claude:${CID(1)}`, text: "/clear" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(socket.lines).toEqual([]);
    expect(await t.call("send", { ref: `claude:${CID(2)}`, text: "hi" })).toMatchObject({ ok: false, error: { code: "stopped" } });
  });

  it("reports a missing key file without detail", async () => {
    const socket = await inbox();
    liveClaude(501, CID(1), "idle", { messagingSocketPath: socket.socketPath, peerProtocol: 1 });
    const t = setup();
    await t.start();
    await until(() => t.bridge.sessions().some((row) => row.sendVia === "inbox"));
    const reply = await t.call("send", { ref: `claude:${CID(1)}`, text: "hi" });
    expect(reply).toMatchObject({ ok: false, error: { code: "not_in_terminal" } });
    expect(socket.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Codex shared daemon

class FakeDaemon {
  readonly received: Rec[] = [];
  loaded: string[] = [];
  private onLine: (line: string) => void = () => {};
  private onClose: () => void = () => {};
  closed = false;
  readonly peer: DaemonPeer = {
    send: (line) => {
      if (this.closed) return false;
      const message = JSON.parse(line) as Rec;
      this.received.push(message);
      queueMicrotask(() => this.handle(message));
      return true;
    },
    close: () => {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
    },
    onLine: (listener) => void (this.onLine = listener),
    onClose: (listener) => void (this.onClose = listener),
  };
  push(message: Rec): void {
    this.onLine(JSON.stringify(message));
  }
  private handle(message: Rec): void {
    const { id, method } = message;
    if (id === undefined || typeof method !== "string") return;
    const params = (message.params ?? {}) as Rec;
    const result: Rec =
      method === "thread/loaded/list"
        ? { data: this.loaded, nextCursor: null }
        : method === "thread/turns/list"
          ? { data: [], nextCursor: null }
          : method === "turn/start"
            ? { turn: { id: "turn-1", status: "inProgress" } }
            : method === "thread/resume"
              ? { thread: { id: params.threadId } }
              : {};
    this.push({ id, result });
  }
  methods(): string[] {
    return this.received.flatMap((m) => (typeof m.method === "string" ? [m.method] : []));
  }
}

function codexRollout(id: string): void {
  const day = new Date(Date.now() - 3_600_000);
  const folder = path.join(codexHome, "sessions", String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0"));
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `rollout-2026-11-15T10-00-00-${id}.jsonl`);
  const at = day.toISOString();
  writeFileSync(
    file,
    [
      JSON.stringify({ timestamp: at, type: "session_meta", payload: { id, cwd: workDir, originator: "codex-tui", source: "cli", cli_version: "0.99.0" } }),
      JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "user_message", message: "earlier" } }),
    ].join("\n") + "\n",
  );
  utimesSync(file, day, day);
}

describe("Codex shared daemon", () => {
  async function joined() {
    codexRollout(XID(1));
    codexRollout(XID(2));
    const daemon = new FakeDaemon();
    daemon.loaded = [XID(1)];
    const t = setup({ codexDaemon: { connect: async () => daemon.peer, detect: async () => true, listEveryMs: 0, retryMs: 60_000 } });
    await t.start();
    await until(() => t.bridge.sessions().some((row) => row.nativeId === XID(1) && row.sendVia === "daemon"));
    return { t, daemon };
  }

  it("offers sending only for the threads the daemon has loaded", async () => {
    const { t } = await joined();
    const rows = Object.fromEntries(t.bridge.sessions().map((row) => [row.nativeId, row]));
    expect(rows[XID(1)]).toMatchObject({ sendVia: "daemon", state: "idle" });
    expect(rows[XID(2)].sendVia).toBeUndefined();
    expect(JSON.stringify(t.messages)).not.toContain('"route"');
  });

  it("starts a turn through the daemon", async () => {
    const { t, daemon } = await joined();
    const reply = await t.call("send", { ref: `codex:${XID(1)}`, text: "go on" });
    expect(reply).toMatchObject({ ok: true, result: { turn: 0, started: true } });
    expect(daemon.methods()).toEqual(expect.arrayContaining(["initialize", "initialized", "thread/resume", "turn/start"]));
    const start = daemon.received.find((m) => m.method === "turn/start")?.params as Rec;
    expect(start).toMatchObject({ threadId: XID(1), input: [{ type: "text", text: "go on" }] });
  });

  it("keeps refusing a thread the daemon does not have", async () => {
    const { t, daemon } = await joined();
    // a rollout that nothing runs reads as stopped, exactly as before
    expect(await t.call("send", { ref: `codex:${XID(2)}`, text: "x" })).toMatchObject({ ok: false, error: { code: "stopped" } });
    expect(daemon.methods()).not.toContain("turn/start");
  });

  it("relays an approval as a request and answers it through the daemon", async () => {
    const { t, daemon } = await joined();
    daemon.push({ id: "srv-1", method: "item/commandExecution/requestApproval", params: { threadId: XID(1), turnId: "t", itemId: "i", command: "npm test" } });
    await until(() => t.messages.some((m) => m.type === "cli.request"));
    const request = t.messages.find((m) => m.type === "cli.request") as Extract<DeviceCliMessage, { type: "cli.request" }>;
    expect(request).toMatchObject({ ref: `codex:${XID(1)}`, kind: "permission", tool: "shell", summary: "npm test" });
    const reply = await t.call("answer", { id: request.id, decision: "allow" });
    expect(reply).toMatchObject({ ok: true, result: { outcome: "ok" } });
    expect(daemon.received.at(-1)).toEqual({ id: "srv-1", result: { decision: "accept" } });
    expect(await t.call("answer", { id: request.id, decision: "allow" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("takes the send route away when the daemon goes", async () => {
    const { t, daemon } = await joined();
    daemon.peer.close();
    await until(() => t.bridge.sessions().find((row) => row.nativeId === XID(1))?.sendVia === undefined);
    expect(await t.call("send", { ref: `codex:${XID(1)}`, text: "x" })).toMatchObject({ ok: false, error: { code: "stopped" } });
  });

  it("does nothing about a daemon when there is no control socket", async () => {
    codexRollout(XID(1));
    let connects = 0;
    const t = setup({ codexDaemon: { connect: async () => (connects++, new FakeDaemon().peer) } });
    await t.start();
    await until(() => t.bridge.sessions().length === 1);
    expect(connects).toBe(0);
    expect(t.bridge.sessions()[0].sendVia).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Codex App chats that live only in the database

describe("Codex App chats", () => {
  function makeDb(): { addItem: (id: string, text: string, ordinal: number) => void } {
    const state = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER, recency_at_ms INTEGER, originator TEXT, source TEXT)");
    state.prepare("INSERT INTO threads (id, rollout_path, cwd, title, name, archived, recency_at_ms, originator, source) VALUES (?, '', ?, ?, NULL, 0, ?, 'Codex Desktop', 'vscode')").run(XID(7), workDir, "App only chat", Date.now() - 1000);
    state.close();
    const history = new DatabaseSync(path.join(codexHome, "thread_history_1.sqlite"));
    history.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, error_json TEXT, started_at INTEGER, completed_at INTEGER, rollout_end_ordinal INTEGER)");
    history.exec("CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT, updated_at_ordinal INTEGER)");
    history.prepare("INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at) VALUES (?, 't1', 0, 'completed', ?, ?)").run(XID(7), Date.now() - 9000, Date.now() - 8000);
    history.close();
    const addItem = (id: string, text: string, ordinal: number): void => {
      const db = new DatabaseSync(path.join(codexHome, "thread_history_1.sqlite"));
      db.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal) VALUES (?, 't1', ?, ?, ?, ?, NULL, ?)").run(
        XID(7),
        id,
        ordinal,
        Date.now() - 5000 + ordinal,
        JSON.stringify({ type: "agentMessage", id, text }),
        ordinal,
      );
      db.close();
    };
    return { addItem };
  }

  it("lists the chat, reads it and streams new items while watched", async () => {
    const { addItem } = makeDb();
    addItem("i1", "first answer", 1);
    const t = setup();
    await t.start();
    await until(() => t.bridge.sessions().some((row) => row.nativeId === XID(7)));
    const row = t.bridge.sessions().find((r) => r.nativeId === XID(7))!;
    expect(row).toMatchObject({ title: "App only chat", state: "idle", liveIn: "desktop" });
    expect(row.sendVia).toBeUndefined();

    const read = await t.call("read", { ref: `codex:${XID(7)}` });
    const items = (read.result as { items: Array<{ kind: string; text?: string }> }).items;
    expect(items.some((item) => item.kind === "assistant" && item.text === "first answer")).toBe(true);

    expect(await t.call("watch", { ref: `codex:${XID(7)}` })).toMatchObject({ ok: true });
    const pages = () => t.messages.filter((m): m is Extract<DeviceCliMessage, { type: "cli.items" }> => m.type === "cli.items" && m.ref === `codex:${XID(7)}`);
    expect(pages()[0].reset).toBe(true);
    addItem("i2", "second answer", 2);
    await until(() => pages().some((page) => page.items.some((item) => item.kind === "assistant" && item.text === "second answer")));
    expect(pages().at(-1)?.reset).toBe(true);

    await t.call("unwatch", { ref: `codex:${XID(7)}` });
    const count = pages().length;
    addItem("i3", "third answer", 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pages()).toHaveLength(count);
  });

  it("cannot be sent to or continued", async () => {
    makeDb();
    const t = setup();
    await t.start();
    await until(() => t.bridge.sessions().some((row) => row.nativeId === XID(7)));
    expect(await t.call("send", { ref: `codex:${XID(7)}`, text: "hi" })).toMatchObject({ ok: false, error: { code: "not_in_terminal" } });
    expect(await t.call("continue", { ref: `codex:${XID(7)}` })).toMatchObject({ ok: false, error: { code: "open_elsewhere" } });
  });
});
