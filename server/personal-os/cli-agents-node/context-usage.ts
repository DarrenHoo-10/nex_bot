// How full a session's context is, from what its CLI wrote down: the tokens the last request sent and,
// where the CLI says, the window they count against.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CliContextUsage } from "../../../shared/cli-agents.ts";

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** A Claude assistant record's `message.usage`: everything the request carried, plus what it wrote, which the next one carries. */
export function claudeUsed(usage: unknown): number {
  const u = rec(usage);
  if (!u) return 0;
  return count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens) + count(u.output_tokens);
}

/** A Codex `token_count` event's payload: the last request's tokens and the model's window. */
export function codexContext(payload: unknown): CliContextUsage | undefined {
  const info = rec(rec(payload)?.info);
  const last = rec(info?.last_token_usage);
  if (!last) return undefined;
  const used = count(last.total_tokens) || count(last.input_tokens) + count(last.output_tokens);
  if (!used) return undefined;
  const window = count(info?.model_context_window);
  return { used, ...(window ? { window } : {}) };
}

const settingsCache = new Map<string, { mtimeMs: number; value: Rec | null }>();
function settings(configDir: string): Rec | null {
  const file = path.join(configDir, "settings.json");
  try {
    const { mtimeMs } = statSync(file);
    const cached = settingsCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.value;
    const value = rec(JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""))) ?? null;
    settingsCache.set(file, { mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

const MILLION = 1_000_000, DEFAULT_WINDOW = 200_000;

const ONE_M = /\[1m\]$/i;

/** Claude's transcripts do not name the window, in this order: the settings' window for the model, a model run with
 * `[1m]` (the desktop app's own record of the session keeps the suffix the transcript drops), the settings' compaction
 * window for all models, the context cap in the environment, a 1M (`[1m]`) default model, else 200K, or 1M once the
 * session has gone past 200K. A general compaction setting is when Claude compacts, not the window of a 1M model. */
export function claudeWindow(configDir: string, model: string | undefined, used: number, env: NodeJS.ProcessEnv = process.env, launched?: string): number {
  const s = settings(configDir);
  const models = rec(s?.modelSettings);
  for (const name of [model, launched, launched?.replace(ONE_M, "")]) {
    const perModel = name ? count(rec(models?.[name])?.autoCompactWindow) : 0;
    if (perModel) return perModel;
  }
  const cap = Number(rec(s?.env)?.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  const capped = Number.isFinite(cap) && cap > 0 ? Math.round(cap) : 0;
  if (launched && ONE_M.test(launched)) return capped ? Math.min(MILLION, capped) : MILLION;
  const all = count(s?.autoCompactWindow);
  if (all) return all;
  if (capped) return capped;
  if (typeof s?.model === "string" && ONE_M.test(s.model)) return MILLION;
  return used > DEFAULT_WINDOW ? MILLION : DEFAULT_WINDOW;
}

/** Tests: forget read settings files. */
export function resetContextSettings(): void { settingsCache.clear(); }
