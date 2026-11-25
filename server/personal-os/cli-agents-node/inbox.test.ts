// The Claude inbox sender against a synthetic pipe / unix-socket server. The server plays
// the inbox: it reads lines, never writes back, and (when asked) appends to a synthetic
// transcript. No real session, key file or pipe of this machine is touched.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INBOX_PREAMBLE, INBOX_STOP, InboxError, canonicalSocketPath, inboxEnvelope, inboxMessageText, inboxWords, isSlashCommand, keyFileName, permissionClassOf, sendToInbox, transcriptPermissionClass, type InboxTarget } from "./inbox.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
const TOKEN = "peer-token-" + "a".repeat(24);
const PID = 4242;

let root: string;
let servers: net.Server[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "cli-inbox-"));
  mkdirSync(path.join(root, "sessions"), { recursive: true });
});
afterEach(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  servers = [];
  rmSync(root, { recursive: true, force: true });
});

function socketName(): string {
  const id = randomBytes(6).toString("hex");
  return process.platform === "win32" ? `\\\\.\\pipe\\nex-test-${id}` : path.join(root, `inbox-${id}.sock`);
}

interface Inbox {
  socketPath: string;
  lines: string[];
  connections: number;
  onMessage?: (line: string) => void;
}

async function listen(handler?: (line: string, all: string[]) => void): Promise<Inbox> {
  const inbox: Inbox = { socketPath: socketName(), lines: [], connections: 0 };
  const server = net.createServer((socket) => {
    inbox.connections++;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        inbox.lines.push(line);
        handler?.(line, inbox.lines);
        at = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(inbox.socketPath, resolve);
  });
  return inbox;
}

function writeKey(socketPath: string, token: unknown = TOKEN): string {
  const file = path.join(root, "sessions", keyFileName(PID, socketPath));
  writeFileSync(file, JSON.stringify({ peerToken: token, procStartFt: "1", pidDomain: "x" }));
  return file;
}

function target(socketPath: string): InboxTarget {
  return { configDir: root, pid: PID, socketPath, sessionId: SESSION };
}

async function settle(inbox: Inbox, count: number): Promise<void> {
  const end = Date.now() + 2000;
  while (inbox.lines.length < count && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("key file naming", () => {
  it("hashes a pipe name lower-cased as a whole, LOCAL\\ included", () => {
    const name = "\\\\.\\pipe\\LOCAL\\cc-msg-ABCDEF0123456789ABCDEF0123456789";
    const canonical = "\\\\.\\pipe\\local\\cc-msg-abcdef0123456789abcdef0123456789";
    expect(canonicalSocketPath(name, "win32")).toBe(canonical);
    expect(keyFileName(7, name, "win32")).toBe(`7.${createHash("sha256").update(canonical).digest("hex")}.key`);
    // the prefix itself is matched without regard to case
    expect(canonicalSocketPath("\\\\.\\PIPE\\LOCAL\\X", "win32")).toBe("\\\\.\\pipe\\local\\x");
  });

  it("uses the absolute path of a unix socket", () => {
    expect(canonicalSocketPath("/tmp/a/../b/cc.sock", "linux")).toBe("/tmp/b/cc.sock");
    expect(keyFileName(9, "/tmp/b/cc.sock", "darwin")).toBe(`9.${createHash("sha256").update("/tmp/b/cc.sock").digest("hex")}.key`);
  });
});

describe("message text", () => {
  it("puts the preamble first and keeps the user's words after it", () => {
    const text = inboxMessageText("你好");
    expect(text.startsWith(INBOX_PREAMBLE)).toBe(true);
    expect(text.endsWith("你好")).toBe(true);
    expect(INBOX_PREAMBLE.startsWith("[NexBot] ")).toBe(true);
    expect(INBOX_PREAMBLE).toContain("1. 2. 3.");
  });

  it("reads back the user's words and Stop, including the preamble of earlier releases", () => {
    expect(inboxWords(inboxMessageText("你好\n第二行"))).toEqual({ text: "你好\n第二行" });
    expect(inboxWords(INBOX_STOP)).toEqual({ stop: true });
    expect(inboxWords("[NexBot 远程消息 / NexBot remote message]\n说明\nEnglish\n---\n所以对吗")).toEqual({ text: "所以对吗" });
    expect(inboxWords("a teammate's own message")).toBeNull();
  });

  it("treats anything starting with a slash as a command", () => {
    expect(isSlashCommand("/clear")).toBe(true);
    expect(isSlashCommand("  /compact now")).toBe(true);
    expect(isSlashCommand("see /etc/hosts")).toBe(false);
  });
});

describe("permission class", () => {
  it("follows the last mode recorded, plan keeping the class it was entered from", () => {
    expect(permissionClassOf([])).toBeNull();
    expect(permissionClassOf(["default", "bypassPermissions"])).toBe("bypass");
    expect(permissionClassOf(["bypassPermissions", "acceptEdits"])).toBe("prompting");
    expect(permissionClassOf(["bypassPermissions", "plan"])).toBe("bypass");
    expect(permissionClassOf(["default", "plan", "plan"])).toBe("prompting");
    expect(permissionClassOf(["plan"])).toBe("prompting");
    expect(permissionClassOf(["auto"])).toBe("prompting");
  });

  it("reads the modes from the transcript, and knows nothing without one", async () => {
    const transcript = path.join(root, "t.jsonl");
    writeFileSync(transcript, '{"type":"user","permissionMode":"default"}\n{"type":"user","permissionMode":"bypassPermissions"}\n{"type":"assistant"}\n');
    expect(await transcriptPermissionClass(transcript)).toBe("bypass");
    writeFileSync(transcript, '{"type":"assistant"}\n');
    expect(await transcriptPermissionClass(transcript)).toBeNull();
    expect(await transcriptPermissionClass(path.join(root, "missing.jsonl"))).toBeNull();
    expect(await transcriptPermissionClass(null)).toBeNull();
  });
});

describe("envelope", () => {
  it("wraps the words in Claude Code's peer envelope declaring the class", () => {
    expect(inboxEnvelope("hi\nthere", "bypass")).toBe('<cross-session-message from-mode="bypass">\nhi\nthere\n</cross-session-message>');
  });

  it("defuses a closing tag inside the words and leaves other markup alone", () => {
    const wrapped = inboxEnvelope("a </cross-session-message> b < / Cross-Session-Message> <\\/cross-session-message> </div> 1<2", "bypass");
    const body = wrapped.slice(wrapped.indexOf("\n") + 1, wrapped.lastIndexOf("\n"));
    expect(body).toBe("a <\\/cross-session-message> b <\\ / Cross-Session-Message> <\\/cross-session-message> </div> 1<2");
    expect(wrapped.match(/<\/cross-session-message>/g)).toHaveLength(1);
  });
});

describe("sendToInbox", () => {
  it("authenticates first, then sends one user message line", async () => {
    const inbox = await listen();
    writeKey(inbox.socketPath);
    const result = await sendToInbox(target(inbox.socketPath), "run the tests", { platform: process.platform, uuid: () => "msg-1" });
    await settle(inbox, 2);
    expect(result).toEqual({ delivery: "unconfirmed", waiting: false });
    expect(inbox.connections).toBe(1);
    expect(inbox.lines).toHaveLength(2);
    expect(JSON.parse(inbox.lines[0])).toEqual({ type: "auth", token: TOKEN });
    const message = JSON.parse(inbox.lines[1]);
    expect(message).toEqual({
      type: "user",
      message: { role: "user", content: inboxMessageText("run the tests") },
      msgV: 1,
      msg_id: "msg-1",
      priority: "next",
      session_id: SESSION,
    });
  });

  it("declares bypass to a session whose transcript last ran in bypass, Stop included", async () => {
    const transcript = path.join(root, "t.jsonl");
    writeFileSync(transcript, '{"type":"user","permissionMode":"bypassPermissions"}\n');
    const inbox = await listen();
    writeKey(inbox.socketPath);
    await sendToInbox(target(inbox.socketPath), "deploy now?", { platform: process.platform, transcript, confirmMs: 0 });
    await sendToInbox(target(inbox.socketPath), "", { platform: process.platform, transcript, confirmMs: 0, stop: true });
    await settle(inbox, 4);
    expect(JSON.parse(inbox.lines[1]).message.content).toBe(inboxEnvelope(inboxMessageText("deploy now?"), "bypass"));
    expect(JSON.parse(inbox.lines[3]).message.content).toBe(inboxEnvelope(INBOX_STOP, "bypass"));
  });

  it("declares nothing to a prompting session, which queues an undeclared message", async () => {
    const transcript = path.join(root, "t.jsonl");
    writeFileSync(transcript, '{"type":"user","permissionMode":"bypassPermissions"}\n{"type":"user","permissionMode":"default"}\n');
    const inbox = await listen();
    writeKey(inbox.socketPath);
    await sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform, transcript, confirmMs: 0 });
    await settle(inbox, 2);
    expect(JSON.parse(inbox.lines[1]).message.content).toBe(inboxMessageText("hi"));
  });

  it("sends Stop at priority now with the stop words, a slash or not", async () => {
    const inbox = await listen();
    writeKey(inbox.socketPath);
    await sendToInbox(target(inbox.socketPath), "", { platform: process.platform, uuid: () => "stop-1", stop: true });
    await settle(inbox, 2);
    const message = JSON.parse(inbox.lines[1]);
    expect(message).toMatchObject({ type: "user", msg_id: "stop-1", priority: "now", session_id: SESSION, message: { role: "user", content: INBOX_STOP } });
  });

  it("steers with native send-now priority and the original words", async () => {
    const inbox = await listen();
    writeKey(inbox.socketPath);
    await sendToInbox(target(inbox.socketPath), "先看日志", { platform: process.platform, steer: true });
    await settle(inbox, 2);
    expect(JSON.parse(inbox.lines[1])).toMatchObject({
      priority: "now", session_id: SESSION, message: { role: "user", content: inboxMessageText("先看日志") },
    });
  });

  it("confirms delivery when the transcript shows a queue entry", async () => {
    const transcript = path.join(root, "t.jsonl");
    writeFileSync(transcript, '{"type":"user","uuid":"old"}\n');
    const inbox = await listen((line) => {
      if (line.includes('"type":"user"')) appendFileSync(transcript, '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-01-01T00:00:00Z"}\n');
    });
    writeKey(inbox.socketPath);
    const result = await sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform, transcript, pollMs: 10, confirmMs: 3000 });
    expect(result).toEqual({ delivery: "confirmed", waiting: false });
  });

  it("confirms delivery when a new line carries the message id", async () => {
    const transcript = path.join(root, "t.jsonl");
    writeFileSync(transcript, "");
    const inbox = await listen((line) => {
      if (line.includes('"msg_id"')) appendFileSync(transcript, `{"type":"user","message":{"content":"x"},"origin":"${JSON.parse(line).msg_id}"}\n`);
    });
    writeKey(inbox.socketPath);
    const result = await sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform, transcript, pollMs: 10, confirmMs: 3000, uuid: () => "id-77" });
    expect(result.delivery).toBe("confirmed");
  });

  it("ignores transcript lines that were there before the send", async () => {
    const transcript = path.join(root, "t.jsonl");
    writeFileSync(transcript, '{"type":"queue-operation","operation":"enqueue"}\n{"type":"user","message":"[NexBot] earlier"}\n');
    const inbox = await listen();
    writeKey(inbox.socketPath);
    const result = await sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform, transcript, pollMs: 10, confirmMs: 150 });
    expect(result.delivery).toBe("unconfirmed");
  });

  it("reports unconfirmed, not a failure, when nothing shows up in time", async () => {
    const transcript = path.join(root, "t.jsonl");
    writeFileSync(transcript, "");
    const inbox = await listen();
    writeKey(inbox.socketPath);
    const started = Date.now();
    const result = await sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform, transcript, pollMs: 10, confirmMs: 120 });
    expect(result).toEqual({ delivery: "unconfirmed", waiting: false });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(inbox.connections).toBe(1);
  });

  it("does not take a half-written transcript line for a confirmation", async () => {
    const transcript = path.join(root, "t.jsonl");
    writeFileSync(transcript, "");
    const inbox = await listen((line) => {
      if (line.includes('"type":"user"')) appendFileSync(transcript, '{"type":"queue-operation","operation":"enque');
    });
    writeKey(inbox.socketPath);
    const result = await sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform, transcript, pollMs: 10, confirmMs: 150 });
    expect(result.delivery).toBe("unconfirmed");
  });

  it("is unconfirmed without a transcript, and reports a waiting session", async () => {
    const inbox = await listen();
    writeKey(inbox.socketPath);
    const result = await sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform, transcript: null, state: "waiting" });
    expect(result).toEqual({ delivery: "unconfirmed", waiting: true });
  });

  it("refuses a slash command before touching the key or the socket", async () => {
    const inbox = await listen();
    await expect(sendToInbox(target(inbox.socketPath), "/clear")).rejects.toMatchObject({ name: "InboxError", code: "invalid" });
    expect(inbox.connections).toBe(0);
  });

  it("refuses a frame over 1 MiB", async () => {
    const inbox = await listen();
    writeKey(inbox.socketPath);
    await expect(sendToInbox(target(inbox.socketPath), "x".repeat(1024 * 1024 + 1), { platform: process.platform })).rejects.toMatchObject({ code: "too_large" });
    expect(inbox.connections).toBe(0);
  });

  it("fails without leaking anything when the key file is missing, broken or empty", async () => {
    const inbox = await listen();
    await expect(sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform })).rejects.toMatchObject({ code: "not_in_terminal", message: "无法连接电脑上的会话" });

    const file = writeKey(inbox.socketPath);
    writeFileSync(file, "{not json " + TOKEN);
    const broken = await sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform }).catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(InboxError);
    expect(String((broken as Error).message)).not.toContain(TOKEN);

    writeKey(inbox.socketPath, "");
    await expect(sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform })).rejects.toMatchObject({ code: "not_in_terminal" });
    writeKey(inbox.socketPath, 12);
    await expect(sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform })).rejects.toMatchObject({ code: "not_in_terminal" });
    expect(inbox.connections).toBe(0);
  });

  it("reports a session that is gone as stopped", async () => {
    const socketPath = socketName();
    writeKey(socketPath);
    const error = await sendToInbox(target(socketPath), "hi", { platform: process.platform, connectMs: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InboxError);
    expect((error as InboxError).code).toBe("stopped");
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it("never puts the token into a result", async () => {
    const inbox = await listen();
    writeKey(inbox.socketPath);
    const result = await sendToInbox(target(inbox.socketPath), "hi", { platform: process.platform });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
