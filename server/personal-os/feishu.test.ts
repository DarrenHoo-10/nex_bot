import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { startFakeFeishu, messageEvent, cardActionEvent } from "./testing/fake-feishu.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 25_000; while (!await check()) { if (Date.now() > end) throw new Error("Feishu fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 30)); } }

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-feishu-fixture-")), key = randomBytes(32), token = "synthetic-owner";
  cleanup.push(async () => { if (path.dirname(root).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(root).startsWith("nex-feishu-fixture-")) throw new Error("Unsafe cleanup"); rmSync(root, { recursive: true, force: true }); });
  const fake = await startFakeFeishu(), model = await startFakeModel();
  cleanup.push(() => fake.close(), () => model.close());
  const proxyFetch: typeof fetch = (input, init) => fetch(String(input).replaceAll("https://open.feishu.cn", fake.origin).replaceAll("https://accounts.feishu.cn", fake.origin), init);
  const app = await createPersonalApp({ dir: root, key, token, identity: false, memoryRuntime: false, feishu: { registerApp: fake.registerApp, transport: fake.createTransport, fetchImpl: proxyFetch } });
  cleanup.push(() => app.close());
  app.store.saveConfig({ provider: "openai", endpoint: model.origin + "/v1", model: "fixture", apiKey: "synthetic-only" });
  app.store.createBot("秘书");
  const bot = app.store.all("SELECT * FROM bots ORDER BY created_at")[0];
  async function api(route: string, data?: unknown) {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, unknown> & { feishu?: { job?: { stage?: string; url?: string; error?: string }; userAuth?: { stage?: string; url?: string; error?: string }; apps: Array<{ id: string; appId: string; brand: string; status: string; ownerBound: boolean; userAuthorized: boolean; userScopes: string[]; userExpiresAt: number | null; botName: string; version: number }> } } };
  }
  async function state() { return (await api("state")).body.feishu!; }
  async function connectFake() {
    expect((await api("feishu/register/start", { botId: bot.id })).status).toBe(200);
    await until(() => fake.sent !== undefined && app.store.get("SELECT connection FROM personal_feishu_apps")?.connection === "connected");
  }
  return { app, fake, model, bot, api, state, connectFake };
}

describe("feishu connector in disposable Core", () => {
  it("scans, connects, and carries one p2p turn to Feishu and back", async () => {
    const f = await fixture();
    await f.connectFake();
    const snapshot = await f.state();
    expect(snapshot.apps).toHaveLength(1);
    expect(snapshot.apps[0]).toMatchObject({ appId: "cli_fake", ownerBound: true, status: "connected", botName: "秘书" });
    expect(JSON.stringify((await f.api("state")).body)).not.toContain("fake-secret");
    expect(String(f.app.store.get("SELECT app_secret FROM personal_feishu_apps")?.app_secret)).not.toContain("fake-secret");
    f.model.scripts.push({ kind: "openai-text", text: "好的，已收到" });
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_1", chatId: "oc_chat1", senderOpenId: "ou_owner", content: JSON.stringify({ text: "帮我看看日程" }) }));
    await until(() => !!f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_1'")?.task_id);
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_1'")?.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
    await until(() => f.fake.sent.some((entry) => JSON.stringify(entry.body).includes("好的，已收到")));
    expect(f.fake.sent[0]).toMatchObject({ path: "send" });
    expect(f.fake.sent[0].body).toMatchObject({ receive_id: "oc_chat1", msg_type: "interactive" });
  }, 60_000);

  it("dedupes message_id, ignores strangers and unmentioned group text, handles group mention", async () => {
    const f = await fixture();
    await f.connectFake();
    await until(() => f.app.store.get("SELECT bot_open_id FROM personal_feishu_apps")?.bot_open_id === "ou_fake_bot");
    f.model.scripts.push({ kind: "openai-text", text: "收到第一条" });
    const event = messageEvent({ messageId: "om_d", chatId: "oc_d", senderOpenId: "ou_owner", content: JSON.stringify({ text: "第一条" }) });
    f.fake.deliver("cli_fake", event);
    await until(() => !!f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_d'")?.task_id);
    const firstTask = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_d'")?.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", firstTask)?.status === "succeeded");
    f.fake.deliver("cli_fake", event);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.app.store.all("SELECT * FROM personal_feishu_messages WHERE message_id='om_d'")).toHaveLength(1);
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_s", chatId: "oc_s", senderOpenId: "ou_other", content: JSON.stringify({ text: "你好" }) }));
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_g0", chatId: "oc_g", chatType: "group", senderOpenId: "ou_owner", content: JSON.stringify({ text: "不叫机器人" }) }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_s'")?.task_id).toBeNull();
    expect(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_g0'")?.task_id).toBeNull();
    f.model.scripts.push({ kind: "openai-text", text: "群里回复" });
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_g1", chatId: "oc_g", chatType: "group", senderOpenId: "ou_owner", content: JSON.stringify({ text: "@_user_1 帮我查天气" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_fake_bot" }, name: "秘书" }] }));
    await until(() => !!f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_g1'")?.task_id);
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_g1'")?.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
    await until(() => f.fake.sent.some((entry) => entry.path === "reply" && JSON.stringify(entry.body).includes("群里回复")));
  }, 60_000);

  it("sends approval cards for Feishu tasks and only the owner's click decides", async () => {
    const f = await fixture();
    await f.connectFake();
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "rename", name: "broker", args: JSON.stringify({ action: "agent.update", botId: f.bot.id, name: "新名字" }) }] },
      { kind: "openai-text", text: "改名完成" },
    );
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_a", chatId: "oc_a", senderOpenId: "ou_owner", content: JSON.stringify({ text: "把你的名字改成新名字" }) }));
    await until(() => !!f.app.store.get("SELECT id FROM approvals WHERE status='pending'"));
    await until(() => f.fake.sent.some((entry) => String(entry.body.content ?? "").includes("请求批准")));
    const approval = f.app.store.get("SELECT * FROM approvals WHERE status='pending'")!;
    const strangerToast = await f.fake.card("cli_fake", cardActionEvent({ openId: "ou_other", value: { kind: "approval", id: approval.id, hash: approval.argument_hash, decision: "allow" } }));
    expect(strangerToast).toMatchObject({ toast: { type: "error" } });
    expect(f.app.store.get("SELECT status FROM approvals WHERE id=?", String(approval.id))?.status).toBe("pending");
    const ownerToast = await f.fake.card("cli_fake", cardActionEvent({ openId: "ou_owner", value: { kind: "approval", id: approval.id, hash: approval.argument_hash, decision: "allow" } }));
    expect(ownerToast).toMatchObject({ toast: { type: "success", content: "已同意" } });
    await until(() => f.app.store.get("SELECT name FROM bots WHERE id=?", String(f.bot.id))?.name === "新名字");
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_a'")?.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
  }, 60_000);

  it("stop button cancels the Feishu task", async () => {
    const f = await fixture();
    await f.connectFake();
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "rename", name: "broker", args: JSON.stringify({ action: "agent.update", botId: f.bot.id, name: "另一个名字" }) }] },
      { kind: "openai-text", text: "完成" },
    );
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_b", chatId: "oc_b", senderOpenId: "ou_owner", content: JSON.stringify({ text: "再改一次名字" }) }));
    await until(() => !!f.app.store.get("SELECT id FROM approvals WHERE status='pending'"));
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_b'")?.task_id);
    const toast = await f.fake.card("cli_fake", cardActionEvent({ openId: "ou_owner", value: { kind: "stop", taskId } }));
    expect(toast).toMatchObject({ toast: { type: "success", content: "已停止" } });
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "cancelled");
  }, 60_000);

  it("binds the owner through the bind code for an existing app", async () => {
    const f = await fixture();
    expect((await f.api("feishu/save", { appId: "cli_manual", appSecret: "manual-secret", brand: "feishu", botId: f.bot.id })).status).toBe(200);
    await until(() => f.app.store.get("SELECT connection FROM personal_feishu_apps")?.connection === "connected");
    expect((await f.state()).apps[0]).toMatchObject({ ownerBound: false });
    const snapshot = await f.state();
    const bind = await f.api("feishu/bind/start", { id: snapshot.apps[0].id });
    const code = String(bind.body.code);
    expect(String(f.app.store.get("SELECT bind_code FROM personal_feishu_apps")?.bind_code)).not.toBe(code);
    f.fake.deliver("cli_manual", messageEvent({ messageId: "om_bind", chatId: "oc_bind", senderOpenId: "ou_newowner", content: JSON.stringify({ text: code }) }));
    await until(async () => (await f.state()).apps[0].ownerBound === true);
    f.model.scripts.push({ kind: "openai-text", text: "绑定成功" });
    f.fake.deliver("cli_manual", messageEvent({ messageId: "om_after", chatId: "oc_bind", senderOpenId: "ou_newowner", content: JSON.stringify({ text: "现在能听见吗" }) }));
    await until(() => !!f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_after'")?.task_id);
  }, 60_000);

  it("disables delivery when toggled off, deletes cleanly, and refuses a second live connection", async () => {
    const f = await fixture();
    await f.connectFake();
    const snapshot = await f.state(), connector = snapshot.apps[0];
    expect((await f.api("feishu/toggle", { id: connector.id, version: connector.version, enabled: false })).status).toBe(200);
    await until(() => f.app.store.get("SELECT connection FROM personal_feishu_apps")?.connection === "disabled");
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_off", chatId: "oc_off", senderOpenId: "ou_owner", content: JSON.stringify({ text: "停用后说话" }) }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_off'")).toBeUndefined();
    expect((await f.api("feishu/toggle", { id: connector.id, version: Number(connector.version) + 1, enabled: true })).status).toBe(200);
    await until(() => f.app.store.get("SELECT connection FROM personal_feishu_apps")?.connection === "connected");
    expect((await f.api("feishu/delete", { id: connector.id, version: Number(connector.version) + 2 })).status).toBe(200);
    await until(async () => (await f.state()).apps.length === 0);
    expect(f.app.store.get("SELECT * FROM personal_feishu_apps")).toBeUndefined();
    expect(f.app.store.get("SELECT * FROM personal_feishu_messages")).toBeUndefined();
    expect(f.app.store.get("SELECT * FROM personal_connectors WHERE kind='feishu'")).toBeUndefined();
  }, 60_000);

  it("stays unconnected while another instance is online, then connects when freed", async () => {
    const f = await fixture();
    f.fake.setOnlineInstances(1);
    expect((await f.api("feishu/register/start", { botId: f.bot.id })).status).toBe(200);
    await until(() => f.app.store.get("SELECT connection FROM personal_feishu_apps")?.connection === "busy");
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_busy", chatId: "oc_busy", senderOpenId: "ou_owner", content: JSON.stringify({ text: "不该被处理" }) }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.app.store.get("SELECT * FROM personal_feishu_messages WHERE message_id='om_busy'")).toBeUndefined();
    f.fake.setOnlineInstances(0);
    const snapshot = await f.state(), connector = snapshot.apps[0];
    expect((await f.api("feishu/toggle", { id: connector.id, version: connector.version, enabled: true })).status).toBe(200);
    await until(() => f.app.store.get("SELECT connection FROM personal_feishu_apps")?.connection === "connected");
    f.model.scripts.push({ kind: "openai-text", text: "现在在线" });
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_free", chatId: "oc_free", senderOpenId: "ou_owner", content: JSON.stringify({ text: "重新上线" }) }));
    await until(() => !!f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_free'")?.task_id);
  }, 60_000);

  it("auto-grants the built-in tools and answers read calls without approval", async () => {
    const f = await fixture();
    await f.connectFake();
    const policy = JSON.parse(String(f.app.store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", String(f.bot.id))?.policy_json)) as { tools: string[] };
    expect(policy.tools).toEqual(expect.arrayContaining(["connector.list", "connector.tools", "connector.call"]));
    const connector = (await f.state()).apps[0];
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "dir", name: "broker", args: JSON.stringify({ action: "connector.tools", connectorId: connector.id }) }] },
      { kind: "openai-tool", calls: [{ id: "read", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "feishu_read", parameters: { path: "/open-apis/docx/v1/documents/doc1/raw_content" } }) }] },
      { kind: "openai-text", text: "查询完成" },
    );
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_read", chatId: "oc_read", senderOpenId: "ou_owner", content: JSON.stringify({ text: "读一下 doc1 的内容" }) }));
    await until(() => f.fake.apiCalls.length >= 1);
    await until(() => !!f.app.store.get("SELECT id FROM tool_calls WHERE tool_name='connector.call' AND status='succeeded'"));
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_read'")?.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
    expect(f.app.store.all("SELECT id FROM approvals")).toHaveLength(0);
    expect(f.fake.apiCalls[0]).toMatchObject({ method: "GET", path: "/open-apis/docx/v1/documents/doc1/raw_content", authorization: /^Bearer tenant-/ });
    expect(String(f.app.store.get("SELECT result_json FROM tool_calls WHERE tool_name='connector.call'")?.result_json)).toContain("doc1");
  }, 60_000);

  it("holds feishu_write for approval, posts after the owner allows, and validates parameters", async () => {
    const f = await fixture();
    await f.connectFake();
    const connector = (await f.state()).apps[0];
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "bad", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "feishu_read", parameters: { path: "https://evil.test/open-apis/x" } }) }] },
      { kind: "openai-tool", calls: [{ id: "write", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "feishu_write", parameters: { path: "/open-apis/docx/v1/documents", body: { title: "会议纪要" } } }) }] },
      { kind: "openai-text", text: "已创建" },
    );
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_write", chatId: "oc_write", senderOpenId: "ou_owner", content: JSON.stringify({ text: "建一篇会议纪要文档" }) }));
    await until(() => !!f.app.store.get("SELECT id FROM tool_calls WHERE status IN ('failed','succeeded') AND result_json LIKE '%参数无效%'"));
    const bad = JSON.parse(String(f.app.store.get("SELECT result_json FROM tool_calls WHERE result_json LIKE '%参数无效%' LIMIT 1")?.result_json)) as { isError?: boolean; text?: string };
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("参数无效");
    expect(f.fake.apiCalls).toHaveLength(0);
    await until(() => !!f.app.store.get("SELECT id FROM approvals WHERE status='pending'"));
    await until(() => f.fake.sent.some((entry) => String(entry.body.content ?? "").includes("请求批准")));
    const approval = f.app.store.get("SELECT * FROM approvals WHERE status='pending'")!;
    expect(f.app.store.get("SELECT status FROM tool_calls WHERE status='awaiting_approval'")?.status).toBe("awaiting_approval");
    expect(f.fake.apiCalls).toHaveLength(0);
    const toast = await f.fake.card("cli_fake", cardActionEvent({ openId: "ou_owner", value: { kind: "approval", id: approval.id, hash: approval.argument_hash, decision: "allow" } }));
    expect(toast).toMatchObject({ toast: { type: "success" } });
    await until(() => f.fake.apiCalls.length >= 1);
    expect(f.fake.apiCalls[0]).toMatchObject({ method: "POST", path: "/open-apis/docx/v1/documents" });
    expect(f.fake.apiCalls[0].body).toMatchObject({ title: "会议纪要" });
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_write'")?.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
  }, 60_000);

  it("authorizes the owner via device flow and serves user-identity reads", async () => {
    const f = await fixture();
    await f.connectFake();
    f.fake.setPendingPolls(2);
    const connector = (await f.state()).apps[0];
    expect((await f.api("feishu/user-auth/start", { id: connector.id })).status).toBe(200);
    await until(async () => (await f.state()).apps[0].userAuthorized);
    expect((await f.state()).apps[0].userScopes.length).toBeGreaterThan(0);
    const stored = String(f.app.store.get("SELECT user_token FROM personal_feishu_apps")?.user_token);
    expect(stored).not.toContain("user-access");
    expect(stored).not.toContain("user-refresh");
    const connectorAfter = (await f.state()).apps[0];
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "userRead", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connectorAfter.id, connectorVersion: connectorAfter.version, tool: "feishu_read", parameters: { path: "/open-apis/wiki/v2/spaces", as: "user" } }) }] },
      { kind: "openai-text", text: "知识库读取完成" },
    );
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_wiki", chatId: "oc_wiki", senderOpenId: "ou_owner", content: JSON.stringify({ text: "看看我的知识库" }) }));
    await until(() => f.fake.apiCalls.length >= 1);
    expect(f.fake.apiCalls[0].authorization).toBe("Bearer user-access-1");
  }, 60_000);

  it("discards authorization from a different account", async () => {
    const f = await fixture();
    await f.connectFake();
    f.fake.setUserOpenId("ou_other");
    const connector = (await f.state()).apps[0];
    expect((await f.api("feishu/user-auth/start", { id: connector.id })).status).toBe(200);
    await until(async () => (await f.state()).userAuth?.stage === "error");
    expect((await f.state()).userAuth?.error).toContain("不一致");
    expect((await f.state()).apps[0].userAuthorized).toBe(false);
    expect(f.app.store.get("SELECT user_token FROM personal_feishu_apps")?.user_token).toBeNull();
    expect((await f.state()).apps[0].ownerBound).toBe(true);
  }, 60_000);

  it("refreshes an expired user token exactly once before a user call", async () => {
    const f = await fixture();
    await f.connectFake();
    const connector = (await f.state()).apps[0];
    expect((await f.api("feishu/user-auth/start", { id: connector.id })).status).toBe(200);
    await until(async () => (await f.state()).apps[0].userAuthorized);
    const row = f.app.store.get("SELECT user_token FROM personal_feishu_apps")!;
    const grant = JSON.parse(f.app.store.decrypt(String(row.user_token))) as { accessToken: string; expiresAt: number };
    expect(grant.accessToken).toBe("user-access-1");
    f.app.store.run("UPDATE personal_feishu_apps SET user_token=?", f.app.store.encrypt(JSON.stringify({ ...grant, expiresAt: Date.now() - 1000 })));
    const connectorAfter = (await f.state()).apps[0];
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "userRead", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connectorAfter.id, connectorVersion: connectorAfter.version, tool: "feishu_read", parameters: { path: "/open-apis/drive/v1/files", as: "user" } }) }] },
      { kind: "openai-text", text: "读取完成" },
    );
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_drive", chatId: "oc_drive", senderOpenId: "ou_owner", content: JSON.stringify({ text: "看看我的云盘" }) }));
    await until(() => f.fake.apiCalls.length >= 1);
    expect(f.fake.apiCalls[0].authorization).toBe("Bearer user-access-2");
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_drive'")?.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
  }, 60_000);
});
