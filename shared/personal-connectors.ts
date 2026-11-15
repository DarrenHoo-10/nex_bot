export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface ConnectorView {
  id: string;
  provider: "mcp" | "gmail" | "github";
  name: string;
  account: string | null;
  url: string;
  transport: "http" | "sse";
  enabled: boolean;
  version: number;
  hasToken: boolean;
  tools: ConnectorTool[];
  checkedAt: number | null;
  error: string | null;
  /** Deprecated compatibility field: per-bot grants were retired and this is always empty. Older clients still parse it. */
  grants: Array<{ botId: string; tools: string[] }>;
}

export interface ConnectorCatalogEntry { id: "gmail" | "github"; name: string; available: boolean }
export interface ConnectorOAuthView {
  id: string;
  status: "pending" | "exchanging" | "connected" | "error" | "cancelled";
  expiresAt: number;
  connectorId?: string;
  error?: string;
  /** Device-code flow (GitHub without a configured OAuth app): the code the user types in. */
  userCode?: string;
  verificationUri?: string;
}

export type MonitorDelivery = "notify" | "task";
export type MonitorCiMode = "default_branch" | "mine" | "all" | "off";
/** One watch configuration: which repos a GitHub connector reports on, and where events land. */
export interface ConnectorMonitorView {
  id: string;
  connectorId: string;
  name: string;
  botId: string;
  repos: string[];
  ciMode: MonitorCiMode;
  mutedRepos: string[];
  ignoreBranches: string[];
  delivery: MonitorDelivery;
  enabled: boolean;
  intervalSeconds: number;
  webhookConfigured: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  version: number;
  /** Only present in the save response: the webhook secret, shown exactly once. */
  webhookSecret?: string;
}
