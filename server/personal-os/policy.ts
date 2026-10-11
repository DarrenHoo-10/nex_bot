import { canonical, hash, text, type CoreStore, type Row } from "./store.ts";

// A single registry serves every Agent. A display name never selects tools,
// permissions, routing or risk rules.
export const actions = ["memory.search", "memory.read", "memory.write", "memory.delete", "agent.directory", "agent.delegate", "device.list", "device.read", "device.exec"] as const;
export const basicActions = actions.filter((action) => !action.startsWith("device."));
export function policyTools(policy: Row): string[] {
  const parsed = JSON.parse(String(policy.policy_json)) as { tools?: unknown };
  return Array.isArray(parsed.tools) ? parsed.tools.filter((value): value is string => typeof value === "string" && actions.includes(value as typeof actions[number])) : [];
}
export function evaluateTool(store: CoreStore, botId: string, args: Record<string, unknown>) {
  const action = text(args.action, 40);
  const policy = store.get("SELECT p.* FROM bot_policies p JOIN bots b ON b.id=p.bot_id WHERE b.id=? AND b.status='active' AND b.workspace_id=? AND b.owner_user_id=?", botId, store.workspace, store.owner);
  if (!policy || !policyTools(policy).includes(action)) throw new Error("该 Agent 无权调用此能力");
  let local: Row | undefined;
  if (action.startsWith("device.")) {
    const device = text(args.deviceId, 100);
    local = store.get("SELECT g.* FROM device_local_grants g JOIN devices d ON d.id=g.device_id WHERE d.id=? AND d.status='bound' AND d.workspace_id=? AND d.owner_user_id=? AND g.local_grant_id='shared' AND g.status='active'", device, store.workspace, store.owner);
    if (!local) throw new Error("设备未连接或未提供本地授权");
    if (action === "device.exec") {
      if (!JSON.parse(String(local.scope_json)).exec) throw new Error("设备未启用终端能力");
      text(args.command, 16_000);
    } else text(args.path ?? ".", 2048);
  } else if (action === "agent.delegate") {
    text(args.message, 16_000);
    if (!store.get("SELECT id FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", text(args.botId, 100), store.workspace, store.owner)) throw new Error("目标 Agent 不存在或已停用");
  } else if (action === "memory.write") {
    text(args.title, 200); text(args.content, 20_000);
    if (args.scope !== undefined && args.scope !== "bot") throw new Error("自动记忆写入仅限自身私有范围；共享内容请由用户在记忆面板明确发布");
  } else if (action === "memory.read") text(args.documentId, 100);
  else if (action === "memory.delete") {
    const doc = store.get("SELECT * FROM memory_documents WHERE id=? AND status='active' AND scope='bot' AND bot_id=? AND workspace_id=? AND owner_user_id=?", text(args.documentId, 100), botId, store.workspace, store.owner);
    if (!doc) throw new Error("不能清理不属于自己的私有记忆");
    if (!Number.isSafeInteger(args.expectedVersion) || doc.version !== args.expectedVersion) throw new Error("记忆版本已变化");
  }
  else if (action === "memory.search") text(args.query, 200);
  // Arbitrary shell is a dangerous effect regardless of command wording.
  // Reads, own private memory and intra-workspace A2A have no approval flow.
  return { policy, local, approvalRequired: action === "device.exec" || action === "memory.delete" };
}
export function directory(store: CoreStore) {
  const grantVersions = store.all("SELECT g.device_id,g.policy_version,g.status,g.scope_json,d.status device_status FROM device_local_grants g JOIN devices d ON d.id=g.device_id ORDER BY g.device_id");
  const bots = store.all("SELECT b.id,b.name,b.instructions,b.version,p.version policy_version,p.policy_json,x.expertise_json FROM bots b JOIN bot_policies p ON p.bot_id=b.id JOIN bot_public_profiles x ON x.bot_id=b.id WHERE b.status='active' AND b.workspace_id=? AND b.owner_user_id=? ORDER BY b.created_at,b.id", store.workspace, store.owner);
  const revision = hash(canonical({ bots, grants: grantVersions }));
  return bots.map((bot) => ({ id: bot.id, bot_id: bot.id, name: bot.name, instructions: bot.instructions, description: bot.instructions, version: bot.version,
    expertise: JSON.parse(String(bot.expertise_json)), capabilities: policyTools(bot).filter((tool) => !tool.startsWith("device.") || grantVersions.some((grant) => grant.status === "active" && grant.device_status === "bound" && (tool !== "device.exec" || JSON.parse(String(grant.scope_json)).exec))),
    availability: store.get("SELECT id FROM tasks WHERE bot_id=? AND ended_at IS NULL", bot.id) ? "busy" : "ready", profile_version: bot.version, capability_version: bot.policy_version, directory_version: revision }));
}
