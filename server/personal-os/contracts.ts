import type { FileEntry } from "@earendil-works/pi-coding-agent";

export interface RuntimeInput { id: string; text: string; hash: string; seq: number }
export interface ModelPermit { invokeId: string; systemPrompt: string }
export interface WorkerConfig {
  taskId: string; conversationId: string; runtimeId: string; generation: number; dir: string;
  provider: string; endpoint: string; model: string; apiKey: string; systemPrompt: string;
  contextWindow: number; maxOutputTokens: number;
  entries?: FileEntry[]; inputs: RuntimeInput[];
}
export interface WorkerEvent {
  type: "request" | "tool" | "snapshot" | "delta" | "done" | "error";
  requestId?: string; entries?: FileEntry[]; inputs?: string[];
  providerId?: string; entryId?: string; args?: Record<string, unknown>;
  text?: string; error?: string; inputTokens?: number; outputTokens?: number; invokeId?: string;
  purpose?: "answer" | "compact";
  modelStatus?: "succeeded" | "failed" | "cancelled";
}
export interface WorkerReply { type: "start" | "reply" | "steer" | "stop"; config?: WorkerConfig; requestId?: string; result?: unknown; error?: string; input?: RuntimeInput }
