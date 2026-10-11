import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { CoreStore, hash, id, type Row } from "./store.ts";
import { MemoryModule } from "./memory.ts";
import { HindsightClient } from "./hindsight.ts";
import { MemoryModelGateway } from "./memory-gateway.ts";
import { createPersonalApp } from "./index.ts";
import { pathToFileURL } from "node:url";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-memory-test-"));
  const store = new CoreStore(root, randomBytes(32), "synthetic-memory-token"), memory = new MemoryModule(store);
  cleanups.push(async () => { await memory.ledger.close(); store.close(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-memory-test-")) throw new Error("Unsafe cleanup"); rmSync(root, { recursive: true, force: true }); });
  const bot = store.createBot("任意名字"), peer = store.createBot("任意同伴");
  return { store, memory, bot, peer };
}
async function fakeEngine() {
  const operations = new Map<string, string>(), documents = new Map<string, Map<string, string>>();
  const recalls: string[] = [], submissions: string[] = [];
  let lostAcknowledgement = false;
  let recallWait: (() => Promise<void>) | undefined;
  let observations = false, incomplete = false;
  const server = createServer((req, res) => { void (async () => {
    const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== "Bearer synthetic-engine-token") { send(401, {}); return; }
    const url = new URL(req.url!, "http://fixture"), parts = url.pathname.split("/"), bank = parts[4];
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (parts.length === 5) { if (req.method === "DELETE") documents.delete(bank); else if (!documents.has(bank)) documents.set(bank, new Map()); send(200, {}); return; }
    if (parts[5] === "operations" && parts[6]) { const state = operations.get(parts[6]); send(200, { status: state ?? "not_found" }); return; }
    if (parts[5] === "operations") { send(200, { operations: [], total: 0 }); return; }
    if (parts[5] === "reflect") {
      if (recallWait) await recallWait();
      send(200, { text: "合成综合回答", based_on: { memories: [...(documents.get(bank)?.entries() ?? [])].map(([document_id, text]) => ({ id: document_id, document_id, text, type: "world" })) } }); return;
    }
    if (parts[5] === "memories" && parts[6] === "recall") {
      recalls.push(bank); if (recallWait) await recallWait();
      const facts = [...(documents.get(bank)?.entries() ?? [])].map(([document_id, text]) => ({ id: document_id, document_id, text, fact_type: "world" }));
      send(200, observations ? { results: [{ id: "observation", text: "综合合成观察", type: "observation", source_fact_ids: facts.map((fact) => fact.id) }], source_facts: Object.fromEntries(facts.slice(incomplete ? 1 : 0).map((fact) => [fact.id, fact])) } : { results: facts }); return;
    }
    if (parts[5] === "memories") {
      submissions.push(data.operation_id); operations.set(data.operation_id, "completed");
      for (const item of data.items) documents.get(bank)!.set(item.document_id, item.content);
      if (lostAcknowledgement) { lostAcknowledgement = false; req.socket.destroy(); return; }
      send(200, { operation_id: data.operation_id }); return;
    }
    send(404, {});
  })().catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  cleanups.push(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });
  return { client: new HindsightClient(`http://127.0.0.1:${address.port}`, "synthetic-engine-token"), operations, documents, recalls, submissions,
    loseNextAck: () => { lostAcknowledgement = true; }, blockRecall: (wait: () => Promise<void>) => { recallWait = wait; }, observation: (truncated = false) => { observations = true; incomplete = truncated; } };
}
async function drain(memory: MemoryModule) { for (let i = 0; i < 10; i++) await memory.ledger.flush(); }
it("returns every original citation for a native observation and withholds incomplete provenance", async () => {
  const f = fixture(), engine = await fakeEngine(); f.memory.ledger.client = engine.client;
  f.memory.write(f.bot, { title: "来源一", content: "合成项目星期二开会" });
  f.memory.write(f.bot, { title: "来源二", content: "合成项目重视准时" });
  f.memory.write(f.peer, { title: "同伴秘密", content: "不可见同伴来源" });
  await drain(f.memory); engine.observation();
  const result = await f.memory.recall(f.bot, "项目");
  expect(result.facts).toHaveLength(1); expect(result.facts[0].sourceClass).toBe("synthesized");
  expect(result.facts[0].refs).toHaveLength(2);
  expect(result.facts[0].refs.map((ref) => f.memory.expand(f.bot, ref).content)).toEqual(expect.arrayContaining(["合成项目星期二开会", "合成项目重视准时"]));
  engine.observation(true); expect((await f.memory.recall(f.bot, "项目")).facts).toEqual([]);
});
it.each(["recall", "reflect"] as const)("fences the entire %s snapshot when the first bank changes while the second is awaiting", async (method) => {
  const f = fixture(), engine = await fakeEngine(); f.memory.ledger.client = engine.client;
  const doc = f.memory.write(f.bot, { title: "私有", content: "不再可读的原文" });
  f.memory.write(f.bot, { title: "共享", content: "另一个来源", scope: "workspace" }); await drain(f.memory);
  let release!: () => void, started!: () => void, requests = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { started = resolve; });
  engine.blockRecall(async () => { if (++requests === 2) { started(); await gate; } });
  const inflight = f.memory[method](f.bot, "来源");
  const rejected = method === "reflect" ? expect(inflight).rejects.toThrow("记忆或权限已变化") : undefined;
  await ready; f.memory.remove(String(doc.documentId), Number(doc.version)); release();
  if (rejected) await rejected;
  else expect((await inflight as Awaited<ReturnType<MemoryModule["recall"]>>).facts).toEqual([]);
  expect(f.store.all("SELECT * FROM memory_syntheses")).toHaveLength(0);
});
it.skipIf(!process.env.NEX_TEST_LEGACY_BUNDLE)("migrates a genuine 0.3.3 fixture without changing existing Agents, note IDs/versions or vault secrets", async () => {
  const f = fixture(), root = path.join(f.store.dir, "legacy"), key = randomBytes(32), token = "synthetic-upgrade-token";
  const legacyCreate = (await import(pathToFileURL(path.resolve(process.env.NEX_TEST_LEGACY_BUNDLE!)).href)).createPersonalApp as typeof createPersonalApp;
  const legacy = await legacyCreate({ dir: root, key, token });
  legacy.store.saveConfig({ provider: "openai", endpoint: "http://127.0.0.1:1/v1", model: "unused-fixture", apiKey: "synthetic-upgrade-key" });
  const bots = legacy.store.all("SELECT id,name,instructions FROM bots ORDER BY id"), botId = String(bots[0].id);
  const doc = legacy.runtime.memory.write(botId, { title: "既有记忆", content: "旧发行版合成记录" });
  const vault = legacy.store.get("SELECT ciphertext FROM secrets WHERE id='model-key'")!.ciphertext;
  await legacy.close();
  const upgraded = await createPersonalApp({ dir: root, key, token, memoryRuntime: false }); cleanups.push(() => upgraded.close());
  expect(upgraded.store.all("SELECT id,name,instructions FROM bots ORDER BY id")).toEqual(bots);
  expect(upgraded.runtime.memory.read(botId, String(doc.documentId))).toMatchObject({ id: doc.documentId, version: doc.version, content: "旧发行版合成记录" });
  expect(upgraded.store.get("SELECT ciphertext FROM secrets WHERE id='model-key'")?.ciphertext).toBe(vault);
  expect(upgraded.store.all("SELECT * FROM memory_bank_bindings WHERE scope='bot'")).toHaveLength(bots.length);
  expect(upgraded.store.all("SELECT * FROM memory_source_registry")).toHaveLength(1);
  expect(upgraded.store.all("PRAGMA foreign_key_check")).toEqual([]);
});
it("purges private originals, explicit shared copies, derived sources and version history, preserving unrelated memory", async () => {
  const f = fixture(), engine = await fakeEngine(); f.memory.ledger.client = engine.client;
  const note = f.memory.write(f.bot, { title: "合成代号", content: "忘记测试代号雪鹭，周二开会" });
  const source = f.store.get("SELECT * FROM memory_source_registry WHERE original_id=?", note.documentId)!;
  const shared = f.memory.publish(f.bot, String(source.id), String(source.content_hash), "用户明确要求共享这条记忆");
  f.memory.write(f.peer, { title: "保留", content: "独立的同伴记忆" });
  await drain(f.memory);
  const result = await f.memory.reflect(f.bot, "会议");
  expect(result.answers.length).toBeGreaterThan(0);
  expect(() => f.memory.expand(f.peer, String(source.id))).toThrow();
  const plan = f.memory.privacy.preview(f.bot, { documentId: note.documentId });
  expect(plan.documents).toContain(shared.documentId);
  expect(() => f.memory.forget(f.bot, { documentId: note.documentId }, "stale")).toThrow("范围已变化");
  f.memory.forget(f.bot, { documentId: note.documentId }, plan.revision);
  expect(f.store.all("SELECT content,title FROM memory_document_versions WHERE document_id IN (?,?)", note.documentId, shared.documentId).every((row) => row.content === "" && row.title === "[已遗忘]")).toBe(true);
  expect(f.store.all("SELECT * FROM memory_syntheses")).toHaveLength(0);
  expect(() => f.memory.expand(f.bot, String(source.id))).toThrow();
  await drain(f.memory);
  expect((await f.memory.recall(f.bot, "雪鹭")).facts).toEqual([]);
  expect((await f.memory.recall(f.peer, "独立")).facts.map((fact) => fact.text)).toEqual(["独立的同伴记忆"]);
  expect(f.store.get("SELECT status FROM memory_forget_rules")?.status).toBe("completed");
  expect(f.store.all("PRAGMA foreign_key_check")).toEqual([]);
});
it("rejects a late synthesis after forgetting and blocks identical background recapture", async () => {
  const f = fixture(), engine = await fakeEngine(); f.memory.ledger.client = engine.client;
  const note = f.memory.write(f.bot, { title: "合成主题", content: "迟到的综合不可返回" }); await drain(f.memory);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { started = resolve; });
  engine.blockRecall(async () => { started(); await gate; });
  const inflight = f.memory.reflect(f.bot, "合成主题"); const rejected = expect(inflight).rejects.toThrow("记忆或权限已变化"); await ready;
  const plan = f.memory.privacy.preview(f.bot, { documentId: note.documentId }); f.memory.forget(f.bot, { documentId: note.documentId }, plan.revision);
  release(); await rejected;
  const bank = f.store.get("SELECT * FROM memory_bank_bindings WHERE bot_id=?", f.bot)!;
  f.memory.ledger.capture(bank, "message", id(), 1, "迟到的综合不可返回", "agent_inferred", "late-copy", Date.now());
  expect(f.store.get("SELECT id FROM memory_source_registry WHERE root_origin_key='late-copy'")).toBeUndefined();
  expect(f.store.get("SELECT content_hash FROM memory_tombstones WHERE content_hash=?", hash("迟到的综合不可返回"))).toBeDefined();
});
it("keeps stable private banks, scopes recall and excludes credentials from the durable source queue", async () => {
  const f = fixture(), engine = await fakeEngine(); f.memory.ledger.client = engine.client;
  const oldBank = f.store.get("SELECT * FROM memory_bank_bindings WHERE bot_id=?", f.bot)!;
  f.memory.write(f.bot, { title: "私有", content: "我偏好中文" });
  f.memory.write(f.peer, { title: "同伴私有", content: "不应跨 bank 读取" });
  f.memory.write(f.bot, { title: "共享", scope: "workspace", content: "显式共享事实" });
  f.memory.write(f.bot, { title: "配置", content: "api_key=synthetic-secret-value-123456" });
  expect(f.store.all("SELECT * FROM memory_source_registry")).toHaveLength(3);
  f.store.run("UPDATE bots SET name='新名字',instructions='新职责',version=version+1 WHERE id=?", f.bot);
  expect(f.store.get("SELECT id FROM memory_bank_bindings WHERE bot_id=?", f.bot)?.id).toBe(oldBank.id);
  await drain(f.memory);
  const recall = await f.memory.recall(f.bot, "偏好");
  expect(recall.status).toBe("available"); expect(recall.facts.map((item) => item.text)).toEqual(expect.arrayContaining(["我偏好中文", "显式共享事实"]));
  expect(recall.facts.some((item) => item.text.includes("不应跨"))).toBe(false);
  expect(engine.recalls).not.toContain(f.store.get("SELECT provider_bank_id FROM memory_bank_bindings WHERE bot_id=?", f.peer)?.provider_bank_id);
  expect(f.store.all("PRAGMA foreign_key_check")).toEqual([]);
});
it("reconciles a lost retain acknowledgement without another submission or a second receipt", async () => {
  const f = fixture(), engine = await fakeEngine(); f.memory.ledger.client = engine.client;
  f.memory.write(f.bot, { title: "原始来源", content: "合成内容" }); engine.loseNextAck();
  await f.memory.ledger.flush();
  expect(f.store.get("SELECT status FROM memory_transfers")?.status).toBe("unknown");
  expect(f.store.all("SELECT * FROM memory_transfer_receipts")).toHaveLength(0);
  f.store.run("UPDATE memory_transfers SET next_attempt_at=0"); await drain(f.memory);
  expect(engine.submissions).toHaveLength(1);
  expect(f.store.all("SELECT * FROM memory_transfer_receipts")).toHaveLength(1);
  await drain(f.memory); expect(f.store.all("SELECT * FROM memory_transfer_receipts")).toHaveLength(1);
});
it("quarantines correction/deletion before HTTP and fences an already-running recall", async () => {
  const f = fixture(), engine = await fakeEngine(); f.memory.ledger.client = engine.client;
  const doc = f.memory.write(f.bot, { title: "偏好", content: "旧偏好" }); await drain(f.memory);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { started = resolve; });
  engine.blockRecall(async () => { started(); await gate; });
  const inflight = f.memory.recall(f.bot, "偏好"); await ready;
  f.memory.write(f.bot, { documentId: doc.documentId, expectedVersion: 1, title: "偏好", content: "新偏好" });
  expect(f.store.get("SELECT state FROM memory_bank_bindings WHERE bot_id=?", f.bot)?.state).toBe("quarantined");
  release(); expect((await inflight).facts).toEqual([]);
  await drain(f.memory); expect((await f.memory.recall(f.bot, "偏好")).facts.map((item) => item.text)).toEqual(["新偏好"]);
  f.memory.remove(String(doc.documentId), 2); await drain(f.memory);
  expect((await f.memory.recall(f.bot, "偏好")).facts).toEqual([]);
  expect(f.store.all("SELECT * FROM memory_source_registry WHERE status='active'")).toHaveLength(0);
});
it("rechecks a revoked search permission while a recall is in flight", async () => {
  const f = fixture(), engine = await fakeEngine(); f.memory.ledger.client = engine.client;
  f.memory.write(f.bot, { title: "内容", content: "不能在撤销后返回" }); await drain(f.memory);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { started = resolve; });
  engine.blockRecall(async () => { started(); await gate; });
  const inflight = f.memory.recall(f.bot, "内容"); await ready;
  f.store.run("UPDATE bot_policies SET policy_json='{}',version=version+1 WHERE bot_id=?", f.bot);
  release(); expect(await inflight).toEqual({ status: "disabled", facts: [] });
});
it.each(["openai", "anthropic"])("keeps %s credentials inside Core, attributes every retry and blocks exhausted daily budgets", async (provider) => {
  const f = fixture(), received: Array<{ headers: Row; body: Record<string, unknown> }> = [];
  const model = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ headers: request.headers as Row, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(provider === "openai" ? { choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } } : { id: "synthetic", model: "fixture", stop_reason: "tool_use", content: [{ type: "tool_use", name: "memory_result", input: { facts: [] } }], usage: { input_tokens: 2, output_tokens: 3 } }));
  })(); });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await new Promise<void>((resolve) => { model.close(() => resolve()); model.closeAllConnections(); }); });
  f.store.saveConfig({ provider, endpoint: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, model: "configured-model", apiKey: "synthetic-paid-key" });
  const gateway = new MemoryModelGateway(f.store); await gateway.start(); cleanups.push(() => gateway.close());
  const bank = f.store.get("SELECT provider_bank_id FROM memory_bank_bindings WHERE bot_id=?", f.bot)!;
  const operation = id(), payload = { model: "ignored", messages: [{ role: "system", content: "synthetic" }, { role: "user", content: "synthetic" }], max_tokens: 100, response_format: { type: "json_schema", json_schema: { name: "memory", schema: { type: "object", properties: { facts: { type: "array" } } } } } };
  const post = (token = gateway.token, attributed = true) => fetch(gateway.origin + "/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(attributed ? { "x-nex-bank": String(bank.provider_bank_id), "x-nex-operation": operation, "x-nex-purpose": "retain" } : {}) }, body: JSON.stringify(payload) });
  expect((await post("bad")).status).toBe(401); expect((await post(gateway.token, false)).status).toBe(403);
  expect((await post()).status).toBe(200); expect((await post()).status).toBe(200);
  expect(received).toHaveLength(2); expect(received[0].body.model).toBe("configured-model");
  expect(received[0].headers[provider === "openai" ? "authorization" : "x-api-key"]).toContain("synthetic-paid-key");
  expect(JSON.stringify(received)).not.toContain("x-nex-bank");
  expect(f.store.all("SELECT * FROM memory_model_invocations")).toHaveLength(2);
  expect(f.store.get("SELECT SUM(input_tokens+output_tokens) n FROM memory_model_invocations")?.n).toBe(10);
  f.store.run("UPDATE memory_model_invocations SET reserved_tokens=100000");
  expect((await post()).status).toBe(429); expect(received).toHaveLength(2);
});
