export type Brand = "feishu" | "lark";
export function feishuOrigins(brand: Brand): { open: string; accounts: string } {
  return brand === "lark"
    ? { open: "https://open.larksuite.com", accounts: "https://accounts.larksuite.com" }
    : { open: "https://open.feishu.cn", accounts: "https://accounts.feishu.cn" };
}

export class FeishuApiError extends Error {
  constructor(readonly code: number, message: string, readonly status: number) { super(message); }
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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
      if ((rateLimited.has(code) || response.status === 429) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 32_000) : 500 * 2 ** attempt);
        continue;
      }
      throw new FeishuApiError(code, String(data.msg ?? `HTTP ${response.status}`), response.status);
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
}
