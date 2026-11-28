// Shared contract for NexAgent multi-agent collaboration ("协作", code name `team`).
// Pure TypeScript with no Node or DOM APIs so Core, device executor, and Web UI share
// the same types, strict wire parsers, and pure-`nex` command validator.
import type { CliContextUsage, CliEngine, CliPermissionMode, CliSessionKey, CliSessionRef } from "./cli-agents.ts";

export type CliTeamRunStatus = "active" | "paused" | "finished" | "cancelled";
export type CliTeamWorkerStatus = "starting" | "running" | "waiting" | "reported" | "stopped" | "failed";
export type CliTeamDispatchMode = "prompt" | "auto" | "off";

export const CLI_TEAM_RUN_STATUSES: readonly CliTeamRunStatus[] = ["active", "paused", "finished", "cancelled"];
export const CLI_TEAM_WORKER_STATUSES: readonly CliTeamWorkerStatus[] = ["starting", "running", "waiting", "reported", "stopped", "failed"];
export const CLI_TEAM_DISPATCH_MODES: readonly CliTeamDispatchMode[] = ["prompt", "auto", "off"];

export const CLI_TEAM_COMMANDS = [
  "agents",
  "start",
  "status",
  "inbox",
  "send",
  "reply",
  "read",
  "stop",
  "done",
  "guide",
  "task",
  "ask",
  "report",
  "escalate",
  "note",
] as const;
export type CliTeamCommand = (typeof CLI_TEAM_COMMANDS)[number];

export interface CliTeamFinding {
  severity: "high" | "medium" | "low" | string;
  file: string;
  line?: number;
  issue: string;
}

export interface CliTeamWorkerView {
  id: string;
  runId: string;
  name: string;
  engine: CliEngine;
  sessionKey: CliSessionKey | null;
  cwd: string;
  role?: string;
  title: string;
  permissions: CliPermissionMode;
  model?: string;
  status: CliTeamWorkerStatus;
  summary?: string;
  findingsCount?: number;
  unreadCount?: number;
  context?: CliContextUsage;
  createdAt: number;
  updatedAt: number;
}

export interface CliTeamRunView {
  id: string;
  leadKey: CliSessionKey;
  title: string;
  status: CliTeamRunStatus;
  limit: number;
  limitHit?: string;
  heldCount?: number;
  summary?: string;
  workers: CliTeamWorkerView[];
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface CliTeamSettings {
  dispatchMode: CliTeamDispatchMode;
  maxWorkers: number;
  allowNexInAsk: boolean;
  enabledEngines: CliEngine[];
  installedEngines: CliEngine[];
  defaultPermissions: Partial<Record<CliEngine, CliPermissionMode | "default">>;
  limits: {
    mailPerHour: number;
    idlePauseHours: number;
    circuitBreakerFailures: number;
  };
}

/** Subset pushed to online device executors so lead prompts and ask-mode allowlists
 * reflect user preferences without querying Core on every hook call. */
export interface CliTeamDeviceConfig {
  dispatchMode: CliTeamDispatchMode;
  allowNexInAsk: boolean;
}

/** Metadata sent with `cli.op start` when Core launches a team worker. */
export interface CliTeamStartMeta {
  runId: string;
  workerName: string;
  role?: string;
  title?: string;
  leadRef?: CliSessionRef;
}

export const DEFAULT_TEAM_SETTINGS: CliTeamSettings = {
  dispatchMode: "prompt",
  maxWorkers: 5,
  allowNexInAsk: true,
  enabledEngines: ["claude", "codex", "agy"],
  installedEngines: ["claude", "codex", "agy"],
  defaultPermissions: { claude: "default", codex: "default", agy: "default" },
  limits: {
    mailPerHour: 60,
    idlePauseHours: 24,
    circuitBreakerFailures: 3,
  },
};

export const DEFAULT_TEAM_DEVICE_CONFIG: CliTeamDeviceConfig = {
  dispatchMode: DEFAULT_TEAM_SETTINGS.dispatchMode,
  allowNexInAsk: DEFAULT_TEAM_SETTINGS.allowNexInAsk,
};

export const TEAM_RUN_STATUS_LABEL: Record<CliTeamRunStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  finished: "已完成",
  cancelled: "已结束",
};

export const TEAM_WORKER_STATUS_LABEL: Record<CliTeamWorkerStatus, string> = {
  starting: "启动中",
  running: "工作中",
  waiting: "等你处理",
  reported: "已汇报",
  stopped: "已停止",
  failed: "失败",
};

export const TEAM_DISPATCH_MODE_LABEL: Record<CliTeamDispatchMode, string> = {
  prompt: "用户提出时",
  auto: "Agent 可自行派活",
  off: "关闭",
};

export const TEAM_FINDING_SEVERITY_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export function isRunLive(status: CliTeamRunStatus): boolean {
  return status === "active" || status === "paused";
}

export function isWorkerLive(status: CliTeamWorkerStatus): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

export function isWorkerWorking(status: CliTeamWorkerStatus): boolean {
  return status === "starting" || status === "running";
}

export function isCliTeamCommand(value: unknown): value is CliTeamCommand {
  return typeof value === "string" && (CLI_TEAM_COMMANDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Strict pure-`nex` command validator (design section 10, phase 0 verified)

// Disallow shell chaining, pipes, redirection, subexpressions `(…)`, variable
// expansion (`$`, `%`, `!`), cmd/PowerShell escape chars (`^`, `` ` ``), newlines,
// NULs, and Unicode line separators or curly quotes anywhere in auto-approved text.
const SHELL_META_RE = /[\r\n\0;&|<>`()$%^!\u0085\u2028\u2029\u2018-\u201f]/;
const ESCAPED_QUOTE_RE = /\\['"]/;
const PURE_NEX_BIN_RE = /^(?:nex|nex\.cmd|nex\.exe)$/i;

export interface ParsedPureNexCommand {
  bin: string;
  subcommand: string | null;
  tokens: string[];
  fileArgs: string[];
}

/** Parses a strictly standalone `nex <subcommand> [args...]` invocation with
 * balanced quotes and zero shell/PowerShell/cmd.exe metacharacters, or null. */
export function parsePureNexCommand(command: unknown): ParsedPureNexCommand | null {
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  if (SHELL_META_RE.test(trimmed) || ESCAPED_QUOTE_RE.test(trimmed)) return null;

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  if (current) tokens.push(current);
  if (tokens.length === 0) return null;

  const bin = tokens[0]!;
  if (!PURE_NEX_BIN_RE.test(bin)) return null;
  if (tokens.length === 1) return { bin, subcommand: null, tokens, fileArgs: [] };
  const sub = tokens[1]!;
  if (sub !== "--help" && sub !== "-h" && !isCliTeamCommand(sub)) return null;

  const fileArgs: string[] = [];
  for (let i = 2; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--file" || tok === "--findings") {
      const value = tokens[++i];
      if (!value) return null;
      fileArgs.push(value);
    } else if (tok.startsWith("--file=")) {
      const value = tok.slice("--file=".length);
      if (!value) return null;
      fileArgs.push(value);
    } else if (tok.startsWith("--findings=")) {
      const value = tok.slice("--findings=".length);
      if (!value) return null;
      fileArgs.push(value);
    }
  }
  return { bin, subcommand: sub, tokens, fileArgs };
}

/** Returns true ONLY for a single standalone `nex <subcommand> [args...]` invocation
 * with balanced quotes and zero shell metacharacters. Never approves chained commands. */
export function isPureNexCommand(command: unknown): boolean {
  return parsePureNexCommand(command) !== null;
}

// ---------------------------------------------------------------------------
// Wire parsers (no runtime import from cli-agents.ts to avoid circular deps)

const ENGINES: readonly CliEngine[] = ["claude", "codex", "zcode", "agy"];
const PERMISSION_MODES: readonly CliPermissionMode[] = ["full", "ask", "edits", "plan", "auto", "readonly"];
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NATIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,199}$/;
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isEngine(value: unknown): value is CliEngine {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value);
}

function isKey(value: unknown): value is CliSessionKey {
  if (typeof value !== "string") return false;
  const first = value.indexOf(":");
  if (first < 1) return false;
  const second = value.indexOf(":", first + 1);
  if (second <= first + 1) return false;
  const deviceId = value.slice(0, first);
  const engine = value.slice(first + 1, second);
  const nativeId = value.slice(second + 1);
  return DEVICE_ID_RE.test(deviceId) && isEngine(engine) && NATIVE_ID_RE.test(nativeId);
}

function isRef(value: unknown): value is CliSessionRef {
  if (typeof value !== "string") return false;
  const colon = value.indexOf(":");
  if (colon < 1) return false;
  const engine = value.slice(0, colon);
  const nativeId = value.slice(colon + 1);
  return isEngine(engine) && NATIVE_ID_RE.test(nativeId);
}

function parseContext(value: unknown): CliContextUsage | undefined {
  const row = asRecord(value);
  if (!row || typeof row.used !== "number" || !Number.isFinite(row.used) || row.used <= 0) return undefined;
  const window = typeof row.window === "number" && Number.isFinite(row.window) && row.window > 0 ? row.window : undefined;
  return { used: row.used, ...(window ? { window } : {}) };
}

export function parseTeamWorker(value: unknown): CliTeamWorkerView | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || typeof row.runId !== "string" || typeof row.name !== "string" || !isEngine(row.engine)) {
    return null;
  }
  const status = typeof row.status === "string" && (CLI_TEAM_WORKER_STATUSES as readonly string[]).includes(row.status)
    ? row.status as CliTeamWorkerStatus
    : "stopped";
  const permissions = typeof row.permissions === "string" && (PERMISSION_MODES as readonly string[]).includes(row.permissions)
    ? row.permissions as CliPermissionMode
    : "full";
  const context = parseContext(row.context);
  return {
    id: row.id.slice(0, 128),
    runId: row.runId.slice(0, 128),
    name: row.name.slice(0, 64),
    engine: row.engine,
    sessionKey: isKey(row.sessionKey) ? row.sessionKey : null,
    cwd: typeof row.cwd === "string" ? row.cwd.slice(0, 4096) : "",
    ...(typeof row.role === "string" && row.role.trim() ? { role: row.role.trim().slice(0, 40) } : {}),
    title: typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 200) : row.name.slice(0, 64),
    permissions,
    ...(typeof row.model === "string" && row.model.trim() ? { model: row.model.trim().slice(0, 200) } : {}),
    status,
    ...(typeof row.summary === "string" && row.summary.trim() ? { summary: row.summary.trim().slice(0, 2000) } : {}),
    ...(typeof row.findingsCount === "number" && Number.isFinite(row.findingsCount) && row.findingsCount >= 0 ? { findingsCount: Math.round(row.findingsCount) } : {}),
    ...(typeof row.unreadCount === "number" && Number.isFinite(row.unreadCount) && row.unreadCount >= 0 ? { unreadCount: Math.round(row.unreadCount) } : {}),
    ...(context ? { context } : {}),
    createdAt: typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
  };
}

export function parseTeamRun(value: unknown): CliTeamRunView | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !isKey(row.leadKey)) return null;
  const status = typeof row.status === "string" && (CLI_TEAM_RUN_STATUSES as readonly string[]).includes(row.status)
    ? row.status as CliTeamRunStatus
    : "finished";
  const workers = Array.isArray(row.workers)
    ? row.workers.slice(0, 100).map(parseTeamWorker).filter((entry): entry is CliTeamWorkerView => entry !== null)
    : [];
  return {
    id: row.id.slice(0, 128),
    leadKey: row.leadKey,
    title: typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 200) : "协作",
    status,
    limit: typeof row.limit === "number" && Number.isFinite(row.limit) && row.limit >= 1 ? Math.min(20, Math.round(row.limit)) : 5,
    ...(typeof row.limitHit === "string" && row.limitHit.trim() ? { limitHit: row.limitHit.trim().slice(0, 300) } : {}),
    ...(typeof row.heldCount === "number" && Number.isFinite(row.heldCount) && row.heldCount > 0 ? { heldCount: Math.round(row.heldCount) } : {}),
    ...(typeof row.summary === "string" && row.summary.trim() ? { summary: row.summary.trim().slice(0, 4000) } : {}),
    workers,
    createdAt: typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    ...(typeof row.finishedAt === "number" && Number.isFinite(row.finishedAt) ? { finishedAt: row.finishedAt } : {}),
  };
}

export function parseTeamRuns(value: unknown): CliTeamRunView[] {
  return Array.isArray(value) ? value.slice(0, 500).map(parseTeamRun).filter((entry): entry is CliTeamRunView => entry !== null) : [];
}

export function parseTeamSettings(value: unknown): CliTeamSettings {
  const row = asRecord(value);
  if (!row) return { ...DEFAULT_TEAM_SETTINGS, defaultPermissions: { ...DEFAULT_TEAM_SETTINGS.defaultPermissions }, limits: { ...DEFAULT_TEAM_SETTINGS.limits } };
  const dispatchMode = typeof row.dispatchMode === "string" && (CLI_TEAM_DISPATCH_MODES as readonly string[]).includes(row.dispatchMode)
    ? row.dispatchMode as CliTeamDispatchMode
    : DEFAULT_TEAM_SETTINGS.dispatchMode;
  const maxWorkers = typeof row.maxWorkers === "number" && Number.isFinite(row.maxWorkers)
    ? Math.max(1, Math.min(10, Math.round(row.maxWorkers)))
    : DEFAULT_TEAM_SETTINGS.maxWorkers;
  const allowNexInAsk = typeof row.allowNexInAsk === "boolean"
    ? row.allowNexInAsk
    : typeof row.allowNexagentInAsk === "boolean"
      ? row.allowNexagentInAsk
      : DEFAULT_TEAM_SETTINGS.allowNexInAsk;
  const parseEngineList = (input: unknown, fallback: CliEngine[]) =>
    Array.isArray(input) ? [...new Set(input.filter((item): item is CliEngine => isEngine(item)))] : [...fallback];
  const installedEngines = parseEngineList(row.installedEngines, DEFAULT_TEAM_SETTINGS.installedEngines);
  const enabledEngines = parseEngineList(row.enabledEngines, installedEngines);
  const permsInput = asRecord(row.defaultPermissions);
  const defaultPermissions: Partial<Record<CliEngine, CliPermissionMode | "default">> = {};
  for (const engine of ENGINES) {
    const raw = permsInput?.[engine];
    if (raw === "default" || (typeof raw === "string" && (PERMISSION_MODES as readonly string[]).includes(raw))) {
      defaultPermissions[engine] = raw as CliPermissionMode | "default";
    }
  }
  const limitsRow = asRecord(row.limits);
  return {
    dispatchMode,
    maxWorkers,
    allowNexInAsk,
    enabledEngines,
    installedEngines,
    defaultPermissions,
    limits: {
      mailPerHour: typeof limitsRow?.mailPerHour === "number" && Number.isFinite(limitsRow.mailPerHour) ? Math.max(1, Math.round(limitsRow.mailPerHour)) : DEFAULT_TEAM_SETTINGS.limits.mailPerHour,
      idlePauseHours: typeof limitsRow?.idlePauseHours === "number" && Number.isFinite(limitsRow.idlePauseHours) ? Math.max(1, Math.round(limitsRow.idlePauseHours)) : DEFAULT_TEAM_SETTINGS.limits.idlePauseHours,
      circuitBreakerFailures: typeof limitsRow?.circuitBreakerFailures === "number" && Number.isFinite(limitsRow.circuitBreakerFailures) ? Math.max(1, Math.round(limitsRow.circuitBreakerFailures)) : DEFAULT_TEAM_SETTINGS.limits.circuitBreakerFailures,
    },
  };
}

export function parseTeamStartMeta(value: unknown): CliTeamStartMeta | null {
  const row = asRecord(value);
  if (!row || typeof row.runId !== "string" || !RUN_ID_RE.test(row.runId)) return null;
  if (typeof row.workerName !== "string" || !WORKER_NAME_RE.test(row.workerName)) return null;
  const role = typeof row.role === "string" && row.role.trim() ? row.role.trim().slice(0, 40) : undefined;
  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 200) : undefined;
  const leadRef = row.leadRef !== undefined ? (isRef(row.leadRef) ? row.leadRef : null) : undefined;
  if (leadRef === null) return null;
  return {
    runId: row.runId,
    workerName: row.workerName,
    ...(role ? { role } : {}),
    ...(title ? { title } : {}),
    ...(leadRef ? { leadRef } : {}),
  };
}

export function parseTeamDeviceConfig(value: unknown): CliTeamDeviceConfig | null {
  const row = asRecord(value);
  if (!row) return null;
  if (typeof row.dispatchMode !== "string" || !(CLI_TEAM_DISPATCH_MODES as readonly string[]).includes(row.dispatchMode)) return null;
  if (typeof row.allowNexInAsk !== "boolean") return null;
  return {
    dispatchMode: row.dispatchMode as CliTeamDispatchMode,
    allowNexInAsk: row.allowNexInAsk,
  };
}
