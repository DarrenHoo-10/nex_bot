import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonalApp } from "./index.ts";
import { startFakeGithub } from "./testing/fake-github.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

interface Flow { id: string; userCode?: string; verificationUri?: string; expiresAt: number }
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function temporaryDirectory() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-github-monitor-"));
  cleanup.push(async () => { if (path.dirname(root).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(root).startsWith("nex-github-monitor-")) throw new Error("Unsafe cleanup"); rmSync(root, { recursive: true, force: true }); });
  return root;
}
async function fixture() {
  const github = await startFakeGithub(); cleanup.push(() => github.close());
  const model = await startFakeModel(); cleanup.push(() => model.close());
  const root = temporaryDirectory();
  const options = { dir: root, key: randomBytes(32), token: "synthetic-owner", identity: false as const, hostDevice: false as const, memoryRuntime: false as const, modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} }, github: { fixtureOrigin: github.origin } };
  const app = await createPersonalApp(options); cleanup.push(() => app.close());
  app.store.saveConfig({ provider: "openai", endpoint: model.origin + "/v1", model: "fixture", apiKey: "synthetic-only" });
  const botId = app.store.createBot("通知助手");
  async function connect() {
    const response = await fetch(app.origin + "/api/connectors/oauth/start", { headers: { Authorization: "Bearer synthetic-owner", "Content-Type": "application/json" }, method: "POST", body: JSON.stringify({ provider: "github" }) });
    const flow = await response.json() as Flow; expect(response.status).toBe(200);
    expect(flow.userCode).toBe("ABCD-1234");
    github.state.deviceApprove = true;
    await expect.poll(async () => {
      const status = await fetch(app.origin + "/api/connectors/oauth/status?id=" + flow.id, { headers: { Authorization: "Bearer synthetic-owner" } });
      return ((await status.json()) as { status: string }).status;
    }, { timeout: 20_000 }).toBe("connected");
  }
  async function api(route: string, data?: unknown) {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: "Bearer synthetic-owner", "Content-Type": "application/json" }, ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> & { monitors?: unknown[]; webhookSecret?: string; webhookPath?: string; error?: string } };
  }
  async function saveMonitor(extra: Record<string, unknown> = {}) {
    const connectorId = app.connectors.list()[0]?.id;
    const response = await fetch(app.origin + "/api/connector-monitors/save", { headers: { Authorization: "Bearer synthetic-owner", "Content-Type": "application/json" }, method: "POST", body: JSON.stringify({ connectorId, botId, repos: ["example/nexbot"], name: "仓库监视", intervalSeconds: 60, ...extra }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> & { id?: string; version?: number; webhookSecret?: string; webhookPath?: string; error?: string } };
  }
  const messages = () => app.store.all("SELECT content, source_key FROM agent_messages WHERE bot_id=? ORDER BY rowid", botId);
  const deliveries = (monitorId: string) => app.store.all("SELECT fingerprint, kind FROM personal_connector_deliveries WHERE monitor_id=?", monitorId);
  return { github, app, botId, connect, saveMonitor, messages, deliveries, api };
}

describe("GitHub monitors in isolated Core", () => {
  it("validates save input and shows the webhook secret exactly once", async () => {
    const f = await fixture(); await f.connect();
    const badRepo = await f.saveMonitor({ repos: ["example/.."] });
    expect(badRepo.status).toBe(400); expect(badRepo.body.error).toContain("仓库");
    const saved = await f.saveMonitor({ enableWebhook: true });
    expect(saved.status).toBe(200);
    expect(String(saved.body.webhookPath)).toBe("/hooks/github/" + saved.body.id);
    expect(String(saved.body.webhookSecret)).toMatch(/^[0-9a-f]{40}$/);
    const again = await f.api("connector-monitors/save", { id: saved.body.id, version: saved.body.version, repos: ["example/nexbot"], botId: f.botId, connectorId: f.app.connectors.list()[0].id });
    expect(again.status).toBe(200); expect(again.body.webhookSecret).toBeUndefined();
    const listBody = await f.api("connector-monitors/list", {});
    if (!(listBody.body.monitors ?? []).length) console.log("DEBUG-LIST", listBody.status, JSON.stringify(listBody.body).slice(0, 200));
    expect((listBody.body.monitors ?? []).length).toBeGreaterThan(0);
  });

  it("delivers notifications and new PRs via notify once, deduplicating across runs", async () => {
    const f = await fixture(); await f.connect();
    const saved = await f.saveMonitor();
    expect(saved.status).toBe(200);
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    const kinds = f.deliveries(String(saved.body.id)).map((row) => String(row.kind)).sort();
    expect(kinds).toEqual(["ci_failed", "pr_opened", "review_requested"]);
    const contents = f.messages().map((row) => String(row.content));
    expect(contents.some((content) => content.includes("[GitHub 新 PR] example/nexbot：新 PR #7"))).toBe(true);
    expect(contents.some((content) => content.includes("[GitHub 请求评审]"))).toBe(true);
    expect(contents.some((content) => content.includes("[GitHub CI 失败]"))).toBe(true);
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    expect(f.deliveries(String(saved.body.id))).toHaveLength(3);
    expect(f.messages()).toHaveLength(3);
  });

  it("delivers CI failures by fingerprint, clears on recovery and re-arms after the next failure", async () => {
    const f = await fixture(); await f.connect();
    const saved = await f.saveMonitor({ ciMode: "mine" });
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    expect(f.deliveries(String(saved.body.id)).some((row) => String(row.kind) === "ci_failed")).toBe(true);
    const ciCount = () => f.deliveries(String(saved.body.id)).filter((row) => String(row.kind) === "ci_failed").length;
    expect(ciCount()).toBe(1);
    f.github.state.checkConclusion = "success";
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    expect(ciCount()).toBe(0); // 恢复后解除布防
    f.github.state.checkConclusion = "failure";
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    expect(ciCount()).toBe(1); // 再次失败重新提醒
  });

  it("honors ignored branches and skipped CI modes", async () => {
    const f = await fixture(); await f.connect();
    const saved = await f.saveMonitor({ ignoreBranches: ["feature/*"], ciMode: "off" });
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    const kinds = f.deliveries(String(saved.body.id)).map((row) => String(row.kind));
    expect(kinds).toEqual(["review_requested"]); // PR #7 的 feature/* 分支被忽略：无 pr_opened、无 CI
  });

  it("pauses under rate limits and resumes when GitHub allows", async () => {
    const f = await fixture(); await f.connect();
    const saved = await f.saveMonitor();
    f.github.state.rateLimited = true; f.github.state.retryAfter = 1;
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    const row = f.app.store.get("SELECT last_error FROM personal_connector_monitors WHERE id=?", String(saved.body.id))!;
    expect(String(row.last_error)).toContain("过于频繁");
    expect(f.deliveries(String(saved.body.id))).toHaveLength(0);
    f.github.state.rateLimited = false;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    expect(f.deliveries(String(saved.body.id)).length).toBeGreaterThan(0);
    expect(String(f.app.store.get("SELECT last_error FROM personal_connector_monitors WHERE id=?", String(saved.body.id))!.last_error ?? "")).toBe("");
  });

  it("delivers task mode through the routine pipeline with an idempotent source key", async () => {
    const f = await fixture(); await f.connect();
    const saved = await f.saveMonitor({ delivery: "task" });
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    const lastError = f.app.store.get("SELECT last_error FROM personal_connector_monitors WHERE id=?", String(saved.body.id))!.last_error;
    if (String(lastError ?? "")) console.log("DEBUG-TASK-ERROR", String(lastError));
    const link = f.app.store.get("SELECT task_id FROM agent_task_links WHERE source_key LIKE 'github-monitor:%'");
    expect(link).toBeTruthy();
    const task = f.app.store.get("SELECT id, bot_id FROM tasks WHERE id=?", String(link!.task_id))!;
    expect(String(task.bot_id)).toBe(f.botId);
    const linksBefore = f.app.store.all("SELECT task_id, source_key FROM agent_task_links WHERE source_key LIKE 'github-monitor:%'").length;
    await f.app.monitors.runNow({ id: saved.body.id, version: saved.body.version });
    expect(f.app.store.all("SELECT task_id, source_key FROM agent_task_links WHERE source_key LIKE 'github-monitor:%'")).toHaveLength(linksBefore); // 重复轮询不新增任务
  });

  it("verifies webhook HMAC signatures, maps events and dedupes deliveries", async () => {
    const f = await fixture(); await f.connect();
    const saved = await f.saveMonitor({ enableWebhook: true });
    const monitorId = String(saved.body.id), secret = String(saved.body.webhookSecret);
    const post = async (event: string, deliveryId: string, payload: unknown, signature?: string) => {
      const raw = JSON.stringify(payload);
      return fetch(f.app.origin + "/hooks/github/" + monitorId, { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": deliveryId, ...(signature ? { "X-Hub-Signature-256": signature } : {}) }, body: raw });
    };
    const sign = (raw: string) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    const opened = { action: "opened", repository: { full_name: "example/nexbot" }, pull_request: { number: 9, title: "webhook pr", head: { ref: "feature/web" } } };
    const ok = await post("pull_request", "wh-1", opened, sign(JSON.stringify(opened)));
    if (ok.status !== 202) console.log("DEBUG-WEBHOOK", ok.status, JSON.stringify(await ok.json()));
    expect(ok.status).toBe(202);
    expect(f.messages().some((row) => String(row.content).includes("新 PR #9 webhook pr"))).toBe(true);
    const replay = await post("pull_request", "wh-1", opened, sign(JSON.stringify(opened)));
    expect(replay.status).toBe(202);
    expect(f.messages().filter((row) => String(row.content).includes("#9 webhook pr"))).toHaveLength(1);
    const bad = await post("pull_request", "wh-2", opened, "sha256=" + "0".repeat(64));
    expect(bad.status).toBe(401);
    const missing = await post("pull_request", "wh-3", opened);
    expect(missing.status).toBe(401);
    const foreignPayload = { action: "opened", repository: { full_name: "other/repo" }, pull_request: { number: 1, title: "x", head: { ref: "a" } } };
    const foreign = await post("pull_request", "wh-4", foreignPayload, sign(JSON.stringify(foreignPayload)));
    expect(foreign.status).toBe(202);
    expect(f.messages().some((row) => String(row.content).includes("other/repo"))).toBe(false);
    const reviewRequested = { action: "review_requested", repository: { full_name: "example/nexbot" }, pull_request: { number: 9, title: "webhook pr", head: { ref: "feature/web" } } };
    const requested = await post("pull_request", "wh-5", reviewRequested, sign(JSON.stringify(reviewRequested)));
    expect(requested.status).toBe(202);
    expect(f.messages().some((row) => String(row.content).includes("请求评审"))).toBe(true);
    const checkSuite = { action: "completed", repository: { full_name: "example/nexbot" }, check_suite: { head_branch: "main", conclusions: ["failure"] } };
    const suite = await post("check_suite", "wh-6", checkSuite, sign(JSON.stringify(checkSuite)));
    expect(suite.status).toBe(202);
    expect(f.messages().some((row) => String(row.content).includes("CI 失败"))).toBe(true);
  });
});
