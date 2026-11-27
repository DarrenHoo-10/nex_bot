import { canonical, hash, optionalText, text, type CoreStore, type Row } from "./store.ts";
import { computerOperations } from "./computer.ts";
import { dangerousEffect } from "./risk.ts";
import { connectorAccess, type ConnectorTool } from "./connectors.ts";
import { universalActions } from '../../shared/personal-capabilities.ts';
import { htmlRenderContent } from '../../shared/html-render.ts';
import { TopicAccess } from "./topic-access.ts";
import { isCliToolAction, validateCliToolArgs } from "./cli-agents/tool-args.ts";
import { validateWebFetchArgs } from "./web-fetch.ts";

// A single registry serves every Agent. All active assistants receive full unrestricted capabilities.
export const actions = ["memory.search", "memory.reflect", "memory.read", "memory.write", "memory.delete", "memory.forget", "agent.directory", "agent.delegate", "agent.create", "agent.update", "agent.feishuDelivery", "todo.list", "todo.save", "todo.delete", "routine.list", "routine.save", "routine.toggle", "routine.run", "routine.delete", "device.inventory", "device.info", "device.list", "device.read", "device.exec", "device.computer", "skill.list", "skill.read", "connector.list", "connector.tools", "connector.call", "attachment.read", "image.models", "image.generate", "html.render", "web.fetch", "tool.search", "cli.list", "cli.read", "cli.start", "cli.send", "cli.interrupt"] as const;
export const basicActions = [...actions];
export function policyTools(_policy: Row): string[] {
  return [...new Set([...actions, ...universalActions])];
}
/**
 * Background job actions move work between main chat and background jobs; every active assistant has them.
 */
export const ownerJobActions = ["job.start", "job.list", "job.message", "job.stop"] as const;
export const workerJobActions = ["job.report", "job.progress"] as const;
export const jobActions: readonly string[] = [...ownerJobActions, ...workerJobActions];
/** Unrestricted mode: no tool is blocked in the main chat. */
export const ownerJobOnly: readonly string[] = [];
export const TOPIC_QUESTION_LIMIT = 300;
export function ownerMayCall(_action: string, _args: Record<string, unknown>) {
  return true;
}
export function evaluateTool(store: CoreStore, botId: string, args: Record<string, unknown>) {
  const action = text(args.action, 40);
  const policy = store.get("SELECT p.* FROM bot_policies p JOIN bots b ON b.id=p.bot_id WHERE b.id=? AND b.status='active' AND b.workspace_id=? AND b.owner_user_id=?", botId, store.workspace, store.owner);
  if (!policy || !(policyTools(policy).includes(action) || jobActions.includes(action) || action === "memory.core.update" || action === "memory.topic")) throw new Error("该 Agent 无权调用此能力");
  let local: Row | undefined;
  let connectorTool: ConnectorTool | undefined;
  let resourceVersion = 0;
  if (action.startsWith("device.") && action !== "device.inventory") {
    const device = text(args.deviceId, 100);
    local = store.get("SELECT g.* FROM device_local_grants g JOIN devices d ON d.id=g.device_id WHERE d.id=? AND d.status='bound' AND d.workspace_id=? AND d.owner_user_id=? AND g.local_grant_id='shared' AND g.status='active'", device, store.workspace, store.owner);
    if (!local) throw new Error("设备未连接或未提供本地授权");
    resourceVersion = Number(local.policy_version);
    const scope = JSON.parse(String(local.scope_json));
    if (action === "device.info" && !scope.info) throw new Error("此设备 Node 版本尚不支持系统信息，请更新客户端");
    if (action === "device.computer") {
      if (!scope.computer) throw new Error("目标设备未提供可用的 computer use 执行器，请检查客户端运行状态");
      const operation = text(args.operation, 80);
      if (!computerOperations.includes(operation)) throw new Error("不支持的 computer use 操作");
      if (args.parameters !== undefined && (!args.parameters || typeof args.parameters !== "object" || Array.isArray(args.parameters) || JSON.stringify(args.parameters).length > 32_000)) throw new Error("电脑操作参数无效");
    } else if (action === "device.exec") {
      text(args.command, 16_000);
    } else if (action !== "device.info") {
      text(args.path ?? ".", 4096);
    }
  } else if (isCliToolAction(action)) {
    validateCliToolArgs(action, args);
  } else if (action === "web.fetch") {
    validateWebFetchArgs(args);
  } else if (action === "agent.delegate") {
    text(args.message, 16_000);
    if (args.topic !== undefined) text(args.topic, 200);
    if (!store.get("SELECT id FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", text(args.botId, 100), store.workspace, store.owner)) throw new Error("目标 Agent 不存在或已停用");
  } else if (action === 'agent.feishuDelivery') {
    if(!['list','upsert'].includes(String(args.operation))) throw new Error('投递操作无效');
    if(args.operation==='upsert') {text(args.appId,200);text(args.chatId,200);text(args.instanceId,200);}
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
    if (action !== "routine.list" && action !== "routine.save") {
      if (!store.get("SELECT id FROM agent_routines WHERE id=? AND deleted_at IS NULL", text(args.routineId, 100))) throw new Error("例行任务不存在");
    }
    if (action === "routine.save" && args.routineId !== undefined && !store.get("SELECT id FROM agent_routines WHERE id=? AND deleted_at IS NULL", text(args.routineId, 100))) throw new Error("例行任务不存在");
  } else if (action === "memory.write") {
    text(args.title, 200); text(args.content, 20_000);
    if (args.scope !== undefined && args.scope !== "bot" && args.scope !== "workspace" && args.scope !== "context") throw new Error("记忆范围无效");
    if(args.scope==='context')text(args.content,6000);
  } else if (action === "memory.topic") {
    if (typeof args.op !== "string" || !["tree", "access", "grant", "revoke", "resident", "group", "move", "rename", "merge", "revert"].includes(args.op)) throw new Error("memory.topic 的 op 须为 tree、access、grant、revoke、resident、group、move、rename、merge 或 revert");
  } else if (action === "memory.core.update") {
    if (args.scope !== undefined && args.scope !== "bot" && args.scope !== "workspace") throw new Error("核心记忆范围无效");
    if (!args.patch || typeof args.patch !== "object" || Array.isArray(args.patch) || JSON.stringify(args.patch).length > 20_000) throw new Error("核心记忆补丁无效");
    if (args.scope !== "workspace" && (!Number.isSafeInteger(args.expectedVersion) || Number(args.expectedVersion) < 0)) throw new Error("核心记忆版本无效");
  } else if (action === "memory.read") text(args.documentId, 100);
  else if (action === "memory.delete" || action === "memory.forget") {
    const doc = store.get("SELECT * FROM memory_documents WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", text(args.documentId, 100), store.workspace, store.owner);
    if (!doc) throw new Error("记忆不存在");
    if (!Number.isSafeInteger(args.expectedVersion) || doc.version !== args.expectedVersion) throw new Error("记忆版本已变化");
  }
  else if (action === "memory.search" || action === "memory.reflect") text(args.query, action === "memory.reflect" ? 1000 : 200);
  else if (action === 'image.generate') {
    text(args.prompt, 16000);
    if (args.modelId !== undefined) text(args.modelId, 200);
  }
  else if (action === 'html.render') htmlRenderContent(args.content);
  else if (action === "skill.read") text(args.skillId, 80);
  else if (action === "connector.tools" || action === "connector.call") {
    const connector = connectorAccess(store, args);
    resourceVersion = Number(connector.version);
    connectorTool = (JSON.parse(String(connector.tools_json)) as ConnectorTool[]).find((tool) => tool.name === args.tool);
  }
  // Validate risk/riskReason shape if provided, without gating execution behind approvals.
  dangerousEffect(args, connectorTool);
  return { policy, local, resourceVersion, approvalRequired: false };
}
export function directory(store: CoreStore) {
  const grantVersions = store.all("SELECT g.device_id,g.policy_version,g.status,g.scope_json,d.status device_status FROM device_local_grants g JOIN devices d ON d.id=g.device_id ORDER BY g.device_id");
  const bots = store.all("SELECT b.id,b.name,b.instructions,b.version,p.version policy_version,p.policy_json,x.expertise_json FROM bots b JOIN bot_policies p ON p.bot_id=b.id JOIN bot_public_profiles x ON x.bot_id=b.id WHERE b.status='active' AND b.workspace_id=? AND b.owner_user_id=? ORDER BY b.created_at,b.id", store.workspace, store.owner);
  // What each assistant looks after (section 7): the names of the top-level user topics it is steward of, nothing below them.
  const access = new TopicAccess(store), duties = new Map(bots.map((bot) => [String(bot.id), access.responsibilities(String(bot.id))]));
  const revision = hash(canonical({ bots, grants: grantVersions, duties: [...duties] }));
  return bots.map((bot) => ({ id: bot.id, bot_id: bot.id, name: bot.name, instructions: bot.instructions, description: bot.instructions, version: bot.version,
    expertise: JSON.parse(String(bot.expertise_json)), capabilities: policyTools(bot),
    ...(duties.get(String(bot.id))?.length ? { responsibilities: duties.get(String(bot.id)) } : {}),
    availability: store.get("SELECT id FROM tasks WHERE bot_id=? AND ended_at IS NULL", bot.id) ? "busy" : "ready", profile_version: bot.version, capability_version: bot.policy_version, directory_version: revision }));
}
