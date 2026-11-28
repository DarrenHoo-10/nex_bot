import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  CLI_LIMITS, CLI_MODEL_LIMITS, CLI_EFFORTS, SUMMARY_MAX,
  cliRef, isCliEffort, parseDeviceCliMessage, truncateUtf8,
  type CliErrorCode, type CliItem, type CliLaunchOptions, type CliModelCatalog,
  type CliOpArgs, type CliRequestResolvedBy, type CliRequestWire, type CliSessionRef, type CliTeamDeviceConfig, type CliTeamStartMeta, type CliTurnReason, type DeviceCliMessage,
} from "../../../shared/cli-agents.ts";
import { CLI_IMAGE_PREFIX, mapCliImageLinks } from "../../../shared/cli-images.ts";
import {
  isInsideDir,
  isLeadAllowedTempFilePath,
  isLeadBlockedShellCommand,
  isSafeAutoApproveNexCommand,
  leadInstruction,
} from "./team-cli.ts";
import { execCli } from "../../procs.ts";
import { AgyAcp, AgyAcpError } from "./agy-acp.ts";
import {
  agyArray, agyDesktopWriters, agyJson, agyLastStep, agyModelId, agyProxyEnvironment, agyRecord, agyString, agyTranscript, agyWriters, deleteAgyConversation, isAgyId, scanAgyHistory, setAgyArchived,
  type AgyNativeSession, type AgyRecord, type AgyWriters,
} from "./agy-native.ts";
import { appendItemText, buildAssistantItem, buildNoticeItem, buildThinkingItem, buildToolItem, buildUserItem, clipUnits, updateToolItem, type LocalSession } from "./items.ts";
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
  desktopDir?: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  writers?: typeof agyWriters;
  executable: () => Promise<string>;
  origin: () => string;
  changed: () => void;
  emit: (message: DeviceCliMessage) => void;
  ended: (id: string, turn: number, reason: CliTurnReason, error?: string) => void;
  teamConfig?: () => CliTeamDeviceConfig;
  isActiveTeamLead?: (ref: CliSessionRef) => boolean;
  teamEnv?: (sessionId: string) => Promise<Record<string, string>>;
  onTeamBound?: (pendingId: string, realId: string) => void;
}

interface Session {
  id: string;
  dir: string;
  cwd: string;
  at: number;
  settings: CliLaunchOptions;
  isWorker: boolean;
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
  afterStep?: number;
  nativeUser?: string;
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
  private desktopWriters: AgyWriters = { sessions: new Set(), unknown: true };
  private writersAt = 0;
  private catalog?: { until: number; result: Promise<CliModelCatalog> };
  private scans?: Promise<void>;

  constructor(private readonly options: AgyOptions) {}

  enable(): void { this.enabled = true; }

  proxyEnvironment(): Promise<Record<string, string>> {
    return agyProxyEnvironment(this.options.platform, this.options.env);
  }

  async scan(): Promise<void> {
    if (this.disposed || (!this.enabled && !this.options.desktopDir)) return;
    this.scans ??= (async () => {
      const { dir, desktopDir, platform } = this.options;
      const [cli, desktop] = await Promise.all([
        this.enabled ? scanAgyHistory(dir, platform) : [],
        desktopDir ? scanAgyHistory(desktopDir, platform, true) : [],
      ]);
      // The CLI also indexes desktop-only IDs. Prefer the App's actual history
      // over a CLI summary with no local transcript.
      this.native = new Map(cli.map(entry => [entry.row.nativeId, entry]));
      for (const entry of desktop) {
        const id = entry.row.nativeId;
        const owner = this.sessions.get(id);
        if (owner ? owner.dir === desktopDir : !this.native.get(id)?.row.transcript) this.native.set(id, entry);
      }
      if (Date.now() - this.writersAt > 5000) await this.refreshWriters();
    })().finally(() => { this.scans = undefined; });
    await this.scans;
  }

  rows(): LocalSession[] {
    const rows = new Map<string, LocalSession>();
    for (const [id, { row, working }] of this.native) {
      if (row.configDir === this.options.desktopDir) {
        const held = this.desktopWriters.sessions.has(id.toLowerCase());
        const next: LocalSession = {
          ...row,
          state: working ? "running" : held ? "idle" : "stopped",
          ...(working || held ? { liveIn: "desktop" } : {}),
          ...(this.desktopWriters.unknown ? { writerUnknown: true } : {}),
        };
        if (working || held) delete next.archived;
        rows.set(id, next);
        continue;
      }
      const explicit = this.writers.sessions.has(id.toLowerCase());
      const next: LocalSession = {
        ...row,
        state: working && (explicit || this.writers.unknown) ? "running" : explicit ? "idle" : "stopped",
        ...(explicit ? { liveIn: "terminal" } : {}),
        ...(!explicit && this.writers.unknown ? { writerUnknown: true } : {}),
      };
      if (working || explicit) delete next.archived;
      rows.set(id, next);
    }
    for (const [id, session] of this.sessions) {
      const row = rows.get(id);
      const waiting = [...this.requests.values()].some((request) => request.session === session);
      rows.set(id, {
        engine: "agy", nativeId: id, cwd: session.cwd, configDir: session.dir,
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

  hasManagedSession(id: string): boolean { return this.sessions.has(id); }

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

  async start(cwd: string, settings: CliLaunchOptions, team?: CliTeamStartMeta): Promise<string> {
    const session = this.session("", cwd, settings, this.options.dir, Boolean(team));
    await this.connect(session, false);
    this.sessions.set(session.id, session);
    this.armIdle(session);
    this.options.changed();
    return session.id;
  }

  async resume(row: Pick<LocalSession, "nativeId" | "cwd" | "configDir">, settings: CliLaunchOptions): Promise<void> {
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
    await this.requireAvailableWriter(row.nativeId, row.configDir);
    const session = this.session(row.nativeId, row.cwd, settings, row.configDir);
    await this.connect(session, true);
    this.sessions.set(session.id, session);
    this.armIdle(session);
    this.options.changed();
  }

  /** Natively archives or restores an Antigravity conversation in `annotations/<id>.pbtxt`. */
  async archiveSession(id: string, dir: string, archived: boolean): Promise<void> {
    if (!isAgyId(id)) throw new AgyError("not_found", "找不到 Antigravity 会话");
    const session = this.sessions.get(id);
    if (archived) {
      if (session?.active) throw new AgyError("busy", "会话正在运行，请先停止后再归档");
      if (session) {
        clearTimeout(session.idle);
        await this.retire(session);
        this.sessions.delete(id);
      }
    }
    const targetDir = dir || this.sessionDir(id);
    await setAgyArchived(targetDir, id, archived);
    await this.scan();
    this.options.changed();
  }

  /** Permanently deletes a local Antigravity conversation after confirming no live writer holds it. */
  async deleteSession(id: string, dir: string): Promise<void> {
    if (!isAgyId(id)) throw new AgyError("not_found", "找不到 Antigravity 会话");
    const session = this.sessions.get(id);
    if (session?.active) throw new AgyError("busy", "会话正在运行，请先停止后再删除");
    const targetDir = dir || this.sessionDir(id);
    await this.requireAvailableWriter(id, targetDir);
    if (session) {
      clearTimeout(session.idle);
      await this.retire(session);
      this.sessions.delete(id);
    }
    await deleteAgyConversation(targetDir, id);
    await this.scan();
    this.options.changed();
  }
  private async requireAvailableWriter(id: string, dir = this.sessionDir(id)): Promise<void> {
    await this.refreshWriters();
    if (dir === this.options.desktopDir) {
      // An open ACP client holds its own native presence lock during handoff.
      const locked = this.desktopWriters.unknown || this.desktopWriters.sessions.has(id.toLowerCase()) || this.native.get(id)?.working;
      if (this.writers.sessions.has(id.toLowerCase()) || (!this.sessions.get(id)?.acp && locked)) {
        throw new AgyError("open_elsewhere", "请先在 Antigravity 桌面端结束并关闭此会话");
      }
      return;
    }
    if (this.writers.unknown || this.writers.sessions.has(id.toLowerCase())) {
      throw new AgyError("open_elsewhere", "请先退出电脑上打开此会话的 Antigravity CLI");
    }
  }

  private async refreshWriters(): Promise<void> {
    const pids = new Set<number>();
    for (const process of this.processes) if (process.pid) pids.add(process.pid);
    [this.writers, this.desktopWriters] = await Promise.all([
      (this.options.writers ?? agyWriters)(this.options.platform, pids),
      this.options.desktopDir && [...this.native.values()].some(entry => entry.row.configDir === this.options.desktopDir)
        ? agyDesktopWriters(this.options.desktopDir, this.options.platform) : { sessions: new Set<string>(), unknown: true },
    ]);
    this.writersAt = Date.now();
  }

  private sessionDir(id: string): string {
    return this.sessions.get(id)?.dir ?? this.native.get(id)?.row.configDir ?? this.options.dir;
  }

  profileArgs(dir: string): string[] {
    return dir === this.options.desktopDir ? ["--app-data-dir=antigravity"] : [];
  }

  private session(id: string, cwd: string, settings: CliLaunchOptions, dir = this.options.dir, isWorker = false): Session {
    return { id, dir, cwd, settings, isWorker, at: Date.now(), title: "", tails: [], allowed: new Set(), version: 0, count: 0 };
  }

  private async connect(session: Session, resume: boolean): Promise<AgyAcp> {
    await session.closing;
    if (session.acp) return session.acp;
    if (!this.enabled || this.disposed) throw new AgyError("cli_missing", "请安装或更新到 Antigravity CLI 1.5.15 以上");
    const pendingId = session.id || randomUUID();
    const [executable, proxy, teamEnv] = await Promise.all([
      this.options.executable(),
      this.proxyEnvironment(),
      this.options.teamEnv ? this.options.teamEnv(pendingId).catch(() => ({})) : Promise.resolve({}),
    ]);
    if (this.disposed) throw new AgyError("paused", "本机控制已暂停");
    let acp: AgyAcp;
    try {
      acp = new AgyAcp(executable, session.cwd, { ...this.options.env, ...proxy, ...teamEnv },
        (method, params, request) => this.onRpc(session, acp, method, params, request),
        () => this.disconnected(session, acp), this.profileArgs(session.dir));
    } catch (error) {
      throw operationError(error);
    }
    this.processes.add(acp);
    session.acp = acp;
    try {
      await acp.initialize();
      const base: Record<string, unknown> = { cwd: session.cwd, mcpServers: [] };
      const native = agyRecord(acp.capabilities.sessionCapabilities);
      const method = resume && native.resume && typeof native.resume === "object" ? "session/resume" : "session/load";
      if (resume && method === "session/load" && acp.capabilities.loadSession !== true) {
        throw new AgyError("invalid", "此 Antigravity CLI 版本无法续接会话");
      }
      if (!resume && !session.isWorker) {
        const prompt = leadInstruction(this.options.teamConfig?.().dispatchMode ?? "prompt");
        if (prompt) base._meta = { antigravity: { systemPrompt: { append: prompt } } };
      }
      const response = resume
        ? await acp.request(method, { ...base, sessionId: session.id })
        : await acp.request("session/new", base);
      if (!resume) {
        if (!isAgyId(response.sessionId)) throw new AgyError("invalid", "Antigravity CLI 返回了无效会话");
        session.id = response.sessionId;
        if (pendingId !== session.id) this.options.onTeamBound?.(pendingId, session.id);
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
    // Antigravity's own modes: `auto_edit` lets file edits through; asking and full access both run `default`, and
    // full access is answered by this executor (see `answer`). `auto_edit` goes in as the assistants' driver sets it.
    const wanted = settings.permissions === "edits" ? "auto_edit" : "default";
    if (newSession || settings.permissions === "ask" || settings.permissions === "edits") {
      const mode = chosenConfig(response, "mode", "mode");
      const current = agyString(mode.currentValue ?? agyRecord(response.modes).currentModeId);
      if ((!initial || current) && current !== wanted) {
        const configured = wanted === "default"
          ? await acp.request("session/set_mode", { sessionId: session.id, modeId: "default" })
          : await acp.request("session/set_config_option", { sessionId: session.id, configId: agyString(mode.id) || "mode", value: wanted });
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
      if (session.active) return;
      void this.retire(session).then(() => {
        if (!session.isWorker && !session.active && !session.acp && session.count === 0 && !this.native.get(session.id)?.row.transcript) {
          this.sessions.delete(session.id);
          this.options.changed();
        }
      }).catch(() => {});
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
      const afterStep = await agyLastStep(session.dir, id);
      if (session.active) throw new AgyError("busy", "当前轮次还在运行");
      turn = { afterStep, startedAt: Date.now(), waiting: 0, stopping: false, completed: false, version: 0, items: [], calls: new Map() };
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
    active.items.push(buildUserItem({ id: randomUUID(), ts, text: content.text }));
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
    if (turn.error) turn.items.push(buildNoticeItem({ id: randomUUID(), ts: Date.now(), level: "error", text: turn.error }));
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
        appendItemText(previous, text);
      } else {
        const next: NonNullable<Turn["lastText"]> = kind === "thinking"
          ? buildThinkingItem({ id: randomUUID(), ts: Date.now(), text })
          : buildAssistantItem({ id: randomUUID(), ts: Date.now(), text });
        turn.lastText = next;
        turn.items.push(next);
      }
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const callId = agyString(update.toolCallId);
      if (!callId) return;
      turn.lastText = undefined;
      let item = turn.calls.get(callId);
      if (!item) {
        item = buildToolItem({ id: randomUUID(), ts: Date.now(), name: "Antigravity", status: "running" });
        turn.calls.set(callId, item);
        turn.items.push(item);
      }
      updateToolItem(item, {
        name: agyString(update.title) || undefined,
        status: update.status === "completed" ? "ok" : update.status === "failed" ? "error" : undefined,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
      });
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
    const rawInput = agyRecord(toolCall.rawInput);
    const toolKind = agyString(toolCall.kind);
    const toolTitle = agyString(toolCall.title).toLowerCase();
    const cmdLine = agyString(rawInput.CommandLine);
    const cmdShort = agyString(rawInput.command);
    const consistentCmd = !cmdLine || !cmdShort || cmdLine === cmdShort;
    const rawCmd = consistentCmd ? (cmdLine || cmdShort) : "";
    const cmdCwd = agyString(rawInput.Cwd ?? rawInput.cwd);
    const cwdAllowed = !cmdCwd || isInsideDir(session.cwd, cmdCwd, this.options.platform);
    // In active collaboration mode, the lead session only plans and decides — never edits project files directly.
    if (deny && !session.isWorker && session.id && this.options.isActiveTeamLead?.(cliRef("agy", session.id))) {
      const editTarget =
        agyString(rawInput.TargetFile) ||
        agyString(rawInput.file_path) ||
        agyString(rawInput.AbsolutePath) ||
        agyString(rawInput.path) ||
        agyString(rawInput.target_file);
      const isEditTool =
        toolKind === "edit" ||
        toolKind === "write" ||
        /\b(?:write_to_file|replace_file_content|multi_replace_file_content|edit_file|write_file|create_file|apply_patch|notebook_edit)\b/.test(toolTitle);
      if (isEditTool && (!editTarget || !isLeadAllowedTempFilePath(editTarget, session.cwd, this.options.platform))) {
        void reply(selected(deny)).catch(() => {});
        return;
      }
      if ((!toolKind || toolKind === "execute") && rawCmd && isLeadBlockedShellCommand(rawCmd, cmdCwd || session.cwd, this.options.platform)) {
        void reply(selected(deny)).catch(() => {});
        return;
      }
    }
    const allowNex =
      (this.options.teamConfig?.().allowNexInAsk ?? true) &&
      (!toolKind || toolKind === "execute") &&
      cwdAllowed &&
      isSafeAutoApproveNexCommand(rawCmd, cmdCwd || session.cwd, this.options.platform);
    if (allow && (session.settings.permissions === "full" || allowNex || (key && session.allowed.has(key)))) {
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
    const file = await agyTranscript(this.sessionDir(id), id);
    const info = file ? await stat(file).catch(() => null) : null;
    const tail = this.sessions.get(id)?.tails ?? [];
    return `${file}:${info?.size ?? 0}:${info?.mtimeMs ?? 0}:${tail.map((turn) => `${turn.startedAt}:${turn.version}`).join(",")}`;
  }

  async page(id: string, options: { before?: string; limit?: number } = {}, limit = options.limit ?? 40): Promise<ReaderPage> {
    const file = await agyTranscript(this.sessionDir(id), id);
    const reader = file ? new TranscriptReader({ path: file, engine: "agy", watch: false }) : null;
    try {
      const session = this.sessions.get(id);
      const tails = session?.tails;
      if (!tails?.length) return await reader?.page({ ...options, limit }) ?? { items: [], more: false };
      const page = await reader?.page({ limit: HISTORY_LOOKBACK }) ?? { items: [], more: false };
      let items = page.items;
      const settled = new Set<Turn>();
      let previousStep = -1;
      for (const turn of tails) {
        const sent = turn.items[0];
        if (!sent || sent.kind !== "user") continue;
        if (previousStep >= 0) turn.afterStep = Math.max(turn.afterStep ?? -1, previousStep);
        const at = items.findIndex(item => item.kind === "user" && /^agy:\d+$/.test(item.id) && (turn.nativeUser ? item.id === turn.nativeUser :
          item.text.trim() === sent.text.trim() && (turn.afterStep === undefined ? item.ts >= turn.startedAt : Number(item.id.slice(4)) > turn.afterStep)));
        let end = at + 1;
        if (at >= 0) {
          turn.nativeUser = items[at].id;
          previousStep = Number(turn.nativeUser.slice(4));
          const steers = turn.items.slice(1).filter(item => item.kind === "user");
          let matched = 0;
          for (; end < items.length; end++) {
            const next = items[end];
            if (next.kind !== "user") continue;
            if (!/^agy:\d+$/.test(next.id) || steers[matched]?.text.trim() !== next.text.trim()) break;
            previousStep = Number(next.id.slice(4));
            matched++;
          }
        }
        const lastReply = turn.items.findLast((item) => item.kind === "assistant");
        const exported = at >= 0 && turn.completed && !turn.error && !turn.stopping &&
          (lastReply?.kind === "assistant"
            ? items.slice(at + 1, end).some((item) => item.kind === "assistant" && item.text.trim() === lastReply.text.trim())
            : turn.items.length === 1 || items.slice(at + 1, end).some((item) => item.kind === "assistant"));
        if (exported) {
          settled.add(turn);
          continue;
        }
        // Within the current turn the export can contain only part of the reply.
        // Replace that part as a unit until the completed native reply catches up.
        if (at >= 0) {
          items = [...items.slice(0, at), ...turn.items, ...items.slice(end)];
        } else items = [...items, ...turn.items];
      }
      if (session && settled.size) session.tails = session.tails.filter((turn) => !settled.has(turn));
      const at = options.before === undefined ? items.length : items.findIndex((item) => item.id === options.before);
      if (at < 0) return await reader?.page({ ...options, limit }) ?? { items: [], more: false };
      const slice = items.slice(Math.max(0, at - limit), at);
      // HISTORY_LOOKBACK is just the window for reconciling live ACP items.
      // At its edge continue before the first *native* id, even when a live
      // turn replaced that id. Never return an empty page claiming more.
      if (slice.length < limit && page.more && reader && page.items.length) {
        const prefix = await reader.page({ before: page.items[0].id, limit: limit - slice.length });
        return { items: [...prefix.items, ...slice], more: prefix.more };
      }
      return { items: slice, more: at > limit || page.more };
    } finally {
      reader?.close();
    }
  }
}
