// Agent mode browser WebSocket: authentication, Origin and Host checks,
// routing of list, transcript and terminal traffic, liveness, and routing
// between accounts. Disposable Core in a temp directory, simulated devices and
// simulated browsers; no real account, device or terminal is involved.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp, type AppOptions } from "../index.ts";
import { createWorkspaceService } from "../workspaces.ts";
import { startFakeIdentity } from "../testing/fake-identity.ts";
import { TERM_INPUT, TERM_OUTPUT, decodeTermFrame, encodeTermFrame } from "../../../shared/cli-agent-frames.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const OWNER = "synthetic-cli-stream-owner";
const CAP = { version: 1, engines: ["claude", "codex"], terminal: { name: "herdr-core", version: "0.1.21", ready: true } };
const TUNING = { graceMs: 0 };

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

function tempDir(prefix: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith(prefix)) throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function fixture(tuning: NonNullable<AppOptions["cliAgents"]> = TUNING) {
  const root = tempDir("nex-cli-stream-");
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: OWNER, identity: false, memoryRuntime: false, hostDevice: false, cliAgents: tuning });
  cleanups.push(() => app.close());
  const call = async (route: string, data?: unknown, token = OWNER) => {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  const login = async (name: string) => {
    const invite = (await call("clients/invite", { name })).data;
    const response = await fetch(app.origin + "/api/client/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: invite.code, name }) });
    return await response.json() as { token: string; sessionId: string };
  };
  return { app, call, login, origin: app.origin };
}

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
  onOp: (message: Record<string, any>) => Record<string, any> | undefined;
  send(message: unknown): void;
  sessions(upserts: unknown[], extra?: { full?: boolean; removes?: string[] }): void;
  ops(op?: string): Array<Record<string, any>>;
  kill(): void;
}
let seq = 0;
const defaultOp = (message: Record<string, any>) => {
  if (message.op === "read") return { ok: true, result: { items: [], more: false } };
  return { ok: true, result: {} };
};

async function connectDevice(origin: string, call: (route: string, data?: unknown, token?: string) => Promise<{ data: Record<string, any> }>, token: string | undefined, name: string): Promise<Device> {
  const pair = (await call("devices", { name }, token)).data as { deviceId: string; token: string };
  const ws = new WebSocket(origin.replace("http:", "ws:") + "/dcp/v1/connect", { headers: { Authorization: "Bearer " + pair.token } });
  cleanups.push(() => { ws.terminate(); });
  const device: Device = {
    id: String(pair.deviceId), token: pair.token, ws, msgs: [], bins: [], onOp: defaultOp,
    send: (message) => ws.send(JSON.stringify(message)),
    sessions: (upserts, extra = {}) => device.send({ type: "cli.sessions", full: extra.full ?? false, upserts, removes: extra.removes ?? [], seq: ++seq }),
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
    identity: { hostname: name, supported: ["device.info"] }, cliAgents: CAP,
  })));
  await Promise.race([until(() => device.msgs.find((m) => m.type === "bound"), "bound"), failed]);
  return device;
}

interface Browser {
  ws: WebSocket;
  msgs: Array<Record<string, any>>;
  bins: Uint8Array[];
  closed: Promise<{ code: number }>;
  send(message: unknown): void;
  sendBin(frame: Uint8Array): void;
  find(type: string, pred?: (m: Record<string, any>) => boolean): Promise<Record<string, any>>;
  count(type: string): number;
}

interface BrowserOptions { cookie?: string; bearer?: string; origin?: string | null; host?: string; autoPong?: boolean; query?: string }

function browserHeaders(origin: string, options: BrowserOptions) {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.Cookie = "nex=" + options.cookie;
  if (options.bearer !== undefined) headers.Authorization = "Bearer " + options.bearer;
  if (options.origin !== null) headers.Origin = options.origin ?? origin;
  if (options.host) headers.Host = options.host;
  return headers;
}

/** Resolves with the HTTP status the upgrade was refused with. */
function refused(origin: string, options: BrowserOptions): Promise<number> {
  const ws = new WebSocket(origin.replace("http:", "ws:") + "/api/cli-agents/stream" + (options.query ?? ""), { headers: browserHeaders(origin, options) });
  cleanups.push(() => { ws.terminate(); });
  return new Promise((resolve, reject) => {
    ws.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    ws.on("open", () => reject(new Error("upgrade was accepted")));
    ws.on("error", () => undefined);
  });
}

async function connectBrowser(origin: string, options: BrowserOptions): Promise<Browser> {
  const ws = new WebSocket(origin.replace("http:", "ws:") + "/api/cli-agents/stream" + (options.query ?? ""), {
    headers: browserHeaders(origin, options), ...(options.autoPong === false ? { autoPong: false } : {}),
  });
  cleanups.push(() => { ws.terminate(); });
  const browser: Browser = {
    ws, msgs: [], bins: [],
    closed: new Promise((resolve) => ws.on("close", (code) => resolve({ code }))),
    send: (message) => ws.send(JSON.stringify(message)),
    sendBin: (frame) => ws.send(frame, { binary: true }),
    find: (type, pred = () => true) => until(() => browser.msgs.find((m) => m.type === type && pred(m)), type),
    count: (type) => browser.msgs.filter((m) => m.type === type).length,
  };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) browser.bins.push(new Uint8Array(raw as Buffer)); else browser.msgs.push(JSON.parse(raw.toString()));
  });
  await new Promise<void>((resolve, reject) => { ws.on("open", () => resolve()); ws.on("error", reject); ws.on("unexpected-response", (_r, res) => reject(new Error("refused " + res.statusCode))); });
  return browser;
}

describe("authentication", () => {
  it("accepts the nex cookie with this Core's Origin and serves the list", async () => {
    const f = await fixture();
    const device = await connectDevice(f.origin, f.call, undefined, "mac");
    device.sessions([wire("a", { state: "running" })], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const browser = await connectBrowser(f.origin, { cookie: OWNER, query: "?v=1" });
    browser.send({ type: "ping" });
    await browser.find("pong");
    browser.send({ type: "sub.list" });
    const list = await browser.find("list");
    expect(list.sessions.map((s: any) => s.key)).toEqual([`${device.id}:claude:a`]);
    expect(list.devices[0]).toMatchObject({ id: device.id, online: true });
    expect(await browser.find("summary")).toMatchObject({ waiting: 0, running: 1 });
    expect(f.app.cliStream.size).toBe(1);
  });

  it("refuses a missing cookie, a bad token, a foreign Origin, a missing Origin and a foreign Host", async () => {
    const f = await fixture();
    expect(await refused(f.origin, {})).toBe(401);
    expect(await refused(f.origin, { cookie: "not-a-session" })).toBe(401);
    expect(await refused(f.origin, { cookie: "x".repeat(300) })).toBe(401);
    expect(await refused(f.origin, { cookie: OWNER, origin: "http://evil.example" })).toBe(403);
    expect(await refused(f.origin, { cookie: OWNER, origin: f.origin + ".evil.example" })).toBe(403);
    expect(await refused(f.origin, { cookie: OWNER, origin: null })).toBe(403);
    expect(await refused(f.origin, { cookie: OWNER, host: "evil.example" })).toBe(403);
    expect(f.app.cliStream.size).toBe(0);
    // The same cookie with the right Origin is fine, and so is a non-browser client with a Bearer token and no Origin.
    expect((await connectBrowser(f.origin, { cookie: OWNER })).ws.readyState).toBe(WebSocket.OPEN);
    expect((await connectBrowser(f.origin, { bearer: OWNER, origin: null })).ws.readyState).toBe(WebSocket.OPEN);
  });

  it("limits the sockets one login can hold", async () => {
    const f = await fixture();
    const open = [];
    for (let i = 0; i < 8; i++) open.push(await connectBrowser(f.origin, { cookie: OWNER }));
    expect(await refused(f.origin, { cookie: OWNER })).toBe(429);
    open[0].ws.close();
    await open[0].closed;
    await until(() => f.app.cliStream.size === 7, "socket released");
    expect((await connectBrowser(f.origin, { cookie: OWNER })).ws.readyState).toBe(WebSocket.OPEN);
  });

  it("ends the socket with 4401 when the login is logged out", async () => {
    const f = await fixture();
    const client = await f.login("合成 浏览器");
    const browser = await connectBrowser(f.origin, { cookie: client.token });
    browser.send({ type: "sub.list" });
    await browser.find("list");
    const kept = await connectBrowser(f.origin, { cookie: OWNER });
    const out = await fetch(f.origin + "/api/client/logout", { method: "POST", headers: { Authorization: "Bearer " + client.token, "Content-Type": "application/json" }, body: "{}" });
    expect(out.status).toBeLessThan(300);
    expect((await browser.closed).code).toBe(4401);
    expect(kept.ws.readyState).toBe(WebSocket.OPEN);
    expect(await refused(f.origin, { cookie: client.token })).toBe(401);
  });

  it("re-checks a live login even when no logout hook fired", async () => {
    const f = await fixture({ graceMs: 0, reauthMs: 60, pingMs: 30 });
    const client = await f.login("合成 浏览器");
    const browser = await connectBrowser(f.origin, { cookie: client.token });
    f.app.store.run("UPDATE user_sessions SET revoked_at=? WHERE id=?", Date.now(), client.sessionId);
    expect((await browser.closed).code).toBe(4401);
  });
});

describe("liveness", () => {
  it("terminates a socket that stops answering pings and keeps one that answers", async () => {
    const f = await fixture({ graceMs: 0, pingMs: 40, pongTimeoutMs: 160 });
    const silent = await connectBrowser(f.origin, { cookie: OWNER, autoPong: false });
    const alive = await connectBrowser(f.origin, { cookie: OWNER });
    const started = Date.now();
    await silent.closed;
    expect(Date.now() - started).toBeLessThan(1500);
    await wait(300);
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
    await until(() => f.app.cliStream.size === 1, "silent socket removed");
  });

  it("answers invalid messages with an error and keeps the socket", async () => {
    const f = await fixture();
    const browser = await connectBrowser(f.origin, { cookie: OWNER });
    browser.ws.send("not json");
    browser.send({ type: "sub.session", key: "bad key" });
    browser.send({ type: "nope" });
    await until(() => browser.count("error") === 3, "three errors");
    expect(browser.msgs.every((m) => m.type === "error" && m.code === "invalid")).toBe(true);
    browser.send({ type: "ping" });
    await browser.find("pong");
  });
});

describe("list and transcript", () => {
  it("pushes list deltas and summary changes, and stops after the socket closes", async () => {
    const f = await fixture();
    const device = await connectDevice(f.origin, f.call, undefined, "mac");
    const browser = await connectBrowser(f.origin, { cookie: OWNER });
    browser.send({ type: "sub.list" });
    await browser.find("list");

    device.sessions([wire("a", { state: "running" }), wire("b")], { full: true });
    const delta = await browser.find("list.delta", (m) => m.upserts.length === 2);
    expect(delta.upserts.map((s: any) => s.nativeId).sort()).toEqual(["a", "b"]);
    await browser.find("summary", (m) => m.running === 1);
    const before = browser.count("summary");

    // The title changes but the counts do not: a delta, no summary.
    device.sessions([wire("a", { state: "running", title: "renamed" })]);
    await browser.find("list.delta", (m) => m.upserts[0]?.title === "renamed");
    expect(browser.count("summary")).toBe(before);

    device.sessions([wire("a", { state: "waiting", waitingFor: "approval" })]);
    await browser.find("summary", (m) => m.waiting === 1 && m.running === 0);

    device.sessions([], { removes: ["claude:b"] });
    await browser.find("list.delta", (m) => m.removes.includes(`${device.id}:claude:b`));

    // A device going offline updates its row and its sessions.
    device.kill();
    await browser.find("list.delta", (m) => m.devices?.[0]?.online === false);
    await browser.find("summary", (m) => m.waiting === 0 && m.running === 0);

    browser.ws.close();
    await browser.closed;
    await until(() => f.app.cliStream.size === 0, "detached");
  });

  it("sends the first transcript page, then live items, and unwatches on unsub", async () => {
    const f = await fixture();
    const device = await connectDevice(f.origin, f.call, undefined, "mac");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = `${device.id}:claude:a`;
    device.onOp = (message) => message.op === "read" ? { ok: true, result: { items: [item(1), item(2)], more: true } } : defaultOp(message);
    const browser = await connectBrowser(f.origin, { cookie: OWNER });
    browser.send({ type: "sub.session", key });
    const page = await browser.find("items", (m) => m.reset === true);
    expect(page).toMatchObject({ key, more: true, items: [{ id: item(1).id }, { id: item(2).id }] });
    await until(() => device.ops("watch").length === 1, "watch");

    device.send({ type: "cli.items", ref: "claude:a", items: [item(3)] });
    const live = await browser.find("items", (m) => !m.reset);
    expect(live).toMatchObject({ key, items: [{ id: item(3).id }] });

    browser.send({ type: "unsub.session", key });
    await until(() => device.ops("unwatch").length === 1, "unwatch");
    device.send({ type: "cli.items", ref: "claude:a", items: [item(4)] });
    await wait(80);
    expect(browser.msgs.some((m) => m.type === "items" && m.items.some((i: any) => i.id === item(4).id))).toBe(false);
  });

  it("reports an error for a session whose device cannot answer the read", async () => {
    const f = await fixture();
    const device = await connectDevice(f.origin, f.call, undefined, "mac");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = `${device.id}:claude:a`;
    device.onOp = (message) => message.op === "read" ? { ok: false, error: { code: "not_found" } } : defaultOp(message);
    const browser = await connectBrowser(f.origin, { cookie: OWNER });
    browser.send({ type: "sub.session", key });
    expect(await browser.find("error")).toMatchObject({ code: "not_found", message: key });
  });
});

describe("terminal", () => {
  async function terminalFixture() {
    const f = await fixture();
    const device = await connectDevice(f.origin, f.call, undefined, "mac");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const browser = await connectBrowser(f.origin, { cookie: OWNER });
    return { f, device, browser, key: `${device.id}:claude:a` };
  }

  it("opens, relays output and input with swapped sids, forwards credit and closes", async () => {
    const { f, device, browser, key } = await terminalFixture();
    browser.send({ type: "term.open", req: "r1", key, cols: 80, rows: 24, observe: false });
    const open = await until(() => device.msgs.find((m) => m.type === "cli.term.open"), "cli.term.open");
    expect(open).toMatchObject({ ref: "claude:a", cols: 80, rows: 24, observe: false });
    device.send({ type: "cli.term.opened", sid: open.sid, cols: 80, rows: 24, observe: false });
    const opened = await browser.find("term.opened");
    expect(opened).toMatchObject({ req: "r1", cols: 80, rows: 24, observe: false });

    device.ws.send(encodeTermFrame(TERM_OUTPUT, open.sid, new TextEncoder().encode("hello terminal")));
    const out = await until(() => browser.bins[0], "output frame");
    expect(decodeTermFrame(out)).toMatchObject({ type: TERM_OUTPUT, sid: opened.sid });
    expect(new TextDecoder().decode(decodeTermFrame(out)!.payload)).toBe("hello terminal");

    browser.sendBin(encodeTermFrame(TERM_INPUT, opened.sid, new TextEncoder().encode("ls\r")));
    const input = await until(() => device.bins.find((b) => b[0] === TERM_INPUT), "input frame");
    expect(decodeTermFrame(input)).toMatchObject({ type: TERM_INPUT, sid: open.sid });
    expect(new TextDecoder().decode(decodeTermFrame(input)!.payload)).toBe("ls\r");

    browser.send({ type: "term.resize", sid: opened.sid, cols: 100, rows: 30 });
    expect(await until(() => device.msgs.find((m) => m.type === "cli.term.resize"), "resize")).toMatchObject({ sid: open.sid, cols: 100, rows: 30 });

    browser.send({ type: "term.credit", sid: opened.sid, bytes: 14 });
    browser.send({ type: "term.credit", sid: opened.sid, bytes: 500_000 });
    await wait(100);
    expect(device.msgs.filter((m) => m.type === "cli.term.credit").map((m) => m.bytes)).toEqual([14]);

    device.send({ type: "cli.term.size", sid: open.sid, cols: 90, rows: 20 });
    expect(await browser.find("term.size")).toMatchObject({ sid: opened.sid, cols: 90, rows: 20 });

    browser.send({ type: "term.close", sid: opened.sid });
    await until(() => device.msgs.find((m) => m.type === "cli.term.close"), "close at device");
    await wait(50);
    expect(browser.count("term.closed")).toBe(0);
    expect(f.app.cliHub.streamCount()).toBe(0);
  });

  it("closes a stream with device_offline when the device disconnects and releases it when the browser leaves", async () => {
    const { f, device, browser, key } = await terminalFixture();
    browser.send({ type: "term.open", req: "r1", key, cols: 80, rows: 24, observe: true });
    const open = await until(() => device.msgs.find((m) => m.type === "cli.term.open"), "cli.term.open");
    device.send({ type: "cli.term.opened", sid: open.sid, cols: 80, rows: 24, observe: true });
    const opened = await browser.find("term.opened");
    browser.send({ type: "term.open", req: "r2", key, cols: 80, rows: 24, observe: true });
    await until(() => device.msgs.filter((m) => m.type === "cli.term.open").length === 2, "second open");
    expect(f.app.cliHub.streamCount()).toBe(2);
    device.kill();
    const closed = await browser.find("term.closed", (m) => m.sid === opened.sid);
    expect(closed.reason).toBe("device_offline");
    expect(f.app.cliHub.streamCount()).toBe(0);

    const device2 = await connectDevice(f.origin, f.call, undefined, "mac2");
    device2.sessions([wire("z")], { full: true });
    await until(() => f.app.cliHub.session(`${device2.id}:claude:z`), "second device listed");
    browser.send({ type: "term.open", req: "r3", key: `${device2.id}:claude:z`, cols: 80, rows: 24, observe: true });
    await until(() => device2.msgs.find((m) => m.type === "cli.term.open"), "open at device 2");
    expect(f.app.cliHub.streamCount()).toBe(1);
    browser.ws.close();
    await browser.closed;
    await until(() => f.app.cliHub.streamCount() === 0, "stream released");
    await until(() => device2.msgs.find((m) => m.type === "cli.term.close"), "close at device 2");
  });

  it("answers an open on an offline device with an error carrying the request id", async () => {
    const { device, browser, key } = await terminalFixture();
    device.kill();
    await wait(100);
    browser.send({ type: "term.open", req: "r9", key, cols: 80, rows: 24, observe: false });
    expect(await browser.find("error", (m) => m.req === "r9")).toMatchObject({ code: "device_offline" });
  });

  it("drops a browser that cannot take the output and tells it", async () => {
    const f = await fixture({ graceMs: 0, streamBufferMax: 40_000 });
    const device = await connectDevice(f.origin, f.call, undefined, "mac");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const browser = await connectBrowser(f.origin, { cookie: OWNER });
    browser.send({ type: "term.open", req: "r1", key: `${device.id}:claude:a`, cols: 80, rows: 24, observe: false });
    const open = await until(() => device.msgs.find((m) => m.type === "cli.term.open"), "cli.term.open");
    device.send({ type: "cli.term.opened", sid: open.sid, cols: 80, rows: 24, observe: false });
    const opened = await browser.find("term.opened");
    // A browser that reads slowly: pause its socket so the sends back up.
    (browser.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    for (let i = 0; i < 400; i++) device.ws.send(encodeTermFrame(TERM_OUTPUT, open.sid, new Uint8Array(60_000)));
    await until(() => f.app.cliHub.streamCount() === 0, "stream dropped", 8000);
    await until(() => device.msgs.find((m) => m.type === "cli.term.close" && m.sid === open.sid), "close at device");
    (browser.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    expect(await browser.find("term.closed", (m) => m.sid === opened.sid)).toMatchObject({ reason: "overflow" });
  });
});

describe("accounts", () => {
  it("routes a browser and its devices to the Core of their own account", async () => {
    const root = tempDir("nex-cli-accounts-");
    const provider = await startFakeIdentity();
    cleanups.push(() => provider.close());
    const options = { dir: root, key: randomBytes(32), token: "synthetic-bootstrap", identity: { fixtureOrigin: provider.origin }, cliAgents: TUNING } as const;
    const legacy = await createPersonalApp(options);
    const operator = legacy.store.get("SELECT * FROM user_sessions WHERE id=?", legacy.store.session)!;
    const challenge = legacy.identity!.start({ account: "owner@example.test", name: "Original owner" }, operator);
    const owner = await legacy.identity!.respond({ ...challenge, password: " synthetic password " }, operator);
    await legacy.close();
    const service = await createWorkspaceService(options);
    cleanups.push(() => service.close());
    const call = async (route: string, data?: unknown, token = "") => {
      const response = await fetch(service.origin + "/api/" + route, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
      return { status: response.status, data: await response.json() as Record<string, any> };
    };
    const start = await call("auth/start", { account: "other@example.test", name: "Separate client" });
    const other = (await call("auth/respond", { ...start.data, password: " synthetic password " })).data as { token: string };
    expect(service.workspaces.size).toBe(1);

    const ownerDevice = await connectDevice(service.origin, call, owner.token, "owner-mac");
    const otherDevice = await connectDevice(service.origin, call, other.token, "other-mac");
    ownerDevice.sessions([wire("o1", { title: "owner session" })], { full: true });
    otherDevice.sessions([wire("p1", { title: "other session" })], { full: true });

    const ownerBrowser = await connectBrowser(service.origin, { cookie: owner.token });
    const otherBrowser = await connectBrowser(service.origin, { cookie: other.token });
    ownerBrowser.send({ type: "sub.list" });
    otherBrowser.send({ type: "sub.list" });
    const keysOf = async (browser: Browser, expected: string) => {
      await until(() => {
        const keys = new Set<string>();
        for (const m of browser.msgs) for (const s of (m.type === "list" ? m.sessions : m.type === "list.delta" ? m.upserts : [])) keys.add(s.key);
        return keys.has(expected) ? keys : null;
      }, "session " + expected);
      return [...new Set(browser.msgs.flatMap((m) => m.type === "list" ? m.sessions : m.type === "list.delta" ? m.upserts : []).map((s: any) => String(s.key)))];
    };
    expect(await keysOf(ownerBrowser, `${ownerDevice.id}:claude:o1`)).toEqual([`${ownerDevice.id}:claude:o1`]);
    expect(await keysOf(otherBrowser, `${otherDevice.id}:claude:p1`)).toEqual([`${otherDevice.id}:claude:p1`]);

    // A terminal opened by one account reaches only that account's device.
    otherBrowser.send({ type: "term.open", req: "r1", key: `${otherDevice.id}:claude:p1`, cols: 80, rows: 24, observe: true });
    await until(() => otherDevice.msgs.find((m) => m.type === "cli.term.open"), "open at the other account's device");
    ownerBrowser.send({ type: "term.open", req: "r2", key: `${otherDevice.id}:claude:p1`, cols: 80, rows: 24, observe: true });
    expect(await ownerBrowser.find("error", (m) => m.req === "r2")).toMatchObject({ code: "device_offline" });
    expect(ownerDevice.msgs.some((m) => m.type === "cli.term.open")).toBe(false);

    // The HTTP side stays inside the account as well.
    const ownerList = (await call("cli-agents", undefined, owner.token)).data;
    expect(ownerList.sessions.map((s: any) => s.nativeId)).toEqual(["o1"]);
    const otherList = (await call("cli-agents", undefined, other.token)).data;
    expect(otherList.sessions.map((s: any) => s.nativeId)).toEqual(["p1"]);

    // A token that belongs to nobody is refused by the primary.
    expect(await refused(service.origin, { cookie: "nobody" })).toBe(401);
  });
});
