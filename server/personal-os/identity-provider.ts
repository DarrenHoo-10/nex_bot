// A first-party bridge for the existing nex_user service. It is deliberately
// separate from Core's identity mapping and from the future native-v1 adapter.
export const NEX_USER_ORIGIN = "https://user.nexorai.com.cn";
export class IdentityError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface UpstreamSession { cookie: string; csrf: string; subject: string; displayName: string; expiresAt: number }
export interface IdentityProvider {
  login(account: string, password: string): Promise<UpstreamSession>;
  status(session: UpstreamSession): Promise<{ subject: string; displayName: string }>;
  revoke(session: UpstreamSession): Promise<void>;
}
export function identityBase(value: unknown, allowFixtureHttp = false) {
  if (typeof value !== "string" || value.length > 2048) throw new IdentityError(400, "请输入有效的用户中心地址");
  let url: URL;
  try { url = new URL(value); } catch { throw new IdentityError(400, "请输入有效的用户中心地址"); }
  const fixture = allowFixtureHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!fixture && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new IdentityError(400, "用户中心须使用 HTTPS 根地址");
  return url.origin;
}
function bounded(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || ["\r", "\n", "\0"].some((character) => value.includes(character))) throw new IdentityError(502, "用户中心返回了无效的身份结果");
  return value;
}
export class NexUserProvider implements IdentityProvider {
  constructor(readonly base: string, readonly signal: AbortSignal) {}
  private async request(route: string, data?: unknown, session?: UpstreamSession) {
    let response: Response;
    try {
      response = await fetch(this.base + route, { method: data === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.any([this.signal, AbortSignal.timeout(5_000)]), headers: { Accept: "application/json", ...(data === undefined ? {} : { "Content-Type": "application/json", Origin: this.base }), ...(session ? { Cookie: `user_session=${session.cookie}`, "X-CSRF-Token": session.csrf } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    } catch { throw new IdentityError(503, "用户中心暂时无法连接，请稍后重试"); }
    if (!response.ok) await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new IdentityError(401, "邮箱或密码不正确，或登录已失效");
    if (response.status === 429) throw new IdentityError(429, "登录尝试过多，请稍后重试");
    if (!response.ok) throw new IdentityError(503, "用户中心暂时不可用，请稍后重试");
    if (route === "/v1/logout") { await response.body?.cancel(); return { response, data: {} as Record<string, unknown> }; }
    try {
      if (!response.headers.get("content-type")?.includes("application/json")) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body!.getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 64_000) throw new Error(); chunks.push(value); } }
      finally { await reader.cancel(); reader.releaseLock(); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return { response, data: parsed as Record<string, unknown> };
    } catch { throw new IdentityError(502, "用户中心返回了无效的身份结果"); }
  }
  private user(data: Record<string, unknown>) {
    const user = data.user as Record<string, unknown> | undefined;
    return { subject: bounded(user?.userId), displayName: bounded(user?.displayName, 160) };
  }
  async login(account: string, password: string) {
    const { response, data } = await this.request("/v1/login", { email: account, password });
    const user = this.user(data), csrf = bounded(data.csrfToken, 256);
    const cookies = response.headers.getSetCookie().filter((cookie) => cookie.startsWith("user_session="));
    const usable = cookies.map((cookie) => {
      const value = cookie.split(";", 1)[0].slice("user_session=".length);
      const age = cookie.match(/;\s*max-age=(\d+)/i), until = cookie.match(/;\s*expires=([^;]+)/i);
      const expiresAt = age ? Date.now() + Number(age[1]) * 1000 : until ? Date.parse(until[1]) : 0;
      return { value, expiresAt, httpOnly: /;\s*httponly(?:;|$)/i.test(cookie) };
    }).filter((cookie) => cookie.expiresAt > Date.now() && cookie.httpOnly && /^[A-Za-z0-9_-]{20,256}$/.test(cookie.value));
    if (usable.length !== 1 || !Number.isSafeInteger(usable[0].expiresAt)) throw new IdentityError(502, "用户中心没有返回有效的登录会话");
    const session: UpstreamSession = { ...user, csrf, cookie: usable[0].value, expiresAt: usable[0].expiresAt };
    try { const verified = await this.status(session); if (verified.subject !== session.subject) throw new IdentityError(502, "用户中心身份不一致"); return { ...session, displayName: verified.displayName }; }
    catch (error) { await this.revoke(session).catch(() => {}); throw error; }
  }
  async status(session: UpstreamSession) {
    if (session.expiresAt <= Date.now()) throw new IdentityError(401, "登录已过期，请重新登录");
    return this.user((await this.request("/v1/session", undefined, session)).data);
  }
  async revoke(session: UpstreamSession) { await this.request("/v1/logout", {}, session); }
}
