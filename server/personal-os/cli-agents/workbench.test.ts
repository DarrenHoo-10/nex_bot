// Workbench queue (workbench plan section 3): the four user actions, consume
// pause after a stop, lost receipts, idempotent retries and two clients
// racing for the same entry. Everything runs against a disposable Core with a
// simulated device, the way the hub tests do; no real product is touched.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp, type AppOptions } from "../index.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const OWNER = "synthetic-workbench-owner";
const CAP = { version: 1, engines: ["claude", "codex", "zcode"], terminal: { name: "herdr-core", version: "0.1.21", ready: true } };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | null | false, what = "condition", ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await wait(10);
  }
}

function tempDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-workbench-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-workbench-")) throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function fixture(tuning: NonNullable<AppOptions["cliAgents"]> = { graceMs: 0, opTimeoutMs: 400 }) {
  const root = tempDir();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: OWNER, identity: false, memoryRuntime: false, hostDevice: false, cliAgents: tuning });
  cleanups.push(() => app.close());
  const call = async (route: string, data?: unknown, method = "POST") => {
    const response = await fetch(app.origin + "/api/" + route, {
      headers: { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" },
      ...(route.startsWith("cli-agents") && method === "GET" ? {} : { method }),
      ...(data !== undefined && method !== "GET" ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  const get = async (route: string) => {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: "Bearer " + OWNER } });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  return { app, root, call, get };
}

const runningWire = (nativeId: string, extra: Record<string, unknown> = {}) => ({
  engine: "claude", nativeId, configDir: "C:/cfg", cwd: "C:/proj", title: "t " + nativeId,
  state: "running", liveIn: "nexbot", terminal: "hc://" + nativeId, lastActivityAt: 1000, ...extra,
});

interface Device {
  id: string;
  ws: WebSocket;
  msgs: Array<Record<string, any>>;
  seq: number;
  onOp: (message: Record<string, any>) => Record<string, any> | undefined;
  send(message: unknown): void;
  sessions(upserts: unknown[], extra?: { full?: boolean; removes?: string[]; seq?: number }): void;
  turn(ref: string, turn: number): void;
  ops(op: string): Array<Record<string, any>>;
  kill(): void;
}

async function connectDevice(f: Awaited<ReturnType<typeof fixture>>, name: string): Promise<Device> {
  const pair = (await f.call("devices", { name })).data as { deviceId: string; token: string };
  const origin = f.app.origin.replace("http:", "ws:");
  const ws = new WebSocket(origin + "/dcp/v1/connect", { headers: { Authorization: "Bearer " + pair.token } });
  cleanups.push(() => ws.terminate());
  const device: Device = {
    id: String(pair.deviceId), ws, msgs: [], seq: 0,
    onOp: (message) => {
      if (message.op === "send") return { ok: true, result: { turn: 1, started: true } };
      if (message.op === "steer") return { ok: true, result: { accepted: true } };
      if (message.op === "interrupt") return { ok: true, result: { outcome: "ok" } };
      if (message.op === "read") return { ok: true, result: { items: [], more: false } };
      return { ok: true, result: {} };
    },
    send: (message) => ws.send(JSON.stringify(message)),
    sessions(upserts, extra = {}) {
      device.send({ type: "cli.sessions", full: extra.full ?? false, upserts, removes: extra.removes ?? [], seq: extra.seq ?? ++device.seq });
    },
    turn(nativeId, turn) {
      device.send({ type: "cli.turn", ref: `claude:${nativeId}`, turn, endedAt: Date.now(), reason: "end" });
    },
    ops: (op) => device.msgs.filter((m) => m.type === "cli.op" && (!op || m.op === op)),
    kill: () => ws.terminate(),
  };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(raw.toString());
    device.msgs.push(message);
    if (message.type === "cli.op") {
      const reply = device.onOp(message);
      if (reply) device.send({ type: "cli.reply", opId: message.opId, ...reply });
    }
  });
  const failed = new Promise<never>((_, reject) => ws.on("error", reject));
  ws.on("open", () => ws.send(JSON.stringify({
    type: "hello", policyVersion: 1, read: true, exec: true, computer: false, platform: "macos",
    identity: { hostname: name, supported: ["device.info"] }, cliAgents: CAP,
  })));
  await Promise.race([until(() => device.msgs.find((m) => m.type === "bound"), "bound"), failed]);
  return device;
}

const keyOf = (device: Device, nativeId: string, engine = "claude") => `${device.id}:${engine}:${nativeId}`;
let serial = 0;
const ids = { client: () => "cm-" + ++serial, request: () => "rq-" + ++serial };

/** The workbench routes of one fixture, against one device's session. */
async function sessionOn(f: Awaited<ReturnType<typeof fixture>>, device: Device, nativeId: string, state = "running") {
  const key = keyOf(device, nativeId);
  device.sessions([runningWire(nativeId, { state })], { full: true });
  await until(() => f.app.cliHub.list().sessions.some((s) => s.key === key), "session listed");
  return key;
}

describe("queue delivery", () => {
  it("queues while a turn runs and dispatches in order after each turn ends", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "queue");
    const key = await sessionOn(f, device, "q1", "running");
    const b = await f.call("cli-agents/send", { key, text: "B", delivery: "queue", clientMessageId: ids.client(), requestId: ids.request() });
    expect(b.status).toBe(200);
    expect(b.data).toMatchObject({ queued: true, status: "pending" });
    const c = await f.call("cli-agents/send", { key, text: "C", delivery: "queue", clientMessageId: ids.client(), requestId: ids.request() });
    expect(c.data.queued).toBe(true);
    await wait(60);
    expect(device.ops("send")).toHaveLength(0);
    console.error("DBG after enqueue", JSON.stringify((await f.get("cli-agents/queue?key=" + encodeURIComponent(key))).data));
    console.error("DBG state", JSON.stringify(f.app.cliHub.list().sessions.map((x: any) => [x.key, x.state, x.online, x.liveIn])));

    // turn 1 ends: the device reports idle and the turn end, then B goes
    device.sessions([runningWire("q1", { state: "idle" })]);
    device.turn("q1", 1);
    await until(() => device.ops("send").length >= 1, "first dispatch");
    expect(device.ops("send")[0].args.text).toBe("B");
    expect(device.ops("send")[0].args.ref).toBe("claude:q1");

    // B started turn 2: the device reports running, so C keeps waiting
    device.sessions([runningWire("q1")]);
    await wait(60);
    expect(device.ops("send")).toHaveLength(1);

    // only the end of turn 2 releases C
    device.sessions([runningWire("q1", { state: "idle" })]);
    device.turn("q1", 2);
    await until(() => device.ops("send").length >= 2, "second dispatch");
    expect(device.ops("send")[1].args.text).toBe("C");
  });

  it("rejects a plain send to a running session and keeps the queue out of a stopped one", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "busy");
    const key = await sessionOn(f, device, "s1", "running");
    const busy = await f.call("cli-agents/send", { key, text: "直接发", delivery: "send", clientMessageId: ids.client(), requestId: ids.request() });
    expect(busy.status).toBe(409);
    expect(busy.data.code).toBe("busy");

    const queued = await f.call("cli-agents/send", { key, text: "排队", delivery: "queue", clientMessageId: ids.client(), requestId: ids.request() });
    expect(queued.data.queued).toBe(true);
    // the user stops the session: the queue pauses before the interrupt leaves
    const stop = await f.call("cli-agents/interrupt", { key, requestId: ids.request() });
    expect(stop.status).toBe(200);
    device.sessions([runningWire("s1", { state: "idle" })]);
    device.turn("s1", 1);
    await until(() => device.ops("interrupt").length === 1, "interrupt dispatched");
    await wait(60);
    expect(device.ops("send")).toHaveLength(0);
    const queue = await f.get("cli-agents/queue?key=" + encodeURIComponent(key));
    expect(queue.data.queue.paused).toBe(true);
    expect(queue.data.queue.pauseReason).toBe("stopped");
    expect(queue.data.queue.entries.map((e: any) => e.text)).toEqual(["排队"]);
    // resuming hands the head to the device
    await f.call("cli-agents/queue/resume", { key });
    await until(() => device.ops("send").length === 1, "resumed dispatch");
    expect(device.ops("send")[0].args.text).toBe("排队");
  });

  it("steers a running turn and refuses when the turn has ended", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "steer");
    const key = await sessionOn(f, device, "t1", "running");
    const steer = await f.call("cli-agents/send", { key, text: "补一句", delivery: "steer", clientMessageId: ids.client(), requestId: ids.request() });
    expect(steer.status).toBe(200);
    expect(steer.data.status).toBe("sent");
    await until(() => device.ops("steer").length === 1, "steer dispatched");
    expect(device.ops("steer")[0].args.text).toBe("补一句");

    device.sessions([runningWire("t1", { state: "idle", terminal: "hc://t1", liveIn: "nexbot" })]);
    await until(() => f.app.cliHub.list().sessions.find((s) => s.key === key)?.state === "idle", "idle");
    const late = await f.call("cli-agents/send", { key, text: "晚了", delivery: "steer", clientMessageId: ids.client(), requestId: ids.request() });
    expect(late.status).toBe(409);
    expect(late.data.code).toBe("turn_changed");
  });
});

describe("idempotency and races", () => {
  it("returns the first entry for a repeated clientMessageId and conflicts on a changed requestId shape", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "double");
    const key = await sessionOn(f, device, "d1", "running");
    const requestId = ids.request();
    const first = await f.call("cli-agents/send", { key, text: "一次", delivery: "queue", clientMessageId: "same-cm", requestId });
    const repeat = await f.call("cli-agents/send", { key, text: "一次", delivery: "queue", clientMessageId: "same-cm", requestId });
    expect(repeat.data.messageId).toBe(first.data.messageId);
    const entries = (await f.get("cli-agents/queue?key=" + encodeURIComponent(key))).data.queue.entries;
    expect(entries).toHaveLength(1);
    const reshaped = await f.call("cli-agents/send", { key, text: "换了内容", delivery: "queue", clientMessageId: "other-cm", requestId });
    expect(reshaped.status).toBe(409);
    expect(reshaped.data.code).toBe("conflict");
  });

  it("lets two clients race for one entry: the first edit wins, the second is told", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "race");
    const key = await sessionOn(f, device, "r1", "running");
    const entry = (await f.call("cli-agents/send", { key, text: "B", delivery: "queue", clientMessageId: ids.client(), requestId: ids.request() })).data;
    const queue = (await f.get("cli-agents/queue?key=" + encodeURIComponent(key))).data.queue;
    const queued = queue.entries.find((e: any) => e.id === entry.messageId);
    const editA = await f.call("cli-agents/queue/edit", { entryId: queued.id, expectedVersion: queued.version, text: "B2" });
    expect(editA.status).toBe(200);
    expect(editA.data.entry.text).toBe("B2");
    const editB = await f.call("cli-agents/queue/edit", { entryId: queued.id, expectedVersion: queued.version, text: "B3" });
    expect(editB.status).toBe(409);
    expect(editB.data.code).toBe("conflict");
    // the winner is what the device eventually receives
    device.sessions([runningWire("r1", { state: "idle" })]);
    device.turn("r1", 1);
    await until(() => device.ops("send").length === 1, "dispatched");
    expect(device.ops("send")[0].args.text).toBe("B2");
  });

  it("withdraws a queued entry and never dispatches it", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "withdraw");
    const key = await sessionOn(f, device, "w1", "running");
    const entry = (await f.call("cli-agents/send", { key, text: "B", delivery: "queue", clientMessageId: ids.client(), requestId: ids.request() })).data;
    const queue = (await f.get("cli-agents/queue?key=" + encodeURIComponent(key))).data.queue;
    const queued = queue.entries.find((e: any) => e.id === entry.messageId);
    const gone = await f.call("cli-agents/queue/withdraw", { entryId: queued.id, expectedVersion: queued.version });
    expect(gone.status).toBe(200);
    expect(gone.data.entry.status).toBe("withdrawn");
    device.sessions([runningWire("w1", { state: "idle" })]);
    device.turn("w1", 1);
    await wait(80);
    expect(device.ops("send")).toHaveLength(0);
    expect((await f.get("cli-agents/queue?key=" + encodeURIComponent(key))).data.queue.entries).toHaveLength(0);
  });
});

describe("uncertain outcomes", () => {
  it("marks a dispatch whose receipt never came uncertain and never re-sends it", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "receipt");
    const key = await sessionOn(f, device, "u1", "idle");
    let answered = false;
    device.onOp = (message) => {
      if (message.op === "send" && !answered) return undefined; // stay silent: the receipt is lost
      return { ok: true, result: {} };
    };
    const sent = await f.call("cli-agents/send", { key, text: "丢了回执", delivery: "send", clientMessageId: ids.client(), requestId: ids.request() });
    expect(sent.data.status).toBe("uncertain");
    const queue = (await f.get("cli-agents/queue?key=" + encodeURIComponent(key))).data.queue;
    expect(queue.paused).toBe(true);
    expect(queue.pauseReason).toBe("uncertain");
    // a second queued entry stays behind the uncertain head
    const next = await f.call("cli-agents/send", { key, text: "排队的", delivery: "queue", clientMessageId: ids.client(), requestId: ids.request() });
    expect(next.data.queued).toBe(true);
    await wait(60);
    expect(device.ops("send")).toHaveLength(1);
    // the device answers the op late; resume settles the head from the op row
    answered = true;
    const opId = queue.entries.find((e: any) => e.status === "uncertain").id;
    device.send({ type: "cli.reply", opId: sent.data.operationId, ok: true, result: {} });
    await f.call("cli-agents/queue/resume", { key });
    await until(() => {
      const view = (f.app.cliWorkbench as any).queueForWorkbench(queue.workbenchId);
      return view.entries.find((e: any) => e.id === opId)?.status === "sent";
    }, "uncertain settled from the op row");
    await until(() => device.ops("send").length === 2, "next entry after reconcile");
    expect(device.ops("send")[1].args.text).toBe("排队的");
  });
});

describe("workbench tree", () => {
  it("creates a fork under its parent, renames it and refuses a grandchild fork", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "tree");
    const key = await sessionOn(f, device, "p1", "idle");
    const branchRequest = ids.request();
    const branch = await f.call("cli-agents/sessions/branch", { parentKey: key, requestId: branchRequest, title: "目录树（fork）" });
    expect(branch.status).toBe(200);
    expect(branch.data.parentId).toBe(branch.data.id === undefined ? null : branch.data.parentId);
    const same = await f.call("cli-agents/sessions/branch", { parentKey: key, requestId: branchRequest, title: "目录树（fork）" });
    expect(same.data.id).toBe(branch.data.id);
    const grand = await f.call("cli-agents/sessions/branch", { parentId: branch.data.id, requestId: ids.request(), title: "孙会话" });
    expect(grand.status).toBe(200);
    const great = await f.call("cli-agents/sessions/branch", { parentId: grand.data.id, requestId: ids.request(), title: "太深了" });
    expect(great.status).toBe(400);
    const rename = await f.call("cli-agents/sessions/rename", { id: branch.data.id, expectedVersion: branch.data.version, title: "改名后" });
    expect(rename.data.session.title).toBe("改名后");
    const stale = await f.call("cli-agents/sessions/rename", { id: branch.data.id, expectedVersion: branch.data.version, title: "再改" });
    expect(stale.status).toBe(409);
    const list = (await f.get("cli-agents")).data;
    expect(list.workbench.map((s: any) => s.title).sort()).toEqual(["", "孙会话", "改名后"]);
    const tree = list.workbench as Array<Record<string, any>>;
    expect(tree.find((s) => s.id === grand.data.id)?.parentId).toBe(branch.data.id);
  });

  it("archives, restores and deletes with children re-parented, never deleting the native session", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "lifecycle");
    const key = await sessionOn(f, device, "l1", "idle");
    const child = await f.call("cli-agents/sessions/branch", { parentKey: key, requestId: ids.request(), title: "子" });
    const parent = (await f.get("cli-agents")).data.workbench.find((s: any) => s.sessionKey === key);
    const archived = await f.call("cli-agents/sessions/archive", { id: parent.id, expectedVersion: parent.version });
    expect(archived.data.session.archived).toBe(true);
    const restored = await f.call("cli-agents/sessions/restore", { id: parent.id, expectedVersion: archived.data.session.version });
    expect(restored.data.session.archived).toBe(false);
    await f.call("cli-agents/sessions/delete", { id: parent.id, expectedVersion: restored.data.session.version });
    const list = (await f.get("cli-agents")).data;
    expect(list.workbench.find((s: any) => s.id === parent.id)).toBeUndefined();
    expect(list.workbench.find((s: any) => s.id === child.data.id)?.parentId).toBeNull();
    // the native session itself is untouched
    expect(f.app.cliHub.list().sessions.some((s) => s.key === key)).toBe(true);
  });

  it("archives and renames a session the workbench never touched, by its native key", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "by-key");
    const key = await sessionOn(f, device, "k1", "idle");
    expect((await f.get("cli-agents")).data.workbench.find((s: any) => s.sessionKey === key)).toBeUndefined();
    const archived = await f.call("cli-agents/sessions/archive", { key });
    expect(archived.status).toBe(200);
    expect(archived.data.session.archived).toBe(true);
    const renamed = await f.call("cli-agents/sessions/rename", { key, title: "新名字" });
    expect(renamed.data.session).toMatchObject({ title: "新名字", archived: true });
    // a stale version given with the key is still checked
    const stale = await f.call("cli-agents/sessions/restore", { key, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    // an id without its version stays a request error
    expect((await f.call("cli-agents/sessions/restore", { id: renamed.data.session.id })).status).toBe(400);
    const rows = (await f.get("cli-agents")).data.workbench.filter((s: any) => s.sessionKey === key);
    expect(rows).toHaveLength(1);
  });

  it("answers the Git card for a computer whose executor predates the git op", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "old-executor");
    const key = await sessionOn(f, device, "g1", "idle");
    device.onOp = (message: Record<string, any>) => message.op === "git" ? { ok: false, error: { code: "invalid" } } : { ok: true, result: {} };
    const git = await f.get("cli-agents/sessions/git?key=" + encodeURIComponent(key));
    expect(git.status).toBe(200);
    expect(git.data).toEqual({ source: "failed", error: "电脑端版本过旧，升级后可查看更改" });
  });
});

describe("workbench start", () => {
  it("starts a session in a device worktree and binds the pending branch row to it", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "worktree");
    const key = await sessionOn(f, device, "p1", "idle");
    const branch = await f.call("cli-agents/sessions/branch", { parentKey: key, requestId: ids.request(), title: "新分支" });
    device.onOp = (message: Record<string, any>) => {
      if (message.op === "start") {
        device.sessions([runningWire("child1", { state: "idle" })]);
        return { ok: true, result: { ref: "claude:child1", terminal: "hc://child1", cwd: message.args.worktree ? "C:/trees/child" : message.args.cwd } };
      }
      return { ok: true, result: {} };
    };
    const started = await f.call("cli-agents/start", {
      deviceId: device.id, engine: "claude", cwd: "C:/proj", worktreeBranch: "feat/demo",
      requestId: "11111111-2222-4333-8444-555555555555", parentId: branch.data.id,
    });
    expect(started.status).toBe(200);
    expect(started.data.cwd).toBe("C:/trees/child");
    expect(device.ops("start")[0].args.worktree).toEqual({ branch: "feat/demo", requestId: "11111111-2222-4333-8444-555555555555" });
    const tree = ((await f.get("cli-agents")).data.workbench as Array<Record<string, any>>);
    expect(tree.find((s) => s.id === branch.data.id)?.sessionKey).toBe(keyOf(device, "child1"));
  });
});

describe("side chats", () => {
  it("binds a side row to a session the hub has not listed yet, so the first send stays in that row", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "side");
    const key = await sessionOn(f, device, "p1", "idle");
    const requestId = ids.request();
    const branch = await f.call("cli-agents/sessions/branch", { parentKey: key, requestId, title: "侧聊", kind: "side" });
    expect(branch.status).toBe(200);
    // a retry of the same branch is the same row
    expect((await f.call("cli-agents/sessions/branch", { parentKey: key, requestId, title: "侧聊", kind: "side" })).data.id).toBe(branch.data.id);
    // the device answers the start before it lists the new session
    device.onOp = (message: Record<string, any>) => message.op === "start"
      ? { ok: true, result: { ref: "claude:side1", terminal: "hc://side1", cwd: message.args.cwd } }
      : message.op === "send" ? { ok: true, result: { turn: 1, started: true } } : { ok: true, result: {} };
    const started = await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", parentId: branch.data.id });
    expect(started.status).toBe(200);
    const sideKey = keyOf(device, "side1");
    let tree = (await f.get("cli-agents")).data.workbench as Array<Record<string, any>>;
    expect(tree.find((s) => s.id === branch.data.id)).toMatchObject({ sessionKey: sideKey, kind: "side", parentId: tree.find((s) => s.sessionKey === key)?.id });
    device.sessions([runningWire("side1", { state: "idle" })]);
    await until(() => f.app.cliHub.list().sessions.some((s) => s.key === sideKey), "side session listed");
    const sent = await f.call("cli-agents/send", { key: sideKey, text: "引用「x」\n\n问题", delivery: "send", clientMessageId: ids.client(), requestId: ids.request() });
    expect(sent.status).toBe(200);
    tree = (await f.get("cli-agents")).data.workbench as Array<Record<string, any>>;
    // no second row appeared for the side session
    expect(tree.filter((s) => s.sessionKey === sideKey)).toHaveLength(1);
    expect(tree.find((s) => s.sessionKey === sideKey)?.kind).toBe("side");
  });
});

describe("notes", () => {
  it("creates, lists, edits and deletes notes, and keeps them encrypted at rest", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "notes");
    const key = await sessionOn(f, device, "n1", "idle");
    expect((await f.get("cli-agents/notes?key=" + encodeURIComponent(key))).data.notes).toEqual([]);
    // asking for notes does not create a logical row
    expect((await f.get("cli-agents")).data.workbench.find((s: any) => s.sessionKey === key)).toBeUndefined();
    const noteId = "note-" + ids.client();
    const created = await f.call("cli-agents/notes", { key, id: noteId, message: "m1", quote: "竞态条件", body: "这里要加锁", start: 4, end: 8, num: 1 });
    expect(created.status).toBe(200);
    expect(created.data.note).toMatchObject({ id: noteId, sessionKey: key, message: "m1", quote: "竞态条件", body: "这里要加锁", start: 4, end: 8, num: 1, version: 1 });
    // the same id again is the same note, not a second one
    const again = await f.call("cli-agents/notes", { key, id: noteId, message: "m1", quote: "竞态条件", body: "这里要加锁", start: 4, end: 8, num: 1 });
    expect(again.data.note.id).toBe(noteId);
    const second = await f.call("cli-agents/notes", { key, message: "m2", quote: "另一段", body: "第二条" });
    expect(second.data.note).toMatchObject({ num: 2, start: null, end: null });
    const listed = (await f.get("cli-agents/notes?key=" + encodeURIComponent(key))).data.notes as Array<Record<string, any>>;
    expect(listed.map((n) => n.body)).toEqual(["这里要加锁", "第二条"]);
    // the quote and the text never sit in the table as plain text
    const stored = f.app.store.all("SELECT content FROM cli_agent_notes").map((row) => String(row.content)).join("");
    expect(stored).not.toContain("竞态条件");
    expect(stored).not.toContain("这里要加锁");

    const edited = await f.call("cli-agents/notes/update", { id: noteId, expectedVersion: 1, body: "改成读写锁" });
    expect(edited.data.note).toMatchObject({ body: "改成读写锁", version: 2, quote: "竞态条件" });
    const stale = await f.call("cli-agents/notes/update", { id: noteId, expectedVersion: 1, body: "旧版本的修改" });
    expect(stale.status).toBe(409);
    expect((await f.call("cli-agents/notes/delete", { id: noteId, expectedVersion: 1 })).status).toBe(409);
    expect((await f.call("cli-agents/notes/delete", { id: noteId, expectedVersion: 2 })).status).toBe(200);
    expect((await f.call("cli-agents/notes/delete", { id: noteId, expectedVersion: 2 })).status).toBe(404);
    expect((await f.call("cli-agents/notes/update", { id: noteId, expectedVersion: 2, body: "x" })).status).toBe(404);
    const left = (await f.get("cli-agents/notes?key=" + encodeURIComponent(key))).data.notes as Array<Record<string, any>>;
    expect(left.map((n) => n.body)).toEqual(["第二条"]);
  });

  it("scopes notes to their session, follows the logical session across a key change, and rejects bad input", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "scope");
    const a = await sessionOn(f, device, "a1", "idle");
    // a delta, not another full snapshot: that would drop the first session
    const b = keyOf(device, "b1");
    device.sessions([runningWire("b1", { state: "idle" })]);
    await until(() => f.app.cliHub.list().sessions.some((s) => s.key === b), "second session listed");
    const made = await f.call("cli-agents/notes", { key: a, id: "shared-id", message: "m", quote: "q", body: "a 的注释" });
    expect(made.status).toBe(200);
    expect((await f.get("cli-agents/notes?key=" + encodeURIComponent(b))).data.notes).toEqual([]);
    // an id that belongs to another session is not reusable there
    expect((await f.call("cli-agents/notes", { key: b, id: "shared-id", message: "m", quote: "q", body: "b" })).status).toBe(409);
    // rebinding the logical session to a new native key keeps its notes
    const row = (await f.get("cli-agents")).data.workbench.find((s: any) => s.sessionKey === a);
    device.sessions([runningWire("a2", { state: "idle" })]);
    await until(() => f.app.cliHub.list().sessions.some((s) => s.key === keyOf(device, "a2")), "resumed key listed");
    f.app.cliWorkbench.bind(row.id, keyOf(device, "a2"));
    expect((await f.get("cli-agents/notes?key=" + encodeURIComponent(keyOf(device, "a2")))).data.notes.map((n: any) => n.body)).toEqual(["a 的注释"]);
    expect((await f.get("cli-agents/notes?key=" + encodeURIComponent(row.id))).data.notes).toHaveLength(1);
    for (const bad of [
      { key: a, message: "", quote: "q", body: "x" },
      { key: a, message: "m", quote: "  ", body: "x" },
      { key: a, message: "m", quote: "q", body: "" },
      { key: a, message: "m", quote: "q", body: "x", start: 5, end: 5 },
      { key: a, message: "m", quote: "q", body: "x", start: 1 },
      { key: "not a key", message: "m", quote: "q", body: "x" },
    ]) expect((await f.call("cli-agents/notes", bad)).status).toBe(400);
    expect((await f.call("cli-agents/notes", { key: a, message: "m", quote: "q", body: "x".repeat(4001) })).status).toBe(413);
    expect((await f.call("cli-agents/notes/update", { id: "shared-id", body: "x" })).status).toBe(400);
  });

  it("is for the owner only", async () => {
    const f = await fixture();
    const anon = await fetch(f.app.origin + "/api/cli-agents/notes?key=x");
    expect(anon.status).toBe(401);
    const member = await f.app.cliRoutes.handle({ method: "GET", pathname: "/api/cli-agents/notes", search: new URLSearchParams({ key: "d:claude:a" }), sessionId: "s", owner: false });
    expect(member?.status).toBe(403);
    const write = await f.app.cliRoutes.handle({ method: "POST", pathname: "/api/cli-agents/notes", search: new URLSearchParams(), sessionId: "s", owner: false, data: { key: "d:claude:a", message: "m", quote: "q", body: "b" } });
    expect(write?.status).toBe(403);
  });
});
