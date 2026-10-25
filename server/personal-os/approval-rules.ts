import { id, now, text, type CoreStore } from "./store.ts";

export function approvalRuleScope(args: Record<string, unknown>) {
  const action = text(args.action, 40);
  const target = action.startsWith("device.") ? text(args.deviceId, 100)
    : action === "connector.call" ? text(args.connectorId, 100)
      : action === "agent.update" ? text(args.botId, 100) : "";
  const operation = action === "device.computer" ? text(args.operation, 80)
    : action === "connector.call" ? text(args.tool, 200) : "";
  return { action, target, operation };
}

export function approvalRuleLabel(store: CoreStore, scope: ReturnType<typeof approvalRuleScope>): string {
  const labels: Record<string, string> = { "device.exec": "执行终端命令", "device.computer": "操作电脑", "connector.call": "调用连接器", "agent.create": "创建 Agent", "agent.update": "更新 Agent", "memory.delete": "撤回记忆", "memory.forget": "清理记忆" };
  const table = scope.action.startsWith("device.") ? "devices" : scope.action === "connector.call" ? "personal_connectors" : "bots";
  const name = scope.target ? store.get(`SELECT name FROM ${table} WHERE id=?`, scope.target)?.name ?? scope.target : "";
  return [labels[scope.action] ?? scope.action, name, scope.operation].filter(Boolean).join(" · ");
}

export function rememberApproval(store: CoreStore, botId: string, args: Record<string, unknown>, policyVersion: number, resourceVersion: number) {
  const { action, target, operation } = approvalRuleScope(args);
  store.run(`INSERT INTO agent_approval_rules(id,bot_id,action,target_id,operation,policy_version,resource_version,created_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,action,target_id,operation) DO UPDATE SET
    policy_version=excluded.policy_version,resource_version=excluded.resource_version,created_at=excluded.created_at`,
  id(), botId, action, target, operation, policyVersion, resourceVersion, now());
}

export function approvalRules(store: CoreStore) {
  return store.all("SELECT r.* FROM agent_approval_rules r JOIN bots b ON b.id=r.bot_id WHERE b.workspace_id=? AND b.owner_user_id=? AND b.status='active' ORDER BY r.created_at", store.workspace, store.owner)
    .map((row) => {
      let active = store.get("SELECT version FROM bot_policies WHERE bot_id=?", row.bot_id)?.version === row.policy_version;
      if (String(row.action).startsWith("device.")) {
        const grant = store.get("SELECT g.policy_version FROM device_local_grants g JOIN devices d ON d.id=g.device_id WHERE g.device_id=? AND g.local_grant_id='shared' AND g.status='active' AND d.status='bound'", row.target_id);
        active = active && grant?.policy_version === row.resource_version;
      } else if (row.action === "connector.call") {
        const connector = store.get("SELECT c.version,g.tools_json FROM personal_connectors c JOIN personal_connector_grants g ON g.connector_id=c.id WHERE c.id=? AND g.bot_id=? AND c.enabled=1", row.target_id, row.bot_id);
        active = active && connector?.version === row.resource_version && JSON.parse(String(connector.tools_json)).includes(row.operation);
      } else if (row.action === "agent.update") active = active && !!store.get("SELECT id FROM bots WHERE id=? AND status='active'", row.target_id);
      return { ...row, id: String(row.id), bot_id: String(row.bot_id), active, label: approvalRuleLabel(store, { action: String(row.action), target: String(row.target_id), operation: String(row.operation) }) };
    });
}

export function revokeApprovalRule(store: CoreStore, ruleId: string, botId: string) {
  if (!store.get("SELECT id FROM bots WHERE id=? AND workspace_id=? AND owner_user_id=? AND status='active'", botId, store.workspace, store.owner)) throw new Error("Agent 不存在");
  store.transaction(() => {
    if (!store.run("DELETE FROM agent_approval_rules WHERE id=? AND bot_id=?", ruleId, botId).changes) throw new Error("授权已不存在，请刷新");
    store.audit("approval.rule.revoke", "bot", botId, { ruleId });
  });
}
