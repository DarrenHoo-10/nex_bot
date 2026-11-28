// HTTP surface of Agent mode. index.ts has already authenticated the caller
// and handed over the parsed body; this returns a status and a JSON body so
// index.ts writes the response the way it does for every other route.
//
// Errors are `{error, code}` with a 4xx status only: a 5xx from Core would be
// rewritten by proxies in front of it and lose the code.
import {
  CLI_ATTACH_MAX_BYTES,
  CLI_PERMISSION_MODES,
  cliPermissionModes,
  CLI_ATTACH_NAME_MAX,
  CLI_ERROR_TEXT,
  CLI_LIMITS,
  CLI_SEARCH,
  MAX_SEND_TEXT,
  isAbsoluteCwd,
  isCliBranchName,
  isCliDeviceId,
  isCliEffort,
  isCliEngine,
  isCliModel,
  parseCliKey,
  utf8ByteLength,
  type CliDeliveryAction,
  type CliEngine,
  type CliErrorCode,
  type CliLaunchOptions,
  type CliSessionRef,
} from "../../../shared/cli-agents.ts";
import type { CoreStore } from "../store.ts";
import { forkToTopic, type ForkAgents } from "./fork.ts";
import { CliOpError, type CliAgentHub } from "./hub.ts";
import { parseSettings, type CliAgentSupervisor } from "./supervisor.ts";
import { MAX_TRANSLATION_SOURCE, CliTranslation } from "./translation.ts";
import type { CliAgentWorkbench, WaitingSteer } from "./workbench.ts";
import type { CliImages } from "./images.ts";

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
  /** the raw body of `POST /api/cli-agents/attach` (index.ts reads it instead of JSON) */
  bytes?: Uint8Array;
  imageOrigin?: string;
}

export interface CliRouteResult {
  status: number;
  body: unknown;
}

const STATUS: Partial<Record<CliErrorCode, number>> = { invalid: 400, cwd_missing: 400, too_large: 413, not_found: 404 };

const MAX_ERROR_TEXT = 200;
const MAX_NOTE_QUOTE = 8000;
const MAX_NOTE_BODY = 4000;

/** `message` is the device's own wording (already cleaned by the hub); without it the code's standard text is used. */
export function cliErrorResult(code: CliErrorCode, message?: string): CliRouteResult {
  const own = typeof message === "string" ? message.trim().slice(0, MAX_ERROR_TEXT) : "";
  // CliOpError's default message is the code itself, which says nothing more than the code
  const error = own && own !== code ? own : CLI_ERROR_TEXT[code];
  return { status: STATUS[code] ?? 409, body: { error, code } };
}

/** Reads the raw body of an attachment upload, at most CLI_ATTACH_MAX_BYTES;
 * null when it is larger (a declared Content-Length is refused before reading). */
export async function readCliAttachment(body: AsyncIterable<Uint8Array | string>, contentLength?: string): Promise<Buffer | null> {
  const declared = contentLength === undefined ? NaN : Number(contentLength);
  if (Number.isFinite(declared) && declared > CLI_ATTACH_MAX_BYTES) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    size += buffer.length;
    if (size > CLI_ATTACH_MAX_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export interface CliRouteExtras {
  /** assistant topics, for fork-to-topic */
  agents?: ForkAgents;
  supervisor?: CliAgentSupervisor;
  /** the workbench queue: present when Core runs the workbench contracts */
  workbench?: CliAgentWorkbench;
  images?: CliImages;
}

export class CliAgentRoutes {
  private readonly translation: CliTranslation;

  constructor(
    private readonly hub: CliAgentHub,
    private readonly store: CoreStore,
    private readonly extras: CliRouteExtras = {},
  ) { this.translation = new CliTranslation(store); }

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
          case "/api/cli-agents/translation-settings": return { status: 200, body: this.translation.settings() };
          case "/api/cli-agents/items": return await this.items(request);
          case "/api/cli-agents/requests": return this.requests(request);
          case "/api/cli-agents/queue": return this.queue(request);
          case "/api/cli-agents/supervision": return this.supervision();
          case "/api/cli-agents/sessions/git": return await this.gitInfo(request);
          case "/api/cli-agents/notes": return this.notes(request);
          case "/api/cli-agents/search": return await this.search(request);
          case "/api/cli-agents/skills": return await this.skills(request);
          case "/api/cli-agents/models": return await this.models(request);
          case "/api/cli-agents/dirs": return await this.dirs(request);
          case "/api/cli-agents/branches": return await this.branches(request);
          default: return {
            status: 200,
            body: {
              ...this.hub.list(),
              requests: this.hub.requests(),
              ...(this.extras.workbench ? { workbench: this.extras.workbench.list(), queues: this.extras.workbench.queues() } : {}),
            },
          };
        }
      }
      const data = request.data ?? {};
      if (put) return this.putSupervision(data);
      switch (pathname) {
        case "/api/cli-agents/translation-settings": return { status: 200, body: this.translation.saveSettings(data) };
        case "/api/cli-agents/translate": return await this.translate(data);
        case "/api/cli-agents/start": return await this.start(request, data);
        case "/api/cli-agents/continue": return await this.continueSession(request, data);
        case "/api/cli-agents/send": return await this.send(request, data);
        case "/api/cli-agents/steer-waiting": return await this.steerWaiting(request, data);
        case "/api/cli-agents/interrupt": return await this.interrupt(request, data);
        case "/api/cli-agents/open-local": return { status: 410, body: { error: "「在电脑上打开」已下线，请使用远程终端并更新客户端", code: "unsupported" } };
        case "/api/cli-agents/answer": return await this.answer(request, data);
        case "/api/cli-agents/fork": return await this.fork(request, data);
        case "/api/cli-agents/fork-message": return await this.fork(request, data, true);
        case "/api/cli-agents/queue/edit": return await this.queueEdit(data);
        case "/api/cli-agents/queue/withdraw": return await this.queueWithdraw(data);
        case "/api/cli-agents/queue/steer": return await this.queueSteer(data);
        case "/api/cli-agents/queue/resume": return await this.queueResume(request, data);
        case "/api/cli-agents/sessions/branch": return await this.branchSession(request, data);
        case "/api/cli-agents/sessions/rename": return await this.sessionUpdate(data, "rename");
        case "/api/cli-agents/sessions/archive": return await this.sessionUpdate(data, "archive");
        case "/api/cli-agents/sessions/restore": return await this.sessionUpdate(data, "restore");
        case "/api/cli-agents/sessions/delete": return await this.sessionUpdate(data, "delete");
        case "/api/cli-agents/notes": return this.createNote(request, data);
        case "/api/cli-agents/notes/update": return this.updateNote(data);
        case "/api/cli-agents/notes/delete": return this.deleteNote(data);
        case "/api/cli-agents/attach": return await this.attach(request);
        case "/api/cli-agents/images": return await this.uploadImage(request);
        default: return this.hide(data);
      }
    } catch (error) {
      if (error instanceof CliOpError) return cliErrorResult(error.code, error.message);
      throw error;
    }
  }

  /** The outbox of one logical session, by native key or logical id. */
  private queue(request: CliRouteRequest): CliRouteResult {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const key = request.search.get("key");
    if (!key) return cliErrorResult("invalid");
    try {
      return { status: 200, body: { queue: workbench.queueForWorkbench(String(workbench.resolve(key).id)) } };
    } catch (error) {
      if (error instanceof CliOpError) return cliErrorResult(error.code, error.message);
      throw error;
    }
  }

  private queueEdit(data: Record<string, unknown>): CliRouteResult | Promise<CliRouteResult> {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const input = this.entryInput(data);
    const text = data.text;
    if (!input || typeof text !== "string" || text.length < 1) return cliErrorResult("invalid");
    if (text.length > MAX_SEND_TEXT || utf8ByteLength(text) > MAX_SEND_TEXT) return cliErrorResult("too_large");
    return { status: 200, body: { entry: workbench.editEntry(input, text) } };
  }

  private queueWithdraw(data: Record<string, unknown>): CliRouteResult | Promise<CliRouteResult> {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const input = this.entryInput(data);
    if (!input) return cliErrorResult("invalid");
    return { status: 200, body: { entry: workbench.withdrawEntry(input) } };
  }

  private async queueSteer(data: Record<string, unknown>, waitingSteer?: WaitingSteer): Promise<CliRouteResult> {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const input = this.entryInput(data);
    if (!input) return cliErrorResult("invalid");
    const expectedTurnId = typeof data.expectedTurnId === "string" ? data.expectedTurnId : undefined;
    const entry = await workbench.steerEntry(input, expectedTurnId, waitingSteer);
    return { status: 200, body: { entry } };
  }

  private async queueResume(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const key = this.key(data.key) ?? this.workbenchRef(data);
    if (!key) return cliErrorResult("invalid");
    this.store.audit("cli.queue_resume", "cli_session", key, { sessionId: request.sessionId });
    workbench.resume(request.sessionId, key);
    return { status: 200, body: { ok: true } };
  }

  private entryInput(data: Record<string, unknown>): { entryId: string; expectedVersion: number } | null {
    const { entryId, expectedVersion } = data;
    if (typeof entryId !== "string" || entryId.length < 1 || entryId.length > 128) return null;
    if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
    return { entryId, expectedVersion };
  }

  /** The workbench accepts a logical session id where a native key goes. */
  private workbenchRef(data: Record<string, unknown>): string | null {
    const id = data.id ?? data.workbenchId ?? data.parentId;
    return typeof id === "string" && id.length >= 1 && id.length <= 128 ? id : null;
  }

  private async branchSession(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const requestId = data.requestId;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) return cliErrorResult("invalid");
    const parent = this.key(data.parentKey) ?? this.workbenchRef(data);
    if (!parent) return cliErrorResult("invalid");
    const title = typeof data.title === "string" ? data.title.trim().slice(0, 200) : "";
    const kind = data.kind === "side" ? "side" as const : "fork" as const;
    this.store.audit("cli.branch", "cli_session", parent, { sessionId: request.sessionId, requestId });
    // the parent may come as a native key or a logical id; both resolve
    const row = workbench.branch(String(workbench.resolve(parent).id), requestId, { kind, ...(title ? { title } : {}) });
    return { status: 200, body: { id: row.id, parentId: row.parent_id, version: row.version } };
  }

  private async sessionUpdate(data: Record<string, unknown>, action: "rename" | "archive" | "restore" | "delete"): Promise<CliRouteResult> {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    // A logical id carries the version the client saw. A native key is enough
    // on its own: most sessions have no logical row until the first change,
    // which creates it here, so the current version is the expected one.
    const key = this.key(data.key);
    const ref = key ?? this.workbenchRef(data);
    if (!ref) return cliErrorResult("invalid");
    const expected = data.expectedVersion;
    if (expected !== undefined && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0)) return cliErrorResult("invalid");
    if (!key && expected === undefined) return cliErrorResult("invalid");
    const current = workbench.resolve(ref);
    const id = String(current.id);
    const version = typeof expected === "number" ? expected : Number(current.version);
    let row;
    switch (action) {
      case "rename": {
        const title = data.title;
        if (typeof title !== "string" || !title.trim() || title.trim().length > 200) return cliErrorResult("invalid");
        row = workbench.rename(id, title.trim(), version);
        break;
      }
      case "archive": row = workbench.setArchived(id, true, version); break;
      case "restore": row = workbench.setArchived(id, false, version); break;
      case "delete": row = workbench.remove(id, version); break;
    }
    return { status: 200, body: { session: workbench.viewOf(row) } };
  }

  /** Annotations of one conversation, by native key or logical id. */
  private notes(request: CliRouteRequest): CliRouteResult {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const key = request.search.get("key");
    if (!key || key.length > 200) return cliErrorResult("invalid");
    return { status: 200, body: { notes: workbench.listNotes(key) } };
  }

  private createNote(request: CliRouteRequest, data: Record<string, unknown>): CliRouteResult {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const ref = this.key(data.key) ?? this.workbenchRef(data);
    const { id, message, quote, body, num, start, end } = data;
    if (!ref) return cliErrorResult("invalid");
    if (id !== undefined && (typeof id !== "string" || id.length < 1 || id.length > 128)) return cliErrorResult("invalid");
    if (typeof message !== "string" || message.length < 1 || message.length > 200) return cliErrorResult("invalid");
    if (typeof quote !== "string" || !quote.trim()) return cliErrorResult("invalid");
    if (typeof body !== "string" || !body.trim()) return cliErrorResult("invalid");
    if (quote.length > MAX_NOTE_QUOTE || body.length > MAX_NOTE_BODY) return cliErrorResult("too_large");
    const integer = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
    if (num !== undefined && (!integer(num, 100_000) || num < 1)) return cliErrorResult("invalid");
    if ((start === undefined) !== (end === undefined)) return cliErrorResult("invalid");
    if (start !== undefined && (!integer(start, 10_000_000) || !integer(end, 10_000_000) || end <= start)) return cliErrorResult("invalid");
    this.store.audit("cli.note_create", "cli_session", ref, { sessionId: request.sessionId, length: body.length });
    const note = workbench.createNote(ref, {
      ...(typeof id === "string" ? { id } : {}), message, quote, body,
      ...(typeof num === "number" ? { num } : {}),
      ...(typeof start === "number" && typeof end === "number" ? { start, end } : {}),
    });
    return { status: 200, body: { note } };
  }

  private updateNote(data: Record<string, unknown>): CliRouteResult {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const { id, expectedVersion, body } = data;
    if (typeof id !== "string" || id.length < 1 || id.length > 128) return cliErrorResult("invalid");
    if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return cliErrorResult("invalid");
    if (typeof body !== "string" || !body.trim()) return cliErrorResult("invalid");
    if (body.length > MAX_NOTE_BODY) return cliErrorResult("too_large");
    return { status: 200, body: { note: workbench.updateNote(id, expectedVersion, body) } };
  }

  private deleteNote(data: Record<string, unknown>): CliRouteResult {
    const workbench = this.extras.workbench;
    if (!workbench) return cliErrorResult("not_found");
    const { id, expectedVersion } = data;
    if (typeof id !== "string" || id.length < 1 || id.length > 128) return cliErrorResult("invalid");
    if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return cliErrorResult("invalid");
    workbench.deleteNote(id, expectedVersion);
    return { status: 200, body: { ok: true } };
  }

  private async gitInfo(request: CliRouteRequest): Promise<CliRouteResult> {
    const key = this.key(request.search.get("key"));
    if (!key) return cliErrorResult("invalid");
    this.store.audit("cli.git", "cli_session", key, { sessionId: request.sessionId });
    const result = await this.hub.git(request.sessionId, key);
    return { status: 200, body: result };
  }

  private requests(request: CliRouteRequest): CliRouteResult {
    const key = request.search.get("key");
    if (key !== null && !this.key(key)) return cliErrorResult("invalid");
    return { status: 200, body: { requests: this.hub.requests(key ?? undefined) } };
  }

  private async answer(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const { id, decision, answers, message, always } = data;
    if (typeof id !== "string" || id.length < 1 || id.length > CLI_LIMITS.requestId) return cliErrorResult("invalid");
    if (decision !== "allow" && decision !== "deny") return cliErrorResult("invalid");
    if (always !== undefined && typeof always !== "boolean") return cliErrorResult("invalid");
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
    this.store.audit("cli.answer", "cli_request", id, { sessionId: request.sessionId, decision, ...(always === true ? { always: true } : {}) });
    const result = await this.hub.answer(request.sessionId, id, decision, chosen, message, always === true);
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

  private async fork(request: CliRouteRequest, data: Record<string, unknown>, anchored = false): Promise<CliRouteResult> {
    const key = this.key(data.key);
    const { botId } = data;
    const itemId = anchored ? data.itemId : undefined;
    if (!key || typeof botId !== "string" || botId.length < 1 || botId.length > 100) return cliErrorResult("invalid");
    if (anchored && (typeof itemId !== "string" || itemId.length < 1 || itemId.length > 200)) return cliErrorResult("invalid");
    const agents = this.extras.agents;
    if (!agents) return cliErrorResult("not_found");
    this.store.audit("cli.fork", "cli_session", key, { sessionId: request.sessionId, botId });
    try {
      const forked = await forkToTopic(this.hub, agents, request.sessionId, key, botId, typeof itemId === "string" ? itemId : undefined);
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
    const translation = this.translation.settings();
    // An untouched setting keeps the browser's local translation behavior.
    return { status: 200, body: { ...page, ...(translation.version ? { translationEnabled: translation.available } : {}) } };
  }

  private async translate(data: Record<string, unknown>): Promise<CliRouteResult> {
    const key = this.key(data.key);
    const { itemId, source } = data;
    if (!key || typeof itemId !== "string" || !itemId || itemId.length > 200 ||
        typeof source !== "string" || !source) return cliErrorResult("invalid");
    if (source.length > MAX_TRANSLATION_SOURCE) return { status: 200, body: { translation: null } };
    const text = this.hub.translationSource(key, itemId, source);
    if (!text) return { status: 200, body: { translation: null } };
    try {
      return { status: 200, body: { translation: await this.translation.translate(text) } };
    } catch (error) {
      // the reason stays in Core's log (no text, no key): "翻译失败" alone hid a wrong address for days
      console.warn("[translation] failed:", error instanceof Error ? error.message : String(error));
      return { status: 422, body: { error: "翻译失败" } };
    }
  }

  /** `GET /search?q=`: sessions on the online computers whose messages hold every term. */
  private async search(request: CliRouteRequest): Promise<CliRouteResult> {
    const query = request.search.get("q") ?? "";
    if (!query.trim() || query.length > CLI_SEARCH.queryMax) return cliErrorResult("invalid");
    const hits = await this.hub.search(request.sessionId, query);
    return { status: 200, body: { hits } };
  }

  private async skills(request: CliRouteRequest): Promise<CliRouteResult> {
    const deviceId = request.search.get("deviceId"), engine = request.search.get("engine");
    const cwd = request.search.get("cwd") ?? "", key = request.search.get("key");
    const session = key ? parseCliKey(key) : null;
    if (!isCliDeviceId(deviceId) || !isCliEngine(engine) || cwd.length > CLI_LIMITS.cwd || (cwd && !isAbsoluteCwd(cwd)) ||
        (key && (!session || session.deviceId !== deviceId || session.engine !== engine))) return cliErrorResult("invalid");
    return { status: 200, body: await this.hub.skills(request.sessionId, deviceId, { engine, cwd, ...(session && { ref: session.ref }) }) };
  }

  /** `GET /models?deviceId=&engine=`: the rows of that CLI's own model picker on the computer. */
  private async models(request: CliRouteRequest): Promise<CliRouteResult> {
    const deviceId = request.search.get("deviceId");
    const engine = request.search.get("engine");
    if (!isCliDeviceId(deviceId) || !isCliEngine(engine)) return cliErrorResult("invalid");
    return { status: 200, body: await this.hub.models(request.sessionId, deviceId, engine) };
  }

  /** `GET /dirs?deviceId=&path=`: the sub-folders of an absolute folder on the computer; no path lists its roots. */
  private async dirs(request: CliRouteRequest): Promise<CliRouteResult> {
    const deviceId = request.search.get("deviceId");
    const path = request.search.get("path") ?? "";
    if (!isCliDeviceId(deviceId) || path.length > 4096 || (path && !isAbsoluteCwd(path))) return cliErrorResult("invalid");
    return { status: 200, body: await this.hub.dirs(request.sessionId, deviceId, path) };
  }

  /** `GET /branches?deviceId=&cwd=`: local Git branches and cleanliness of `cwd` on the computer. */
  private async branches(request: CliRouteRequest): Promise<CliRouteResult> {
    const deviceId = request.search.get("deviceId");
    const cwd = request.search.get("cwd") ?? "";
    if (!isCliDeviceId(deviceId) || !isAbsoluteCwd(cwd)) return cliErrorResult("invalid");
    return { status: 200, body: await this.hub.branches(request.sessionId, deviceId, cwd) };
  }

  /** `POST /attach?key=&name=` with the file itself as the body. */
  private async attach(request: CliRouteRequest): Promise<CliRouteResult> {
    const key = this.key(request.search.get("key"));
    const name = request.search.get("name") ?? "";
    const bytes = request.bytes;
    if (!key || !name.trim() || name.length > CLI_ATTACH_NAME_MAX || !bytes) return cliErrorResult("invalid");
    if (bytes.length > CLI_ATTACH_MAX_BYTES) return cliErrorResult("too_large", "附件不能超过 8 MB");
    // the audit row says how big the file was, never its name or content
    this.store.audit("cli.attach", "cli_session", key, { sessionId: request.sessionId, size: bytes.length });
    return { status: 200, body: await this.hub.attach(request.sessionId, key, name, bytes) };
  }

  private async uploadImage(request: CliRouteRequest): Promise<CliRouteResult> {
    const key = this.key(request.search.get("key"));
    if (!key || !request.bytes || !request.imageOrigin || !this.extras.images) return cliErrorResult("invalid");
    const session = this.hub.session(key);
    if (!session) return cliErrorResult("not_found");
    return { status: 200, body: await this.extras.images.upload(session.deviceId, request.imageOrigin, Buffer.from(request.bytes)) };
  }

  /** `model` / `effort` / `permissions` of a start or continue body; null when one is malformed. */
  private launchOptions(data: Record<string, unknown>, engine: CliEngine): CliLaunchOptions | null {
    const { model, effort, permissions } = data;
    if (model !== undefined && model !== null && model !== "" && !isCliModel(model)) return null;
    if (effort !== undefined && effort !== null && effort !== "" && !isCliEffort(engine, effort)) return null;
    const mode = CLI_PERMISSION_MODES.find((entry) => entry === permissions);
    if (permissions !== undefined && permissions !== null && (!mode || !cliPermissionModes(engine).includes(mode))) return null;
    return {
      ...(typeof model === "string" && model ? { model } : {}),
      ...(typeof effort === "string" && effort ? { effort } : {}),
      ...(mode ? { permissions: mode } : {}),
    };
  }

  private async start(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const { deviceId, engine, cwd } = data;
    if (!isCliDeviceId(deviceId) || !isCliEngine(engine) || !isAbsoluteCwd(cwd)) return cliErrorResult("invalid");
    const launch = this.launchOptions(data, engine);
    if (!launch) return cliErrorResult("invalid", "模型或推理强度不可用");
    const worktreeBranch = data.worktreeBranch;
    const worktreeBaseBranch = data.worktreeBaseBranch;
    const requestId = data.requestId;
    const switchBranch = data.branch;
    if (data.createDir !== undefined && typeof data.createDir !== "boolean") return cliErrorResult("invalid");
    const createDir = data.createDir === true;
    const withWorktree = worktreeBranch !== undefined || requestId !== undefined || worktreeBaseBranch !== undefined;
    if (withWorktree) {
      if (!isCliBranchName(worktreeBranch)) return cliErrorResult("invalid");
      if (worktreeBaseBranch !== undefined && !isCliBranchName(worktreeBaseBranch)) return cliErrorResult("invalid");
      if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) return cliErrorResult("invalid");
    }
    if (switchBranch !== undefined) {
      if (!isCliBranchName(switchBranch) || withWorktree || createDir) return cliErrorResult("invalid");
    }
    // A fork is a session of the same device and engine, one this Core knows; the device
    // gets its ref and decides how to resume it (a worktree start and a fork do not mix)
    let forkRef: CliSessionRef | undefined;
    if (data.forkFrom !== undefined) {
      const source = this.key(data.forkFrom);
      const parsed = source ? parseCliKey(source) : null;
      if (!source || !parsed || withWorktree || createDir || switchBranch !== undefined) return cliErrorResult("invalid");
      if (parsed.deviceId !== deviceId || parsed.engine !== engine) return cliErrorResult("invalid");
      if (!this.hub.session(source)) return cliErrorResult("not_found");
      forkRef = parsed.ref;
    }
    if (createDir && withWorktree) return cliErrorResult("invalid", "新建目录不能同时新建工作树");
    this.store.audit("cli.start", "device", deviceId, {
      engine, cwd,
      ...(createDir ? { createDir: true } : {}),
      ...(switchBranch ? { branch: switchBranch } : {}),
      ...(withWorktree ? { worktree: worktreeBranch, ...(worktreeBaseBranch ? { worktreeBaseBranch } : {}) } : {}),
      ...(forkRef ? { forkFrom: forkRef } : {}),
      ...launch, sessionId: request.sessionId,
    });
    const started = withWorktree && this.extras.workbench
      ? await this.hub.startWorktree(request.sessionId, deviceId, engine, cwd, worktreeBranch as string, requestId as string, launch, worktreeBaseBranch as string | undefined)
      : await this.hub.start(request.sessionId, deviceId, engine, cwd, forkRef, launch, createDir, switchBranch as string | undefined);
    // A start that belongs to a pending branch row binds it, so the tree shows
    // the child as soon as the device has the session.
    const parentId = this.workbenchRef(data);
    if (parentId && this.extras.workbench) {
      try {
        this.extras.workbench.bind(parentId, started.key);
      } catch (error) {
        if (!(error instanceof CliOpError)) throw error;
      }
    }
    return { status: 200, body: { key: started.key, ...(started.cwd ? { cwd: started.cwd } : {}) } };
  }

  private async continueSession(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const key = this.key(data.key);
    if (!key) return cliErrorResult("invalid");
    const launch = this.launchOptions(data, parseCliKey(key)!.engine);
    if (!launch) return cliErrorResult("invalid", "模型或推理强度不可用");
    this.store.audit("cli.continue", "cli_session", key, { sessionId: request.sessionId, ...launch });
    const continued = await this.hub.continueSession(request.sessionId, key, launch);
    return { status: 200, body: { key: continued.key } };
  }

  /** A separate route makes older Cores reject waiting actions instead of typing into the terminal. */
  private async steerWaiting(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    if (!this.extras.workbench) return cliErrorResult("not_found");
    const { questionId, interruptWaiting } = data;
    let waitingSteer: WaitingSteer;
    if (questionId === undefined && interruptWaiting === true) {
      waitingSteer = { interruptWaiting };
    } else if (interruptWaiting === undefined && typeof questionId === "string" && questionId.length > 0 && questionId.length <= CLI_LIMITS.requestId) {
      waitingSteer = { questionId };
    } else {
      return cliErrorResult("invalid");
    }
    if ("entryId" in data) return this.queueSteer(data, waitingSteer);
    return this.send(request, { ...data, delivery: "steer" }, waitingSteer);
  }

  private async send(request: CliRouteRequest, data: Record<string, unknown>, waitingSteer?: WaitingSteer): Promise<CliRouteResult> {
    const key = this.key(data.key);
    const text = data.text;
    if (!key || typeof text !== "string" || text.length < 1) return cliErrorResult("invalid");
    if (text.length > MAX_SEND_TEXT || utf8ByteLength(text) > MAX_SEND_TEXT) return cliErrorResult("too_large");
    // The audit row records how much was sent, never the text itself.
    this.store.audit("cli.send", "cli_session", key, { sessionId: request.sessionId, length: text.length });
    const workbench = this.extras.workbench;
    const delivery = data.delivery;
    const contract = typeof data.clientMessageId === "string" || typeof data.requestId === "string" || delivery !== undefined;
    if (contract && workbench) {
      if (!isCliDelivery(delivery)) return cliErrorResult("invalid");
      const clientMessageId = data.clientMessageId;
      const requestId = data.requestId;
      if (typeof clientMessageId !== "string" || clientMessageId.length < 1 || clientMessageId.length > 128) return cliErrorResult("invalid");
      if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) return cliErrorResult("invalid");
      const revisesMessageId = data.revisesMessageId;
      if (revisesMessageId !== undefined && (typeof revisesMessageId !== "string" || revisesMessageId.length < 1 || revisesMessageId.length > 200)) return cliErrorResult("invalid");
      const attachments = data.attachments;
      if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 20 || attachments.some((entry) => typeof entry !== "string" || entry.length > 4096))) return cliErrorResult("invalid");
      const result = await workbench.submit(request.sessionId, key, {
        text,
        delivery,
        clientMessageId,
        requestId,
        ...waitingSteer,
        ...(typeof revisesMessageId === "string" ? { revisesMessageId } : {}),
        ...(Array.isArray(attachments) ? { attachments: attachments as string[] } : {}),
      });
      return { status: 200, body: { ...result, messageId: result.messageId } };
    }
    const deviceId = parseCliKey(key)!.deviceId;
    this.extras.images?.publish(text, deviceId);
    const result = await this.hub.send(request.sessionId, key, this.extras.images?.delivery(text, deviceId) ?? text);
    return {
      status: 200,
      body: {
        turn: result.turn,
        started: result.started,
        ...(result.delivery ? { delivery: result.delivery } : {}),
        ...(result.waiting ? { waiting: true } : {}),
        ...(result.nativeQueued ? { nativeQueued: true } : {}),
      },
    };
  }

  private async interrupt(request: CliRouteRequest, data: Record<string, unknown>): Promise<CliRouteResult> {
    const key = this.key(data.key) ?? this.workbenchRef(data);
    if (!key) return cliErrorResult("invalid");
    this.store.audit("cli.interrupt", "cli_session", key, { sessionId: request.sessionId });
    const workbench = this.extras.workbench;
    if (workbench && typeof data.requestId === "string") {
      // The queue pauses before the interrupt leaves, so nothing queued can
      // fire into the turn that follows (workbench plan section 3).
      const result = await workbench.stop(request.sessionId, key);
      return { status: 200, body: { outcome: result.outcome } };
    }
    const result = await this.hub.interrupt(request.sessionId, key);
    return { status: 200, body: { outcome: result.outcome } };
  }

  private hide(data: Record<string, unknown>): CliRouteResult {
    const key = this.key(data.key);
    if (!key || typeof data.hidden !== "boolean") return cliErrorResult("invalid");
    return this.hub.hide(key, data.hidden) ? { status: 200, body: { ok: true } } : cliErrorResult("not_found");
  }
}

const POST_ROUTES = new Set([
  "/api/cli-agents/translation-settings",
  "/api/cli-agents/translate",
  "/api/cli-agents/start",
  "/api/cli-agents/continue",
  "/api/cli-agents/send",
  "/api/cli-agents/steer-waiting",
  "/api/cli-agents/interrupt",
  "/api/cli-agents/open-local",
  "/api/cli-agents/hide",
  "/api/cli-agents/answer",
  "/api/cli-agents/fork",
  "/api/cli-agents/fork-message",
  "/api/cli-agents/queue/edit",
  "/api/cli-agents/queue/withdraw",
  "/api/cli-agents/queue/steer",
  "/api/cli-agents/queue/resume",
  "/api/cli-agents/sessions/branch",
  "/api/cli-agents/sessions/rename",
  "/api/cli-agents/sessions/archive",
  "/api/cli-agents/sessions/restore",
  "/api/cli-agents/sessions/delete",
  "/api/cli-agents/notes",
  "/api/cli-agents/notes/update",
  "/api/cli-agents/notes/delete",
  "/api/cli-agents/attach",
  "/api/cli-agents/images",
]);

const GET_ROUTES = new Set([
  "/api/cli-agents/translation-settings",
  "/api/cli-agents",
  "/api/cli-agents/items",
  "/api/cli-agents/requests",
  "/api/cli-agents/queue",
  "/api/cli-agents/supervision",
  "/api/cli-agents/sessions/git",
  "/api/cli-agents/notes",
  "/api/cli-agents/search",
  "/api/cli-agents/models",
  "/api/cli-agents/skills",
  "/api/cli-agents/dirs",
  "/api/cli-agents/branches",
]);

/** The delivery a workbench submit carries; absent means the legacy contract. */
function isCliDelivery(value: unknown): value is CliDeliveryAction {
  return value === "send" || value === "queue" || value === "steer";
}
