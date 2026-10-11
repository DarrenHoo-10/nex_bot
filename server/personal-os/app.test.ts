import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync, unlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { pathToFileURL } from "node:url";
import { startFakeModel, type FakeModel } from "../runtime/pi/p0/fake-model.ts";
import { hash, id } from "./store.ts";
import { nextDaily } from "./routines.ts";
import { createClientNode } from "./client-node.ts";
function pdfFixture(content: string) {
  const stream = `BT /F1 12 Tf 60 750 Td (${content}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let document = "%PDF-1.4\n", positions = [0];
  for (const [index, object] of objects.entries()) { positions.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const offset = Buffer.byteLength(document); document += `xref\n0 6\n0000000000 65535 f \n${positions.slice(1).map((p) => String(p).padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(document);
}

type App = Awaited<ReturnType<typeof createPersonalApp>>;
const startApp: typeof createPersonalApp = process.env.NEX_TEST_BUNDLE ? (await import(pathToFileURL(path.resolve(process.env.NEX_TEST_BUNDLE)).href)).createPersonalApp : createPersonalApp;
const createApp: typeof createPersonalApp = (options) => startApp({ ...options, memoryRuntime: false });
const fixtures: Array<{ root: string; apps: App[]; fake: FakeModel }> = [];
const wait = async (check: () => boolean, milliseconds = 25_000) => {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    for (const f of fixtures) for (const app of f.apps) {
      const failed = app.store.get("SELECT result_summary FROM tasks WHERE status='failed' ORDER BY created_at DESC LIMIT 1");
      if (failed) throw new Error("Fixture task failed: " + failed.result_summary + " " + JSON.stringify({ fixtureModelPort: f.fake.port, modelRequests: f.fake.requests.length }));
    }
    if (Date.now() > deadline) throw new Error("Fixture timeout: " + JSON.stringify(fixtures.map((f) => ({ requests: f.fake.requests.length, tasks: f.apps.map((a) => a.store.all("SELECT status,result_summary FROM tasks")), invocations: f.apps.map((a) => a.store.all("SELECT purpose,status FROM model_invocations")) })))); await new Promise((resolve) => setTimeout(resolve, 30));
  }
};
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-personal-fixture-")), key = randomBytes(32), token = "synthetic-desktop-token";
  const fake = await startFakeModel();
  const app = await createApp({ dir: path.join(root, "core"), key, token });
  const owned = { root, apps: [app], fake }; fixtures.push(owned);
  app.store.saveConfig({ provider: "openai", endpoint: fake.origin + "/v1", model: "fake", apiKey: "synthetic-model-key" });
  for (const name of ["Alpha", "Beta", "Gamma"]) app.store.createBot(name);
  const bots = app.store.all("SELECT * FROM bots");
  app.agents.updatePolicy({ id: bots[0].id, version: 1, tools: ["memory.search", "memory.read", "memory.write", "memory.delete", "agent.directory", "agent.delegate", "device.list", "device.read", "device.exec"] });
  const conversation = app.store.createConversation(String(bots[0].id));
  return { root, key, token, fake, app, owned, bots, conversation };
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const app of fixture.apps.splice(0)) await app.close();
    await fixture.fake.close();
    if (!path.basename(fixture.root).startsWith("nex-personal-fixture-") || path.dirname(fixture.root).toLowerCase() !== os.tmpdir().toLowerCase()) throw new Error("Unsafe fixture cleanup");
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
function approval(app: App) { return app.store.get("SELECT * FROM approvals WHERE status='pending' ORDER BY created_at DESC")!; }
function pendingCleanup(app: App, botId: string) {
  const doc = app.runtime.memory.write(botId, { title: "合成待清理记忆", content: "用于验证危险清理审批" });
  return { action: "memory.delete", documentId: doc.documentId, expectedVersion: doc.version };
}
describe("Personal AI OS production workflows in isolated fixtures", () => {
  it("registers the primary computer with default shell/computer capabilities and a separate shared folder, exposes actual device metadata and keeps its ID through restart", async () => {
    const f = await fixture(), botId = String(f.bots[1].id);
    await wait(() => f.app.node.status === "已连接");
    const [device] = f.app.gateway.inventory();
    expect(device).toMatchObject({ role: "core", online: true, granted: { info: true, read: false, exec: true, computer: f.app.node.computer.available() }, identity: { architecture: os.arch(), os: os.type(), release: os.release() } });
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "inventory", name: "broker", args: JSON.stringify({ action: "device.inventory" }) }] }, { kind: "openai-tool", calls: [{ id: "info", name: "broker", args: JSON.stringify({ action: "device.info", deviceId: device.id }) }] }, { kind: "openai-text", text: "主电脑识别完成" });
    const taskId = f.app.agents.send(botId, "识别主电脑", "inventory-input").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded"); await wait(() => !f.app.runtime.workers.size);
    expect(String(f.app.store.get("SELECT result_json FROM tool_calls WHERE task_id=? AND tool_name='device.info'", taskId)?.result_json)).toContain(os.release());
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "default-terminal", name: "broker", args: JSON.stringify({ action: "device.exec", deviceId: device.id, command: process.platform === "win32" ? "Convert-Path ." : "pwd" }) }] }, { kind: "openai-text", text: "终端无需共享目录" });
    const terminal = f.app.agents.send(botId, "查看默认工作目录", "default-terminal-input").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", terminal)?.status === "succeeded"); await wait(() => !f.app.runtime.workers.size);
    const result = JSON.parse(String(f.app.store.get("SELECT result_json FROM tool_calls WHERE task_id=?", terminal)?.result_json));
    expect(realpathSync.native(result.stdout.trim())).toBe(realpathSync.native(os.homedir()));
    expect(f.app.node.config!.root).toBe("");
    expect(f.app.store.all("SELECT * FROM approvals")).toHaveLength(0);
    const policyVersion = f.app.node.config!.policyVersion;
    await f.app.close(); f.owned.apps.splice(0, 1);
    const reopened = await createApp({ dir: path.join(f.root, "core"), key: f.key, token: f.token }); f.owned.apps.push(reopened);
    await wait(() => reopened.node.status === "已连接");
    expect(reopened.gateway.inventory()[0]).toMatchObject({ id: device.id, role: "core", granted: { read: false, exec: true, computer: reopened.node.computer.available() } });
    expect(reopened.node.config!.policyVersion).toBe(policyVersion);
    // Older Nodes can share files without implementing device.info. The
    // public directory must not invent that extra capability.
    const scope = JSON.parse(String(reopened.store.get("SELECT scope_json FROM device_local_grants WHERE device_id=?", device.id)!.scope_json));
    reopened.store.run("UPDATE device_local_grants SET scope_json=? WHERE device_id=?", JSON.stringify({ ...scope, info: false, read: true }), device.id);
    const state = await fetch(reopened.origin + "/api/state", { headers: { Authorization: "Bearer " + f.token } }).then((response) => response.json()) as { directory: { id: string; capabilities: string[] }[] };
    expect(state.directory.find((bot) => bot.id === botId)!.capabilities).toContain("device.read");
    expect(state.directory.find((bot) => bot.id === botId)!.capabilities).not.toContain("device.info");
  }, 60_000);
  it("upgrades an untouched previous default policy, preserves identical user-edited restrictions and freezes the shipped migration", async () => {
    const f = await fixture(), untouched = String(f.bots[1].id), edited = String(f.bots[2].id);
    const tools = JSON.parse(String(f.app.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", untouched)?.policy_json)).tools.filter((tool: string) => tool !== "device.exec");
    f.app.agents.updatePolicy({ id: edited, version: 1, tools });
    f.app.store.run("UPDATE bot_policies SET policy_json=? WHERE bot_id=?", JSON.stringify({ tools }), untouched);
    const previousHash = f.app.store.get("SELECT checksum FROM schema_migrations WHERE version=7")?.checksum;
    f.app.node.configure({ ...f.app.node.config, exec: false, computer: false });
    f.app.store.run("DELETE FROM schema_migrations WHERE version=8");
    await f.app.close(); f.owned.apps.splice(0, 1);
    const reopened = await createApp({ dir: path.join(f.root, "core"), key: f.key, token: f.token }); f.owned.apps.push(reopened);
    await wait(() => reopened.node.status === "已连接");
    expect(reopened.node.config).toMatchObject({ exec: true, computer: reopened.node.computer.available(), root: "" });
    expect(JSON.parse(String(reopened.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", untouched)?.policy_json)).tools).toContain("device.exec");
    expect(JSON.parse(String(reopened.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", edited)?.policy_json)).tools).not.toContain("device.exec");
    expect(reopened.store.get("SELECT checksum FROM schema_migrations WHERE version=7")?.checksum).toBe(previousHash);
  });
  it("releases an old pending read-only terminal approval after restart and executes its original call once", async () => {
    const f = await fixture(), botId = String(f.bots[1].id);
    await wait(() => f.app.node.status === "已连接");
    // Simulate the former blanket approval at the proposal boundary without
    // changing the immutable arguments, envelope or Pi source entry.
    const propose = f.app.runtime.propose.bind(f.app.runtime);
    f.app.runtime.propose = (worker, event) => {
      const call = propose(worker, event);
      if (call.provider_tool_call_id !== "legacy-pending-query") return call;
      f.app.store.insert("approvals", { id: id(), tool_call_id: call.id, ...f.app.store.scope(), argument_hash: call.argument_hash, bot_policy_version: JSON.parse(String(call.authorization_snapshot_json)).policyVersion, status: "pending", created_at: Date.now(), expires_at: Date.now() + 60_000 });
      f.app.store.run("UPDATE tool_calls SET status='awaiting_approval' WHERE id=?", call.id);
      f.app.store.run("UPDATE tasks SET status='awaiting_approval' WHERE id=?", call.task_id);
      return f.app.store.get("SELECT * FROM tool_calls WHERE id=?", call.id)!;
    };
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "legacy-pending-query", name: "broker", args: JSON.stringify({ action: "device.exec", deviceId: f.app.gateway.hostDeviceId, command: process.platform === "win32" ? "Convert-Path ." : "pwd" }) }] }, { kind: "openai-text", text: "旧版终端查询已继续" });
    const taskId = f.app.agents.send(botId, "合成旧版终端查询", "legacy-pending-query-input").taskId;
    await wait(() => !!approval(f.app));
    const old = approval(f.app);
    expect(f.app.node.journal.prepare("SELECT COUNT(*) n FROM node_calls WHERE capability='device.exec'").get()?.n).toBe(0);
    await f.app.close(); f.owned.apps.splice(0, 1);
    const reopened = await createApp({ dir: path.join(f.root, "core"), key: f.key, token: f.token }); f.owned.apps.push(reopened);
    await wait(() => reopened.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
    expect(reopened.store.get("SELECT status FROM approvals WHERE id=?", old.id)?.status).toBe("cancelled");
    expect(reopened.store.get("SELECT status FROM tool_calls WHERE id=?", old.tool_call_id)?.status).toBe("succeeded");
    expect(reopened.node.journal.prepare("SELECT COUNT(*) n FROM node_calls WHERE capability='device.exec'").get()?.n).toBe(1);
  }, 60_000);
  it("does not silently execute a legacy GUI input whose effect was never classified", async () => {
    const f = await fixture(), botId = String(f.bots[1].id);
    await wait(() => f.app.node.status === "已连接");
    f.app.node.computer.available = () => true;
    f.app.node.configure({ ...f.app.node.config, computer: true });
    await wait(() => f.app.node.status === "已连接" && f.app.gateway.inventory()[0].granted.computer);
    // Simulate the former blanket approval at the proposal boundary without
    // changing the immutable arguments, envelope or Pi source entry.
    const propose = f.app.runtime.propose.bind(f.app.runtime);
    f.app.runtime.propose = (worker, event) => {
      const call = propose(worker, event);
      if (call.provider_tool_call_id !== "legacy-pending-gui") return call;
      f.app.store.insert("approvals", { id: id(), tool_call_id: call.id, ...f.app.store.scope(), argument_hash: call.argument_hash, bot_policy_version: JSON.parse(String(call.authorization_snapshot_json)).policyVersion, status: "pending", created_at: Date.now(), expires_at: Date.now() + 60_000 });
      f.app.store.run("UPDATE tool_calls SET status='awaiting_approval' WHERE id=?", call.id);
      f.app.store.run("UPDATE tasks SET status='awaiting_approval' WHERE id=?", call.task_id);
      return f.app.store.get("SELECT * FROM tool_calls WHERE id=?", call.id)!;
    };
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "legacy-pending-gui", name: "broker", args: JSON.stringify({ action: "device.computer", deviceId: f.app.gateway.hostDeviceId, operation: "press_key", parameters: { pid: 999999, window_id: 777777, key: "Enter" } }) }] }, { kind: "openai-text", text: "合成旧操作未执行" });
    const taskId = f.app.agents.send(botId, "合成旧版未知影响输入", "legacy-pending-gui-input").taskId;
    await wait(() => !!approval(f.app));
    const old = approval(f.app);
    expect(f.app.node.journal.prepare("SELECT COUNT(*) n FROM node_calls WHERE capability='device.computer'").get()?.n).toBe(0);
    await f.app.close(); f.owned.apps.splice(0, 1);
    const reopened = await createApp({ dir: path.join(f.root, "core"), key: f.key, token: f.token }); f.owned.apps.push(reopened);
    expect(reopened.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status).toBe("awaiting_approval");
    expect(reopened.store.get("SELECT status FROM approvals WHERE id=?", old.id)?.status).toBe("pending");
    expect(reopened.store.get("SELECT status FROM tool_calls WHERE id=?", old.tool_call_id)?.status).toBe("awaiting_approval");
    expect(reopened.node.journal.prepare("SELECT COUNT(*) n FROM node_calls WHERE capability='device.computer'").get()?.n).toBe(0);
  }, 60_000);
  it("reads generic bundled skills without agents by profession and keeps edited restrictions during migration", async () => {
    const f = await fixture(), botId = String(f.bots[1].id);
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "skills", name: "broker", args: JSON.stringify({ action: "skill.list" }) }] }, { kind: "openai-tool", calls: [{ id: "read-skill", name: "broker", args: JSON.stringify({ action: "skill.read", skillId: "devices" }) }] }, { kind: "openai-text", text: "设备技能已读" });
    const taskId = f.app.agents.send(botId, "了解内置技能", "skills-input").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded"); await wait(() => !f.app.runtime.workers.size);
    const skills = JSON.parse(String(f.app.store.get("SELECT result_json FROM tool_calls WHERE task_id=? AND tool_name='skill.list'", taskId)?.result_json));
    expect(skills.skills.map((skill: { id: string }) => skill.id)).toEqual(["devices", "computer", "memory", "collaboration", "routines"]);
    expect(String(f.app.store.get("SELECT result_json FROM tool_calls WHERE task_id=? AND tool_name='skill.read'", taskId)?.result_json)).toContain("主设备会自动登记");
    f.app.agents.updatePolicy({ id: botId, version: 1, tools: ["agent.directory"] });
    f.app.store.run("DELETE FROM schema_migrations WHERE version=7");
    await f.app.close(); f.owned.apps.splice(0, 1);
    const reopened = await createApp({ dir: path.join(f.root, "core"), key: f.key, token: f.token }); f.owned.apps.push(reopened);
    expect(JSON.parse(String(reopened.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", botId)?.policy_json)).tools).toEqual(["agent.directory"]);
  }, 60_000);
  it("runs ordinary computer input automatically and approves dangerous effects only in the executing Agent, returning screenshot images to the vision model", async () => {
    const f = await fixture(), botId = String(f.bots[1].id);
    await wait(() => f.app.node.status === "已连接");
    f.app.node.computer.available = () => true;
    const executed: string[] = [];
    f.app.node.computer.execute = async (operation) => { executed.push(operation); return { text: operation === "get_window_state" ? "合成窗口" : "合成输入已执行", images: operation === "get_window_state" ? [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSu8AAAAASUVORK5CYII=" }] : [], isError: false, errorCode: undefined, structured: undefined }; };
    f.app.node.configure({ ...f.app.node.config, computer: true });
    await wait(() => f.app.node.status === "已连接" && f.app.gateway.inventory()[0].granted.computer);
    const deviceId = f.app.gateway.hostDeviceId;
    const parameters = { pid: 123, window_id: 456 };
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "observe", name: "broker", args: JSON.stringify({ action: "device.computer", deviceId, operation: "get_window_state", parameters }) }] }, { kind: "openai-text", text: "合成窗口已观察" });
    const observed = f.app.agents.send(botId, "观察合成窗口", "computer-observe").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", observed)?.status === "succeeded"); await wait(() => !f.app.runtime.workers.size);
    const messages = JSON.parse(f.fake.requests.at(-1)!.body).messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(messages)).toContain("data:image/png;base64,");
    expect(f.app.store.all("SELECT * FROM approvals")).toHaveLength(0);
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "input", name: "broker", args: JSON.stringify({ action: "device.computer", deviceId, operation: "type_text", parameters: { ...parameters, text: "合成文本" } }) }] }, { kind: "openai-text", text: "输入结果已处理" });
    const input = f.app.agents.send(botId, "输入合成文本", "computer-input").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", input)?.status === "succeeded"); await wait(() => !f.app.runtime.workers.size);
    expect(executed).toEqual(["get_window_state", "type_text"]);
    expect(f.app.store.all("SELECT * FROM approvals")).toHaveLength(0);
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "denied", name: "broker", args: JSON.stringify({ action: "device.computer", deviceId, risk: "dangerous", riskReason: "合成危险提交", operation: "press_key", parameters: { ...parameters, key: "Enter" } }) }] }, { kind: "openai-text", text: "未执行输入" });
    const deniedTask = f.app.agents.send(botId, "合成拒绝输入", "computer-denied").taskId;
    await wait(() => !!approval(f.app)); const denied = approval(f.app); expect(f.app.store.get("SELECT bot_id FROM tool_calls WHERE id=?", denied.tool_call_id)?.bot_id).toBe(botId); f.app.runtime.decide(String(denied.id), String(denied.argument_hash), false);
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", deniedTask)?.status === "succeeded");
    expect(executed).toEqual(["get_window_state", "type_text"]);
    await wait(() => !f.app.runtime.workers.size);
    f.app.node.computer.execute = async () => ({ unknown: true, error: "合成 Native 输入中断", images: [] });
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "unknown-input", name: "broker", args: JSON.stringify({ action: "device.computer", deviceId, operation: "type_text", parameters: { ...parameters, text: "合成不确定输入" } }) }] });
    const unknownTask = f.app.agents.send(botId, "合成中断输入", "computer-unknown").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", unknownTask)?.status === "needs_reconciliation");
    expect(f.app.node.publicState().unknownCalls).toHaveLength(1);
    expect(f.app.store.get("SELECT status FROM tool_calls WHERE task_id=?", unknownTask)?.status).toBe("unknown");
  }, 60_000);
  it("forgets a task-derived routine, its receipt and future wakeup along with the source message", async () => {
    const f = await fixture(), botId = String(f.bots[1].id);
    const args = { action: "routine.save", name: "合成待忘计划", prompt: "记得合成银杉会面地点", scheduleKind: "once", delaySeconds: 120 };
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "forget-routine", name: "broker", args: JSON.stringify(args) }] }, { kind: "openai-text", text: "合成银杉计划已建立" });
    const task = f.app.agents.send(botId, "合成银杉会面，两分钟后提醒", "forget-routine-input").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded"); await wait(() => !f.app.runtime.workers.size);
    const plan = f.app.runtime.memory.privacy.preview(botId, { query: "合成银杉" });
    f.app.runtime.memory.forget(botId, { query: "合成银杉" }, plan.revision);
    expect(f.app.routines.list()[0]).toMatchObject({ enabled: 0, prompt: "[已遗忘]", name: "[已遗忘]", next_due_at: null });
    expect(f.app.store.get("SELECT result_json FROM routine_tool_receipts")?.result_json).toBe('{"forgotten":true}');
    f.app.routines.tick(Date.now() + 130_000);
    expect(f.app.store.all("SELECT * FROM routine_occurrences")).toHaveLength(0);
  }, 60_000);
  it.skipIf(!process.env.NEX_TEST_LEGACY_04_BUNDLE)("migrates a 0.4 Core in place, upgrading standard policies and preserving custom restrictions and memory", async () => {
    const f = await fixture(), dir = path.join(f.root, "legacy-migration");
    const legacy = (await import(pathToFileURL(path.resolve(process.env.NEX_TEST_LEGACY_04_BUNDLE!)).href)).createPersonalApp;
    const old = await legacy({ dir, key: f.key, token: f.token, memoryRuntime: false });
    let standard: string, restricted: string, original: string, edited: string;
    try {
      standard = old.store.createBot("合成标准 Agent"); restricted = old.store.createBot("合成受限 Agent");
      original = old.store.createBot("合成最早默认 Agent"); edited = old.store.createBot("合成手改旧配置 Agent");
      const originalTools = ["memory.search", "memory.read", "memory.write", "agent.delegate", "device.read", "device.list", "device.exec"];
      old.store.run("UPDATE bot_policies SET policy_json=? WHERE bot_id=?", JSON.stringify({ tools: originalTools }), original);
      old.agents.updatePolicy({ id: edited, version: 1, tools: originalTools });
      old.agents.updatePolicy({ id: restricted, version: 1, tools: ["agent.directory"] });
      old.runtime.memory.write(standard, { title: "合成旧记忆", content: "旧记忆应保留" });
    } finally { await old.close(); }
    const upgraded = await createApp({ dir, key: f.key, token: f.token }); f.owned.apps.push(upgraded);
    expect(upgraded.store.get("SELECT MAX(version) version FROM schema_migrations")?.version).toBe(8);
    expect(JSON.parse(String(upgraded.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", standard!)?.policy_json)).tools).toContain("routine.save");
    expect(JSON.parse(String(upgraded.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", restricted!)?.policy_json)).tools).toEqual(["agent.directory"]);
    expect(JSON.parse(String(upgraded.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", original!)?.policy_json)).tools).toContain("routine.save");
    expect(JSON.parse(String(upgraded.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", edited!)?.policy_json)).tools).not.toContain("routine.save");
    expect(upgraded.runtime.memory.list(standard!).some((m) => m.title === "合成旧记忆")).toBe(true);
    expect(upgraded.store.all("PRAGMA foreign_key_check")).toEqual([]);
  });
  it("runs a thin Device Node without a Core database, grants only its own directory and requires execution approval in the Agent feed", async () => {
    const f = await fixture(), shared = path.join(f.root, "thin-shared"), dir = path.join(f.root, "thin-client"); mkdirSync(shared); writeFileSync(path.join(shared, "client.txt"), "合成客户端文件");
    const startNode: typeof createClientNode = process.env.NEX_TEST_CLIENT_BUNDLE ? (await import(pathToFileURL(path.resolve(process.env.NEX_TEST_CLIENT_BUNDLE)).href)).createClientNode : createClientNode;
    const client = startNode(dir, randomBytes(32), () => {}, f.app.origin);
    try {
      const pair = f.app.gateway.pair("Thin fixture"); client.node.configure({ origin: f.app.origin, token: pair.token, root: shared });
      await wait(() => client.node.status === "已连接");
      expect(client.node.publicState()).toMatchObject({ exec: true, computer: client.node.computer.available() });
      expect(existsSync(path.join(dir, "core.db"))).toBe(false); expect(existsSync(path.join(dir, "memory"))).toBe(false);
      f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "thin-read", name: "broker", args: JSON.stringify({ action: "device.read", deviceId: pair.deviceId, path: "client.txt" }) }] }, { kind: "openai-text", text: "合成文件已读" });
      const readTask = f.app.agents.send(String(f.bots[0].id), "读客户端文件", "thin-read-input").taskId;
      await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", readTask)?.status === "succeeded");
      expect(String(f.app.store.get("SELECT result_json FROM tool_calls WHERE task_id=?", readTask)?.result_json)).toContain("合成客户端文件");
      await wait(() => !f.app.runtime.workers.size);
      f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "thin-exec", name: "broker", args: JSON.stringify({ action: "device.exec", deviceId: pair.deviceId, command: "Set-Content -LiteralPath marker.txt -Value synthetic" }) }] }, { kind: "openai-text", text: "合成命令已批准执行" });
      const taskId = f.app.agents.send(String(f.bots[0].id), "执行客户端命令", "thin-exec-input").taskId;
      await wait(() => !!approval(f.app));
      expect(existsSync(path.join(shared, "marker.txt"))).toBe(false);
      const grant = approval(f.app); f.app.runtime.decide(String(grant.id), String(grant.argument_hash), true);
      await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
      expect(readFileSync(path.join(shared, "marker.txt"), "utf8").trim()).toBe("synthetic");
      expect(approval(f.app)).toBeUndefined();
    } finally { await client.close(); }
  }, 60_000);
  it("creates a generic chat routine with a Core-relative deadline and survives a lost acknowledgement without duplicating it", async () => {
    const f = await fixture(), botId = String(f.bots[1].id), start = Date.now();
    const args = { action: "routine.save", name: "合成两分钟提醒", prompt: "发送合成你好", scheduleKind: "once", delaySeconds: 120 };
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "fixture-schedule", name: "broker", args: JSON.stringify(args) }] }, { kind: "openai-text", text: "已安排两分钟后的提醒" });
    const taskId = f.app.agents.send(botId, "两分钟后向我问好", "fixture-schedule-input").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
    const row = f.app.store.get("SELECT * FROM agent_routines WHERE bot_id=?", botId)!;
    expect(Number(row.next_due_at)).toBeGreaterThanOrEqual(start + 120_000);
    expect(Number(row.next_due_at)).toBeLessThan(Date.now() + 120_100);
    expect(f.app.store.all("SELECT * FROM approvals")).toHaveLength(0);
    const call = f.app.store.get("SELECT * FROM tool_calls WHERE task_id=?", taskId)!;
    expect(f.app.routines.tool(call, args)).toMatchObject({ scheduled: true });
    expect(f.app.store.all("SELECT * FROM agent_routines")).toHaveLength(1);
    expect(() => f.app.routines.tool({ ...call, argument_hash: "different" }, args)).toThrow("身份冲突");
    await wait(() => !f.app.runtime.workers.size);
    f.fake.scripts.push({ kind: "openai-text", text: "合成你好，到时间了" });
    f.app.routines.tick(Number(row.next_due_at));
    await wait(() => f.app.store.get("SELECT status FROM routine_occurrences")?.status === "succeeded" || f.app.store.get("SELECT status FROM tasks WHERE id=(SELECT task_id FROM routine_occurrences)")?.status === "succeeded");
    expect(f.app.agents.messages(botId).some((m) => m.content === "合成你好，到时间了")).toBe(true);
    expect(f.app.store.all("SELECT * FROM routine_occurrences")).toHaveLength(1);
  }, 60_000);
  it("issues independent client sessions, preserves them through Core restart, rejects device credentials and revokes one client only", async () => {
    const f = await fixture();
    const owner = { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" };
    const invite = await (await fetch(f.app.origin + "/api/clients/invite", { method: "POST", headers: owner, body: JSON.stringify({ name: "合成设备" }) })).json() as { code: string };
    const login = async (code: string) => await fetch(f.app.origin + "/api/client/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "合成客户端" }) });
    type Session = { token: string; sessionId: string; coreId: string };
    const one = await (await login(invite.code)).json() as Session;
    expect(one.sessionId).toBeTruthy(); expect((await login(invite.code)).status).toBe(400);
    const secondInvite = await (await fetch(f.app.origin + "/api/clients/invite", { method: "POST", headers: owner, body: JSON.stringify({ name: "合成第二设备" }) })).json() as { code: string };
    const two = await (await login(secondInvite.code)).json() as Session;
    expect(one.sessionId).not.toBe(two.sessionId);
    const device = f.app.gateway.pair("合成设备节点");
    expect((await fetch(f.app.origin + "/api/state", { headers: { Authorization: `Bearer ${device.token}` } })).status).toBe(401);
    const coreId = one.coreId;
    await f.app.close(); f.owned.apps.splice(0, 1);
    const restarted = await createApp({ dir: path.join(f.root, "core"), key: f.key, token: "new-synthetic-boot-token" }); f.owned.apps.push(restarted);
    for (const client of [one, two]) {
      const response = await fetch(restarted.origin + "/api/state", { headers: { Authorization: `Bearer ${client.token}` } });
      expect(response.status).toBe(200); expect((await response.json() as { sync: { coreId: string } }).sync.coreId).toBe(coreId);
    }
    await fetch(restarted.origin + "/api/clients/revoke", { method: "POST", headers: { ...owner, Authorization: "Bearer new-synthetic-boot-token" }, body: JSON.stringify({ sessionId: one.sessionId }) });
    expect((await fetch(restarted.origin + "/api/state", { headers: { Authorization: `Bearer ${one.token}` } })).status).toBe(401);
    expect((await fetch(restarted.origin + "/api/state", { headers: { Authorization: `Bearer ${two.token}` } })).status).toBe(200);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest(restarted.origin + "/api/state", { headers: { Authorization: `Bearer ${two.token}`, Host: "attacker.example" } }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); }); request.once("error", reject); request.end(); });
    expect(wrongHost).toBe(403);
    expect((await fetch(restarted.origin + "/api/clients/invite", { method: "POST", headers: { ...owner, Authorization: `Bearer ${two.token}`, Origin: "https://attacker.example" }, body: JSON.stringify({ name: "bad" }) })).status).toBe(403);
  });
  it("replays a message gap larger than one page and advances the privacy fence when an old message is redacted", async () => {
    const f = await fixture(), botId = String(f.bots[1].id);
    for (let i = 0; i < 450; i++) f.app.agents.publish(botId, "assistant", "message", `合成消息 ${i}`, `sync-fixture:${i}`);
    const headers = { Authorization: `Bearer ${f.token}` };
    type SyncState = { sync: { privacyEpoch: number; cursor: number } };
    const state = await (await fetch(f.app.origin + "/api/state", { headers })).json() as SyncState;
    let after = 0; const seen: string[] = [];
    for (let page = 0; page < 3; page++) {
      const feed = await (await fetch(f.app.origin + `/api/agents/messages?bot=${botId}&after=${after}`, { headers })).json() as { messages: Array<{ id: string; seq: number }>; hasMore: boolean };
      seen.push(...feed.messages.map((m: { id: string }) => m.id)); after = Number(feed.messages.at(-1)?.seq);
      if (!feed.hasMore) break;
    }
    expect(seen).toHaveLength(450); expect(new Set(seen).size).toBe(450);
    const first = f.app.store.get("SELECT id FROM agent_messages WHERE bot_id=? AND seq=1", botId)!;
    f.app.store.run("UPDATE agent_messages SET content='[已遗忘]' WHERE id=?", first.id);
    const newer = await (await fetch(f.app.origin + "/api/state", { headers })).json() as SyncState;
    expect(newer.sync.privacyEpoch).toBeGreaterThan(state.sync.privacyEpoch); expect(newer.sync.cursor).toBeGreaterThan(state.sync.cursor);
    const abort = new AbortController();
    const stream = await fetch(f.app.origin + "/api/events?after=999999999", { headers, signal: abort.signal });
    const chunk = await stream.body!.getReader().read(); abort.abort();
    expect(Buffer.from(chunk.value!).toString()).toContain('"reset":true');
    expect(f.app.store.all("SELECT * FROM sync_events").every((event) => !JSON.stringify(event).includes("合成消息"))).toBe(true);
  });
  it("forgets causal A2A copies and Pi context, then reapplies tombstones to an older restored Core database", async () => {
    const f = await fixture(), sender = String(f.bots[0].id), peer = String(f.bots[1].id);
    const memory = f.app.runtime.memory;
    const note = memory.write(sender, { title: "合成计划", content: "雪鹭计划在周二举行会议" });
    const retained = memory.write(peer, { title: "无关记忆", content: "同伴喜欢盆栽" });
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "forget-a2a", name: "broker", args: JSON.stringify({ action: "agent.delegate", botId: peer, message: "请整理雪鹭会议计划" }) }] }, { kind: "openai-text", text: "雪鹭计划是周二开会" }, { kind: "openai-text", text: "同伴确认雪鹭计划周二开会" });
    const task = f.app.agents.send(sender, "请同伴确认会议安排", "forget-source-owner").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded"); await wait(() => !f.app.runtime.workers.size);
    const link = f.app.store.get("SELECT * FROM a2a_messages")!;
    const old = path.join(f.root, "before-forget.db"); f.app.store.db.exec(`VACUUM INTO '${old.replace(/'/g, "''")}'`);
    const selector = { documentId: note.documentId }, plan = memory.privacy.preview(sender, selector);
    expect(plan.tasks).toContain(link.child_task_id); expect(plan.bots).toContain(peer);
    memory.forget(sender, selector, plan.revision);
    expect(f.app.agents.search(peer, "雪鹭")).toEqual([]);
    expect(f.app.store.all("SELECT * FROM transcript WHERE content LIKE '%雪鹭%' OR content LIKE '%周二%'")).toHaveLength(0);
    expect(f.app.store.all("SELECT payload,result FROM a2a_messages").every((row) => !JSON.stringify(row).includes("雪鹭"))).toBe(true);
    expect(f.app.runtime.projection.db.prepare("SELECT COUNT(*) n FROM projections").get()?.n).toBe(0);
    expect(memory.read(peer, String(retained.documentId)).content).toBe("同伴喜欢盆栽");
    expect(() => f.app.store.run("UPDATE conversation_inputs SET content_json='{}' WHERE task_id=?", task)).toThrow("immutable");
    await f.app.close(); f.owned.apps.splice(f.owned.apps.indexOf(f.app), 1);
    const core = path.join(f.root, "core", "core.db");
    for (const file of [core + "-wal", core + "-shm"]) if (existsSync(file)) unlinkSync(file);
    copyFileSync(old, core);
    const restored = await createApp({ dir: path.join(f.root, "core"), key: f.key, token: f.token }); f.owned.apps.push(restored);
    expect(restored.agents.search(sender, "雪鹭")).toEqual([]); expect(restored.agents.search(peer, "雪鹭")).toEqual([]);
    expect(restored.runtime.memory.list(sender).some((row) => row.id === note.documentId)).toBe(false);
    expect(restored.store.all("SELECT * FROM memory_forgotten_tasks").length).toBeGreaterThan(1);
    expect(restored.store.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(f.fake.requests).toHaveLength(3);
  }, 60_000);
  it("starts empty, creates arbitrary Agent instances explicitly and never reseeds after archiving the last one", async () => {
    const f = await fixture();
    // The fixture helper creates its synthetic contacts explicitly. A second
    // clean Core uses precisely the production initialization path.
    const dir = path.join(f.root, "empty-core");
    const empty = await createApp({ dir, key: f.key, token: f.token }); f.owned.apps.push(empty);
    expect(empty.agents.contacts()).toEqual([]);
    expect(empty.store.all("SELECT * FROM tasks")).toEqual([]);
    const botId = empty.store.createBot("任意名字", "");
    expect(empty.agents.contacts()).toHaveLength(1);
    expect(empty.store.get("SELECT instructions FROM bots WHERE id=?", botId)?.instructions).toBe("");
    expect(JSON.parse(String(empty.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", botId)?.policy_json)).tools).toContain("device.exec");
    empty.runtime.memory.write(botId, { title: "独立记忆", content: "沿用稳定身份" });
    empty.agents.updateProfile({ id: botId, name: "另一个任意名字", instructions: "", version: 1 });
    expect(empty.runtime.memory.prompt(botId)).toContain("沿用稳定身份");
    empty.agents.archive({ id: botId, version: 2 });
    expect(empty.agents.contacts()).toEqual([]);
    await empty.close(); f.owned.apps.splice(f.owned.apps.indexOf(empty), 1);
    const reopened = await createApp({ dir, key: f.key, token: f.token }); f.owned.apps.push(reopened);
    expect(reopened.agents.contacts()).toEqual([]);
    expect(reopened.store.all("SELECT * FROM bots")).toHaveLength(1);
    expect(reopened.runtime.memory.prompt(botId)).toContain("沿用稳定身份");
    expect(f.fake.requests).toHaveLength(0);
  });
  it("automatically consults a peer with its own memory and grants, approving dangerous effects only in that peer", async () => {
    const f = await fixture(), source = String(f.bots[0].id), peer = String(f.bots[1].id);
    const cleanup = pendingCleanup(f.app, peer);
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "auto-peer-risk", name: "broker", args: JSON.stringify({ action: "agent.delegate", botId: peer, message: "清理你自己的指定测试记忆" }) }] }, { kind: "openai-tool", calls: [{ id: "peer-risk", name: "broker", args: JSON.stringify(cleanup) }] });
    // The sender lacks delete; the peer uses its independently granted tool.
    f.app.agents.updatePolicy({ id: source, version: 2, tools: ["agent.delegate", "agent.directory", "memory.search", "memory.read"] });
    const task = f.app.agents.send(source, "请联系合适同伴处理", "peer-risk-owner").taskId;
    await wait(() => !!approval(f.app));
    const pending = approval(f.app), call = f.app.store.get("SELECT * FROM tool_calls WHERE id=?", pending.tool_call_id)!;
    expect(call.bot_id).toBe(peer); expect(call.tool_name).toBe("memory.delete");
    expect(f.app.store.all("SELECT * FROM approvals")).toHaveLength(1);
    expect(f.app.store.get("SELECT status FROM tool_calls WHERE provider_tool_call_id='auto-peer-risk'")?.status).toBe("executing");
    f.fake.scripts.push({ kind: "openai-text", text: "已清理测试记忆" }, { kind: "openai-text", text: "同伴已经处理" });
    f.app.runtime.decide(String(pending.id), String(pending.argument_hash), true);
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    expect(f.app.store.get("SELECT status FROM memory_documents WHERE id=?", cleanup.documentId)?.status).toBe("deleted");
  }, 40_000);
  it("creates a named Agent without supplementary identity and accepts clearing it through the public API", async () => {
    const f = await fixture();
    const post = (route: string, data: unknown) => fetch(f.app.origin + "/api/" + route, { method: "POST", headers: { Authorization: "Bearer " + f.token, "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const response = await post("bots", { name: "私人秘书" }); expect(response.status).toBe(200);
    const { id: botId } = await response.json() as { id: string };
    expect(f.app.store.get("SELECT instructions FROM bots WHERE id=?", botId)?.instructions).toBe("");
    const saved = await post("bots/update", { id: botId, name: "我的私人秘书", instructions: "  \n  ", version: 1 }); expect(saved.status).toBe(200);
    expect(f.app.agents.messages(botId)).toHaveLength(0);
    const stale = await post("bots/update", { id: botId, name: "旧资料", version: 1 }); expect(stale.status).toBe(400);
    const invalid = await post("bots/update", { id: botId, name: "无效资料", instructions: 42, version: 2 }); expect(invalid.status).toBe(400);
    expect(f.app.store.get("SELECT name,instructions FROM bots WHERE id=?", botId)).toEqual({ name: "我的私人秘书", instructions: "" });
    f.fake.scripts.push({ kind: "openai-text", text: "我会按照私人秘书的身份工作" });
    const task = f.app.agents.send(botId, "你叫什么，是什么身份？", "named-agent").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    const prompt = JSON.parse(f.fake.requests[0].body).messages.find((m: { role: string }) => m.role === "system").content;
    expect(prompt).toContain('"name":"我的私人秘书"'); expect(prompt).toContain('"instructions":""');
  }, 40_000);
  it("silently refreshes self and peer identity in a running worker after approval, retaining IDs, privacy and restart continuity", async () => {
    const f = await fixture(), botId = String(f.bots[0].id), peerId = String(f.bots[1].id);
    const update = async (target: string, name: string, instructions: string) => {
      const version = f.app.store.get("SELECT version FROM bots WHERE id=?", target)!.version;
      const response = await fetch(f.app.origin + "/api/bots/update", { method: "POST", headers: { Authorization: "Bearer " + f.token, "Content-Type": "application/json" }, body: JSON.stringify({ id: target, name, instructions, version }) });
      expect(response.status).toBe(200);
    };
    await update(botId, "OLD_SELF_NAME", "OLD_SELF_IDENTITY"); await update(peerId, "OLD_PEER_NAME", "OLD_PEER_IDENTITY");
    f.app.runtime.memory.write(peerId, { title: "不共享的记忆", content: "PEER_PRIVATE_IDENTITY_TEST", scope: "bot" });
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "identity-pending", name: "broker", args: JSON.stringify(pendingCleanup(f.app, String(f.bots[0].id))) }] });
    const task = f.app.agents.send(botId, "完成一项需要批准的工作", "identity-task").taskId;
    await wait(() => !!approval(f.app));
    const pending = approval(f.app), worker = f.app.runtime.workers.get(task), before = f.app.agents.messages(botId).map((m) => m.id);
    const policyVersion = f.app.store.get("SELECT version FROM bot_policies WHERE bot_id=?", botId)!.version;
    await update(botId, "新私人秘书", ""); await update(peerId, "新研究助手", "最新研究身份，专长材料化学");
    expect(f.app.runtime.workers.get(task)).toBe(worker);
    expect(f.app.agents.messages(botId).map((m) => m.id)).toEqual(before);
    expect(f.app.agents.messages(peerId)).toHaveLength(0);
    expect(f.fake.requests).toHaveLength(1);
    expect(f.app.store.get("SELECT version FROM bot_policies WHERE bot_id=?", botId)?.version).toBe(policyVersion);
    f.fake.scripts.push({ kind: "openai-text", text: "使用更新后的身份完成工作" });
    f.app.runtime.decide(String(pending.id), String(pending.argument_hash), true);
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    const systems = JSON.parse(f.fake.requests[1].body).messages.filter((m: { role: string }) => m.role === "system" || m.role === "developer");
    expect(systems).toHaveLength(1);
    expect(systems[0].content).toContain('"name":"新私人秘书"'); expect(systems[0].content).toContain("新研究助手"); expect(systems[0].content).toContain("最新研究身份");
    expect(systems[0].content).not.toContain("OLD_SELF_"); expect(systems[0].content).not.toContain("OLD_PEER_");
    expect(f.fake.requests[1].body).not.toContain("PEER_PRIVATE_IDENTITY_TEST");
    const dir = f.app.store.dir; await f.app.close(); f.owned.apps.splice(0);
    const restored = await createApp({ dir, key: f.key, token: f.token }); f.owned.apps.push(restored);
    expect(restored.store.get("SELECT name FROM bots WHERE id=?", botId)?.name).toBe("新私人秘书");
    f.fake.scripts.push({ kind: "openai-text", text: "重启后仍认识更新后的同伴" });
    const next = restored.agents.send(peerId, "确认自己的身份和同伴", "identity-restarted").taskId;
    await wait(() => restored.store.get("SELECT status FROM tasks WHERE id=?", next)?.status === "succeeded");
    expect(f.fake.requests[2].body).toContain("新私人秘书"); expect(f.fake.requests[2].body).toContain("新研究助手");
    expect(restored.store.all("PRAGMA foreign_key_check")).toEqual([]);
  }, 50_000);
  it("keeps an Agent inbox across independent goals and restart, with private history and exact input receipts", async () => {
    const f = await fixture(), botId = String(f.bots[0].id);
    f.app.agents.publish(String(f.bots[1].id), "user", "message", "OTHER_CONTACT_PRIVATE", "other-private");
    f.fake.scripts.push({ kind: "openai-text", text: "已分析材料 A，记录结论 ALPHA_RESULT" });
    const first = f.app.agents.send(botId, "分析材料 A", "persistent-message").taskId;
    expect(f.app.agents.send(botId, "分析材料 A", "persistent-message").taskId).toBe(first);
    expect(() => f.app.agents.send(botId, "不同内容", "persistent-message")).toThrow("内容不同");
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", first)?.status === "succeeded");
    f.fake.scripts.push({ kind: "openai-text", text: "基于上次结论安排下一步" });
    const second = f.app.agents.send(botId, "基于上次结论安排下一步", "next-goal").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", second)?.status === "succeeded");
    expect(f.app.store.get("SELECT conversation_id FROM tasks WHERE id=?", first)?.conversation_id).not.toBe(f.app.store.get("SELECT conversation_id FROM tasks WHERE id=?", second)?.conversation_id);
    expect(f.fake.requests[1].body).toContain("ALPHA_RESULT");
    expect(f.fake.requests[1].body).not.toContain("OTHER_CONTACT_PRIVATE");
    expect(f.app.agents.search(botId, "OTHER_CONTACT_PRIVATE")).toHaveLength(0);
    const messages = f.app.agents.messages(botId); expect(messages).toHaveLength(4);
    f.app.agents.read(botId, Number(messages.at(-1)!.seq));
    const dir = f.app.store.dir; await f.app.close(); f.owned.apps.splice(0);
    const restored = await createApp({ dir, key: f.key, token: f.token }); f.owned.apps.push(restored);
    expect(restored.agents.messages(botId).map((m) => m.id)).toEqual(messages.map((m) => m.id));
    expect(restored.agents.contacts().find((b) => b.id === botId)?.unread_count).toBe(0);
    expect(restored.store.all("SELECT * FROM agent_journal WHERE bot_id=?", botId)).toHaveLength(2);
    expect(restored.agents.send(botId, "分析材料 A", "persistent-message").taskId).toBe(first);
    expect(f.fake.requests).toHaveLength(2);
  }, 40_000);
  it("wakes an Agent from a durable routine without a user message and never repeats an occurrence after restart", async () => {
    const f = await fixture(), botId = String(f.bots[0].id), due = Date.now() + 60_000;
    f.app.routines.save({ botId, name: "工作汇报", prompt: "整理工作并汇报", scheduleKind: "once", runAt: due, timeZone: "Asia/Shanghai" });
    f.fake.scripts.push({ kind: "openai-text", text: "例行任务主动汇报成功" });
    f.app.routines.tick(due); f.app.routines.tick(due);
    await wait(() => f.app.agents.messages(botId).some((m) => m.content === "例行任务主动汇报成功"));
    f.app.routines.tick(due + 1);
    expect(f.app.store.all("SELECT * FROM routine_occurrences")).toHaveLength(1);
    expect(f.app.store.all("SELECT * FROM routine_occurrences")[0].status).toBe("succeeded");
    const dir = f.app.store.dir; await f.app.close(); f.owned.apps.splice(0);
    const restored = await createApp({ dir, key: f.key, token: f.token }); f.owned.apps.push(restored);
    restored.routines.tick(due + 2);
    expect(f.fake.requests).toHaveLength(1);
    expect(restored.agents.messages(botId).filter((m) => m.content === "例行任务主动汇报成功")).toHaveLength(1);
  }, 40_000);
  it("queues routines behind approvals and cancels undispatched occurrences when paused", async () => {
    const f = await fixture(), botId = String(f.bots[0].id);
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "owner-pending", name: "broker", args: JSON.stringify(pendingCleanup(f.app, String(f.bots[0].id))) }] });
    const task = f.app.agents.send(botId, "记住一件事", "pending-owner").taskId;
    await wait(() => !!approval(f.app));
    const routine = f.app.routines.save({ botId, name: "排队任务", prompt: "不要绕过审批", scheduleKind: "interval", intervalMinutes: 1 });
    const row = f.app.store.get("SELECT * FROM agent_routines WHERE id=?", routine.id)!;
    f.app.routines.tick(Number(row.next_due_at));
    expect(f.app.store.all("SELECT * FROM tasks WHERE ended_at IS NULL")).toHaveLength(1);
    expect(f.app.store.get("SELECT status FROM routine_occurrences")?.status).toBe("pending");
    f.app.routines.toggle(routine.id, Number(row.version), false);
    expect(f.app.store.get("SELECT status FROM routine_occurrences")?.status).toBe("cancelled");
    expect(f.fake.requests).toHaveLength(1);
    f.app.runtime.cancel(task);
  }, 40_000);
  it("publishes peer requests and replies in both Agent inboxes, retaining isolated child execution", async () => {
    const f = await fixture(), botId = String(f.bots[0].id), peer = String(f.bots[1].id);
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "contact-peer", name: "broker", args: JSON.stringify({ action: "agent.delegate", botId: peer, message: "只分享批准的目标" }) }] }, { kind: "openai-text", text: "同伴工作结果" }, { kind: "openai-text", text: "收到同伴结果，工作完成" });
    const task = f.app.agents.send(botId, "让 Beta 协助", "contact-task").taskId;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    expect(f.app.agents.messages(peer).some((m) => m.role === "peer" && m.content === "只分享批准的目标")).toBe(true);
    expect(f.app.agents.messages(botId).some((m) => m.role === "peer" && m.content === "同伴工作结果")).toBe(true);
    expect(f.app.agents.messages(botId).find((m) => m.a2a_direction === "returned")?.a2a_peer_id).toBe(peer);
    expect(f.app.agents.messages(peer).find((m) => m.a2a_direction === "received")?.a2a_peer_id).toBe(botId);
    const reply = f.app.agents.messages(peer).find((m) => m.a2a_direction === "replied")!;
    expect(reply.role).toBe("assistant"); expect(reply.content).toBe("同伴工作结果"); expect(reply.a2a_peer_id).toBe(botId); expect(reply.sender_bot_id).toBeNull();
    expect(f.app.store.get("SELECT role,content FROM agent_messages WHERE id=?", reply.id)).toEqual({ role: "assistant", content: "同伴工作结果" });
    const before = f.app.agents.messages(botId).length; f.app.runtime.completeDelegations(); expect(f.app.agents.messages(botId)).toHaveLength(before);
    expect(f.app.store.all("SELECT * FROM a2a_messages")).toHaveLength(1);
    // Simulate the old receiver-side system description. The read projection
    // shows an own reply without rewriting history or publishing a new record.
    const oldText = "已向 Assistant 返回结果：\n同伴工作结果";
    f.app.store.run("UPDATE agent_messages SET role='system',content=?,sender_bot_id=? WHERE id=?", oldText, botId, reply.id);
    const ids = f.app.agents.messages(peer).map((m) => m.id), dir = f.app.store.dir;
    await f.app.close(); f.owned.apps.splice(0);
    const restored = await createApp({ dir, key: f.key, token: f.token }); f.owned.apps.push(restored);
    const restoredReply = restored.agents.messages(peer).find((m) => m.id === reply.id)!;
    expect(restoredReply.role).toBe("assistant"); expect(restoredReply.content).toBe("同伴工作结果"); expect(restoredReply.seq).toBe(reply.seq); expect(restoredReply.sender_bot_id).toBeNull();
    expect(restored.agents.messages(peer).map((m) => m.id)).toEqual(ids);
    expect(restored.store.get("SELECT role,content FROM agent_messages WHERE id=?", reply.id)).toEqual({ role: "system", content: oldText });
    expect(f.fake.requests).toHaveLength(3);
  }, 40_000);
  it("imports legacy conversation messages once, preserving their old task and context IDs", async () => {
    const f = await fixture(), botId = String(f.bots[0].id);
    f.fake.scripts.push({ kind: "openai-text", text: "旧版已保存的回复" });
    const task = f.app.runtime.input(f.conversation, "旧版消息", "legacy-input");
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    // Simulate a 0.2.x store reaching the new Agent bootstrap for the first time.
    f.app.store.run("DELETE FROM agent_bootstrap");
    const dir = f.app.store.dir; await f.app.close(); f.owned.apps.splice(0);
    let restored = await createApp({ dir, key: f.key, token: f.token }); f.owned.apps.push(restored);
    expect(restored.agents.messages(botId).map((m) => m.content)).toEqual(["旧版消息", "旧版已保存的回复"]);
    expect(restored.store.get("SELECT conversation_id FROM tasks WHERE id=?", task)?.conversation_id).toBe(f.conversation);
    await restored.close(); f.owned.apps.splice(0); restored = await createApp({ dir, key: f.key, token: f.token }); f.owned.apps.push(restored);
    expect(restored.agents.messages(botId)).toHaveLength(2);
  }, 40_000);
  it("handles skipped and repeated local times in daily Agent routines", () => {
    expect(nextDaily("01:30", "America/New_York", Date.UTC(2026, 10, 1, 5, 30))).toBe(Date.UTC(2026, 10, 2, 6, 30));
    expect(nextDaily("02:30", "America/New_York", Date.UTC(2026, 2, 8, 6))).toBe(Date.UTC(2026, 2, 9, 6, 30));
  });
  it("reports the actual model URL on 404 without retrying or exposing the key", async () => {
    const f = await fixture();
    f.app.store.saveConfig({ provider: "openai", endpoint: f.fake.origin + "/gateway", model: "fake", apiKey: "synthetic-model-key" });
    f.fake.scripts.push({ kind: "openai-error", status: 404, message: "not found synthetic-model-key" });
    const task = f.app.runtime.input(f.conversation, "验证错误地址", id());
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "failed");
    const error = String(f.app.store.get("SELECT result_summary FROM tasks WHERE id=?", task)?.result_summary);
    expect(error).toContain("模型服务返回 404");
    expect(error).toContain(f.fake.origin + "/gateway/chat/completions");
    expect(error).toContain("/v1");
    expect(error).not.toContain("synthetic-model-key");
    expect(f.fake.requests).toHaveLength(1);
    expect(f.app.store.get("SELECT status FROM model_invocations")?.status).toBe("failed");
    f.app.store.saveConfig({ provider: "openai", endpoint: f.fake.origin + "/gateway/v1/", model: "fake", apiKey: "" });
    f.fake.scripts.push({ kind: "openai-text", text: "修正地址后连接成功" });
    const next = f.app.runtime.input(f.conversation, "重试", id());
    // The earlier failed task is an expected fixture outcome, so wait on this
    // exact new task rather than the helper's global unexpected-failure guard.
    const deadline = Date.now() + 25_000;
    while (f.app.store.get("SELECT status FROM tasks WHERE id=?", next)?.status === "running" || f.app.store.get("SELECT status FROM tasks WHERE id=?", next)?.status === "queued") {
      if (Date.now() > deadline) throw new Error("Corrected endpoint task timed out");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(f.app.store.get("SELECT status FROM tasks WHERE id=?", next)?.status).toBe("succeeded");
    expect(f.fake.requests[1].url).toBe("/gateway/v1/chat/completions");
  }, 40_000);
  it("records provider failures accurately and redacts the configured key", async () => {
    const f = await fixture();
    f.fake.scripts.push({ kind: "openai-error", status: 401, message: "rejected synthetic-model-key" });
    const task = f.app.runtime.input(f.conversation, "验证失败处理", id());
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "failed");
    expect(JSON.stringify(f.app.store.state())).not.toContain("synthetic-model-key");
    expect(f.app.store.get("SELECT status FROM model_invocations")?.status).toBe("failed");
    expect(f.app.store.get("SELECT result_summary FROM tasks WHERE id=?", task)?.result_summary).toContain("[redacted]");
  }, 40_000);
  it("uses the same fixed runtime with Anthropic API protocol", async () => {
    const f = await fixture();
    f.app.agents.updateProfile({ id: f.bots[0].id, name: "Anthropic 私人秘书", version: f.bots[0].version });
    f.app.store.saveConfig({ provider: "anthropic", endpoint: f.fake.origin, model: "fixture-anthropic", apiKey: "synthetic-anthropic-key" });
    f.fake.scripts.push({ kind: "anthropic-text", text: "Anthropic 连接成功" });
    const task = f.app.runtime.input(f.conversation, "你好", id());
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    expect(f.fake.requests[0].url).toContain("/v1/messages");
    expect(f.fake.requests[0].body).toContain("NexBot Personal AI OS");
    expect(JSON.parse(f.fake.requests[0].body).system).toContain("Anthropic 私人秘书");
  }, 40_000);
  it("runs the fixed SDK, persists input/reply, deduplicates lost ACK, and hides credentials", async () => {
    const f = await fixture();
    f.fake.scripts.push({ kind: "openai-text", text: "你好，已连接固定运行时" });
    const task = f.app.runtime.input(f.conversation, "你好", "client-one");
    expect(f.app.runtime.input(f.conversation, "你好", "client-one")).toBe(task);
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    expect(f.app.store.all("SELECT * FROM transcript").map((m) => m.content)).toEqual(["你好", "你好，已连接固定运行时"]);
    expect(f.fake.requests).toHaveLength(1);
    expect(JSON.stringify(f.app.store.state())).not.toContain("synthetic-model-key");
    expect(f.app.store.get("SELECT ciphertext FROM secrets")?.ciphertext).not.toContain("synthetic-model-key");
    const noAuth = await fetch(f.app.origin + "/api/state"); expect(noAuth.status).toBe(401);
    const crossOrigin = await fetch(f.app.origin + "/api/input", { method: "POST", headers: { Origin: "https://attacker.invalid", Authorization: "Bearer " + f.token }, body: "{}" }); expect(crossOrigin.status).toBe(403);
  }, 40_000);
  it("automatically commits private memory once and preserves scoped recall across restart", async () => {
    const f = await fixture();
    const secret = f.app.runtime.memory.write(String(f.bots[1].id), { title: "Private", content: "OTHER_AGENT_SECRET", scope: "bot" });
    f.app.runtime.memory.write(String(f.bots[1].id), { title: "Shared", content: "SHARED_KNOWLEDGE", scope: "workspace" });
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "remember-one", name: "broker", args: JSON.stringify({ action: "memory.write", title: "用户偏好", content: "偏好中文与 Python", scope: "bot", expectedVersion: 0 }) }] }, { kind: "openai-text", text: "已记住，下次会参考" });
    const task = f.app.runtime.input(f.conversation, "记住我的偏好", "remember-client");
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    expect(approval(f.app)).toBeUndefined();
    const source = f.app.store.get("SELECT * FROM tool_calls WHERE task_id=?", task)!;
    await f.app.close(); f.owned.apps.splice(0);
    const reopened = await createApp({ dir: path.join(f.root, "core"), key: f.key, token: f.token }); f.owned.apps.push(reopened);
    expect(reopened.store.all("SELECT * FROM memory_write_receipts")).toHaveLength(1);
    expect(reopened.store.all("SELECT * FROM tool_calls")).toHaveLength(1);
    expect(reopened.store.get("SELECT argument_hash FROM tool_calls WHERE id=?", source.id)?.argument_hash).toBe(source.argument_hash);
    expect(() => reopened.runtime.memory.read(String(f.bots[0].id), String(secret.documentId))).toThrow();
    expect(reopened.runtime.memory.prompt(String(f.bots[0].id))).not.toContain("OTHER_AGENT_SECRET");
    expect(reopened.runtime.memory.prompt(String(f.bots[0].id))).toContain("偏好中文与 Python");
    expect(f.fake.requests.at(-1)?.body).not.toContain("OTHER_AGENT_SECRET");
    expect(reopened.store.all("PRAGMA foreign_key_check")).toEqual([]);
  }, 50_000);
  it("routes a durable A2A child task, returns one result, keeps private contexts separate", async () => {
    const f = await fixture();
    f.app.runtime.memory.write(String(f.bots[0].id), { title: "Parent secret", content: "PARENT_PRIVATE", scope: "bot" });
    f.app.runtime.memory.write(String(f.bots[1].id), { title: "Child memory", content: "RESEARCH_PRIVATE", scope: "bot" });
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "delegate-one", name: "broker", args: JSON.stringify({ action: "agent.delegate", botId: f.bots[1].id, message: "分析材料 A 的优点" }) }] }, { kind: "openai-text", text: "材料 A 的优点是稳定" }, { kind: "openai-text", text: "Beta 已完成：材料 A 稳定" });
    const task = f.app.runtime.input(f.conversation, "让 Beta 分析材料 A", "delegate-client");
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    const links = f.app.store.all("SELECT * FROM a2a_messages"); expect(links).toHaveLength(1); expect(links[0].status).toBe("succeeded");
    expect(f.fake.requests).toHaveLength(3);
    expect(f.fake.requests[1].body).toContain("RESEARCH_PRIVATE"); expect(f.fake.requests[1].body).not.toContain("PARENT_PRIVATE");
    expect(f.fake.requests[2].body).toContain("材料 A 的优点是稳定"); expect(f.fake.requests[2].body).not.toContain("RESEARCH_PRIVATE");
    expect(f.app.store.all("PRAGMA foreign_key_check")).toEqual([]);
  }, 50_000);
  it("new input invalidates a pending approval, and root cancellation stops descendants", async () => {
    const f = await fixture();
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "stale-write", name: "broker", args: JSON.stringify(pendingCleanup(f.app, String(f.bots[0].id))) }] }, { kind: "openai-text", text: "按新要求回答" });
    const task = f.app.runtime.input(f.conversation, "记住这个", "first"); await wait(() => !!approval(f.app)); const old = approval(f.app);
    f.app.runtime.input(f.conversation, "先不要保存，只回答", "steer");
    expect(() => f.app.runtime.decide(String(old.id), String(old.argument_hash), true)).toThrow();
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    expect(f.app.store.all("SELECT * FROM memory_write_receipts")).toHaveLength(0);
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "cancel-child", name: "broker", args: JSON.stringify({ action: "agent.delegate", botId: f.bots[1].id, message: "慢任务" }) }] }, { kind: "hang" });
    const parent = f.app.runtime.input(f.conversation, "开始慢任务", "slow");
    await wait(() => !!f.app.store.get("SELECT child_task_id FROM a2a_messages"));
    f.app.runtime.cancel(parent);
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", parent)?.status === "cancelled");
    const link = f.app.store.get("SELECT * FROM a2a_messages")!;
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", link.child_task_id)?.status === "cancelled");
    expect(f.app.store.get("SELECT status FROM tool_calls WHERE id=?", link.call_id)?.status).toBe("cancelled");
  }, 60_000);
  it("binds an outbound Device Node, reads a granted directory and rejects traversal", async () => {
    const f = await fixture(), root = path.join(f.root, "shared"); mkdirSync(root); writeFileSync(path.join(root, "paper.txt"), "设备论文文本");
    const nodeApp = await createApp({ dir: path.join(f.root, "device"), key: randomBytes(32), token: "node-owner-token" }); f.owned.apps.push(nodeApp);
    const pair = f.app.gateway.pair("Fixture Windows");
    nodeApp.node.configure({ origin: f.app.origin, token: pair.token, root, exec: false });
    await wait(() => nodeApp.node.status === "已连接");
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "read-device", name: "broker", args: JSON.stringify({ action: "device.read", deviceId: pair.deviceId, path: "paper.txt" }) }] }, { kind: "openai-text", text: "已分析设备论文" });
    const task = f.app.runtime.input(f.conversation, "读取设备论文", id());
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    const call = f.app.store.get("SELECT * FROM tool_calls WHERE tool_name='device.read'")!;
    expect(call.status).toBe("succeeded"); expect(call.result_json).toContain("设备论文文本");
    const nodeCall = nodeApp.node.journal.prepare("SELECT * FROM node_calls").get()!;
    expect(nodeCall.canonical_envelope).toBe(call.canonical_envelope); expect(hash(String(nodeCall.canonical_envelope))).toBe(nodeCall.argument_hash);
    expect(nodeApp.node.journal.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "escape-device", name: "broker", args: JSON.stringify({ action: "device.read", deviceId: pair.deviceId, path: "../core/backend.json" }) }] }, { kind: "openai-text", text: "目录越界已拒绝" });
    const denied = f.app.runtime.input(f.conversation, "尝试越界", id());
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", denied)?.status === "succeeded");
    expect(f.app.store.get("SELECT result_json FROM tool_calls WHERE provider_tool_call_id='escape-device'")?.result_json).toContain("超出授权目录");
  }, 60_000);
  it("extracts actual PDF text and executes an explicitly enabled terminal exactly once", async () => {
    const f = await fixture(), root = path.join(f.root, "shared"); mkdirSync(root); writeFileSync(path.join(root, "paper.pdf"), pdfFixture("PAPER_FIXTURE_STABILITY_RESULT"));
    const nodeApp = await createApp({ dir: path.join(f.root, "device"), key: randomBytes(32), token: "node-owner-token" }); f.owned.apps.push(nodeApp);
    const pair = f.app.gateway.pair("PDF node"); nodeApp.node.configure({ origin: f.app.origin, token: pair.token, root, exec: true }); await wait(() => nodeApp.node.status === "已连接");
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "pdf-read", name: "broker", args: JSON.stringify({ action: "device.read", deviceId: pair.deviceId, path: "paper.pdf" }) }] }, { kind: "openai-text", text: "PDF 已分析" });
    const task = f.app.runtime.input(f.conversation, "读取 PDF", id());
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    expect(f.app.store.get("SELECT result_json FROM tool_calls WHERE provider_tool_call_id='pdf-read'")?.result_json).toContain("PAPER_FIXTURE_STABILITY_RESULT");
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "shell-once", name: "broker", args: JSON.stringify({ action: "device.exec", deviceId: pair.deviceId, command: "Add-Content -LiteralPath counter.txt -Value executed; Get-Content -LiteralPath counter.txt" }) }] }, { kind: "openai-text", text: "命令完成" });
    const commandTask = f.app.runtime.input(f.conversation, "执行授权命令", id()); await wait(() => !!approval(f.app)); const commandGrant = approval(f.app); f.app.runtime.decide(String(commandGrant.id), String(commandGrant.argument_hash), true);
    await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", commandTask)?.status === "succeeded");
    const receipt = nodeApp.node.journal.prepare("SELECT * FROM node_calls WHERE capability='device.exec'").get()!;
    // Delivery retries carry exactly the same immutable source, even after expiry.
    f.app.gateway.sockets.get(pair.deviceId)!.send(JSON.stringify({ type: "call", callId: receipt.call_id, canonicalEnvelope: receipt.canonical_envelope, argumentHash: receipt.argument_hash, localPolicyVersion: receipt.local_policy_version, leaseSeq: receipt.lease_seq, leaseExpiresAt: receipt.lease_expires_at, deadlineAt: receipt.deadline_at }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(path.join(root, "counter.txt"), "utf8").trim()).toBe("executed");
    expect(nodeApp.node.journal.prepare("SELECT COUNT(*) count FROM node_calls WHERE capability='device.exec'").get()?.count).toBe(1);
  }, 60_000);
  it("invalidates device approvals when the local grant changes and rejects HTTP lookalike domains", async () => {
    const f = await fixture(), root = path.join(f.root, "shared"); mkdirSync(root); writeFileSync(path.join(root, "paper.txt"), "fixture");
    const nodeApp = await createApp({ dir: path.join(f.root, "device"), key: randomBytes(32), token: "node-owner-token" }); f.owned.apps.push(nodeApp);
    const pair = f.app.gateway.pair("Grant node");
    expect(() => nodeApp.node.configure({ origin: "http://10.example.invalid", token: pair.token, root })).toThrow();
    nodeApp.node.configure({ origin: f.app.origin, token: pair.token, root, exec: true }); await wait(() => nodeApp.node.status === "已连接");
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "old-grant", name: "broker", args: JSON.stringify({ action: "device.exec", risk: "dangerous", deviceId: pair.deviceId, command: "Get-Content -LiteralPath paper.txt" }) }] });
    const task = f.app.runtime.input(f.conversation, "等待审批时更改授权", id()); await wait(() => !!approval(f.app)); const grant = approval(f.app);
    const previousVersion = nodeApp.node.config!.policyVersion;
    nodeApp.node.configure({ origin: f.app.origin, token: pair.token, root, exec: false });
    await wait(() => f.app.store.get("SELECT policy_version FROM device_local_grants WHERE device_id=?", pair.deviceId)?.policy_version === previousVersion + 1);
    expect(() => f.app.runtime.decide(String(grant.id), String(grant.argument_hash), true)).toThrow("设备授权已变化");
    expect(nodeApp.node.journal.prepare("SELECT COUNT(*) count FROM node_calls").get()?.count).toBe(0);
    f.app.runtime.cancel(task);
  }, 40_000);
  it("recovers an in-flight A2A delegation after Core restart without creating a second child", async () => {
    const f = await fixture();
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "restart-a2a", name: "broker", args: JSON.stringify({ action: "agent.delegate", botId: f.bots[1].id, message: "继续重启测试" }) }] }, { kind: "hang" });
    const task = f.app.runtime.input(f.conversation, "委派任务", id());
    await wait(() => f.fake.requests.length === 2);
    const link = f.app.store.get("SELECT * FROM a2a_messages")!;
    await f.app.close(); f.owned.apps.splice(0);
    f.fake.scripts.push({ kind: "openai-text", text: "重启后的子任务结果" }, { kind: "openai-text", text: "主任务收到恢复结果" });
    const reopened = await createApp({ dir: path.join(f.root, "core"), key: f.key, token: f.token }); f.owned.apps.push(reopened);
    await wait(() => reopened.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
    expect(reopened.store.all("SELECT * FROM a2a_messages")).toHaveLength(1);
    expect(reopened.store.get("SELECT child_task_id FROM a2a_messages")?.child_task_id).toBe(link.child_task_id);
    expect(reopened.store.get("SELECT result_summary FROM tasks WHERE id=?", task)?.result_summary).toBe("主任务收到恢复结果");
  }, 60_000);
  it("compacts long conversation context through the SDK and retains durable inputs", async () => {
    const f = await fixture();
    f.fake.scripts.push(...Array.from({ length: 24 }, () => ({ kind: "openai-text" as const, text: "保留用户目标与已完成步骤的摘要和回复" })));
    for (let turn = 0; turn < 6; turn++) {
      const task = f.app.runtime.input(f.conversation, String(turn) + "x".repeat(31_000), id());
      await wait(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded");
      await wait(() => !f.app.runtime.workers.size);
    }
    expect(Number(f.app.store.get("SELECT COUNT(*) count FROM model_invocations WHERE purpose='compact'")?.count)).toBeGreaterThan(0);
    expect(f.app.store.get("SELECT status,usage_known FROM model_invocations WHERE purpose='compact'")).toMatchObject({ status: "succeeded", usage_known: 0 });
    expect(f.app.store.all("SELECT * FROM transcript WHERE role='user'")).toHaveLength(6);
  }, 60_000);
});
