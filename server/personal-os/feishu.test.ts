import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonalApp } from "./index.ts";
import { id } from "./store.ts";
import { startFakeFeishu, messageEvent, cardActionEvent } from "./testing/fake-feishu.ts";
import { reportBody } from "./feishu/module.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 25_000; while (!await check()) { if (Date.now() > end) throw new Error("Feishu fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 30)); } }

async function startReachable<T extends { origin: string; close(): Promise<void> }>(start: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const service = await start();
    try {
      // This host's ephemeral pool includes ports rejected by Fetch. Probe before any chat operation.
      const probe = await fetch(service.origin + "/health", { signal: AbortSignal.timeout(5_000) });
      await probe.arrayBuffer();
      return service;
    } catch (error) {
      await service.close();
      if (attempt >= 8 || !(error instanceof Error && error.cause instanceof Error && error.cause.message === "bad port")) throw error;
    }
  }
}

async function fixture(profileAssets = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-feishu-fixture-")), key = randomBytes(32), token = "synthetic-owner";
  cleanup.push(async () => { if (path.dirname(root).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(root).startsWith("nex-feishu-fixture-")) throw new Error("Unsafe cleanup"); rmSync(root, { recursive: true, force: true }); });
  const fake = await startReachable(() => startFakeFeishu()), model = await startFakeModel();
  cleanup.push(() => fake.close(), () => model.close());
  const proxyFetch: typeof fetch = (input, init) => fetch(String(input).replaceAll("https://open.feishu.cn", fake.origin).replaceAll("https://accounts.feishu.cn", fake.origin).replaceAll("https://s1-imfile.feishucdn.com", fake.origin), init);
  if (profileAssets) {
    mkdirSync(path.join(root, "feishu-avatars"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVm0AAAAASUVORK5CYII=", "base64");
    writeFileSync(path.join(root, "feishu-avatars", "graphic-secretary-01.png"), png);
    writeFileSync(path.join(root, "feishu-avatars", "portrait-fox.png"), png);
  }
  const app = await startReachable(() => createPersonalApp({ dir: root, key, token, identity: false, memoryRuntime: false, ...(profileAssets ? { uiDir: root, publicOrigin: "https://nexbot.example.test" } : {}), feishu: { registerApp: fake.registerApp, transport: fake.createTransport, fetchImpl: proxyFetch } }));
  cleanup.push(() => app.close());
  app.store.saveConfig({ provider: "openai", endpoint: model.origin + "/v1", model: "fixture", apiKey: "synthetic-only" });
  app.store.createBot("秘书");
  const bot = app.store.all("SELECT * FROM bots ORDER BY created_at")[0];
  if (profileAssets) app.agents.ensure(String(bot.id));
  async function api(route: string, data?: unknown) {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, unknown> & { feishu?: { job?: { stage?: string; url?: string; error?: string }; userAuth?: { stage?: string; url?: string; error?: string }; apps: Array<{ id: string; appId: string; brand: string; status: string; ownerBound: boolean; userAuthorized: boolean; userScopes: string[]; userExpiresAt: number | null; botName: string; version: number }> } } };
  }
  async function state() { return (await api("state")).body.feishu!; }
  async function connectFake() {
    expect((await api("feishu/register/start", { botId: bot.id })).status).toBe(200);
    await until(() => fake.sent !== undefined && app.store.get("SELECT connection FROM personal_feishu_apps")?.connection === "connected");
  }
  return { app, fake, model, bot, api, state, connectFake, token };
}

describe("feishu connector in disposable Core", () => {
  it("reuses a group's list and avatar for five minutes, then refreshes both", async () => {
    const f = await fixture();
    await f.connectFake();
    const [app] = (await f.state()).apps;
    const route = "feishu/groups?id=" + app.id;
    const calls = (path: string) => f.fake.apiCalls.filter(call => call.path === path).length;
    const group = { chatId: "oc_cached", name: "开发协作", avatar: "https://s1-imfile.feishucdn.com/fixture-avatar/first.png" };
    f.fake.setChats([group]);
    const results = await Promise.all([f.api(route), f.api(route)]);
    expect(calls("/open-apis/im/v1/chats")).toBe(1);
    const original = (results[0].body.groups as { avatarUrl: string }[])[0].avatarUrl;
    const requestAvatar = (asset: string) => fetch(f.app.origin + asset, { headers: { Authorization: `Bearer ${f.token}` } });
    expect((await fetch(f.app.origin + original)).status).toBe(401);
    const downloads = await Promise.all([requestAvatar(original), requestAvatar(original)]);
    for (const download of downloads) {
      expect(download.status).toBe(200);
      expect(download.headers.get("Cache-Control")).toBe("private, max-age=300");
      expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    expect(calls("/fixture-avatar/first.png")).toBe(1);
    const wallClock = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => wallClock() + 299_000);
    try {
      f.fake.setChats([{ ...group, avatar: "https://s1-imfile.feishucdn.com/fixture-avatar/second.png" }]);
      await f.api(route);
      expect(calls("/open-apis/im/v1/chats")).toBe(1);
      await (await requestAvatar(original)).arrayBuffer();
      expect(calls("/fixture-avatar/first.png")).toBe(1);
      clock.mockImplementation(() => wallClock() + 301_000);
      const fresh = (await f.api(route)).body.groups as { avatarUrl: string }[];
      expect(calls("/open-apis/im/v1/chats")).toBe(2);
      expect(fresh[0].avatarUrl).not.toBe(original);
      expect((await requestAvatar(original)).status).toBe(404);
      expect((await requestAvatar(fresh[0].avatarUrl)).status).toBe(200);
      expect(calls("/fixture-avatar/second.png")).toBe(1);
    } finally { clock.mockRestore(); }
  }, 30_000);

  it("keeps native Feishu connectors out of generic management and syncs the explicitly selected profile", async () => {
    const f = await fixture(true);
    const missing = await f.api("feishu/register/start", { botId: "" });
    expect(missing.status).toBe(400);
    await f.connectFake();
    expect(f.fake.registrationPresets[0]).toMatchObject({
      name: "秘书", avatar: "https://nexbot.example.test/feishu-avatars/graphic-secretary-01.png",
    });
    const [app] = (await f.state()).apps;
    expect((await f.api("state")).body.connectors).toContainEqual(expect.objectContaining({ id: app.id, kind: "feishu" }));
    expect((await f.api("connectors/delete", { id: app.id, version: app.version })).status).toBe(400);
    expect((await f.state()).apps).toHaveLength(1);

    expect((await f.api("bots/update", { id: f.bot.id, version: f.bot.version, name: "开发助手" })).status).toBe(200);
    expect((await f.api("bots/appearance", { id: f.bot.id, version: 0, appearance: { kind: "portrait", id: "fox" } })).status).toBe(200);
    const profilePath = "/open-apis/application/v7/applications/cli_fake/base";
    await until(() => f.app.store.get("SELECT profile_status FROM personal_feishu_apps")?.profile_status === "publication");
    expect(f.fake.apiCalls.filter(call => call.path === profilePath).at(-1)).toMatchObject({
      method: "PATCH", body: { i18ns: [{ i18n_key: "zh_cn", name: "开发助手" }], avatar_url: "https://s1-imfile.feishucdn.com/fixture-avatar.png" },
    });
    expect(f.fake.apiCalls.some(call => call.path.endsWith("/app_avatar/upload") && String(call.body.raw).includes('name="avatar"'))).toBe(true);

    const message = (messageId: string, parentId?: string) => messageEvent({
      messageId, parentId, chatId: "oc_profile", senderOpenId: "ou_owner", content: JSON.stringify({ text: messageId }),
    });
    const receiverOf = (messageId: string) => f.app.store.get("SELECT t.bot_id FROM personal_feishu_messages m JOIN tasks t ON t.id=m.task_id WHERE m.message_id=?", messageId)?.bot_id;
    f.model.scripts.push(...["旧话题", "继续", "新话题"].map(text => ({ kind: "openai-text" as const, text })));
    f.fake.deliver("cli_fake", message("om_original_receiver"));
    await until(() => receiverOf("om_original_receiver") === f.bot.id);

    const newBot = f.app.store.createBot("第二助手");
    expect((await f.api("feishu/receiver", { id: app.id, version: app.version, botId: newBot })).status).toBe(200);
    expect((await f.state()).apps[0]).toMatchObject({ id: app.id, botName: "第二助手", ownerBound: true });
    expect((await f.api("feishu/receiver", { id: app.id, version: app.version, botId: f.bot.id })).status).toBe(400);
    f.fake.deliver("cli_fake", message("om_old_topic_reply", "om_original_receiver"));
    f.fake.deliver("cli_fake", message("om_new_receiver"));
    await until(() => receiverOf("om_old_topic_reply") === f.bot.id && receiverOf("om_new_receiver") === newBot);
  }, 30_000);

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
    expect(f.fake.sent[0]).toMatchObject({ path: "reply" });
    expect(f.fake.sent[0].body).toMatchObject({ receive_id: "oc_chat1", msg_type: "interactive",reply_in_thread:true });
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
    await until(() => f.fake.sent.some((entry) => ["reply","patch"].includes(entry.path) && JSON.stringify(entry.body).includes("群里回复")));
  }, 60_000);

  it("executes agent updates directly from Feishu tasks without blocking approvals", async () => {
    const f = await fixture();
    await f.connectFake();
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "rename", name: "broker", args: JSON.stringify({ action: "agent.update", botId: f.bot.id, name: "新名字" }) }] },
      { kind: "openai-text", text: "改名完成" },
    );
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_a", chatId: "oc_a", senderOpenId: "ou_owner", content: JSON.stringify({ text: "把你的名字改成新名字" }) }));
    await until(() => f.app.store.get("SELECT name FROM bots WHERE id=?", String(f.bot.id))?.name === "新名字");
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_a'")?.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
    expect(f.app.store.all("SELECT id FROM approvals")).toHaveLength(0);
  }, 60_000);

  it("stop button cancels the Feishu task", async () => {
    const f = await fixture();
    await f.connectFake();
    f.model.scripts.push({ kind: "hang" });
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_b", chatId: "oc_b", senderOpenId: "ou_owner", content: JSON.stringify({ text: "再改一次名字" }) }));
    await until(() => !!f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_b'")?.task_id && f.model.requests.length >= 1);
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_b'")?.task_id);
    const toast = await f.fake.card("cli_fake", cardActionEvent({ openId: "ou_owner", value: { kind: "stop", taskId } }));
    expect(toast).toMatchObject({ toast: { type: "success", content: "已停止" } });
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "cancelled");
  }, 60_000);

  /** A Feishu turn of the main chat, then a background job it dispatched (started directly so one fake model stays in order). */
  async function dispatched(f: Awaited<ReturnType<typeof fixture>>, messageId: string, title: string) {
    f.model.scripts.push({ kind: "openai-text", text: "已交给后台：" + title });
    f.fake.deliver("cli_fake", messageEvent({ messageId, chatId: "oc_job", senderOpenId: "ou_owner", content: JSON.stringify({ text: "请在后台" + title }) }));
    await until(() => !!f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id=?", messageId)?.task_id);
    const owner = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id=?", messageId)!.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", owner)?.status === "succeeded" && f.app.runtime.workers.size === 0);
    await until(() => f.fake.sent.some((entry) => JSON.stringify(entry.body).includes("已交给后台：" + title)));
    return { owner, start: () => f.app.jobs.start({ botId: String(f.bot.id), title, prompt: "请在后台" + title, originTaskId: owner, sourceKey: "feishu-job:" + messageId }) };
  }

  it("sends a background job's report to the Feishu chat of the turn that dispatched it, as one message", async () => {
    const f = await fixture();
    await f.connectFake();
    const { start } = await dispatched(f, "om_job", "整理周报");
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "job-report", name: "broker", args: JSON.stringify({ action: "job.report", state: "ready", summary: "周报已整理" }) }] },
      { kind: "openai-text", text: "执行细节不发飞书" },
    );
    const job = start();
    await until(() => f.fake.sent.some((entry) => JSON.stringify(entry.body).includes("后台任务「整理周报」")));
    const sent = f.fake.sent.filter((entry) => JSON.stringify(entry.body).includes("后台任务「整理周报」"));
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ receive_id: "oc_job", msg_type: "interactive" });
    expect(String(sent[0].body.content)).toContain(JSON.stringify("后台任务「整理周报」\n周报已整理").slice(1, -1));
    expect(JSON.stringify(sent[0].body)).not.toContain("完整结果在 App 中查看");
    // Generated images stay in the app; the one message says so.
    expect(reportBody("后台任务「画图」\n已画好\n\n![生成图片](/api/attachments/abc-1)\n\n[下载图片](/api/attachments/abc-1)")).toBe("后台任务「画图」\n已画好\n\n完整结果在 App 中查看");
    expect(f.fake.sent.some((entry) => JSON.stringify(entry.body).includes("执行细节不发飞书"))).toBe(false);
    const report = f.app.store.get("SELECT r.id FROM agent_job_reports r WHERE r.job_id=?", job.jobId)!;
    expect(f.app.store.get("SELECT message_id FROM personal_feishu_outbound WHERE source_key=?", `reply:job-report:${report.id}`)?.message_id).toMatch(/^om_out_/);
    // Routine reports still stay in the app.
    const routine = f.app.agents.startRoutine(String(f.bot.id), "例行检查", "例行", "feishu-routine");
    f.model.scripts.push({ kind: "openai-text", text: "例行结果" });
    f.app.runtime.kick(routine);
    await until(() => !!f.app.store.get("SELECT id FROM agent_messages WHERE source_key=?", `routine-report:${routine}`));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.fake.sent.some((entry) => JSON.stringify(entry.body).includes("例行结果"))).toBe(false);
  }, 60_000);

  it("routes a Feishu reply to a job report straight to that job, not through the main chat", async () => {
    const f = await fixture();
    await f.connectFake();
    const { owner, start } = await dispatched(f, "om_job_reply", "导出报告");
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "ask-format", name: "broker", args: JSON.stringify({ action: "job.report", state: "question", summary: "报告已整理", question: "导出为 PDF 还是 Word？" }) }] },
      { kind: "openai-text", text: "等待回答" },
    );
    const job = start();
    await until(() => f.fake.sent.some((entry) => JSON.stringify(entry.body).includes("导出为 PDF 还是 Word？")));
    const report = f.app.store.get("SELECT id FROM agent_job_reports WHERE job_id=?", job.jobId)!;
    const outbound = f.app.store.get("SELECT message_id,job_id FROM personal_feishu_outbound WHERE source_key=?", `reply:job-report:${report.id}`)!;
    expect(outbound.job_id).toBe(job.jobId);
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "exported", name: "broker", args: JSON.stringify({ action: "job.report", state: "ready", summary: "已导出 PDF" }) }] },
      { kind: "openai-text", text: "完成" },
    );
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_answer", chatId: "oc_job", senderOpenId: "ou_owner", content: JSON.stringify({ text: "PDF" }), parentId: String(outbound.message_id) }));
    await until(() => f.fake.sent.some((entry) => JSON.stringify(entry.body).includes("已导出 PDF")));
    const rounds = f.app.store.all("SELECT id FROM tasks WHERE conversation_id=(SELECT conversation_id FROM agent_jobs WHERE id=?) ORDER BY created_at", job.jobId);
    expect(rounds).toHaveLength(2);
    expect(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_answer'")?.task_id).toBe(rounds[1].id);
    expect(JSON.parse(String(f.app.store.get("SELECT content_json FROM conversation_inputs WHERE task_id=?", rounds[1].id)!.content_json)).text).toBe("PDF");
    // The main chat got no new turn; the reply is shown in the stream as a reply to the job.
    expect(f.app.store.all("SELECT t.id FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE l.origin='owner'").map((row) => row.id)).toEqual([owner]);
    expect(f.app.agents.messages(String(f.bot.id)).find((message) => message.content === "PDF")).toMatchObject({ role: "user", job_id: job.jobId });
  }, 60_000);

  it("sends approval cards for a dispatched job with its title, and the stop button stops the job", async () => {
    const f = await fixture();
    await f.connectFake();
    const propose = f.app.runtime.propose.bind(f.app.runtime);
    f.app.runtime.propose = (worker, event) => {
      const call = propose(worker, event);
      if (call.provider_tool_call_id !== "job-rename") return call;
      f.app.store.insert("approvals", { id: id(), tool_call_id: call.id, ...f.app.store.scope(), argument_hash: call.argument_hash, bot_policy_version: JSON.parse(String(call.authorization_snapshot_json)).policyVersion, status: "pending", created_at: Date.now(), expires_at: Date.now() + 60_000 });
      f.app.store.run("UPDATE tool_calls SET status='awaiting_approval' WHERE id=?", call.id);
      f.app.store.run("UPDATE tasks SET status='awaiting_approval' WHERE id=?", call.task_id);
      f.app.runtime.changed();
      return f.app.store.get("SELECT * FROM tool_calls WHERE id=?", call.id)!;
    };
    const { start } = await dispatched(f, "om_job_approval", "修改名字");
    f.model.scripts.push({ kind: "openai-tool", calls: [{ id: "job-rename", name: "broker", args: JSON.stringify({ action: "agent.update", botId: f.bot.id, name: "后台改名" }) }] });
    const job = start();
    await until(() => f.fake.sent.some((entry) => String(entry.body.content ?? "").includes("请求批准")));
    const card = f.fake.sent.find((entry) => String(entry.body.content ?? "").includes("请求批准"))!;
    expect(String(card.body.content)).toContain("后台任务「修改名字」");
    expect(card.body).toMatchObject({ receive_id: "oc_job" });
    const toast = await f.fake.card("cli_fake", cardActionEvent({ openId: "ou_owner", value: { kind: "stop", taskId: job.taskId } }));
    expect(toast).toMatchObject({ toast: { type: "success", content: "已停止" } });
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", job.taskId)?.status === "cancelled");
    expect(f.app.store.get("SELECT stopped_at FROM agent_jobs WHERE id=?", job.jobId)?.stopped_at).not.toBeNull();
    expect(f.app.store.get("SELECT name FROM bots WHERE id=?", String(f.bot.id))?.name).toBe("秘书");
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
    f.fake.deliver("cli_manual", messageEvent({ appId:"cli_manual",messageId: "om_bind", chatId: "oc_bind", senderOpenId: "ou_newowner", content: JSON.stringify({ text: code }) }));
    await until(async () => (await f.state()).apps[0].ownerBound === true);
    f.model.scripts.push({ kind: "openai-text", text: "绑定成功" });
    f.fake.deliver("cli_manual", messageEvent({ appId:"cli_manual",messageId: "om_after", chatId: "oc_bind", senderOpenId: "ou_newowner", content: JSON.stringify({ text: "现在能听见吗" }) }));
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

  it("serves the built-in tools by default and answers read calls without approval", async () => {
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

  it("executes feishu_write directly and validates parameters", async () => {
    const f = await fixture();
    await f.connectFake();
    const connector = (await f.state()).apps[0];
    f.model.scripts.push(
      { kind: "openai-tool", calls: [{ id: "bad", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "feishu_read", parameters: { path: "https://evil.test/open-apis/x" } }) }] },
      { kind: "openai-tool", calls: [{ id: "write", name: "broker", args: JSON.stringify({ action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool: "feishu_write", parameters: { path: "/open-apis/docx/v1/documents", body: { title: "会议纪要" } } }) }] },
      { kind: "openai-text", text: "已创建" },
    );
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_write", chatId: "oc_write", senderOpenId: "ou_owner", content: JSON.stringify({ text: "建一篇会议纪要文档" }) }));
    await until(() => f.fake.apiCalls.length >= 1);
    const bad = JSON.parse(String(f.app.store.get("SELECT result_json FROM tool_calls WHERE result_json LIKE '%参数无效%' LIMIT 1")?.result_json)) as { isError?: boolean; text?: string };
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("参数无效");
    expect(f.fake.apiCalls[0]).toMatchObject({ method: "POST", path: "/open-apis/docx/v1/documents" });
    expect(f.fake.apiCalls[0].body).toMatchObject({ title: "会议纪要" });
    const taskId = String(f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_write'")?.task_id);
    await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status === "succeeded");
    expect(f.app.store.all("SELECT id FROM approvals")).toHaveLength(0);
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
  it("connects several apps, shows each bot's identity, and refuses a duplicate app", async () => {
    const f = await fixture();
    f.fake.queueAppIds("cli_one", "cli_two");
    expect((await f.api("feishu/register/start", { botId: f.bot.id })).status).toBe(200);
    await until(() => f.app.store.get("SELECT connection FROM personal_feishu_apps WHERE app_id='cli_one'")?.connection === "connected");
    expect((await f.api("feishu/register/start", { botId: f.bot.id })).status).toBe(200);
    await until(() => f.app.store.get("SELECT connection FROM personal_feishu_apps WHERE app_id='cli_two'")?.connection === "connected");
    await until(async () => (await f.state()).apps.every((app) => (app as { name?: string }).name === "假机器人"));
    const apps = (await f.state()).apps as unknown as Array<{ appId: string; name: string; avatarUrl: string; groupCount: number }>;
    expect(apps.map((app) => app.appId)).toEqual(["cli_one", "cli_two"]);
    expect(apps[0]).toMatchObject({ avatarUrl: "https://example.invalid/bot.png", groupCount: 0 });
    const duplicate = await f.api("feishu/save", { appId: "cli_two", appSecret: "x", brand: "feishu", botId: f.bot.id });
    expect(duplicate.status).not.toBe(200);
    expect(JSON.stringify(duplicate.body)).toContain("该应用已添加");
  }, 60_000);

  it("lists the bot's groups and applies each group's reply mode and context", async () => {
    const f = await fixture();
    await f.connectFake();
    await until(() => f.app.store.get("SELECT bot_open_id FROM personal_feishu_apps")?.bot_open_id === "ou_fake_bot");
    f.fake.setChats([{ chatId: "oc_team", name: "投研群", members: 5 }, { chatId: "oc_topics", name: "盯盘话题", mode: "topic", members: 8 }]);
    const id = (await f.state()).apps[0].id;
    type Group = { chatId: string; name: string; kind: string; members: number; claimed: boolean; trigger: string; session: string; context: string; version: number };
    const listed = (await f.api(`feishu/groups?id=${id}`)).body as { groups: Group[]; error: string | null };
    expect(listed.error).toBeNull();
    expect(listed.groups).toEqual([
      expect.objectContaining({ chatId: "oc_team", name: "投研群", kind: "group", members: 5, claimed: false, trigger: "topic", session: "new-topic", context: "" }),
      expect.objectContaining({ chatId: "oc_topics", name: "盯盘话题", kind: "topic", members: 8, claimed: false }),
    ]);
    const stale = await f.api("feishu/groups/save", { id, chatId: "oc_team", trigger: "never", session: "chat", context: "x", version: 9 });
    expect(stale.status).not.toBe(200);
    const saved = (await f.api("feishu/groups/save", { id, chatId: "oc_team", trigger: "never", session: "chat", context: "回答先给结论", version: 1 })).body as Group;
    expect(saved).toMatchObject({ claimed: true, trigger: "never", session: "chat", context: "回答先给结论", version: 2 });

    // Whole group, no @ needed: every message joins the group's own topic and is answered inline.
    f.model.scripts.push({ kind: "openai-text", text: "群答一" }, { kind: "openai-text", text: "群答二" });
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_c1", chatId: "oc_team", chatType: "group", senderOpenId: "ou_member", content: JSON.stringify({ text: "今天大盘怎么样" }) }));
    await until(() => f.fake.sent.some((entry) => JSON.stringify(entry.body).includes("群答一")));
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_c2", chatId: "oc_team", chatType: "group", senderOpenId: "ou_member", content: JSON.stringify({ text: "那成交量呢" }) }));
    await until(() => f.fake.sent.some((entry) => JSON.stringify(entry.body).includes("群答二")));
    const routed = f.app.store.all("SELECT conversation_id,inline FROM personal_feishu_messages WHERE message_id IN ('om_c1','om_c2')");
    expect(new Set(routed.map((row) => row.conversation_id)).size).toBe(1);
    expect(routed.every((row) => row.inline === 1)).toBe(true);
    expect(f.fake.sent.filter((entry) => entry.path === "reply").every((entry) => entry.body.reply_in_thread === undefined)).toBe(true);
    const system = JSON.stringify(f.model.requests.at(-1)?.body);
    expect(system).toContain("回答先给结论");
    const topics = (await f.api(`agents/topics?bot=${encodeURIComponent(String(f.bot.id))}`)).body as { topics: Array<{ conversationId: string; title: string; audience: string; sourceContext: Record<string, unknown> }> };
    expect(topics.topics.find((topic) => topic.conversationId === routed[0].conversation_id)).toMatchObject({ title: "投研群", audience: "public", sourceContext: { chatName: "投研群", scope: "group" } });
  }, 60_000);

  it("shares one topic for top-level @ messages and gives each Feishu thread its own", async () => {
    const f = await fixture();
    await f.connectFake();
    await until(() => f.app.store.get("SELECT bot_open_id FROM personal_feishu_apps")?.bot_open_id === "ou_fake_bot");
    f.fake.setChats([{ chatId: "oc_mix", name: "混合群" }]);
    const id = (await f.state()).apps[0].id;
    await f.api(`feishu/groups?id=${id}`);
    expect((await f.api("feishu/groups/save", { id, chatId: "oc_mix", trigger: "ambient", session: "chat-topic", context: "", version: 1 })).status).toBe(200);
    const mention = (open_id: string) => [{ key: "@_user_1", id: { open_id }, name: "某人" }];
    const conversation = (messageId: string) => String(f.app.store.get("SELECT conversation_id FROM personal_feishu_messages WHERE message_id=?", messageId)?.conversation_id ?? "");
    f.model.scripts.push({ kind: "openai-text", text: "a" }, { kind: "openai-text", text: "b" }, { kind: "openai-text", text: "c" }, { kind: "openai-text", text: "d" });
    // Ambient: answers without @, stays silent when someone else is @-mentioned.
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_m1", chatId: "oc_mix", chatType: "group", senderOpenId: "ou_member", content: JSON.stringify({ text: "大家好" }) }));
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_m2", chatId: "oc_mix", chatType: "group", senderOpenId: "ou_member", content: JSON.stringify({ text: "@_user_1 你看下" }), mentions: mention("ou_someone") }));
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_m3", chatId: "oc_mix", chatType: "group", senderOpenId: "ou_member", content: JSON.stringify({ text: "第二条顶层" }) }));
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_t1", chatId: "oc_mix", chatType: "group", senderOpenId: "ou_member", threadId: "omt_a", parentId: "om_m1", content: JSON.stringify({ text: "话题里问" }) }));
    await until(() => !!conversation("om_m1") && !!conversation("om_m3") && !!conversation("om_t1"));
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_t2", chatId: "oc_mix", chatType: "group", senderOpenId: "ou_member", threadId: "omt_a", parentId: "om_t1", content: JSON.stringify({ text: "话题里继续" }) }));
    await until(() => !!conversation("om_t2"));
    expect(f.app.store.get("SELECT state FROM personal_feishu_messages WHERE message_id='om_m2'")?.state).toBe("ignored");
    expect(conversation("om_m1")).toBe(conversation("om_m3"));
    expect(conversation("om_t1")).not.toBe(conversation("om_m1"));
    expect(conversation("om_t2")).toBe(conversation("om_t1"));
    expect(f.app.store.get("SELECT inline FROM personal_feishu_messages WHERE message_id='om_t1'")?.inline).toBe(0);
  }, 60_000);

  it("requires an @ in every message when the group's trigger is 'always'", async () => {
    const f = await fixture();
    await f.connectFake();
    await until(() => f.app.store.get("SELECT bot_open_id FROM personal_feishu_apps")?.bot_open_id === "ou_fake_bot");
    f.fake.setChats([{ chatId: "oc_strict", name: "严格群" }]);
    const id = (await f.state()).apps[0].id;
    await f.api(`feishu/groups?id=${id}`);
    expect((await f.api("feishu/groups/save", { id, chatId: "oc_strict", trigger: "always", session: "new-topic", context: "", version: 1 })).status).toBe(200);
    f.model.scripts.push({ kind: "openai-text", text: "首答" });
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_s1", chatId: "oc_strict", chatType: "group", senderOpenId: "ou_member", content: JSON.stringify({ text: "@_user_1 问题" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_fake_bot" }, name: "秘书" }] }));
    await until(() => !!f.app.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='om_s1'")?.task_id);
    f.fake.deliver("cli_fake", messageEvent({ messageId: "om_s2", chatId: "oc_strict", chatType: "group", senderOpenId: "ou_member", parentId: "om_s1", content: JSON.stringify({ text: "追问不带@" }) }));
    await until(() => f.app.store.get("SELECT state FROM personal_feishu_messages WHERE message_id='om_s2'")?.state === "ignored");
  }, 60_000);
});
