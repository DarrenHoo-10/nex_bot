import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

const HEAD = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

/** Synthetic OAuth (web + device flow) and GitHub REST endpoints, with no upstream network access. */
export async function startFakeGithub() {
  const state = {
    login: "octocat-fixture", scope: "repo,notifications,read:org,workflow", deny: false, deviceApprove: false, devicePending: 0,
    slowDown: false, apiStatus: 200, api401: 0, echoToken: false, malformed: false, revokeStatus: 200, checkConclusion: "failure", rateLimited: false, retryAfter: 120, rateWaitCount: 0, logBody: "2026-11-15T10:00:01 合成测试：unit-test 失败于 expect(2+2).toBe(5)\n使用合成日志验证日志尾部裁剪。",
  };
  const requests: Array<{ method: string; path: string; query: string; authorization: string }> = [];
  const hooks: Array<{ id: number; events: string[]; active: boolean; config: { url: string; secret: string } }> = [];
  const codes = new Map<string, { redirect: string }>();
  const tokens = new Map<string, string>();
  let exchanges = 0, deviceStarts = 0, devicePolls = 0, revocations = 0;
  const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url!, "http://fixture.test");
    requests.push({ method: request.method!, path: url.pathname, query: url.search, authorization: request.headers.authorization ?? "" });
    if (url.pathname === "/login/device/code") {
      let raw = ""; for await (const chunk of request) raw += String(chunk);
      const data = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (!data.client_id) { json(response, 400, { error: "incorrect_client_credentials" }); return; }
      deviceStarts++;
      json(response, 200, { device_code: "synthetic-device-code", user_code: "ABCD-1234", verification_uri: "http://" + (request.headers.host ?? "127.0.0.1") + "/login/device", expires_in: 900, interval: 0.2 });
      return;
    }
    if (url.pathname === "/login/oauth/access_token") {
      let raw = ""; for await (const chunk of request) raw += String(chunk);
      const data = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (data.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        devicePolls++;
        if (!state.deviceApprove) { json(response, 200, { error: "authorization_pending" }); return; }
        if (state.slowDown) { state.slowDown = false; json(response, 200, { error: "slow_down" }); return; }
        const accessToken = "synthetic-access-" + randomBytes(12).toString("hex"); tokens.set(accessToken, state.login);
        json(response, 200, { access_token: accessToken, token_type: "bearer", scope: state.scope });
        return;
      }
      if (data.client_id !== "fixture-github-client" || data.client_secret !== "synthetic-github-secret") { json(response, 401, { error: "incorrect_client_credentials" }); return; }
      exchanges++;
      const code = codes.get(String(data.code)); codes.delete(String(data.code)!);
      if (!code || code.redirect !== data.redirect_uri) { json(response, 400, { error: "bad_verification_code", error_description: "synthetic-private-provider-detail" }); return; }
      const accessToken = "synthetic-access-" + randomBytes(12).toString("hex"); tokens.set(accessToken, state.login);
      json(response, 200, { access_token: accessToken, token_type: "bearer", scope: state.scope });
      return;
    }
    if (url.pathname === "/login/oauth/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      if (redirect.hostname !== "127.0.0.1" || url.searchParams.get("client_id") !== "fixture-github-client") { json(response, 400, { error: "invalid_request" }); return; }
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      if (state.deny) redirect.searchParams.set("error", "access_denied");
      else { const code = randomBytes(12).toString("hex"); codes.set(code, { redirect: url.searchParams.get("redirect_uri")! }); redirect.searchParams.set("code", code); }
      response.writeHead(302, { Location: redirect.href }); response.end(); return;
    }
    if (url.pathname === "/login/device") { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><title>fixture device page</title>"); return; }
    if (!url.pathname.startsWith("/api/v3/")) { json(response, 404, { message: "Not Found" }); return; }
    const accessToken = (request.headers.authorization ?? "").replace(/^Bearer /, ""), login = tokens.get(accessToken) ?? (accessToken ? state.login : undefined);
    if (!login || state.api401-- > 0) { json(response, 401, { message: "Bad credentials" }); return; }
    if (state.apiStatus !== 200) { json(response, state.apiStatus, { message: "synthetic-private-provider-detail " + accessToken }); return; }
    if (state.malformed) { response.writeHead(200); response.end("synthetic-private-provider-detail"); return; }
    const echo = state.echoToken ? accessToken : "";
    const route = url.pathname.slice("/api/v3/".length);
    const ok = (value: unknown) => json(response, 200, value);
    if (route === "repos/example/nexbot/hooks") {
      if (request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const data = JSON.parse(body);
        hooks.push({ ...data, id: hooks.length + 1 });
        json(response, 201, { id: hooks.length }); return;
      }
      ok(hooks); return;
    }
    if (route === "repos/example/nexbot/hooks/1/pings" && request.method === "POST") {
      response.writeHead(204); response.end(); return;
    }
    if (request.method === "DELETE" && route.startsWith("applications/")) {
      revocations++;
      const basic = Buffer.from((request.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString("utf8");
      if (basic !== "fixture-github-client:synthetic-github-secret") { json(response, 401, { message: "Bad credentials" }); return; }
      if (state.revokeStatus === 200) tokens.delete(accessToken);
      json(response, state.revokeStatus, {}); return;
    }
    if (route === "user") { ok({ login, name: "合成章鱼猫", html_url: "https://github.com/" + login }); return; }
    if (route === "user/repos") { ok([{ full_name: "example/nexbot", private: false, default_branch: "main", pushed_at: "2026-11-15T09:00:00Z", html_url: "https://github.com/example/nexbot" }]); return; }
    if (route === "notifications") {
      if (state.rateLimited) { state.rateWaitCount++; response.writeHead(429, { "Retry-After": String(state.retryAfter), "Content-Type": "application/json" }); response.end(JSON.stringify({ message: "rate limited" })); return; } ok([{ id: "n1", reason: "review_requested", subject: { title: echo ? "echo " + echo : "feat: github 连接器", type: "PullRequest" }, repository: { full_name: "example/nexbot" }, updated_at: "2026-11-15T09:30:00Z" }]); return; }
    if (route === "search/issues") { ok({ total_count: 1, items: [{ number: 7, title: "feat: github 连接器", state: "open", repository_url: url.origin + "/repos/example/nexbot", pull_request: { url: "x" }, html_url: "https://github.com/example/nexbot/pull/7" }] }); return; }
    const pull = (number: number) => ({ number, title: "feat: github 连接器", state: "open", draft: false, body: "连接器实现。\n" + echo, user: { login: "octocat-fixture", type: "User" }, head: { ref: "feature/github-connector", sha: HEAD }, base: { ref: "main" }, mergeable_state: "clean", requested_reviewers: [{ login: "octocat-fixture" }], additions: 900, deletions: 12, changed_files: 6, html_url: `https://github.com/example/nexbot/pull/${number}`, created_at: "2026-11-15T08:00:00Z", updated_at: "2026-11-15T09:30:00Z" });
    if (route === "repos/example/nexbot/pulls") { ok(url.searchParams.get("page") === "2" ? [] : [pull(7)]); return; }
    if (route === "repos/example/nexbot/pulls/7") { ok(pull(7)); return; }
    if (route === `repos/example/nexbot/commits/${HEAD}/check-runs`) { ok({ total_count: 2, check_runs: [{ id: 99, name: "unit-test", status: "completed", conclusion: state.checkConclusion === "success" ? "success" : state.checkConclusion }, { id: 100, name: "build", status: "completed", conclusion: "success" }] }); return; }
    if (route === `repos/example/nexbot/commits/${HEAD}/status`) { ok({ total_count: 1, statuses: [{ context: "ci/verify", state: "success" }] }); return; }
    if (route === "repos/example/nexbot/actions/jobs/99/logs") { response.writeHead(200, { "Content-Type": "text/plain" }); response.end(state.logBody + (echo ? "\n" + echo : "")); return; }
    if (route === "repos/example/nexbot/actions/runs") { ok({ total_count: 1, workflow_runs: [{ id: 501, name: "verify", status: "completed", conclusion: "failure", head_branch: "feature/github-connector", head_sha: HEAD, event: "push", html_url: "https://github.com/example/nexbot/actions/runs/501", created_at: "2026-11-15T09:00:00Z", updated_at: "2026-11-15T09:05:00Z" }] }); return; }
    if (route === "repos/example/nexbot/issues") {
      if (request.method === "POST") { let raw = ""; for await (const chunk of request) raw += String(chunk); const data = JSON.parse(raw || "{}"); ok({ number: 42, html_url: "https://github.com/example/nexbot/issues/42", title: data.title }); return; }
      ok([{ number: 11, title: echo ? "echo " + echo : "合成 issue", state: "open", user: { login: "octocat-fixture", type: "User" }, comments: 0, updated_at: "2026-11-15T07:00:00Z", html_url: "https://github.com/example/nexbot/issues/11" }]);
      return;
    }
    if (route === "repos/example/nexbot/issues/11") { ok({ number: 11, title: "合成 issue", state: "open", body: "issue 正文。" + echo, user: { login: "octocat-fixture", type: "User" }, labels: [{ name: "fixture" }], comments: 0, html_url: "https://github.com/example/nexbot/issues/11", created_at: "2026-11-14T07:00:00Z", updated_at: "2026-11-15T07:00:00Z" }); return; }
    if (route === "repos/example/nexbot/issues/7/comments") {
      let raw = ""; for await (const chunk of request) raw += String(chunk);
      ok({ id: 9001, html_url: "https://github.com/example/nexbot/pull/7#issuecomment-9001", body: (JSON.parse(raw || "{}") as { body?: string }).body });
      return;
    }
    if (route === "repos/example/nexbot/pulls/7/reviews") {
      let raw = ""; for await (const chunk of request) raw += String(chunk);
      const data = JSON.parse(raw || "{}") as Record<string, unknown>;
      ok({ id: 7001, state: String(data.event ?? "COMMENT").replace("APPROVE", "APPROVED").replace("REQUEST_CHANGES", "CHANGES_REQUESTED"), html_url: "https://github.com/example/nexbot/pull/7#review-7001" });
      return;
    }
    if (route === "repos/example/nexbot/pulls/7/merge") { ok({ merged: true, sha: HEAD, message: "Pull Request successfully merged" }); return; }
    json(response, 404, { message: "Not Found" });
  })().catch(() => { if (!response.headersSent) json(response, 500, { message: "fixture_failure" }); else response.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, state, requests, hooks, get exchanges() { return exchanges; }, get deviceStarts() { return deviceStarts; }, get devicePolls() { return devicePolls; }, get revocations() { return revocations; },
    configuration: { clientId: "fixture-github-client", clientSecret: "synthetic-github-secret", fixtureOrigin: origin },
    async close() { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); },
  };
}
export const FAKE_GITHUB_HEAD = HEAD;
