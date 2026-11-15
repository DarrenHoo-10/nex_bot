import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonalApp } from "./index.ts";
import { startFakeGithub } from "./testing/fake-github.ts";
import { GithubProvider, githubFromEnvironment, validateGithubArguments } from "./github-provider.ts";
import type { ConnectorOAuthView } from "../../shared/personal-connectors.ts";

interface Flow { id: string; authorizationUrl?: string; userCode?: string; verificationUri?: string; expiresAt: number }
interface ExecuteResult { isError: boolean; text: string; structured: any; images?: unknown[] }
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function temporaryDirectory() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-github-fixture-"));
  cleanup.push(async () => { if (path.dirname(root).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(root).startsWith("nex-github-fixture-")) throw new Error("Unsafe cleanup"); rmSync(root, { recursive: true, force: true }); });
  return root;
}
type Options = Parameters<typeof createPersonalApp>[0];
async function fixtureApp(github: Record<string, unknown>, root = temporaryDirectory()) {
  const options = { dir: root, key: randomBytes(32), token: "synthetic-owner", identity: false as const, hostDevice: false as const, memoryRuntime: false as const, modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} }, github } as unknown as Options;
  let app = await createPersonalApp(options); cleanup.push(() => app.close());
  async function restart() { await app.close(); app = await createPersonalApp(options); }
  return { get app() { return app; }, options, restart };
}
async function fixture(githubConfiguration: Record<string, unknown> | undefined, root?: string) {
  const github = await startFakeGithub(); cleanup.push(() => github.close());
  const base = await fixtureApp(githubConfiguration ? { ...githubConfiguration, fixtureOrigin: github.origin } : { fixtureOrigin: github.origin }, root);
  const botId = base.app.store.createBot("代码助手");
  async function api<T = Record<string, unknown>>(route: string, data?: unknown, token = "synthetic-owner") {
    const response = await fetch(base.app.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() as T };
  }
  const current = () => base.app.connectors.list()[0];
  async function begin(data: Record<string, unknown> = {}) { const response = await api<Flow>("connectors/oauth/start", { provider: "github", ...data }); expect(response.status).toBe(200); return response.body; }
  async function callbackUrl(flow: Flow) { const response = await fetch(flow.authorizationUrl!, { redirect: "manual" }); expect(response.status).toBe(302); return response.headers.get("location")!; }
  function execute(tool = "github.me", parameters: Record<string, unknown> = {}, connector = current(), authorize = async () => {}): Promise<ExecuteResult> {
    return base.app.connectors.execute({ bot_id: botId, task_id: "synthetic-task" }, { action: "connector.call", connectorId: connector.id, connectorVersion: connector.version, tool, parameters }, authorize) as Promise<ExecuteResult>;
  }
  return { github, options: base.options, get app() { return base.app; }, restart: base.restart, api, current, begin, callbackUrl, execute, botId };
}

describe("GitHub connectors in isolated Core", () => {
  it("connects through the device flow, survives restart and lists the catalog", async () => {
    const f = await fixture(undefined), catalog = f.app.connectors.catalog();
    expect(catalog.find((entry) => entry.id === "github")).toMatchObject({ name: "GitHub", available: true });
    const flow = await f.begin();
    expect(flow.userCode).toBe("ABCD-1234");
    expect(flow.verificationUri).toBe(f.github.origin + "/login/device");
    expect(flow.authorizationUrl).toBeUndefined();
    expect((await f.api<ConnectorOAuthView>("connectors/oauth/status?id=" + flow.id)).body.status).toBe("pending");
    f.github.state.deviceApprove = true;
    await expect.poll(async () => (await f.api<ConnectorOAuthView>("connectors/oauth/status?id=" + flow.id)).body.status, { timeout: 20_000 }).toBe("connected");
    expect(f.current()).toMatchObject({ provider: "github", name: "GitHub", account: "octocat-fixture", hasToken: true });
    expect(await f.execute()).toMatchObject({ isError: false, structured: { login: "octocat-fixture" } });
    const connected = f.current(); await f.restart();
    expect(f.current()).toEqual(connected);
    expect(await f.execute()).toMatchObject({ structured: { login: "octocat-fixture" } });
    f.github.state.apiStatus = 403;
    await expect(f.execute("github.pr", { repo: "example/nexbot", number: 7 })).rejects.toThrow("拒绝了这个请求");
    f.github.state.apiStatus = 200;
    const removed = await f.api("connectors/delete", { ...f.current() });
    expect(removed.status).toBe(200); expect(String(removed.body.warning)).toContain("暂未自动撤销");
    expect(f.app.connectors.list()).toEqual([]);
  }, 60_000);

  it("connects through the OAuth web flow, rejects replay, forgery and duplicate accounts", async () => {
    const f = await fixture({ clientId: "fixture-github-client", clientSecret: "synthetic-github-secret" });
    const flow = await f.begin();
    expect(flow.authorizationUrl).toContain("/login/oauth/authorize");
    expect(flow.authorizationUrl).toContain("scope=repo+notifications");
    expect(flow.authorizationUrl).not.toContain("synthetic-github-secret");
    const callback = await f.callbackUrl(flow);
    expect((await fetch(callback)).status).toBe(200);
    expect(f.current()).toMatchObject({ provider: "github", account: "octocat-fixture", hasToken: true });
    expect(String(f.app.store.get("SELECT credential FROM personal_connectors")?.credential)).not.toContain("synthetic-");
    expect((await fetch(callback)).status).toBe(400); expect(f.github.exchanges).toBe(1);
    f.github.state.deny = true;
    const denied = await f.begin(); expect((await fetch(await f.callbackUrl(denied))).status).toBe(400);
    expect((await f.api<ConnectorOAuthView>("connectors/oauth/status?id=" + denied.id)).body.error).toContain("授权未完成");
    f.github.state.deny = false;
    const forged = await f.begin(), callbackUrl = new URL(await f.callbackUrl(forged));
    callbackUrl.searchParams.set("state", "forged"); expect((await fetch(callbackUrl)).status).toBe(400);
    f.github.state.login = "second-account";
    const separate = await f.begin(); expect((await fetch(await f.callbackUrl(separate))).status).toBe(200);
    expect(f.app.connectors.list()).toHaveLength(2);
    const duplicate = await f.begin(); expect((await fetch(await f.callbackUrl(duplicate))).status).toBe(400);
    expect(f.app.connectors.list()).toHaveLength(2);
  }, 60_000);

  it("binds a PAT, discovers the account on test and serves reads and bounded log tails", async () => {
    const f = await fixture({ clientId: "fixture-github-client", clientSecret: "synthetic-github-secret" });
    expect((await f.api("connectors/save", { provider: "github", token: "synthetic-pat-token" })).status).toBe(200);
    expect(f.current()).toMatchObject({ provider: "github", account: null, hasToken: true, url: "https://api.github.com" });
    expect((await f.api("connectors/test", { ...f.current() })).status).toBe(200);
    expect(f.current()).toMatchObject({ account: "octocat-fixture", error: null });
    const checks = await f.execute("github.pr.checks", { repo: "example/nexbot", number: 7, includeLogTail: true });
    expect(checks).toMatchObject({ isError: false, structured: { head: expect.stringMatching(/^a1b2c3d4/), pending: false, failures: ["unit-test"], logTail: { job: "unit-test", text: expect.stringContaining("expect(2+2).toBe(5)") }, checks: [{ name: "unit-test", state: "failure" }, { name: "build", state: "success" }], statuses: [{ context: "ci/verify", state: "success" }] } });
    expect(String(checks.structured.fingerprint)).toHaveLength(64);
    expect(await f.execute("github.pr.list", { repo: "example/nexbot" })).toMatchObject({ structured: { items: [{ number: 7, title: "feat: github 连接器" }] } });
    expect(await f.execute("github.notifications")).toMatchObject({ structured: { items: [{ reason: "review_requested", repo: { fullName: "example/nexbot" } }] } });
    expect(await f.execute("github.actions.log", { repo: "example/nexbot", jobId: 99 })).toMatchObject({ structured: { text: expect.stringContaining("合成测试") } });
    await expect(f.execute("github.comment", { repo: "example/..", number: 7, body: "x" })).rejects.toThrow("仓库标识无效");
    await expect(f.execute("github.comment", { repo: "example/nexbot", number: 7, body: "x".repeat(17_000) })).rejects.toThrow("内容无效");
    await expect(f.execute("github.search", { query: "is:pr", page: 0 })).rejects.toThrow("页码");
    expect(() => validateGithubArguments("github.nonexistent", {})).toThrow("GitHub 工具或参数无效");
    expect(githubFromEnvironment({})).toBeUndefined();
    expect(() => githubFromEnvironment({ NEX_GITHUB_CLIENT_ID: "only-one" })).toThrow("同时配置");
    expect(() => new GithubProvider({ clientId: "a", clientSecret: "b", fixtureOrigin: "https://real-provider.example" })).toThrow();
  });

  it("runs writes through the connector gateway and redacts tokens from every result", async () => {
    const f = await fixture({ clientId: "fixture-github-client", clientSecret: "synthetic-github-secret" });
    const flow = await f.begin(); await fetch(await f.callbackUrl(flow));
    const comment = await f.execute("github.comment", { repo: "example/nexbot", number: 7, body: "已合并前的说明" });
    expect(comment).toMatchObject({ isError: false, structured: { id: 9001 } });
    expect(await f.execute("github.merge", { repo: "example/nexbot", number: 7, mergeMethod: "squash" })).toMatchObject({ structured: { merged: true } });
    expect(await f.execute("github.review", { repo: "example/nexbot", number: 7, event: "APPROVE" })).toMatchObject({ structured: { state: "APPROVED" } });
    expect(await f.execute("github.issue.create", { repo: "example/nexbot", title: "跟进连接器", body: "事项" })).toMatchObject({ structured: { number: 42 } });
    f.github.state.echoToken = true;
    f.github.state.logBody = "token in log: ghp_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";
    const leaked = await f.execute("github.pr.checks", { repo: "example/nexbot", number: 7, includeLogTail: true });
    const serialized = JSON.stringify(leaked);
    expect(serialized).toContain("[redacted]"); expect(serialized).toContain("[token]");
    expect(serialized).not.toContain("synthetic-access"); expect(serialized).not.toContain("ghp_a1b2");
    f.github.state.echoToken = false;
    f.github.state.api401 = 1;
    await expect(f.execute("github.me")).rejects.toThrow("授权已失效");
    expect(f.current()).toMatchObject({ hasToken: false, error: "GitHub 授权已失效，请重新连接" });
  }, 60_000);

  it("keeps account identity stable across reconnection and refuses provider switching", async () => {
    const f = await fixture({ clientId: "fixture-github-client", clientSecret: "synthetic-github-secret" });
    const flow = await f.begin(); await fetch(await f.callbackUrl(flow));
    const original = f.current();
    f.github.state.login = "someone-else";
    const reconnect = await f.begin({ ...original }); expect((await fetch(await f.callbackUrl(reconnect))).status).toBe(400);
    expect(f.current()).toEqual(original);
    expect((await f.api("connectors/save", { ...original, url: "https://example.test/mcp", token: "x", provider: "mcp" })).status).toBe(400);
    f.github.state.login = "third-account";
    const separate = await f.begin(); expect((await fetch(await f.callbackUrl(separate))).status).toBe(200);
    expect(f.app.connectors.list()).toHaveLength(2);
  }, 60_000);
});
