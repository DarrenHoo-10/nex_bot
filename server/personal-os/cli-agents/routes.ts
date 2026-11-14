// HTTP surface of Agent mode. index.ts has already authenticated the caller
// and handed over the parsed body; this returns a status and a JSON body so
// index.ts writes the response the way it does for every other route.
//
// Errors are `{error, code}` with a 4xx status only: a 5xx from Core would be
// rewritten by proxies in front of it and lose the code.
import {
  CLI_ERROR_TEXT,
  CLI_LIMITS,
  MAX_SEND_TEXT,
  isAbsoluteCwd,
  isCliDeviceId,
  isCliEngine,
  parseCliKey,
  utf8ByteLength,
  type CliErrorCode,
} from "../../../shared/cli-agents.ts";
import type { CoreStore } from "../store.ts";
import { forkToTopic, type ForkAgents } from "./fork.ts";
import { CliOpError, type CliAgentHub } from "./hub.ts";
import { parseSettings, type CliAgentSupervisor } from "./supervisor.ts";

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

export interface CliRouteExtras {
  /** assistant topics, for fork-to-topic */
  agents?: ForkAgents;
  supervisor?: CliAgentSupervisor;
}

export class CliAgentRoutes {
  constructor(
    private readonly hub: CliAgentHub,
    private readonly store: CoreStore,
    private readonly extras: CliRouteExtras = {},
  ) {}

  /** Null when the path is not an Agent mode route. */
  async handle(request: CliRouteRequest): Promise<CliRouteResult | null> {
    const { method, pathname } = request;
    if (!pathname.startsWith("/api/cli-agents")) return null;
    const get = method === "GET", post = method === "POST", put = method === "PUT";
    if (!(get && GET_ROUTES.has(pathname)) && !(post && POST_ROUTES.has(pathname)) && !(put && pathname === "/api/cli-agents/supervision")) return null;
    if (!request.owner) return { status: 403, body: { error: "此账号没有使用 Agent 会话的权限" } };
    try {
      if (get) {
        switch (pathname) {
          case "/api/cli-agents/items": return await this.items(request);
          case "/api/cli-agents/requests": return this.requests(request);
          case "/api/cli-agents/supervision": return this.supervision();
          default: return { status: 200, body: { ...this.hub.list(), requests: this.hub.requests() } };
        }
      }
      const data = request.data ?? {};
      if (put) return this.putSupervision(data);
      switch (pathname) {
        case "/api/cli-agents/start": return await this.start(request, data);
        case "/api/cli-agents/continue": return await this.continueSession(request, data);
        case "/api/cli-agents/send": return await this.send(request, data);
        case "/api/cli-agents/interrupt": return await this.interrupt(request, data);
        case "/api/cli-agents/open-local": return await this.openLocal(request, data);
        case "/api/cli-agents/answer": return await this.answer(request, data);
        case "/api/cli-agents/fork": return await this.fork(request, data);
        default: return this.hide(data);
      }
    } catch (error) {
      if (error instanceof CliOpError) return cliErrorResult(error.code);
      throw error;
    }
  }

  private requests(request: CliRouteRequest): CliRouteResult {
    const key = request.search.get("key");
    if (key !== null && !this.key(key)) return cliErrorResult("invalid");
    return { status: 200, body: { requests: this.hub.requests(key ?? undefined) } };
  }

  private async answer(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const { id, decision, answers, message } = data;
    if (typeof id !== "string" || id.length < 1 || id.length > CLI_LIMITS.requestId) return cliErrorResult("invalid");
    if (decision !== "allow" && decision !== "deny") return cliErrorResult("invalid");
    if (message !== undefined && (typeof message !== "string" || message.length > CLI_LIMITS.answerMessage)) return cliErrorResult("invalid");
    let chosen: Record<string, string> | undefined;
    if (answers !== undefined) {
      if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return cliErrorResult("invalid");
      const entries = Object.entries(answers);
      if (entries.length > CLI_LIMITS.requestQuestions) return cliErrorResult("invalid");
      chosen = {};
      for (const [question, answer] of entries) {
        if (typeof answer !== "string" || answer.length > CLI_LIMITS.requestAnswer) return cliErrorResult("invalid");
        chosen[question] = answer;
      }
    }
    // The audit row says who answered what kind of decision, never the answer text.
    this.store.audit("cli.answer", "cli_request", id, { sessionId: request.sessionId, decision });
    const result = await this.hub.answer(request.sessionId, id, decision, chosen, message);
    return { status: 200, body: { outcome: result.outcome } };
  }

  private supervision(): CliRouteResult {
    const supervisor = this.extras.supervisor;
    return supervisor ? { status: 200, body: supervisor.overview() } : cliErrorResult("not_found");
  }

  /** `{cwd?, settings}`: switches for one workspace folder, or for all without `cwd`. `settings: null` removes a folder's override. */
  private putSupervision(data: Record<string, unknown>): CliRouteResult {
    const supervisor = this.extras.supervisor;
    if (!supervisor) return cliErrorResult("not_found");
    const { cwd } = data;
    if (cwd !== undefined && !isAbsoluteCwd(cwd)) return cliErrorResult("invalid");
    let settings: ReturnType<typeof parseSettings> | null;
    if (data.settings === null) settings = null;
    else {
      settings = parseSettings(data.settings);
      if (!settings) return cliErrorResult("invalid");
    }
    if (settings === null && cwd === undefined) return cliErrorResult("invalid");
    supervisor.put(cwd as string | undefined, settings);
    return { status: 200, body: supervisor.overview() };
  }

  private async fork(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const key = this.key(data.key);
    const { botId } = data;
    if (!key || typeof botId !== "string" || botId.length < 1 || botId.length > 100) return cliErrorResult("invalid");
    const agents = this.extras.agents;
    if (!agents) return cliErrorResult("not_found");
    this.store.audit("cli.fork", "cli_session", key, { sessionId: request.sessionId, botId });
    try {
      const forked = await forkToTopic(this.hub, agents, request.sessionId, key, botId);
      return { status: 200, body: forked };
    } catch (error) {
      if (error instanceof CliOpError) throw error;
      // the agent module words its own refusals (unknown assistant, bad topic)
      return { status: 400, body: { error: error instanceof Error ? error.message : "无法创建话题", code: "invalid" } };
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
  "/api/cli-agents/answer",
  "/api/cli-agents/fork",
]);

const GET_ROUTES = new Set([
  "/api/cli-agents",
  "/api/cli-agents/items",
  "/api/cli-agents/requests",
  "/api/cli-agents/supervision",
]);
