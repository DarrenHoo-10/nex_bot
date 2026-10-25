export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface ConnectorView {
  id: string;
  provider: "mcp" | "gmail";
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
  grants: Array<{ botId: string; tools: string[] }>;
}

export interface ConnectorCatalogEntry { id: "gmail"; name: string; available: boolean }
export interface ConnectorOAuthView {
  id: string;
  status: "pending" | "exchanging" | "connected" | "error" | "cancelled";
  expiresAt: number;
  connectorId?: string;
  error?: string;
}
