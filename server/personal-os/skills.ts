import { readFileSync } from "node:fs";
const catalog = [
  { id: "devices", title: "设备识别与授权", actions: ["device.inventory", "device.info"] },
  { id: "computer", title: "操作电脑窗口", actions: ["device.computer"] },
  { id: "memory", title: "记忆检索与维护", actions: ["memory.search", "memory.write"] },
  { id: "collaboration", title: "联系其他 Agent", actions: ["agent.directory", "agent.delegate"] },
  { id: "routines", title: "定时与主动汇报", actions: ["routine.list", "routine.save"] },
  { id: "agent-reach", title: "全网调研与平台内容获取（Agent Reach：搜索、网页、小红书、Twitter、B站、Reddit、YouTube、GitHub 等）", actions: ["device.exec"] },
];
export function skillList() {
  return catalog.map(skill => ({ ...skill, version: 1, builtin: true }));
}
export function skillRead(skillId: string) {
  if (!catalog.some(skill => skill.id === skillId)) throw new Error("技能不存在");
  return { id: skillId, version: 1, content: readFileSync(new URL(`./skills/${skillId}/SKILL.md`, import.meta.url), "utf8") };
}
