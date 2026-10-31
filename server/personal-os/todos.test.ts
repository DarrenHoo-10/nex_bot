import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createPersonalApp } from "./index.ts";
import { TodoModule } from "./todos.ts";
import { hash } from "./store.ts";
import { evaluateTool } from "./policy.ts";
import type { TodoItem } from "../../shared/personal-todos.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-todos-test-")),
    key = randomBytes(32),
    token = "synthetic-todo-token";
  const model = await startFakeModel();
  let app = await createPersonalApp({
    dir: root,
    key,
    token,
    identity: false,
    memoryRuntime: false,
    hostDevice: false,
    modelCatalog: {
      fetchDisabled: true,
      readSnapshot: () => undefined,
      log: () => {},
    },
  });
  cleanups.push(async () => {
    await app.close();
    await model.close();
    rmSync(root, { recursive: true, force: true });
  });
  app.store.saveConfig({
    provider: "openai",
    endpoint: model.origin + "/v1",
    model: "fake",
    apiKey: "synthetic",
  });
  const bot = app.store.createBot("测试助手");
  app.agents.ensure(bot);
  const module = () => new TodoModule(app.store, app.agents);
  const input = (overrides = {}) => ({
    id: randomUUID(),
    version: 0,
    title: "验收待办",
    description: "生成结果",
    owner: "me",
    date: "2026-10-30",
    priority: "普通",
    steps: [],
    ...overrides,
  });
  const request = async (route: string, data?: unknown, auth = token) =>
    fetch(app.origin + "/api/" + route, {
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      ...(data === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(data) }),
    });
  return {
    get app() {
      return app;
    },
    model,
    bot,
    module,
    input,
    request,
    restart: async () => {
      await app.close();
      app = await createPersonalApp({
        dir: root,
        key,
        token,
        identity: false,
        memoryRuntime: false,
        hostDevice: false,
        modelCatalog: {
          fetchDisabled: true,
          readSnapshot: () => undefined,
          log: () => {},
        },
      });
    },
  };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("任务未在隔离环境中完成");
}
describe("durable unified todos", () => {
  it("lets a model save panel todos, edit with versions and replay safely across restart", async () => {
    const f = await fixture();
    const draft = { action: "todo.save", title: "修复聊天界面", description: "修复侧栏摘要与流式显示", steps: [{ text: "检查侧栏摘要", done: false }] };
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "save-todo", name: "broker", args: JSON.stringify(draft) }] },
      { kind: "openai-tool", calls: [{ id: "list-todos", name: "broker", args: JSON.stringify({ action: "todo.list" }) }] },
      { kind: "openai-text", text: "已记录在待办中，尚未开始。" },
    );
    const task = f.app.agents.send(f.bot, "把这些记录为待办，先不要开工", "todo-broker-create").taskId;
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded" && f.app.runtime.workers.size === 0);
    let items = (await (await f.request("todos")).json() as { items: TodoItem[] }).items;
    expect(items).toHaveLength(1);
    const original = items[0];
    expect(original).toMatchObject({ title: draft.title, description: draft.description, status: "todo", owner: "me", date: "", priority: "普通", taskId: null, steps: draft.steps });
    const call = f.app.store.get("SELECT * FROM tool_calls WHERE task_id=? AND tool_name='todo.save'", task)!;
    expect(call.status).toBe("succeeded");
    expect(f.app.store.all("SELECT * FROM todo_runs")).toHaveLength(0);
    const prompt = JSON.stringify(f.model.requests[0].body);
    expect(prompt).toContain("todo.save");
    expect(prompt).toContain("不能用 memory.write");
    expect(prompt).toContain("todoId");
    await f.restart();
    expect(f.module().tool(call, draft)).toMatchObject({ saved: true, item: { id: original.id, version: original.version } });
    expect(f.module().list()).toHaveLength(1);
    const update = { action: "todo.save", todoId: original.id, expectedVersion: original.version, title: "更新后的界面待办", owner: f.bot };
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "edit-todo", name: "broker", args: JSON.stringify(update) }] },
      { kind: "openai-text", text: "待办已更新，尚未开始。" },
    );
    const editTask = f.app.agents.send(f.bot, "修改待办标题并分配给你，先不要执行", "todo-broker-edit").taskId;
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", editTask)?.status === "succeeded" && f.app.runtime.workers.size === 0);
    items = (await (await f.request("todos")).json() as { items: TodoItem[] }).items;
    expect(items[0]).toMatchObject({ id: original.id, title: update.title, description: draft.description, steps: draft.steps, owner: f.bot, status: "todo", taskId: null, version: original.version + 1 });
    const editCall = f.app.store.get("SELECT * FROM tool_calls WHERE task_id=? AND tool_name='todo.save'", editTask)!;
    expect(f.module().tool(editCall, update)).toMatchObject({ item: { version: original.version + 1 } });
    expect(() => f.module().tool({ ...editCall, id: "stale-attempt" }, update)).toThrow("其他设备更新");
    expect(() => f.module().tool({ ...editCall, argument_hash: "changed" }, update)).toThrow("身份冲突");
    f.module().action({ id: original.id, version: items[0].version, action: "delete" }, f.app.store.session);
    expect(() => f.module().tool(call, draft)).toThrow("已删除");
    expect(f.module().list()).toHaveLength(0);
  });
  it("lets a model delete a panel todo and replay the durable receipt after restart", async () => {
    const f = await fixture();
    const item = f.module().save(f.input());
    const kept = f.module().save(f.input({ title: "保留的待办" }));
    const args = { action: "todo.delete", todoId: item.id, expectedVersion: item.version };
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "delete-todo", name: "broker", args: JSON.stringify(args) }] },
      { kind: "openai-text", text: "已删除指定待办。" },
    );
    const task = f.app.agents.send(f.bot, "删除指定待办", "todo-broker-delete").taskId;
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded" && f.app.runtime.workers.size === 0);
    const call = f.app.store.get("SELECT * FROM tool_calls WHERE task_id=? AND tool_name='todo.delete'", task)!;
    expect(call.status).toBe("succeeded");
    expect(JSON.stringify(f.model.requests[0].body)).toContain("todo.delete(todoId,expectedVersion)");
    expect((await (await f.request("todos")).json() as { items: TodoItem[] }).items.map((t) => t.id)).toEqual([kept.id]);
    const tombstone = f.app.store.get("SELECT * FROM todos WHERE id=?", item.id)!;
    expect(tombstone.deleted_at).not.toBeNull();
    expect(tombstone.version).toBe(item.version + 1);
    await f.restart();
    expect(f.module().tool(call, args)).toEqual({ deleted: true, todoId: item.id });
    expect(f.app.store.get("SELECT * FROM todos WHERE id=?", item.id)).toEqual(tombstone);
    expect(f.app.store.all("SELECT * FROM todo_tool_receipts WHERE call_id=?", call.id)).toHaveLength(1);
    expect(f.app.store.all("SELECT * FROM audit_records WHERE action='todo.delete' AND entity_id=?", item.id)).toHaveLength(1);
    expect(f.module().list().map((t) => t.id)).toEqual([kept.id]);
    expect(() => f.module().tool({ ...call, argument_hash: "changed" }, args)).toThrow("身份冲突");
    expect(() => f.module().tool({ ...call, id: "another-delete" }, args)).toThrow("已删除");
    f.app.store.insert("users", { id: "different-owner", display_name: "隔离成员", status: "active", created_at: Date.now() });
    f.app.store.run("UPDATE todos SET owner_user_id='different-owner' WHERE id=?", item.id);
    expect(() => f.module().tool(call, args)).toThrow("不存在");
  });
  it("rejects stale or missing delete versions without removing the item", async () => {
    const f = await fixture();
    const item = f.module().save(f.input());
    const current = f.module().save({ ...item, title: "已更新" });
    const call = { id: "rejected-delete", tool_name: "todo.delete" };
    for (const expectedVersion of [undefined, item.version, "2", 2.5])
      expect(() => f.module().tool(call, { todoId: item.id, expectedVersion })).toThrow("其他设备更新");
    expect(() => f.module().tool(call, { todoId: "missing", expectedVersion: 1 })).toThrow("不存在");
    expect(() => f.module().tool(call, { expectedVersion: current.version })).toThrow();
    // A receipt failure must roll the deletion and its audit record back together.
    expect(() => f.module().tool(call, { todoId: item.id, expectedVersion: current.version })).toThrow();
    expect(f.module().get(item.id)).toEqual(current);
    expect(f.app.store.all("SELECT * FROM todo_tool_receipts")).toHaveLength(0);
    expect(f.app.store.all("SELECT * FROM audit_records WHERE action='todo.delete' AND entity_id=?", item.id)).toHaveLength(0);
  });
  it("honors tool grants and workspace ownership", async () => {
    const f = await fixture();
    expect(evaluateTool(f.app.store, f.bot, { action: "todo.save", title: "授权待办" }).approvalRequired).toBe(false);
    expect(evaluateTool(f.app.store, f.bot, { action: "todo.delete", todoId: "specified", expectedVersion: 1 }).approvalRequired).toBe(false);
    const item = f.module().save(f.input());
    f.app.store.insert("users", { id: "another-owner", display_name: "隔离成员", status: "active", created_at: Date.now() });
    f.app.store.run("UPDATE todos SET owner_user_id='another-owner' WHERE id=?", item.id);
    expect(f.module().tool({ tool_name: "todo.list" }, {})).toEqual({ items: [] });
    expect(() => f.module().tool({ id: "cross-owner", tool_name: "todo.save" }, { todoId: item.id, expectedVersion: item.version, title: "不应修改" })).toThrow("不存在");
    expect(() => f.module().tool({ id: "cross-owner-delete", tool_name: "todo.delete" }, { todoId: item.id, expectedVersion: item.version })).toThrow("不存在");
    f.app.store.run("UPDATE bot_policies SET policy_json=? WHERE bot_id=?", JSON.stringify({ tools: ["memory.search"] }), f.bot);
    expect(() => evaluateTool(f.app.store, f.bot, { action: "todo.save", title: "不应创建" })).toThrow("无权");
    expect(() => evaluateTool(f.app.store, f.bot, { action: "todo.delete", todoId: item.id, expectedVersion: item.version })).toThrow("无权");
  });
  it("persists changes, steps and completion across Core restart and detects stale writes", async () => {
    const f = await fixture();
    let item = f
      .module()
      .save(f.input({ steps: [{ text: "第一步", done: false }] }));
    const stale = { ...item };
    item = f.module().save({
      ...item,
      title: "已修改",
      steps: [{ text: "第一步", done: true }],
    });
    expect((await f.request("todos/save", stale)).status).toBe(409);
    f.module().action({ ...item, action: "complete" }, f.app.store.session);
    await f.restart();
    item = f.module().get(item.id);
    expect(item).toMatchObject({
      title: "已修改",
      status: "done",
      steps: [{ text: "第一步", done: true }],
    });
    expect(item.log).toContain("你确认完成了待办");
    expect((await f.request("todos", undefined, "invalid")).status).toBe(401);
    expect((await f.request("todos")).status).toBe(200);
    f.module().action({ ...item, action: "delete" }, f.app.store.session);
    expect(f.module().list()).toEqual([]);
  });
  it("links a real worker run, rejects busy assignment, delivers for review, and replays start once", async () => {
    const f = await fixture();
    f.model.scripts.push({ kind: "openai-text", text: "待办交付结果" });
    const item = f.module().save(f.input({ owner: f.bot })),
      request = {
        id: item.id,
        version: item.version,
        action: "start",
        clientId: randomUUID(),
      };
    const started = f.module().action(request, f.app.store.session);
    expect(started).toMatchObject({ status: "running" });
    expect(f.module().action(request, f.app.store.session)).toMatchObject({
      taskId: "taskId" in started ? started.taskId : null,
    });
    const other = f.module().save(f.input({ owner: f.bot }));
    expect(() =>
      f.module().action(
        {
          id: other.id,
          version: other.version,
          action: "start",
          clientId: randomUUID(),
        },
        f.app.store.session,
      ),
    ).toThrow("其他工作");
    await until(() => f.module().get(item.id).status === "review");
    const delivered = f.module().get(item.id);
    expect(delivered.result).toContain("待办交付结果");
    expect(f.app.store.all("SELECT * FROM todo_runs")).toHaveLength(1);
    await f.restart();
    expect(f.module().get(item.id)).toMatchObject({
      status: "review",
      result: delivered.result,
    });
  });
  it("keeps interrupted work and blocks completion/deletion/editing until its execution stops", async () => {
    const f = await fixture();
    f.model.scripts.push({ kind: "hang" });
    let item = f.module().save(f.input({ owner: f.bot }));
    f.module().action(
      {
        id: item.id,
        version: item.version,
        action: "start",
        clientId: randomUUID(),
      },
      f.app.store.session,
    );
    item = f.module().get(item.id);
    for (const action of ["complete", "delete"])
      expect(() =>
        f.module().action({ ...item, action }, f.app.store.session),
      ).toThrow("停止");
    expect(() => f.module().save({ ...item })).toThrow("停止");
    expect(() => f.module().tool({ id: "running-delete", tool_name: "todo.delete" }, { todoId: item.id, expectedVersion: item.version })).toThrow("停止");
    f.module().action({ ...item, action: "stop" }, f.app.store.session);
    await until(() => f.module().get(item.id).status === "todo");
    expect(f.module().get(item.id).log).toContain("执行已停止");
    expect(f.module().list()).toHaveLength(1);
  });
  it("validates dates, owners and step shapes before writing", async () => {
    const f = await fixture();
    for (const overrides of [
      { date: "2026-02-30" },
      { owner: "missing" },
      { steps: [{ text: "x", done: "yes" }] },
      { priority: "urgent" },
    ])
      expect(() => f.module().save(f.input(overrides))).toThrow();
    expect(f.module().list()).toEqual([]);
  });
  it("persists personal work in progress and resets assignment without starting an AI task", async () => {
    const f = await fixture();
    let item = f.module().save(f.input());
    f.module().action({ ...item, action: "begin" }, f.app.store.session);
    await f.restart();
    item = f.module().get(item.id);
    expect(item).toMatchObject({ status: "running", taskId: null });
    item = f.module().save({ ...item, title: "正在自己处理" });
    f.module().action({ ...item, action: "stop" }, f.app.store.session);
    item = f.module().get(item.id);
    expect(item.status).toBe("todo");
    f.module().action({ ...item, action: "begin" }, f.app.store.session);
    item = f.module().get(item.id);
    f.module().action({ ...item, action: "complete" }, f.app.store.session);
    item = f.module().get(item.id);
    expect(item.status).toBe("done");
    f.module().action({ ...item, action: "reopen" }, f.app.store.session);
    item = f.module().get(item.id);
    f.module().action({ ...item, action: "begin" }, f.app.store.session);
    item = f.module().get(item.id);
    item = f.module().save({ ...item, owner: f.bot });
    expect(item).toMatchObject({ owner: f.bot, status: "todo", taskId: null });
    expect(f.app.store.all("SELECT id FROM tasks")).toHaveLength(0);
  });
  it("recovers a persisted stop across restart without losing or restarting its todo", async () => {
    const f = await fixture();
    f.model.scripts.push({ kind: "hang" });
    const item = f.module().save(f.input({ owner: f.bot }));
    f.module().action(
      { ...item, action: "start", clientId: randomUUID() },
      f.app.store.session,
    );
    const running = f.module().get(item.id);
    f.app.store.run(
      "UPDATE tasks SET status='cancelling' WHERE id=?",
      running.taskId!,
    );
    await f.restart();
    expect(f.module().get(item.id)).toMatchObject({
      status: "todo",
      taskStatus: "cancelled",
    });
    expect(f.module().get(item.id).log).toContain("执行已停止");
    expect(f.app.store.all("SELECT * FROM todo_runs")).toHaveLength(1);
  });

  it("restricts list and writes to the workspace owner", async () => {
    const f = await fixture(),
      other = randomUUID();
    f.app.store.insert("users", {
      id: other,
      display_name: "合成成员",
      status: "active",
      created_at: Date.now(),
    });
    f.app.store.insert("memberships", {
      workspace_id: f.app.store.workspace,
      user_id: other,
      status: "active",
      created_at: Date.now(),
    });
    f.app.store.insert("user_sessions", {
      id: randomUUID(),
      workspace_id: f.app.store.workspace,
      user_id: other,
      token_hash: hash("synthetic-member"),
      protocol: "local",
      revocation_mode: "local",
      created_at: Date.now(),
      expires_at: Date.now() + 60000,
    });
    expect(
      (await f.request("todos", undefined, "synthetic-member")).status,
    ).toBe(401);
    expect(
      (await f.request("todos/save", f.input(), "synthetic-member")).status,
    ).toBe(401);
    expect(f.module().list()).toEqual([]);
  });
});
