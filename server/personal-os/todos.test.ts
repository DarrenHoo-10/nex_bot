import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createPersonalApp } from "./index.ts";
import { TodoModule } from "./todos.ts";
import { hash } from "./store.ts";
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
