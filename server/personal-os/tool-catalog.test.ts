import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CoreStore } from "./store.ts";
import { actions, evaluateTool, policyTools } from "./policy.ts";
import { commonToolPrompt, missingToolArguments, searchTools, toolCatalog } from "./tool-catalog.ts";
import { brokerDeclaration, brokerParameters } from "./broker-tool.ts";
import { tokens } from "./assistant-model.ts";
import { createPersonalApp } from "./index.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function directoryFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-tool-catalog-"));
  const store = new CoreStore(dir, randomBytes(32), "synthetic");
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bot = store.createBot("查询验收");
  return { store, bot };
}

it("lists authorized tools with pagination and returns usable action-specific schemas on demand", () => {
  const { store, bot } = directoryFixture();
  const names: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = searchTools(store, bot, { offset, limit: 10 });
    expect(page.items.every((item) => !("parameters" in item))).toBe(true);
    names.push(...page.items.map((item) => item.action));
    offset = page.nextOffset;
  }
  expect(new Set(names)).toEqual(new Set([...actions, "memory.core.update", "memory.topic"]));
  expect(names.length).toBe(new Set(names).size);
  const result = searchTools(store, bot, { query: "routine.save" });
  expect(result.items[0]).toMatchObject({ action: "routine.save", common: false, parameters: {
    required: ["action", "name", "prompt", "scheduleKind"],
    properties: { action: { const: "routine.save" }, delaySeconds: { type: "integer" } },
  } });
  expect(result.items[0].description).toContain("最短5分钟");
  expect(result.items[0].parameters?.properties).not.toHaveProperty("todoId");
  expect(searchTools(store, bot, { query: "帮我设个定时提醒" }).items.some((item) => item.action === "routine.save")).toBe(true);
  expect(searchTools(store, bot, { query: "xyz-unmatched-987" })).toMatchObject({ items: [], total: 0, nextOffset: null });
  for (const args of [{ query: {} }, { query: "x".repeat(201) }, { offset: -1 }, { offset: 0.5 }, { limit: 11 }])
    expect(() => searchTools(store, bot, args)).toThrow();
  for (const entry of toolCatalog) {
    // Background job actions belong to the calling task's origin, not to a grant.
    const origin = ["job.report", "job.progress"].includes(entry.action) ? "job" : entry.action.startsWith("job.") ? "owner" : undefined;
    const found = searchTools(store, bot, { query: entry.action }, origin).items[0];
    expect(found.action).toBe(entry.action);
    expect(Object.values(found.parameters!.properties).every((schema) => schema !== undefined)).toBe(true);
  }
  expect(searchTools(store, bot, { query: "job" }).items).toEqual([]);
  expect(searchTools(store, bot, { query: "job.report" }, "owner").items).toEqual([]);
  expect(searchTools(store, bot, { query: "job.start" }, "job").items).toEqual([]);
  for (const query of ["子代理", "子agent", "subagent"])
    expect(searchTools(store, bot, { query }, "owner").items.some((item) => item.action === "job.start")).toBe(true);
  const owner = searchTools(store, bot, { query: "device.computer" }, "owner").items[0];
  expect(owner.title).toContain("仅后台任务");
  expect(owner.description).toContain("job.start");
  expect(searchTools(store, bot, { query: "device.computer" }, "job").items[0].title).not.toContain("仅后台任务");
  expect(commonToolPrompt(policyTools(store.get("SELECT * FROM bot_policies WHERE bot_id=?", bot)!), "owner")).toContain("job.start(title");
});

it("does not expose restricted operations or grant them through discovery, including after a policy change", () => {
  const { store, bot } = directoryFixture();
  const before = store.get("SELECT * FROM bot_policies WHERE bot_id=?", bot)!;
  expect(searchTools(store, bot, { query: "todo.delete" }).items).toHaveLength(1);
  store.run("UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?", JSON.stringify({ tools: ["memory.search"] }), bot);
  expect(evaluateTool(store, bot, { action: "tool.search", query: "todo" }).approvalRequired).toBe(false);
  expect(searchTools(store, bot, { query: "todo" }).items).toEqual([]);
  expect(searchTools(store, bot, { query: "memory.core.update" }).items).toEqual([]);
  expect(() => evaluateTool(store, bot, { action: "todo.delete", todoId: "x", expectedVersion: 1 })).toThrow("无权");
  const current = store.get("SELECT * FROM bot_policies WHERE bot_id=?", bot)!;
  expect(current.version).toBe(Number(before.version) + 1);
  expect(policyTools(current)).not.toContain("todo.delete");
  expect(commonToolPrompt(policyTools(current))).not.toContain("todo.save(");
  store.run("UPDATE bots SET status='archived' WHERE id=?", bot);
  expect(() => searchTools(store, bot, {})).toThrow("无权");
  expect(() => searchTools(store, "unknown", {})).toThrow("无权");
});

it("keeps todo resident while bounding common help and the wire declaration", () => {
  const prompt = commonToolPrompt([...actions]);
  expect(prompt).toContain("todo.save(title");
  expect(prompt).toContain("todo.delete(todoId,expectedVersion)");
  expect(prompt).not.toContain("scheduleKind");
  expect(prompt).not.toContain("intervalMinutes");
  expect(tokens(prompt)).toBeLessThan(800);
  // Field types are a wire contract, not an optional instruction manual. Full
  // action help is still on demand; don't optimize the schema back to action-only.
  expect(tokens(brokerDeclaration)).toBeLessThan(1400);
  for (const entry of toolCatalog) for (const key of entry.fields.split(" ").filter(Boolean))
    expect(brokerParameters.properties, `${entry.action}.${key}`).toHaveProperty(key);
  expect(brokerParameters.properties).toMatchObject({
    title: { type: "string" }, sources: { type: "array", items: { type: "string" } }, note: { type: "string" },
    query: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 },
  });
});

it("diagnoses absent required fields without turning optional search fields into requirements", () => {
  for (const title of [undefined, null, "", "   "]) {
    expect(missingToolArguments("job.start", { action: "job.start", title })).toMatchObject({
      code: "invalid_tool_arguments", action: "job.start", fields: ["title"], error: expect.stringContaining("title"),
    });
  }
  expect(missingToolArguments("job.start", { title: "写文章" })).toBeUndefined();
  expect(missingToolArguments("tool.search", {})).toBeUndefined();
  expect(missingToolArguments("routine.toggle", { routineId: "r", expectedVersion: 0, enabled: false })).toBeUndefined();
});

it.each(["openai", "anthropic"] as const)("preserves query and pagination and returns different pages through the %s worker", async (provider) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-tool-pages-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const model = await startFakeModel(); cleanup.push(() => model.close());
  const app = await createPersonalApp({ dir, key: randomBytes(32), token: "synthetic", identity: false, memoryRuntime: false, hostDevice: false,
    modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } });
  cleanup.push(() => app.close());
  app.store.saveConfig({ provider, endpoint: model.origin + "/v1", model: "grok-4.7-build-fast", apiKey: "synthetic" });
  const bot = app.store.createBot("翻页验收");
  const proposals = [
    { action: "tool.search" }, // An intentional directory request remains valid.
    { action: "tool.search", query: "", offset: 0, limit: 3 },
    { action: "tool.search", query: "", offset: 3, limit: 3 },
    { action: "tool.search", query: "job.start", offset: 0, limit: 1 },
  ];
  proposals.forEach((args, i) => model.scripts.push(provider === "openai"
    ? { kind: "openai-tool", calls: [{ id: `page-${i}`, name: "broker", args: JSON.stringify(args) }] }
    : { kind: "anthropic-tool", id: `page-${i}`, name: "broker", args: JSON.stringify(args) }));
  model.scripts.push({ kind: provider === "openai" ? "openai-text" : "anthropic-text", text: "已查询两页和派发用法。" });
  const sent = app.agents.send(bot, "查看目录并翻页，再查询 job.start", `pages-${provider}`);
  const deadline = Date.now() + 40000;
  while (app.store.get("SELECT ended_at FROM tasks WHERE id=?", sent.taskId)?.ended_at == null) {
    if (Date.now() > deadline) throw new Error("隔离翻页任务超时");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  expect(app.store.get("SELECT status FROM tasks WHERE id=?", sent.taskId)?.status).toBe("succeeded");
  const calls = app.store.all("SELECT * FROM tool_calls WHERE task_id=? ORDER BY created_at,rowid", sent.taskId);
  expect(calls.map((call) => call.status)).toEqual(proposals.map(() => "succeeded"));
  expect(calls.map((call) => JSON.parse(String(call.arguments_json)))).toEqual(proposals);
  const pages = calls.map((call) => JSON.parse(String(call.result_json)));
  expect(pages[0].items).toHaveLength(5);
  expect(pages[0].nextOffset).toBe(5);
  expect(pages[1].items).toHaveLength(3);
  expect(pages[1].nextOffset).toBe(3);
  expect(pages[2].items).toHaveLength(3);
  expect(pages[2].nextOffset).toBe(6);
  expect(new Set([...pages[1].items, ...pages[2].items].map((item: { action: string }) => item.action)).size).toBe(6);
  expect(pages[3]).toMatchObject({ items: [{ action: "job.start" }], total: 1, nextOffset: null });
  expect(pages[3].items[0].parameters.required).toContain("title");
  const runtimeId = app.store.get("SELECT runtime_session_id FROM tool_calls WHERE task_id=?", sent.taskId)!.runtime_session_id;
  const projection = app.runtime.projection.load(String(runtimeId));
  expect(projection).toBeDefined();
  const projectedCalls = projection!.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant"
    ? entry.message.content.filter((part) => part.type === "toolCall").map((part) => part.arguments) : []);
  expect(projectedCalls).toEqual(proposals);
}, 60000);

it.each(["openai", "anthropic"] as const)("discovers a rare action then executes its flat call through the %s worker", async (provider) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-tool-discovery-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const model = await startFakeModel(); cleanup.push(() => model.close());
  const app = await createPersonalApp({ dir, key: randomBytes(32), token: "synthetic", identity: false, memoryRuntime: false, hostDevice: false,
    modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } });
  cleanup.push(() => app.close());
  app.store.saveConfig({ provider, endpoint: model.origin + "/v1", model: "fixture", apiKey: "synthetic" });
  const bot = app.store.createBot("工具查询验收");
  const proposals = [
    { action: "tool.search", query: "routine.save" },
    { action: "routine.save", name: "验收提醒", prompt: "提醒检查验收结果", scheduleKind: "once", delaySeconds: 86400, taskKind: "reminder" },
  ];
  proposals.forEach((args, i) => model.scripts.push(provider === "openai"
    ? { kind: "openai-tool", calls: [{ id: `call-${i}`, name: "broker", args: JSON.stringify(args) }] }
    : { kind: "anthropic-tool", id: `call-${i}`, name: "broker", args: JSON.stringify(args) }));
  model.scripts.push({ kind: provider === "openai" ? "openai-text" : "anthropic-text", text: "已安排提醒。" });
  const sent = app.agents.send(bot, "明天提醒我检查验收结果", `discovery-${provider}`);
  const until = Date.now() + 40000;
  while (app.store.get("SELECT ended_at FROM tasks WHERE id=?", sent.taskId)?.ended_at == null) {
    if (Date.now() > until) throw new Error("隔离查询任务超时");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  expect(app.store.get("SELECT status FROM tasks WHERE id=?", sent.taskId)?.status).toBe("succeeded");
  const calls = app.store.all("SELECT * FROM tool_calls WHERE task_id=? ORDER BY created_at", sent.taskId);
  expect(calls.map((call) => [call.tool_name, call.status])).toEqual([["tool.search", "succeeded"], ["routine.save", "succeeded"]]);
  expect(JSON.parse(String(calls[0].result_json)).items[0].parameters.properties).toHaveProperty("scheduleKind");
  expect(app.store.all("SELECT * FROM agent_routines WHERE bot_id=?", bot)).toHaveLength(1);
  expect(model.requests[0].body).toContain("todo.save(title");
  const first = JSON.parse(model.requests[0].body);
  const wireSchema = provider === "openai" ? first.tools[0].function.parameters : first.tools[0].input_schema;
  expect(wireSchema).toEqual(JSON.parse(JSON.stringify(brokerParameters)));
  if (provider === "openai") expect(first.tools[0].function).not.toHaveProperty("strict");
  expect(JSON.stringify(first.messages)).not.toContain("scheduleKind");
  expect(model.requests[1].body).toContain("最短5分钟");
  expect(calls.map((call) => JSON.parse(String(call.arguments_json)))).toEqual(proposals);
  // The explicit wire schema must not drop the previous per-field type checks.
  const badArgs = [
    { action: "todo.save", title: 123 },
    { action: "tool.search", offset: "3" },
    { action: "job.start", title: "不应创建", note: null },
  ];
  badArgs.forEach((args, i) => model.scripts.push(provider === "openai"
    ? { kind: "openai-tool", calls: [{ id: `bad-field-${i}`, name: "broker", args: JSON.stringify(args) }] }
    : { kind: "anthropic-tool", id: `bad-field-${i}`, name: "broker", args: JSON.stringify(args) }));
  model.scripts.push({ kind: provider === "openai" ? "openai-text" : "anthropic-text", text: "参数无效，未保存。" });
  const bad = app.agents.send(bot, "测试错误类型的待办参数", `bad-fields-${provider}`);
  const deadline = Date.now() + 20000;
  while (app.store.get("SELECT ended_at FROM tasks WHERE id=?", bad.taskId)?.ended_at == null) {
    if (Date.now() > deadline) throw new Error("参数校验测试超时");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  expect(app.store.all("SELECT * FROM todos")).toHaveLength(0);
  expect(app.store.all("SELECT * FROM tool_calls WHERE task_id=?", bad.taskId)).toHaveLength(0);
  expect(app.store.all("SELECT * FROM agent_jobs")).toHaveLength(0);
  const last = model.requests.at(-1)!.body;
  expect(last).toContain("工具参数类型无效");
  for (const field of ["/title", "/offset", "/note"]) expect(last).toContain(field);
  expect(last).not.toContain("Tool source mismatch");
}, 60000);
