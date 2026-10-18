import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { ConnectorModule, connectorUrl, type ConnectorView } from "./connectors.ts";
import { startFakeMcp } from "./testing/fake-mcp.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean) { const end = Date.now() + 25_000; while (!check()) { if (Date.now() > end) throw new Error("Connector fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 30)); } }
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-connector-fixture-")), key = randomBytes(32), token = "synthetic-owner";
  cleanup.push(async () => { if (path.dirname(root).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(root).startsWith("nex-connector-fixture-")) throw new Error("Unsafe cleanup"); rmSync(root, { recursive: true, force: true }); });
  const mcp = await startFakeMcp(), model = await startFakeModel(); cleanup.push(() => mcp.close(), () => model.close());
  const app = await createPersonalApp({ dir: root, key, token, identity: false, memoryRuntime: false });
  let activeApp = app; cleanup.push(() => activeApp.close());
  async function restart() { await activeApp.close(); activeApp = await createPersonalApp({ dir: root, key, token, identity: false, memoryRuntime: false }); return activeApp; }
  app.store.saveConfig({ provider: "openai", endpoint: model.origin + "/v1", model: "fixture", apiKey: "synthetic-only" });
  app.store.createBot("助手"); app.store.createBot("未授权助手");
  const bots = app.store.all("SELECT * FROM bots ORDER BY created_at");
  async function api(route: string, data?: unknown, auth = token) {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    const body = await response.json() as { connectors: Array<ConnectorView & Record<string, unknown>> }; return { status: response.status, body };
  }
  async function current() { return (await api("state")).body.connectors[0]; }
  async function setup(transport = "http", secret = "synthetic-mcp-secret", tools = ["echo"]) {
    expect((await api("connectors/save", { name: "测试工具", url: mcp.origin + (transport === "sse" ? "/sse" : "/mcp"), transport, token: secret })).status).toBe(200);
    expect((await api("connectors/test", await current())).status).toBe(200);
    expect((await api("connectors/grant", { ...await current(), botId: bots[0].id, tools })).status).toBe(200);
    return current();
  }
  return { app, root, key, token, mcp, model, bots, api, current, setup, restart };
}
describe("generic MCP connectors in disposable Core", () => {
  it.each(["http", "sse"])("discovers %s, encrypts credentials and makes one approved real worker call", async (transport) => {
    const f = await fixture(), connector = await f.setup(transport);
    expect(JSON.stringify((await f.api("state")).body)).not.toContain("synthetic-mcp-secret");
    expect(f.app.store.get("SELECT credential FROM personal_connectors")?.credential).not.toContain("synthetic-mcp-secret");
    expect((await f.api("connectors/toggle", { ...connector, enabled: false }, "invalid")).status).toBe(401);
    f.model.scripts.push({ kind: "openai-tool", calls: [{ id: "directory", name: "broker", args: JSON.stringify({ action: "connector.tools", connectorId: connector.id }) }] }, { kind: "openai-tool", calls: [{ id: "echo", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "echo", parameters: { text: "合成测试" } }) }] }, { kind: "openai-text", text: "连接器调用完成" });
    const taskId = f.app.agents.send(String(f.bots[0].id), "使用已授权的回显工具", "connector-call").taskId;
    await until(() => !!f.app.store.get("SELECT id FROM approvals WHERE status='pending'"));
    expect(f.mcp.calls).toHaveLength(0);
    const approval = f.app.store.get("SELECT * FROM approvals WHERE status='pending'")!;
    f.app.runtime.decide(String(approval.id), String(approval.argument_hash), true);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
    expect(f.mcp.calls).toEqual([{ name: "echo", arguments: { text: "合成测试" } }]);
    expect(f.mcp.credentials.every((value) => value === "Bearer synthetic-mcp-secret")).toBe(true);
    const tools = String(f.app.store.get("SELECT result_json FROM tool_calls WHERE tool_name='connector.tools'")?.result_json);
    expect(tools).toContain("echo"); expect(tools).not.toContain("private_tool");
    expect(String(f.app.store.get("SELECT result_json FROM tool_calls WHERE tool_name='connector.call'")?.result_json)).toContain("MCP 回显：合成测试");
  }, 60_000);
  it.each(["http", "sse"])("runs %s read-only queries automatically but holds external sending", async (transport) => {
    const f = await fixture(), connector = await f.setup(transport, "synthetic-mcp-secret", ["read_query", "echo", "send_message"]);
    expect(connector.tools.find((tool) => tool.name === "read_query")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    for (const [tool, risk] of [["read_query", undefined], ["echo", "standard"]]) {
      f.model.scripts.push({ kind: "openai-tool", calls: [{ id: tool!, name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool, risk, parameters: { text: "只读合成数据" } }) }] }, { kind: "openai-text", text: "查询完成" });
      const task = f.app.agents.send(String(f.bots[0].id), "读取合成数据", "read-" + tool).taskId;
      await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
      await until(() => !f.app.runtime.workers.size);
      expect(f.app.store.all("SELECT id FROM approvals")).toHaveLength(0);
    }
    expect(f.mcp.calls).toHaveLength(2);
    f.model.scripts.push({ kind: "openai-tool", calls: [{ id: "send", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "send_message", risk: "standard", parameters: { text: "合成发送" } }) }] }, { kind: "openai-text", text: "已发送" });
    const task = f.app.agents.send(String(f.bots[0].id), "发送合成数据", "send-fixture").taskId;
    await until(() => !!f.app.store.get("SELECT id FROM approvals WHERE status='pending'"));
    expect(f.mcp.calls).toHaveLength(2);
    const approval = f.app.store.get("SELECT * FROM approvals WHERE status='pending'")!;
    f.app.runtime.decide(String(approval.id), String(approval.argument_hash), true);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    expect(f.mcp.calls).toHaveLength(3);
  }, 60_000);
  it("rejects ungranted agents/tools and stale versions before dispatch, and clears grants on target change", async () => {
    const f = await fixture(), connector = await f.setup();
    const module = new ConnectorModule(f.app.store, () => {}); cleanup.push(() => module.close());
    const args = { action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "echo", parameters: {} };
    await expect(module.execute({ bot_id: f.bots[1].id }, args, async () => {})).rejects.toThrow("未授权");
    await expect(module.execute({ bot_id: f.bots[0].id }, { ...args, tool: "private_tool" }, async () => {})).rejects.toThrow("未获准");
    await expect(module.execute({ bot_id: f.bots[0].id }, { ...args, connectorVersion: 1 }, async () => {})).rejects.toThrow("已变化");
    expect((await f.api("connectors/save", { ...connector, url: f.mcp.origin + "/other" })).status).toBe(200);
    expect(await f.current()).toMatchObject({ hasToken: false, grants: [], tools: [] }); expect(f.mcp.calls).toHaveLength(0);
  });
  it("marks a cancelled dispatched call unknown and never replays it", async () => {
    const f = await fixture(), connector = await f.setup(); f.mcp.hold(true);
    f.model.scripts.push({ kind: "openai-tool", calls: [{ id: "held", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "echo", parameters: { text: "slow" } }) }] });
    const taskId = f.app.agents.send(String(f.bots[0].id), "等待中的连接器调用", "connector-cancel").taskId;
    await until(() => !!f.app.store.get("SELECT id FROM approvals WHERE status='pending'"));
    const approval = f.app.store.get("SELECT * FROM approvals WHERE status='pending'")!; f.app.runtime.decide(String(approval.id), String(approval.argument_hash), true);
    await until(() => f.mcp.calls.length === 1); f.app.runtime.cancel(taskId);
    await until(() => !f.app.runtime.workers.size);
    expect(f.app.store.get("SELECT status FROM tool_calls WHERE task_id=?", taskId)?.status).toBe("unknown");
    expect(f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status).toBe("cancelled");
    const reopened = await f.restart();
    expect(reopened.store.get("SELECT status FROM tool_calls WHERE task_id=?", taskId)?.status).toBe("unknown");
    const restored = new ConnectorModule(reopened.store, () => {});
    expect(restored.list()[0]).toMatchObject({ id: connector.id, hasToken: true, grants: [{ botId: f.bots[0].id, tools: ["echo"] }] });
    f.mcp.hold(false); await restored.test(restored.list()[0] as unknown as Record<string, unknown>); await restored.close();
    expect(f.mcp.calls).toHaveLength(1);
  }, 60_000);
  it("refuses redirects, credential-bearing URLs, pseudo-private hosts and late unauthorized discovery", async () => {
    for (const url of ["http://127.attacker.test/mcp", "https://user:pass@example.test/mcp", "https://example.test/mcp?token=secret", "http://169.254.169.254/mcp"]) expect(() => connectorUrl(url)).toThrow();
    const f = await fixture(); const module = new ConnectorModule(f.app.store, () => {}); cleanup.push(() => module.close());
    module.save({ name: "redirect", url: f.mcp.origin + "/redirect" });
    await expect(module.test(await f.current())).rejects.toThrow("连接失败");
    module.save({ ...await f.current(), url: f.mcp.origin + "/mcp" });
    await expect(module.test(await f.current(), async () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
    expect(await f.current()).toMatchObject({ tools: [], checkedAt: null });
  });
  it("rechecks authorization after handshake and prevents a revoked tool from being sent", async () => {
    const f = await fixture(), connector = await f.setup();
    const module = new ConnectorModule(f.app.store, () => {}); cleanup.push(() => module.close());
    await expect(module.execute({ bot_id: f.bots[0].id, task_id: "synthetic" }, { action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "echo", parameters: {} }, async () => { module.grant({ ...connector, botId: f.bots[0].id, tools: [] }); })).rejects.toThrow("未发送工具调用");
    expect(f.mcp.calls).toHaveLength(0);
  });
  it("redacts echoed credentials even when structured JSON escapes them", async () => {
    const f = await fixture(), secret = 'synthetic"quoted\\token', connector = await f.setup("http", secret);
    const module = new ConnectorModule(f.app.store, () => {}); cleanup.push(() => module.close());
    const result = await module.execute({ bot_id: f.bots[0].id, task_id: "synthetic" }, { action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "echo", parameters: { text: secret } }, async () => {});
    expect(result).toMatchObject({ text: "MCP 回显：[redacted]", structured: { echo: "[redacted]" } });
  });
});
