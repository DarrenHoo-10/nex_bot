import { CoreStore, id, now } from './store.ts';
import { toAnthropic, fromAnthropic } from './memory-gateway.ts';

import { tokens } from './token-estimate.ts';
export { tokens } from './token-estimate.ts';
export function jsonObject(value: string): Record<string, unknown> {
  const result = JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('模型未返回有效结构');
  return result;
}
/** Hard cap on the tokens one assistant's background memory work may use per day, whatever its setting says. */
export const MEMORY_DAILY_TOKENS = 500_000;
export const MEMORY_BUDGET_EXHAUSTED = '今日记忆维护预算已用完';
/** The budget enforced for a saved setting: "0 = unlimited" and anything above the hard cap both mean the cap. */
export const effectiveDailyBudget = (setting: number) => setting > 0 ? Math.min(setting, MEMORY_DAILY_TOKENS) : MEMORY_DAILY_TOKENS;
/** Tokens (actual when known, else reserved) a day of background context maintenance may use per conversation. */
export const MAINTAIN_DAILY_TOKENS = 500_000;
const spent = "COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN input_tokens+output_tokens ELSE reserved_tokens END),0)";
/** Tokens an assistant's background memory work has used since local midnight (what its daily budget is counted against). */
export function memoryUsage(store: CoreStore, botId: string): number {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return Number(store.get(`SELECT ${spent} n FROM assistant_usage WHERE bot_id=? AND task_id IS NULL AND purpose NOT IN ('maintain','embed','rerank') AND created_at>=?`, botId, start.getTime())!.n);
}
/** Maintenance tokens one conversation has used since local midnight. */
export function maintainUsage(store: CoreStore, conversationId: string): number {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return Number(store.get(`SELECT ${spent} n FROM assistant_usage WHERE conversation_id=? AND purpose='maintain' AND created_at>=?`, conversationId, start.getTime())!.n);
}
/** The model stopped at its output cap (`finish_reason=length`); `partial` is what it wrote. Callers that can use a partial text ask for it with `allowTruncated`. */
export class TruncatedOutput extends Error {
  constructor(readonly partial: string) { super('模型整理未完整结束，原文已保留'); }
}
/** The daily allowance of background work is spent: no fault of the target being summarized. */
export class BudgetSpent extends Error {}
interface CompletionArgs { botId: string; taskId?: string; conversationId?: string; purpose: string; model?: string; instruction: string; content: string; maxOutput?: number; signal?: AbortSignal; dailyBudget?: number; maintainBudget?: number }
export async function assistantCompletion(store: CoreStore, args: CompletionArgs & { allowTruncated: true }): Promise<{ text: string; truncated: boolean }>;
export async function assistantCompletion(store: CoreStore, args: CompletionArgs & { allowTruncated?: false }): Promise<string>;
export async function assistantCompletion(store: CoreStore, args: CompletionArgs & { allowTruncated?: boolean }): Promise<string | { text: string; truncated: boolean }> {
  const model = store.modelConfig(args.botId);
  if (args.model) model.model = args.model;
  const limits = store.modelLimitSettings(model);
  const maximum = Math.min(args.maxOutput ?? 4096, limits.maxOutputTokens, Math.floor(limits.contextWindow / 4));
  const reserved = tokens(args.instruction + args.content) + 128 + maximum;
  if (reserved > limits.contextWindow - 256) throw new Error('待整理内容超出模型窗口，请选择更大窗口的模型');
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const invoice = id();
  store.transaction(() => {
    // Memory work (task_id IS NULL) is budgeted per assistant per day; background context maintenance has no task
    // either but has its own per-conversation cap, so it neither consumes nor is blocked by the memory budget.
    // Embedding and rerank calls (retrieval.ts) are tracked in the same table but have their own, separate cap.
    const used = Number(store.get(`SELECT ${spent} n FROM assistant_usage WHERE bot_id=? AND task_id IS NULL AND purpose NOT IN ('maintain','embed','rerank') AND created_at>=?`, args.botId, start.getTime())!.n);
    if (args.dailyBudget !== undefined && used + reserved > effectiveDailyBudget(args.dailyBudget)) throw new BudgetSpent(MEMORY_BUDGET_EXHAUSTED);
    if (args.maintainBudget !== undefined && maintainUsage(store, args.conversationId ?? '') + reserved > args.maintainBudget) throw new BudgetSpent('今日后台整理预算已用完');
    store.insert('assistant_usage', { id: invoice, bot_id: args.botId, task_id: args.taskId ?? null, conversation_id: args.conversationId ?? null, purpose: args.purpose, model: model.model, status: 'running', reserved_tokens: reserved, created_at: now() });
  });
  try {
    let payload: Record<string, unknown> = { model: model.model, messages: [{ role: 'system', content: args.instruction }, { role: 'user', content: args.content }], max_tokens: maximum, stream: false };
    let suffix = '/chat/completions', headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` };
    if (model.provider === 'anthropic') {
      payload = toAnthropic(payload); suffix = new URL(model.endpoint).pathname.replace(/\/$/, '').endsWith('/v1') ? '/messages' : '/v1/messages';
      headers = { 'Content-Type': 'application/json', 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' };
    }
    const response = await fetch(model.endpoint.replace(/\/$/, '') + suffix, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(90000), ...(args.signal ? [args.signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`模型服务返回 ${response.status}`); }
    const body = await response.text(); if (body.length > 2_000_000) throw new Error('模型响应过大');
    const raw = JSON.parse(body);
    const value = model.provider === 'anthropic' ? fromAnthropic(raw, payload) : raw;
    const usage = raw.usage;
    const number = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : null;
    const cacheRead = number(model.provider === 'anthropic' ? usage?.cache_read_input_tokens : usage?.prompt_tokens_details?.cached_tokens);
    const cacheWrite = number(model.provider === 'anthropic' ? usage?.cache_creation_input_tokens : usage?.prompt_tokens_details?.cache_creation_tokens);
    const baseInput = number(model.provider === 'anthropic' ? usage?.input_tokens : usage?.prompt_tokens);
    const totalInput = baseInput === null ? null : baseInput + (model.provider === 'anthropic' ? (cacheRead ?? 0) + (cacheWrite ?? 0) : 0);
    store.run("UPDATE assistant_usage SET status='succeeded',input_tokens=?,output_tokens=?,cache_read=?,cache_write=?,finished_at=? WHERE id=?", totalInput, number(model.provider === 'anthropic' ? usage?.output_tokens : usage?.completion_tokens), cacheRead, cacheWrite, now(), invoice);
    const choice = (value.choices as Array<{ finish_reason: string; message: { content: string } }> | undefined)?.[0];
    const written = choice?.message?.content;
    // A cut-off answer is still a paid, valid receipt; only callers that asked for it get the partial text.
    if (choice?.finish_reason === 'length' && written?.trim()) {
      if (args.allowTruncated) return { text: written, truncated: true };
      throw new TruncatedOutput(written);
    }
    if (choice?.finish_reason !== 'stop' || !written?.trim()) throw new Error('模型整理未完整结束，原文已保留');
    return args.allowTruncated ? { text: written, truncated: false } : written;
  } catch (error) {
    store.run("UPDATE assistant_usage SET status=CASE WHEN status='succeeded' THEN 'invalid' ELSE 'unknown' END,finished_at=? WHERE id=?", now(), invoice);
    throw error;
  }
}
