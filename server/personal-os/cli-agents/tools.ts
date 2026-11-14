// Assistant broker tools for Agent sessions: cli.list, cli.read, cli.start,
// cli.send and cli.interrupt. The bot is the actor, so the same device checks,
// operation records and audit rows as the web client apply. Starting, sending
// and interrupting are dangerous effects and reach this executor only after
// the approval step in the runtime.
import { CLI_ERROR_TEXT, type CliItem } from "../../../shared/cli-agents.ts";
import { CliOpError, type CliAgentHub } from "./hub.ts";
import { isCliToolAction, validateCliToolArgs } from "./tool-args.ts";

export { CLI_TOOL_ACTIONS, cliToolDevice, isCliToolAction, validateCliToolArgs, type CliToolAction } from "./tool-args.ts";

/** What the assistant gets back from one cli.read, in characters. */
export const READ_TEXT_MAX = 2000;
export const READ_TOOL_MAX = 400;
export const READ_TOTAL_MAX = 24_000;
export const LIST_MAX = 40;

function cut(value: string, max: number): { text: string; cut: boolean } {
  if (value.length <= max) return { text: value, cut: false };
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), cut: true };
}

/** One page of a transcript for a model: no thinking, bounded text, bounded total. */
export function readView(page: { items: CliItem[]; more: boolean }) {
  const out: Array<Record<string, unknown>> = [];
  for (const item of page.items) {
    if (item.kind === "thinking") continue;
    if (item.kind === "turn") { out.push({ id: item.id, kind: "turn", phase: item.phase }); continue; }
    if (item.kind === "tool") {
      const input = cut(item.input, READ_TOOL_MAX), output = cut(item.output ?? "", READ_TOOL_MAX);
      out.push({ id: item.id, kind: "tool", name: item.name, status: item.status, input: input.text, ...(item.output ? { output: output.text } : {}), ...(input.cut || output.cut ? { truncated: true } : {}) });
      continue;
    }
    const body = cut(item.text, READ_TEXT_MAX);
    out.push({ id: item.id, kind: item.kind, text: body.text, ...(body.cut ? { truncated: true } : {}), ...(item.kind === "notice" ? { level: item.level } : {}) });
  }
  // keep the newest; the oldest give way when the page is too big
  let total = 0, keep = out.length;
  for (let index = out.length - 1; index >= 0; index -= 1) {
    total += JSON.stringify(out[index]).length;
    if (total > READ_TOTAL_MAX) break;
    keep = index;
  }
  const items = out.slice(keep);
  const droppedByTotal = keep > 0;
  const first = page.items.find((item) => item.id === items[0]?.id) ?? page.items[0];
  const more = page.more || droppedByTotal;
  return { items, more, ...(more && first ? { before: first.id } : {}), ...(droppedByTotal ? { truncated: true } : {}) };
}

export interface CliToolStore { audit(action: string, targetType: string, targetId: string, detail: Record<string, unknown>): unknown }

function failure(error: unknown, mutating: boolean) {
  if (error instanceof CliOpError) {
    const hint = error.code === "unknown" && mutating ? "，操作可能已经生效，不要重发，先用 cli.read 查看" : "";
    return { error: CLI_ERROR_TEXT[error.code] + hint, code: error.code };
  }
  throw error;
}

/** The executor the runtime calls for an approved (or never dangerous) cli.* call. */
export function cliToolExecutor(hub: CliAgentHub, store: CliToolStore) {
  return async (call: { id?: unknown; bot_id?: unknown; tool_name?: unknown }, args: Record<string, unknown>): Promise<unknown> => {
    const action = String(call.tool_name);
    if (!isCliToolAction(action)) throw new Error("能力尚未配置");
    validateCliToolArgs(action, args);
    const botId = String(call.bot_id);
    const actor = `bot:${botId}`;
    const detail = { botId, toolCallId: String(call.id) };
    try {
      if (action === "cli.list") {
        const { devices, sessions } = hub.list();
        const only = typeof args.deviceId === "string" ? args.deviceId : undefined;
        const shown = sessions.filter((session) => !session.hidden && (!only || session.deviceId === only)).slice(0, LIST_MAX);
        return {
          devices: devices.filter((device) => !only || device.id === only).map((device) => ({ id: device.id, name: device.name, online: device.online, engines: device.cliAgents?.engines ?? [] })),
          sessions: shown.map((session) => ({
            key: session.key, deviceId: session.deviceId, engine: session.engine, title: cut(session.title, 120).text, cwd: session.cwd,
            state: session.state, ...(session.waitingFor ? { waitingFor: cut(session.waitingFor, 200).text } : {}), ...(session.liveIn ? { liveIn: session.liveIn } : {}),
            online: session.online, lastActivityAt: session.lastActivityAt,
          })),
          total: sessions.filter((session) => !session.hidden && (!only || session.deviceId === only)).length,
        };
      }
      if (action === "cli.read") {
        const key = String(args.key);
        if (!hub.session(key)) throw new CliOpError("not_found");
        return readView(await hub.items(actor, key, typeof args.before === "string" ? args.before : undefined));
      }
      if (action === "cli.start") {
        const deviceId = String(args.deviceId), engine = args.engine as "claude" | "codex", cwd = String(args.cwd);
        store.audit("cli.start", "device", deviceId, { ...detail, engine, cwd });
        const started = await hub.start(actor, deviceId, engine, cwd);
        return { started: true, key: started.key };
      }
      const key = String(args.key);
      if (action === "cli.send") {
        const body = String(args.text);
        // Only the person at the composer may write into a session outside nex_bot's terminals.
        const via = hub.session(key)?.sendVia;
        if (via && via !== "terminal") throw new CliOpError("not_in_terminal");
        // length only: what the assistant typed into the session is never stored in the audit log
        store.audit("cli.send", "cli_session", key, { ...detail, length: body.length });
        await hub.send(actor, key, body);
        return { sent: true, key };
      }
      store.audit("cli.interrupt", "cli_session", key, detail);
      await hub.interrupt(actor, key);
      return { interrupted: true, key };
    } catch (error) {
      return failure(error, action !== "cli.list" && action !== "cli.read");
    }
  };
}
