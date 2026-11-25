// Agent mode pending requests (design section 8): a device reports a
// permission or question, browsers see it, an answer goes back through Core and
// is audited without its text. Disposable Core in a temp directory and a
// simulated device; no real account, device or CLI is involved.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp } from "../index.ts";
import type { ServerMessage } from "../../../shared/cli-agents.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const OWNER = "synthetic-cli-requests-owner";
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

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-cli-req-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-cli-req-")) throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: OWNER, identity: false, memoryRuntime: false, hostDevice: false, cliAgents: { graceMs: 0 } });
  cleanups.push(() => app.close());
  const call = async (route: string, data?: unknown, method = data ? "POST" : "GET") => {
    const response = await fetch(app.origin + "/api/" + route, { method, headers: { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  return { app, call };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const wire = (nativeId: string, extra: Record<string, unknown> = {}) => ({
  engine: "claude", nativeId, configDir: "C:/cfg", cwd: "C:/proj", title: "title " + nativeId, state: "idle", lastActivityAt: 1000, ...extra,
});

interface Device {
  id: string;
  msgs: Array<Record<string, any>>;
  onOp: (message: Record<string, any>) => Record<string, any> | undefined;
  send(message: unknown): void;
  sessions(upserts: unknown[], extra?: { full?: boolean; removes?: string[] }): void;
  ops(op?: string): Array<Record<string, any>>;
  kill(): void;
}
let seq = 0;

async function connectDevice(f: Fixture, name: string): Promise<Device> {
  const pair = (await f.call("devices", { name })).data as { deviceId: string; token: string };
  const ws = new WebSocket(f.app.origin.replace("http:", "ws:") + "/dcp/v1/connect", { headers: { Authorization: "Bearer " + pair.token } });
  cleanups.push(() => { ws.terminate(); });
  const device: Device = {
    id: String(pair.deviceId), msgs: [],
    onOp: () => ({ ok: true, result: {} }),
    send: (message) => ws.send(JSON.stringify(message)),
    sessions: (upserts, extra = {}) => device.send({ type: "cli.sessions", full: extra.full ?? false, upserts, removes: extra.removes ?? [], seq: ++seq }),
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

const keyOf = (device: Device, nativeId: string) => `${device.id}:claude:${nativeId}`;
const permission = (id: string, nativeId = "s1", extra: Record<string, unknown> = {}) => ({
  type: "cli.request", ref: "claude:" + nativeId, id, kind: "permission", tool: "Bash", summary: "run the secret build script", expiresAt: Date.now() + 60_000, ...extra,
});
const question = (id: string, nativeId = "s1") => ({
  type: "cli.request", ref: "claude:" + nativeId, id, kind: "question", tool: "AskUserQuestion", summary: "which color",
  questions: [{ question: "Which color?", options: [{ label: "red" }, { label: "blue" }] }], expiresAt: Date.now() + 60_000,
});

async function ready() {
  const f = await fixture();
  const device = await connectDevice(f, "requests-device");
  device.sessions([wire("s1")], { full: true });
  await until(() => f.app.cliHub.session(keyOf(device, "s1")), "session");
  const heard: ServerMessage[] = [];
  const off = f.app.cliHub.onRequests((message) => heard.push(message));
  cleanups.push(off);
  return { f, device, heard, key: keyOf(device, "s1") };
}

describe("pending requests", () => {
  it("stores a request, pushes it to list and session subscribers and lists it over HTTP", async () => {
    const { f, device, heard, key } = await ready();
    const session: ServerMessage[] = [];
    cleanups.push(f.app.cliHub.subscribe(key, (message) => session.push(message)));
    device.send(permission("r1", "s1", { options: ["allow", "deny"] }));
    await until(() => f.app.cliHub.requests(key).length === 1, "request stored");
    const pushed = heard.find((m) => m.type === "requests") as Extract<ServerMessage, { type: "requests" }>;
    expect(pushed.key).toBe(key);
    expect(pushed.requests[0]).toMatchObject({ id: "r1", key, kind: "permission", tool: "Bash", summary: "run the secret build script", options: ["allow", "deny"] });
    expect(session.some((m) => m.type === "requests" && m.requests.length === 1)).toBe(true);

    const list = await f.call("cli-agents");
    expect(list.data.requests).toHaveLength(1);
    expect((await f.call("cli-agents/requests?key=" + encodeURIComponent(key))).data.requests).toHaveLength(1);
    expect((await f.call("cli-agents/requests?key=" + encodeURIComponent(keyOf(device, "other")))).data.requests).toHaveLength(0);
    expect((await f.call("cli-agents/requests?key=bad")).status).toBe(400);
    // the request text is encrypted at rest
    expect(JSON.stringify(f.app.store.all("SELECT * FROM cli_agent_requests"))).not.toContain("secret build script");
  });

  it("counts a session with a pending request as waiting, and stops when it closes", async () => {
    const { f, device, key } = await ready();
    expect(f.app.cliHub.summary()).toEqual({ waiting: 0, running: 0 });
    device.send(permission("r1"));
    await until(() => f.app.cliHub.summary().waiting === 1, "waiting");
    device.send({ type: "cli.request.resolved", id: "r1", by: "terminal" });
    await until(() => f.app.cliHub.summary().waiting === 0, "no longer waiting");
    expect(f.app.cliHub.requests(key)).toHaveLength(0);
  });

  it("tells subscribers who closed a request", async () => {
    const { f, device, heard } = await ready();
    for (const by of ["terminal", "timeout", "gone"] as const) {
      device.send(permission("r-" + by));
      await until(() => f.app.cliHub.requests().some((r) => r.id === "r-" + by), "stored " + by);
      device.send({ type: "cli.request.resolved", id: "r-" + by, by });
      await until(() => heard.some((m) => m.type === "request.resolved" && m.id === "r-" + by && m.by === by), "resolved " + by);
    }
    expect(f.app.cliHub.requests()).toHaveLength(0);
  });

  it("ignores a repeat, a request id owned by another session, and a request that is already expired", async () => {
    const { f, device, key } = await ready();
    device.sessions([wire("s2")]);
    await until(() => f.app.cliHub.session(keyOf(device, "s2")), "second session");
    device.send(permission("r1"));
    device.send(permission("r1"));
    device.send(permission("r1", "s2"));
    device.send(permission("old", "s1", { expiresAt: Date.now() - 1000 }));
    device.send(permission("r2"));
    await until(() => f.app.cliHub.requests(key).length === 2, "two requests");
    expect(f.app.cliHub.requests(key).map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(f.app.cliHub.requests(keyOf(device, "s2"))).toHaveLength(0);
  });

  it("closes requests past their expiry as timeout", async () => {
    const { f, device, heard, key } = await ready();
    device.send(permission("r1", "s1", { expiresAt: Date.now() + 10_000 }));
    await until(() => f.app.cliHub.requests(key).length === 1, "stored");
    expect(f.app.cliHub.expireRequests(Date.now())).toBe(0);
    expect(f.app.cliHub.expireRequests(Date.now() + 20_000)).toBe(1);
    expect(heard.some((m) => m.type === "request.resolved" && m.id === "r1" && m.by === "timeout")).toBe(true);
    expect(f.app.cliHub.requests(key)).toHaveLength(0);
    expect((await f.call("cli-agents/answer", { id: "r1", decision: "allow" })).status).toBe(404);
  });

  it("closes requests as gone when the session disappears", async () => {
    const { f, device, heard, key } = await ready();
    device.send(permission("r1"));
    await until(() => f.app.cliHub.requests(key).length === 1, "stored");
    device.sessions([], { removes: ["claude:s1"] });
    await until(() => heard.some((m) => m.type === "request.resolved" && m.id === "r1" && m.by === "gone"), "gone");
    expect(f.app.cliHub.requests()).toHaveLength(0);
  });
});

describe("answering", () => {
  it("sends the decision to the device, audits it without the answer text and closes the request", async () => {
    const { f, device, heard, key } = await ready();
    device.send(question("q1"));
    await until(() => f.app.cliHub.requests(key).length === 1, "stored");
    const answered = await f.call("cli-agents/answer", { id: "q1", decision: "allow", answers: { "Which color?": "periwinkle-private" }, message: "private note" });
    expect(answered.status).toBe(200);
    expect(answered.data.outcome).toBe("ok");
    const op = device.ops("answer")[0];
    expect(op.args).toMatchObject({ id: "q1", decision: "allow", answers: { "Which color?": "periwinkle-private" }, message: "private note" });
    expect(heard.some((m) => m.type === "request.resolved" && m.id === "q1" && m.by === "nexbot")).toBe(true);
    expect(f.app.cliHub.requests(key)).toHaveLength(0);
    expect(f.app.store.get("SELECT COUNT(*) n FROM audit_records WHERE action='cli.answer'")?.n).toBe(1);
    for (const table of ["audit_records", "cli_agent_ops"]) {
      const dump = JSON.stringify(f.app.store.all(`SELECT * FROM ${table}`));
      expect(dump).not.toContain("periwinkle-private");
      expect(dump).not.toContain("private note");
    }
    // answered once: a second answer finds nothing to answer
    expect((await f.call("cli-agents/answer", { id: "q1", decision: "allow", answers: { "Which color?": "red" } })).status).toBe(404);
    expect(device.ops("answer")).toHaveLength(1);
  });

  it("denies a permission with an optional message", async () => {
    const { f, device, key } = await ready();
    device.send(permission("r1"));
    await until(() => f.app.cliHub.requests(key).length === 1, "stored");
    expect((await f.call("cli-agents/answer", { id: "r1", decision: "deny", message: "not now" })).status).toBe(200);
    expect(device.ops("answer")[0].args).toMatchObject({ id: "r1", decision: "deny", message: "not now" });
  });

  it("shows the full arguments and relays always only for a request that offered it", async () => {
    const { f, device, key, heard } = await ready();
    device.send(permission("r1", "s1", { detail: "{\n  \"command\": \"secret build\"\n}", always: true }));
    device.send(permission("r2"));
    await until(() => f.app.cliHub.requests(key).length === 2, "stored");
    const [first, second] = f.app.cliHub.requests(key);
    expect(first).toMatchObject({ id: "r1", detail: "{\n  \"command\": \"secret build\"\n}", always: true });
    expect(second.always).toBeUndefined();
    expect(second.detail).toBeUndefined();
    const pushed = heard.filter((m) => m.type === "requests").at(-1) as Extract<ServerMessage, { type: "requests" }>;
    expect(pushed.requests[0]).toMatchObject({ detail: first.detail, always: true });
    // the detail is encrypted at rest like the summary
    expect(JSON.stringify(f.app.store.all("SELECT * FROM cli_agent_requests"))).not.toContain("secret build");

    expect((await f.call("cli-agents/answer", { id: "r1", decision: "allow", always: true })).status).toBe(200);
    expect(device.ops("answer")[0].args).toEqual({ id: "r1", decision: "allow", always: true });
    // a request that did not offer it gets a plain allow
    expect((await f.call("cli-agents/answer", { id: "r2", decision: "allow", always: true })).status).toBe(200);
    expect(device.ops("answer")[1].args).toEqual({ id: "r2", decision: "allow" });
    expect((await f.call("cli-agents/answer", { id: "r2", decision: "allow", always: "yes" })).status).toBe(400);
  });

  it("rejects malformed answers before anything reaches the device", async () => {
    const { f, device, key } = await ready();
    device.send(question("q1"));
    await until(() => f.app.cliHub.requests(key).length === 1, "stored");
    const bad: unknown[] = [
      { id: "q1" }, { id: "q1", decision: "maybe" }, { id: 7, decision: "allow" }, { id: "", decision: "allow" },
      { id: "q1", decision: "allow", answers: "red" }, { id: "q1", decision: "allow", answers: { "Which color?": 3 } },
      { id: "q1", decision: "allow", message: "x".repeat(2001) }, { id: "q1", decision: "allow", answers: { "Which color?": "x".repeat(4097) } },
      // a question is answered with its own question text; an empty or foreign answer is not accepted
      { id: "q1", decision: "allow" }, { id: "q1", decision: "allow", answers: {} }, { id: "q1", decision: "allow", answers: { Other: "red" } },
    ];
    for (const body of bad) expect((await f.call("cli-agents/answer", body)).status, JSON.stringify(body)).toBe(400);
    expect((await f.call("cli-agents/answer", { id: "nope", decision: "allow" })).status).toBe(404);
    expect(device.ops("answer")).toHaveLength(0);
    expect(f.app.cliHub.requests(key)).toHaveLength(1);
  });

  it("gives the request back when the device definitely refused, and closes it when the outcome is unknown", async () => {
    const { f, device, key } = await ready();
    device.send(permission("r1"));
    device.send(permission("r2"));
    await until(() => f.app.cliHub.requests(key).length === 2, "stored");
    device.onOp = () => ({ ok: false, error: { code: "not_found", message: "gone" } });
    expect((await f.call("cli-agents/answer", { id: "r1", decision: "allow" })).status).toBe(404);
    // still pending, so it can be answered again
    expect(f.app.cliHub.requests(key).map((r) => r.id)).toEqual(["r1", "r2"]);
    device.onOp = () => ({ ok: true, result: {} });
    expect((await f.call("cli-agents/answer", { id: "r1", decision: "allow" })).status).toBe(200);
    // the device dropped before answering: the outcome is unknown and the request stays closed
    device.onOp = () => { device.kill(); return undefined; };
    const unknown = await f.call("cli-agents/answer", { id: "r2", decision: "allow" });
    expect(unknown.status).toBe(409);
    expect(f.app.cliHub.requests(key).map((r) => r.id)).not.toContain("r2");
  });

  it("needs a signed in caller", async () => {
    const { f } = await ready();
    const anon = await fetch(f.app.origin + "/api/cli-agents/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "x", decision: "allow" }) });
    expect(anon.status).toBe(401);
  });
});
