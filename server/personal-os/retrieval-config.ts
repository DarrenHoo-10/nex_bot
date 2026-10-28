import { CoreStore, now, text, type Row } from './store.ts';
import { embedTexts, type EmbeddingSettings } from './embeddings.ts';
import { rerankDocuments, type RerankFormat, type RerankSettings } from './rerank.ts';

// Where memory retrieval gets its embedding and rerank models. The two are configured independently. Per item:
// the user's own settings (this Core's database, API key encrypted in `secrets`) win; otherwise the server default
// from the process environment; otherwise the item is off (no embedding: BM25 only; no rerank: rank fusion only).

export type RetrievalKind = 'embedding' | 'rerank';
export interface RetrievalDefaults { embedding?: EmbeddingSettings; rerank?: RerankSettings }
export type { EmbeddingSettings, RerankFormat, RerankSettings };
export type RetrievalSource = 'custom' | 'default' | 'disabled';

const SECRET: Record<RetrievalKind, string> = { embedding: 'retrieval-embedding-key', rerank: 'retrieval-rerank-key' };
const MAX_DIMENSIONS = 8192;
const TEST_TIMEOUT_MS = 15_000;

/** Server defaults from the environment (`/etc/nexbot/core.env` in production); invalid or partial settings count as none. */
export function retrievalDefaultsFromEnvironment(env: NodeJS.ProcessEnv = process.env): RetrievalDefaults {
  const value = (name: string) => env[name]?.trim() || undefined;
  const url = (name: string) => {
    const raw = value(name);
    if (!raw) return;
    try { const parsed = new URL(raw); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? raw.replace(/\/+$/, '') : undefined; } catch { return undefined; }
  };
  const defaults: RetrievalDefaults = {};
  const embeddingUrl = url('NEX_EMBEDDINGS_BASE_URL'), embeddingModel = value('NEX_EMBEDDINGS_MODEL');
  if (embeddingUrl && embeddingModel) {
    const dimensions = Number(value('NEX_EMBEDDINGS_DIMENSIONS'));
    defaults.embedding = { baseUrl: embeddingUrl, model: embeddingModel, ...(Number.isSafeInteger(dimensions) && dimensions > 0 && dimensions <= MAX_DIMENSIONS ? { dimensions } : {}), ...(value('NEX_EMBEDDINGS_API_KEY') ? { apiKey: value('NEX_EMBEDDINGS_API_KEY') } : {}) };
  }
  const rerankUrl = url('NEX_RERANK_BASE_URL'), format = value('NEX_RERANK_FORMAT') ?? 'cohere', rerankModel = value('NEX_RERANK_MODEL') ?? '';
  if (rerankUrl && (format === 'cohere' || format === 'tei') && (format === 'tei' || rerankModel)) {
    defaults.rerank = { format, baseUrl: rerankUrl, model: rerankModel, ...(value('NEX_RERANK_API_KEY') ? { apiKey: value('NEX_RERANK_API_KEY') } : {}) };
  }
  return defaults;
}

function checkedBaseUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('请填写服务地址');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('服务地址无效'); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('服务地址须为 HTTPS；本地服务可使用 HTTP localhost');
  return url.toString().replace(/\/+$/, '');
}
const origin = (value: unknown) => { try { return new URL(String(value)).origin; } catch { return ''; } };

export class RetrievalConfig {
  /** Server defaults; set once at startup (service.ts reads them from the environment). */
  defaults: RetrievalDefaults = {};
  constructor(readonly store: CoreStore) {}

  private custom(kind: RetrievalKind): Row | undefined { return this.store.get('SELECT * FROM memory_retrieval_settings WHERE kind=?', kind); }
  private key(kind: RetrievalKind): string | undefined {
    const secret = this.store.get('SELECT ciphertext FROM secrets WHERE id=?', SECRET[kind]);
    return secret ? this.store.decrypt(String(secret.ciphertext)) : undefined;
  }

  /** The embedding model in effect, or undefined when there is none. */
  embedding(): (EmbeddingSettings & { source: 'custom' | 'default' }) | undefined {
    const row = this.custom('embedding');
    if (row) {
      if (!row.enabled) return;
      return { source: 'custom', baseUrl: String(row.base_url), model: String(row.model), ...(row.dimensions ? { dimensions: Number(row.dimensions) } : {}), ...(this.key('embedding') ? { apiKey: this.key('embedding') } : {}) };
    }
    return this.defaults.embedding ? { source: 'default', ...this.defaults.embedding } : undefined;
  }
  /** The reranker in effect, or undefined when there is none. */
  rerank(): (RerankSettings & { source: 'custom' | 'default' }) | undefined {
    const row = this.custom('rerank');
    if (row) {
      if (!row.enabled) return;
      return { source: 'custom', format: row.format === 'tei' ? 'tei' : 'cohere', baseUrl: String(row.base_url), model: String(row.model), ...(this.key('rerank') ? { apiKey: this.key('rerank') } : {}) };
    }
    return this.defaults.rerank ? { source: 'default', ...this.defaults.rerank } : undefined;
  }

  /**
   * What the settings page shows: the effective source and model per item, and the user's own settings. A server
   * default exposes its model name only; no address and no key of any kind is returned.
   */
  view() {
    const item = (kind: RetrievalKind) => {
      const row = this.custom(kind), fallback = this.defaults[kind];
      const source: RetrievalSource = row ? (row.enabled ? 'custom' : 'disabled') : fallback ? 'default' : 'disabled';
      const effective = source === 'custom' ? { model: String(row!.model), ...(kind === 'rerank' ? { format: row!.format === 'tei' ? 'tei' : 'cohere' } : {}) } : source === 'default' ? { model: fallback!.model, ...(kind === 'rerank' ? { format: (fallback as RerankSettings).format } : {}) } : {};
      return {
        source, ...effective, version: Number(row?.version ?? 0),
        default: fallback ? { model: fallback.model, ...(kind === 'rerank' ? { format: (fallback as RerankSettings).format } : {}) } : null,
        custom: row ? { enabled: !!row.enabled, baseUrl: String(row.base_url), model: String(row.model), ...(kind === 'embedding' ? { dimensions: row.dimensions ? Number(row.dimensions) : null } : { format: row.format === 'tei' ? 'tei' : 'cohere' }), hasKey: !!this.store.get('SELECT id FROM secrets WHERE id=?', SECRET[kind]) } : null,
      };
    };
    return { embedding: item('embedding'), rerank: item('rerank') };
  }

  /**
   * Saves one item's custom settings after a test request (embed one text / rerank two documents) succeeds, or
   * (`reset`) drops them so the server default applies again. A blank key keeps the stored one unless the address
   * moved to another origin, where it would otherwise be sent to a server the user did not give it to.
   */
  async save(data: Record<string, unknown>, authorize: () => Promise<void> = async () => {}) {
    const kind = data.kind;
    if (kind !== 'embedding' && kind !== 'rerank') throw new Error('检索设置类型无效');
    const old = this.custom(kind), expected = Number(old?.version ?? 0);
    if (!Number.isSafeInteger(Number(data.version)) || Number(data.version) !== expected) throw new Error('检索设置已变化，请刷新');
    if (data.reset === true) {
      this.store.transaction(() => { this.store.run('DELETE FROM memory_retrieval_settings WHERE kind=?', kind); this.store.run('DELETE FROM secrets WHERE id=?', SECRET[kind]); this.changed(kind, { reset: true }); });
      return this.view();
    }
    if (typeof data.enabled !== 'boolean') throw new Error('启用开关无效');
    const enabled = data.enabled;
    // A switched-off item may be saved half-filled; one that is on must work.
    const blank = !enabled && (typeof data.baseUrl !== 'string' || !data.baseUrl.trim());
    const baseUrl = blank ? '' : checkedBaseUrl(data.baseUrl);
    const format: RerankFormat = data.format === undefined || data.format === null || data.format === '' ? 'cohere' : data.format as RerankFormat;
    if (kind === 'rerank' && format !== 'cohere' && format !== 'tei') throw new Error('重排格式无效');
    const model = typeof data.model === 'string' ? data.model.trim() : '';
    if (model.length > 200) throw new Error('模型名过长');
    if (enabled && !model && (kind === 'embedding' || format === 'cohere')) throw new Error('请填写模型名');
    let dimensions: number | null = null;
    if (kind === 'embedding' && data.dimensions !== undefined && data.dimensions !== null && data.dimensions !== '' && Number(data.dimensions) !== 0) {
      dimensions = Number(data.dimensions);
      if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS) throw new Error(`维度须为 1 至 ${MAX_DIMENSIONS}`);
    }
    const supplied = typeof data.apiKey === 'string' && data.apiKey.trim() ? text(data.apiKey, 8192) : undefined;
    const keep = !supplied && data.clearKey !== true && !!old && origin(old.base_url) === origin(baseUrl);
    const apiKey = supplied ?? (keep ? this.key(kind) : undefined);
    if (enabled) await this.test(kind, { baseUrl, model, dimensions, format, apiKey });
    // The test request crossed an asynchronous boundary: the session must still be valid when the settings are written.
    await authorize();
    this.store.transaction(() => {
      if (Number(this.custom(kind)?.version ?? 0) !== expected) throw new Error('检索设置已变化，请刷新');
      this.store.run('INSERT INTO memory_retrieval_settings(kind,enabled,format,base_url,model,dimensions,version,updated_at) VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(kind) DO UPDATE SET enabled=excluded.enabled,format=excluded.format,base_url=excluded.base_url,model=excluded.model,dimensions=excluded.dimensions,version=version+1,updated_at=excluded.updated_at', kind, enabled ? 1 : 0, kind === 'rerank' ? format : null, baseUrl, model, dimensions, now());
      if (apiKey) this.store.run('INSERT INTO secrets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext', SECRET[kind], this.store.encrypt(apiKey));
      else this.store.run('DELETE FROM secrets WHERE id=?', SECRET[kind]);
      this.changed(kind, { enabled, model, ...(kind === 'rerank' ? { format } : {}) });
    });
    return this.view();
  }
  private changed(kind: RetrievalKind, details: Record<string, unknown>) {
    // A new embedding configuration starts the background vectorization with a clean backoff.
    if (kind === 'embedding') this.store.run("DELETE FROM assistant_memory_steps WHERE step='embed'");
    this.store.audit('memory.retrieval.configure', 'retrieval', kind, { kind, ...details });
  }
  private async test(kind: RetrievalKind, settings: { baseUrl: string; model: string; dimensions: number | null; format: RerankFormat; apiKey?: string }) {
    const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
    try {
      if (kind === 'embedding') {
        const result = await embedTexts({ baseUrl: settings.baseUrl, model: settings.model, ...(settings.dimensions ? { dimensions: settings.dimensions } : {}), ...(settings.apiKey ? { apiKey: settings.apiKey } : {}) }, ['记忆检索连接测试'], signal);
        if (settings.dimensions && result.vectors[0].length !== settings.dimensions) throw new Error(`服务返回 ${result.vectors[0].length} 维，与填写的维度不一致`);
      } else {
        const result = await rerankDocuments({ format: settings.format, baseUrl: settings.baseUrl, model: settings.model, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}) }, '连接测试', ['用于测试的文档一', '用于测试的文档二'], signal);
        if (result.scores.length !== 2) throw new Error('服务返回的排序结果数量不符');
      }
    } catch (error) {
      throw new Error('测试请求失败：' + (signal.aborted ? '连接超时' : error instanceof Error ? error.message : '未知错误'));
    }
  }
}
