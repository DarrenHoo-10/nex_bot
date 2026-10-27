import type { FileEntry } from "@earendil-works/pi-coding-agent";

export interface RuntimeInput { id: string; text: string; hash: string; seq: number }
// systemPrompt is the stable system message; volatilePrompt is injected per request before the newest model turn.
export interface ModelPermit { invokeId: string; systemPrompt: string; volatilePrompt: string }
export interface WorkerConfig {
  taskId: string; conversationId: string; runtimeId: string; generation: number; dir: string;
  provider: string; endpoint: string; model: string; apiKey: string; systemPrompt: string; volatilePrompt: string;
  contextWindow: number; maxOutputTokens: number;
  // Working context budget in tokens (resolved and clamped by Core); reduction starts here, not at the window.
  contextBudget?: number;
  // Real/estimated token ratio of this model; scales the count that starts context reduction, never a capacity check. 1 when unknown.
  calibration?: number;
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
  summaryMaxTokens?: number;
  cacheRead?: number; cacheWrite?: number;
  // The worker's own estimate of the request this receipt (inputTokens) belongs to.
  estimatedTokens?: number;
}
export interface WorkerReply { type: "start" | "reply" | "steer" | "stop"; config?: WorkerConfig; requestId?: string; result?: unknown; error?: string; input?: RuntimeInput }
