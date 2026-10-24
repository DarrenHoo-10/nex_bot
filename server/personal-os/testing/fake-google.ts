import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Synthetic OAuth and Gmail endpoints, with no upstream network access. */
export async function startFakeGoogle() {
  const state = { email: "reader@example.test", scope: GMAIL_SCOPE, deny: false, rejectRefresh: false, api401: 0, apiStatus: 200, apiRedirect: "", revokeStatus: 200, echoToken: false, malformed: false, htmlOnly: false, body: "请查收本周项目进展。\n明天继续验证 Gmail 连接器。", threadCount: 2, attachmentCount: 1, tokenWait: undefined as Promise<void> | undefined, revokeWait: undefined as Promise<void> | undefined, apiWait: undefined as Promise<void> | undefined };
  const requests: Array<{ method: string; path: string; query: string; authorization: string }> = [];
  const codes = new Map<string, { challenge: string; redirect: string; email: string }>();
  const tokens = new Map<string, string>(), refreshes = new Map<string, string>();
  let exchanges = 0, refreshCount = 0, revocations = 0;
  const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url!, "http://fixture.test");
    requests.push({ method: request.method!, path: url.pathname, query: url.search, authorization: request.headers.authorization ?? "" });
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      if (redirect.hostname !== "127.0.0.1" || url.searchParams.get("client_id") !== "fixture-google-client" || url.searchParams.get("code_challenge_method") !== "S256") { json(response, 400, { error: "invalid_request" }); return; }
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      if (state.deny) redirect.searchParams.set("error", "access_denied");
      else {
        const code = randomBytes(12).toString("hex");
        codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")!, email: state.email });
        redirect.searchParams.set("code", code);
      }
      response.writeHead(302, { Location: redirect.href }); response.end(); return;
    }
    if (url.pathname === "/token" || url.pathname === "/revoke") {
      let raw = ""; for await (const chunk of request) raw += String(chunk);
      const data = new URLSearchParams(raw);
      if (url.pathname === "/revoke") {
        revocations++; await state.revokeWait;
        if (state.revokeStatus === 200) { const account = refreshes.get(data.get("token")!); for (const [token, email] of refreshes) if (email === account) refreshes.delete(token); for (const [token, email] of tokens) if (email === account) tokens.delete(token); }
        json(response, state.revokeStatus, {}); return;
      }
      if (data.get("client_id") !== "fixture-google-client" || data.get("client_secret") !== "synthetic-google-secret") { json(response, 401, { error: "invalid_client" }); return; }
      let email: string | undefined;
      const refreshing = data.get("grant_type") === "refresh_token";
      if (refreshing) { refreshCount++; email = state.rejectRefresh ? undefined : refreshes.get(data.get("refresh_token")!); }
      else {
        exchanges++;
        const code = codes.get(data.get("code")!); codes.delete(data.get("code")!);
        if (code?.challenge === createHash("sha256").update(data.get("code_verifier") ?? "").digest("base64url") && code.redirect === data.get("redirect_uri")) email = code.email;
      }
      await state.tokenWait;
      if (!email) { json(response, 400, { error: "invalid_grant", error_description: "synthetic-private-provider-detail" }); return; }
      const accessToken = "synthetic-access-" + randomBytes(12).toString("hex"); tokens.set(accessToken, email);
      const refreshToken = "synthetic-refresh-" + randomBytes(12).toString("hex");
      if (!refreshing) refreshes.set(refreshToken, email);
      json(response, 200, { access_token: accessToken, ...(refreshing ? {} : { refresh_token: refreshToken }), token_type: "Bearer", expires_in: 3600, scope: state.scope }); return;
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/")) {
      const accessToken = (request.headers.authorization ?? "").replace(/^Bearer /, ""), email = tokens.get(accessToken);
      if (!email || state.api401-- > 0) { json(response, 401, { error: "unauthorized" }); return; }
      await state.apiWait;
      if (state.apiRedirect) { response.writeHead(302, { Location: state.apiRedirect }); response.end(); return; }
      if (state.apiStatus !== 200) { json(response, state.apiStatus, { error: { message: "synthetic-private-provider-detail " + accessToken } }); return; }
      if (state.malformed) { response.writeHead(200); response.end("synthetic-private-provider-detail"); return; }
      const mail = (id: string) => ({ id, threadId: "t1", snippet: state.echoToken ? accessToken : "周五项目进展与待办", labelIds: ["INBOX", "UNREAD"], payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "项目进展" }, { name: "From", value: "team@example.test" }, { name: "To", value: email }, { name: "Date", value: "Fri, 23 Oct 2026 10:00:00 +0800" }], parts: [{ mimeType: state.htmlOnly ? "text/html" : "text/plain", body: { data: Buffer.from(state.body).toString("base64url") } }, ...Array.from({ length: state.attachmentCount }, () => ({ filename: "progress.pdf", mimeType: "application/pdf", body: { attachmentId: "a1", size: 1024 } }))] } });
      const route = url.pathname.slice("/gmail/v1/users/me/".length);
      if (route === "profile") { json(response, 200, { emailAddress: email }); return; }
      if (route === "messages") { json(response, 200, { messages: [{ id: url.searchParams.has("pageToken") ? "m2" : "m1", threadId: "t1" }], ...(url.searchParams.has("pageToken") ? {} : { nextPageToken: "next-page" }), resultSizeEstimate: 2 }); return; }
      if (route === "messages/m1" || route === "messages/m2") { json(response, 200, mail(route.split("/")[1])); return; }
      if (route === "threads/t1") { json(response, 200, { id: "t1", messages: Array.from({ length: state.threadCount }, (_, index) => mail("m" + (index + 1))) }); return; }
      json(response, 404, { error: "not_found" }); return;
    }
    json(response, 404, { error: "not_found" });
  })().catch(() => { if (!response.headersSent) json(response, 500, { error: "fixture_failure" }); else response.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, state, requests, get exchanges() { return exchanges; }, get refreshCount() { return refreshCount; }, get revocations() { return revocations; }, configuration: { clientId: "fixture-google-client", clientSecret: "synthetic-google-secret", fixtureOrigin: origin }, async close() { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); } };
}
