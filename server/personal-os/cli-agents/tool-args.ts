// Argument rules for the cli.* broker tools. Kept free of the hub so the policy
// module can validate a call without pulling the session machinery in.
import { CLI_ENGINES, CLI_LIMITS, MAX_SEND_TEXT, isAbsoluteCwd, parseCliKey, type CliEngine } from "../../../shared/cli-agents.ts";

export const CLI_TOOL_ACTIONS = ["cli.list", "cli.read", "cli.start", "cli.send", "cli.interrupt"] as const;
export type CliToolAction = (typeof CLI_TOOL_ACTIONS)[number];
export const isCliToolAction = (action: string): action is CliToolAction => (CLI_TOOL_ACTIONS as readonly string[]).includes(action);

/** The device a cli.* call acts on, for the tool-call record and a remembered approval. */
export function cliToolDevice(args: Record<string, unknown>): string {
  if (typeof args.deviceId === "string") return args.deviceId.trim().slice(0, CLI_LIMITS.deviceId);
  return parseCliKey(args.key)?.deviceId ?? "";
}

/** Throws a plain Error (shown to the model) when the arguments cannot be a valid call. */
export function validateCliToolArgs(action: CliToolAction, args: Record<string, unknown>) {
  const key = () => { if (!parseCliKey(args.key)) throw new Error("会话 key 无效，请用 cli.list 返回的 key"); };
  if (action === "cli.list") {
    if (args.deviceId !== undefined && (typeof args.deviceId !== "string" || !args.deviceId.trim() || args.deviceId.length > CLI_LIMITS.deviceId)) throw new Error("设备无效");
  } else if (action === "cli.read") {
    key();
    if (args.before !== undefined && (typeof args.before !== "string" || !args.before || args.before.length > CLI_LIMITS.itemId)) throw new Error("before 无效");
  } else if (action === "cli.start") {
    if (typeof args.deviceId !== "string" || !args.deviceId.trim() || args.deviceId.length > CLI_LIMITS.deviceId) throw new Error("设备无效");
    if (!CLI_ENGINES.includes(args.engine as CliEngine)) throw new Error("engine 须为 claude 或 codex");
    if (!isAbsoluteCwd(args.cwd)) throw new Error("cwd 须为绝对路径");
  } else {
    key();
    if (action === "cli.send") {
      if (typeof args.text !== "string" || !args.text.trim()) throw new Error("text 不能为空");
      if (args.text.length > MAX_SEND_TEXT) throw new Error("text 太长");
    }
  }
}
