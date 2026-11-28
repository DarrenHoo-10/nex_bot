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
  "models",
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

/** Subset pushed to online device executors so lead prompts, ask-mode allowlists,
 * and active lead edit-guards reflect Core state without querying Core on every hook call. */
export interface CliTeamDeviceConfig {
  dispatchMode: CliTeamDispatchMode;
  allowNexInAsk: boolean;
  /** Lead session refs currently owning an active or paused collaboration run on this device. */
  activeLeadRefs?: CliSessionRef[];
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
  p0: "P0",
  p1: "P1",
  p2: "P2",
  p3: "P3",
  critical: "P0",
  high: "高",
  medium: "中",
  low: "低",
};

export interface CliTeamFindingCount {
  severity: string;
  label: string;
  count: number;
}

export function isRunLive(status: CliTeamRunStatus): boolean {
  return status === "active" || status === "paused";
}

export function isWorkerLive(status: CliTeamWorkerStatus): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

export function isWorkerWorking(status: CliTeamWorkerStatus): boolean {
  return status === "starting" || status === "running";
}

/** Failed collaborators are hidden from UI lists/panels while kept in the ledger for auditing. */
export function isWorkerVisible(worker: Pick<CliTeamWorkerView, "status">): boolean {
  return worker.status !== "failed";
}

export function visibleTeamWorkers<T extends Pick<CliTeamWorkerView, "status">>(workers: readonly T[]): T[] {
  return workers.filter(isWorkerVisible);
}

// ---------------------------------------------------------------------------
// Concise report/review briefing extraction (shared by Core & Web UI)

const TEAM_HEADER_LINE_RE = /^\s*\[NexAgent team\]\s+From\s+[^\n]+(?:\r?\n)*/;
const TEAM_FOOTER_LINE_RE = /(?:\r?\n)+(?:如需跟进请运行|如果修改请运行|主控提示（|答复方式：|完成后请(?:再次)?运行|全部完成后运行)[^\n]*\s*$/;
const REVIEW_STOP_HEADING_RE = /^(?:#{1,6}\s*|\*\*)?(?:验证范围|测试范围|测试情况|测试结果|复现环境|环境说明|验证记录|检查范围|详细过程|详细日志|verification(?:\s+scope)?|test(?:ing)?(?:\s+scope|\s+plan)?|environment)\b/i;
const REPORT_STOP_HEADING_RE = /^(?:#{1,6}\s*|\*\*)?(?:验证范围|详细日志|完整输出|修改细节|verification(?:\s+scope)?|detailed\s+logs?|raw\s+output)\b/i;
const FINDING_LINE_RE = /^\s*(?:\d+[.)、]|[-*•])\s*(?:\*\*)?(?:\[(P[0-3]|critical|high|medium|low|阻塞|严重|高|中|低)\]|(P[0-3]|critical|high|medium|low)(?=(?:\*\*)?[\s:：\-–—）)\u4e00-\u9fff])|(阻塞|严重|高|中|低)(?=优先级|(?:\*\*)?[\s:：\-–—）)]))/i;
const CONCLUSION_LINE_RE = /^(?:\*\*)?(?:交付结论|审查结论|复审结论|总体结论|结论|摘要|简报|总结|summary|verdict|conclusion)\s*[:：]\s*(.+)$/i;

const SEVERITY_ORDER: Record<string, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
  high: 4,
  medium: 5,
  low: 6,
};

export function normalizeFindingSeverity(raw: string): { severity: string; label: string } {
  const clean = raw.trim().toLowerCase();
  if (clean === "p0" || clean === "critical" || clean === "blocker" || clean === "阻塞") return { severity: "p0", label: "P0" };
  if (clean === "p1" || clean === "严重") return { severity: "p1", label: "P1" };
  if (clean === "p2") return { severity: "p2", label: "P2" };
  if (clean === "p3") return { severity: "p3", label: "P3" };
  if (clean === "high" || clean === "高") return { severity: "high", label: "高" };
  if (clean === "medium" || clean === "中") return { severity: "medium", label: "中" };
  if (clean === "low" || clean === "低") return { severity: "low", label: "低" };
  return { severity: clean || "medium", label: TEAM_FINDING_SEVERITY_LABEL[clean] ?? raw.trim().toUpperCase() };
}

/** Strips machine-directed `[NexAgent team] From ...` headers and command hint footers. */
export function stripTeamMessageFraming(text: string): string {
  let out = text.trim();
  out = out.replace(TEAM_HEADER_LINE_RE, "");
  // Strip one or more trailing command-hint lines added for the receiving LLM.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(TEAM_FOOTER_LINE_RE, "");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

function stripMarkdownLine(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function clipBriefText(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Counts review issues grouped by normalized severity from structured findings or bulleted text. */
export function summarizeFindingCounts(
  findings?: readonly CliTeamFinding[],
  fallbackText?: string,
): CliTeamFindingCount[] {
  const counts = new Map<string, CliTeamFindingCount>();
  const add = (rawSeverity: string) => {
    const { severity, label } = normalizeFindingSeverity(rawSeverity);
    const entry = counts.get(severity);
    if (entry) entry.count += 1;
    else counts.set(severity, { severity, label, count: 1 });
  };

  if (findings?.length) {
    for (const finding of findings) add(finding.severity || "medium");
  } else if (fallbackText) {
    const cleaned = stripTeamMessageFraming(fallbackText);
    let inCode = false;
    for (const line of cleaned.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        inCode = !inCode;
        continue;
      }
      if (inCode) continue;
      if (REVIEW_STOP_HEADING_RE.test(trimmed)) break;
      const match = FINDING_LINE_RE.exec(line);
      const severity = match?.[1] ?? match?.[2] ?? match?.[3];
      if (severity) add(severity);
    }
  }

  return [...counts.values()].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99) || a.label.localeCompare(b.label),
  );
}

export function formatFindingCountsSummary(counts: readonly CliTeamFindingCount[]): string {
  if (!counts.length) return "未发现问题";
  const parts = counts.map((entry) => {
    const isP = /^P\d$/i.test(entry.label);
    return isP ? `${entry.count} 个 ${entry.label}` : `${entry.count} 个${entry.label}优先级`;
  });
  return `发现 ${parts.join("、")}问题`;
}

/** Builds a short user-facing briefing ("简报") for collaborator reports and reviews. */
export function buildTeamReportBrief(input: {
  brief?: string;
  body?: string;
  findings?: readonly CliTeamFinding[];
  isReview?: boolean;
  outcome?: "succeeded" | "failed";
}): { brief: string; findingCounts: CliTeamFindingCount[] } {
  const cleanedBody = input.body ? stripTeamMessageFraming(input.body) : "";
  const findingCounts = summarizeFindingCounts(input.findings, input.isReview ? cleanedBody : undefined);

  const explicit = input.brief ? stripTeamMessageFraming(input.brief) : "";
  if (explicit) {
    const lines = explicit
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4);
    return {
      brief: clipBriefText(lines.join("\n"), 320),
      findingCounts,
    };
  }

  const rawLines = cleanedBody.split(/\r?\n/);
  const contentLines: string[] = [];
  let inCode = false;
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !trimmed) continue;
    if (input.isReview ? REVIEW_STOP_HEADING_RE.test(trimmed) : REPORT_STOP_HEADING_RE.test(trimmed)) break;
    contentLines.push(trimmed);
  }

  if (input.isReview) {
    // Prefer an explicit verdict/conclusion line; otherwise first concise non-heading sentence.
    for (const line of contentLines) {
      const clean = stripMarkdownLine(line);
      const match = CONCLUSION_LINE_RE.exec(clean);
      if (match?.[1]) {
        return { brief: clipBriefText(match[1].trim(), 160), findingCounts };
      }
    }
    const prose = contentLines.find((line) => !/^#{1,6}\s/.test(line) && !FINDING_LINE_RE.test(line));
    if (prose) {
      const clean = stripMarkdownLine(prose);
      // Skip bare title-only first lines when a better next line exists.
      const nextProse = contentLines.find((line) => line !== prose && !/^#{1,6}\s/.test(line) && !FINDING_LINE_RE.test(line));
      const chosen = clean.length <= 24 && !/[。！？.!?]/.test(clean) && nextProse ? stripMarkdownLine(nextProse) : clean;
      if (chosen) return { brief: clipBriefText(chosen, 160), findingCounts };
    }
    if (findingCounts.length) {
      return { brief: `${formatFindingCountsSummary(findingCounts)}，详情可点进会话查看。`, findingCounts };
    }
    const fallback = contentLines[0] ? stripMarkdownLine(contentLines[0]) : "";
    return {
      brief: clipBriefText(fallback || (input.outcome === "failed" ? "审查未能完成" : "审查完成，未发现阻塞问题。"), 160),
      findingCounts,
    };
  }

  // Implementer / general collaborator report: keep concise summary + up to 3 short bullet points.
  const picked: string[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i]!;
    const isHeading = /^#{1,6}\s/.test(line);
    const clean = stripMarkdownLine(line);
    if (!clean) continue;
    if (isHeading && i === 0 && contentLines.length > 1) continue;
    if (isHeading) {
      if (picked.length > 0) break;
      continue;
    }
    const isBullet = /^\s*(?:[-*•]|\d+[.)、])\s+/.test(line);
    if (isBullet) {
      const bulletBody = stripMarkdownLine(line.replace(/^\s*(?:[-*•]|\d+[.)、])\s+/, ""));
      if (!bulletBody) continue;
      // Keep only the first concise sentence of each bullet to avoid essays.
      const firstSentence = bulletBody.split(/(?<=[。！？；])\s*|(?<=[.!?])\s+/)[0] ?? bulletBody;
      picked.push(`- ${clipBriefText(firstSentence, 90)}`);
    } else {
      const match = CONCLUSION_LINE_RE.exec(clean);
      const sentence = match?.[1]?.trim() || clean;
      picked.push(clipBriefText(sentence, 140));
    }
    if (picked.length >= 3) break;
  }

  return {
    brief: clipBriefText(picked.join("\n") || (input.outcome === "failed" ? "任务执行失败" : "任务已完成。"), 280),
    findingCounts,
  };
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
  const activeLeadRefs = Array.isArray(row.activeLeadRefs)
    ? [...new Set(row.activeLeadRefs.slice(0, 100).filter(isRef))]
    : undefined;
  return {
    dispatchMode: row.dispatchMode as CliTeamDispatchMode,
    allowNexInAsk: row.allowNexInAsk,
    ...(activeLeadRefs !== undefined ? { activeLeadRefs } : {}),
  };
}
