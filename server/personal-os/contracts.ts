import type { FileEntry } from "@earendil-works/pi-coding-agent";

export interface RuntimeInput { id: string; text: string; hash: string; seq: number }
export interface ModelPermit { invokeId: string; systemPrompt: string }
export interface WorkerConfig {
  taskId: string; conversationId: string; runtimeId: string; generation: number; dir: string;
  provider: string; endpoint: string; model: string; apiKey: string; systemPrompt: string;
  contextWindow: number; maxOutputTokens: number;
  entries?: FileEntry[]; inputs: RuntimeInput[];
  history?: Array<{ref:string;role:string;content:string}>;
}
export interface WorkerEvent {
  type: "request" | "tool" | "snapshot" | "delta" | "done" | "error" | "compact";
  requestId?: string; entries?: FileEntry[]; inputs?: string[];
  providerId?: string; entryId?: string; args?: Record<string, unknown>;
  text?: string; error?: string; inputTokens?: number; outputTokens?: number; invokeId?: string;
  purpose?: "answer" | "compact";
  modelStatus?: "succeeded" | "failed" | "cancelled";
  firstEntry?: string; lastEntry?: string; contextTokens?: number;
  cacheRead?: number; cacheWrite?: number;
}
export interface WorkerReply { type: "start" | "reply" | "steer" | "stop"; config?: WorkerConfig; requestId?: string; result?: unknown; error?: string; input?: RuntimeInput }
