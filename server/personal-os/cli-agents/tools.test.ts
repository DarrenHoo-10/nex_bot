// The assistant's cli.* broker tools: argument rules, risk and approval scope,
// the main-chat refusal, and a background job driving a simulated device end to
// end. Everything runs in a temp directory against a fake model and a simulated
// device; no real session, assistant or model is touched.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp } from "../index.ts";
import { CoreStore } from "../store.ts";
import { evaluateTool, ownerMayCall, policyTools } from "../policy.ts";
import { dangerousEffect } from "../risk.ts";
import { approvalRuleLabel, approvalRuleScope } from "../approval-rules.ts";
import { toolCatalog } from "../tool-catalog.ts";
import type { CliItem } from "../../../shared/cli-agents.ts";
import { startFakeModel, type FakeScript } from "../../runtime/pi/p0/fake-model.ts";
import { READ_TEXT_MAX, READ_TOTAL_MAX, readView } from "./tools.ts";
import { validateCliToolArgs } from "./tool-args.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const OWNER = "synthetic-cli-tools-owner";
const CAP = { version: 1, engines: ["claude", "codex"], terminal: { name: "herdr-core", version: "0.1.21", ready: true } };
const KEY = "dev-1:claude:s1";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | null | false, what = "condition", ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await wait(15);
  }
}

describe("argument rules", () => {
  it("accepts well-formed calls", () => {
    expect(() => validateCliToolArgs("cli.list", {})).not.toThrow();
    expect(() => validateCliToolArgs("cli.list", { deviceId: "dev-1" })).not.toThrow();
    expect(() => validateCliToolArgs("cli.read", { key: KEY, before: "item-1" })).not.toThrow();
    expect(() => validateCliToolArgs("cli.start", { deviceId: "dev-1", engine: "codex", cwd: "C:/work/proj" })).not.toThrow();
    expect(() => validateCliToolArgs("cli.start", { deviceId: "dev-1", engine: "claude", cwd: "/home/me/proj" })).not.toThrow();
    expect(() => validateCliToolArgs("cli.send", { key: KEY, text: "continue" })).not.toThrow();
    expect(() => validateCliToolArgs("cli.interrupt", { key: KEY })).not.toThrow();
  });

  it("refuses bad keys, engines, directories and text", () => {
    expect(() => validateCliToolArgs("cli.read", { key: "nope" })).toThrow();
    expect(() => validateCliToolArgs("cli.read", { key: KEY, before: 5 })).toThrow();
    expect(() => validateCliToolArgs("cli.send", { key: KEY, text: "   " })).toThrow();
    expect(() => validateCliToolArgs("cli.send", { key: KEY, text: "x".repeat(40_000) })).toThrow();
    expect(() => validateCliToolArgs("cli.send", { key: "dev-1:other:s1", text: "hi" })).toThrow();
    expect(() => validateCliToolArgs("cli.interrupt", {})).toThrow();
    expect(() => validateCliToolArgs("cli.start", { deviceId: "dev-1", engine: "gemini", cwd: "/x" })).toThrow();
    expect(() => validateCliToolArgs("cli.start", { deviceId: "dev-1", engine: "claude", cwd: "relative/dir" })).toThrow();
    expect(() => validateCliToolArgs("cli.start", { engine: "claude", cwd: "/x" })).toThrow();
    expect(() => validateCliToolArgs("cli.list", { deviceId: "" })).toThrow();
  });
});

describe("read view", () => {
  const item = (n: number, text: string): CliItem => ({ kind: "assistant", id: "a" + n, ts: n, text });

  it("drops thinking and cuts long text and tool output", () => {
    const view = readView({ more: false, items: [
      { kind: "thinking", id: "k", ts: 1, text: "private reasoning" },
      { kind: "user", id: "u", ts: 2, text: "hi" },
      item(3, "z".repeat(READ_TEXT_MAX + 500)),
      { kind: "tool", id: "t", ts: 4, name: "Bash", input: "i".repeat(900), status: "ok", output: "o".repeat(900) },
      { kind: "turn", id: "m", ts: 5, phase: "ended" },
    ] });
    expect(JSON.stringify(view)).not.toContain("private reasoning");
    expect(view.items.map((entry) => entry.kind)).toEqual(["user", "assistant", "tool", "turn"]);
    expect((view.items[1].text as string).length).toBe(READ_TEXT_MAX);
    expect(view.items[1].truncated).toBe(true);
    expect(view.items[2].truncated).toBe(true);
    expect(view.items[0].truncated).toBeUndefined();
    expect(view.more).toBe(false);
  });

  it("keeps the newest items under the total cap and points at older ones", () => {
    const items = Array.from({ length: 40 }, (_, n) => item(n, "x".repeat(READ_TEXT_MAX)));
    const view = readView({ more: false, items });
    expect(JSON.stringify(view.items).length).toBeLessThanOrEqual(READ_TOTAL_MAX + 200);
    expect(view.items.at(-1)?.id).toBe("a39");
    expect(view.items.length).toBeLessThan(40);
    expect(view.more).toBe(true);
    expect(view.truncated).toBe(true);
    expect(view.before).toBe(view.items[0].id);
  });

  it("passes the device's own paging through", () => {
    const view = readView({ more: true, items: [item(1, "a"), item(2, "b")] });
    expect(view).toMatchObject({ more: true, before: "a1" });
    expect(view.truncated).toBeUndefined();
  });
});

describe("policy, risk and approval scope", () => {
  function store() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nex-cli-tools-policy-"));
    const created = new CoreStore(dir, randomBytes(32), "synthetic");
    cleanups.push(() => { created.close(); rmSync(dir, { recursive: true, force: true }); });
    return created;
  }

  it("lists the tools in the catalog and the default policy, owner chat excluded", () => {
    const names = ["cli.list", "cli.read", "cli.start", "cli.send", "cli.interrupt"];
    for (const name of names) {
      expect(toolCatalog.some((entry) => entry.action === name && entry.brief)).toBe(true);
      expect(ownerMayCall(name, {})).toBe(false);
    }
    const s = store(), bot = s.createBot("助手");
    const policy = s.get("SELECT * FROM bot_policies WHERE bot_id=?", bot)!;
    for (const name of names) expect(policyTools(policy)).toContain(name);
  });

  it("marks starting, sending and interrupting dangerous whatever the model says", () => {
    expect(dangerousEffect({ action: "cli.start", deviceId: "d", engine: "claude", cwd: "/x" })).toBe(true);
    expect(dangerousEffect({ action: "cli.send", key: KEY, text: "hi", risk: "standard" })).toBe(true);
    expect(dangerousEffect({ action: "cli.interrupt", key: KEY })).toBe(true);
    expect(dangerousEffect({ action: "cli.list" })).toBe(false);
    expect(dangerousEffect({ action: "cli.read", key: KEY })).toBe(false);
  });

  it("asks for approval unless the assistant is on full approval, and refuses bad arguments", () => {
    const s = store(), bot = s.createBot("助手");
    expect(evaluateTool(s, bot, { action: "cli.list" }).approvalRequired).toBe(false);
    expect(evaluateTool(s, bot, { action: "cli.read", key: KEY }).approvalRequired).toBe(false);
    expect(evaluateTool(s, bot, { action: "cli.send", key: KEY, text: "go" }).approvalRequired).toBe(true);
    expect(() => evaluateTool(s, bot, { action: "cli.send", key: "bad", text: "go" })).toThrow();
    s.run("INSERT INTO agent_approval_settings(bot_id,mode,version) VALUES(?,?,1) ON CONFLICT(bot_id) DO UPDATE SET mode=excluded.mode", bot, "full");
    expect(evaluateTool(s, bot, { action: "cli.send", key: KEY, text: "go" }).approvalRequired).toBe(false);
  });

  it("scopes a remembered approval to one session, or to one device and directory for a start", () => {
    expect(approvalRuleScope({ action: "cli.send", key: KEY, text: "a" })).toEqual({ action: "cli.send", target: KEY, operation: "" });
    expect(approvalRuleScope({ action: "cli.send", key: KEY, text: "b" })).toEqual(approvalRuleScope({ action: "cli.send", key: KEY, text: "a" }));
    expect(approvalRuleScope({ action: "cli.send", key: "dev-1:claude:s2", text: "a" }).target).not.toBe(KEY);
    expect(approvalRuleScope({ action: "cli.start", deviceId: "dev-1", engine: "claude", cwd: "/x" })).toEqual({ action: "cli.start", target: "dev-1", operation: "claude /x" });
    const s = store();
    expect(approvalRuleLabel(s, approvalRuleScope({ action: "cli.send", key: KEY, text: "a" }))).toContain("给 Agent 会话发消息");
  });
});

async function ready(items: CliItem[] = [], sessionExtra: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-cli-tools-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("nex-cli-tools-")) throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  const fake = await startFakeModel();
  cleanups.push(() => fake.close());
  const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: OWNER, identity: false, memoryRuntime: false, hostDevice: false, cliAgents: { graceMs: 0 } });
  cleanups.push(() => app.close());
  clearInterval(app.runtime.memory.personal.timer);
  app.store.saveConfig({ provider: "openai", endpoint: fake.origin + "/v1", model: "fake", apiKey: "synthetic-model-key" });
  const response = await fetch(app.origin + "/api/devices", { method: "POST", headers: { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" }, body: JSON.stringify({ name: "tools-device" }) });
  const pair = await response.json() as { deviceId: string; token: string };
  const ws = new WebSocket(app.origin.replace("http:", "ws:") + "/dcp/v1/connect", { headers: { Authorization: "Bearer " + pair.token } });
  cleanups.push(() => { ws.terminate(); });
  const msgs: Array<Record<string, any>> = [];
  const ops = () => msgs.filter((m) => m.type === "cli.op");
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(raw.toString());
    msgs.push(message);
    if (message.type !== "cli.op") return;
    const result = message.op === "read" ? { items, more: false } : message.op === "start" ? { ref: "claude:fresh", terminal: "term-1" } : message.op === "send" ? { turn: 1, started: true } : message.op === "interrupt" ? { outcome: "ok" } : {};
    ws.send(JSON.stringify({ type: "cli.reply", opId: message.opId, ok: true, result }));
  });
  ws.on("open", () => ws.send(JSON.stringify({
    type: "hello", policyVersion: 1, read: true, exec: true, computer: false, platform: "macos",
    identity: { hostname: "tools-device", supported: ["device.info"] }, cliAgents: CAP,
  })));
  await until(() => msgs.find((m) => m.type === "bound"), "bound");
  ws.send(JSON.stringify({
    type: "cli.sessions", full: true, removes: [], seq: 1,
    upserts: [{ engine: "claude", nativeId: "s1", configDir: "C:/cfg", cwd: "C:/work/proj", title: "fix the parser", state: "idle", lastActivityAt: 1000, ...sessionExtra }],
  }));
  const key = `${pair.deviceId}:claude:s1`;
  await until(() => app.cliHub.session(key), "session");
  const bot = app.store.createBot("合成助手");
  const tool = (id: string, args: Record<string, unknown>): FakeScript => ({ kind: "openai-tool", calls: [{ id, name: "broker", args: JSON.stringify(args) }] });
  const say = (text: string): FakeScript => ({ kind: "openai-text", text });
  const call = (providerId: string) => app.store.get("SELECT * FROM tool_calls WHERE provider_tool_call_id=?", providerId);
  const result = (providerId: string) => JSON.parse(String(call(providerId)?.result_json ?? "null"));
  return { app, fake, bot, key, deviceId: pair.deviceId, ops, tool, say, call, result };
}

describe("a background job driving a session", () => {
  it("lists and reads without asking, then sends only after approval, with no text in the audit log", async () => {
    const transcript: CliItem[] = [
      { kind: "user", id: "u1", ts: 1, text: "fix the parser" },
      { kind: "thinking", id: "k1", ts: 2, text: "secret reasoning" },
      { kind: "assistant", id: "a1", ts: 3, text: "fixed it" },
    ];
    const f = await ready(transcript);
    const secret = "synthetic-send-text-do-not-log";
    f.fake.scripts.push(
      f.tool("list", { action: "cli.list" }), f.tool("read", { action: "cli.read", key: f.key }),
      f.tool("send", { action: "cli.send", key: f.key, text: secret }), f.say("已发送"),
    );
    const job = f.app.jobs.start({ botId: f.bot, title: "催进度", prompt: "看看会话并让它继续", sourceKey: "cli-job" });
    const approval = await until(() => f.app.store.get("SELECT * FROM approvals WHERE status='pending'"), "approval");
    // list and read ran at once; the send waits and nothing reached the device
    expect(f.result("list").sessions).toEqual([expect.objectContaining({ key: f.key, engine: "claude", state: "idle", online: true, title: "fix the parser" })]);
    expect(f.result("list").devices).toEqual([expect.objectContaining({ id: f.deviceId, online: true, engines: ["claude", "codex"] })]);
    const read = f.result("read");
    expect(read.items.map((entry: any) => entry.kind)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(read)).not.toContain("secret reasoning");
    expect(f.call("send")).toMatchObject({ status: "awaiting_approval", target_kind: "device", target_id: f.deviceId });
    expect(f.ops().filter((op) => op.op === "send")).toHaveLength(0);

    f.app.runtime.decide(String(approval.id), String(approval.argument_hash), true);
    await until(() => f.ops().find((op) => op.op === "send"), "send op");
    const sent = f.ops().find((op) => op.op === "send")!;
    expect(sent.args).toMatchObject({ ref: "claude:s1", text: secret });
    await until(() => ["succeeded", "failed"].includes(String(f.call("send")?.status)), "send done");
    expect(f.result("send")).toEqual({ sent: true, key: f.key });
    await until(() => f.app.store.get("SELECT id FROM agent_job_reports WHERE job_id=?", job.jobId), "job report");

    const audit = f.app.store.all("SELECT * FROM audit_records WHERE action='cli.send'");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(String(audit[0].details_json)).toContain(`"length":${secret.length}`);
    expect(f.app.store.get("SELECT created_by FROM cli_agent_ops WHERE op='send'")?.created_by).toBe(`bot:${f.bot}`);
  }, 60_000);

  it("does nothing when the approval is rejected", async () => {
    const f = await ready();
    f.fake.scripts.push(f.tool("stop", { action: "cli.interrupt", key: f.key }), f.say("用户拒绝了"));
    f.app.jobs.start({ botId: f.bot, title: "打断", prompt: "打断会话", sourceKey: "cli-job-reject" });
    const approval = await until(() => f.app.store.get("SELECT * FROM approvals WHERE status='pending'"), "approval");
    f.app.runtime.decide(String(approval.id), String(approval.argument_hash), false);
    await until(() => f.call("stop")?.status === "rejected", "rejected");
    expect(f.ops().filter((op) => op.op === "interrupt")).toHaveLength(0);
    expect(f.app.store.get("SELECT id FROM audit_records WHERE action='cli.interrupt'")).toBeUndefined();
  }, 60_000);

  it("starts a session on approval and returns its key", async () => {
    const f = await ready();
    f.fake.scripts.push(f.tool("start", { action: "cli.start", deviceId: f.deviceId, engine: "claude", cwd: "C:/work/other" }), f.say("已启动"));
    f.app.jobs.start({ botId: f.bot, title: "开新会话", prompt: "开一个新会话", sourceKey: "cli-job-start" });
    const approval = await until(() => f.app.store.get("SELECT * FROM approvals WHERE status='pending'"), "approval");
    f.app.runtime.decide(String(approval.id), String(approval.argument_hash), true);
    await until(() => f.call("start")?.status === "succeeded", "start done");
    expect(f.ops().find((op) => op.op === "start")?.args).toMatchObject({ engine: "claude", cwd: "C:/work/other" });
    expect(f.result("start")).toEqual({ started: true, key: `${f.deviceId}:claude:fresh` });
    expect(f.app.store.get("SELECT entity_id FROM audit_records WHERE action='cli.start'")?.entity_id).toBe(f.deviceId);
  }, 60_000);

  it("reports a device error to the model instead of failing the job", async () => {
    const f = await ready();
    f.fake.scripts.push(f.tool("read-missing", { action: "cli.read", key: f.key.replace(":s1", ":gone") }), f.say("会话不存在"));
    const job = f.app.jobs.start({ botId: f.bot, title: "读不存在的会话", prompt: "读会话", sourceKey: "cli-job-missing" });
    await until(() => f.call("read-missing")?.status === "failed", "failed call");
    expect(f.result("read-missing")).toMatchObject({ code: "not_found" });
    await until(() => f.app.store.get("SELECT id FROM agent_job_reports WHERE job_id=?", job.jobId), "job report");
  }, 60_000);

  it.each(["inbox", "daemon"])("refuses to send into a session reached only through the %s, even when approved", async (via) => {
    const f = await ready([], { sendVia: via });
    expect(f.app.cliHub.session(f.key)?.sendVia).toBe(via);
    f.fake.scripts.push(f.tool("outside", { action: "cli.send", key: f.key, text: "go on" }), f.say("不能发送"));
    f.app.jobs.start({ botId: f.bot, title: "催进度", prompt: "让它继续", sourceKey: "cli-job-outside-" + via });
    const approval = await until(() => f.app.store.get("SELECT * FROM approvals WHERE status='pending'"), "approval");
    f.app.runtime.decide(String(approval.id), String(approval.argument_hash), true);
    await until(() => f.call("outside")?.status === "failed", "failed call");
    expect(f.result("outside")).toMatchObject({ code: "not_in_terminal" });
    expect(f.ops().filter((op) => op.op === "send")).toHaveLength(0);
    expect(f.app.store.get("SELECT id FROM audit_records WHERE action='cli.send'")).toBeUndefined();
  }, 60_000);

  it.each([["terminal"], [undefined]])("still sends into a session whose sendVia is %s", async (via) => {
    const f = await ready([], via ? { sendVia: via } : {});
    f.fake.scripts.push(f.tool("inside", { action: "cli.send", key: f.key, text: "go on" }), f.say("已发送"));
    f.app.jobs.start({ botId: f.bot, title: "催进度", prompt: "让它继续", sourceKey: "cli-job-inside-" + String(via) });
    const approval = await until(() => f.app.store.get("SELECT * FROM approvals WHERE status='pending'"), "approval");
    f.app.runtime.decide(String(approval.id), String(approval.argument_hash), true);
    await until(() => f.call("inside")?.status === "succeeded", "send done");
    expect(f.ops().filter((op) => op.op === "send")).toHaveLength(1);
  }, 60_000);

  it("refuses a call with a bad key before anything runs", async () => {
    const f = await ready();
    f.fake.scripts.push(f.tool("bad", { action: "cli.send", key: "nope", text: "hi" }), f.say("参数不对"));
    const job = f.app.jobs.start({ botId: f.bot, title: "坏参数", prompt: "发消息", sourceKey: "cli-job-bad" });
    await until(() => f.app.store.get("SELECT id FROM agent_job_reports WHERE job_id=?", job.jobId), "job report");
    expect(f.app.store.get("SELECT id FROM approvals")).toBeUndefined();
    expect(f.ops().filter((op) => op.op === "send")).toHaveLength(0);
  }, 60_000);
});

describe("the main chat", () => {
  it("is pointed at a background job and never reaches the device", async () => {
    const f = await ready();
    f.fake.scripts.push(f.tool("owner-list", { action: "cli.list" }), f.say("好的，交给后台任务"));
    const taskId = f.app.agents.send(f.bot, "看看我电脑上的 Claude 会话", "owner-cli").taskId;
    await until(() => f.call("owner-list")?.status === "failed", "refused call");
    expect(f.result("owner-list")).toMatchObject({ useJob: true });
    expect(f.app.store.get("SELECT status FROM tasks WHERE id=?", taskId)).toBeDefined();
    expect(f.ops()).toHaveLength(0);
  }, 60_000);
});
