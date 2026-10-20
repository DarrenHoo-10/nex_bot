import { canonical, hash, optionalText, text, type CoreStore, type Row } from "./store.ts";
import { computerOperations } from "./computer.ts";
import { dangerousEffect } from "./risk.ts";
import { connectorAccess, type ConnectorTool } from "./connectors.ts";
import { universalImageActions } from '../../shared/personal-capabilities.ts';

// A single registry serves every Agent. A display name never selects tools,
// permissions, routing or risk rules.
export const actions = ["memory.search", "memory.reflect", "memory.read", "memory.write", "memory.delete", "memory.forget", "agent.directory", "agent.delegate", "agent.create", "agent.update", "routine.list", "routine.save", "routine.toggle", "routine.run", "device.inventory", "device.info", "device.list", "device.read", "device.exec", "device.computer", "skill.list", "skill.read", "connector.list", "connector.tools", "connector.call", "attachment.read", "image.models", "image.generate"] as const;
// Device binding, Agent policy and effect-specific approval remain independent.
export const basicActions = [...actions];
export function policyTools(policy: Row): string[] {
  const parsed = JSON.parse(String(policy.policy_json)) as { tools?: unknown };
  const configured = Array.isArray(parsed.tools) ? parsed.tools.filter((value): value is string => typeof value === "string" && actions.includes(value as typeof actions[number])) : [];
  return [...new Set([...configured, ...universalImageActions])];
}
export function evaluateTool(store: CoreStore, botId: string, args: Record<string, unknown>) {
  const action = text(args.action, 40);
  const policy = store.get("SELECT p.* FROM bot_policies p JOIN bots b ON b.id=p.bot_id WHERE b.id=? AND b.status='active' AND b.workspace_id=? AND b.owner_user_id=?", botId, store.workspace, store.owner);
  if (!policy || !policyTools(policy).includes(action)) throw new Error("该 Agent 无权调用此能力");
  let local: Row | undefined;
  let connectorTool: ConnectorTool | undefined;
  if (action.startsWith("device.") && action !== "device.inventory") {
    const device = text(args.deviceId, 100);
    local = store.get("SELECT g.* FROM device_local_grants g JOIN devices d ON d.id=g.device_id WHERE d.id=? AND d.status='bound' AND d.workspace_id=? AND d.owner_user_id=? AND g.local_grant_id='shared' AND g.status='active'", device, store.workspace, store.owner);
    if (!local) throw new Error("设备未连接或未提供本地授权");
    const scope = JSON.parse(String(local.scope_json));
    if (action === "device.info" && !scope.info) throw new Error("此设备 Node 版本尚不支持系统信息，请更新客户端");
    if (action === "device.computer") {
      if (!scope.computer) throw new Error("目标设备未提供可用的 computer use 执行器，请检查客户端运行状态");
      const operation = text(args.operation, 80);
      if (!computerOperations.includes(operation)) throw new Error("不支持的 computer use 操作");
      if (args.parameters !== undefined && (!args.parameters || typeof args.parameters !== "object" || Array.isArray(args.parameters) || JSON.stringify(args.parameters).length > 32_000)) throw new Error("电脑操作参数无效");
    } else if (action === "device.exec") {
      if (!JSON.parse(String(local.scope_json)).exec) throw new Error("设备未启用终端能力");
      text(args.command, 16_000);
    } else if (action !== "device.info") { if (scope.read === false) throw new Error("设备未授权文件目录"); text(args.path ?? ".", 2048); }
  } else if (action === "agent.delegate") {
    text(args.message, 16_000);
    if (!store.get("SELECT id FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", text(args.botId, 100), store.workspace, store.owner)) throw new Error("目标 Agent 不存在或已停用");
  } else if (action === "agent.create") {
    text(args.name, 80);
    if (args.instructions !== undefined) optionalText(args.instructions, 8000);
    if (args.expertise !== undefined && (!Array.isArray(args.expertise) || args.expertise.length > 20 || args.expertise.some((item) => typeof item !== "string" || !item.trim() || item.length > 80))) throw new Error("专长标签无效");
  } else if (action === "agent.update") {
    const targetId = text(args.botId, 100);
    if (!store.get("SELECT id FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", targetId, store.workspace, store.owner)) throw new Error("目标 Agent 不存在或已停用");
    if (args.name !== undefined) text(args.name, 80);
    if (args.instructions !== undefined) optionalText(args.instructions, 8000);
    if (args.expertise !== undefined && (!Array.isArray(args.expertise) || args.expertise.length > 20 || args.expertise.some((item) => typeof item !== "string" || !item.trim() || item.length > 80))) throw new Error("专长标签无效");
  } else if (action.startsWith("routine.")) {
    if (args.botId !== undefined && args.botId !== botId) throw new Error("只能管理自己的例行任务");
    if (action !== "routine.list" && action !== "routine.save") {
      if (!store.get("SELECT id FROM agent_routines WHERE id=? AND bot_id=?", text(args.routineId, 100), botId)) throw new Error("例行任务不属于当前 Agent");
    }
    if (action === "routine.save" && args.routineId !== undefined && !store.get("SELECT id FROM agent_routines WHERE id=? AND bot_id=?", text(args.routineId, 100), botId)) throw new Error("例行任务不属于当前 Agent");
  } else if (action === "memory.write") {
    text(args.title, 200); text(args.content, 20_000);
    if (args.scope !== undefined && args.scope !== "bot" && args.scope !== "context") throw new Error("自动记忆写入仅限自身私有范围；共享内容请由用户在记忆面板明确发布");
    if(args.scope==='context')text(args.content,6000);
  } else if (action === "memory.read") text(args.documentId, 100);
  else if (action === "memory.delete" || action === "memory.forget") {
    const doc = store.get("SELECT * FROM memory_documents WHERE id=? AND status='active' AND scope='bot' AND bot_id=? AND workspace_id=? AND owner_user_id=?", text(args.documentId, 100), botId, store.workspace, store.owner);
    if (!doc) throw new Error("不能清理不属于自己的私有记忆");
    if (!Number.isSafeInteger(args.expectedVersion) || doc.version !== args.expectedVersion) throw new Error("记忆版本已变化");
  }
  else if (action === "memory.search" || action === "memory.reflect") text(args.query, action === "memory.reflect" ? 1000 : 200);
  else if (action === 'image.generate') {
    text(args.prompt, 16000);
    if (args.modelId !== undefined) text(args.modelId, 200);
  }
  else if (action === "skill.read") text(args.skillId, 80);
  else if (action === "connector.tools" || action === "connector.call") {
    const connector = connectorAccess(store, botId, args);
    connectorTool = (JSON.parse(String(connector.tools_json)) as ConnectorTool[]).find((tool) => tool.name === args.tool);
  }
  const full = store.get("SELECT mode FROM agent_approval_settings WHERE bot_id=?", botId)?.mode === "full";
  return { policy, local, approvalRequired: !full && dangerousEffect(args, connectorTool) };
}
export function directory(store: CoreStore) {
  const grantVersions = store.all("SELECT g.device_id,g.policy_version,g.status,g.scope_json,d.status device_status FROM device_local_grants g JOIN devices d ON d.id=g.device_id ORDER BY g.device_id");
  const bots = store.all("SELECT b.id,b.name,b.instructions,b.version,p.version policy_version,p.policy_json,x.expertise_json FROM bots b JOIN bot_policies p ON p.bot_id=b.id JOIN bot_public_profiles x ON x.bot_id=b.id WHERE b.status='active' AND b.workspace_id=? AND b.owner_user_id=? ORDER BY b.created_at,b.id", store.workspace, store.owner);
  const revision = hash(canonical({ bots, grants: grantVersions }));
  return bots.map((bot) => ({ id: bot.id, bot_id: bot.id, name: bot.name, instructions: bot.instructions, description: bot.instructions, version: bot.version,
    expertise: JSON.parse(String(bot.expertise_json)), capabilities: policyTools(bot).filter((tool) => !tool.startsWith("device.") || tool === "device.inventory" || grantVersions.some((grant) => {
      const scope = JSON.parse(String(grant.scope_json));
      return grant.status === "active" && grant.device_status === "bound" && (tool === "device.exec" ? scope.exec : tool === "device.computer" ? scope.computer : tool === "device.info" ? scope.info : scope.read !== false);
    })),
    availability: store.get("SELECT id FROM tasks WHERE bot_id=? AND ended_at IS NULL", bot.id) ? "busy" : "ready", profile_version: bot.version, capability_version: bot.policy_version, directory_version: revision }));
}
