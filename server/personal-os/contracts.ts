import type { FileEntry } from "@earendil-works/pi-coding-agent";

export interface RuntimeInput { id: string; text: string; hash: string; seq: number }
// systemPrompt is the stable system message; volatilePrompt is injected per request before the newest model turn.
export interface ModelPermit { invokeId: string; systemPrompt: string; volatilePrompt: string }
export interface WorkerConfig {
  // 'answer' (default) runs a task. 'maintain' only reduces the stored projection ahead of the next turn:
  // no input, no answering model, no tools; it saves through `snapshot`, reports `done` and exits. It has no task.
  mode?: "answer" | "maintain";
  taskId?: string; conversationId: string; runtimeId: string; generation: number; dir: string;
  provider: string; endpoint: string; model: string; apiKey: string; systemPrompt: string; volatilePrompt: string;
  contextWindow: number; maxOutputTokens: number;
  // Window of the tidy-up model, which every summarizer request goes to (digests, turn summaries, episode archives).
  // Summarizer batches and window checks are sized by it, not by the chat model's window. Defaults to contextWindow.
  tidyWindow?: number;
  // Working context budget in tokens (resolved and clamped by Core); reduction starts here, not at the window.
  contextBudget?: number;
  // Set by Core when the input that opens this run's turn also opens a new episode (a 6 h gap or an explicit
  // new topic): before the first model request the worker closes the previous episode (see closeEpisode).
  episode?: { reason: "gap" | "topic"; inputId: string };
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
  // What a compact request is for: a single tool result digest (plain text), a summary of earlier turns
  // (JSON {workingNote, history}, the default) or the archive of a closed episode (structured JSON).
  summaryKind?: "result" | "history" | "episode";
  // The episode a summaryKind 'episode' request closes: its entry range and times (from the entries' own timestamps).
  episode?: { firstEntry: string; lastEntry: string; startedAt: number; endedAt: number };
  cacheRead?: number; cacheWrite?: number;
  // The worker's own estimate of the request this receipt (inputTokens) belongs to.
  estimatedTokens?: number;
}
export interface WorkerReply { type: "start" | "reply" | "steer" | "stop"; config?: WorkerConfig; requestId?: string; result?: unknown; error?: string; input?: RuntimeInput }
