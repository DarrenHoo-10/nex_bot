import { companionColors, companionShapes, parseAppearance, type Appearance } from "../../../shared/personal-appearance";
import type { RecordRow } from "../api";

export { companionColors, companionShapes, type Appearance };
export const colors = { teal: { name: "松青", value: "#23756d" }, ink: { name: "墨色", value: "#414853" }, blue: { name: "雾蓝", value: "#426dac" }, clay: { name: "陶红", value: "#b26351" }, plum: { name: "灰紫", value: "#7c608f" } };
export const shapes = { soft: { name: "软方", radius: "27% 35% 27% 35%" }, bean: { name: "豆荚", radius: "50% 50% 35% 50%" }, pebble: { name: "卵石", radius: "52% 40% 48% 28%" }, bud: { name: "新芽", radius: "52% 12% 52% 12%" } };
export function appearanceOf(bot?: RecordRow, firstId?: string): Appearance {
  try { if (bot?.appearance_json) return parseAppearance(JSON.parse(String(bot.appearance_json))); } catch { /* old or future format: safe default */ }
  try { const old = JSON.parse(localStorage.getItem("nexbot.avatarPortraits.v1") || "{}")[String(bot?.id)]; if (old) return parseAppearance({ kind: "portrait", id: old }); } catch { /* storage may be unavailable */ }
  if (!bot?.id || bot.id === firstId) return { kind: "companion", shape: "soft", color: "teal" };
  let seed = 0; for (const ch of String(bot.id)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return { kind: "companion", shape: companionShapes[seed % 4], color: companionColors[Math.floor(seed / 4) % 5] };
}
export type CompanionState = "idle" | "thinking" | "working" | "approval" | "done" | "failed" | "offline" | "paused";
export const companionLabels: Record<CompanionState, string> = { idle: "准备好了", thinking: "正在思考", working: "正在执行", approval: "等你确认", done: "已完成", failed: "执行未完成", offline: "正在重新连接", paused: "已暂停" };
export function companionState(task?: RecordRow, approval = false, connected = true): CompanionState {
  if (!connected) return "offline";
  if (approval || task?.status === "awaiting_approval") return "approval";
  if (task?.status === "failed" || task?.status === "needs_reconciliation") return "failed";
  if (["paused", "cancelled", "rejected"].includes(String(task?.status))) return "paused";
  if (task?.status === "succeeded") return "done";
  if (task?.status === "queued" || task?.status === "running" && !task.active_tool) return "thinking";
  return task ? "working" : "idle";
}
