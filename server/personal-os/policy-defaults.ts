// Frozen historical defaults: never derive these from the current registry.
// Only exact known defaults without a policy-edit audit may opt into inheritance.
const original = ["memory.search", "memory.read", "memory.write", "agent.delegate", "device.read", "device.list", "device.exec"];
const routines = ["routine.list", "routine.save", "routine.toggle", "routine.run"];
const basic = ["memory.search", "memory.reflect", "memory.read", "memory.write", "memory.delete", "memory.forget", "agent.directory", "agent.delegate", ...routines];
const devices = ["device.inventory", "device.info", "device.list", "device.read", "device.exec", "device.computer", "skill.list", "skill.read"];
const desktop = [...basic, ...devices];
const agents = [...desktop, "agent.create", "agent.update"];
const connectors = [...agents, "connector.list", "connector.tools", "connector.call"];
const attachments = [...connectors, "attachment.read"];
const normalize = (tools: string[]) => [...new Set(tools)].sort().join(",");
const historicalDefaults = new Set([
  original, [...original, ...routines], basic,
  [...basic, "device.list", "device.read", "device.exec"],
  desktop.filter((tool) => tool !== "device.exec"), desktop, agents, connectors,
  attachments, [...attachments, "image.models", "image.generate"],
].map(normalize));

export function isLegacyDefaultTools(tools: unknown): boolean {
  return Array.isArray(tools) && tools.every((tool) => typeof tool === "string") && historicalDefaults.has(normalize(tools));
}
