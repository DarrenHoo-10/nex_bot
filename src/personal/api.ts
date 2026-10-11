export type RecordRow = Record<string, string | number | null>;
export interface State {
  config?: RecordRow; bots: RecordRow[]; conversations: RecordRow[]; approvals: RecordRow[];
  memories: RecordRow[]; delegations: RecordRow[]; devices: RecordRow[]; tasks: RecordRow[]; onlineDevices: string[];
  routines: RecordRow[]; occurrences: RecordRow[]; journal: RecordRow[];
  memoryEngine?: { provider: string; release: string; status: string; service: string; pending: number; failed: number; quarantined: number; error: string | null };
  node: { status: string; origin: string; root: string; exec: boolean; connected: boolean; unknownCalls: RecordRow[] };
  dataDir: string; address: string; lanEnabled: boolean;
}
type Bridge = {
  chooseFolder(): Promise<string | null>; openData(): Promise<void>; openExternal(url: string): Promise<void>;
  configureNetwork(settings: { enabled: boolean; port: number }): Promise<void>;
  preferences(): Promise<{ openAtLogin: boolean; notifications: boolean }>;
  savePreferences(settings: { openAtLogin: boolean; notifications: boolean }): Promise<void>;
  quit(): Promise<void>;
  closeWindow(): Promise<void>;
};
export const desktop = (window as unknown as { nex?: Bridge }).nex;
export async function api<T>(url: string, data?: unknown): Promise<T> {
  const response = await fetch("/api/" + url, data === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "连接失败");
  return result;
}
export const statuses: Record<string, string> = { queued: "排队中", running: "执行中", awaiting_approval: "等你批准", paused: "已暂停", needs_reconciliation: "需核对结果", cancelling: "取消中", succeeded: "已完成", failed: "失败", cancelled: "已取消", rejected: "已拒绝", bound: "已配对", revoked: "已撤销", pending: "待执行" };
export const str = (value: string | number | null | undefined) => String(value ?? "");
