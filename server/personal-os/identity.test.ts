import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { request as httpRequest, createServer } from "node:http";
import { HindsightClient } from "./hindsight.ts";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonalApp } from "./index.ts";
import { startFakeIdentity } from "./testing/fake-identity.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";
import { NEX_USER_ORIGIN } from "./identity-provider.ts";

const fixtures: Array<{ app: Awaited<ReturnType<typeof createPersonalApp>>; provider: Awaited<ReturnType<typeof startFakeIdentity>>; root: string; key: Buffer }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { await f.app.close(); await f.provider.close(); if (path.dirname(f.root) === os.tmpdir() && path.basename(f.root).startsWith("nex-login-fixture-")) rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-login-fixture-")), provider = await startFakeIdentity(), key = randomBytes(32);
  const app = await createPersonalApp({ dir: root, key, token: "synthetic-bootstrap", memoryRuntime: false, identity: { fixtureOrigin: provider.origin } });
  const f = { app, provider, root, key }; fixtures.push(f); return f;
}
async function request(app: Awaited<ReturnType<typeof createPersonalApp>>, route: string, data?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(app.origin + "/api/" + route, { headers: { ...headers, ...(data === undefined ? {} : { "Content-Type": "application/json" }) }, ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }) });
  const result = await response.json() as { token: string; sessionId: string; coreId: string; expiresAt: number; transactionId: string; bindingToken: string; stepId: string; taskId: string };
  return { status: response.status, body: result, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
}
async function bootstrap(app: Awaited<ReturnType<typeof createPersonalApp>>) { const result = await request(app, "session", { token: "synthetic-bootstrap" }); return { Cookie: result.cookie! }; }
async function login(app: Awaited<ReturnType<typeof createPersonalApp>>, headers: Record<string, string> = {}, account = "owner@example.test", password = " synthetic password ") {
  const start = await request(app, "auth/start", { account, name: "合成设备" }, headers);
  if (start.status !== 200) return start;
  return request(app, "auth/respond", { ...start.body, password }, headers);
}
function staleCache() { const real = performance.now(); vi.spyOn(performance, "now").mockReturnValue(real + 61_000); }

describe("mandatory built-in account login", () => {
  it("uses the production issuer by default and blocks bootstrap/invite tokens from business APIs", async () => {
    const f = await fixture();
    await f.app.close(); f.app = await createPersonalApp({ dir: path.join(f.root, "production"), key: f.key, token: "synthetic-bootstrap", memoryRuntime: false });
    expect((await request(f.app, "client/identity")).body).toMatchObject({ loginRequired: true, loginMethods: ["password"], provider: { baseUrl: NEX_USER_ORIGIN } });
    expect((await request(f.app, "state", undefined, { Authorization: "Bearer synthetic-bootstrap" })).status).toBe(401);
    expect((await request(f.app, "bots", { name: "禁止" }, await bootstrap(f.app))).status).toBe(401);
    expect((await request(f.app, "client/login", { code: "legacy", name: "old" })).status).toBe(410);
  });
  it("requires a private local bootstrap for first owner association, keeps existing data, then supports separate client sessions", async () => {
    const { app } = await fixture();
    const bot = app.store.createBot("现有联系人"), coreId = app.store.get("SELECT core_id FROM workspaces")!.core_id;
    expect((await login(app)).status).toBe(403);
    const owner = await login(app, await bootstrap(app)); expect(owner.status).toBe(200);
    const client = await login(app); expect(client.status).toBe(200); expect(client.body.sessionId).not.toBe(owner.body.sessionId);
    expect(app.store.get("SELECT id FROM bots WHERE id=?", bot)).toBeTruthy(); expect(owner.body.coreId).toBe(coreId);
    expect((await request(app, "state", undefined, { Authorization: `Bearer ${client.body.token}` })).status).toBe(200);
    expect(app.store.get("SELECT COUNT(*) n FROM external_identities")!.n).toBe(1);
    expect(app.store.get("SELECT protocol FROM user_sessions WHERE id=?", owner.body.sessionId)!.protocol).toBe("native-v1");
    expect(owner.body.expiresAt - Date.now()).toBeLessThanOrEqual(8 * 3_600_000);
  });
  it("binds identity by immutable subject and rejects another account without replacing the owner", async () => {
    const { app, provider } = await fixture(); await login(app, await bootstrap(app));
    const result = await login(app, {}, "other@example.test"); expect(result.status).toBe(403);
    expect(app.store.get("SELECT subject FROM external_identities")!.subject).toBe("synthetic-owner-uid");
    expect([...provider.sessions.values()].filter((s) => s.subject === "synthetic-other-uid" && s.active)).toHaveLength(0);
  });
  it("consumes failed attempts and forbids challenge replay or forged binding without calling upstream", async () => {
    const { app, provider } = await fixture(), headers = await bootstrap(app);
    const transaction = (await request(app, "auth/start", { account: "owner@example.test" }, headers)).body;
    expect((await request(app, "auth/respond", { ...transaction, bindingToken: "forged", password: "x" }, headers)).status).toBe(401);
    expect(provider.state.loginCount).toBe(0);
    expect((await request(app, "auth/respond", { ...transaction, password: "wrong" }, headers)).status).toBe(401);
    expect((await request(app, "auth/respond", { ...transaction, password: " synthetic password " }, headers)).status).toBe(401);
    expect(provider.state.loginCount).toBe(1);
  });
  it("caps local expiry by upstream expiry and encrypts upstream cookies; never persists passwords", async () => {
    const { app, provider, root } = await fixture(); provider.state.maxAge = 60;
    const owner = await login(app, await bootstrap(app)); expect(owner.status).toBe(200);
    expect(owner.body.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    const secret = app.store.get("SELECT ciphertext FROM secrets WHERE id=?", `identity-session:${owner.body.sessionId}`)!;
    const upstream = JSON.parse(app.store.decrypt(String(secret.ciphertext)));
    expect(String(secret.ciphertext)).not.toContain(upstream.cookie);
    for (const file of ["core.db", "core.db-wal"]) { try { const bytes = readFileSync(path.join(root, file)); expect(bytes.includes(Buffer.from(" synthetic password "))).toBe(false); expect(bytes.includes(Buffer.from(upstream.cookie))).toBe(false); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
    vi.spyOn(Date, "now").mockReturnValue(owner.body.expiresAt + 1);
    expect((await request(app, "state", undefined, { Authorization: `Bearer ${owner.body.token}` })).status).toBe(401);
  });
  it("revalidates after the 60-second bound and fails closed during upstream outage", async () => {
    const { app, provider } = await fixture(); const owner = await login(app, await bootstrap(app));
    provider.state.status = 503; staleCache();
    expect((await request(app, "state", undefined, { Authorization: `Bearer ${owner.body.token}` })).status).toBe(503);
    expect(app.store.get("SELECT revoked_at FROM user_sessions WHERE id=?", owner.body.sessionId)!.revoked_at).toBeNull();
    provider.state.status = 401;
    expect((await request(app, "state", undefined, { Authorization: `Bearer ${owner.body.token}` })).status).toBe(401);
    expect(app.store.get("SELECT revoked_at FROM user_sessions WHERE id=?", owner.body.sessionId)!.revoked_at).not.toBeNull();
  });
  it("locally revokes logout even if upstream is down, and leaves the other device logged in", async () => {
    const { app, provider } = await fixture(); const first = await login(app, await bootstrap(app)), second = await login(app);
    provider.state.logoutStatus = 503;
    expect((await request(app, "auth/logout", {}, { Authorization: `Bearer ${first.body.token}` })).status).toBe(200);
    expect((await request(app, "state", undefined, { Authorization: `Bearer ${first.body.token}` })).status).toBe(401);
    expect((await request(app, "state", undefined, { Authorization: `Bearer ${second.body.token}` })).status).toBe(200);
    expect(app.store.get("SELECT attempts FROM identity_revocations WHERE session_id=?", first.body.sessionId)!.attempts).toBe(1);
    provider.state.logoutStatus = 204; app.store.run("UPDATE identity_revocations SET next_attempt_at=0"); await app.identity!.retryRevocations();
    expect(app.store.get("SELECT session_id FROM identity_revocations WHERE session_id=?", first.body.sessionId)).toBeUndefined();
    expect(app.store.get("SELECT id FROM secrets WHERE id=?", `identity-session:${first.body.sessionId}`)).toBeUndefined();
  });
  it("rechecks a partially uploaded mutation after logout before writing any data", async () => {
    const { app } = await fixture(), owner = await login(app, await bootstrap(app));
    const body = JSON.stringify({ name: "禁止晚到写入" });
    let finish: (() => void) | undefined;
    const pending = new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(app.origin + "/api/bots", { method: "POST", headers: { Authorization: `Bearer ${owner.body.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
      req.once("error", reject); req.write(body.slice(0, 2)); finish = () => req.end(body.slice(2));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await request(app, "auth/logout", {}, { Authorization: `Bearer ${owner.body.token}` }); finish!();
    expect(await pending).toBe(401); expect(app.store.get("SELECT id FROM bots WHERE name='禁止晚到写入'")).toBeUndefined();
  });
  it("keeps old memory sources queued without login, then permits delivery after account authentication", async () => {
    const { app } = await fixture(); let requests = 0;
    const engine = createServer((_req, res) => { requests++; res.writeHead(503, { "Content-Type": "application/json" }); res.end('{}'); });
    await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
    try {
      const botId = app.store.createBot("历史记忆联系人");
      app.runtime.memory.write(botId, { title: "合成旧记忆", content: "合成用户喜欢中文交流" });
      app.runtime.memory.ledger.client = new HindsightClient(`http://127.0.0.1:${(engine.address() as { port: number }).port}`, "synthetic-hindsight");
      await app.runtime.memory.ledger.flush();
      expect(requests).toBe(0); expect(app.store.get("SELECT status FROM memory_transfers")!.status).toBe("queued");
      await login(app, await bootstrap(app)); await app.runtime.memory.ledger.flush();
      expect(requests).toBeGreaterThan(0);
      expect(app.store.get("SELECT status FROM memory_transfers")!.status).toBe("queued");
    } finally { app.runtime.memory.ledger.client = undefined; await new Promise<void>((resolve) => { engine.close(() => resolve()); engine.closeAllConnections(); }); }
  });
  it("requires fresh validation on Core restart and preserves the mapped owner and agents", async () => {
    const f = await fixture(); const loginResult = await login(f.app, await bootstrap(f.app)); const botId = f.app.store.createBot("已有 Agent");
    await f.app.close(); f.provider.state.status = 401;
    f.app = await createPersonalApp({ dir: f.root, key: f.key, token: "new-bootstrap", memoryRuntime: false, identity: { fixtureOrigin: f.provider.origin } });
    expect((await request(f.app, "state", undefined, { Authorization: `Bearer ${loginResult.body.token}` })).status).toBe(401);
    expect(f.app.store.get("SELECT name FROM bots WHERE id=?", botId)!.name).toBe("已有 Agent");
  });
  it("prevents cross-site login, expired challenges and legacy access to an initialized Core", async () => {
    const { app } = await fixture(), headers = await bootstrap(app);
    expect((await request(app, "auth/start", { account: "owner@example.test" }, { ...headers, Origin: "https://evil.example" })).status).toBe(403);
    const txn = (await request(app, "auth/start", { account: "owner@example.test" }, headers)).body;
    app.store.run("UPDATE login_transactions SET expires_at=created_at+1 WHERE id=?", txn.transactionId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await request(app, "auth/respond", { ...txn, password: " synthetic password " }, headers)).status).toBe(401);
    expect((await login(app, headers)).status).toBe(200);
    expect((await request(app, "clients/invite", { name: "old" }, { Authorization: "Bearer synthetic-bootstrap" })).status).toBe(401);
  });
  it("attributes real tasks to the signed-in client and cancels them on logout", async () => {
    const { app } = await fixture(); const fake = await startFakeModel();
    try {
      const result = await login(app, await bootstrap(app)); const botId = app.store.createBot("抽象联系人");
      app.store.saveConfig({ provider: "openai", endpoint: fake.origin + "/v1", model: "fake", apiKey: "synthetic-key" }); fake.scripts.push({ kind: "hang" });
      const task = await request(app, "agents/input", { botId, text: "合成挂起任务", clientId: "login-task" }, { Authorization: `Bearer ${result.body.token}` });
      expect(task.status).toBe(202); expect(app.store.get("SELECT authorized_session_id FROM tasks WHERE id=?", task.body.taskId)!.authorized_session_id).toBe(result.body.sessionId);
      const deadline = Date.now() + 25_000; while (!fake.requests.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fake.requests, JSON.stringify(app.store.all("SELECT status,result_summary FROM tasks"))).toHaveLength(1);
      await request(app, "auth/logout", {}, { Authorization: `Bearer ${result.body.token}` });
      expect(app.store.get("SELECT status FROM tasks WHERE id=?", task.body.taskId)!.status).toMatch(/cancelling|cancelled/);
    } finally { await fake.close(); }
  }, 30_000);
});
