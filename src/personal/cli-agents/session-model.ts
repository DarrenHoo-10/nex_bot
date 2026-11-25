// Pure helpers over the session rows Core sends: grouping, labels and what the
// composer may do. No React, no network.
import { CLI_ENGINES, unwrapPastedContent, type CliDeviceView, type CliEngine, type CliSessionKey, type CliSessionView } from "../../../shared/cli-agents";

export const ENGINE_LABEL: Record<CliEngine, string> = { claude: "Claude", codex: "Codex", zcode: "ZCode", agy: "Antigravity" };
/** The agent names the session list groups by. */
export const AGENT_LABEL: Record<CliEngine, string> = { claude: "Claude Code", codex: "Codex", zcode: "ZCode", agy: "Antigravity CLI" };

export function sessionStatusLabel(session: Pick<CliSessionView, "state" | "online">): string {
  if (!session.online) return "电脑离线";
  switch (session.state) {
    case "running": return "运行中";
    case "waiting": return "等你处理";
    case "idle": return "空闲";
    default: return "已停止";
  }
}

/** The tone a status chip uses; offline wins over the session's own state. */
export function sessionTone(session: Pick<CliSessionView, "state" | "online">): "offline" | "running" | "waiting" | "idle" | "stopped" {
  return session.online ? session.state : "offline";
}

export function folderLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || cwd || "未知目录";
}

/** The name of the linked worktree a cwd sits in, for the worktrees Claude
 * Code and NexAgent create; null for anything else (usually the main tree). */
export function worktreeName(cwd: string): string | null {
  const match = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/i.exec(cwd) ?? /[\\/]\.nexbot-worktrees[\\/][^\\/]+[\\/]([^\\/]+)/i.exec(cwd);
  return match ? match[1] : null;
}

/** A path without the Windows long-path prefix (`\\?\D:\x` -> `D:\x`, `\\?\UNC\h\s` -> `\\h\s`). */
export function stripLongPath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

/** The form paths are compared in: no long-path prefix, one separator, no trailing slash, lower case. */
export function normalizePath(path: string): string {
  return stripLongPath(path).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

/** Paths compare equal across `\\?\` prefixes, separators, case and a trailing slash. */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** The repository root a linked-worktree cwd belongs to (`<root>\.claude\worktrees\<name>`,
 * `<parent>\.nexbot-worktrees\<repo>\<name>`); any other cwd is its own root. The long-path prefix is dropped. */
export function worktreeRoot(cwd: string): string {
  const clean = stripLongPath(cwd).replace(/[\\/]+$/, "");
  const sep = clean.includes("\\") ? "\\" : "/";
  const claude = /^(.*?)[\\/]\.claude[\\/]worktrees(?:[\\/]|$)/i.exec(clean);
  if (claude) return claude[1] || sep;
  const nexbot = /^(.*?)[\\/]\.nexbot-worktrees[\\/]([^\\/]+)(?:[\\/]|$)/i.exec(clean);
  if (nexbot) return `${nexbot[1]}${sep}${nexbot[2]}`;
  return clean || cwd;
}

/** A throwaway Codex chat folder: `…\Documents\Codex\<yyyy-mm-dd>\<anything>`. */
export function isScratchCwd(cwd: string): boolean {
  return /\/documents\/codex\/\d{4}-\d{2}-\d{2}(?:\/|$)/.test(normalizePath(cwd));
}

export const SCRATCH_LABEL = "未关联项目";
const SCRATCH_KEY = "\u0000scratch";

export interface ProjectRef {
  /** what sessions group by: the normalized root, or one shared key for scratch chats */
  key: string;
  /** the root path in its original casing; empty for the scratch group */
  root: string;
  label: string;
  scratch: boolean;
}

/** The project a session belongs to. `root` overrides the derived root (the review fixture names one). */
export function projectOf(session: CliSessionView, root?: string): ProjectRef {
  // `repoRoot` is absent on devices that predate it
  const explicit = root || session.repoRoot?.trim();
  if (!explicit && isScratchCwd(session.cwd)) return { key: SCRATCH_KEY, root: "", label: SCRATCH_LABEL, scratch: true };
  const path = stripLongPath(explicit || worktreeRoot(session.cwd)).replace(/[\\/]+$/, "") || session.cwd;
  return { key: normalizePath(path), root: path, label: folderLabel(path), scratch: false };
}

export interface ProjectGroup<T = CliSessionView> extends ProjectRef { rows: T[]; latest: number }

/** Rows grouped by project: real projects by latest activity, the scratch group last. */
export function projectGroups(rows: readonly CliSessionView[], rootOf?: (row: CliSessionView) => string | undefined): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const row of rows) {
    const ref = projectOf(row, rootOf?.(row));
    let group = groups.get(ref.key);
    if (!group) groups.set(ref.key, (group = { ...ref, rows: [], latest: 0 }));
    // label and path casing follow the newest session
    if (row.lastActivityAt >= group.latest && group.rows.length) Object.assign(group, ref);
    group.rows.push(row);
    group.latest = Math.max(group.latest, row.lastActivityAt);
  }
  return [...groups.values()].sort((a, b) => Number(a.scratch) - Number(b.scratch) || b.latest - a.latest || a.label.localeCompare(b.label));
}

/** Projects in the user's order: projects not in `saved` yet are new and go first (newest activity
 * first), the rest keep their saved order, and the scratch group stays last. */
export function orderProjects<T extends ProjectRef & { latest: number }>(groups: readonly T[], saved: readonly string[]): T[] {
  const at = new Map(saved.map((key, index) => [key, index]));
  const fresh = groups.filter((group) => !group.scratch && !at.has(group.key)).sort((a, b) => b.latest - a.latest);
  const known = groups.filter((group) => !group.scratch && at.has(group.key)).sort((a, b) => at.get(a.key)! - at.get(b.key)!);
  return [...fresh, ...known, ...groups.filter((group) => group.scratch)];
}

/** The saved order after `groups` were shown: new projects go in front, nothing known moves. */
export function rememberProjects(groups: readonly (ProjectRef & { latest: number })[], saved: readonly string[], max = 300): string[] {
  const known = new Set(saved);
  const fresh = orderProjects(groups, saved).filter((group) => !group.scratch && !known.has(group.key)).map((group) => group.key);
  return fresh.length ? [...fresh, ...saved].slice(0, max) : [...saved];
}

/** The saved order with `key` dropped before or after `target`. */
export function moveProject(saved: readonly string[], key: string, target: string, after: boolean): string[] {
  if (key === target) return [...saved];
  const rest = saved.filter((entry) => entry !== key);
  const index = rest.indexOf(target);
  if (index < 0) return [...saved];
  rest.splice(index + (after ? 1 : 0), 0, key);
  return rest;
}

/** Every whitespace-separated term of `query` occurs in `text`, ignoring case. An empty query matches. */
export function matchesTerms(text: string, query: string): boolean {
  const haystack = text.toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

/** The session this one was forked from on the same computer and agent, when Core reports it. */
export function forkParentKey(session: CliSessionView): CliSessionKey | null {
  const key: CliSessionKey | null = session.forkOf ? `${session.deviceId}:${session.engine}:${session.forkOf}` : null;
  return key && key !== session.key ? key : null;
}

/** Tree parent per session key within `rows`: the parent only counts when it is in `rows`, and a loop is
 * cut so every session stays reachable from a root. */
export function treeParents(rows: readonly CliSessionView[], parentOf: (row: CliSessionView) => CliSessionKey | null | undefined): Map<CliSessionKey, CliSessionKey | null> {
  const keys = new Set(rows.map((row) => row.key));
  const parents = new Map<CliSessionKey, CliSessionKey | null>();
  for (const row of rows) {
    const parent = parentOf(row);
    parents.set(row.key, parent && parent !== row.key && keys.has(parent) ? parent : null);
  }
  for (const row of rows) {
    const seen = new Set([row.key]);
    for (let p = parents.get(row.key); p; p = parents.get(p)) {
      if (p === row.key) { parents.set(row.key, null); break; }
      if (seen.has(p)) break;
      seen.add(p);
    }
  }
  return parents;
}

export const RECENT_MS = 7 * 24 * 3600 * 1000;
/** A toggle row for a single older session saves no space, so history folds from this many sessions up. */
export const FOLD_MIN = 2;

/** Keys of the sessions worth showing without opening history: those `active` accepts plus their ancestors.
 * Fewer than `FOLD_MIN` hidden sessions are not worth a toggle row, so everything stays shown then. */
export function foldHistory(rows: readonly CliSessionView[], parents: ReadonlyMap<CliSessionKey, CliSessionKey | null>, active: (row: CliSessionView) => boolean): Set<CliSessionKey> {
  const shown = new Set<CliSessionKey>();
  for (const row of rows) {
    if (!active(row)) continue;
    for (let key: CliSessionKey | null | undefined = row.key; key && !shown.has(key); key = parents.get(key)) shown.add(key);
  }
  return rows.length - shown.size < FOLD_MIN ? new Set(rows.map((row) => row.key)) : shown;
}

export function sessionTitle(session: Pick<CliSessionView, "title" | "engine" | "cwd">): string {
  return unwrapPastedContent(session.title).trim() || `${ENGINE_LABEL[session.engine]} 会话`;
}

export interface AgentGroup { engine: CliEngine; label: string; sessions: CliSessionView[] }
export interface DeviceGroup { device: CliDeviceView; agents: AgentGroup[]; count: number }

const byRecent = (a: CliSessionView, b: CliSessionView) => b.lastActivityAt - a.lastActivityAt;

/** Computer -> agent (Claude Code, Codex) -> session. A device with no sessions stays in the list
 * so a new session can be started on it. Hidden rows only appear on request. */
export function groupSessions(devices: readonly CliDeviceView[], sessions: readonly CliSessionView[], showHidden = false): DeviceGroup[] {
  const known = new Map<string, CliDeviceView>(devices.map((device) => [device.id, device]));
  const visible = sessions.filter((session) => showHidden || !session.hidden);
  for (const session of visible) {
    if (!known.has(session.deviceId)) known.set(session.deviceId, { id: session.deviceId, name: session.deviceId, online: session.online, cliAgents: null });
  }
  const groups: DeviceGroup[] = [];
  for (const device of known.values()) {
    const mine = visible.filter((session) => session.deviceId === device.id).sort(byRecent);
    // agents in a fixed order, sessions newest first; an agent without sessions is left out
    const agents = CLI_ENGINES.map((engine) => ({ engine, label: AGENT_LABEL[engine], sessions: mine.filter((session) => session.engine === engine) })).filter((agent) => agent.sessions.length);
    groups.push({ device, agents, count: mine.length });
  }
  return groups.sort((a, b) => Number(b.device.online) - Number(a.device.online) || a.device.name.localeCompare(b.device.name, "zh-CN"));
}

export function hiddenCount(sessions: readonly CliSessionView[]): number {
  return sessions.filter((session) => session.hidden).length;
}

/** Most recently used folders on a computer, for the new-session dialog. */
export function recentCwds(sessions: readonly CliSessionView[], deviceId: string, limit = 8): string[] {
  const latest = new Map<string, number>();
  for (const session of sessions) {
    if (session.deviceId !== deviceId || !session.cwd) continue;
    latest.set(session.cwd, Math.max(latest.get(session.cwd) ?? 0, session.lastActivityAt));
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([cwd]) => cwd);
}

/** Why a new session cannot start on this computer, or null when it can. */
export function deviceBlocker(device: CliDeviceView | undefined, engine?: CliEngine): string | null {
  if (!device) return "电脑离线";
  if (!device.online) return "电脑离线";
  if (!device.cliAgents) return "未开启 Agent 会话";
  const { agyNeedsUpdate, engines, terminal } = device.cliAgents;
  if (engine === "agy") return engines.includes("agy") ? null : agyNeedsUpdate ? "请更新 Antigravity CLI" : "找不到 Antigravity CLI";
  if (!engine && engines.includes("agy")) return null;
  if (!terminal.ready) return terminal.error || "终端组件不可用";
  if (!engines.length) return agyNeedsUpdate ? "请更新 Antigravity CLI" : "找不到可用的运行工具";
  return null;
}

/** Sessions waiting for the user: waiting by their own state, or holding a pending request (`asked` holds their keys). */
export function waitingCount(sessions: readonly CliSessionView[], asked?: ReadonlySet<string>): number {
  return sessions.filter((session) => session.online && !session.hidden && (session.state === "waiting" || !!asked?.has(session.key))).length;
}

/** A session that holds a pending request reads as waiting whatever its file says. */
export function askedSession<T extends Pick<CliSessionView, "state" | "online">>(session: T, pending: number): T {
  return pending > 0 && session.online && session.state !== "waiting" ? { ...session, state: "waiting" } : session;
}

/** The session runs in a nex_bot terminal this page can attach to. */
export function canAttach(session: CliSessionView): boolean {
  return session.online && session.state !== "stopped" && session.liveIn === "nexbot" && !!session.terminal;
}

/** The session runs on the computer outside nex_bot's terminals and takes messages through its own inbox or daemon. */
export function sendsOutside(session: Pick<CliSessionView, "sendVia">): boolean {
  return session.sendVia === "inbox" || session.sendVia === "daemon" || session.sendVia === "acp";
}

export type ComposerMode =
  | { kind: "send"; running: boolean; outside?: true }
  | { kind: "stopped"; hint?: string }
  | { kind: "blocked"; hint: string };

/** What the composer offers for a session (plan 6.5). */
export function composerMode(session: CliSessionView): ComposerMode {
  if (!session.online) return { kind: "blocked", hint: "电脑离线" };
  if (session.state === "stopped") return { kind: "stopped", hint: session.writerUnknown ? "可能在电脑上打开" : undefined };
  if (session.liveIn === "nexbot" && session.terminal) return { kind: "send", running: session.state === "running" };
  if (session.sendVia === "acp") return { kind: "send", running: session.state === "running" || session.state === "waiting" };
  // A Claude's inbox takes Stop (a message at priority now); the Codex daemon has no stop path.
  if (sendsOutside(session)) return { kind: "send", running: session.engine === "claude" && session.sendVia === "inbox" && (session.state === "running" || session.state === "waiting"), outside: true };
  if (session.liveIn === "desktop" && session.engine === "claude") return { kind: "blocked", hint: "在 Claude 桌面应用中打开" };
  return { kind: "blocked", hint: session.writerUnknown ? "可能在电脑上打开" : "在电脑上运行" };
}
