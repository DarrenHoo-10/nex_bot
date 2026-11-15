// Pure helpers over the session rows Core sends: grouping, labels and what the
// composer may do. No React, no network.
import { CLI_ENGINES, type CliDeviceView, type CliEngine, type CliSessionView } from "../../../shared/cli-agents";

export const ENGINE_LABEL: Record<CliEngine, string> = { claude: "Claude", codex: "Codex", zcode: "ZCode" };
/** The agent names the session list groups by. */
export const AGENT_LABEL: Record<CliEngine, string> = { claude: "Claude Code", codex: "Codex", zcode: "ZCode" };

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

export function sessionTitle(session: Pick<CliSessionView, "title" | "engine" | "cwd">): string {
  return session.title.trim() || `${ENGINE_LABEL[session.engine]} 会话`;
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
export function deviceBlocker(device: CliDeviceView | undefined): string | null {
  if (!device) return "电脑离线";
  if (!device.online) return "电脑离线";
  if (!device.cliAgents) return "未开启 Agent 会话";
  if (!device.cliAgents.terminal.ready) return device.cliAgents.terminal.error || "终端组件不可用";
  if (!device.cliAgents.engines.length) return "找不到 Claude 或 Codex";
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
  return session.sendVia === "inbox" || session.sendVia === "daemon";
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
  // Interrupt is a terminal operation, so there is no stop button for these.
  if (sendsOutside(session)) return { kind: "send", running: false, outside: true };
  if (session.liveIn === "desktop" && session.engine === "claude") return { kind: "blocked", hint: "在 Claude 桌面应用中打开" };
  return { kind: "blocked", hint: session.writerUnknown ? "可能在电脑上打开" : "在电脑上运行" };
}
