import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  CLI_LIMITS, CLI_MODEL_LIMITS, CLI_EFFORTS, ITEM_TEXT_MAX, SUMMARY_MAX, TOOL_OUTPUT_MAX,
  cliRef, isCliEffort, parseDeviceCliMessage, truncateUtf8,
  type CliErrorCode, type CliItem, type CliLaunchOptions, type CliModelCatalog,
  type CliOpArgs, type CliRequestResolvedBy, type CliRequestWire, type CliTurnReason, type DeviceCliMessage,
} from "../../../shared/cli-agents.ts";
import { CLI_IMAGE_PREFIX, mapCliImageLinks } from "../../../shared/cli-images.ts";
import { execCli } from "../../procs.ts";
import { AgyAcp, AgyAcpError } from "./agy-acp.ts";
import {
  agyArray, agyJson, agyModelId, agyProxyEnvironment, agyRecord, agyString, agyTranscript, agyWriters, isAgyId, scanAgyHistory,
  type AgyNativeSession, type AgyRecord, type AgyWriters,
} from "./agy-native.ts";
import { clipUnits, type LocalSession } from "./items.ts";
import { TranscriptReader, type ReaderPage } from "./reader.ts";

const IDLE_MS = 5 * 60_000;
const REQUEST_MS = 5 * 60_000;
const CANCEL_GRACE_MS = 6000;
const MAX_TAIL = 160;
const MAX_RECENT_TURNS = 8;
const HISTORY_LOOKBACK = 200;
const MODEL_TTL = 60_000;
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;
const MAX_IMAGE = 5 * 1024 * 1024;

export class AgyError extends Error {
  constructor(readonly code: CliErrorCode, message: string) { super(message); }
}

interface AgyOptions {
  dir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  writers?: typeof agyWriters;
  executable: () => Promise<string>;
  origin: () => string;
  changed: () => void;
  emit: (message: DeviceCliMessage) => void;
  ended: (id: string, turn: number, reason: CliTurnReason, error?: string) => void;
}

interface Session {
  id: string;
  cwd: string;
  at: number;
  settings: CliLaunchOptions;
  title: string;
  model?: string;
  acp?: AgyAcp;
  closing?: Promise<void>;
  idle?: NodeJS.Timeout;
  active?: Turn;
  tails: Turn[];
  allowed: Set<string>;
  version: number;
  count: number;
}

interface Turn {
  startedAt: number;
  waiting: number;
  stopping: boolean;
  cancelTimer?: NodeJS.Timeout;
  completed: boolean;
  error?: string;
  version: number;
  items: CliItem[];
  calls: Map<string, Extract<CliItem, { kind: "tool" }>>;
  lastText?: Extract<CliItem, { kind: "assistant" | "thinking" }>;
}

interface Request {
  session: Session;
  wire: CliRequestWire;
  timer: NodeJS.Timeout;
  cancel: unknown;
  answer: (args: CliOpArgs["answer"]) => unknown;
  reply: (result: unknown) => Promise<void>;
}

interface RequestField {
  key: string;
  label: string;
  options: string[];
  type: "string" | "boolean" | "number" | "integer";
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if ((error instanceof AgyAcpError && error.rpcCode === -32000 && /auth/i.test(message)) || /sign.?in|authenticat|logged in|invalid_grant|oauth/i.test(message)) {
    return "请先在该电脑运行 agy 登录 Google";
  }
  // Service errors sometimes embed URLs with sign-in or request tokens.
  if (/https?:\/\/|token=|authorization:/i.test(message)) return "Antigravity CLI 请求失败";
  return clipUnits(message.replace(/\s+/g, " ").trim(), CLI_LIMITS.turnError) || "Antigravity CLI 请求失败";
}

function operationError(error: unknown): AgyError {
  if (error instanceof AgyError) return error;
  if (error instanceof AgyAcpError && error.rpcCode === -32002) return new AgyError("not_found", "Antigravity CLI 找不到原会话");
  return new AgyError("invalid", safeError(error));
}

function modelsFromOutput(output: string, configured: string, configuredEffort: string): CliModelCatalog {
  const models = new Map<string, CliModelCatalog["models"][number]>();
  let current: string | undefined;
  let currentEffort: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const [raw, label] = line.trim().split(/\t+/);
    const id = agyModelId(raw);
    if (!id || !label) continue;
    const variant = EFFORT_SUFFIX.exec(id)?.[1];
    const base = variant ? id.slice(0, -(variant.length + 1)) : id;
    const model = models.get(base) ?? { id: base, label: clipUnits(label.replace(/\s+\([^)]*\)$/, ""), CLI_MODEL_LIMITS.label) || base, efforts: [] };
    if (variant && !model.efforts?.includes(variant)) model.efforts?.push(variant);
    models.set(base, model);
    if (configured === id || configured === label) {
      current = base;
      currentEffort = variant;
    }
  }
  const rows = [...models.values()].slice(0, CLI_MODEL_LIMITS.models);
  for (const row of rows) row.efforts = CLI_EFFORTS.agy.filter((effort) => row.efforts?.includes(effort));
  if (isCliEffort("agy", configuredEffort)) currentEffort = configuredEffort;
  return { models: rows, ...(current ? { current } : {}), ...(currentEffort ? { currentEffort } : {}) };
}

function chosenConfig(response: AgyRecord, id: string, category: string): AgyRecord {
  return agyArray(response.configOptions).map(agyRecord).find((option) => option.id === id || option.category === category) ?? {};
}

function nativeModel(response: AgyRecord): string | undefined {
  const config = chosenConfig(response, "model", "model");
  return agyModelId(config.currentValue ?? agyRecord(response.models).currentModelId);
}

function fieldsOf(schema: AgyRecord): RequestField[] | null {
  const entries = Object.entries(agyRecord(schema.properties));
  if (schema.type !== "object" || !entries.length || entries.length > CLI_LIMITS.requestQuestions) return null;
  const fields: RequestField[] = [];
  for (const [key, value] of entries) {
    const field = agyRecord(value);
    const type = field.type;
    if (!key || key === "__proto__" || (type !== "string" && type !== "boolean" && type !== "number" && type !== "integer")) return null;
    const enumOptions = agyArray(field.enum).filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= CLI_LIMITS.requestOption);
    if (field.enum && (!enumOptions.length || enumOptions.length !== agyArray(field.enum).length || enumOptions.length > CLI_LIMITS.requestOptions)) return null;
    const caption = agyString(field.title ?? field.description) || key;
    const label = clipUnits(entries.length > 1 ? `${key} · ${caption}` : caption, CLI_LIMITS.requestQuestion);
    fields.push({ key, label, options: type === "boolean" ? ["是", "否"] : enumOptions, type });
  }
  return new Set(fields.map((field) => field.label)).size === fields.length ? fields : null;
}

/** Resolve only signed NexAgent images from the bound Core. Never put their ticket in AGY's transcript. */
async function promptContent(text: string, origin: string, acceptsImages: boolean): Promise<{ text: string; prompt: AgyRecord[] }> {
  const images = new Map<string, URL>();
  const boundOrigin = URL.canParse(origin) ? new URL(origin).origin : "";
  const clean = mapCliImageLinks(text, (id, original) => {
    const url = URL.canParse(original) ? new URL(original) : null;
    if (url?.origin === boundOrigin && !url.username && !url.password && url.searchParams.has("ticket")) images.set(id, url);
    return CLI_IMAGE_PREFIX + id;
  });
  if (images.size > 5) throw new AgyError("too_large", "最多添加 5 张图片");
  if (images.size && !acceptsImages) throw new AgyError("invalid", "当前 Antigravity 模型不支持图片");
  const attachments = await Promise.all([...images.values()].map(async (url): Promise<AgyRecord> => {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
      if (!response.ok || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) throw new Error();
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
      if (!size) throw new Error();
      return { type: "image", mimeType, data: Buffer.concat(chunks).toString("base64") };
    } catch {
      throw new AgyError("invalid", "Antigravity CLI 无法读取图片，请重新上传");
    }
  }));
  return { text: clean, prompt: [{ type: "text", text: clean }, ...attachments] };
}

export class AgyRuntime {
  private enabled = false;
  private disposed = false;
  private readonly sessions = new Map<string, Session>();
  private native = new Map<string, AgyNativeSession>();
  private readonly processes = new Set<AgyAcp>();
  private readonly requests = new Map<string, Request>();
  private writers: AgyWriters = { sessions: new Set(), unknown: true };
  private writersAt = 0;
  private catalog?: { until: number; result: Promise<CliModelCatalog> };
  private scans?: Promise<void>;

  constructor(private readonly options: AgyOptions) {}

  enable(): void { this.enabled = true; }

  proxyEnvironment(): Promise<Record<string, string>> {
    return agyProxyEnvironment(this.options.platform, this.options.env);
  }

  async scan(): Promise<void> {
    if (!this.enabled || this.disposed) return;
    this.scans ??= (async () => {
      const rows = await scanAgyHistory(this.options.dir, this.options.platform);
      this.native = new Map(rows.map((entry) => [entry.row.nativeId, entry]));
      if (Date.now() - this.writersAt > 5000) await this.refreshWriters();
    })().finally(() => { this.scans = undefined; });
    await this.scans;
  }

  rows(): LocalSession[] {
    const rows = new Map<string, LocalSession>();
    for (const [id, { row, working }] of this.native) {
      const explicit = this.writers.sessions.has(id.toLowerCase());
      rows.set(id, {
        ...row,
        state: working && (explicit || this.writers.unknown) ? "running" : explicit ? "idle" : "stopped",
        ...(explicit ? { liveIn: "terminal" } : {}),
        ...(!explicit && this.writers.unknown ? { writerUnknown: true } : {}),
      });
    }
    for (const [id, session] of this.sessions) {
      const row = rows.get(id);
      const waiting = [...this.requests.values()].some((request) => request.session === session);
      rows.set(id, {
        engine: "agy", nativeId: id, cwd: session.cwd, configDir: this.options.dir,
        title: row?.title || session.title || path.basename(session.cwd),
        state: waiting ? "waiting" : session.active ? "running" : "idle",
        sendVia: "acp", liveIn: "background", transcript: row?.transcript ?? "",
        lastActivityAt: Math.max(session.at, row?.lastActivityAt ?? 0),
        ...(session.model ? { model: session.model } : {}),
      });
    }
    return [...rows.values()];
  }

  hasRequest(id: string): boolean { return this.requests.has(id); }

  relink(): void {
    for (const { wire } of this.requests.values()) this.options.emit({ type: "cli.request", ...wire });
  }

  async close(): Promise<void> {
    this.disposed = true;
    for (const session of this.sessions.values()) clearTimeout(session.idle);
    for (const request of this.requests.values()) this.finishRequest(request, "gone");
    this.sessions.clear();
    await Promise.allSettled([...this.processes].map((acp) => acp.close()));
  }

  async models(): Promise<CliModelCatalog> {
    if (!this.enabled) return { models: [] };
    const now = Date.now();
    if (this.catalog && this.catalog.until > now) return this.catalog.result;
    const result = this.readModels();
    this.catalog = { until: now + MODEL_TTL, result };
    try { return await result; } catch (error) {
      if (this.catalog?.result === result) this.catalog = undefined;
      throw error;
    }
  }

  private async readModels(): Promise<CliModelCatalog> {
    const executable = await this.options.executable();
    const [settings, proxy] = await Promise.all([agyJson(path.join(this.options.dir, "settings.json")), this.proxyEnvironment()]);
    return new Promise((resolve, reject) => {
      execCli(executable, ["models"], {
        env: { ...this.options.env, ...proxy, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, timeout: 6500, maxBuffer: 1024 * 1024,
      }, (error, out) => {
        const catalog = modelsFromOutput(out, agyString(settings.model), agyString(settings.effort));
        if (!error && catalog.models.length) resolve(catalog);
        else reject(new AgyError("invalid", "无法读取 Antigravity 模型。请检查此电脑的 agy 登录状态"));
      });
    });
  }

  async start(cwd: string, settings: CliLaunchOptions): Promise<string> {
    const session = this.session("", cwd, settings);
    await this.connect(session, false);
    this.sessions.set(session.id, session);
    this.armIdle(session);
    this.options.changed();
    return session.id;
  }

  async resume(row: LocalSession | Pick<LocalSession, "nativeId" | "cwd">, settings: CliLaunchOptions): Promise<void> {
    if (!isAgyId(row.nativeId)) throw new AgyError("not_found", "找不到 Antigravity CLI 会话");
    const known = this.sessions.get(row.nativeId);
    if (known) {
      if (!Object.keys(settings).length) return;
      if (known.active) throw new AgyError("busy", "等当前轮结束后再更改 Antigravity 设置");
      if (!known.acp) await this.requireAvailableWriter(row.nativeId);
      const acp = await this.connect(known, true);
      try {
        await this.configure(known, acp, settings);
      } catch (error) {
        throw operationError(error);
      } finally {
        this.armIdle(known);
        this.options.changed();
      }
      return;
    }
    await this.requireAvailableWriter(row.nativeId);
    const session = this.session(row.nativeId, row.cwd, settings);
    await this.connect(session, true);
    this.sessions.set(session.id, session);
    this.armIdle(session);
    this.options.changed();
  }

  /** Hand off an idle ACP conversation before opening it in a local terminal. */
  async handoff(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session?.active) throw new AgyError("busy", "等当前轮结束后再在本机打开");
    await this.requireAvailableWriter(id);
    if (!session) return;
    if (!(await agyTranscript(this.options.dir, id))) throw new AgyError("busy", "等 Antigravity CLI 保存会话后再打开");
    await this.scan();
    clearTimeout(session.idle);
    await this.retire(session);
    this.sessions.delete(id);
    this.options.changed();
  }

  private async requireAvailableWriter(id: string): Promise<void> {
    await this.refreshWriters();
    if (this.writers.unknown || this.writers.sessions.has(id.toLowerCase())) {
      throw new AgyError("open_elsewhere", "请先退出电脑上打开此会话的 Antigravity CLI");
    }
  }

  private async refreshWriters(): Promise<void> {
    const pids = new Set<number>();
    for (const process of this.processes) if (process.pid) pids.add(process.pid);
    this.writers = await (this.options.writers ?? agyWriters)(this.options.platform, pids);
    this.writersAt = Date.now();
  }

  private session(id: string, cwd: string, settings: CliLaunchOptions): Session {
    return { id, cwd, settings, at: Date.now(), title: "", tails: [], allowed: new Set(), version: 0, count: 0 };
  }

  private async connect(session: Session, resume: boolean): Promise<AgyAcp> {
    await session.closing;
    if (session.acp) return session.acp;
    if (!this.enabled || this.disposed) throw new AgyError("cli_missing", "请安装或更新到 Antigravity CLI 1.5.15 以上");
    const [executable, proxy] = await Promise.all([this.options.executable(), this.proxyEnvironment()]);
    if (this.disposed) throw new AgyError("paused", "本机控制已暂停");
    let acp: AgyAcp;
    try {
      acp = new AgyAcp(executable, session.cwd, { ...this.options.env, ...proxy },
        (method, params, request) => this.onRpc(session, acp, method, params, request),
        () => this.disconnected(session, acp));
    } catch (error) {
      throw operationError(error);
    }
    this.processes.add(acp);
    session.acp = acp;
    try {
      await acp.initialize();
      const base = { cwd: session.cwd, mcpServers: [] };
      const native = agyRecord(acp.capabilities.sessionCapabilities);
      const method = resume && native.resume && typeof native.resume === "object" ? "session/resume" : "session/load";
      if (resume && method === "session/load" && acp.capabilities.loadSession !== true) {
        throw new AgyError("invalid", "此 Antigravity CLI 版本无法续接会话");
      }
      const response = resume
        ? await acp.request(method, { ...base, sessionId: session.id })
        : await acp.request("session/new", base);
      if (!resume) {
        if (!isAgyId(response.sessionId)) throw new AgyError("invalid", "Antigravity CLI 返回了无效会话");
        session.id = response.sessionId;
      }
      await this.configure(session, acp, session.settings, response, !resume);
      return acp;
    } catch (error) {
      await this.retire(session);
      throw operationError(error);
    }
  }

  private async configure(session: Session, acp: AgyAcp, settings: CliLaunchOptions, initial?: AgyRecord, newSession = false): Promise<void> {
    let response = initial ?? {};
    if (newSession || settings.permissions === "ask") {
      const mode = chosenConfig(response, "mode", "mode");
      const current = agyString(mode.currentValue ?? agyRecord(response.modes).currentModeId);
      if ((!initial || current) && current !== "default") {
        const configured = await acp.request("session/set_mode", { sessionId: session.id, modeId: "default" });
        response = { ...response, ...configured };
      }
    }
    if (settings.permissions) session.settings.permissions = settings.permissions;
    for (const [kind, configId] of [["model", "model"], ["effort", "thought_level"]] as const) {
      const value = settings[kind];
      if (!value) continue;
      const option = chosenConfig(response, configId, configId);
      if (option.currentValue !== value) {
        const configured = await acp.request("session/set_config_option", { sessionId: session.id, configId: agyString(option.id) || configId, value });
        response = { ...response, ...configured };
      }
      session.settings[kind] = value;
      if (kind === "model") session.model = nativeModel(response) ?? value;
    }
    session.model = nativeModel(response) ?? session.model;
  }

  private disconnected(session: Session, acp: AgyAcp): void {
    if (session.acp !== acp) return;
    session.acp = undefined;
    clearTimeout(session.idle);
    for (const request of this.requests.values()) if (request.session === session) this.finishRequest(request, "gone");
    if (session.active) {
      session.active.error = "Antigravity CLI 已断开，当前轮结果未知";
      this.endTurn(session, session.active);
    }
    // Leave the process classified as ours until the child group is gone.
    const closing = Promise.resolve().then(() => acp.close());
    session.closing = closing;
    void closing.then(
      () => {
        this.processes.delete(acp);
        if (session.closing === closing) session.closing = undefined;
      },
      () => { /* Retain the failure so this session cannot acquire a second writer. */ },
    );
  }

  private async retire(session: Session): Promise<void> {
    const acp = session.acp;
    if (acp) await acp.close();
    await session.closing;
  }

  private armIdle(session: Session): void {
    clearTimeout(session.idle);
    if (!session.acp || this.disposed) return;
    session.idle = setTimeout(() => {
      if (!session.active) void this.retire(session).catch(() => {});
    }, IDLE_MS);
    session.idle.unref();
  }

  async send(id: string, text: string, steer = false): Promise<{ turn: number; started: boolean }> {
    const session = this.sessions.get(id);
    if (!session) throw new AgyError("stopped", "请先继续此 Antigravity CLI 会话");
    let turn = session.active;
    if (steer && (!turn || turn.stopping)) throw new AgyError("turn_changed", "目标轮次已经结束");
    if (!steer && turn) throw new AgyError("busy", "当前轮次还在运行");
    if (!steer && !session.acp) await this.requireAvailableWriter(id);
    const acp = await this.connect(session, true);
    const content = await promptContent(text, this.options.origin(), agyRecord(acp.capabilities.promptCapabilities).image === true);
    if (steer && session.active !== turn) throw new AgyError("turn_changed", "目标轮次已经结束");
    clearTimeout(session.idle);
    if (!turn) {
      turn = { startedAt: Date.now(), waiting: 0, stopping: false, completed: false, version: 0, items: [], calls: new Map() };
      session.active = turn;
      session.tails.push(turn);
      if (session.tails.length > MAX_RECENT_TURNS) session.tails.shift();
      session.count += 1;
    }
    const active = turn;
    const turnNumber = session.count;
    const ts = Date.now();
    session.title ||= clipUnits(content.text.trim().split("\n", 1)[0], CLI_LIMITS.title);
    session.at = ts;
    active.lastText = undefined;
    active.items.push({ id: randomUUID(), ts, kind: "user", text: truncateUtf8(content.text, ITEM_TEXT_MAX) });
    active.version++;
    active.waiting++;
    const call = acp.prompt({ sessionId: id, prompt: content.prompt });
    void call.result.then(
      (result) => this.promptSettled(session, active, result),
      (error) => this.promptSettled(session, active, {}, error),
    );
    this.options.changed();
    try { await call.written; } catch { throw new AgyError("unknown", "写入 Antigravity CLI 的结果未知"); }
    return { turn: turnNumber, started: !steer };
  }

  async interrupt(id: string): Promise<{ outcome: string }> {
    const session = this.sessions.get(id);
    const turn = session?.active;
    if (!session?.acp || !turn) throw new AgyError("turn_changed", "目标轮次已经结束");
    turn.stopping = true;
    try { await session.acp.cancel(id); } catch { throw new AgyError("unknown", "Antigravity CLI 停止结果未知"); }
    for (const request of this.requests.values()) if (request.session === session) this.finishRequest(request, "gone", request.cancel);
    if (session.active === turn && !turn.cancelTimer) {
      turn.cancelTimer = setTimeout(() => {
        if (session.active === turn) void this.retire(session).catch(() => {});
      }, CANCEL_GRACE_MS);
      turn.cancelTimer.unref();
    }
    return { outcome: "sent" };
  }

  async answer(args: CliOpArgs["answer"]): Promise<{ outcome: string }> {
    const request = this.requests.get(args.id);
    if (!request) throw new AgyError("not_found", "此请求已关闭");
    const result = request.answer(args);
    this.finishRequest(request, "nexbot");
    try { await request.reply(result); } catch { throw new AgyError("unknown", "Antigravity CLI 未确认答复"); }
    return { outcome: "delivered" };
  }

  private promptSettled(session: Session, turn: Turn, response: AgyRecord, error?: unknown): void {
    if (session.active !== turn) return;
    turn.waiting--;
    if (error) turn.error = safeError(error);
    if (response.stopReason === "cancelled") turn.stopping = true;
    if (turn.waiting <= 0) this.endTurn(session, turn);
  }

  private endTurn(session: Session, turn: Turn): void {
    if (session.active !== turn) return;
    clearTimeout(turn.cancelTimer);
    for (const request of this.requests.values()) if (request.session === session) this.finishRequest(request, "gone");
    if (turn.error) turn.items.push({ id: randomUUID(), ts: Date.now(), kind: "notice", level: "error", text: turn.error });
    for (const tool of turn.calls.values()) if (tool.status === "running") tool.status = turn.stopping || turn.error ? "error" : "ok";
    turn.version++;
    turn.completed = true;
    session.active = undefined;
    session.at = Date.now();
    this.armIdle(session);
    this.options.changed();
    this.options.ended(session.id, session.count, turn.stopping ? "interrupted" : turn.error ? "error" : "end", turn.error);
  }

  private onRpc(session: Session, acp: AgyAcp, method: string, params: AgyRecord, rpcId: string | number | undefined): void {
    if (params.sessionId !== session.id || !session.id || this.disposed) {
      if (rpcId !== undefined) void acp.refuse(rpcId, -32602).catch(() => {});
      return;
    }
    if (method === "session/update" && rpcId === undefined) {
      this.update(session, agyRecord(params.update));
      return;
    }
    if (rpcId === undefined) return;
    const reply = (result: unknown) => acp.respond(rpcId, result);
    if (method === "session/request_permission") this.permission(session, params, reply);
    else if (method === "elicitation/create" && params.mode === "form") this.question(session, params, reply);
    else void acp.refuse(rpcId).catch(() => {});
  }

  private update(session: Session, update: AgyRecord): void {
    if (update.sessionUpdate === "config_option_update" || update.sessionUpdate === "session_info_update") {
      session.model = nativeModel(update) ?? session.model;
      session.title = clipUnits(agyString(update.title), CLI_LIMITS.title) || session.title;
      this.options.changed();
    }
    const turn = session.active;
    if (!turn) return;
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      const text = agyRecord(update.content).text;
      if (typeof text !== "string" || !text) return;
      const kind = update.sessionUpdate === "agent_message_chunk" ? "assistant" : "thinking";
      const previous = turn.lastText;
      if (previous?.kind === kind) {
        previous.text = truncateUtf8(previous.text + text, ITEM_TEXT_MAX);
      } else {
        const next: NonNullable<Turn["lastText"]> = { id: randomUUID(), ts: Date.now(), kind, text: truncateUtf8(text, ITEM_TEXT_MAX) };
        turn.lastText = next;
        turn.items.push(next);
      }
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const callId = agyString(update.toolCallId);
      if (!callId) return;
      turn.lastText = undefined;
      let item = turn.calls.get(callId);
      if (!item) {
        item = { id: randomUUID(), ts: Date.now(), kind: "tool", name: "Antigravity", input: "", status: "running" };
        turn.calls.set(callId, item);
        turn.items.push(item);
      }
      item.name = clipUnits(agyString(update.title) || item.name, CLI_LIMITS.toolName);
      item.status = update.status === "completed" ? "ok" : update.status === "failed" ? "error" : item.status;
      if (update.rawInput !== undefined) item.input = truncateUtf8(JSON.stringify(update.rawInput), TOOL_OUTPUT_MAX);
      if (update.rawOutput !== undefined) item.output = truncateUtf8(JSON.stringify(update.rawOutput), TOOL_OUTPUT_MAX);
    } else return;
    if (turn.items.length > MAX_TAIL) {
      const removed = turn.items.splice(1, 1)[0];
      for (const [id, item] of turn.calls) if (item === removed) turn.calls.delete(id);
    }
    turn.version++;
  }

  private permission(session: Session, params: AgyRecord, reply: Request["reply"]): void {
    const toolCall = agyRecord(params.toolCall);
    const opts = agyArray(params.options).map(agyRecord);
    const allow = agyString(opts.find((option) => option.kind === "allow_once")?.optionId);
    const deny = agyString(opts.find((option) => option.kind === "reject_once")?.optionId);
    const cancelled = { outcome: { outcome: "cancelled" } };
    const selected = (id: string) => id ? { outcome: { outcome: "selected", optionId: id } } : cancelled;
    if (session.active?.stopping) { void reply(cancelled).catch(() => {}); return; }
    const input = toolCall.rawInput === undefined ? "" : JSON.stringify(toolCall.rawInput);
    const key = input.length > 0 && input.length <= CLI_LIMITS.requestDetail ? `${agyString(toolCall.title)}\n${input}` : "";
    if (allow && (session.settings.permissions === "full" || (key && session.allowed.has(key)))) {
      void reply(selected(allow)).catch(() => {});
      return;
    }
    this.openRequest(session, {
      kind: "permission", tool: "Antigravity",
      summary: truncateUtf8(agyString(toolCall.title), SUMMARY_MAX),
      detail: clipUnits(input, CLI_LIMITS.requestDetail),
      ...(key && allow ? { always: true } : {}),
    }, reply, cancelled, (args) => {
      if (args.always && args.decision === "allow" && key && allow && session.allowed.size < 128) session.allowed.add(key);
      return selected(args.decision === "allow" ? allow : deny);
    });
  }

  private question(session: Session, params: AgyRecord, reply: Request["reply"]): void {
    const cancel = { action: "cancel" };
    const fields = fieldsOf(agyRecord(params.requestedSchema));
    if (session.active?.stopping || !fields) { void reply(cancel).catch(() => {}); return; }
    this.openRequest(session, {
      kind: "question", tool: "Antigravity",
      summary: truncateUtf8(agyString(params.message), SUMMARY_MAX),
      questions: fields.map((field) => ({ question: field.label, options: field.options.map((label) => ({ label })) })),
    }, reply, cancel, (args) => {
      if (args.decision !== "allow") return { action: "decline" };
      const content: Record<string, string | boolean | number> = Object.create(null);
      for (const field of fields) {
        const value = args.answers?.[field.label] ?? (fields.length === 1 ? args.message : undefined);
        if (!value || (field.options.length && !field.options.includes(value))) throw new AgyError("invalid", "请选择或填写 Antigravity 提问的有效答案");
        if (field.type === "number" || field.type === "integer") {
          const n = Number(value);
          if (!Number.isFinite(n) || (field.type === "integer" && !Number.isSafeInteger(n))) throw new AgyError("invalid", "Antigravity 需要数字答案");
          content[field.key] = n;
        } else content[field.key] = field.type === "boolean" ? value === "是" : value;
      }
      return { action: "accept", content };
    });
  }

  private openRequest(
    session: Session, fields: Omit<CliRequestWire, "id" | "ref" | "expiresAt">,
    reply: Request["reply"], cancel: unknown, answer: Request["answer"],
  ): void {
    const wire = {
      ...fields, id: randomUUID(), ref: cliRef("agy", session.id), expiresAt: Date.now() + REQUEST_MS,
    };
    if (!session.active || this.requests.size >= CLI_LIMITS.requestsPerSession || !parseDeviceCliMessage({ type: "cli.request", ...wire })) {
      void reply(cancel).catch(() => {});
      return;
    }
    const timer = setTimeout(() => this.finishRequest(request, "timeout", cancel), REQUEST_MS);
    timer.unref();
    const request: Request = { wire, timer, session, cancel, reply, answer };
    this.requests.set(wire.id, request);
    this.options.changed();
    this.options.emit({ type: "cli.request", ...wire });
  }

  private finishRequest(request: Request, resolvedBy: CliRequestResolvedBy, respond?: unknown): void {
    if (!this.requests.delete(request.wire.id)) return;
    clearTimeout(request.timer);
    if (respond !== undefined) void request.reply(respond).catch(() => {});
    this.options.emit({ type: "cli.request.resolved", id: request.wire.id, by: resolvedBy });
    this.options.changed();
  }

  /** A watch polls only the open session. ACP items cover the gap before AGY exports native steps. */
  async marker(id: string): Promise<string> {
    const file = await agyTranscript(this.options.dir, id);
    const info = file ? await stat(file).catch(() => null) : null;
    const tail = this.sessions.get(id)?.tails ?? [];
    return `${file}:${info?.size ?? 0}:${info?.mtimeMs ?? 0}:${tail.map((turn) => `${turn.startedAt}:${turn.version}`).join(",")}`;
  }

  async page(id: string, options: { before?: string } = {}, limit = 40): Promise<ReaderPage> {
    const file = await agyTranscript(this.options.dir, id);
    const reader = file ? new TranscriptReader({ path: file, engine: "agy", watch: false }) : null;
    try {
      const session = this.sessions.get(id);
      const tails = session?.tails;
      if (!tails?.length) return await reader?.page({ ...options, limit }) ?? { items: [], more: false };
      const page = await reader?.page({ limit: HISTORY_LOOKBACK }) ?? { items: [], more: false };
      let items = page.items;
      const settled = new Set<Turn>();
      for (const turn of tails) {
        const sent = turn.items[0];
        if (!sent || sent.kind !== "user") continue;
        const at = items.findIndex((item) => item.kind === "user" && item.text.trim() === sent.text.trim() && item.ts >= turn.startedAt);
        const lastReply = turn.items.findLast((item) => item.kind === "assistant");
        const exported = at >= 0 && turn.completed && !turn.error && !turn.stopping &&
          (lastReply?.kind === "assistant"
            ? items.slice(at + 1).some((item) => item.kind === "assistant" && item.text.trim() === lastReply.text.trim())
            : turn.items.length === 1);
        if (exported) {
          settled.add(turn);
          continue;
        }
        // Within the current turn the export can contain only part of the reply.
        // Replace that part as a unit until the completed native reply catches up.
        if (at >= 0) {
          const upcoming = items.findIndex((item, index) => index > at && item.kind === "user" && item.ts > (turn.items.at(-1)?.ts ?? turn.startedAt) + 1000);
          items = [...items.slice(0, at), ...turn.items, ...(upcoming >= 0 ? items.slice(upcoming) : [])];
        } else items = [...items, ...turn.items];
      }
      if (session && settled.size) session.tails = session.tails.filter((turn) => !settled.has(turn));
      const at = options.before === undefined ? items.length : items.findIndex((item) => item.id === options.before);
      if (at < 0) return await reader?.page({ ...options, limit }) ?? { items: [], more: false };
      return { items: items.slice(Math.max(0, at - limit), at), more: at > limit || page.more };
    } finally {
      reader?.close();
    }
  }
}
