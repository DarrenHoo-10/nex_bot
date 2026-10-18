import { ModelCatalogStore, type ModelCatalogOptions } from "../model-catalog/catalog.ts";
import type { CatalogModel, CatalogProviders } from "../model-catalog/trim.ts";

export const DEFAULT_MODEL_LIMITS = { contextWindow: 64_000, maxOutputTokens: 8192 };
export type ModelLimitOverrides = { contextWindow: number | null; maxOutputTokens: number | null };
export type ModelCatalogConfig = Pick<ModelCatalogOptions, "fetch" | "fetchDisabled" | "readSnapshot" | "now" | "log">;

export function modelInputBudget(contextWindow: number, maxOutputTokens: number): number {
  // This is an output ceiling, not space every answer must consume. Some
  // catalogs legitimately publish output == context; the SDK clamps each
  // actual request to the remaining window. Reserve bounded working room.
  const reserve = Math.min(maxOutputTokens, 21_000, Math.floor(contextWindow / 4));
  return Math.max(1, Math.floor(Math.min(contextWindow * 0.8, contextWindow - reserve - Math.min(2048, contextWindow * 0.05))));
}

export function validateModelLimits(limits: { contextWindow: number; maxOutputTokens: number }) {
  if (limits.maxOutputTokens > limits.contextWindow) throw new Error("最大输出 Token 不能大于上下文窗口");
}

export function modelLimitScope(input: Record<string, unknown>) {
  if (!["openai", "anthropic"].includes(String(input.provider))) throw new Error("请选择 API 协议");
  if (typeof input.endpoint !== "string" || input.endpoint.length > 2048) throw new Error("请输入有效的 API 基础地址");
  const url = new URL(input.endpoint);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("请使用 HTTPS 地址，本机服务可使用 HTTP");
  if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200) throw new Error("请输入模型 ID");
  return { provider: String(input.provider), endpoint: url.toString().replace(/\/+$/, ""), model: input.model.trim() };
}

export function parseModelLimit(value: unknown, field: keyof ModelLimitOverrides): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < (field === "contextWindow" ? 1024 : 1) || number > 10_000_000) throw new Error(field === "contextWindow" ? "上下文窗口须为 1,024 至 10,000,000 的整数" : "最大输出 Token 须为 1 至 10,000,000 的整数");
  return number;
}

/** Exact IDs only. Prefer the actual endpoint, then an explicitly named or
 * canonical vendor. Conflicting third-party definitions are never guessed. */
export function matchModelLimits(providers: CatalogProviders, model: string, endpoint: string): { model?: CatalogModel; matched?: string; ambiguous?: boolean } {
  const matches: Array<{ model: CatalogModel; matched: string; rank: number }> = [];
  const slash = model.indexOf("/");
  const namespace = slash > 0 && Object.hasOwn(providers, model.slice(0, slash)) ? model.slice(0, slash) : undefined;
  const localId = namespace ? model.slice(slash + 1) : model;
  const vendor = namespace ?? (model.startsWith("claude-") ? "anthropic" : /^(gpt-|o[134](?:-|$))/.test(model) ? "openai" : model.startsWith("grok-") ? "xai" : model.startsWith("gemini-") ? "google" : undefined);
  for (const provider of Object.values(providers)) {
    const candidate = Object.hasOwn(provider.models, model) ? provider.models[model] : provider.id === namespace && Object.hasOwn(provider.models, localId) ? provider.models[localId] : undefined;
    if (!candidate?.limit || !Number.isSafeInteger(candidate.limit.context) || candidate.limit.context < 1024 || candidate.limit.context > 10_000_000) continue;
    const rank = provider.api?.replace(/\/+$/, "") === endpoint ? 3 : provider.id === vendor ? 2 : 1;
    matches.push({ model: candidate, matched: `${provider.id}/${candidate.id}`, rank });
  }
  if (!matches.length) return {};
  const best = matches.filter(match => match.rank === Math.max(...matches.map(m => m.rank)));
  if (new Set(best.map(m => JSON.stringify(m.model.limit))).size > 1) return { ambiguous: true };
  return best[0];
}

export class ModelLimits {
  readonly catalog: ModelCatalogStore;
  constructor(dir: string, options: ModelCatalogConfig = {}) {
    this.catalog = new ModelCatalogStore({ dataDir: dir, openCodeCachePath: null, ...options });
  }
  resolve(scope: ReturnType<typeof modelLimitScope>, manual: ModelLimitOverrides) {
    const catalog = this.catalog.get();
    const match = matchModelLimits(catalog.providers, scope.model, scope.endpoint);
    const contextWindow = manual.contextWindow ?? match.model?.limit?.context ?? DEFAULT_MODEL_LIMITS.contextWindow;
    const output = match.model?.limit?.output;
    const detectedOutput = output && Number.isSafeInteger(output) && output > 0 && output <= (match.model?.limit?.context ?? 0) ? output : undefined;
    const maxOutputTokens = manual.maxOutputTokens ?? Math.min(detectedOutput ?? DEFAULT_MODEL_LIMITS.maxOutputTokens, contextWindow);
    return { manual, contextWindow, maxOutputTokens, matched: match.matched ?? null,
      status: match.ambiguous ? "ambiguous" : match.model ? "matched" : "unknown",
      source: { contextWindow: manual.contextWindow !== null ? "manual" : match.model ? "models.dev" : "default", maxOutputTokens: manual.maxOutputTokens !== null ? "manual" : detectedOutput ? "models.dev" : "default" },
      updatedAt: catalog.updatedAt || null };
  }
}
