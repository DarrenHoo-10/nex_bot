import { localCacheScope, queueLocalCache, readLocalCache } from "../local-content-cache";
// HTTP side of Agent mode (plan 5.4). Not the shared `api()` wrapper: that one
// keeps only the error text, and this page needs Core's `code` to say what
// happened. Responses are validated with the shared parsers.
import {
  CLI_ATTACH_MAX_BYTES,
  CLI_ATTACH_NAME_MAX,
  CLI_ERROR_TEXT,
  isCliEngine,
  isCliErrorCode,
  parseCliKey,
  parseCliModelCatalog,
  parseSkillCatalog,
  parseCliDirListing,
  parseCliDeviceView,
  parseCliItems,
  parseCliRequestView,
  parseCliSessionView,
  type CliDelivery,
  type CliDeviceView,
  type CliEngine,
  type CliErrorCode,
  type CliItem,
  type CliLaunchOptions,
  type CliModelCatalog,
  type CliDirListing,
  type CliAnswerDecision,
  type CliRequestView,
  type CliSessionKey,
  type CliSessionView,
} from "../../../shared/cli-agents";
import { compressPickedImage } from "./image-preview";
import { cliImageId } from "../../../shared/cli-images";

import { httpErrorText, isTechnicalMessage, readJson, userErrorText } from "../../lib/http-errors";

export class CliApiError extends Error {
  /** `detail` is the wording Core sent in the response, which may be the device's own message. */
  constructor(message: string, readonly code?: CliErrorCode, readonly status = 0, readonly detail?: string) {
    super(message);
    this.name = "CliApiError";
  }
}

/** The one line the page shows for a failed call: Core's wording when it sent some, else the code's standard text. */
export function cliErrorText(error: unknown, fallback = "操作失败"): string {
  if (error instanceof CliApiError) {
    if (error.code) return error.detail?.trim() || CLI_ERROR_TEXT[error.code];
    return error.message && !isTechnicalMessage(error.message) ? error.message : fallback;
  }
  return userErrorText(error, fallback);
}

/** `body` is sent as JSON, except a Blob, which goes as it is (an attachment). */
async function call<T>(path: string, body?: unknown, method = "POST", signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit | undefined = body === undefined
      ? undefined
      : body instanceof Blob
        ? { method, headers: { "Content-Type": body.type || "application/octet-stream" }, body }
        : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    response = await fetch(`/api/cli-agents${path}`, signal ? { ...init, signal } : init);
  } catch (error) {
    // an aborted search is the caller's own doing, not a connection failure
    if (signal?.aborted) throw error;
    throw new CliApiError(httpErrorText(0));
  }
  // empty, or a proxy's HTML page while Core restarts
  const data: unknown = await readJson(response);
  const record = (data && typeof data === "object" ? data : {}) as { error?: unknown; code?: unknown };
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("nex-session-expired"));
    const code = isCliErrorCode(record.code) ? record.code : undefined;
    const detail = typeof record.error === "string" && record.error && !isTechnicalMessage(record.error) ? record.error : undefined;
    throw new CliApiError(detail ?? httpErrorText(response.status), code, response.status, detail);
  }
  return data as T;
}

export interface CliSnapshot { devices: CliDeviceView[]; sessions: CliSessionView[]; requests: CliRequestView[] }

export async function fetchSnapshot(): Promise<CliSnapshot> {
  const data = await call<{ devices?: unknown[]; sessions?: unknown[]; requests?: unknown[] }>("");
  // one malformed row should not blank the page
  const devices = (data.devices ?? []).map(parseCliDeviceView).filter((row): row is CliDeviceView => row !== null);
  const sessions = (data.sessions ?? []).map(parseCliSessionView).filter((row): row is CliSessionView => row !== null);
  const requests = (data.requests ?? []).map(parseCliRequestView).filter((row): row is CliRequestView => row !== null);
  return { devices, sessions, requests };
}

export async function fetchItems(key: CliSessionKey, before?: string): Promise<{ items: CliItem[]; more: boolean; translationEnabled?: boolean }> {
  const query = `?key=${encodeURIComponent(key)}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  const data = await call<{ items?: unknown; more?: unknown; translationEnabled?: unknown }>(`/items${query}`);
  const items = parseCliItems(data.items);
  if (!items) throw new CliApiError("记录格式不对");
  return { items, more: data.more === true, ...(typeof data.translationEnabled === "boolean" ? { translationEnabled: data.translationEnabled } : {}) };
}

export async function translateReply(key: CliSessionKey, itemId: string, source: string, signal: AbortSignal): Promise<string | undefined> {
  const scope = localCacheScope();
  const digest = scope && globalThis.crypto?.subtle ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)).catch(() => undefined) : undefined;
  const cacheKey = digest ? `cli-translation:zh:v1:${key}:${itemId}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}` : undefined;
  const stored = cacheKey ? await readLocalCache<string>(scope, cacheKey) : undefined;
  signal.throwIfAborted();
  if (stored) return stored;
  const result = await call<{ translation?: unknown }>("/translate", { key, itemId, source }, "POST", signal);
  const translation = typeof result.translation === "string" && result.translation !== source ? result.translation : undefined;
  if (cacheKey && translation && !signal.aborted) queueLocalCache(scope, cacheKey, translation);
  return translation;
}

/** `parentId` binds the started session to a pending branch row; `forkFrom` makes it a real context fork of that session (same computer and tool).
 * `model` / `effort` (see CLI_MODELS / CLI_EFFORTS) need a computer whose capability lists `launchOptions`. */
export const startSession = (deviceId: string, engine: CliEngine, cwd: string, options: { worktreeBranch?: string; requestId?: string; parentId?: string; forkFrom?: CliSessionKey; createDir?: boolean } & CliLaunchOptions = {}) =>
  call<{ key: CliSessionKey; cwd?: string }>("/start", {
    deviceId, engine, cwd,
    ...(options.createDir ? { createDir: true } : {}),
    ...(options.worktreeBranch ? { worktreeBranch: options.worktreeBranch } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.parentId ? { parentId: options.parentId } : {}),
    ...(options.forkFrom ? { forkFrom: options.forkFrom } : {}),
    ...launchBody(options),
  });
export const continueSession = (key: CliSessionKey, options: CliLaunchOptions = {}) => call<{ key: CliSessionKey }>("/continue", { key, ...launchBody(options) });

function launchBody(options: CliLaunchOptions): CliLaunchOptions {
  return {
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
  };
}

/** The sub-folders of a folder on a computer; "" lists its drives and home folder. */
export async function listDirs(deviceId: string, path: string): Promise<CliDirListing> {
  const data = await call<unknown>(`/dirs?deviceId=${encodeURIComponent(deviceId)}&path=${encodeURIComponent(path)}`, undefined, "GET");
  const listing = parseCliDirListing(data);
  if (!listing) throw new CliApiError("目录格式不对");
  return listing;
}

export async function fetchSkills(deviceId: string, engine: CliEngine, cwd: string, key: string | undefined, signal: AbortSignal) {
  const query = new URLSearchParams({ deviceId, engine, cwd });
  if (key) query.set("key", key);
  const catalog = parseSkillCatalog(await call<unknown>(`/skills?${query}`, undefined, "GET", signal));
  if (!catalog) throw new CliApiError("技能列表格式不对");
  return catalog.skills;
}

/** A computer's model lists, read again after this long (the CLI's settings may change). */
const MODELS_TTL_MS = 60_000;
const modelLists = new Map<string, { at: number; value: Promise<CliModelCatalog> }>();

/** The rows the CLI's own `/model` picker shows on that computer. One request per computer and CLI a minute; a failure is not kept. */
export function fetchModels(deviceId: string, engine: CliEngine): Promise<CliModelCatalog> {
  const id = `${deviceId}
${engine}`;
  const cached = modelLists.get(id);
  if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.value;
  const value = call<unknown>(`/models?deviceId=${encodeURIComponent(deviceId)}&engine=${encodeURIComponent(engine)}`, undefined, "GET").then((data) => {
    const catalog = parseCliModelCatalog(data);
    if (!catalog) throw new CliApiError("模型列表格式不对");
    return catalog;
  });
  modelLists.set(id, { at: Date.now(), value });
  value.catch(() => { if (modelLists.get(id)?.value === value) modelLists.delete(id); });
  return value;
}

export interface CliSearchHit { key: CliSessionKey; snippet: string }

/** Sessions whose messages hold every word of `query`, newest activity first. */
export async function searchSessions(query: string, signal?: AbortSignal): Promise<CliSearchHit[]> {
  const data = await call<{ hits?: unknown }>(`/search?q=${encodeURIComponent(query)}`, undefined, "GET", signal);
  if (!Array.isArray(data.hits)) throw new CliApiError("搜索结果格式不对");
  const hits: CliSearchHit[] = [];
  for (const entry of data.hits) {
    const hit = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!hit || typeof hit.key !== "string" || !parseCliKey(hit.key) || typeof hit.snippet !== "string") continue;
    hits.push({ key: hit.key as CliSessionKey, snippet: hit.snippet });
  }
  return hits;
}

/** Images are stored in Core. Other files use the existing device attachment route. */
export async function uploadAttachment(key: CliSessionKey, file: File): Promise<{ path: string }> {
  const image = file.type.startsWith("image/") || /\.(?:png|jpe?g|webp)$/i.test(file.name);
  if (!image && file.size > CLI_ATTACH_MAX_BYTES) throw new CliApiError(image ? "图片不能超过 5 MB" : "附件不能超过 8 MB", "too_large", 413);
  // Core takes a name of up to 200 units; the end keeps the extension
  const name = (file.name || "file").slice(-CLI_ATTACH_NAME_MAX);
  const data = await call<{ path?: unknown }>(`/${image ? "images" : "attach"}?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`, image ? await compressPickedImage(file) : file);
  if (typeof data.path !== "string" || !data.path) throw new CliApiError("附件上传结果格式不对");
  if (image && !cliImageId(data.path)) throw new CliApiError("Core 版本过旧，升级后可发送图片");
  return { path: data.path };
}
/** `delivery` and `waiting` come only from a session outside nex_bot's terminals; the
 * workbench contract answers with the outbox entry instead. */
export interface SendResult { turn: number; started?: boolean; delivery?: CliDelivery; waiting?: boolean; nativeQueued?: boolean }
export interface WorkbenchSendResult { messageId: string; operationId?: string; status: string; version: number; queued: boolean }
export type SendOutcome = SendResult & Partial<WorkbenchSendResult>;

export interface SendOptions {
  delivery?: "send" | "queue" | "steer";
  clientMessageId?: string;
  requestId?: string;
  questionId?: string;
  interruptWaiting?: boolean;
  /** edit-and-resend: the transcript message this send revises */
  revisesMessageId?: string;
}

export async function sendMessage(key: CliSessionKey, text: string, options: SendOptions = {}): Promise<SendOutcome> {
  const withContract = options.clientMessageId !== undefined || options.requestId !== undefined || options.delivery !== undefined;
  const waiting = options.delivery === "steer" && (options.questionId || options.interruptWaiting);
  const data = await call<Record<string, unknown>>(
    waiting ? "/steer-waiting" : "/send",
    withContract
      ? { key, text, ...options, delivery: options.delivery ?? "send" }
      : { key, text },
  );
  return {
    turn: typeof data.turn === "number" ? data.turn : 0,
    ...(typeof data.started === "boolean" ? { started: data.started } : {}),
    ...(data.delivery === "confirmed" || data.delivery === "unconfirmed" ? { delivery: data.delivery } : {}),
    ...(data.waiting === true ? { waiting: true } : {}),
    ...(data.nativeQueued === true ? { nativeQueued: true } : {}),
    ...(typeof data.messageId === "string" ? { messageId: data.messageId } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.version === "number" ? { version: data.version } : {}),
    ...(data.queued === true ? { queued: true } : {}),
    ...(typeof data.operationId === "string" ? { operationId: data.operationId } : {}),
  };
}

/** Stops the running turn; Core pauses the session's queue first. */
export const stopSession = (key: CliSessionKey, requestId: string) => call<{ outcome: string }>("/interrupt", { key, requestId });
export const resumeQueue = (key: CliSessionKey) => call<{ ok: boolean }>("/queue/resume", { key });
export const editQueued = (entryId: string, expectedVersion: number, text: string) =>
  call<{ entry: unknown }>("/queue/edit", { entryId, expectedVersion, text });
export const withdrawQueued = (entryId: string, expectedVersion: number) =>
  call<{ entry: unknown }>("/queue/withdraw", { entryId, expectedVersion });
export const steerQueued = (entryId: string, expectedVersion: number, options: Pick<SendOptions, "questionId" | "interruptWaiting"> = {}) =>
  call<{ entry: { status: string } }>(options.questionId || options.interruptWaiting ? "/steer-waiting" : "/queue/steer", { entryId, expectedVersion, ...options });
export const interruptSession = (key: CliSessionKey) => call<{ outcome: string }>("/interrupt", { key });
export const openLocal = (key: CliSessionKey) => call<{ ok: boolean }>("/open-local", { key });
export const hideSession = (key: CliSessionKey, hidden: boolean) => call<{ ok: boolean }>("/hide", { key, hidden });

/** An answer: allow or deny, with the chosen labels for a question; `always` allows such calls for the rest of the session. */
export const answerRequest = (id: string, decision: CliAnswerDecision, answers?: Record<string, string>, always?: boolean) =>
  call<{ outcome: string }>("/answer", { id, decision, ...(answers ? { answers } : {}), ...(always ? { always: true } : {}) });

export const forkSession = (key: CliSessionKey, botId: string, itemId?: string) =>
  call<{ botId: string; conversationId: string }>(itemId === undefined ? "/fork" : "/fork-message", { key, botId, itemId });

// ---------------------------------------------------------------------------
// Workbench tree, queue and Git (workbench plan sections 3 and 4)

export interface CliWorkbenchSession {
  id: string;
  sessionKey?: CliSessionKey | null;
  deviceId?: string | null;
  engine?: CliEngine | null;
  cwd: string;
  parentId?: string | null;
  kind: "main" | "fork" | "side";
  title: string;
  archived: boolean;
  version: number;
}

export interface CliQueueEntry {
  id: string;
  seq: number;
  text: string;
  status: "pending" | "claimed" | "sent" | "confirmed" | "failed" | "withdrawn" | "uncertain";
  version: number;
  createdAt: number;
  updatedAt: number;
  revisesMessageId?: string;
  errorCode?: string;
}

export interface CliQueue {
  workbenchId: string;
  sessionKey: CliSessionKey;
  paused: boolean;
  pauseReason?: string;
  entries: CliQueueEntry[];
}

export interface CliGitInfo {
  source: "worktree" | "folder" | "none" | "failed";
  project?: string;
  worktree?: string;
  branch?: string;
  head?: string;
  files?: string[];
  added?: number;
  removed?: number;
  error?: string;
}

function parseWorkbench(value: unknown): CliWorkbenchSession | null {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!row || typeof row.id !== "string") return null;
  return {
    id: row.id,
    sessionKey: typeof row.sessionKey === "string" ? row.sessionKey as CliSessionKey : null,
    deviceId: typeof row.deviceId === "string" ? row.deviceId : null,
    engine: isCliEngine(row.engine) ? row.engine : null,
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    parentId: typeof row.parentId === "string" ? row.parentId : null,
    kind: row.kind === "fork" || row.kind === "side" ? row.kind : "main",
    title: typeof row.title === "string" ? row.title : "",
    archived: row.archived === true,
    version: typeof row.version === "number" ? row.version : 0,
  };
}

export function parseWorkbenchRows(value: unknown): CliWorkbenchSession[] {
  return Array.isArray(value) ? value.map(parseWorkbench).filter((row): row is CliWorkbenchSession => row !== null) : [];
}

function parseQueue(value: unknown): CliQueue | null {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!row || typeof row.workbenchId !== "string" || typeof row.sessionKey !== "string") return null;
  const entries = Array.isArray(row.entries) ? row.entries : [];
  return {
    workbenchId: row.workbenchId,
    sessionKey: row.sessionKey as CliSessionKey,
    paused: row.paused === true,
    pauseReason: typeof row.pauseReason === "string" ? row.pauseReason : undefined,
    entries: entries
      .filter((entry): entry is Record<string, unknown> => !!(entry && typeof entry === "object"))
      .map((entry) => ({
        id: String(entry.id),
        seq: Number(entry.seq) || 0,
        text: typeof entry.text === "string" ? entry.text : "",
        status: typeof entry.status === "string" ? entry.status as CliQueueEntry["status"] : "pending",
        version: Number(entry.version) || 0,
        createdAt: Number(entry.createdAt) || 0,
        updatedAt: Number(entry.updatedAt) || 0,
        ...(typeof entry.revisesMessageId === "string" ? { revisesMessageId: entry.revisesMessageId } : {}),
        ...(typeof entry.errorCode === "string" ? { errorCode: entry.errorCode } : {}),
      })),
  };
}

export async function fetchSnapshotWithWorkbench(): Promise<CliSnapshot & { workbench: CliWorkbenchSession[]; queues: CliQueue[] }> {
  const data = await call<Record<string, unknown>>("");
  const base = await (async () => {
    const devices = (Array.isArray(data.devices) ? data.devices : []).map(parseCliDeviceView).filter((row): row is CliDeviceView => row !== null);
    const sessions = (Array.isArray(data.sessions) ? data.sessions : []).map(parseCliSessionView).filter((row): row is CliSessionView => row !== null);
    const requests = (Array.isArray(data.requests) ? data.requests : []).map(parseCliRequestView).filter((row): row is CliRequestView => row !== null);
    return { devices, sessions, requests };
  })();
  return {
    ...base,
    workbench: parseWorkbenchRows(data.workbench),
    queues: (Array.isArray(data.queues) ? data.queues : []).map(parseQueue).filter((row): row is CliQueue => row !== null),
  };
}

export async function fetchQueue(key: CliSessionKey): Promise<CliQueue> {
  const data = await call<Record<string, unknown>>(`/queue?key=${encodeURIComponent(key)}`, undefined, "GET");
  const queue = parseQueue(data.queue);
  if (!queue) throw new CliApiError("队列状态读取失败");
  return queue;
}

export async function fetchGit(key: CliSessionKey): Promise<CliGitInfo> {
  const data = await call<Record<string, unknown>>(`/sessions/git?key=${encodeURIComponent(key)}`, undefined, "GET");
  const source = data.source;
  if (source !== "worktree" && source !== "folder" && source !== "none" && source !== "failed") throw new CliApiError("Git 状态读取失败");
  return {
    source,
    ...(typeof data.project === "string" ? { project: data.project } : {}),
    ...(typeof data.worktree === "string" ? { worktree: data.worktree } : {}),
    ...(typeof data.branch === "string" ? { branch: data.branch } : {}),
    ...(typeof data.head === "string" ? { head: data.head } : {}),
    ...(Array.isArray(data.files) ? { files: data.files.filter((file): file is string => typeof file === "string") } : {}),
    ...(typeof data.added === "number" ? { added: data.added } : {}),
    ...(typeof data.removed === "number" ? { removed: data.removed } : {}),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

export const branchSession = (parentKey: CliSessionKey, title: string, requestId: string, kind: "fork" | "side" = "fork") =>
  call<{ id: string; parentId: string | null; version: number }>("/sessions/branch", { parentKey, requestId, ...(title ? { title } : {}), ...(kind === "side" ? { kind } : {}) });

// ---------------------------------------------------------------------------
// Notes: annotations on a conversation's messages, kept in Core

export interface CliNote {
  id: string;
  message: string;
  num: number;
  start: number;
  end: number;
  quote: string;
  body: string;
  version: number;
}

function parseNote(value: unknown): CliNote | null {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!row || typeof row.id !== "string" || typeof row.message !== "string" || typeof row.quote !== "string" || typeof row.body !== "string") return null;
  return {
    id: row.id, message: row.message, quote: row.quote, body: row.body,
    num: typeof row.num === "number" ? row.num : 1,
    start: typeof row.start === "number" ? row.start : 0,
    end: typeof row.end === "number" ? row.end : 0,
    version: typeof row.version === "number" ? row.version : 1,
  };
}

export async function fetchNotes(key: CliSessionKey): Promise<CliNote[]> {
  const data = await call<{ notes?: unknown }>(`/notes?key=${encodeURIComponent(key)}`, undefined, "GET");
  return (Array.isArray(data.notes) ? data.notes : []).map(parseNote).filter((note): note is CliNote => note !== null);
}

export async function createNote(key: CliSessionKey, note: { id: string; message: string; quote: string; body: string; num: number; start?: number; end?: number }): Promise<CliNote> {
  const data = await call<{ note?: unknown }>("/notes", { key, ...note });
  const saved = parseNote(data.note);
  if (!saved) throw new CliApiError("注释保存失败");
  return saved;
}

export async function updateNote(id: string, expectedVersion: number, body: string): Promise<CliNote> {
  const data = await call<{ note?: unknown }>("/notes/update", { id, expectedVersion, body });
  const saved = parseNote(data.note);
  if (!saved) throw new CliApiError("注释保存失败");
  return saved;
}

export const deleteNote = (id: string, expectedVersion: number) => call<{ ok: boolean }>("/notes/delete", { id, expectedVersion });
/** A logical row the client has seen (with its version), or just the native
 * key of a session that has no logical row yet; Core creates it on demand. */
export type WorkbenchRef = { id: string; expectedVersion: number } | { key: CliSessionKey };
export const renameWorkbenchSession = (ref: WorkbenchRef, title: string) =>
  call<{ session: unknown }>("/sessions/rename", { ...ref, title });
export const archiveWorkbenchSession = (ref: WorkbenchRef, archived: boolean) =>
  call<{ session: unknown }>(archived ? "/sessions/archive" : "/sessions/restore", ref);
export const deleteWorkbenchSession = (ref: WorkbenchRef) =>
  call<{ session: unknown }>("/sessions/delete", ref);

/** `triage` classifies finished turns with a model; `decide` and `wake` only act on its verdict. */
export interface SupervisionSettings { transientRetry: boolean; usageLimit: boolean; wakeup: boolean; triage: boolean; decide: boolean; wake: boolean }
export const SUPERVISION_KEYS = ["transientRetry", "usageLimit", "wakeup", "triage", "decide", "wake"] as const;
const SUPERVISION_DEFAULTS: SupervisionSettings = { transientRetry: true, usageLimit: false, wakeup: false, triage: false, decide: false, wake: false };

export interface SupervisionView {
  /** the switches in force for every folder without its own setting */
  settings: SupervisionSettings;
  /** folders with settings of their own */
  overrides: number;
  /** actions waiting for their time */
  pending: number;
}

function parseSupervision(data: unknown): SupervisionView {
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const root = record(data);
  const defaults = record(root.defaults), global = record(root.global);
  const settings = { ...SUPERVISION_DEFAULTS };
  for (const key of SUPERVISION_KEYS) {
    const value = typeof global[key] === "boolean" ? global[key] : defaults[key];
    if (typeof value === "boolean") settings[key] = value;
  }
  const actions = Array.isArray(root.actions) ? root.actions : [];
  return {
    settings,
    overrides: Array.isArray(root.workspaces) ? root.workspaces.length : 0,
    pending: actions.filter((action) => record(action).status === "pending").length,
  };
}

export async function fetchSupervision(): Promise<SupervisionView> {
  return parseSupervision(await call<unknown>("/supervision"));
}

/** Changes some switches for every folder; the answer is the new state. */
export async function saveSupervision(settings: Partial<SupervisionSettings>): Promise<SupervisionView> {
  return parseSupervision(await call<unknown>("/supervision", { settings }, "PUT"));
}
