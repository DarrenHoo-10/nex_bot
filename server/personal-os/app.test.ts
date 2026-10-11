import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { pathToFileURL } from "node:url";
import { startFakeModel, type FakeModel } from "../runtime/pi/p0/fake-model.ts";
import { hash, id } from "./store.ts";
import { nextDaily } from "./routines.ts";
function pdfFixture(content: string) {
  const stream = `BT /F1 12 Tf 60 750 Td (${content}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let document = "%PDF-1.4\n", positions = [0];
  for (const [index, object] of objects.entries()) { positions.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const offset = Buffer.byteLength(document); document += `xref\n0 6\n0000000000 65535 f \n${positions.slice(1).map((p) => String(p).padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(document);
}

type App = Awaited<ReturnType<typeof createPersonalApp>>;
const createApp: typeof createPersonalApp = process.env.NEX_TEST_BUNDLE ? (await import(pathToFileURL(path.resolve(process.env.NEX_TEST_BUNDLE)).href)).createPersonalApp : createPersonalApp;
const fixtures: Array<{ root: string; apps: App[]; fake: FakeModel }> = [];
const wait = async (check: () => boolean, milliseconds = 25_000) => {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    for (const f of fixtures) for (const app of f.apps) {
      const failed = app.store.get("SELECT result_summary FROM tasks WHERE status='failed' ORDER BY created_at DESC LIMIT 1");
      if (failed) throw new Error("Fixture task failed: " + failed.result_summary);
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
    expect(JSON.parse(String(empty.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", botId)?.policy_json)).tools).not.toContain("device.exec");
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
    f.fake.scripts.push({ kind: "openai-tool", calls: [{ id: "old-grant", name: "broker", args: JSON.stringify({ action: "device.exec", deviceId: pair.deviceId, command: "Get-Content -LiteralPath paper.txt" }) }] });
    const task = f.app.runtime.input(f.conversation, "等待审批时更改授权", id()); await wait(() => !!approval(f.app)); const grant = approval(f.app);
    nodeApp.node.configure({ origin: f.app.origin, token: pair.token, root, exec: false });
    await wait(() => f.app.store.get("SELECT policy_version FROM device_local_grants WHERE device_id=?", pair.deviceId)?.policy_version === 2);
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
