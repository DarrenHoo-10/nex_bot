// Managed ZCode runtime over ZCode's stdio NDJSON `app-server` protocol
// (modeled on `agy.ts`). Handles session discovery (SQLite + live managed
// sessions), creating/resuming sessions, streaming replies, steering,
// interrupts, permission/question cards, model catalog and skills.
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLI_EFFORTS,
  CLI_LIMITS,
  CLI_MODEL_LIMITS,
  MAX_SESSIONS,
  PAGE_SIZE,
  SUMMARY_MAX,
  cliRef,
  isCliEffort,
  isCliModel,
  isCliNativeId,
  parseDeviceCliMessage,
  truncateUtf8,
  type CliContextUsage,
  type CliEngine,
  type CliErrorCode,
  type CliItem,
  type CliLaunchOptions,
  type CliModelCatalog,
  type CliOpArgs,
  type CliPermissionMode,
  type CliRequestQuestion,
  type CliRequestResolvedBy,
  type CliRequestWire,
  type CliTurnReason,
  type DeviceCliMessage,
  type SkillOption,
} from "../../../shared/cli-agents.ts";
import { CLI_IMAGE_PREFIX, mapCliImageLinks } from "../../../shared/cli-images.ts";
import { execCli } from "../../procs.ts";
import {
  appendItemText,
  buildAssistantItem,
  buildNoticeItem,
  buildThinkingItem,
  buildToolItem,
  buildUserItem,
  clipUnits,
  updateToolItem,
  type LocalSession,
  type TranscriptImage,
} from "./items.ts";
import type { ReaderPage } from "./reader.ts";
import {
  ZcodeAppServer,
  ZcodeProtocolError,
  asZcodeArray,
  asZcodeRecord,
  asZcodeString,
  type ZcodeRecord,
  type ZcodeRpcId,
} from "./zcode-protocol.ts";
import {
  ZcodeDb,
  defaultZcodeHome,
  resolveZcodeDbPath,
  resolveZcodeLaunch,
  type ZcodeHostChannel,
  type ZcodeLaunchSpec,
  type ZcodeSessionRow,
} from "./zcode.ts";

const IDLE_MS = 5 * 60_000;
const REQUEST_MS = 5 * 60_000;
const CANCEL_GRACE_MS = 6000;
const MAX_TAIL = 160;
const MAX_RECENT_TURNS = 8;
const HISTORY_LOOKBACK = 200;
const MODEL_TTL = 60_000;
const MAX_IMAGE = 5 * 1024 * 1024;
const V4_ATTACHMENT_CHUNK_BYTES = 512 * 1024;

export class ZcodeError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ZcodeRuntimeOptions {
  /** ZCode DB homes to read; defaults to `[~/.zcode/cli]` when probed. */
  homes?: string[];
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir?: string;
  /** Optional external host channel (kept for host-channel tests). */
  host?: ZcodeHostChannel | null;
  resolveCli?: (engine: CliEngine) => Promise<string | null>;
  resolveLaunch?: () => Promise<ZcodeLaunchSpec | null>;
  origin: () => string;
  changed: () => void;
  emit: (message: DeviceCliMessage) => void;
  ended: (id: string, turn: number, reason: CliTurnReason, error?: string) => void;
}

interface ModelMeta {
  id: string;
  providerId: string;
  modelId: string;
  label: string;
  providerLabel: string;
  efforts: string[];
  defaultLevel?: string;
  requiresReasoning: boolean;
  supportsImage: boolean;
  contextWindow?: number;
}

interface ModelSelection {
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
}

interface Session {
  id: string;
  cwd: string;
  configDir: string;
  at: number;
  settings: CliLaunchOptions;
  title: string;
  model?: string;
  modelSelection?: ModelSelection;
  context?: CliContextUsage;
  idle?: NodeJS.Timeout;
  active?: Turn;
  tails: Turn[];
  allowed: Set<string>;
  count: number;
  subscribed: boolean;
}

interface Turn {
  startedAt: number;
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
  nativeKey?: string;
  wire: CliRequestWire;
  timer: NodeJS.Timeout;
  cancel: unknown;
  answer: (args: CliOpArgs["answer"]) => unknown;
  replies: Array<(result: unknown) => Promise<void>>;
}

interface ZcodeAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  bytes: Buffer;
  dataBase64: string;
  sizeBytes: number;
}

interface V4AttachmentRef {
  ref: string;
  fileName: string;
  mime: string;
  bytes: number;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/sign.?in|authenticat|logged in|api.?key|unauthori[sz]ed|credential|oauth/i.test(message)) {
    return "请先在该电脑打开 ZCode 检查账号或模型配置";
  }
  if (/https?:\/\/|token=|authorization:/i.test(message)) return "ZCode 请求失败";
  return clipUnits(message.replace(/\s+/g, " ").trim(), CLI_LIMITS.turnError) || "ZCode 请求失败";
}

function operationError(error: unknown): ZcodeError {
  if (error instanceof ZcodeError) return error;
  if (error instanceof ZcodeProtocolError) {
    if (error.rpcCode === -32004 || /session not found/i.test(error.message)) {
      return new ZcodeError("not_found", "ZCode 找不到原会话");
    }
    if (error.rpcCode === -32010 || /already running/i.test(error.message)) {
      return new ZcodeError("busy", "当前轮次还在运行");
    }
  }
  return new ZcodeError("invalid", safeError(error));
}

function toZcodeMode(mode: CliPermissionMode | undefined): string {
  switch (mode) {
    case "plan":
      return "plan";
    case "ask":
      return "guarded";
    case "edits":
      return "edit";
    case "full":
    default:
      return "yolo";
  }
}

async function canonicalCwd(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function parseModelId(id: string): { providerId: string; modelId: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash >= id.length - 1) return null;
  return { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

function formatModelRef(ref: ZcodeRecord): { id: string; providerId: string; modelId: string } | null {
  const providerId = asZcodeString(ref.providerId).trim();
  const modelId = asZcodeString(ref.modelId).trim();
  if (!providerId || !modelId) return null;
  return { id: `${providerId}/${modelId}`, providerId, modelId };
}

function parseAvailableModels(settings: ZcodeRecord): {
  catalog: CliModelCatalog;
  meta: Map<string, ModelMeta>;
} {
  const modelSettings = asZcodeRecord(settings.model);
  const available = asZcodeArray(modelSettings.available);
  const meta = new Map<string, ModelMeta>();
  const options: CliModelCatalog["models"] = [];
  for (const entry of available) {
    const rec = asZcodeRecord(entry);
    const ref = formatModelRef(asZcodeRecord(rec.ref));
    if (!ref || !isCliModel(ref.id) || meta.has(ref.id)) continue;
    const label = clipUnits(asZcodeString(rec.label).trim() || ref.modelId, CLI_MODEL_LIMITS.label);
    const providerLabel = clipUnits(asZcodeString(rec.providerLabel).trim() || ref.providerId, CLI_MODEL_LIMITS.description);
    const reasoning = asZcodeRecord(rec.reasoning);
    const rawLevels = asZcodeArray(reasoning.levels)
      .map((item) => asZcodeString(asZcodeRecord(item).value).trim())
      .filter(Boolean);
    const efforts = CLI_EFFORTS.zcode.filter((level) => rawLevels.includes(level));
    const defaultLevel = asZcodeString(reasoning.defaultLevel).trim() || efforts[0];
    const inputFormat = asZcodeRecord(asZcodeRecord(rec.properties).inputFormat);
    const supportsImage = inputFormat.supportsImage !== false;
    const contextWindow = Number(rec.contextWindow);
    const item: ModelMeta = {
      id: ref.id,
      providerId: ref.providerId,
      modelId: ref.modelId,
      label,
      providerLabel,
      efforts,
      ...(defaultLevel ? { defaultLevel } : {}),
      requiresReasoning: rawLevels.length > 0,
      supportsImage,
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.trunc(contextWindow) } : {}),
    };
    meta.set(ref.id, item);
    if (options.length < CLI_MODEL_LIMITS.models) {
      options.push({
        id: ref.id,
        label,
        ...(providerLabel ? { description: providerLabel } : {}),
        ...(efforts.length ? { efforts } : { efforts: [] }),
      });
    }
  }
  const currentRef = formatModelRef(asZcodeRecord(modelSettings.current));
  const current = currentRef && meta.has(currentRef.id) ? currentRef.id : options[0]?.id;
  const rawThought = asZcodeString(settings.thoughtLevel).trim();
  const currentEffort = isCliEffort("zcode", rawThought) ? rawThought : undefined;
  return {
    catalog: {
      models: options,
      ...(current ? { current } : {}),
      ...(currentEffort ? { currentEffort } : {}),
    },
    meta,
  };
}

/** Resolves only signed NexAgent images from the bound Core. Tickets never enter ZCode. */
async function promptAttachments(
  text: string,
  origin: string,
  supportsImage: boolean,
): Promise<{ text: string; attachments: ZcodeAttachment[] }> {
  const images = new Map<string, URL>();
  const boundOrigin = URL.canParse(origin) ? new URL(origin).origin : "";
  const clean = mapCliImageLinks(text, (id, original) => {
    const url = URL.canParse(original) ? new URL(original) : null;
    if (url?.origin === boundOrigin && !url.username && !url.password && url.searchParams.has("ticket")) {
      images.set(id, url);
    }
    return CLI_IMAGE_PREFIX + id;
  });
  if (images.size > 5) throw new ZcodeError("too_large", "最多添加 5 张图片");
  if (images.size && !supportsImage) throw new ZcodeError("invalid", "当前 ZCode 模型不支持图片");
  const attachments = await Promise.all(
    [...images.entries()].map(async ([id, url]): Promise<ZcodeAttachment> => {
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
          if (size > MAX_IMAGE) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
        if (!size) throw new Error();
        const ext = mimeType.split("/")[1] || "png";
        const bytes = Buffer.concat(chunks);
        return {
          kind: "image",
          filename: `${id}.${ext}`,
          mimeType,
          bytes,
          dataBase64: bytes.toString("base64"),
          sizeBytes: size,
        };
      } catch {
        throw new ZcodeError("invalid", "ZCode 无法读取图片，请重新上传");
      }
    }),
  );
  return { text: clean, attachments };
}

export class ZcodeRuntime {
  readonly id = "zcode" as const;
  private enabled = false;
  private launchable = false;
  private disposed = false;
  private launchSpec: ZcodeLaunchSpec | null = null;
  private readonly dbs: ZcodeDb[];
  private readonly primaryHome: string;
  private readonly explicitDbPath?: string;
  private readonly connectionId = `nexagent-${randomUUID()}`;
  private readonly sessions = new Map<string, Session>();
  private native = new Map<string, { home: string; row: ZcodeSessionRow }>();
  private server: ZcodeAppServer | null = null;
  private connecting: Promise<ZcodeAppServer> | null = null;
  private serverIdle: NodeJS.Timeout | null = null;
  private readonly processes = new Set<ZcodeAppServer>();
  private readonly requests = new Map<string, Request>();
  private modelMeta = new Map<string, ModelMeta>();
  private catalog?: { until: number; result: Promise<CliModelCatalog> };
  private scans?: Promise<void>;

  constructor(private readonly options: ZcodeRuntimeOptions) {
    const homes = options.homes ?? [];
    const envDbPath = options.env.ZCODE_SESSION_DB_PATH?.trim();
    if (!homes.length && envDbPath) {
      const parent = path.dirname(envDbPath);
      this.primaryHome = path.basename(parent).toLowerCase() === "db" ? path.dirname(parent) : parent;
      this.explicitDbPath = envDbPath;
      this.dbs = [new ZcodeDb(this.primaryHome, { dbFile: envDbPath, ignorePids: () => this.ownPids() })];
    } else {
      this.primaryHome = homes[0] ?? defaultZcodeHome(options.homedir, options.env);
      const dirs = homes.length ? homes : [this.primaryHome];
      this.dbs = dirs.map((home) => new ZcodeDb(home, { ignorePids: () => this.ownPids() }));
    }
  }

  enable(launchable = true): void {
    this.enabled = true;
    this.launchable = this.launchable || launchable;
  }

  hasManagedSession(id: string): boolean {
    return this.sessions.has(id);
  }

  private ownPids(): ReadonlySet<number> {
    const pids = new Set<number>();
    for (const proc of this.processes) if (proc.pid) pids.add(proc.pid);
    return pids;
  }

  private async resolveLaunch(): Promise<ZcodeLaunchSpec | null> {
    if (this.launchSpec) return this.launchSpec;
    const spec = this.options.resolveLaunch
      ? await this.options.resolveLaunch()
      : await resolveZcodeLaunch({
          platform: this.options.platform,
          env: this.options.env,
          homedir: this.options.homedir,
          resolveCli: this.options.resolveCli,
        });
    if (spec) this.launchSpec = spec;
    return spec;
  }

  /** Probes whether ZCode is installed (launchable). If only a leftover database
   * exists, enables read-only history scanning without advertising ZCode as a
   * startable engine. */
  async probe(): Promise<{ available: boolean; version: string | null }> {
    const spec = await this.resolveLaunch();
    if (spec) {
      this.enable(true);
      return { available: true, version: spec.version };
    }
    for (const db of this.dbs) {
      if (await db.exists()) {
        this.enable(false);
        break;
      }
    }
    return { available: false, version: null };
  }

  async scan(): Promise<void> {
    if (!this.enabled || this.disposed) return;
    this.scans ??= (async () => {
      const next = new Map<string, { home: string; row: ZcodeSessionRow }>();
      const ignorePids = this.ownPids();
      for (const db of this.dbs) {
        for (const row of db.scan({ ignorePids })) {
          const prev = next.get(row.id);
          if (!prev || row.timeUpdated > prev.row.timeUpdated) {
            next.set(row.id, { home: db.home, row });
          }
        }
      }
      this.native = next;
    })().finally(() => {
      this.scans = undefined;
    });
    await this.scans;
  }

  rows(): LocalSession[] {
    if (!this.enabled) return [];
    const rows = new Map<string, LocalSession>();
    const host = this.options.host;

    for (const [id, { home, row }] of this.native) {
      const meta = row.model ? this.modelMeta.get(row.model) : undefined;
      const context = row.context
        ? { used: row.context.used, ...(row.context.window ?? meta?.contextWindow ? { window: row.context.window ?? meta?.contextWindow } : {}) }
        : undefined;
      const local: LocalSession = {
        engine: "zcode",
        nativeId: id,
        configDir: home,
        cwd: row.directory || home,
        title: row.title,
        state: row.running ? "running" : "stopped",
        ...(row.running ? { liveIn: "desktop" as const } : {}),
        ...(row.archived && !row.running ? { archived: true } : {}),
        ...(row.parentId && isCliNativeId(row.parentId) ? { forkOf: row.parentId } : {}),
        lastActivityAt: row.timeUpdated,
        transcript: "",
        ...(row.version ? { cliVersion: row.version } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(context ? { context } : {}),
      };
      if (row.running && host) {
        local.sendVia = "host";
        local.route = { via: "host", home, sessionId: id };
      }
      rows.set(id, local);
    }

    for (const [id, session] of this.sessions) {
      const existing = rows.get(id);
      const waiting = [...this.requests.values()].some((request) => request.session === session);
      const model = session.model ?? existing?.model;
      const meta = model ? this.modelMeta.get(model) : undefined;
      const rawContext = session.context ?? existing?.context;
      const context = rawContext
        ? { used: rawContext.used, ...(rawContext.window ?? meta?.contextWindow ? { window: rawContext.window ?? meta?.contextWindow } : {}) }
        : undefined;
      rows.set(id, {
        engine: "zcode",
        nativeId: id,
        configDir: session.configDir || existing?.configDir || this.primaryHome,
        cwd: session.cwd,
        title: session.title || existing?.title || path.basename(session.cwd),
        state: waiting ? "waiting" : session.active ? "running" : "idle",
        sendVia: "host",
        liveIn: "background",
        transcript: "",
        lastActivityAt: Math.max(session.at, existing?.lastActivityAt ?? 0),
        ...(existing?.cliVersion ? { cliVersion: existing.cliVersion } : {}),
        ...(model ? { model } : {}),
        ...(context ? { context } : {}),
      });
    }

    return [...rows.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, MAX_SESSIONS);
  }

  hasRequest(id: string): boolean {
    return this.requests.has(id);
  }

  relink(): void {
    for (const { wire } of this.requests.values()) this.options.emit({ type: "cli.request", ...wire });
  }

  async close(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.serverIdle ?? undefined);
    this.serverIdle = null;
    for (const session of this.sessions.values()) {
      clearTimeout(session.idle);
      clearTimeout(session.active?.cancelTimer);
    }
    for (const request of this.requests.values()) this.finishRequest(request, "gone");
    this.sessions.clear();
    for (const db of this.dbs) db.close();
    await Promise.allSettled([...this.processes].map((proc) => proc.close()));
    this.server = null;
  }

  // -------------------------------------------------------------------------
  // Server process management

  private async ensureServer(): Promise<ZcodeAppServer> {
    if (this.disposed) throw new ZcodeError("paused", "本机控制已暂停");
    if (!this.launchable) throw new ZcodeError("cli_missing", "找不到可用的 ZCode，请先在本机安装 ZCode");
    if (this.server && !this.server.isClosed) {
      clearTimeout(this.serverIdle ?? undefined);
      this.serverIdle = null;
      return this.server;
    }
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const spec = await this.resolveLaunch();
      if (!spec) throw new ZcodeError("cli_missing", "找不到可用的 ZCode，请先在本机安装 ZCode");
      if (this.disposed) throw new ZcodeError("paused", "本机控制已暂停");
      const homedir = this.options.homedir ?? os.homedir();
      const spawnCwd = await canonicalCwd(homedir);
      const env: NodeJS.ProcessEnv = { ...this.options.env, ...spec.env };
      if (this.explicitDbPath) {
        env.ZCODE_SESSION_DB_PATH = this.explicitDbPath;
      } else if (this.options.homes?.length && !env.ZCODE_SESSION_DB_PATH) {
        env.ZCODE_SESSION_DB_PATH = resolveZcodeDbPath(this.primaryHome);
      }
      const proc = new ZcodeAppServer(
        { command: spec.command, args: [...spec.argsPrefix, "app-server"], cwd: spawnCwd, env },
        (method, params, rpcId) => this.onRpc(proc, method, params, rpcId),
        () => this.onDisconnected(proc),
      );
      this.processes.add(proc);
      this.server = proc;
      return proc;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onDisconnected(proc: ZcodeAppServer): void {
    if (this.server === proc) this.server = null;
    for (const request of this.requests.values()) this.finishRequest(request, "gone");
    for (const session of this.sessions.values()) {
      session.subscribed = false;
      if (session.active) {
        session.active.error = "ZCode 已断开，当前轮结果未知";
        this.endTurn(session, session.active);
      }
    }
    void Promise.resolve()
      .then(() => proc.close())
      .catch(() => {})
      .finally(() => {
        this.processes.delete(proc);
      });
  }

  private armServerIdle(): void {
    clearTimeout(this.serverIdle ?? undefined);
    this.serverIdle = null;
    if (this.disposed || this.sessions.size > 0 || !this.server) return;
    this.serverIdle = setTimeout(() => {
      if (this.sessions.size === 0 && this.server) {
        const proc = this.server;
        this.server = null;
        void proc.close().catch(() => {});
      }
    }, IDLE_MS);
    this.serverIdle.unref();
  }

  private armSessionIdle(session: Session): void {
    clearTimeout(session.idle);
    if (this.disposed) return;
    session.idle = setTimeout(() => {
      if (session.active) return;
      void this.releaseSession(session).catch(() => {});
    }, IDLE_MS);
    session.idle.unref();
  }

  private async releaseSession(session: Session): Promise<void> {
    clearTimeout(session.idle);
    if (session.active) return;
    const server = this.server;
    this.sessions.delete(session.id);
    if (server && !server.isClosed) {
      await server.request("session/close", { sessionId: session.id }, 5000).catch(() => {});
    }
    this.options.changed();
    this.armServerIdle();
  }

  /** Natively archives or restores a ZCode session in `db.sqlite` and `tasks-index.sqlite`. */
  async archiveSession(id: string, archived: boolean): Promise<void> {
    const managed = this.sessions.get(id);
    if (archived) {
      if (managed?.active) throw new ZcodeError("busy", "会话正在运行，请先停止后再归档");
      if (managed) await this.releaseSession(managed);
    }
    let updated = false;
    for (const db of this.dbs) {
      if (db.setArchived(id, archived)) updated = true;
    }
    if (!updated) throw new ZcodeError("not_found", "找不到 ZCode 会话");
    await this.scan();
    this.options.changed();
  }

  /** Permanently marks a ZCode session deleted in `db.sqlite` and `tasks-index.sqlite`. */
  async deleteSession(id: string): Promise<void> {
    const managed = this.sessions.get(id);
    if (managed?.active) throw new ZcodeError("busy", "会话正在运行，请先停止后再删除");
    if (managed) await this.releaseSession(managed);
    const ignorePids = this.ownPids();
    for (const db of this.dbs) {
      if (db.isRunningExternally(id, ignorePids)) {
        throw new ZcodeError("open_elsewhere", "会话正在 ZCode 中运行，请先关闭后再删除");
      }
    }
    let deleted = false;
    for (const db of this.dbs) {
      if (db.deleteSession(id)) deleted = true;
    }
    if (!deleted) throw new ZcodeError("not_found", "找不到 ZCode 会话");
    await this.scan();
    this.options.changed();
  }

  // -------------------------------------------------------------------------
  // Models & Skills

  async models(): Promise<CliModelCatalog> {
    if (!this.enabled || !this.launchable) return { models: [] };
    const now = Date.now();
    if (this.catalog && this.catalog.until > now) return this.catalog.result;
    const result = this.readModels();
    this.catalog = { until: now + MODEL_TTL, result };
    try {
      return await result;
    } catch (error) {
      if (this.catalog?.result === result) this.catalog = undefined;
      throw error;
    }
  }

  private async readModels(): Promise<CliModelCatalog> {
    const server = await this.ensureServer();
    const workspacePath = await canonicalCwd(this.options.homedir ?? os.homedir());
    const response = await server.request(
      "session/create",
      {
        workspace: { workspacePath, workspaceKey: workspacePath },
        persistence: "deferred",
      },
      12_000,
    );
    const probeId = asZcodeString(asZcodeRecord(response.session).sessionId);
    if (probeId) {
      void server.request("session/close", { sessionId: probeId }, 5000).catch(() => {});
    }
    this.armServerIdle();
    const parsed = parseAvailableModels(asZcodeRecord(response.settings));
    this.modelMeta = parsed.meta;
    return parsed.catalog;
  }

  async skills(cwd: string): Promise<{ skills: SkillOption[] }> {
    if (!this.launchable) return { skills: [] };
    const spec = await this.resolveLaunch();
    if (!spec) return { skills: [] };
    const safeCwd = await canonicalCwd(cwd);
    const env: NodeJS.ProcessEnv = { ...this.options.env, ...spec.env };
    return new Promise((resolve) => {
      execCli(
        spec.command,
        [...spec.argsPrefix, "skills", "list", "--json"],
        { cwd: safeCwd, env, timeout: 6000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve({ skills: [] });
            return;
          }
          try {
            const parsed = asZcodeRecord(JSON.parse(stdout));
            const seen = new Set<string>();
            const list: SkillOption[] = [];
            for (const entry of asZcodeArray(parsed.skills)) {
              const rec = asZcodeRecord(entry);
              const name = asZcodeString(rec.name).trim();
              if (!name || seen.has(name)) continue;
              seen.add(name);
              const description = clipUnits(asZcodeString(rec.description).trim(), 200);
              list.push({ name, description });
              if (list.length >= 200) break;
            }
            resolve({ skills: list });
          } catch {
            resolve({ skills: [] });
          }
        },
      );
    });
  }

  // -------------------------------------------------------------------------
  // Start / Resume / Configure

  private resolveSelection(modelId: string | undefined, effort: string | undefined): {
    selection?: ModelSelection;
    thoughtLevel?: string;
    fullId?: string;
  } {
    if (!modelId) {
      return effort ? { thoughtLevel: effort } : {};
    }
    const meta = this.modelMeta.get(modelId);
    const parsed = meta ? { providerId: meta.providerId, modelId: meta.modelId } : parseModelId(modelId);
    if (!parsed) return effort ? { thoughtLevel: effort } : {};
    let reasoningLevel = effort;
    if (meta?.requiresReasoning) {
      if (!reasoningLevel || !meta.efforts.includes(reasoningLevel)) {
        reasoningLevel = meta.defaultLevel ?? meta.efforts[0];
      }
    }
    return {
      selection: {
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        ...(reasoningLevel ? { reasoningLevel } : {}),
      },
      ...(reasoningLevel ? { thoughtLevel: reasoningLevel } : {}),
      fullId: `${parsed.providerId}/${parsed.modelId}`,
    };
  }

  private absorbSettings(session: Session, settings: ZcodeRecord): void {
    const parsed = parseAvailableModels(settings);
    if (parsed.meta.size > 0) this.modelMeta = parsed.meta;
    const modelSettings = asZcodeRecord(settings.model);
    const currentRef = formatModelRef(asZcodeRecord(modelSettings.current));
    const thoughtLevel = asZcodeString(settings.thoughtLevel).trim() || undefined;
    if (currentRef) {
      session.model = currentRef.id;
      const meta = this.modelMeta.get(currentRef.id);
      const level = thoughtLevel ?? (meta?.requiresReasoning ? meta.defaultLevel : undefined);
      session.modelSelection = {
        providerId: currentRef.providerId,
        modelId: currentRef.modelId,
        ...(level ? { reasoningLevel: level } : {}),
      };
    }
  }

  private toWireModelParam(selection: ModelSelection): ZcodeRecord {
    return {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(selection.reasoningLevel ? { options: { reasoningLevel: selection.reasoningLevel } } : {}),
    };
  }

  async start(cwd: string, settings: CliLaunchOptions): Promise<string> {
    if (!this.enabled || !this.launchable) {
      throw new ZcodeError("cli_missing", "找不到可用的 ZCode，请先在本机安装 ZCode");
    }
    const server = await this.ensureServer();
    const safeCwd = await canonicalCwd(cwd);
    if ((settings.model || settings.effort) && this.modelMeta.size === 0) {
      await this.models().catch(() => {});
    }
    const resolved = this.resolveSelection(settings.model, settings.effort);
    const params: ZcodeRecord = {
      workspace: { workspacePath: safeCwd, workspaceKey: safeCwd },
      mode: toZcodeMode(settings.permissions ?? "full"),
      persistence: "immediate",
    };
    if (resolved.selection) params.model = this.toWireModelParam(resolved.selection);
    if (resolved.thoughtLevel) params.thoughtLevel = resolved.thoughtLevel;

    let response: ZcodeRecord;
    try {
      response = await server.request("session/create", params, 20_000);
    } catch (error) {
      throw operationError(error);
    }
    const sessionObj = asZcodeRecord(response.session);
    const id = asZcodeString(sessionObj.sessionId);
    if (!isCliNativeId(id)) throw new ZcodeError("invalid", "ZCode 返回了无效会话");

    const session: Session = {
      id,
      cwd: safeCwd,
      configDir: this.primaryHome,
      at: Date.now(),
      settings: { ...settings, permissions: settings.permissions ?? "full" },
      title: clipUnits(asZcodeString(sessionObj.title), CLI_LIMITS.title),
      tails: [],
      allowed: new Set(),
      count: 0,
      subscribed: false,
    };
    const responseSettings = asZcodeRecord(response.settings);
    this.absorbSettings(session, responseSettings);
    if (!settings.model && (!session.model || !this.modelMeta.has(session.model))) {
      const available = parseAvailableModels(responseSettings).catalog;
      const fallback = available.current ?? available.models[0]?.id;
      if (fallback) {
        await this.applySettings(server, session, { model: fallback, ...(settings.effort ? { effort: settings.effort } : {}) });
      }
    }
    try {
      await server.request("session/subscribe", { sessionId: id, deliveryKind: "desktop-continuous", includeSnapshot: false }, 10_000);
      session.subscribed = true;
    } catch (error) {
      void server.request("session/close", { sessionId: id }, 5000).catch(() => {});
      throw operationError(error);
    }

    this.sessions.set(id, session);
    this.armSessionIdle(session);
    this.options.changed();
    return id;
  }

  private isOpenElsewhere(id: string): boolean {
    const own = this.ownPids();
    return this.dbs.some((db) => db.isRunningExternally(id, own));
  }

  async resume(row: Pick<LocalSession, "nativeId" | "cwd" | "configDir">, settings: CliLaunchOptions): Promise<void> {
    if (!isCliNativeId(row.nativeId)) throw new ZcodeError("not_found", "找不到 ZCode 会话");
    const known = this.sessions.get(row.nativeId);
    if (known) {
      const server = await this.ensureServer();
      if (!known.subscribed) {
        await this.attachExisting(server, known, settings);
      } else if (Object.keys(settings).length > 0) {
        if (known.active) throw new ZcodeError("busy", "等当前轮结束后再更改 ZCode 设置");
        await this.applySettings(server, known, settings);
      }
      this.armSessionIdle(known);
      this.options.changed();
      return;
    }

    if (this.isOpenElsewhere(row.nativeId)) {
      throw new ZcodeError("open_elsewhere", "请先关闭电脑上打开此会话的 ZCode");
    }
    const server = await this.ensureServer();
    const safeCwd = await canonicalCwd(row.cwd);
    const session: Session = {
      id: row.nativeId,
      cwd: safeCwd,
      configDir: row.configDir || this.primaryHome,
      at: Date.now(),
      settings: { ...settings },
      title: "",
      tails: [],
      allowed: new Set(),
      count: 0,
      subscribed: false,
    };
    await this.attachExisting(server, session, settings);
    this.sessions.set(session.id, session);
    this.armSessionIdle(session);
    this.options.changed();
  }

  private async attachExisting(server: ZcodeAppServer, session: Session, settings: CliLaunchOptions): Promise<void> {
    try {
      const response = await server.request(
        "session/resume",
        {
          sessionId: session.id,
          workspace: { workspacePath: session.cwd, workspaceKey: session.cwd },
          ...(settings.effort ? { thoughtLevel: settings.effort } : {}),
        },
        20_000,
      );
      const sessionObj = asZcodeRecord(response.session);
      session.title = clipUnits(asZcodeString(sessionObj.title), CLI_LIMITS.title) || session.title;
      const responseSettings = asZcodeRecord(response.settings);
      this.absorbSettings(session, responseSettings);

      // If the persisted session used a model unavailable in standalone app-server
      // (e.g. a Desktop-only OAuth account:* model), switch cleanly to the user's
      // requested model or the first available model so sending succeeds.
      const hasRestoreWarning = Boolean(response.restoreWarning);
      const modelUnavailable = !session.model || (this.modelMeta.size > 0 && !this.modelMeta.has(session.model));
      const desired: CliLaunchOptions = { ...settings };
      if (!desired.model && (hasRestoreWarning || modelUnavailable)) {
        const available = parseAvailableModels(responseSettings).catalog;
        const fallback = available.current ?? available.models[0]?.id;
        if (!fallback) throw new ZcodeError("invalid", "ZCode 没有可用的模型，请先在 ZCode 中配置模型");
        desired.model = fallback;
      }
      if (Object.keys(desired).length > 0) {
        await this.applySettings(server, session, desired);
      }
      await server.request(
        "session/subscribe",
        { sessionId: session.id, deliveryKind: "desktop-continuous", includeSnapshot: false },
        10_000,
      );
      session.subscribed = true;
    } catch (error) {
      throw operationError(error);
    }
  }

  private async applySettings(server: ZcodeAppServer, session: Session, settings: CliLaunchOptions): Promise<void> {
    try {
      if (settings.permissions) {
        await server.request("session/setMode", { sessionId: session.id, mode: toZcodeMode(settings.permissions) }, 10_000);
        session.settings.permissions = settings.permissions;
      }
      if (settings.model) {
        if (this.modelMeta.size === 0) await this.models().catch(() => {});
        const resolved = this.resolveSelection(settings.model, settings.effort ?? session.settings.effort);
        if (resolved.selection) {
          const result = await server.request(
            "session/setModel",
            { sessionId: session.id, model: this.toWireModelParam(resolved.selection) },
            10_000,
          );
          if (result.settings) this.absorbSettings(session, asZcodeRecord(result.settings));
          session.model = resolved.fullId ?? settings.model;
          session.modelSelection = resolved.selection;
          session.settings.model = settings.model;
          if (resolved.thoughtLevel) {
            await server.request("session/setThoughtLevel", { sessionId: session.id, thoughtLevel: resolved.thoughtLevel }, 10_000).catch(() => {});
            session.settings.effort = resolved.thoughtLevel;
          }
        }
      } else if (settings.effort) {
        const result = await server.request(
          "session/setThoughtLevel",
          { sessionId: session.id, thoughtLevel: settings.effort },
          10_000,
        );
        if (result.settings) this.absorbSettings(session, asZcodeRecord(result.settings));
        session.settings.effort = settings.effort;
        if (session.modelSelection) {
          session.modelSelection = { ...session.modelSelection, reasoningLevel: settings.effort };
        }
      }
    } catch (error) {
      throw operationError(error);
    }
  }

  // -------------------------------------------------------------------------
  // Send / Steer / Interrupt / Answer

  private async uploadV4Attachments(
    server: ZcodeAppServer,
    session: Session,
    attachments: readonly ZcodeAttachment[],
  ): Promise<V4AttachmentRef[]> {
    const refs: V4AttachmentRef[] = [];
    for (const item of attachments) {
      const uploadId = `upl_${randomUUID().replace(/-/g, "")}`;
      const totalBytes = item.bytes.byteLength;
      const totalChunks = totalBytes === 0 ? 0 : Math.ceil(totalBytes / V4_ATTACHMENT_CHUNK_BYTES);
      const checksum = `sha256:${createHash("sha256").update(item.bytes).digest("hex")}`;
      try {
        await server.request(
          "v4/attachment/begin",
          {
            workspace: { workspacePath: session.cwd, workspaceKey: session.cwd },
            connectionId: this.connectionId,
            uploadId,
            sessionId: session.id,
            fileName: item.filename,
            mime: item.mimeType,
            totalBytes,
            totalChunks,
            checksum,
          },
          10_000,
        );
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
          const slice = item.bytes.subarray(
            chunkIndex * V4_ATTACHMENT_CHUNK_BYTES,
            (chunkIndex + 1) * V4_ATTACHMENT_CHUNK_BYTES,
          );
          await server.request(
            "v4/attachment/chunk",
            {
              connectionId: this.connectionId,
              uploadId,
              sessionId: session.id,
              chunkIndex,
              dataBase64: slice.toString("base64"),
            },
            10_000,
          );
        }
        const committed = await server.request(
          "v4/attachment/commit",
          {
            connectionId: this.connectionId,
            uploadId,
            sessionId: session.id,
          },
          10_000,
        );
        const ref = asZcodeString(committed.ref);
        if (!ref) throw new ZcodeError("invalid", "ZCode 未返回附件引用");
        refs.push({ ref, fileName: item.filename, mime: item.mimeType, bytes: totalBytes });
      } catch (error) {
        void server
          .request("v4/attachment/abort", { connectionId: this.connectionId, uploadId, sessionId: session.id }, 5000)
          .catch(() => {});
        throw error instanceof ZcodeError ? error : new ZcodeError("invalid", "ZCode 引导消息附件上传失败");
      }
    }
    return refs;
  }

  async send(id: string, text: string, steer = false): Promise<{ turn: number; started: boolean; accepted?: boolean }> {
    const session = this.sessions.get(id);
    if (!session) throw new ZcodeError("stopped", "请先继续此 ZCode 会话");
    let turn = session.active;
    if (steer && (!turn || turn.stopping)) throw new ZcodeError("turn_changed", "目标轮次已经结束");
    if (!steer && turn) throw new ZcodeError("busy", "当前轮次还在运行");

    const server = await this.ensureServer();
    if (!session.subscribed) {
      if (!steer && this.isOpenElsewhere(id)) throw new ZcodeError("open_elsewhere", "请先关闭电脑上打开此会话的 ZCode");
      await this.attachExisting(server, session, session.settings);
    }

    const meta = session.model ? this.modelMeta.get(session.model) : undefined;
    const content = await promptAttachments(text, this.options.origin(), meta?.supportsImage !== false);
    if (steer && session.active !== turn) throw new ZcodeError("turn_changed", "目标轮次已经结束");

    const v4Attachments =
      steer && content.attachments.length > 0 ? await this.uploadV4Attachments(server, session, content.attachments) : [];
    if (steer && session.active !== turn) throw new ZcodeError("turn_changed", "目标轮次已经结束");

    clearTimeout(session.idle);
    if (!turn) {
      if (session.active) throw new ZcodeError("busy", "当前轮次还在运行");
      turn = { startedAt: Date.now(), stopping: false, completed: false, version: 0, items: [], calls: new Map() };
      session.active = turn;
      session.tails.push(turn);
      if (session.tails.length > MAX_RECENT_TURNS) session.tails.shift();
      session.count += 1;
    }

    const active = turn;
    const turnNumber = session.count;
    const ts = Date.now();
    session.title ||= clipUnits(content.text.trim().split("\n", 1)[0] ?? "", CLI_LIMITS.title);
    session.at = ts;
    active.lastText = undefined;
    const optimistic = buildUserItem({ id: randomUUID(), ts, text: content.text });
    active.items.push(optimistic);
    active.version += 1;

    const modelSelection = session.modelSelection ? this.toWireModelParam(session.modelSelection) : undefined;
    try {
      if (steer) {
        const ack = await server.request(
          "v4/command",
          {
            workspace: { workspacePath: session.cwd, workspaceKey: session.cwd },
            commandId: randomUUID(),
            clientId: "nexagent",
            sessionId: id,
            type: "sendText",
            payload: {
              text: content.text,
              ...(v4Attachments.length ? { attachments: v4Attachments } : {}),
              requestedDelivery: "guide",
              ...(modelSelection ? { modelSelection } : {}),
            },
            issuedAt: ts,
          },
          15_000,
        );
        const status = asZcodeString(ack.status);
        if (status !== "accepted") {
          const idx = active.items.indexOf(optimistic);
          if (idx >= 0) {
            active.items.splice(idx, 1);
            active.version += 1;
          }
          const reasonCode = asZcodeString(ack.reasonCode);
          if (status === "stale" || /turn|idle|ended|completed/i.test(reasonCode)) {
            throw new ZcodeError("turn_changed", "目标轮次已经结束");
          }
          throw new ZcodeError("invalid", safeError(asZcodeString(ack.message) || reasonCode || "ZCode 拒绝了引导消息"));
        }
        const ackResult = asZcodeRecord(ack.result);
        const delivery = asZcodeString(ackResult.delivery) || asZcodeString(asZcodeRecord(ackResult.input).delivery);
        this.options.changed();
        return { turn: turnNumber, started: delivery === "startNow", accepted: true };
      } else {
        const sendAttachments = content.attachments.map(({ kind, filename, mimeType, dataBase64, sizeBytes }) => ({
          kind,
          filename,
          mimeType,
          dataBase64,
          sizeBytes,
        }));
        await server.request(
          "session/send",
          {
            sessionId: id,
            content: content.text,
            ...(sendAttachments.length ? { attachments: sendAttachments } : {}),
            ...(modelSelection ? { modelSelection } : {}),
          },
          15_000,
        );
      }
    } catch (error) {
      if (!steer && session.active === active) {
        active.error = safeError(error);
        this.endTurn(session, active);
      } else if (steer) {
        const idx = active.items.indexOf(optimistic);
        if (idx >= 0) {
          active.items.splice(idx, 1);
          active.version += 1;
        }
      }
      throw operationError(error);
    }

    this.options.changed();
    return { turn: turnNumber, started: true };
  }

  async interrupt(id: string): Promise<{ outcome: string }> {
    const session = this.sessions.get(id);
    const turn = session?.active;
    if (!session || !turn || !this.server || this.server.isClosed) {
      throw new ZcodeError("turn_changed", "目标轮次已经结束");
    }
    turn.stopping = true;
    for (const request of this.requests.values()) {
      if (request.session === session) this.finishRequest(request, "gone", request.cancel);
    }
    try {
      await this.server.request("session/stop", { sessionId: id }, 8000);
    } catch {
      throw new ZcodeError("unknown", "ZCode 停止结果未知");
    }
    if (session.active === turn && !turn.cancelTimer) {
      turn.cancelTimer = setTimeout(() => {
        if (session.active === turn) this.endTurn(session, turn);
      }, CANCEL_GRACE_MS);
      turn.cancelTimer.unref();
    }
    return { outcome: "sent" };
  }

  async answer(args: CliOpArgs["answer"]): Promise<{ outcome: string }> {
    const request = this.requests.get(args.id);
    if (!request) throw new ZcodeError("not_found", "此请求已关闭");
    const result = request.answer(args);
    this.finishRequest(request, "nexbot");
    const outcomes = await Promise.allSettled(request.replies.map((reply) => reply(result)));
    if (!outcomes.some((outcome) => outcome.status === "fulfilled")) {
      throw new ZcodeError("unknown", "ZCode 未确认答复");
    }
    return { outcome: "delivered" };
  }

  private endTurn(session: Session, turn: Turn): void {
    if (session.active !== turn) return;
    clearTimeout(turn.cancelTimer);
    for (const request of this.requests.values()) {
      if (request.session === session) this.finishRequest(request, "gone");
    }
    if (turn.error) {
      turn.items.push(buildNoticeItem({ id: randomUUID(), ts: Date.now(), level: "error", text: turn.error }));
    }
    for (const tool of turn.calls.values()) {
      if (tool.status === "running") tool.status = turn.stopping || turn.error ? "error" : "ok";
    }
    turn.version += 1;
    turn.completed = true;
    session.active = undefined;
    session.at = Date.now();
    this.armSessionIdle(session);
    this.options.changed();
    this.options.ended(session.id, session.count, turn.stopping ? "interrupted" : turn.error ? "error" : "end", turn.error);
  }

  // -------------------------------------------------------------------------
  // Server -> Client RPC & Event Handling

  private onRpc(proc: ZcodeAppServer, method: string, params: ZcodeRecord, rpcId: ZcodeRpcId | undefined): void {
    if (this.disposed) {
      if (rpcId !== undefined) void proc.refuse(rpcId, -32601).catch(() => {});
      return;
    }
    if (method === "session/event" && rpcId === undefined) {
      this.onSessionEvent(params);
      return;
    }
    if (rpcId === undefined) return;

    if (method === "session/readReplyLanguage") {
      void proc.respond(rpcId, { language: null }).catch(() => {});
      return;
    }
    const sessionId = asZcodeString(params.sessionId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const reply = (result: unknown) => proc.respond(rpcId, result);

    if (method === "interaction/requestPermission" && session) {
      this.onPermissionRequest(session, params, reply);
      return;
    }
    if (method === "interaction/requestUserInput" && session) {
      this.onUserInputRequest(session, params, reply);
      return;
    }
    // Reply immediately to unsupported host-only RPCs (e.g. runtime preferences / official MCP auth)
    // so ZCode falls back without hitting its 15 s request timeout.
    void proc.refuse(rpcId, -32601).catch(() => {});
  }

  private onSessionEvent(params: ZcodeRecord): void {
    const sessionId = asZcodeString(params.sessionId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return;
    const type = asZcodeString(params.type);
    const payload = asZcodeRecord(params.payload);

    if (type === "session.titleUpdated") {
      const title = clipUnits(asZcodeString(payload.title), CLI_LIMITS.title);
      if (title) {
        session.title = title;
        this.options.changed();
      }
      return;
    }

    const turn = session.active;
    if (!turn) return;

    if (type === "model.streaming") {
      const kind = asZcodeString(payload.kind);
      const delta = asZcodeString(payload.delta);
      if (!delta) return;
      if (kind === "text_delta" || kind === "reasoning_delta") {
        const itemKind = kind === "text_delta" ? "assistant" : "thinking";
        const previous = turn.lastText;
        if (previous?.kind === itemKind) {
          appendItemText(previous, delta);
        } else {
          const next: NonNullable<Turn["lastText"]> =
            itemKind === "thinking"
              ? buildThinkingItem({ id: randomUUID(), ts: Date.now(), text: delta })
              : buildAssistantItem({ id: randomUUID(), ts: Date.now(), text: delta });
          turn.lastText = next;
          turn.items.push(next);
        }
        this.trimTail(turn);
        turn.version += 1;
      }
      return;
    }

    if (type === "tool.updated") {
      const kind = asZcodeString(payload.kind);
      const callId = asZcodeString(payload.toolCallId);
      if (!callId || kind === "batch") return;
      turn.lastText = undefined;
      let item = turn.calls.get(callId);
      if (!item) {
        item = buildToolItem({
          id: randomUUID(),
          ts: Date.now(),
          name: asZcodeString(payload.toolName) || "ZCode",
          input: payload.input,
          status: "running",
        });
        turn.calls.set(callId, item);
        turn.items.push(item);
      }
      if (kind === "scheduled") {
        updateToolItem(item, {
          name: asZcodeString(payload.toolName) || undefined,
          rawInput: payload.input,
        });
      } else if (kind === "result") {
        updateToolItem(item, {
          name: asZcodeString(payload.toolName) || undefined,
          status: "ok",
          rawOutput: payload.result,
        });
      } else if (kind === "error") {
        const errObj = asZcodeRecord(payload.error);
        updateToolItem(item, {
          name: asZcodeString(payload.toolName) || undefined,
          status: "error",
          rawOutput: asZcodeString(errObj.message) || payload.error,
        });
      } else if (kind === "progress") {
        const preview = asZcodeString(payload.stdoutTail) || asZcodeString(payload.stderrTail);
        if (preview) updateToolItem(item, { rawOutput: preview });
      }
      this.trimTail(turn);
      turn.version += 1;
      return;
    }

    if (type === "turn.completed") {
      const usage = asZcodeRecord(payload.usage);
      const total = Number(usage.total ?? usage.totalTokens ?? payload.tokenCount);
      if (Number.isFinite(total) && total > 0) {
        const window = session.model ? this.modelMeta.get(session.model)?.contextWindow : undefined;
        session.context = { used: Math.trunc(total), ...(window ? { window } : {}) };
      }
      const response = asZcodeString(payload.response).trim();
      const hasAssistant = turn.items.some((item) => item.kind === "assistant");
      if (response && !hasAssistant) {
        turn.items.push(buildAssistantItem({ id: randomUUID(), ts: Date.now(), text: response }));
      }
      this.endTurn(session, turn);
      return;
    }

    if (type === "turn.failed") {
      const errObj = asZcodeRecord(payload.error);
      const message = asZcodeString(errObj.message) || asZcodeString(payload.message);
      if (!turn.stopping) {
        if (/abort|cancel|interrupt/i.test(message)) turn.stopping = true;
        else turn.error = safeError(message || "ZCode 执行失败");
      }
      this.endTurn(session, turn);
    }
  }

  private trimTail(turn: Turn): void {
    if (turn.items.length > MAX_TAIL) {
      const removed = turn.items.splice(1, 1)[0];
      for (const [id, item] of turn.calls) if (item === removed) turn.calls.delete(id);
    }
  }

  private onPermissionRequest(session: Session, params: ZcodeRecord, reply: (result: unknown) => Promise<void>): void {
    const deny = { decision: "deny", reason: "Cancelled" };
    if (session.active?.stopping) {
      void reply(deny).catch(() => {});
      return;
    }
    const toolName = asZcodeString(params.toolName) || "ZCode";
    const reason = asZcodeString(params.reason);
    let input = "";
    let key = "";
    try {
      input = params.input === undefined ? "" : JSON.stringify(params.input);
      key = `${toolName}\0${createHash("sha256").update(input).digest("hex")}`;
    } catch {
      input = "";
      key = "";
    }
    if (session.settings.permissions === "full" || (key && session.allowed.has(key))) {
      void reply({ decision: "allow" }).catch(() => {});
      return;
    }
    const nativeRequestId = asZcodeString(params.requestId).trim() || undefined;
    this.openRequest(
      session,
      {
        kind: "permission",
        tool: clipUnits(toolName, CLI_LIMITS.requestTool),
        summary: truncateUtf8(reason || toolName, SUMMARY_MAX),
        ...(input ? { detail: clipUnits(input, CLI_LIMITS.requestDetail) } : {}),
        ...(key ? { always: true } : {}),
      },
      reply,
      deny,
      (args) => {
        if (args.decision === "allow") {
          if (args.always && key && session.allowed.size < 128) session.allowed.add(key);
          return { decision: "allow" };
        }
        return { decision: "deny", ...(args.message ? { reason: args.message } : {}) };
      },
      nativeRequestId,
    );
  }

  private onUserInputRequest(session: Session, params: ZcodeRecord, reply: (result: unknown) => Promise<void>): void {
    const cancel = { action: "cancel" };
    if (session.active?.stopping) {
      void reply(cancel).catch(() => {});
      return;
    }
    const toolName = asZcodeString(params.toolName) || "ZCode";
    const prompt = asZcodeString(params.prompt);
    const schema = asZcodeRecord(params.schema);
    const isPlanApproval = asZcodeString(schema.interaction) === "plan_approval";
    const rawQuestions = asZcodeArray(params.questions);
    const questions: CliRequestQuestion[] = [];
    const valueMaps = new Map<string, Map<string, string>>();
    for (const raw of rawQuestions) {
      const q = asZcodeRecord(raw);
      const text = clipUnits(asZcodeString(q.question).trim(), CLI_LIMITS.requestQuestion);
      if (!text) continue;
      const header = clipUnits(asZcodeString(q.header).trim(), CLI_LIMITS.requestOption);
      const map = new Map<string, string>();
      const opts = asZcodeArray(q.options)
        .map((entry) => {
          if (typeof entry === "string") {
            const label = clipUnits(entry, CLI_LIMITS.requestOption);
            if (label) map.set(label, entry);
            return { label };
          }
          const o = asZcodeRecord(entry);
          const rawLabel = asZcodeString(o.label ?? o.value).trim();
          const label = clipUnits(rawLabel, CLI_LIMITS.requestOption);
          if (!label) return null;
          const rawValue = asZcodeString(o.value).trim() || rawLabel;
          map.set(label, rawValue);
          const description = clipUnits(asZcodeString(o.description).trim(), CLI_LIMITS.requestDescription);
          return { label, ...(description ? { description } : {}) };
        })
        .filter((opt): opt is { label: string; description?: string } => opt !== null && opt.label.length > 0)
        .slice(0, CLI_LIMITS.requestOptions);
      valueMaps.set(text, map);
      questions.push({
        question: text,
        ...(header ? { header } : {}),
        options: opts,
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
      });
      if (questions.length >= CLI_LIMITS.requestQuestions) break;
    }

    const structured = questions.length > 0;
    if (!structured) {
      const choices = asZcodeArray(params.choices)
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        .slice(0, CLI_LIMITS.requestOptions)
        .map((label) => ({ label: clipUnits(label.trim(), CLI_LIMITS.requestOption) }));
      const label = clipUnits(prompt || "ZCode 需要你的确认", CLI_LIMITS.requestQuestion);
      questions.push({ question: label, options: choices.length ? choices : [{ label: "确认" }, { label: "取消" }] });
    }

    const mapChoice = (questionText: string, answer: string): string => {
      const map = valueMaps.get(questionText);
      if (!map || !map.size) return answer;
      const direct = map.get(answer);
      if (direct !== undefined) return direct;
      return answer
        .split(/,\s*/)
        .map((part) => map.get(part) ?? part)
        .join(", ");
    };

    const nativeRequestId = asZcodeString(params.requestId).trim() || undefined;
    this.openRequest(
      session,
      {
        kind: "question",
        tool: clipUnits(toolName, CLI_LIMITS.requestTool),
        summary: truncateUtf8(prompt || questions[0]?.question || "ZCode 提问", SUMMARY_MAX),
        questions,
      },
      reply,
      cancel,
      (args) => {
        if (args.decision !== "allow") {
          return { action: "decline", ...(args.message ? { reason: args.message } : {}) };
        }
        const mappedAnswers: Record<string, string> = {};
        for (const [questionText, value] of Object.entries(args.answers ?? {})) {
          mappedAnswers[questionText] = mapChoice(questionText, value);
        }
        const firstMapped = Object.values(mappedAnswers)[0] ?? args.message ?? "";
        if (isPlanApproval) {
          return { action: "accept", content: { answers: mappedAnswers, answer: firstMapped } };
        }
        if (structured) {
          return { action: "accept", content: { answers: mappedAnswers } };
        }
        return { action: "accept", content: { answer: firstMapped } };
      },
      nativeRequestId,
    );
  }

  private openRequest(
    session: Session,
    fields: Omit<CliRequestWire, "id" | "ref" | "expiresAt">,
    reply: (result: unknown) => Promise<void>,
    cancel: unknown,
    answer: Request["answer"],
    nativeRequestId?: string,
  ): void {
    const nativeKey = nativeRequestId ? `${session.id}\0${nativeRequestId}` : undefined;
    if (nativeKey) {
      const existing = [...this.requests.values()].find((req) => req.nativeKey === nativeKey);
      if (existing) {
        existing.replies.push(reply);
        existing.wire.expiresAt = Date.now() + REQUEST_MS;
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => this.finishRequest(existing, "timeout", existing.cancel), REQUEST_MS);
        existing.timer.unref();
        return;
      }
    }
    const wire: CliRequestWire = {
      ...fields,
      id: randomUUID(),
      ref: cliRef("zcode", session.id),
      expiresAt: Date.now() + REQUEST_MS,
    };
    if (!session.active || this.requests.size >= CLI_LIMITS.requestsPerSession || !parseDeviceCliMessage({ type: "cli.request", ...wire })) {
      void reply(cancel).catch(() => {});
      return;
    }
    const timer = setTimeout(() => this.finishRequest(request, "timeout", cancel), REQUEST_MS);
    timer.unref();
    const request: Request = { wire, nativeKey, timer, session, cancel, replies: [reply], answer };
    this.requests.set(wire.id, request);
    this.options.changed();
    this.options.emit({ type: "cli.request", ...wire });
  }

  private finishRequest(request: Request, resolvedBy: CliRequestResolvedBy, respond?: unknown): void {
    if (!this.requests.delete(request.wire.id)) return;
    clearTimeout(request.timer);
    if (respond !== undefined) {
      for (const reply of request.replies) void reply(respond).catch(() => {});
    }
    this.options.emit({ type: "cli.request.resolved", id: request.wire.id, by: resolvedBy });
    this.options.changed();
  }

  // -------------------------------------------------------------------------
  // PageableChat implementation (SQLite history + live streaming tails)

  private dbFor(id: string): ZcodeDb {
    const knownHome = this.sessions.get(id)?.configDir ?? this.native.get(id)?.home;
    return this.dbs.find((db) => db.home === knownHome) ?? this.dbs[0]!;
  }

  async marker(id: string): Promise<string> {
    const dbMarker = await this.dbFor(id).marker(id);
    const tail = this.sessions.get(id)?.tails ?? [];
    return `${dbMarker}|${tail.map((turn) => `${turn.startedAt}:${turn.version}`).join(",")}`;
  }

  imageSource(id: string, itemId: string, locator: string): TranscriptImage | undefined {
    return this.dbFor(id).imageSource(id, itemId, locator);
  }

  async page(id: string, options: { before?: string; limit?: number } = {}, limit = options.limit ?? PAGE_SIZE): Promise<ReaderPage> {
    const db = this.dbFor(id);
    const session = this.sessions.get(id);
    const tails = session?.tails;
    if (!tails?.length) return db.page(id, { ...options, limit });

    const persisted = await db.page(id, { limit: HISTORY_LOOKBACK });
    let items = persisted.items;
    const settled = new Set<Turn>();

    for (const turn of tails) {
      const sent = turn.items[0];
      if (!sent || sent.kind !== "user") continue;
      // Match the persisted user message from the end so repeated phrases match the newest turn.
      let at = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        const candidate = items[i]!;
        if (candidate.kind === "user" && candidate.text.trim() === sent.text.trim() && candidate.ts >= turn.startedAt - 10_000) {
          at = i;
          break;
        }
      }
      const lastReply = turn.items.findLast((item) => item.kind === "assistant");
      const tailSlice = at >= 0 ? items.slice(at + 1) : [];
      const exported =
        at >= 0 &&
        turn.completed &&
        !turn.error &&
        !turn.stopping &&
        (lastReply?.kind === "assistant"
          ? tailSlice.some((item) => item.kind === "assistant" && item.text.trim() === lastReply.text.trim())
          : turn.items.length === 1 || tailSlice.some((item) => item.kind === "assistant"));
      if (exported) {
        settled.add(turn);
        continue;
      }
      if (at >= 0) {
        items = [...items.slice(0, at), ...turn.items];
      } else {
        items = [...items, ...turn.items];
      }
    }

    if (session && settled.size) {
      session.tails = session.tails.filter((turn) => !settled.has(turn));
    }

    const at = options.before === undefined ? items.length : items.findIndex((item) => item.id === options.before);
    if (at < 0) return db.page(id, { ...options, limit });
    const slice = items.slice(Math.max(0, at - limit), at);
    if (slice.length < limit && persisted.more && persisted.items.length) {
      const prefix = await db.page(id, { before: persisted.items[0]!.id, limit: limit - slice.length });
      return { items: [...prefix.items, ...slice], more: prefix.more };
    }
    return { items: slice, more: at > limit || persisted.more };
  }
}
