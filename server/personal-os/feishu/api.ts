export type Brand = "feishu" | "lark";
export function feishuOrigins(brand: Brand): { open: string; accounts: string } {
  return brand === "lark"
    ? { open: "https://open.larksuite.com", accounts: "https://accounts.larksuite.com" }
    : { open: "https://open.feishu.cn", accounts: "https://accounts.feishu.cn" };
}

export class FeishuApiError extends Error {
  constructor(readonly code: number, message: string, readonly status: number, readonly payload?: unknown) { super(message); }
  get scopes(): string[] { return violationScopes(this.payload); }
}

export interface FeishuCredentials { appId: string; appSecret: string; brand: Brand }

/** 缺权限错误的应用/用户层归属，用于生成结构化工具结果。 */
export function missingScope(error: unknown): { layer: "app" | "user" | "token"; code: number } | undefined {
  if (!(error instanceof FeishuApiError)) return undefined;
  if (error.code === 99991672) return { layer: "app", code: error.code };
  if (error.code === 99991679 || error.code === 99991676) return { layer: "user", code: error.code };
  if ([99991661, 99991663, 99991668, 99991671, 99991677].includes(error.code)) return { layer: "token", code: error.code };
  return undefined;
}

const rateLimited = new Set([230049, 230020, 99991400]);
const tenantTokenInvalid = new Set([99991661, 99991663, 99991668, 99991671, 99991677]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 从缺权限错误里取平台点名的 scope（permission_violations[].subject）。 */
export function violationScopes(payload: unknown): string[] {
  const error = record(record(payload).error);
  const violations = Array.isArray(error.permission_violations) ? error.permission_violations : Array.isArray(record(payload).permission_violations) ? record(payload).permission_violations as unknown[] : [];
  const scopes = violations.map((item) => record(item).subject).filter((value): value is string => typeof value === "string" && !!value);
  return [...new Set(scopes)];
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** 每应用 15 QPS 的朴素闸门：发送间隔不足时排队。 */
class Gate {
  private next = 0;
  async wait() {
    const now = Date.now(), earliest = this.next;
    this.next = Math.max(now, earliest) + 66;
    if (earliest > now) await sleep(earliest - now);
  }
}

/** OpenAPI 客户端：tenant token 缓存、限流、429/限流码退避重试。凭据只进内存。 */
export class FeishuApi {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly gates = new Map<string, Gate>();
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  private gate(appId: string) { let gate = this.gates.get(appId); if (!gate) { gate = new Gate(); this.gates.set(appId, gate); } return gate; }
  private async tenantToken(app: FeishuCredentials): Promise<string> {
    const cached = this.tokens.get(app.appId);
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;
    const response = await this.fetchImpl(`${feishuOrigins(app.brand).open}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const token = typeof data.tenant_access_token === "string" ? data.tenant_access_token : "";
    const expire = typeof data.expire === "number" ? data.expire : 0;
    if (!token || data.code !== 0) throw new FeishuApiError(Number(data.code ?? response.status), String(data.msg ?? "获取应用凭据失败"), response.status);
    this.tokens.set(app.appId, { token, expiresAt: Date.now() + expire * 1000 });
    return token;
  }
  async request<T = Record<string, unknown>>(app: FeishuCredentials, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0;; attempt++) {
      await this.gate(app.appId).wait();
      const token = await this.tenantToken(app);
      const response = await this.fetchImpl(`${feishuOrigins(app.brand).open}${path}${path.includes("?") ? "&" : "?"}lang=zh_cn`, {
        method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(async (error) => { if (attempt >= 2) throw error; await sleep(500 * 2 ** attempt); return undefined; });
      if (!response) continue;
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const code = Number(data.code ?? 0);
      if (response.ok && code === 0) return data as T;
      if (tenantTokenInvalid.has(code) && attempt < 1) { this.tokens.delete(app.appId); continue; }
      if ((rateLimited.has(code) || response.status === 429) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 32_000) : 500 * 2 ** attempt);
        continue;
      }
      throw new FeishuApiError(code, String(data.msg ?? `HTTP ${response.status}`), response.status, data);
    }
  }
  /** 多实例防护：长连接已被其它实例持有时不重复连接。 */
  async onlineInstances(app: FeishuCredentials): Promise<number> {
    const data = await this.request<{ online_instance_cnt?: number }>(app, "GET", "/open-apis/event/v1/connection");
    return Number(data.online_instance_cnt ?? 0);
  }
  async botOpenId(app: FeishuCredentials): Promise<string | undefined> {
    const data = await this.request<{ bot?: { open_id?: string } }>(app, "GET", "/open-apis/bot/v3/info");
    return typeof data.bot?.open_id === "string" ? data.bot.open_id : undefined;
  }

  /** 用户身份调用：与 request 相同的限流与重试，Bearer 换成 user_access_token。 */
  async userRequest<T = Record<string, unknown>>(app: FeishuCredentials, userToken: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0;; attempt++) {
      await this.gate(app.appId).wait();
      const response = await this.fetchImpl(`${feishuOrigins(app.brand).open}${path}${path.includes("?") ? "&" : "?"}lang=zh_cn`, {
        method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` }, body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(async (error) => { if (attempt >= 2) throw error; await sleep(500 * 2 ** attempt); return undefined; });
      if (!response) continue;
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const code = Number(data.code ?? 0);
      if (response.ok && code === 0) return data as T;
      if ((rateLimited.has(code) || response.status === 429) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 32_000) : 500 * 2 ** attempt);
        continue;
      }
      throw new FeishuApiError(code, String(data.msg ?? `HTTP ${response.status}`), response.status, data);
    }
  }

  /** 设备码授权第一步：拿到验证链接与 device_code。 */
  async deviceAuthorization(app: FeishuCredentials, scopes: string[]): Promise<{ deviceCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn: number; interval: number }> {
    const origins = feishuOrigins(app.brand);
    const body = new URLSearchParams({ scope: [...new Set([...scopes, "offline_access"])].join(" ") });
    const response = await this.fetchImpl(`${origins.accounts}/oauth/v1/device_authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${app.appId}:${app.appSecret}`).toString("base64")}` },
      body,
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const deviceCode = typeof data.device_code === "string" ? data.device_code : "";
    const verificationUri = typeof data.verification_uri === "string" ? data.verification_uri : typeof data.verification_uri_complete === "string" ? data.verification_uri_complete : "";
    if (!deviceCode || !verificationUri) throw new FeishuApiError(Number(data.code ?? response.status), `获取设备授权失败 ${response.status} ${JSON.stringify(data).slice(0, 200)}`, response.status, data);
    return { deviceCode, verificationUri, ...(typeof data.verification_uri_complete === "string" ? { verificationUriComplete: data.verification_uri_complete } : {}), expiresIn: Number(data.expires_in ?? 300), interval: Math.max(1, Number(data.interval ?? 5)) };
  }

  /** 设备码/刷新令牌换取 token。返回 OAuth 风格错误（authorization_pending 等）时不抛错。 */
  async tokenEndpoint(app: FeishuCredentials, params: Record<string, string>): Promise<{ pending?: string; access?: UserTokenGrant }> {
    const origins = feishuOrigins(app.brand);
    const response = await this.fetchImpl(`${origins.open}/open-apis/authen/v2/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: app.appId, client_secret: app.appSecret, ...params }),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof data.error === "string" && data.error) return { pending: data.error };
    if (typeof data.access_token !== "string" || !data.access_token) throw new FeishuApiError(Number(data.code ?? response.status), String(data.msg ?? data.error_description ?? "获取用户令牌失败"), response.status, data);
    const scope = typeof data.scope === "string" ? data.scope.split(/[\s+]/).filter(Boolean) : [];
    return { access: { accessToken: data.access_token, refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "", expiresAt: Date.now() + Number(data.expires_in ?? 7200) * 1000, refreshExpiresAt: Date.now() + Number(data.refresh_token_expires_in ?? 604800) * 1000, scope } };
  }

  /** 主人身份信息：open_id 校验用。 */
  async userInfo(app: FeishuCredentials, userToken: string): Promise<{ openId?: string; name?: string }> {
    const origins = feishuOrigins(app.brand);
    const response = await this.fetchImpl(`${origins.open}/open-apis/authen/v1/user_info`, { headers: { Authorization: `Bearer ${userToken}` } });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const info = record(data.data);
    return { ...(typeof info.open_id === "string" ? { openId: info.open_id } : {}), ...(typeof info.name === "string" ? { name: info.name } : {}) };
  }
}

export interface UserTokenGrant { accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number; scope: string[] }
