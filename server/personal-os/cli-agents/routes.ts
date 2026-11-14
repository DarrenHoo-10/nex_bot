// HTTP surface of Agent mode. index.ts has already authenticated the caller
// and handed over the parsed body; this returns a status and a JSON body so
// index.ts writes the response the way it does for every other route.
//
// Errors are `{error, code}` with a 4xx status only: a 5xx from Core would be
// rewritten by proxies in front of it and lose the code.
import {
  CLI_ERROR_TEXT,
  MAX_SEND_TEXT,
  isAbsoluteCwd,
  isCliDeviceId,
  isCliEngine,
  parseCliKey,
  utf8ByteLength,
  type CliErrorCode,
} from "../../../shared/cli-agents.ts";
import type { CoreStore } from "../store.ts";
import { CliOpError, type CliAgentHub } from "./hub.ts";

export interface CliRouteRequest {
  method: string;
  pathname: string;
  search: URLSearchParams;
  /** the caller's session id, recorded in audit and op rows */
  sessionId: string;
  /** the caller owns this Core; Agent mode is owner-only */
  owner: boolean;
  /** parsed JSON body of a POST */
  data?: Record<string, unknown>;
}

export interface CliRouteResult {
  status: number;
  body: unknown;
}

const STATUS: Partial<Record<CliErrorCode, number>> = { invalid: 400, cwd_missing: 400, too_large: 413, not_found: 404 };

export function cliErrorResult(code: CliErrorCode): CliRouteResult {
  return { status: STATUS[code] ?? 409, body: { error: CLI_ERROR_TEXT[code], code } };
}

export class CliAgentRoutes {
  constructor(
    private readonly hub: CliAgentHub,
    private readonly store: CoreStore,
  ) {}

  /** Null when the path is not an Agent mode route. */
  async handle(request: CliRouteRequest): Promise<CliRouteResult | null> {
    const { method, pathname } = request;
    if (!pathname.startsWith("/api/cli-agents")) return null;
    const get = method === "GET", post = method === "POST";
    if (!(get && (pathname === "/api/cli-agents" || pathname === "/api/cli-agents/items")) && !(post && POST_ROUTES.has(pathname))) return null;
    if (!request.owner) return { status: 403, body: { error: "此账号没有使用 Agent 会话的权限" } };
    try {
      if (get) return pathname === "/api/cli-agents" ? { status: 200, body: this.hub.list() } : await this.items(request);
      const data = request.data ?? {};
      switch (pathname) {
        case "/api/cli-agents/start": return await this.start(request, data);
        case "/api/cli-agents/continue": return await this.continueSession(request, data);
        case "/api/cli-agents/send": return await this.send(request, data);
        case "/api/cli-agents/interrupt": return await this.interrupt(request, data);
        case "/api/cli-agents/open-local": return await this.openLocal(request, data);
        default: return this.hide(data);
      }
    } catch (error) {
      if (error instanceof CliOpError) return cliErrorResult(error.code);
      throw error;
    }
  }

  private key(value: unknown): string | null {
    return typeof value === "string" && parseCliKey(value) ? value : null;
  }

  private async items(request: CliRouteRequest): Promise<CliRouteResult> {
    const key = this.key(request.search.get("key"));
    if (!key) return cliErrorResult("invalid");
    const before = request.search.get("before") ?? undefined;
    if (before !== undefined && (before.length < 1 || before.length > 200)) return cliErrorResult("invalid");
    const page = await this.hub.items(request.sessionId, key, before);
    return { status: 200, body: { items: page.items, more: page.more } };
  }

  private async start(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const { deviceId, engine, cwd } = data;
    if (!isCliDeviceId(deviceId) || !isCliEngine(engine) || !isAbsoluteCwd(cwd)) return cliErrorResult("invalid");
    this.store.audit("cli.start", "device", deviceId, { engine, cwd, sessionId: request.sessionId });
    const started = await this.hub.start(request.sessionId, deviceId, engine, cwd);
    return { status: 200, body: { key: started.key } };
  }

  private async continueSession(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const key = this.key(data.key);
    if (!key) return cliErrorResult("invalid");
    this.store.audit("cli.continue", "cli_session", key, { sessionId: request.sessionId });
    const continued = await this.hub.continueSession(request.sessionId, key);
    return { status: 200, body: { key: continued.key } };
  }

  private async send(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const key = this.key(data.key);
    const text = data.text;
    if (!key || typeof text !== "string" || text.length < 1) return cliErrorResult("invalid");
    if (text.length > MAX_SEND_TEXT || utf8ByteLength(text) > MAX_SEND_TEXT) return cliErrorResult("too_large");
    // The audit row records how much was sent, never the text itself.
    this.store.audit("cli.send", "cli_session", key, { sessionId: request.sessionId, length: text.length });
    const result = await this.hub.send(request.sessionId, key, text);
    return { status: 200, body: { turn: result.turn, started: result.started } };
  }

  private async interrupt(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const key = this.key(data.key);
    if (!key) return cliErrorResult("invalid");
    this.store.audit("cli.interrupt", "cli_session", key, { sessionId: request.sessionId });
    const result = await this.hub.interrupt(request.sessionId, key);
    return { status: 200, body: { outcome: result.outcome } };
  }

  private async openLocal(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const key = this.key(data.key);
    if (!key) return cliErrorResult("invalid");
    this.store.audit("cli.open_local", "cli_session", key, { sessionId: request.sessionId });
    await this.hub.openLocal(request.sessionId, key);
    return { status: 200, body: { ok: true } };
  }

  private hide(data: Record<string, unknown>): CliRouteResult {
    const key = this.key(data.key);
    if (!key || typeof data.hidden !== "boolean") return cliErrorResult("invalid");
    return this.hub.hide(key, data.hidden) ? { status: 200, body: { ok: true } } : cliErrorResult("not_found");
  }
}

const POST_ROUTES = new Set([
  "/api/cli-agents/start",
  "/api/cli-agents/continue",
  "/api/cli-agents/send",
  "/api/cli-agents/interrupt",
  "/api/cli-agents/open-local",
  "/api/cli-agents/hide",
]);
