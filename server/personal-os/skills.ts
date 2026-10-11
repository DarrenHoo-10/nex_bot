import { readFileSync } from "node:fs";
import type { CoreStore } from "./store.ts";
import { policyTools } from "./policy.ts";
const catalog = [
  { id: "devices", title: "设备识别与授权", actions: ["device.inventory", "device.info"] },
  { id: "computer", title: "操作电脑窗口", actions: ["device.computer"] },
  { id: "memory", title: "记忆检索与维护", actions: ["memory.search", "memory.write"] },
  { id: "collaboration", title: "联系其他 Agent", actions: ["agent.directory", "agent.delegate"] },
  { id: "routines", title: "定时与主动汇报", actions: ["routine.list", "routine.save"] },
];
export function skillList(store: CoreStore, botId: string) {
  const policy = store.get("SELECT policy_json FROM bot_policies WHERE bot_id=?", botId);
  const tools = policy ? policyTools(policy) : [];
  return catalog.filter((skill) => skill.actions.every((action) => tools.includes(action))).map((skill) => ({ ...skill, version: 1, builtin: true }));
}
export function skillRead(store: CoreStore, botId: string, skillId: string) {
  if (!skillList(store, botId).some((skill) => skill.id === skillId)) throw new Error("技能不存在或所需工具未授权");
  return { id: skillId, version: 1, content: readFileSync(new URL(`./skills/${skillId}/SKILL.md`, import.meta.url), "utf8") };
}
