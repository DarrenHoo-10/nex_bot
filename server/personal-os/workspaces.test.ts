import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { createWorkspaceService } from "./workspaces.ts";
import { startFakeIdentity } from "./testing/fake-identity.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

const cleanup: Array<() => Promise<void>> = [];
interface FixtureBody {
  token: string; sessionId: string; coreId: string; id: string; taskId: string;
  deviceId: string; documentId: string; version: number; authenticated: boolean;
  bots: Array<{ id: string; name: string }>; connectors: unknown[];
  node: { connected: boolean }; onlineDevices: string[];
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-accounts-fixture-"));
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const provider = await startFakeIdentity(), model = await startFakeModel();
  cleanup.push(() => provider.close(), () => model.close());
  const options = { dir: root, key: randomBytes(32), token: "synthetic-bootstrap", identity: { fixtureOrigin: provider.origin } };
  const legacy = await createPersonalApp(options);
  const operator = legacy.store.get("SELECT * FROM user_sessions WHERE id=?", legacy.store.session)!;
  const challenge = legacy.identity!.start({ account: "owner@example.test", name: "Original owner" }, operator);
  const owner = await legacy.identity!.respond({ ...challenge, password: " synthetic password " }, operator);
  legacy.store.createBot("Original private agent");
  await legacy.close();
  let app = await createWorkspaceService(options);
  cleanup.push(() => app.close());
  async function api(route: string, token = "", data?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() as FixtureBody };
  }
  async function login(account = "other@example.test", password = " synthetic password ") {
    const start = await api("auth/start", "", { account, name: "Separate client" });
    expect(start.status).toBe(200);
    return api("auth/respond", "", { ...start.data, password });
  }
  return { get app() { return app; }, root, options, owner, provider, model, api, login,
    async restart() { await app.close(); app = await createWorkspaceService(options); } };
}

it("preserves the original owner, provisions only after verification, and keeps the existing client protocol", async () => {
  const f = await fixture();
  expect((await f.api("state", f.owner.token)).data.bots[0].name).toBe("Original private agent");
  expect((await f.login(undefined, "wrong")).status).toBe(401);
  expect(f.app.workspaces.size).toBe(0);
  const [a, b] = await Promise.all([f.login(), f.login()]);
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  expect(f.app.workspaces.size).toBe(1);
  expect(a.data.coreId).toBe(f.owner.coreId);
  expect((await f.api("session", "", { token: a.data.token })).data).toMatchObject({ authenticated: true, coreId: f.owner.coreId });
  expect((await f.api("state", a.data.token)).data.bots).toEqual([]);
  const child = [...f.app.workspaces.values()][0];
  expect(child.store.key.equals(f.options.key)).toBe(false);
  expect(child.server.listening).toBe(false);
  expect(child.store.get("SELECT core_id FROM workspaces")!.core_id).not.toBe(f.owner.coreId);
  expect(f.app.store.get("SELECT subject FROM external_identities")!.subject).toBe("synthetic-owner-uid");
  expect(child.store.get("SELECT subject FROM external_identities")!.subject).toBe("synthetic-other-uid");
  expect((await f.api("state", a.data.token)).data.node.connected).toBe(false);
  expect((await f.api("node", a.data.token, { root: os.tmpdir(), exec: true })).status).toBe(403);
  expect((await f.api("node", f.owner.token, { root: os.tmpdir(), exec: true })).status).toBe(403);
  await f.restart();
  expect((await f.api("state", a.data.token)).status).toBe(200);
  expect((await f.api("state", f.owner.token)).data.bots[0].name).toBe("Original private agent");
  expect((await f.api("auth/status", a.data.token)).data.authenticated).toBe(true);
  expect((await f.api("auth/status", "forged")).data.authenticated).toBe(false);
  for (const session of f.provider.sessions.values()) if (session.subject === "synthetic-other-uid") session.active = false;
  await f.restart();
  expect((await f.api("state", a.data.token)).status).toBe(401);
  expect((await f.api("state", f.owner.token)).status).toBe(200);
});

it("isolates actual model messages, memory, connectors and adversarial foreign object IDs", async () => {
  const f = await fixture(), other = (await f.login()).data;
  const original = (await f.api("state", f.owner.token)).data.bots[0];
  const bot = (await f.api("bots", other.token, { name: "Other private agent" })).data;
  expect((await f.api("config", other.token, { provider: "openai", endpoint: f.model.origin + "/v1", model: "fixture", apiKey: "other-private-key" })).status).toBe(200);
  expect(f.app.store.get("SELECT id FROM model_connections")).toBeUndefined();
  const note = (await f.api("memory", other.token, { botId: bot.id, title: "Other note", content: "other-private-content", scope: "bot" })).data;
  expect((await f.api("memory/delete", f.owner.token, { id: note.documentId, version: note.version })).status).toBe(400);
  const connector = (await f.api("connectors/save", other.token, { name: "Other MCP", url: "https://example.test/mcp", transport: "http", token: "other-private-mcp" })).data;
  expect((await f.api("state", f.owner.token)).data.connectors).toEqual([]);
  expect((await f.api("connectors/delete", f.owner.token, { id: connector.id, version: connector.version })).status).toBe(400);
  expect((await f.api("agents/input", other.token, { botId: original.id, text: "attack", clientId: "foreign-input" })).status).toBe(400);
  expect((await f.api("agents/input", f.owner.token, { botId: bot.id, text: "attack", clientId: "foreign-input" })).status).toBe(400);
  f.model.scripts.push({ kind: "openai-text", text: "other-private-reply" });
  const sent = await f.api("agents/input", other.token, { botId: bot.id, text: "other-private-message", clientId: "own-input" });
  expect(sent.status).toBe(202);
  const tenant = [...f.app.workspaces.values()][0];
  await expect.poll(() => tenant.store.get("SELECT status FROM tasks WHERE id=?", sent.data.taskId)?.status, { timeout: 20_000 }).toBe("succeeded");
  expect(JSON.stringify((await f.api("agents/messages?bot=" + bot.id, other.token)).data)).toContain("other-private-reply");
  expect(JSON.stringify((await f.api("agents/messages?bot=" + bot.id, f.owner.token)).data)).not.toContain("other-private");
  expect((await f.api("state", other.token)).data.connectors).toHaveLength(1);
  expect(JSON.stringify((await f.api("state", other.token)).data)).not.toContain("other-private-mcp");
  expect(tenant.store.get("SELECT status FROM memory_documents WHERE id=?", note.documentId)?.status).toBe("active");
});

it("routes cookies and SSE to the correct workspace and does not accept cross-origin login", async () => {
  const f = await fixture(), other = (await f.login()).data;
  await f.api("bots", other.token, { name: "Other visible only here" });
  const response = await fetch(f.app.origin + "/api/state", { headers: { Cookie: "nex=" + other.token } });
  expect((await response.json() as FixtureBody).bots[0].name).toBe("Other visible only here");
  expect((await f.api("auth/start", "", { account: "other@example.test" }, { Origin: "https://attacker.test" })).status).toBe(403);
  expect((await f.api("session", "", { token: other.token }, { Origin: "https://attacker.test" })).status).toBe(403);
  const controller = new AbortController();
  const stream = await fetch(f.app.origin + "/api/events", { headers: { Cookie: "nex=" + other.token }, signal: controller.signal });
  const reader = stream.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain(String([...f.app.workspaces.values()][0].store.get("SELECT core_id FROM workspaces")!.core_id));
  expect(first).not.toContain(f.owner.coreId);
  controller.abort(); await reader.cancel().catch(() => {});
});

it("keeps device pairing and revocation inside the selected account", async () => {
  const f = await fixture(), other = (await f.login()).data;
  const pair = (await f.api("devices", other.token, { name: "Other private device" })).data;
  const ws = new WebSocket(f.app.origin.replace("http:", "ws:") + "/dcp/v1/connect", { headers: { Authorization: "Bearer " + pair.token } });
  cleanup.push(async () => { ws.terminate(); });
  const bound = new Promise<Record<string, unknown>>((resolve, reject) => { ws.on("message", (raw) => resolve(JSON.parse(String(raw)))); ws.on("error", reject); });
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", policyVersion: 1, read: false, exec: false, computer: false, identity: { hostname: "synthetic-node", supported: ["device.info"] } })));
  expect((await bound).deviceId).toBe(pair.deviceId);
  expect((await f.api("state", other.token)).data.onlineDevices).toContain(pair.deviceId);
  expect((await f.api("state", f.owner.token)).data.onlineDevices).not.toContain(pair.deviceId);
  await f.api("devices/revoke", f.owner.token, { id: pair.deviceId });
  expect((await f.api("state", other.token)).data.onlineDevices).toContain(pair.deviceId);
  expect((await f.api("clients/revoke", f.owner.token, { sessionId: other.sessionId })).status).toBe(404);
  await f.api("auth/logout", other.token, {});
  expect((await f.api("state", other.token)).status).toBe(401);
  expect((await f.api("state", f.owner.token)).status).toBe(200);
});
