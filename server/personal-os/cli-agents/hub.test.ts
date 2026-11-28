// Agent mode hub: capability gating, session list, item cache, operations,
// terminal stream routing. Everything runs against a disposable Core in a temp
// directory and simulated devices; nothing touches a real account or device.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonalApp, type AppOptions } from "../index.ts";
import { CoreStore } from "../store.ts";
import { CliAgentHub, type CliLink, type StreamSink } from "./hub.ts";
import { TERM_INPUT, TERM_OUTPUT, decodeTermFrame, encodeTermFrame } from "../../../shared/cli-agent-frames.ts";
import { CLI_ERROR_TEXT, CORE_ITEM_CACHE, type CoreCliMessage } from "../../../shared/cli-agents.ts";

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

  it("shows how a session takes messages, follows the device's rows, and forgets it on removal and disconnect", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "via");
    const deltas: Array<{ upserts: any[]; removes: string[] }> = [];
    f.app.cliHub.onList((delta) => deltas.push(delta));
    device.sessions([wire("a", { sendVia: "inbox" }), wire("b", { sendVia: "daemon" }), wire("c", { sendVia: "terminal" }), wire("d")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 4, "listed");
    const via = () => Object.fromEntries(f.app.cliHub.list().sessions.map((s) => [s.nativeId, s.sendVia]));
    expect(via()).toEqual({ a: "inbox", b: "daemon", c: "terminal", d: undefined });
    expect((await f.call("cli-agents")).data.sessions.find((s: any) => s.nativeId === "a")).toMatchObject({ sendVia: "inbox" });

    // a change of route alone is a change worth sending to the clients
    const before = deltas.length;
    device.sessions([wire("a", { sendVia: "terminal" })]);
    await until(() => deltas.length === before + 1, "route change");
    expect(deltas.at(-1)!.upserts[0]).toMatchObject({ nativeId: "a", sendVia: "terminal" });
    device.sessions([wire("a")]);
    await until(() => f.app.cliHub.session(keyOf(device, "a"))?.sendVia === undefined, "route dropped");

    device.sessions([], { removes: ["claude:b"] });
    await until(() => !f.app.cliHub.session(keyOf(device, "b")), "removed");
    device.sessions([wire("b")]);
    await until(() => f.app.cliHub.session(keyOf(device, "b")), "listed again");
    expect(f.app.cliHub.session(keyOf(device, "b"))?.sendVia).toBeUndefined();

    device.kill();
    await until(() => f.app.cliHub.session(keyOf(device, "c"))?.online === false, "offline");
    expect(f.app.cliHub.session(keyOf(device, "c"))?.sendVia).toBeUndefined();
  });

  it("carries repoRoot and forkOf into the views, announces a change of either and forgets them with the connection", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "placed");
    const deltas: Array<{ upserts: any[]; removes: string[] }> = [];
    f.app.cliHub.onList((delta) => deltas.push(delta));
    device.sessions([wire("p", { repoRoot: "D:\\proj" }), wire("c", { repoRoot: "D:\\proj", forkOf: "p" }), wire("n")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 3, "listed");
    const place = () => Object.fromEntries(f.app.cliHub.list().sessions.map((s) => [s.nativeId, [s.repoRoot, s.forkOf]]));
    expect(place()).toEqual({ p: ["D:\\proj", undefined], c: ["D:\\proj", "p"], n: [undefined, undefined] });
    expect((await f.call("cli-agents")).data.sessions.find((s: any) => s.nativeId === "c")).toMatchObject({ repoRoot: "D:\\proj", forkOf: "p" });

    const before = deltas.length;
    device.sessions([wire("n", { repoRoot: "D:\\other" })]);
    await until(() => deltas.length === before + 1, "repoRoot change");
    expect(deltas.at(-1)!.upserts[0]).toMatchObject({ nativeId: "n", repoRoot: "D:\\other" });
    device.sessions([wire("n")]);
    await until(() => f.app.cliHub.session(keyOf(device, "n"))?.repoRoot === undefined, "repoRoot dropped");

    // a malformed value never reaches the list: the device message is rejected as a whole
    device.sessions([wire("bad", { forkOf: "a:b" })]);
    await wait(100);
    expect(f.app.cliHub.session(keyOf(device, "bad"))).toBeNull();

    device.kill();
    await until(() => f.app.cliHub.session(keyOf(device, "c"))?.online === false, "offline");
    expect(f.app.cliHub.session(keyOf(device, "c"))?.forkOf).toBeUndefined();
    expect(f.app.cliHub.session(keyOf(device, "c"))?.repoRoot).toBeUndefined();
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

describe("assistant translation", () => {
  it("saves only a model selection in the current workspace and rejects stale or unavailable choices", async () => {
    const f = await fixture(), other = await fixture();
    const route = "cli-agents/translation-settings";
    const connectionId = f.app.store.saveConnection({
      name: "MiniMax fixture", provider: "openai", endpoint: "http://127.0.0.1:5000/v1",
      apiKey: "synthetic-secret", defaultModel: "fixture-model",
    });
    f.app.store.saveModelVisibility({ connectionId, models: ["fixture-model"], version: 0 });
    expect((await f.call(route)).data).toEqual({ selection: null, available: false, version: 0 });
    const selection = { connectionId, model: "fixture-model" };
    expect((await f.call(route, { selection, version: 0 }, "bad-token")).status).toBe(401);
    expect((await f.call(route, { selection: { ...selection, model: "disabled-model" }, version: 0 })).status).toBe(400);
    const saved = await f.call(route, { selection, version: 0 });
    expect(saved).toEqual({ status: 200, data: { selection, available: true, version: 1 } });
    expect((await f.call(route)).data).toEqual(saved.data);
    expect((await other.call(route)).data).toEqual({ selection: null, available: false, version: 0 });
    expect((await f.call(route, { selection: null, version: 0 })).status).toBe(400);

    f.app.store.saveModelVisibility({ connectionId, models: [], version: 1 });
    expect((await f.call(route)).data).toEqual({ selection, available: false, version: 1 });
    expect((await f.call(route, { selection: null, version: 1 })).data).toEqual({ selection: null, available: false, version: 2 });
  });

  it("translates completed cached replies through the authenticated Core route and rejects corrupt output", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    cleanups.push(() => { vi.unstubAllEnvs(); });
    const requests: Array<{ prompt: string; model: string; effort?: string; key?: string; path?: string }> = [];
    let corrupt = false;
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const anthropic = request.url === "/anthropic/v1/messages";
      const content = anthropic ? data.messages[0].content[0].text : data.messages[0].content;
      const prompt = String(content).split("<source>\n")[1]!.split("\n</source>")[0]!;
      requests.push({
        prompt, model: data.model, effort: data.reasoning_effort ?? data.output_config?.effort,
        key: request.headers.authorization ?? String(request.headers["x-api-key"]), path: request.url,
      });
      const markers = prompt.match(/\[\[NEX_\d+\]\]/g) ?? [];
      const translation = corrupt ? "缺失占位符" : `仅在迁移成功后运行 ${markers[0]}。否则，回滚。`;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(anthropic
        ? { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: translation }] }
        : { choices: [{ finish_reason: "stop", message: { content: translation, reasoning_content: "private reasoning" } }] }));

    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); }));
    const f = await fixture();
    const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    const minimax = f.app.store.saveConnection({
      name: "MiniMax fixture", provider: "openai", endpoint: endpoint + "/v1", apiKey: "minimax-fixture-key", defaultModel: "other-model",
    });
    const claude = f.app.store.saveConnection({
      name: "Anthropic fixture", provider: "anthropic", endpoint: endpoint + "/anthropic", apiKey: "claude-fixture-key", defaultModel: "claude-fixture",
    });
    const device = await connectDevice(f, "translation");
    const key = keyOf(device, "a");
    device.sessions([wire("a", { state: "running" })], { full: true });
    await until(() => f.app.cliHub.session(key)?.state === "running", "running");
    const source = "Only run `pnpm test` if the migration succeeds. Otherwise, roll back.\n\n```sh\necho secret test command\n```";
    const assistant = item(1, source);
    const translated = "仅在迁移成功后运行 `pnpm test`。否则，回滚。\n\n```sh\necho secret test command\n```";
    const itemsRoute = `cli-agents/items?key=${encodeURIComponent(key)}`;
    expect((await f.call(itemsRoute)).data.translationEnabled).toBeUndefined();
    expect((await f.call("cli-agents/translation-settings", { version: 0, selection: { connectionId: minimax, model: "MiniMax-M3.1-Flash" } })).status).toBe(200);
    const page = await f.call(itemsRoute);
    expect(page.data.translationEnabled).toBe(true);
    device.send({ type: "cli.items", ref: "claude:a", items: [assistant] });
    await until(() => f.app.store.get("SELECT body FROM cli_agent_items WHERE session_key=? AND item_id=?", key, assistant.id), "cached");
    const body = { key, itemId: assistant.id, source };
    expect((await f.call("cli-agents/translate", body, "bad-token")).status).toBe(401);
    expect((await f.call("cli-agents/translate", body)).data.translation).toBeNull();
    expect(requests).toHaveLength(0);

    const ended = { kind: "turn", id: "ended", ts: 1002, phase: "ended" };
    device.send({ type: "cli.items", ref: "claude:a", items: [ended] });
    await until(() => f.app.store.get("SELECT body FROM cli_agent_items WHERE session_key=? AND item_id=?", key, ended.id), "turn ended");
    const results = await Promise.all([f.call("cli-agents/translate", body), f.call("cli-agents/translate", body)]);
    expect(results.map(result => result.data.translation)).toEqual([translated, translated]);
    expect((await f.call("cli-agents/translate", body)).data.translation).toBe(translated);
    expect(requests).toEqual([{
      prompt: "Only run [[NEX_0]] if the migration succeeds. Otherwise, roll back.",
      model: "MiniMax-M3.1-Flash", effort: "low", key: "Bearer minimax-fixture-key", path: "/v1/chat/completions",
    }]);
    expect((await f.call("cli-agents/translate", { ...body, source: "a spoofed version" })).data.translation).toBeNull();
    expect(requests).toHaveLength(1);

    expect((await f.call("cli-agents/translation-settings", {
      version: 1, selection: { connectionId: claude, model: "claude-fixture" },
    })).status).toBe(200);
    expect((await f.call("cli-agents/translate", body)).data.translation).toBe(translated);
    expect(requests.at(-1)).toMatchObject({ model: "claude-fixture", key: "claude-fixture-key", path: "/anthropic/v1/messages" });
    expect(requests).toHaveLength(2);

    corrupt = true;
    const next = item(3, "Keep `src/cache.ts` as it is.");
    device.send({ type: "cli.items", ref: "claude:a", items: [next, { ...ended, id: "ended2", ts: 1004 }] });
    await until(() => f.app.store.get("SELECT body FROM cli_agent_items WHERE session_key=? AND item_id='ended2'", key), "second turn ended");
    expect(await f.call("cli-agents/translate", { key, itemId: next.id, source: next.text })).toEqual({ status: 422, data: { error: "翻译失败" } });
    expect(requests.at(-1)?.prompt).not.toContain("src/cache.ts");
    expect((await f.call("cli-agents/translation-settings", { version: 2, selection: null })).status).toBe(200);
    expect((await f.call(itemsRoute)).data.translationEnabled).toBe(false);
    expect((await f.call("cli-agents/translate", body)).data.translation).toBeNull();
  });

  it("judges only eligible prose and keeps the session usable while Jev is pending", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "jev translation");
    const key = keyOf(device, "a");
    device.sessions([wire("a", { state: "running" })], { full: true });
    await until(() => f.app.cliHub.session(key)?.state === "running", "running");
    const connectionId = f.app.store.saveConnection({
      name: "Translation fixture", provider: "openai", endpoint: "https://translation.example/v1",
      apiKey: "translation-fixture-key", defaultModel: "fixture-model",
    });
    expect((await f.call("cli-agents/translation-settings", { version: 0, selection: { connectionId, model: "fixture-model" } })).status).toBe(200);
    vi.stubEnv("TYPESAFE_API_KEY", "jev-fixture-key");
    vi.stubEnv("NEX_TRANSLATION_JEV_CORE_ID", String(f.app.store.get("SELECT core_id FROM workspaces")?.core_id));
    vi.stubEnv("NEX_TRANSLATION_JEV_PROXY", "");
    cleanups.push(() => { vi.unstubAllEnvs(); });

    const originalFetch = globalThis.fetch;
    const judgeRequests: Array<{ model: string; state: { paragraphs: Record<string, string> } }> = [];
    const prompts: string[] = [];
    const respondToJudge: Array<(response: Response) => void> = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "https://api.typesafe.ai/v1/systemone") {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer jev-fixture-key");
        judgeRequests.push(JSON.parse(String(init?.body)));
        return await new Promise<Response>(resolve => { respondToJudge.push(resolve); });
      }
      if (String(input) === "https://translation.example/v1/chat/completions") {
        const { messages } = JSON.parse(String(init?.body));
        prompts.push(messages[0].content.split("<source>\n")[1].split("\n</source>")[0]);
        const content = prompts.at(-1) === "Perhaps a heading" ? "可能是个标题。" : "修复完成。测试通过。见 [[NEX_0]]。";
        return Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });
      }
      return originalFetch(input, init);
    });
    cleanups.push(() => { fetch.mockRestore(); });

    const chinese = item(1, "全中文段落。\n\n```sh\necho sensitive fixture\n```");
    const paragraphs = [
      "修复完成。Tests pass. See `src/cache.ts`.", "已修复 React 页面。", "Perhaps a heading",
      "```sh\necho sensitive fixture\n```", "2026-11-25 10:00 private log line", "| internal header |\n| --- |\n| private row |",
    ];
    const mixed = item(2, paragraphs.join("\n\n"));
    device.send({ type: "cli.items", ref: "claude:a", items: [chinese, mixed] });
    await until(() => f.app.store.get("SELECT 1 FROM cli_agent_items WHERE session_key=? AND item_id=?", key, mixed.id), "cached original");
    const translate = (reply: typeof mixed) => f.call("cli-agents/translate", { key, itemId: reply.id, source: reply.text });
    expect((await translate(mixed)).data.translation).toBeNull();
    expect(judgeRequests).toHaveLength(0);

    const ended = { kind: "turn", id: "ended-jev", ts: 1003, phase: "ended" };
    device.send({ type: "cli.items", ref: "claude:a", items: [ended] });
    await until(() => f.app.store.get("SELECT 1 FROM cli_agent_items WHERE session_key=? AND item_id=?", key, ended.id), "turn ended");
    expect((await translate(chinese)).data.translation).toBeNull();
    expect(judgeRequests).toHaveLength(0);

    const translation = translate(mixed);
    cleanups.push(async () => {
      for (const respond of respondToJudge) respond(Response.error());
      await translation.catch(() => undefined);
    });
    await until(() => judgeRequests.length === 1, "Jev request started");
    expect(judgeRequests[0]).toMatchObject({ model: "jev-1.14.0", state: { paragraphs: {
      p1: "修复完成。Tests pass. See .", p2: "已修复 React 页面。", p3: "Perhaps a heading",
    } } });
    expect(Object.keys(judgeRequests[0]!.state.paragraphs)).toHaveLength(3);
    expect(prompts).toHaveLength(0);
    device.onOp = message => message.op === "read"
      ? { ok: true, result: { items: [chinese, mixed, ended], more: false } }
      : defaultOp(message);
    const page = await f.call(`cli-agents/items?key=${encodeURIComponent(key)}`);
    expect(page.data.items).toContainEqual(expect.objectContaining({ id: mixed.id, text: mixed.text }));
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.session(key)?.state === "idle", "ready for the next turn");
    expect((await f.call("cli-agents/send", { key, text: "Next prompt" })).status).toBe(200);

    respondToJudge[0]!(Response.json({ answers: { p1: { type: "noul", noul: 0.7 }, p2: { type: "noul", noul: 0.1 } } }));
    expect((await translation).data.translation).toBe([...paragraphs.slice(0, 2), "可能是个标题。", ...paragraphs.slice(3)].join("\n\n"));
    expect(prompts).toEqual(["Perhaps a heading"]);
    const retry = translate(mixed);
    await until(() => judgeRequests.length === 2, "Jev retry started");
    respondToJudge[1]!(Response.json({ answers: {
      p1: { type: "noul", noul: 0.7 }, p2: { type: "noul", noul: 0.1 }, p3: { type: "noul", noul: 0.69 },
    } }));
    expect((await retry).data.translation).toBe(["修复完成。测试通过。见 `src/cache.ts`。", ...paragraphs.slice(1)].join("\n\n"));
    expect(prompts).toEqual(["Perhaps a heading", "修复完成。Tests pass. See [[NEX_0]]."]);
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

  it("retries an oversized older page with the same cursor and a smaller limit", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "large-history");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a"), before = item(20).id;
    const reads: { before: string; limit: number }[] = [];
    device.onOp = (message) => {
      if (message.op !== "read") return defaultOp(message);
      reads.push({ before: message.args.before, limit: message.args.limit });
      return message.args.limit > 10
        ? { ok: false, error: { code: "too_large", message: "内容太长" } }
        : { ok: true, result: { items: [item(19, "older")], more: true } };
    };
    const response = await f.call("cli-agents/items?" + new URLSearchParams({ key, before }));
    expect(reads).toEqual([{ before, limit: 40 }, { before, limit: 20 }, { before, limit: 10 }]);
    expect(response).toMatchObject({ status: 200, data: { items: [item(19, "older")], more: true } });
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
    const older = await f.call("cli-agents/items?" + new URLSearchParams({ key, before: item(1).id }));
    expect(older.data).toMatchObject({ code: "device_offline", error: "会话所在电脑离线，暂时无法加载更早的记录" });
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

  it("forks through a device that lists the engine, and refuses an older executor instead of opening a blank session", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "fork", { cap: { ...CAP, forkEngines: ["claude"] } });
    device.onOp = (message) => (message.op === "start" ? { ok: true, result: { ref: "claude:child", terminal: "term-1" } } : defaultOp(message));
    device.sessions([wire("parent"), wire("other", { engine: "codex" })], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 2, "listed");
    const parent = keyOf(device, "parent");

    const forked = await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", forkFrom: parent });
    expect(forked).toMatchObject({ status: 200, data: { key: keyOf(device, "child") } });
    expect(device.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj", forkFrom: "claude:parent" });
    expect(JSON.parse(String(f.app.store.get("SELECT args_json FROM cli_agent_ops WHERE op='start'")?.args_json))).toMatchObject({ forkFrom: "claude:parent" });

    // not a key, another device's or another engine's session, a session Core does not know, a fork inside a new worktree
    const bad = async (extra: Record<string, unknown>, data: Record<string, unknown> = {}) => (await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", ...data, forkFrom: parent, ...extra })).status;
    expect(await bad({ forkFrom: "nope" })).toBe(400);
    expect(await bad({ forkFrom: keyOf(device, "other", "codex") })).toBe(400);
    expect(await bad({ forkFrom: `someone-else:claude:parent` })).toBe(400);
    expect(await bad({ forkFrom: keyOf(device, "ghost") })).toBe(404);
    expect(await bad({}, { worktreeBranch: "feat/x", requestId: "abcdefgh1234" })).toBe(400);
    expect(device.ops("start")).toHaveLength(1);

    // an executor that does not list the engine would ignore forkFrom and start a blank session
    const codex = await f.call("cli-agents/start", { deviceId: device.id, engine: "codex", cwd: "C:/proj", forkFrom: keyOf(device, "other", "codex") });
    expect(codex.status).toBe(400);
    expect(String(codex.data.error)).toContain("版本过旧");
    const old = await connectDevice(f, "old");
    old.sessions([wire("p2")], { full: true });
    await until(() => f.app.cliHub.session(keyOf(old, "p2")), "old listed");
    const refused = await f.call("cli-agents/start", { deviceId: old.id, engine: "claude", cwd: "C:/proj", forkFrom: keyOf(old, "p2") });
    expect(refused.status).toBe(400);
    expect(String(refused.data.error)).toContain("版本过旧");
    expect(old.ops("start")).toHaveLength(0);
    // a plain start still works there
    old.onOp = (message) => (message.op === "start" ? { ok: true, result: { ref: "claude:plain", terminal: "t" } } : defaultOp(message));
    expect((await f.call("cli-agents/start", { deviceId: old.id, engine: "claude", cwd: "C:/proj" })).status).toBe(200);
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

  it("passes delivery and waiting from the device to the caller", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "delivery");
    device.sessions([wire("a", { sendVia: "inbox" })], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a");

    device.onOp = (message) => message.op === "send" ? { ok: true, result: { turn: 0, started: false, delivery: "unconfirmed", waiting: true } } : defaultOp(message);
    const unconfirmed = await f.call("cli-agents/send", { key, text: "hello" });
    expect(unconfirmed).toMatchObject({ status: 200, data: { turn: 0, started: false, delivery: "unconfirmed", waiting: true } });

    device.onOp = (message) => message.op === "send" ? { ok: true, result: { turn: 0, started: false, delivery: "confirmed" } } : defaultOp(message);
    const confirmed = await f.call("cli-agents/send", { key, text: "hello" });
    expect(confirmed.data.delivery).toBe("confirmed");
    expect(confirmed.data.waiting).toBeUndefined();

    // an answer with a value outside the contract is a malformed result, not a guess
    device.onOp = (message) => message.op === "send" ? { ok: true, result: { turn: 0, started: false, delivery: "whatever" } } : defaultOp(message);
    const odd = await f.call("cli-agents/send", { key, text: "hello" });
    expect(odd).toMatchObject({ status: 409, data: { code: "unknown" } });
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

  it("passes the device's own refusal wording through, and falls back to the standard text without one", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "words");
    device.sessions([wire("a")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 1, "listed");
    const key = keyOf(device, "a");

    device.onOp = (message) => message.op === "send" ? { ok: false, error: { code: "busy", message: "电脑上有人正在输入" } } : defaultOp(message);
    const typing = await f.call("cli-agents/send", { key, text: "hello" });
    expect(typing).toMatchObject({ status: 409, data: { code: "busy", error: "电脑上有人正在输入" } });

    device.onOp = (message) => message.op === "send" ? { ok: false, error: { code: "busy" } } : defaultOp(message);
    const bare = await f.call("cli-agents/send", { key, text: "hello" });
    expect(bare).toMatchObject({ status: 409, data: { code: "busy", error: CLI_ERROR_TEXT.busy } });

    // a long device message stays short
    device.onOp = (message) => message.op === "send" ? { ok: false, error: { code: "busy", message: "忙".repeat(900) } } : defaultOp(message);
    const long = await f.call("cli-agents/send", { key, text: "hello" });
    expect(long.status).toBe(409);
    expect(String(long.data.error).length).toBeLessThanOrEqual(200);
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

describe("search, launch options and attachments", () => {
  const FULL = { ...CAP, features: ["search", "launchOptions", "attach"] };

  it("stores chat images privately in OSS, sends only a limited link, and keeps that link out of the transcript", async () => {
    const f = await fixture(), objects = new Map<string, string>();
    f.app.store.attachmentObjects = {
      async put(key, value) { objects.set(key, value); },
      async get(key) { return objects.get(key)!; },
    };
    const device = await connectDevice(f, "image fixture");
    device.sessions([wire("image-session")], { full: true });
    await until(() => f.app.cliHub.session(keyOf(device, "image-session")));
    const key = keyOf(device, "image-session");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEtcAAAAASUVORK5CYII=", "base64");
    const uploaded = await fetch(f.app.origin + "/api/cli-agents/images?key=" + encodeURIComponent(key), {
      method: "POST", headers: { Authorization: "Bearer " + OWNER, "Content-Type": "image/png" }, body: new Uint8Array(bytes),
    });
    expect(uploaded.status).toBe(200);
    const { path: imagePath } = await uploaded.json() as { path: string };
    expect(imagePath).toMatch(/^\/api\/cli-agents\/images\/[0-9a-f-]+$/);
    expect(device.ops("attach")).toHaveLength(0);
    expect([...objects.keys()]).toEqual([expect.stringContaining("nexbot/attachments/v1/")]);
    expect([...objects.values()][0]).not.toContain(bytes.toString("base64"));
    expect(f.app.store.get("SELECT ciphertext,published FROM cli_agent_images")).toEqual({ ciphertext: "", published: 0 });
    const preview = f.app.origin + imagePath, auth = { Authorization: "Bearer " + OWNER };
    expect((await fetch(preview)).status).toBe(401);
    expect((await fetch(preview, { headers: auth })).status).toBe(404);
    const text = `看看图片\n\n![fixture.png](${imagePath})`;
    expect((await f.call("cli-agents/send", { key, text, delivery: "send", clientMessageId: "image-message", requestId: "image-send" })).status).toBe(200);
    const outgoing: string = device.ops("send").at(-1)?.args.text;
    const link = /\]\((https?:\/\/[^)]+)\)/.exec(outgoing)?.[1] ?? "";
    expect(link).toContain(preview + "?ticket=");
    expect((await fetch(link.replace(/.$/, link.endsWith("0") ? "1" : "0"))).status).toBe(401);
    expect(Buffer.from(await (await fetch(link)).arrayBuffer())).toEqual(bytes);
    expect(Buffer.from(await (await fetch(preview, { headers: auth })).arrayBuffer())).toEqual(bytes);
    const compact = await fetch(preview + "?preview=1", { headers: auth });
    expect(compact.headers.get("Content-Type")).toBe("image/webp");
    expect(Buffer.from(await compact.arrayBuffer()).toString("ascii", 8, 12)).toBe("WEBP");
    device.onOp = (op) => op.op === "read" ? {
      ok: true, result: { items: [{ kind: "user", id: "image-message", ts: 123, text: outgoing }], more: false },
    } : defaultOp(op);
    const transcript = await f.call("cli-agents/items?key=" + encodeURIComponent(key));
    expect(transcript.data.items[0].text).toBe(text);
  });

  it("publishes a history image on first view and serves subsequent devices while the source is offline", async () => {
    const f = await fixture(), objects = new Map<string, string>();
    f.app.store.attachmentObjects = {
      async put(key, value) { objects.set(key, value); },
      async get(key) { return objects.get(key)!; },
    };
    const device = await connectDevice(f, "history image source");
    const key = keyOf(device, "history");
    device.sessions([wire("history")], { full: true });
    await until(() => f.app.cliHub.session(key));
    const locator = "history:42:" + "a".repeat(64);
    const bytes = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=", "base64");
    device.onOp = op => {
      if (op.op === "read") return { ok: true, result: { items: [{ kind: "user", ts: 1, id: "msg", text: "", images: [locator] }], more: false } };
      if (op.op === "history_image") return { ok: true, result: { data: bytes.toString("base64") } };
      return defaultOp(op);
    };
    const page = await f.call("cli-agents/items?key=" + encodeURIComponent(key));
    const url = f.app.origin + page.data.items[0].images[0] + "?preview=1";
    expect(objects.size).toBe(0);
    expect((await fetch(url)).status).toBe(401);
    expect(device.ops("history_image")).toHaveLength(0);
    const get = async () => Buffer.from(await (await fetch(url, { headers: { Authorization: "Bearer " + OWNER } })).arrayBuffer());
    expect(await Promise.all([get(), get()])).toEqual([bytes, bytes]);
    expect(device.ops("history_image")).toHaveLength(1);
    expect(device.ops("history_image")[0].args).toEqual({ ref: "claude:history", itemId: "msg", locator });
    expect(objects.size).toBe(1);
    device.kill();
    await device.closed;
    expect(await get()).toEqual(bytes);
  });

  it("searches the online computers that can, keys the hits, drops unknown sessions and survives a failing computer", async () => {
    const f = await fixture();
    const a = await connectDevice(f, "search-a", { cap: FULL });
    const b = await connectDevice(f, "search-b", { cap: FULL });
    const old = await connectDevice(f, "search-old");
    a.sessions([wire("older", { lastActivityAt: 1000 }), wire("newer", { lastActivityAt: 5000 })], { full: true });
    b.sessions([wire("b1", { lastActivityAt: 3000 })], { full: true });
    old.sessions([wire("o1")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 4, "listed");
    a.onOp = (message) => message.op === "search"
      ? { ok: true, result: { hits: [{ ref: "claude:older", snippet: "old hit" }, { ref: "claude:newer", snippet: "new hit" }, { ref: "claude:ghost", snippet: "unknown" }] } }
      : defaultOp(message);
    b.onOp = (message) => message.op === "search" ? { ok: false, error: { code: "unknown" } } : defaultOp(message);

    const found = await f.call(`cli-agents/search?q=${encodeURIComponent("部署 main")}`);
    expect(found.status).toBe(200);
    expect(found.data.hits).toEqual([
      { key: keyOf(a, "newer"), snippet: "new hit" },
      { key: keyOf(a, "older"), snippet: "old hit" },
    ]);
    expect(a.ops("search").at(-1)!.args).toEqual({ query: "部署 main" });
    expect(b.ops("search")).toHaveLength(1);
    // an executor without the feature is never asked
    expect(old.ops("search")).toHaveLength(0);
    // a search is not a change: nothing is recorded
    expect(f.app.store.all("SELECT op FROM cli_agent_ops")).toEqual([]);

    expect((await f.call("cli-agents/search?q=")).status).toBe(400);
    expect((await f.call("cli-agents/search?q=%20%20")).status).toBe(400);
    expect((await f.call(`cli-agents/search?q=${"x".repeat(201)}`)).status).toBe(400);
  });

  it("lists a computer's CLI models, and refuses an executor that cannot", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "models", { cap: { ...FULL, features: [...FULL.features, "models"] } });
    const old = await connectDevice(f, "models-old", { cap: FULL });
    const catalog = { current: "auto/claude-opus-5-5[1m]", models: [{ id: "auto/claude-opus-5-5[1m]", label: "Opus 5.5 · gateway", efforts: ["low", "high"] }, { id: "bad name", label: "x" }] };
    device.onOp = (message) => message.op === "models" ? { ok: true, result: catalog } : defaultOp(message);
    const listed = await f.call(`cli-agents/models?deviceId=${device.id}&engine=claude`);
    expect(listed).toMatchObject({ status: 200, data: { current: "auto/claude-opus-5-5[1m]", models: [{ id: "auto/claude-opus-5-5[1m]", label: "Opus 5.5 · gateway", efforts: ["low", "high"] }] } });
    expect(device.ops("models").at(-1)!.args).toEqual({ engine: "claude" });
    expect((await f.call(`cli-agents/models?deviceId=${old.id}&engine=claude`)).status).toBe(400);
    expect(old.ops("models")).toHaveLength(0);
    expect((await f.call(`cli-agents/models?deviceId=${device.id}&engine=gpt`)).status).toBe(400);
    // a model gateways name with a slash is a launch option too
    device.onOp = (message) => message.op === "start" ? { ok: true, result: { ref: "claude:new9", terminal: "t" } } : defaultOp(message);
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", model: "auto/claude-opus-5-5[1m]" })).status).toBe(200);
    expect(device.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj", model: "auto/claude-opus-5-5[1m]" });
  });

  it("sends the permission mode only to an executor that takes it, and drops it for an older one", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "perm", { cap: { ...FULL, features: [...FULL.features, "permissions"] } });
    const old = await connectDevice(f, "perm-old", { cap: FULL });
    device.sessions([wire("p1")], { full: true });
    await until(() => f.app.cliHub.list().sessions.some((s) => s.nativeId === "p1"), "listed");
    for (const target of [device, old]) target.onOp = (message) => message.op === "start" || message.op === "continue" ? { ok: true, result: { ref: "claude:p1", terminal: "t" } } : defaultOp(message);
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", permissions: "ask" })).status).toBe(200);
    expect(device.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj", permissions: "ask" });
    expect((await f.call("cli-agents/continue", { key: keyOf(device, "p1"), permissions: "full" })).status).toBe(200);
    expect(device.ops("continue").at(-1)!.args).toEqual({ ref: "claude:p1", permissions: "full" });
    // nothing chosen: the executor applies its own default (full for a new session)
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj" })).status).toBe(200);
    expect(device.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj" });
    expect((await f.call("cli-agents/start", { deviceId: old.id, engine: "claude", cwd: "C:/proj", permissions: "ask" })).status).toBe(200);
    expect(old.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj" });
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", permissions: "root" })).status).toBe(400);
  });

  it("passes a CLI's other permission modes only to an executor that takes them, and refuses a mode the CLI lacks", async () => {
    const f = await fixture();
    const modes = await connectDevice(f, "perm-modes", { cap: { ...FULL, features: [...FULL.features, "permissions", "permissionModes"] } });
    const basic = await connectDevice(f, "perm-basic", { cap: { ...FULL, features: [...FULL.features, "permissions"] } });
    modes.sessions([wire("m1")], { full: true });
    await until(() => f.app.cliHub.list().sessions.some((s) => s.nativeId === "m1"), "listed");
    for (const target of [modes, basic]) target.onOp = (message) => message.op === "start" || message.op === "continue" ? { ok: true, result: { ref: "claude:m1", terminal: "t" } } : defaultOp(message);
    expect((await f.call("cli-agents/start", { deviceId: modes.id, engine: "claude", cwd: "C:/proj", permissions: "plan" })).status).toBe(200);
    expect(modes.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj", permissions: "plan" });
    expect((await f.call("cli-agents/continue", { key: keyOf(modes, "m1"), permissions: "edits" })).status).toBe(200);
    expect(modes.ops("continue").at(-1)!.args).toEqual({ ref: "claude:m1", permissions: "edits" });
    // an executor with only full and ask keeps the CLI's own settings rather than a mode it cannot apply
    expect((await f.call("cli-agents/start", { deviceId: basic.id, engine: "claude", cwd: "C:/proj", permissions: "plan" })).status).toBe(200);
    expect(basic.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj" });
    expect((await f.call("cli-agents/start", { deviceId: modes.id, engine: "codex", cwd: "C:/proj", permissions: "edits" })).status).toBe(400);
    expect((await f.call("cli-agents/start", { deviceId: modes.id, engine: "codex", cwd: "C:/proj", permissions: "readonly" })).status).toBe(200);
  });

  it("passes each session's context usage to the page, and a change of usage alone", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "context", { cap: FULL });
    device.sessions([wire("c1", { context: { used: 5100, window: 200000 } }), wire("c2")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 2, "listed");
    const byKey = () => new Map(f.app.cliHub.list().sessions.map((session) => [session.nativeId, session]));
    expect(byKey().get("c1")?.context).toEqual({ used: 5100, window: 200000 });
    expect(byKey().get("c2")?.context).toBeUndefined();
    // the next turn: only the usage moved, and it still reaches the page
    device.sessions([wire("c1", { context: { used: 90000, window: 200000 } })]);
    await until(() => byKey().get("c1")?.context?.used === 90000, "usage updated");
  });

  it("lists a computer's folders and starts in a folder it creates, and refuses an executor that cannot", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "dirs", { cap: { ...FULL, features: [...FULL.features, "dirs"] } });
    const old = await connectDevice(f, "dirs-old", { cap: FULL });
    const folder = { path: "C:\\proj", parent: "C:\\", exists: true, git: true, entries: [{ name: "src", path: "C:\\proj\\src" }, { name: "bad", path: "relative" }] };
    device.onOp = (message) => message.op === "dirs" ? { ok: true, result: folder }
      : message.op === "start" ? { ok: true, result: { ref: "claude:new7", terminal: "t" } } : defaultOp(message);
    const listed = await f.call(`cli-agents/dirs?deviceId=${device.id}&path=${encodeURIComponent("C:\\proj")}`);
    expect(listed).toMatchObject({ status: 200, data: { path: "C:\\proj", git: true, entries: [{ name: "src", path: "C:\\proj\\src" }] } });
    expect(device.ops("dirs").at(-1)!.args).toEqual({ path: "C:\\proj" });
    expect((await f.call(`cli-agents/dirs?deviceId=${device.id}`)).status).toBe(200);
    expect(device.ops("dirs").at(-1)!.args).toEqual({ path: "" });
    expect((await f.call(`cli-agents/dirs?deviceId=${device.id}&path=relative`)).status).toBe(400);
    expect((await f.call(`cli-agents/dirs?deviceId=${old.id}&path=${encodeURIComponent("C:\\proj")}`)).status).toBe(400);
    expect(old.ops("dirs")).toHaveLength(0);

    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/new/app", createDir: true })).status).toBe(200);
    expect(device.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/new/app", createDir: true });
    // a new folder has no repository to make a worktree of; an old executor would ignore the flag
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/new/app", createDir: true, worktreeBranch: "nexagent/x", requestId: "r-1" })).status).toBe(400);
    expect((await f.call("cli-agents/start", { deviceId: old.id, engine: "claude", cwd: "C:/new/app", createDir: true })).status).toBe(400);
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/new/app", createDir: "yes" })).status).toBe(400);
  });

  it("passes model and effort to a computer that can take them and refuses an older one", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "launch", { cap: FULL });
    const old = await connectDevice(f, "launch-old");
    device.sessions([wire("c1", { engine: "codex" })], { full: true });
    old.sessions([wire("o1")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 2, "listed");
    device.onOp = (message) => {
      if (message.op === "start") return { ok: true, result: { ref: "claude:new1", terminal: "t" } };
      if (message.op === "continue") return { ok: true, result: { ref: message.args.ref, terminal: "t2" } };
      return defaultOp(message);
    };

    const started = await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", model: "opus", effort: "xhigh" });
    expect(started).toMatchObject({ status: 200, data: { key: keyOf(device, "new1") } });
    expect(device.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj", model: "opus", effort: "xhigh" });
    const continued = await f.call("cli-agents/continue", { key: keyOf(device, "c1", "codex"), effort: "ultra" });
    expect(continued.status).toBe(200);
    expect(device.ops("continue").at(-1)!.args).toEqual({ ref: "codex:c1", effort: "ultra" });
    // empty values are "not chosen", today's launch
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", model: "", effort: null })).status).toBe(200);
    expect(device.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj" });

    // an effort the engine lacks, a model that is not a plain name
    const before = device.ops().length;
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", effort: "ultra" })).status).toBe(400);
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", model: "--yolo" })).status).toBe(400);
    expect((await f.call("cli-agents/continue", { key: keyOf(device, "c1", "codex"), effort: "turbo" })).status).toBe(400);
    expect(device.ops()).toHaveLength(before);

    const refused = await f.call("cli-agents/start", { deviceId: old.id, engine: "claude", cwd: "C:/proj", model: "opus" });
    expect(refused).toMatchObject({ status: 400, data: { code: "invalid", error: "电脑端版本过旧，升级后可用" } });
    const refusedContinue = await f.call("cli-agents/continue", { key: keyOf(old, "o1"), effort: "low" });
    expect(refusedContinue.data.error).toBe("电脑端版本过旧，升级后可用");
    expect(old.ops("start")).toHaveLength(0);
    expect(old.ops("continue")).toHaveLength(0);
  });

  it("uploads an attachment as the raw body, forwards it as base64 and refuses what is too big or too old", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "attach", { cap: FULL });
    const old = await connectDevice(f, "attach-old");
    device.sessions([wire("a")], { full: true });
    old.sessions([wire("o")], { full: true });
    await until(() => f.app.cliHub.list().sessions.length === 2, "listed");
    device.onOp = (message) => message.op === "attach" ? { ok: true, result: { path: "/tmp/nexbot-attachments/claude-a/1234abcd-shot.png" } } : defaultOp(message);
    const upload = (key: string, name: string, body: Uint8Array | string, headers: Record<string, string> = {}) =>
      fetch(`${f.app.origin}/api/cli-agents/attach?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: "Bearer " + OWNER, "Content-Type": "image/png", ...headers }, body })
        .then(async (response) => ({ status: response.status, data: await response.json() as Record<string, any> }));

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const ok = await upload(keyOf(device, "a"), "截图 1.png", bytes);
    expect(ok).toEqual({ status: 200, data: { path: "/tmp/nexbot-attachments/claude-a/1234abcd-shot.png" } });
    const op = device.ops("attach").at(-1)!;
    expect(op.args).toEqual({ ref: "claude:a", name: "截图 1.png", data: Buffer.from(bytes).toString("base64") });
    // the file is neither in the op record nor in the audit trail; the audit keeps its size
    expect(f.app.store.all("SELECT op FROM cli_agent_ops WHERE op='attach'")).toEqual([]);
    const audit = f.app.store.all("SELECT details_json FROM audit_records WHERE action='cli.attach'").map((row) => String(row.details_json));
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0])).toMatchObject({ size: 8 });
    expect(audit[0]).not.toContain("截图");

    const tooBig = await upload(keyOf(device, "a"), "big.bin", new Uint8Array(8 * 1024 * 1024 + 1));
    expect(tooBig).toMatchObject({ status: 413, data: { code: "too_large" } });
    const outdated = await upload(keyOf(old, "o"), "a.png", bytes);
    expect(outdated).toMatchObject({ status: 400, data: { code: "invalid", error: "电脑端版本过旧，升级后可用" } });
    expect(old.ops("attach")).toHaveLength(0);
    expect((await upload("bad key", "a.png", bytes)).status).toBe(400);
    expect((await upload(keyOf(device, "a"), "", bytes)).status).toBe(400);
    expect((await upload(keyOf(device, "a"), "a.png", bytes, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect(device.ops("attach")).toHaveLength(1);
  });

  it("deduplicates worktree start retries by requestId instead of launching a second session", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "wt-dedup", { cap: FULL });
    let starts = 0;
    device.onOp = (message) => {
      if (message.op !== "start") return defaultOp(message);
      starts += 1;
      return { ok: true, result: { ref: `agy:sess-${starts}`, cwd: "C:/wt/nexagent-abc" } };
    };
    const body = { deviceId: device.id, engine: "agy", cwd: "C:/proj", worktreeBranch: "nexagent/abc", requestId: "req-same-1" };
    const [first, second] = await Promise.all([f.call("cli-agents/start", body), f.call("cli-agents/start", body)]);
    expect(first).toMatchObject({ status: 200, data: { key: keyOf(device, "sess-1", "agy"), cwd: "C:/wt/nexagent-abc" } });
    expect(second).toEqual(first);
    const third = await f.call("cli-agents/start", body);
    expect(third).toEqual(first);
    expect(device.ops("start")).toHaveLength(1);
    const conflict = await f.call("cli-agents/start", { ...body, worktreeBranch: "nexagent/other" });
    expect(conflict.status).toBe(409);
  });

  it("lists Git branches, forwards in-place branch and worktreeBaseBranch, and enforces gitBranch capability", async () => {
    const f = await fixture();
    const device = await connectDevice(f, "git-branch", { cap: { ...FULL, features: [...FULL.features, "dirs", "gitBranch"] } });
    const old = await connectDevice(f, "git-branch-old", { cap: { ...FULL, features: [...FULL.features, "dirs"] } });
    device.onOp = (message) => {
      if (message.op === "branches") return { ok: true, result: { git: true, current: "main", dirty: true, branches: ["main", "dev", "bad name"] } };
      if (message.op === "start") return { ok: true, result: { ref: "claude:new-br", terminal: "t" } };
      return defaultOp(message);
    };

    const listed = await f.call(`cli-agents/branches?deviceId=${device.id}&cwd=${encodeURIComponent("C:\\proj")}`);
    expect(listed).toEqual({ status: 200, data: { git: true, current: "main", dirty: true, branches: ["main", "dev"] } });
    expect(device.ops("branches").at(-1)!.args).toEqual({ cwd: "C:\\proj" });
    expect((await f.call(`cli-agents/branches?deviceId=${device.id}&cwd=relative`)).status).toBe(400);
    expect((await f.call(`cli-agents/branches?deviceId=${old.id}&cwd=${encodeURIComponent("C:\\proj")}`)).status).toBe(400);
    expect(old.ops("branches")).toHaveLength(0);

    // in-place branch switch
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", branch: "dev" })).status).toBe(200);
    expect(device.ops("start").at(-1)!.args).toEqual({ engine: "claude", cwd: "C:/proj", branch: "dev" });

    // worktree off an explicit base branch
    expect((await f.call("cli-agents/start", {
      deviceId: device.id, engine: "claude", cwd: "C:/proj",
      worktreeBranch: "nexagent/feat1", worktreeBaseBranch: "dev", requestId: "req-base-1",
    })).status).toBe(200);
    expect(device.ops("start").at(-1)!.args).toEqual({
      engine: "claude", cwd: "C:/proj",
      worktree: { branch: "nexagent/feat1", requestId: "req-base-1", baseBranch: "dev" },
    });

    // invalid combinations and older executors without gitBranch
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", branch: "dev", createDir: true })).status).toBe(400);
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", branch: "dev", worktreeBranch: "nexagent/x", requestId: "req-bad-1" })).status).toBe(400);
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", worktreeBaseBranch: "dev" })).status).toBe(400);
    expect((await f.call("cli-agents/start", { deviceId: device.id, engine: "claude", cwd: "C:/proj", branch: "bad branch" })).status).toBe(400);
    expect((await f.call("cli-agents/start", { deviceId: old.id, engine: "claude", cwd: "C:/proj", branch: "dev" })).status).toBe(400);
    expect((await f.call("cli-agents/start", { deviceId: old.id, engine: "claude", cwd: "C:/proj", worktreeBranch: "nexagent/x", worktreeBaseBranch: "dev", requestId: "req-old-1" })).status).toBe(400);
    expect(old.ops("start")).toHaveLength(0);
  });
});
