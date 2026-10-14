import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { memoryEndpoint, HindsightClient } from "./hindsight.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-plugin-fixture-")), key = randomBytes(32), token = "synthetic-core-owner";
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  let app = await createPersonalApp({ dir, key, token, identity: false });
  cleanups.push(async () => { await app.close(); });
  return { get app() { return app; }, async restart() { await app.close(); app = await createPersonalApp({ dir, key, token, identity: false }); },
    async call(route: string, data?: unknown, auth = token) {
      const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }) });
      return { status: response.status, value: await response.json() as Record<string, unknown> };
    } };
}
async function engine() {
  const banks = new Map<string, Map<string, string>>(), operations = new Set<string>();
  let requests = 0;
  const server = createServer((request, response) => { void (async () => {
    requests++;
    const send = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== "Bearer synthetic-plugin-secret") { send(401, { error: "secret-must-not-appear" }); return; }
    const url = new URL(request.url!, "http://fixture"), parts = url.pathname.split("/"), bank = parts[4];
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (url.pathname === "/v1/default/banks") { send(200, { banks: [...banks.keys()].map((bank_id) => ({ bank_id })) }); return; }
    if (parts.length === 5) {
      if (request.method === "PUT") { if (!banks.has(bank)) banks.set(bank, new Map()); }
      else if (!banks.has(bank)) { send(404, {}); return; }
      if (request.method === "DELETE") banks.delete(bank);
      send(200, { bank_id: bank }); return;
    }
    if (parts[5] === "operations") { send(200, parts[6] ? { status: operations.has(parts[6]) ? "completed" : "not_found" } : { operations: [], total: 0 }); return; }
    if (parts[5] === "memories" && parts[6] === "recall") { send(200, { results: [...(banks.get(bank) ?? [])].map(([document_id, text]) => ({ id: document_id, document_id, text, type: "world" })) }); return; }
    if (parts[5] === "memories") { operations.add(data.operation_id); for (const item of data.items) banks.get(bank)!.set(item.document_id, item.content); send(200, { operation_id: data.operation_id }); return; }
    send(404, {});
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, banks, get requests() { return requests; } };
}
async function connected(f: Awaited<ReturnType<typeof fixture>>) {
  const end = Date.now() + 5000;
  while (f.app.memoryPlugin.state !== "ready") { if (Date.now() > end) throw new Error("External plugin fixture did not connect"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

it("ships with memory disabled, validates a plugin without activating it, and keeps credentials out of state", async () => {
  const e = await engine(), f = await fixture();
  expect("memoryService" in f.app).toBe(false);
  expect(f.app.runtime.memory.ledger.client).toBeUndefined();
  const settings = { provider: "hindsight", enabled: true, endpoint: e.endpoint, token: "synthetic-plugin-secret" };
  expect((await f.call("plugins/memory/test", settings)).value).toEqual({ ok: true, provider: "hindsight" });
  expect(f.app.runtime.memory.ledger.client).toBeUndefined(); expect(e.banks.size).toBe(0);
  expect((await f.call("plugins/memory", settings)).value.restartRequired).toBe(true);
  const state = (await f.call("state")).value;
  expect((state.memoryPlugin as { hasToken: boolean }).hasToken).toBe(true); expect(JSON.stringify(state)).not.toContain(settings.token);
  expect(f.app.store.get("SELECT ciphertext FROM secrets WHERE id='memory-plugin-settings'")?.ciphertext).not.toContain(settings.token);
  expect((await f.call("plugins/memory", { ...settings, token: "" })).status).toBe(200);
  await f.restart(); await connected(f);
  expect(f.app.memoryPlugin.status().restartRequired).toBe(false); expect("memoryService" in f.app).toBe(false);
});

it("retains and recalls through an external service, isolates banks, and disabling preserves local data", async () => {
  const e = await engine(), f = await fixture();
  const settings = { provider: "hindsight", enabled: true, endpoint: e.endpoint, token: "synthetic-plugin-secret" };
  await f.call("plugins/memory", settings); await f.restart(); await connected(f);
  const bot = f.app.store.createBot("合成联系人"), peer = f.app.store.createBot("隔离同伴");
  const note = f.app.runtime.memory.write(bot, { title: "合成外部记忆", content: "合成外部记忆每周二开会" });
  for (let i = 0; i < 4; i++) await f.app.runtime.memory.ledger.flush();
  expect((await f.app.runtime.memory.recall(bot, "开会")).facts.some((fact) => fact.text.includes("每周二"))).toBe(true);
  expect((await f.app.runtime.memory.recall(peer, "开会")).facts).toEqual([]);
  await f.call("plugins/memory", { ...settings, enabled: false, token: "" });
  await f.restart();
  expect(f.app.runtime.memory.ledger.client).toBeUndefined(); expect(f.app.memoryPlugin.status().status).toBe("disabled");
  expect(f.app.store.get("SELECT status FROM memory_documents WHERE id=?", note.documentId)?.status).toBe("active");
  expect(e.banks.size).toBeGreaterThan(0);
});

it("requires the main-device owner, rejects unknown adapters and never reuses a key for a new origin", async () => {
  const e = await engine(), f = await fixture();
  const settings = { provider: "hindsight", enabled: true, endpoint: e.endpoint, token: "synthetic-plugin-secret" };
  for (const route of ["plugins/memory", "plugins/memory/test"]) expect((await f.call(route, settings, "wrong-owner-token")).status).toBe(401);
  expect((await f.call("plugins/memory", { ...settings, provider: "file:///tmp/plugin.js" })).status).toBe(400);
  await f.call("plugins/memory", settings);
  expect((await f.call("plugins/memory/test", { ...settings, endpoint: "https://memory.example.com", token: "" })).status).toBe(400);
  const rejected = await f.call("plugins/memory/test", { ...settings, token: "wrong-secret" });
  expect(rejected.status).toBe(400); expect(JSON.stringify(rejected.value)).not.toContain("secret-must-not-appear");
});

it("refuses to silently replace a populated backend with an empty service", async () => {
  const e = await engine(), other = await engine(), f = await fixture();
  const settings = { provider: "hindsight", enabled: true, endpoint: e.endpoint, token: "synthetic-plugin-secret" };
  await f.call("plugins/memory", settings); await f.restart(); await connected(f);
  const bot = f.app.store.createBot("有记忆的联系人"); f.app.runtime.memory.write(bot, { title: "来源", content: "合成迁移来源" });
  for (let i = 0; i < 4; i++) await f.app.runtime.memory.ledger.flush();
  const rejected = await f.call("plugins/memory", { ...settings, endpoint: other.endpoint });
  expect(rejected.status).toBe(400); expect(rejected.value.error).toContain("迁移");
  expect(f.app.memoryPlugin.status().endpoint).toBe(e.endpoint);
  for (const [id, data] of e.banks) other.banks.set(id, new Map(data));
  expect((await f.call("plugins/memory", { ...settings, endpoint: other.endpoint })).status).toBe(200);
  await f.restart(); await connected(f);
  expect((await f.app.runtime.memory.recall(bot, "迁移")).facts).toHaveLength(1);
});

it("keeps Core and local sources usable when an enabled service rejects authentication", async () => {
  const e = await engine(), f = await fixture();
  await f.call("plugins/memory", { provider: "hindsight", enabled: true, endpoint: e.endpoint, token: "invalid-token" });
  await f.restart();
  const deadline = Date.now() + 5000;
  while (f.app.memoryPlugin.state !== "unavailable") { if (Date.now() > deadline) throw new Error("Expected unavailable service state"); await new Promise((resolve) => setTimeout(resolve, 10)); }
  expect((await f.call("state")).status).toBe(200);
  expect(f.app.runtime.memory.ledger.client).toBeUndefined();
  const bot = f.app.store.createBot("离线联系人");
  const note = f.app.runtime.memory.write(bot, { title: "离线来源", content: "服务恢复后再同步的合成记录" });
  expect(f.app.store.get("SELECT status FROM memory_documents WHERE id=?", note.documentId)?.status).toBe("active");
  expect(f.app.runtime.memory.ledger.status().pending).toBeGreaterThan(0);
  expect(e.banks.size).toBe(0);
});

it("accepts external HTTPS/private addresses and rejects credential-bearing, public HTTP and redirect-style URLs", () => {
  for (const address of ["https://memory.example.com", "http://192.168.1.22:8888", "http://localhost:8888", "http://127.0.0.1:8888"]) expect(memoryEndpoint(address + "/")).toBe(address);
  for (const address of ["http://public.example.com", "http://169.254.169.254", "http://10.example.com", "https://user:password@example.com", "file:///tmp/memory", "https://example.com/path", "https://example.com?key=secret"]) expect(() => memoryEndpoint(address)).toThrow();
});

it("aborts only the stopped task's in-flight external request", async () => {
  const sockets = new Set<import("node:net").Socket>();
  let received!: () => void;
  const waiting = new Promise<void>((resolve) => { received = resolve; });
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); received(); });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const client = new HindsightClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "synthetic");
  const pending = client.reflect("bank", "synthetic", "stopped-task");
  const rejected = expect(pending).rejects.toThrow();
  await waiting; client.cancelTask("unrelated-task"); client.cancelTask("stopped-task");
  await rejected;
});

it("does not commit plugin settings when owner authorization is revoked before commit", async () => {
  const f = await fixture(), e = await engine();
  await expect(f.app.memoryPlugin.save({ provider: "hindsight", enabled: true, endpoint: e.endpoint, token: "synthetic-plugin-secret" }, async () => { throw new Error("owner-session-revoked"); })).rejects.toThrow("owner-session-revoked");
  expect(f.app.store.get("SELECT ciphertext FROM secrets WHERE id='memory-plugin-settings'")).toBeUndefined();
});
