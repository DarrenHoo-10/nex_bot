import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// Strict synthetic nex_user contract. Never opens a real account or service.
export async function startFakeIdentity({ displayName = "合成用户" } = {}) {
  const sessions = new Map<string, { subject: string; csrf: string; active: boolean }>();
  const state = { status: 200, loginCount: 0, logoutCount: 0, maxAge: 30 * 86400, logoutStatus: 204 };
  const server = createServer((request, response) => {
    void (async () => {
      const send = (status: number, value: unknown = {}) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(status === 204 ? undefined : JSON.stringify(value)); };
      const cookie = /(?:^|;\s*)user_session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
      if (request.url === "/v1/login" && request.method === "POST") {
        let body = ""; for await (const chunk of request) body += chunk;
        const data = JSON.parse(body); state.loginCount++;
        if (!["owner@example.test", "other@example.test"].includes(data.email) || data.password !== " synthetic password ") { send(401); return; }
        const token = randomBytes(32).toString("base64url"), csrf = randomBytes(24).toString("base64url"), subject = data.email === "owner@example.test" ? "synthetic-owner-uid" : "synthetic-other-uid";
        sessions.set(token, { subject, csrf, active: true });
        response.setHeader("Set-Cookie", [`user_session=; HttpOnly; Max-Age=-1; Path=/`, `user_session=${token}; HttpOnly; SameSite=Lax; Domain=example.test; Path=/; Max-Age=${state.maxAge}`]);
        send(200, { user: { userId: subject, displayName }, csrfToken: csrf }); return;
      }
      const session = cookie ? sessions.get(cookie) : undefined;
      if (request.url === "/v1/session") {
        if (state.status !== 200) { send(state.status); return; }
        if (!session?.active) { send(401); return; }
        send(200, { user: { userId: session.subject, displayName }, csrfToken: session.csrf }); return;
      }
      if (request.url === "/v1/logout" && request.method === "POST") {
        state.logoutCount++;
        if (state.logoutStatus !== 204) { send(state.logoutStatus); return; }
        if (!session || request.headers["x-csrf-token"] !== session.csrf) { send(403); return; }
        session.active = false; send(204); return;
      }
      send(404);
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, state, sessions, async close() { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); } };
}
