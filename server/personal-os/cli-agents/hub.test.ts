// Agent mode hub: capability gating, session list, item cache, operations,
// terminal stream routing. Everything runs against a disposable Core in a temp
// directory and simulated devices; nothing touches a real account or device.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp, type AppOptions } from "../index.ts";
import { CoreStore } from "../store.ts";
import { CliAgentHub, type CliLink, type StreamSink } from "./hub.ts";
import { TERM_INPUT, TERM_OUTPUT, decodeTermFrame, encodeTermFrame } from "../../../shared/cli-agent-frames.ts";
import { CORE_ITEM_CACHE, type CoreCliMessage } from "../../../shared/cli-agents.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const OWNER = "synthetic-cli-owner";
const CAP = { version: 1, engines: ["claude", "codex"], terminal: { name: "herdr-core", version: "0.1.21", ready: true } };

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
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-cli-hub-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-cli-hub-")) throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function fixture(tuning: NonNullable<AppOptions["cliAgents"]> = { graceMs: 0 }) {
  const root = tempDir();
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: OWNER, identity: false, memoryRuntime: false, hostDevice: false, cliAgents: tuning });
  cleanups.push(() => app.close());
  const call = async (route: string, data?: unknown, token = OWNER) => {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  return { app, root, call };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const wire = (nativeId: string, extra: Record<string, unknown> = {}) => ({
  engine: "claude", nativeId, configDir: "C:/cfg", cwd: "C:/proj", title: "title " + nativeId, state: "idle", lastActivityAt: 1000, ...extra,
});
const item = (n: number, text = "hello " + n) => ({ kind: "assistant" as const, id: "i" + String(n).padStart(4, "0"), ts: 1000 + n, text });

interface Device {
  id: string;
  token: string;
  ws: WebSocket;
  msgs: Array<Record<string, any>>;
  bins: Uint8Array[];
  seq: number;
  closed: Promise<{ code: number }>;
  /** Answers cli.op messages; undefined means stay silent. Default: ok with an empty result. */
  onOp: (message: Record<string, any>) => Record<string, any> | undefined;
  send(message: unknown): void;
  sessions(upserts: unknown[], extra?: { full?: boolean; removes?: string[]; seq?: number }): void;
  ops(op?: string): Array<Record<string, any>>;
  kill(): void;
}

const defaultOp = (message: Record<string, any>) => {
  if (message.op === "read") return { ok: true, result: { items: [], more: false } };
  if (message.op === "send") return { ok: true, result: { turn: 1, started: false } };
  return { ok: true, result: {} };
};

/** Pairs a device and connects it the way the client executor does. `cap: null` leaves cliAgents out of the hello. */
async function connectDevice(f: Fixture, name: string, options: { cap?: unknown; pair?: { deviceId: string; token: string }; call?: Fixture["call"] } = {}): Promise<Device> {
  const call = options.call ?? f.call;
  const pair = options.pair ?? (await call("devices", { name })).data as { deviceId: string; token: string };
  const origin = f.app.origin.replace("http:", "ws:");
  return await dial(origin, pair, options.cap === undefined ? CAP : options.cap, name);
}

async function dial(origin: string, pair: { deviceId: string; token: string }, cap: unknown, name: string): Promise<Device> {
  const ws = new WebSocket(origin + "/dcp/v1/connect", { headers: { Authorization: "Bearer " + pair.token } });
  cleanups.push(() => { ws.terminate(); });
  const device: Device = {
    id: String(pair.deviceId), token: pair.token, ws, msgs: [], bins: [], seq: 0,
    closed: new Promise((resolve) => ws.on("close", (code) => resolve({ code }))),
    onOp: defaultOp,
    send: (message) => ws.send(JSON.stringify(message)),
    sessions(upserts, extra = {}) {
      device.send({ type: "cli.sessions", full: extra.full ?? false, upserts, removes: extra.removes ?? [], seq: extra.seq ?? ++device.seq });
    },
    ops: (op) => device.msgs.filter((m) => m.type === "cli.op" && (!op || m.op === op)),
    kill: () => ws.terminate(),
  };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) { device.bins.push(new Uint8Array(raw as Buffer)); return; }
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
    identity: { hostname: name, supported: ["device.info"] }, ...(cap === null ? {} : { cliAgents: cap }),
  })));
  await Promise.race([until(() => device.msgs.find((m) => m.type === "bound"), "bound"), failed]);
  return device;
}

const keyOf = (device: Device, nativeId: string, engine = "claude") => `${device.id}:${engine}:${nativeId}`;

/** A browser stream as the hub sees it, with a controllable socket. */
function makeSink(sessionId = "sink-session") {
  const log: Array<Record<string, any>> = [];
  const frames: Uint8Array[] = [];
  const dones: Array<() => void> = [];
  let autoDone = true;
  const sink: StreamSink = {
    sessionId,
    opened: (req, sid, cols, rows, observe) => log.push({ type: "opened", req, sid, cols, rows, observe }),
    size: (sid, cols, rows) => log.push({ type: "size", sid, cols, rows }),
    closed: (sid, reason) => log.push({ type: "closed", sid, reason }),
    error: (code, req, message) => log.push({ type: "error", code, req, message }),
    data: (frame, done) => { frames.push(frame); if (autoDone) done(); else dones.push(done); },
  };
  return { sink, log, frames, dones, hold: () => { autoDone = false; } };
}

/** A device that takes the terminal open and answers it. */
async function openTerminal(f: Fixture, device: Device, sink: ReturnType<typeof makeSink>, nativeId: string, observe: boolean) {
  f.app.cliHub.openStream(sink.sink, keyOf(device, nativeId), "r1", 80, 24, observe);
  const open = await until(() => device.msgs.find((m) => m.type === "cli.term.open"), "cli.term.open");
  device.send({ type: "cli.term.opened", sid: open.sid, cols: 80, rows: 24, observe });
  await until(() => sink.log.find((e) => e.type === "opened"), "opened");
  return { deviceSid: open.sid as number, browserSid: sink.log.find((e) => e.type === "opened")!.sid as number };
}

describe("capability gating", () => {
  it("serves only devices that declared cliAgents and closes undeclared cli traffic with 1008", async () => {
    const f = await fixture();
    const capable = await connectDevice(f, "capable");
    const plain = await connectDevice(f, "plain", { cap: null });
    const invalid = await connectDevice(f, "invalid-cap", { cap: { version: 2, engines: ["claude"] } });
    expect(f.app.store.get("SELECT capabilities_json FROM devices WHERE id=?", capable.id)?.capabilities_json).toContain("cli.agents");
    expect(f.app.store.get("SELECT capabilities_json FROM devices WHERE id=?", plain.id)?.capabilities_json).not.toContain("cli.agents");
    expect(f.app.store.get("SELECT capabilities_json FROM devices WHERE id=?", invalid.id)?.capabilities_json).not.toContain("cli.agents");

    capable.sessions([wire("s1")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "session listed");
    const listed = (await f.call("cli-agents")).data;
    expect(listed.devices.map((d: any) => d.id)).toEqual([capable.id]);
    expect(listed.devices[0]).toMatchObject({ online: true, cliAgents: { version: 1 } });

    plain.sessions([wire("p1")], { full: true });
    expect((await plain.closed).code).toBe(1008);
    invalid.ws.send(encodeTermFrame(TERM_OUTPUT, 1, new Uint8Array([1])));
    expect((await invalid.closed).code).toBe(1008);
    expect(f.app.cliHub.list().sessions.map((s) => s.nativeId)).toEqual(["s1"]);
  });

  it("refuses ops to a device that is offline and to non-owner callers", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "gone");
    device.kill();
    await device.closed;
    await until(() => !f.app.cliHub.list().devices.some((d) => d.online), "device offline");
    const result = await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj" });
    expect(result.status).toBe(409);
    expect(result.data.code).toBe("device_offline");
    const invalid = await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "relative/dir" });
    expect(invalid.status).toBe(400);
    expect(invalid.data.code).toBe("invalid");
  });
});

describe("session list", () => {
  it("applies full snapshots and deltas, and only emits real changes", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "list");
    const deltas: Array<{ upserts: any[]; removes: string[] }> = [];
    f.app.cliHub.onList((delta) => deltas.push(delta));

    device.sessions([wire("a"), wire("b")], { full: true });
    await until(() => deltas.length === 1, "first snapshot");
    expect(deltas[0].upserts.map((s) => s.nativeId).sort()).toEqual(["a", "b"]);
    expect(f.app.cliHub.list().sessions.every((s) => s.online && !s.hidden)).toBe(true);

    device.sessions([wire("a", { state: "running" })]);
    await until(() => deltas.length === 2, "delta");
    expect(deltas[1].upserts.map((s) => [s.nativeId, s.state])).toEqual([["a", "running"]]);

    // An identical row is not a change and must not wake the clients.
    device.sessions([wire("a", { state: "running" })]);
    device.sessions([], { removes: ["claude:b"] });
    await until(() => deltas.length === 3, "remove");
    expect(deltas[2]).toMatchObject({ upserts: [], removes: [keyOf(device, "b")] });

    // A stale seq is ignored, a full snapshot resets and drops what it omits.
    device.sessions([wire("zzz")], { seq: 1 });
    device.sessions([wire("c")], { full: true, seq: 1 });
    await until(() => deltas.length === 4, "full replace");
    expect(deltas[3].removes).toEqual([keyOf(device, "a")]);
    expect(deltas[3].upserts.map((s) => s.nativeId)).toEqual(["c"]);
    expect(f.app.cliHub.list().sessions.map((s) => s.nativeId)).toEqual(["c"]);
  });

  it("keeps the hidden flag across snapshots and marks sessions offline with the device", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "hide");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a");
    expect((await f.call("cli-agents/hide", { key, hidden: true })).status).toBe(200);
    device.sessions([wire("a", { title: "renamed" })], { full: true });
    await until(() => f.app.cliHub.session(key)?.title === "renamed", "renamed");
    expect(f.app.cliHub.session(key)?.hidden).toBe(true);
    expect((await f.call("cli-agents/hide", { key: device.id + ":claude:nope", hidden: true })).status).toBe(404);

    device.kill();
    await until(() => f.app.cliHub.session(key)?.online === false, "offline flag");
    expect(f.app.cliHub.list().devices[0]).toMatchObject({ id: device.id, online: false });
  });

  it("re-asks a reconnecting device for its state with cli.resync", async () => {
    const f = await fixture();
    const first = await connectDevice(f, "resync");
    await until(() => first.msgs.find((m) => m.type === "cli.resync"), "first resync");
    first.kill();
    await first.closed;
    const second = await connectDevice(f, "resync", { pair: { deviceId: first.id, token: first.token } });
    await until(() => second.msgs.find((m) => m.type === "cli.resync"), "second resync");
  });
});

describe("transcript cache", () => {
  it("keeps the newest items only and stores them encrypted", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "items");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const total = CORE_ITEM_CACHE + 50;
    for (let start = 0; start < total; start += 100) {
      device.send({ type: "cli.items", ref: "claude:a", items: Array.from({ length: Math.min(100, total - start) }, (_, i) => item(start + i, "secret-body-" + (start + i))) });
    }
    const key = keyOf(device, "a");
    await until(() => Number(f.app.store.get("SELECT COUNT(*) n FROM cli_agent_items WHERE session_key=?", key)?.n) === CORE_ITEM_CACHE && f.app.store.get("SELECT item_id FROM cli_agent_items WHERE session_key=? AND item_id=?", key, item(total - 1).id), "cap");
    expect(f.app.store.get("SELECT MIN(item_id) m FROM cli_agent_items WHERE session_key=?", key)?.m).toBe(item(total - CORE_ITEM_CACHE).id);
    const bodies = f.app.store.all("SELECT body FROM cli_agent_items WHERE session_key=?", key).map((row) => String(row.body));
    expect(bodies.some((body) => body.includes("secret-body"))).toBe(false);
    expect(bodies.some((body) => body.includes("assistant"))).toBe(false);

    // reset replaces everything; items for an unknown session are dropped
    device.send({ type: "cli.items", ref: "claude:a", reset: true, items: [item(1, "fresh")] });
    device.send({ type: "cli.items", ref: "claude:ghost", items: [item(2)] });
    await until(() => Number(f.app.store.get("SELECT COUNT(*) n FROM cli_agent_items WHERE session_key=?", key)?.n) === 1, "reset");
    expect(Number(f.app.store.get("SELECT COUNT(*) n FROM cli_agent_items")?.n)).toBe(1);
  });

  it("answers a history read from the device online and from the cache offline", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "history");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a");
    device.onOp = (message) => message.op === "read" ? { ok: true, result: { items: [item(1, "one"), item(2, "two")], more: true } } : defaultOp(message);
    const online = await f.call(`cli-agents/items?key=${encodeURIComponent(key)}`);
    expect(online.status).toBe(200);
    expect(online.data).toMatchObject({ more: true, items: [{ text: "one" }, { text: "two" }] });

    device.kill();
    await device.closed;
    await until(() => !f.app.cliHub.session(key)?.online, "offline");
    const cached = await f.call(`cli-agents/items?key=${encodeURIComponent(key)}`);
    expect(cached.data).toMatchObject({ more: false, items: [{ text: "one" }, { text: "two" }] });
  });
});

describe("operations", () => {
  it("returns the device result and maps a device error to its code", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "ops");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a");

    device.onOp = (message) => message.op === "send" ? { ok: true, result: { turn: 1, started: true } } : defaultOp(message);
    const ok = await f.call("cli-agents/send", { key, text: "private prompt text" });
    expect(ok).toMatchObject({ status: 200, data: { turn: 1, started: true } });
    const op = device.ops("send")[0];
    expect(op).toMatchObject({ args: { ref: "claude:a", text: "private prompt text" } });
    expect(op.deadlineMs).toBeGreaterThan(0);

    // The record keeps the length, never the text.
    const rows = f.app.store.all("SELECT args_json,status FROM cli_agent_ops");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("succeeded");
    expect(String(rows[0].args_json)).not.toContain("private prompt text");
    expect(JSON.parse(String(rows[0].args_json))).toEqual({ ref: "claude:a", length: 19 });
    expect(JSON.stringify(f.app.store.all("SELECT details_json FROM audit_records"))).not.toContain("private prompt text");

    device.onOp = (message) => message.op === "send" ? { ok: false, error: { code: "open_elsewhere" } } : defaultOp(message);
    const refused = await f.call("cli-agents/send", { key, text: "again" });
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe("open_elsewhere");
    expect(f.app.store.all("SELECT status,error_code FROM cli_agent_ops ORDER BY created_at,rowid").map((r) => [r.status, r.error_code])).toEqual([["succeeded", null], ["failed", "open_elsewhere"]]);

    expect((await f.call("cli-agents/send", { key, text: "x".repeat(32 * 1024 + 1) })).status).toBe(413);
    expect((await f.call("cli-agents/send", { key, text: "你".repeat(11000) })).status).toBe(413);
    expect((await f.call("cli-agents/send", { key: "bad key", text: "x" })).status).toBe(400);
  });

  it("starts a session and reports interrupt and open-local results", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "start");
    device.onOp = (message) => {
      if (message.op === "start") return { ok: true, result: { ref: "codex:new1", terminal: "term-1" } };
      if (message.op === "interrupt") return { ok: true, result: { outcome: "interrupted" } };
      return defaultOp(message);
    };
    const started = await f.call("cli-agents/start", { deviceId: device.id, engine: "codex", cwd: "C:/work" });
    expect(started).toMatchObject({ status: 200, data: { key: keyOf(device, "new1", "codex") } });
    const interrupted = await f.call("cli-agents/interrupt", { key: keyOf(device, "new1", "codex") });
    expect(interrupted).toMatchObject({ status: 200, data: { outcome: "interrupted" } });
    expect(f.app.store.all("SELECT op FROM cli_agent_ops ORDER BY rowid").map((r) => r.op)).toEqual(["start", "interrupt"]);
  });

  it("ends a mutating op that times out as unknown, and a read as a cached page", async () => {
    const f = await fixture({ graceMs: 0, opTimeoutMs: 150 });
    const device = await connectDevice(f, "slow");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a");
    device.onOp = (message) => message.op === "send" || message.op === "read" ? undefined : defaultOp(message);
    const sent = await f.call("cli-agents/send", { key, text: "hello" });
    expect(sent.status).toBe(409);
    expect(sent.data.code).toBe("unknown");
    expect(f.app.store.get("SELECT status,error_code FROM cli_agent_ops")).toMatchObject({ status: "unknown", error_code: "unknown" });
    // The session is free again for a deliberate retry.
    device.onOp = defaultOp;
    expect((await f.call("cli-agents/send", { key, text: "retry" })).status).toBe(200);
    expect(device.ops("send")).toHaveLength(2);

    device.onOp = (message) => message.op === "read" ? undefined : defaultOp(message);
    const read = await f.call(`cli-agents/items?key=${encodeURIComponent(key)}`);
    expect(read).toMatchObject({ status: 200, data: { items: [], more: false } });
  });

  it("rejects a second mutating op on a busy session", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "busy");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a");
    device.onOp = (message) => message.op === "send" ? undefined : defaultOp(message);
    const first = f.call("cli-agents/send", { key, text: "one" });
    await until(() => device.ops("send").length === 1, "first send at device");
    const second = await f.call("cli-agents/send", { key, text: "two" });
    expect(second).toMatchObject({ status: 409, data: { code: "busy" } });
    const op = device.ops("send")[0];
    device.send({ type: "cli.reply", opId: op.opId, ok: true, result: { turn: 2, started: false } });
    expect((await first).status).toBe(200);
  });

  it("never resends a mutating op after the device reconnects, and settles it from a late answer", async () => {
    const f = await fixture({ graceMs: 0, opTimeoutMs: 5000 });
    const device = await connectDevice(f, "flaky");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a");
    device.onOp = (message) => message.op === "send" ? undefined : defaultOp(message);
    const pending = f.call("cli-agents/send", { key, text: "do it once" });
    const op = await until(() => device.ops("send")[0], "send at device");
    device.kill();
    const result = await pending;
    expect(result).toMatchObject({ status: 409, data: { code: "unknown" } });
    expect(f.app.store.get("SELECT status FROM cli_agent_ops WHERE id=?", op.opId)?.status).toBe("unknown");

    const again = await connectDevice(f, "flaky", { pair: { deviceId: device.id, token: device.token } });
    again.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.session(key)?.online, "back online");
    await wait(150);
    expect(again.ops("send")).toHaveLength(0);
    expect(f.app.store.get("SELECT COUNT(*) n FROM cli_agent_ops")?.n).toBe(1);

    // The device did act: its late answer settles the record, and nothing else happens.
    again.send({ type: "cli.reply", opId: op.opId, ok: true, result: { turn: 1, started: true } });
    await until(() => f.app.store.get("SELECT status FROM cli_agent_ops WHERE id=?", op.opId)?.status === "succeeded", "late reply settled");
    expect(again.ops("send")).toHaveLength(0);
  });

  it("fails a read as device_offline when the link drops, without recording it", async () => {
    const f = await fixture({ graceMs: 0, opTimeoutMs: 5000 });
    const device = await connectDevice(f, "drop");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    device.onOp = (message) => message.op === "read" ? undefined : defaultOp(message);
    const read = f.app.cliHub.op("t", device.id, keyOf(device, "a"), "read", { ref: "claude:a" });
    await until(() => device.ops("read").length === 1, "read at device");
    device.kill();
    await expect(read).rejects.toMatchObject({ code: "device_offline" });
    expect(f.app.store.get("SELECT COUNT(*) n FROM cli_agent_ops")?.n).toBe(0);
  });

  it("sends watch for the first subscriber, unwatch for the last, and watch again after a reconnect", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "watch");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a");
    const seen: any[] = [];
    const off1 = f.app.cliHub.subscribe(key, (m) => seen.push(m));
    const off2 = f.app.cliHub.subscribe(key, () => undefined);
    await until(() => device.ops("watch").length === 1, "watch");
    device.send({ type: "cli.items", ref: "claude:a", items: [item(1)] });
    await until(() => seen.length === 1, "live item");
    expect(seen[0]).toMatchObject({ type: "items", key, items: [{ id: item(1).id }] });
    off1();
    await wait(50);
    expect(device.ops("unwatch")).toHaveLength(0);

    device.kill();
    await device.closed;
    const again = await connectDevice(f, "watch", { pair: { deviceId: device.id, token: device.token } });
    await until(() => again.ops("watch").length === 1, "watch after reconnect");
    off2();
    await until(() => again.ops("unwatch").length === 1, "unwatch");
  });
});

describe("terminal streams", () => {
  it("closes streams with device_offline when the device goes away, and refuses to open on an offline one", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "term");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const sink = makeSink();
    const { browserSid } = await openTerminal(f, device, sink, "a", false);
    expect(f.app.cliHub.streamCount()).toBe(1);
    expect(f.app.store.get("SELECT COUNT(*) n FROM audit_records WHERE action='cli.term.control'")?.n).toBe(1);
    device.kill();
    await until(() => sink.log.find((e) => e.type === "closed"), "closed");
    expect(sink.log.find((e) => e.type === "closed")).toMatchObject({ sid: browserSid, reason: "device_offline" });
    expect(f.app.cliHub.streamCount()).toBe(0);

    f.app.cliHub.openStream(sink.sink, keyOf(device, "a"), "r2", 80, 24, false);
    expect(sink.log.at(-1)).toMatchObject({ type: "error", code: "device_offline", req: "r2" });
  });

  it("re-addresses output and input frames with the right sid, and forwards credit within what was delivered", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "frames");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const sink = makeSink();
    const { deviceSid, browserSid } = await openTerminal(f, device, sink, "a", false);

    device.ws.send(encodeTermFrame(TERM_OUTPUT, deviceSid, new Uint8Array(10_000).fill(65)));
    await until(() => sink.frames.length === 1, "output frame");
    expect(decodeTermFrame(sink.frames[0])).toMatchObject({ type: TERM_OUTPUT, sid: browserSid });
    expect(decodeTermFrame(sink.frames[0])!.payload.length).toBe(10_000);

    f.app.cliHub.streamInput(sink.sink, browserSid, new Uint8Array([104, 105]));
    const input = await until(() => device.bins.find((b) => b[0] === TERM_INPUT), "input frame");
    expect(decodeTermFrame(input)).toMatchObject({ type: TERM_INPUT, sid: deviceSid });
    expect(Array.from(decodeTermFrame(input)!.payload)).toEqual([104, 105]);

    f.app.cliHub.streamResize(sink.sink, browserSid, 100, 30);
    await until(() => device.msgs.find((m) => m.type === "cli.term.resize"), "resize");

    // Credit beyond what was delivered is clamped; nothing is credited twice.
    f.app.cliHub.streamCredit(sink.sink, browserSid, 4096);
    f.app.cliHub.streamCredit(sink.sink, browserSid, 1_000_000);
    f.app.cliHub.streamCredit(sink.sink, browserSid, 1_000_000);
    await until(() => device.msgs.filter((m) => m.type === "cli.term.credit").length === 2, "credits");
    await wait(50);
    const credits = device.msgs.filter((m) => m.type === "cli.term.credit");
    expect(credits.map((c) => c.bytes)).toEqual([4096, 10_000 - 4096]);
    expect(credits.every((c) => c.sid === deviceSid)).toBe(true);

    // Another browser cannot drive this stream.
    const other = makeSink("other");
    f.app.cliHub.streamInput(other.sink, browserSid, new Uint8Array([1]));
    await wait(30);
    expect(device.bins.filter((b) => b[0] === TERM_INPUT)).toHaveLength(1);

    f.app.cliHub.streamClose(sink.sink, browserSid);
    await until(() => device.msgs.find((m) => m.type === "cli.term.close"), "close at device");
    expect(sink.log.some((e) => e.type === "closed")).toBe(false);
  });

  it("passes the device's close reason through and closes open streams as closed on shutdown", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "reasons");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const first = makeSink();
    const a = await openTerminal(f, device, first, "a", false);
    device.send({ type: "cli.term.closed", sid: a.deviceSid, reason: "exited", exitCode: 0 });
    await until(() => first.log.find((e) => e.type === "closed"), "closed");
    expect(first.log.find((e) => e.type === "closed")).toMatchObject({ sid: a.browserSid, reason: "exited" });
    expect(f.app.cliHub.streamCount()).toBe(0);

    const second = makeSink();
    f.app.cliHub.openStream(second.sink, keyOf(device, "a"), "r2", 80, 24, true);
    await until(() => device.msgs.filter((m) => m.type === "cli.term.open").length === 2, "second open");
    f.app.cliHub.close();
    expect(second.log.at(-1)).toMatchObject({ type: "closed", reason: "closed" });
  });

  it("keeps observe streams read-only", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "observe");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const sink = makeSink();
    const { browserSid } = await openTerminal(f, device, sink, "a", true);
    expect(f.app.store.get("SELECT COUNT(*) n FROM audit_records WHERE action='cli.term.control'")?.n).toBe(0);
    f.app.cliHub.streamInput(sink.sink, browserSid, new Uint8Array([1]));
    f.app.cliHub.streamResize(sink.sink, browserSid, 10, 10);
    expect(sink.log.at(-1)).toMatchObject({ type: "error", code: "read_only" });
    await wait(30);
    expect(device.bins.filter((b) => b[0] === TERM_INPUT)).toHaveLength(0);
    expect(device.msgs.some((m) => m.type === "cli.term.resize")).toBe(false);
  });

  it("drops a stream whose browser does not drain, and tells the device", async () => {
    const f = await fixture({ graceMs: 0, streamBufferMax: 50_000 });
    const device = await connectDevice(f, "overflow");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const sink = makeSink();
    sink.hold();
    const { deviceSid, browserSid } = await openTerminal(f, device, sink, "a", false);
    for (let i = 0; i < 3; i++) device.ws.send(encodeTermFrame(TERM_OUTPUT, deviceSid, new Uint8Array(30_000)));
    await until(() => sink.log.find((e) => e.type === "closed"), "overflow close");
    expect(sink.log.find((e) => e.type === "closed")).toMatchObject({ sid: browserSid, reason: "overflow" });
    expect(sink.frames).toHaveLength(1);
    await until(() => device.msgs.find((m) => m.type === "cli.term.close" && m.sid === deviceSid), "close sent to device");
    expect(f.app.cliHub.streamCount()).toBe(0);
  });

  it("keeps draining streams under the cap and reports device terminal errors", async () => {
    const f = await fixture({ graceMs: 0, streamBufferMax: 50_000 });
    const device = await connectDevice(f, "drain");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const sink = makeSink();
    const { deviceSid } = await openTerminal(f, device, sink, "a", false);
    for (let i = 0; i < 10; i++) device.ws.send(encodeTermFrame(TERM_OUTPUT, deviceSid, new Uint8Array(30_000)));
    await until(() => sink.frames.length === 10, "all frames");
    expect(sink.log.some((e) => e.type === "closed")).toBe(false);

    const second = makeSink();
    f.app.cliHub.openStream(second.sink, keyOf(device, "a"), "r9", 80, 24, false);
    const open = await until(() => device.msgs.filter((m) => m.type === "cli.term.open")[1], "second open");
    device.send({ type: "cli.term.error", sid: open.sid, code: "not_found" });
    await until(() => second.log.find((e) => e.type === "error"), "open error");
    expect(second.log[0]).toMatchObject({ code: "not_found", req: "r9" });
    expect(f.app.cliHub.streamCount()).toBe(1);
  });

  it("gives up on a terminal open the device never answers", async () => {
    const f = await fixture({ graceMs: 0, streamOpenMs: 100 });
    const device = await connectDevice(f, "mute");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const sink = makeSink();
    f.app.cliHub.openStream(sink.sink, keyOf(device, "a"), "r1", 80, 24, false);
    await until(() => sink.log.find((e) => e.type === "error"), "open timeout");
    expect(sink.log[0]).toMatchObject({ code: "unknown", req: "r1" });
    await until(() => device.msgs.find((m) => m.type === "cli.term.close"), "close at device");
    expect(f.app.cliHub.streamCount()).toBe(0);
  });

  it("limits the streams one browser can hold", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "many");
    const sink = makeSink();
    for (let i = 0; i < 8; i++) f.app.cliHub.openStream(sink.sink, keyOf(device, "a"), "r" + i, 80, 24, true);
    expect(sink.log).toHaveLength(0);
    f.app.cliHub.openStream(sink.sink, keyOf(device, "a"), "r8", 80, 24, true);
    expect(sink.log.at(-1)).toMatchObject({ type: "error", code: "busy", req: "r8" });
    f.app.cliHub.closeSink(sink.sink);
    expect(f.app.cliHub.streamCount()).toBe(0);
  });
});

describe("summary", () => {
  /** A hub on its own store with a link that goes nowhere: only the counting is under test. */
  function standalone() {
    const root = tempDir();
    const store = new CoreStore(root, randomBytes(32), OWNER);
    cleanups.push(() => store.close());
    const sent: CoreCliMessage[] = [];
    const link: CliLink = { sendCli: (_id, message) => { sent.push(message); }, sendCliBinary: () => undefined };
    let changes = 0;
    const hub = new CliAgentHub(store, link, () => { changes++; });
    cleanups.push(() => hub.close());
    return { hub, changes: () => changes, sent };
  }

  it("wakes clients only when the waiting or running count moves", () => {
    const { hub, changes } = standalone();
    const cap = { version: 1 as const, engines: ["claude" as const], terminal: null };
    hub.deviceOnline("dev1", cap as any);
    const base = changes();
    const send = (seq: number, upserts: unknown[], full = false) => hub.fromDevice("dev1", { type: "cli.sessions", full, upserts, removes: [], seq });

    send(1, [wire("a", { state: "running" }), wire("b")], true);
    expect(hub.summary()).toEqual({ waiting: 0, running: 1 });
    expect(changes()).toBe(base + 1);

    // A busy session rewriting its title or activity time is not a count change.
    send(2, [wire("a", { state: "running", title: "other", lastActivityAt: 5000 })]);
    send(3, [wire("b", { title: "idle but retitled" })]);
    expect(changes()).toBe(base + 1);

    send(4, [wire("a", { state: "waiting", waitingFor: "approval" })]);
    expect(hub.summary()).toEqual({ waiting: 1, running: 0 });
    expect(changes()).toBe(base + 2);

    // Hidden sessions drop out of the counts.
    expect(hub.hide("dev1:claude:a", true)).toBe(true);
    expect(hub.summary()).toEqual({ waiting: 0, running: 0 });
    expect(changes()).toBe(base + 3);

    // idle -> idle-like state changes that keep the counts do not fire either.
    send(5, [wire("b", { state: "idle", title: "again" })]);
    expect(changes()).toBe(base + 3);

    hub.hide("dev1:claude:a", false);
    expect(changes()).toBe(base + 4);
    hub.deviceOffline("dev1");
    expect(hub.summary()).toEqual({ waiting: 0, running: 0 });
    expect(changes()).toBe(base + 5);
  });

  it("counts invalid device payloads without failing", () => {
    const { hub } = standalone();
    hub.deviceOnline("dev1", { version: 1, engines: ["claude"], terminal: null } as any);
    hub.fromDevice("dev1", { type: "cli.sessions", full: "yes" });
    hub.fromDevice("dev1", { type: "cli.unknown" });
    hub.fromDevice("other-device", { type: "cli.sessions", full: true, upserts: [], removes: [], seq: 1 });
    expect(hub.invalidMessages).toBe(2);
    expect(hub.list().sessions).toEqual([]);
  });
});
