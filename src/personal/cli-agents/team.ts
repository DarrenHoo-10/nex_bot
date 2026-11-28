// Multi-agent collaboration ("协作") view models, strict parsers, transcript card
// extraction and lead/worker lookup indexes. Re-exports shared wire types/parsers
// from `shared/cli-team` so Core and Web UI stay strictly in sync.
import {
  isCliEngine,
  isCliKey,
  type CliEngine,
  type CliSessionKey,
  type CliSessionView,
} from "../../../shared/cli-agents";
import {
  DEFAULT_TEAM_SETTINGS,
  TEAM_DISPATCH_MODE_LABEL,
  TEAM_FINDING_SEVERITY_LABEL,
  TEAM_RUN_STATUS_LABEL,
  TEAM_WORKER_STATUS_LABEL,
  isRunLive,
  isWorkerLive,
  isWorkerWorking,
  parseTeamRun,
  parseTeamRuns,
  parseTeamSettings,
  parseTeamWorker,
  type CliTeamDispatchMode,
  type CliTeamFinding,
  type CliTeamRunStatus,
  type CliTeamRunView,
  type CliTeamSettings,
  type CliTeamWorkerStatus,
  type CliTeamWorkerView,
} from "../../../shared/cli-team";

export {
  DEFAULT_TEAM_SETTINGS,
  TEAM_DISPATCH_MODE_LABEL,
  TEAM_FINDING_SEVERITY_LABEL,
  TEAM_RUN_STATUS_LABEL,
  TEAM_WORKER_STATUS_LABEL,
  isRunLive,
  isWorkerLive,
  isWorkerWorking,
  parseTeamRun,
  parseTeamRuns,
  parseTeamSettings,
  parseTeamWorker,
  type CliTeamDispatchMode,
  type CliTeamFinding,
  type CliTeamRunStatus,
  type CliTeamRunView,
  type CliTeamSettings,
  type CliTeamWorkerStatus,
  type CliTeamWorkerView,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// ---------------------------------------------------------------------------
// Indexes for SessionList & SessionPane

export interface TeamWorkerBinding {
  run: CliTeamRunView;
  worker: CliTeamWorkerView;
  /** True when the worker belongs to the lead's current active/paused run. */
  isActiveRun: boolean;
  /** True when the worker should stay expanded directly under its lead (current run,
   * or the sole/latest finished run when no new run has started yet). */
  inPrimaryGroup: boolean;
}

export interface TeamIndex {
  runs: readonly CliTeamRunView[];
  /** Runs per lead, live run first, then historical newest first. */
  runsByLead: ReadonlyMap<CliSessionKey, CliTeamRunView[]>;
  /** Currently active or paused run for a lead, if any. */
  activeRunByLead: ReadonlyMap<CliSessionKey, CliTeamRunView>;
  /** Direct lookup by worker session key. */
  workerBySession: ReadonlyMap<CliSessionKey, TeamWorkerBinding>;
  /** All known worker session keys belonging to a lead (across active and historical runs). */
  workerKeysByLead: ReadonlyMap<CliSessionKey, CliSessionKey[]>;
}

export function indexTeams(runs: readonly CliTeamRunView[]): TeamIndex {
  const runsByLead = new Map<CliSessionKey, CliTeamRunView[]>();
  const activeRunByLead = new Map<CliSessionKey, CliTeamRunView>();
  const workerBySession = new Map<CliSessionKey, TeamWorkerBinding>();
  const workerKeysByLead = new Map<CliSessionKey, CliSessionKey[]>();

  for (const run of runs) {
    const list = runsByLead.get(run.leadKey) ?? [];
    list.push(run);
    runsByLead.set(run.leadKey, list);
  }

  for (const [leadKey, list] of runsByLead) {
    list.sort((a, b) => Number(isRunLive(b.status)) - Number(isRunLive(a.status)) || (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt) || b.createdAt - a.createdAt);
    const active = list.find((run) => isRunLive(run.status));
    if (active) activeRunByLead.set(leadKey, active);
    const primaryRunId = active?.id ?? list[0]?.id;
    const keys: CliSessionKey[] = [];
    for (const run of list) {
      for (const worker of run.workers) {
        if (!worker.sessionKey) continue;
        keys.push(worker.sessionKey);
        workerBySession.set(worker.sessionKey, {
          run,
          worker,
          isActiveRun: run.id === active?.id,
          inPrimaryGroup: run.id === primaryRunId,
        });
      }
    }
    workerKeysByLead.set(leadKey, keys);
  }

  return { runs, runsByLead, activeRunByLead, workerBySession, workerKeysByLead };
}

/** Counts workers of a lead's active run that are currently working (not waiting on user). */
export function activeWorkingWorkers(
  run: CliTeamRunView | undefined,
  sessionsByKey: ReadonlyMap<CliSessionKey, CliSessionView>,
  pending?: ReadonlyMap<string, number>,
): { working: number; waiting: number } {
  if (!run || !isRunLive(run.status)) return { working: 0, waiting: 0 };
  let working = 0;
  let waiting = 0;
  for (const worker of run.workers) {
    const session = worker.sessionKey ? sessionsByKey.get(worker.sessionKey) : undefined;
    const hasPending = worker.sessionKey ? (pending?.get(worker.sessionKey) ?? 0) > 0 : false;
    if (hasPending || worker.status === "waiting" || (session?.online && session.state === "waiting")) {
      waiting++;
    } else if (isWorkerWorking(worker.status) || (session?.online && session.state === "running")) {
      working++;
    }
  }
  return { working, waiting };
}

// ---------------------------------------------------------------------------
// Collaboration message cards in transcript

export type CliTeamCardKind =
  | "task"
  | "report"
  | "review"
  | "followup"
  | "question"
  | "answer"
  | "nudge"
  | "escalation"
  | "done";

export interface CliTeamCard {
  kind: CliTeamCardKind;
  heading: string;
  subtitle?: string;
  actorEngine?: CliEngine;
  actorLabel?: string;
  targetEngine?: CliEngine;
  targetLabel?: string;
  targetSessionKey?: CliSessionKey;
  sourceSessionKey?: CliSessionKey;
  role?: string;
  outcome?: "succeeded" | "failed";
  body?: string;
  files?: string[];
  findings?: CliTeamFinding[];
}

const CARD_KINDS: readonly CliTeamCardKind[] = [
  "task", "report", "review", "followup", "question", "answer", "nudge", "escalation", "done",
];

const CARD_ENVELOPE_RE = /^\s*<!--\s*nexagent-team:([\s\S]*?)-->\s*([\s\S]*)$/;
const PLAIN_TEAM_HEAD_RE = /^\[NexAgent team\]\s+From\s+([^\s·]+)\s+·\s+([^\s·]+)\s+·\s+([^\n]+)(?:\n+([\s\S]*))?$/;
const PLAIN_NUDGE_RE = /^\[NexAgent\]\s+(Your turn ended without a report\.[\s\S]*)$/;
const PLAIN_ASSIGN_RE = /^\[NexAgent\]\s+The lead assigned you a task\.[\s\S]*$/;
const PLAIN_INBOX_RE = /^\[NexAgent\]\s+You have (\d+) new team messages?\.[\s\S]*$/;

export function parseTeamCard(text: string): CliTeamCard | null {
  const envelope = CARD_ENVELOPE_RE.exec(text);
  if (envelope) {
    try {
      const meta = asRecord(JSON.parse(envelope[1]!.trim()));
      const body = envelope[2]?.trim() || (typeof meta?.body === "string" ? meta.body.trim() : undefined);
      if (meta && typeof meta.kind === "string" && (CARD_KINDS as readonly string[]).includes(meta.kind) && typeof meta.heading === "string") {
        const findings: CliTeamFinding[] | undefined = Array.isArray(meta.findings)
          ? meta.findings
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry.file === "string" && typeof entry.issue === "string")
            .map((entry) => ({
              severity: typeof entry.severity === "string" ? entry.severity : "medium",
              file: String(entry.file),
              ...(typeof entry.line === "number" ? { line: entry.line } : {}),
              issue: String(entry.issue),
            }))
          : undefined;
        const files = Array.isArray(meta.files) ? meta.files.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) : undefined;
        return {
          kind: meta.kind as CliTeamCardKind,
          heading: meta.heading,
          ...(typeof meta.subtitle === "string" && meta.subtitle.trim() ? { subtitle: meta.subtitle.trim() } : {}),
          ...(isCliEngine(meta.actorEngine) ? { actorEngine: meta.actorEngine } : {}),
          ...(typeof meta.actorLabel === "string" ? { actorLabel: meta.actorLabel } : {}),
          ...(isCliEngine(meta.targetEngine) ? { targetEngine: meta.targetEngine } : {}),
          ...(typeof meta.targetLabel === "string" ? { targetLabel: meta.targetLabel } : {}),
          ...(typeof meta.targetSessionKey === "string" && isCliKey(meta.targetSessionKey) ? { targetSessionKey: meta.targetSessionKey } : {}),
          ...(typeof meta.sourceSessionKey === "string" && isCliKey(meta.sourceSessionKey) ? { sourceSessionKey: meta.sourceSessionKey } : {}),
          ...(typeof meta.role === "string" ? { role: meta.role } : {}),
          ...(meta.outcome === "succeeded" || meta.outcome === "failed" ? { outcome: meta.outcome } : {}),
          ...(body ? { body } : {}),
          ...(files?.length ? { files } : {}),
          ...(findings?.length ? { findings } : {}),
        };
      }
    } catch {
      // fall through to plain-text matchers
    }
  }

  const trimmed = text.trim();
  const plain = PLAIN_TEAM_HEAD_RE.exec(trimmed);
  if (plain) {
    const [, sender, rawType, subject, body] = plain;
    const type = rawType!.toLowerCase();
    const kind: CliTeamCardKind =
      type === "report" ? "report"
        : type === "task" ? "task"
          : type === "question" ? "question"
            : type === "answer" ? "answer"
              : type === "escalation" ? "escalation"
                : type === "message" ? "followup" : "report";
    const typeLabel: Record<CliTeamCardKind, string> = {
      task: "任务派发",
      report: "完成报告",
      review: "审查结果",
      followup: "修改要求",
      question: "提问",
      answer: "答复",
      nudge: "催促汇报",
      escalation: "异常升级",
      done: "交付摘要",
    };
    return {
      kind,
      heading: `${sender} · ${typeLabel[kind]}`,
      subtitle: subject?.trim(),
      actorLabel: sender,
      body: body?.trim() || undefined,
    };
  }

  const nudge = PLAIN_NUDGE_RE.exec(trimmed);
  if (nudge) {
    return {
      kind: "nudge",
      heading: "系统催促",
      subtitle: "本轮结束但尚未汇报",
      body: nudge[1],
    };
  }

  if (PLAIN_ASSIGN_RE.test(trimmed)) {
    return {
      kind: "task",
      heading: "主会话 · 已派发任务",
      subtitle: "通过 nex task 读取任务说明",
    };
  }

  const inbox = PLAIN_INBOX_RE.exec(trimmed);
  if (inbox) {
    return {
      kind: "nudge",
      heading: `协作通知 · ${inbox[1]} 条新消息`,
      subtitle: "通过 nex inbox 读取",
    };
  }

  return null;
}
