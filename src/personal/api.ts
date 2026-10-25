import type { ConnectorCatalogEntry, ConnectorView } from "../../shared/personal-connectors";
export type { ConnectorTool, ConnectorView } from "../../shared/personal-connectors";
export type RecordRow = Record<string, string | number | null>;
export interface MemoryPluginState {
  providers: Array<{ id: string; name: string; protocol: string }>;
  provider: string; enabled: boolean; endpoint: string; hasToken: boolean;
  restartRequired: boolean; status: string; error: string | null;
}
export interface ToolStep { id: string; tool_name: string; status: string; summary: string; preview: string; created_at: number }
export interface PreviewItem { kind: "file" | "tool"; id?: string; path?: string; title: string; status?: string; exists?: boolean; size?: number; updatedAt?: number; createdAt?: number; arguments?: string; content: string }
export interface State {
  imageModelSelection?: { models: string[]; version: number };
  modelVisibility?: { models: string[] | null; version: number };
  connectors?: ConnectorView[];
  connectorCatalog?: ConnectorCatalogEntry[];
  sync: { cursor: number; privacyEpoch: number; coreId: string; bootId: string };
  config?: RecordRow; bots: RecordRow[]; conversations: RecordRow[]; approvals: RecordRow[];
  approvalRules?: Array<{ id: string; bot_id: string; label: string; active?: boolean }>;
  memories: RecordRow[]; delegations: RecordRow[]; devices: RecordRow[]; tasks: RecordRow[]; onlineDevices: string[];
  routines: RecordRow[]; occurrences: RecordRow[]; journal: RecordRow[]; usage?: RecordRow[];
  memoryEngine?: { provider: string; release: string; status: string; service: string; pending: number; failed: number; quarantined: number; forgetting: number; revision: string; error: string | null };
  memoryPlugin?: MemoryPluginState;
  hostDeviceId?: string;
  node: { hosted?: boolean; status: string; origin: string; root: string; exec: boolean; computer?: boolean; computerSupported?: boolean; deviceId?: string; connected: boolean; unknownCalls: RecordRow[] };
  dataDir: string; address: string; lanEnabled: boolean;
}
export interface LocalDeviceState { available: boolean; name?: string; status?: string; connected?: boolean; authorized?: boolean; paused?: boolean; deviceId?: string; root?: string; exec?: boolean; computer?: boolean; computerSupported?: boolean; unknownCalls?: RecordRow[] }
export interface ClientUpdateState { status: "idle" | "downloading" | "ready" | "error" | "unsupported"; current?: string; version?: string; progress?: number; error?: string }
type Bridge = {
  platform?: "android";
  saveFile?(name: string, content: string): Promise<unknown>;
  downloadAttachment?(url: string, name: string): Promise<unknown>;
  minimize?(): Promise<unknown>;
  workspaceReady?(): Promise<unknown>;
  deviceState?(): Promise<LocalDeviceState>;
  setDevicePaused?(paused: boolean): Promise<LocalDeviceState>;
  reconcileDevice?(id: string, version: number): Promise<LocalDeviceState>;
  stopDevice?(): Promise<void>;
  mode?: "client";
  listModels?(settings: { provider: string; endpoint: string; apiKey: string }): Promise<{ models: string[]; hasMore: boolean }>;
  disconnect?(): Promise<void>;
  rememberLogin?(session: { token: string; coreId: string; sessionId: string; expiresAt: number }): Promise<void>;
  forgetLogin?(): Promise<void>;
  openExternal(url: string): Promise<void>;
  preferences(): Promise<{ openAtLogin: boolean; notifications: boolean }>;
  quit(): Promise<void>;
  closeWindow(): Promise<void>;
  onClipboardImage?(callback: (image: { name: string; type: string; bytes: Uint8Array }) => void): (() => void) | void;
  updateState?(): Promise<ClientUpdateState>;
  installUpdate?(): Promise<void>;
  onUpdateState?(callback: (state: ClientUpdateState) => void): (() => void) | void;
};
export const desktop = (window as unknown as { nex?: Bridge }).nex;
export async function listModels(settings: { provider: string; endpoint: string; apiKey: string }): Promise<{ models: string[]; hasMore: boolean }> {
  const response = await fetch("/api/models/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
  if (response.status === 404 && desktop?.listModels && settings.apiKey.trim()) return desktop.listModels(settings);
  if (response.status === 404) throw new Error(desktop?.listModels ? "当前版本暂不能用已保存的 Key 查询模型。请在上方重新填写 Key 后获取，无需先保存。" : "当前服务暂不支持获取模型列表，请手动填写模型 ID");
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("nex-session-expired"));
    throw new Error(result.error || "获取模型列表失败");
  }
  return result;
}
export async function api<T>(url: string, data?: unknown): Promise<T> {
  const response = await fetch("/api/" + url, data === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json() as T & { error?: string; code?: string };
  if (!response.ok) { if (!url.startsWith("auth/") && (response.status === 401 || result.code === "identity_unavailable")) window.dispatchEvent(new Event("nex-session-expired")); throw new Error(result.error ?? "连接失败"); }
  return result;
}
export const statuses: Record<string, string> = { queued: "排队中", running: "执行中", awaiting_approval: "等你批准", paused: "已暂停", needs_reconciliation: "需核对结果", cancelling: "取消中", succeeded: "已完成", failed: "失败", cancelled: "已取消", rejected: "已拒绝", bound: "已配对", revoked: "已撤销", pending: "待执行" };
export const toolLabels: Record<string, string> = { "html.render": "展示交互内容", "image.models": "查看生图模型", "image.generate": "生成图片", "attachment.read": "读取附件", "connector.list": "查看连接器", "connector.tools": "读取工具目录", "connector.call": "调用连接器工具", "agent.delegate": "联系同伴", "agent.directory": "查看同伴目录", "agent.create": "招募新同伴", "agent.update": "更新同伴资料", "memory.search": "检索记忆", "memory.read": "读取记忆", "memory.reflect": "综合记忆", "memory.write": "写入长期记忆", "memory.delete": "撤回记忆", "memory.forget": "清理记忆", "routine.list": "查看计划", "routine.save": "保存例行任务", "routine.toggle": "切换计划状态", "routine.run": "立即运行计划", "device.list": "查看设备目录", "device.read": "读取设备文件", "device.exec": "执行终端命令", "device.inventory": "检查设备目录", "device.info": "读取设备信息", "device.computer": "操作电脑窗口", "skill.list": "查看技能目录", "skill.read": "阅读技能说明" };
export const toolPhrases: Record<string, string> = { "html.render": "正在准备展示内容", "image.models": "正在查看生图模型", "image.generate": "正在生成图片", "attachment.read": "正在读取附件", "connector.list": "正在查看连接器", "connector.tools": "正在读取工具目录", "connector.call": "正在调用连接器工具", "agent.delegate": "正在联系同伴", "agent.directory": "正在查看同伴目录", "agent.create": "正在创建新同伴", "agent.update": "正在更新同伴资料", "memory.search": "正在检索记忆", "memory.read": "正在读取记忆", "memory.reflect": "正在综合记忆", "memory.write": "正在记录长期记忆", "memory.delete": "正在整理记忆", "memory.forget": "正在清理记忆", "routine.list": "正在查看计划", "routine.save": "正在安排例行任务", "routine.toggle": "正在调整计划", "routine.run": "正在执行例行任务", "device.list": "正在查看设备目录", "device.read": "正在读取设备文件", "device.exec": "正在执行终端命令", "device.inventory": "正在检查设备状态", "device.info": "正在读取设备信息", "device.computer": "正在操作电脑窗口", "skill.list": "正在查看技能目录", "skill.read": "正在阅读技能说明" };
export const str = (value: string | number | null | undefined) => String(value ?? "");
export const taskPhrase = (task?: RecordRow) => !task ? "" : task.status === "needs_reconciliation" ? "等待核对执行结果" : task.status === "cancelling" ? "正在停止…" : task.status === "awaiting_approval" ? "等你批准" : (task.active_tool && toolPhrases[str(task.active_tool)]) || statuses[str(task.status)] || "执行中";
