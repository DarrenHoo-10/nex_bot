import { CoreStore, hash, id, now, type Row } from './store.ts';
import { clipTokens, tokens } from './token-estimate.ts';
import { RetrievalConfig, type EmbeddingSettings } from './retrieval-config.ts';
import { embedTexts } from './embeddings.ts';
import { rerankDocuments } from './rerank.ts';
import { POOL_KINDS, describe, embeddingHash, lexicalHits, pendingEmbeddings, sourceRow, storeVector, unpackVector, vectorRows, type Hit, type PendingEmbedding, type PoolKind } from './retrieval-index.ts';

// Hybrid retrieval over one pool: assistant memories, episode archives and memory documents.
//   BM25 (FTS5 trigram, top 50)  +  vectors (cosine, top 50)  ->  RRF (k=60, top 20)  ->  rerank (>= 0.3)
// Embedding and rerank are optional and independent; every provider failure degrades to what remains and never
// reaches the caller. See docs/plans/memory-recall.md section 4.7.

export const RRF_K = 60;
export const VECTOR_TOP = 50;
export const FUSED_TOP = 20;
/** Reranker score below which a candidate is dropped. */
export const RERANK_THRESHOLD = 0.3;
export const RERANK_DOC_TOKENS = 512;
/** Whole retrieval, embedding and rerank included. */
export const RETRIEVAL_TIMEOUT_MS = 4000;
/**
 * Without a reranker a candidate found only by vectors needs this cosine similarity to be kept: ranks alone cannot
 * tell "closest of an unrelated pool" from "relevant". (Qwen3-Embedding: paraphrases ~0.7, unrelated text ~0.45.)
 */
export const VECTOR_ONLY_MIN_SIMILARITY = 0.6;
/** Token budget a caller should use for the result: the full one when a reranker vouched for the order, else less. */
export const RECALL_BUDGET = 2000;
export const RECALL_BUDGET_UNRANKED = 1000;
const QUERY_CHARS = 2000;
/** Query embeddings and rerank scores are remembered briefly: both are pure functions of their inputs. */
const CACHE_ENTRIES = 64, CACHE_MS = 5 * 60_000;

export type CandidateKind = PoolKind | 'message' | 'entry';
export interface Candidate {
  kind: CandidateKind;
  /** The id of the record within its kind. */
  refId: string;
  /** The reference a model can expand: `memory:<id>`, `episode:<id>`, `message:<id>` or `entry:<id>`. */
  ref: string;
  title: string; text: string; tokens: number;
  /** The reranker's score when `reranked`, else the rank-fusion score. */
  score: number;
  /** Which stages found it: bm25, vector, rerank, or exact for a direct lookup. */
  sources: string[];
  updatedAt: number;
  /** The source row (documents with their content), for callers that format it themselves. */
  row: Row;
}
export interface RetrievalResult {
  candidates: Candidate[];
  /** A reranker scored the candidates; otherwise the order is rank fusion only and callers should use the smaller budget. */
  reranked: boolean;
  /** Vectors took part. */
  vector: boolean;
  /** The token budget this result deserves (2000, or 1000 without rerank). */
  budget: number;
  /** Stages ('embedding', 'rerank') that were configured but failed or timed out. */
  degraded: string[];
}
export interface RetrieveOptions {
  kinds?: readonly PoolKind[];
  taskId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** At most this many candidates (default 20). */
  limit?: number;
}

export { clipTokens };

export class Retrieval {
  readonly config: RetrievalConfig;
  /** Resolves `entry:<id>` (a run record of the conversation projection); wired by the app, which owns that store. */
  resolveEntry?: (botId: string, entryId: string) => { id: string; content: string } | undefined;
  private readonly queries = new Map<string, { at: number; vector: Float32Array }>();
  private readonly reranks = new Map<string, { at: number; scores: Array<number | undefined> }>();
  /**
   * `valid` decides whether a memory may be recalled at all (it rests on verifiable sources and is a kind that is
   * recalled). `covered` says a fact is already represented by a topic: ranked retrieval skips such a fact, while
   * naming it with `memory:<id>` still opens it.
   */
  constructor(readonly store: CoreStore, readonly valid: (botId: string, row: Row) => boolean = () => true, readonly covered: (botId: string, row: Row) => boolean = () => false) { this.config = new RetrievalConfig(store); }

  private candidate(kind: PoolKind, row: Row, score: number, sources: string[]): Candidate {
    const item = describe(kind, row);
    return { kind, refId: String(row.id), ref: item.ref, title: item.title, text: item.text, tokens: tokens(item.text), score, sources, updatedAt: item.updatedAt, row };
  }
  private accept(botId: string) { return (kind: PoolKind, row: Row) => kind !== 'memory' || (this.valid(botId, row) && !this.covered(botId, row)); }

  /** `entry:` / `message:` / `episode:` / `memory:` name one record: no ranking, no models. */
  private exact(botId: string, query: string): Candidate[] | undefined {
    const match = /^(entry|message|episode|memory):(\S+)$/.exec(query);
    if (!match) return;
    const [, prefix, ident] = match, found: Candidate[] = [];
    const other = (kind: CandidateKind, row: Row, title: string, text: string, ref: string) => found.push({ kind, refId: ident, ref, title, text, tokens: tokens(text), score: 1, sources: ['exact'], updatedAt: Number(row.created_at ?? 0), row });
    if (prefix === 'message') {
      const row = this.store.get("SELECT id,role,content,created_at FROM agent_messages WHERE bot_id=? AND id=? AND content<>'[已遗忘]'", botId, ident);
      if (row) other('message', row, String(row.role), String(row.content), `message:${ident}`);
    } else if (prefix === 'entry') {
      const entry = this.resolveEntry?.(botId, ident);
      if (entry) other('entry', {}, 'entry', entry.content, `entry:${ident}`);
    } else if (prefix === 'episode') {
      const row = sourceRow(this.store, 'episode', botId, ident);
      if (row) found.push(this.candidate('episode', row, 1, ['exact']));
    } else {
      const memory = sourceRow(this.store, 'memory', botId, ident);
      if (memory && this.valid(botId, memory)) found.push(this.candidate('memory', memory, 1, ['exact']));
      const document = sourceRow(this.store, 'document', botId, ident);
      if (document) found.push(this.candidate('document', document, 1, ['exact']));
    }
    return found;
  }

  /** Runs a model call and records it in assistant_usage (purpose embed / rerank; budgeted separately from memory maintenance). */
  private async recorded<T extends { tokens: number | null }>(args: { botId: string; taskId?: string; purpose: 'embed' | 'rerank'; model: string; reserved: number }, run: () => Promise<T>): Promise<T> {
    const usage = id();
    this.store.insert('assistant_usage', { id: usage, bot_id: args.botId, task_id: args.taskId ?? null, purpose: args.purpose, model: args.model || '(default)', status: 'running', reserved_tokens: args.reserved, created_at: now() });
    try {
      const result = await run();
      // A service that reports no usage is billed at the estimate, so the totals stay complete.
      this.store.run("UPDATE assistant_usage SET status='succeeded',input_tokens=?,output_tokens=0,finished_at=? WHERE id=?", result.tokens ?? args.reserved, now(), usage);
      return result;
    } catch (error) {
      try { this.store.run("UPDATE assistant_usage SET status='failed',input_tokens=0,output_tokens=0,finished_at=? WHERE id=?", now(), usage); } catch { /* the database may be closing */ }
      throw error;
    }
  }

  private async queryVector(botId: string, settings: EmbeddingSettings, query: string, signal: AbortSignal, taskId?: string) {
    const key = JSON.stringify([settings.baseUrl, settings.model, settings.dimensions ?? 0, query]), cached = this.queries.get(key);
    if (cached && now() - cached.at < CACHE_MS) return cached.vector;
    const { vectors } = await this.recorded({ botId, taskId, purpose: 'embed', model: settings.model, reserved: tokens(query) }, () => embedTexts(settings, [query], signal));
    this.queries.set(key, { at: now(), vector: vectors[0] });
    this.trim(this.queries);
    return vectors[0];
  }
  private trim(cache: Map<string, unknown>) { while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!); }

  /** The closest vectors, cosine similarity in memory; vectors of changed text and invalid memories are skipped. */
  private vectorHits(botId: string, kinds: readonly PoolKind[], query: Float32Array, model: string): Hit[] {
    const scored: Array<{ kind: PoolKind; refId: string; similarity: number; hash: string }> = [];
    for (const kind of kinds) for (const row of vectorRows(this.store, kind, botId, model, query.length)) {
      const vector = unpackVector(row.vector, query.length);
      if (!vector) continue;
      let similarity = 0;
      for (let i = 0; i < vector.length; i++) similarity += vector[i] * query[i];
      scored.push({ kind, refId: String(row.ref_id), similarity, hash: String(row.content_hash) });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    const accept = this.accept(botId), hits: Hit[] = [];
    for (const item of scored) {
      if (hits.length >= VECTOR_TOP) break;
      const row = sourceRow(this.store, item.kind, botId, item.refId);
      if (!row || embeddingHash(item.kind, row) !== item.hash || !accept(item.kind, row)) continue;
      hits.push({ kind: item.kind, refId: item.refId, row, score: item.similarity });
    }
    return hits;
  }

  async retrieve(botId: string, query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
    const text = query.trim(), kinds = options.kinds ?? POOL_KINDS, degraded: string[] = [];
    if (!text) return { candidates: [], reranked: false, vector: false, budget: RECALL_BUDGET_UNRANKED, degraded };
    const direct = this.exact(botId, text);
    if (direct) return { candidates: direct, reranked: false, vector: false, budget: RECALL_BUDGET, degraded };
    const timeout = options.timeoutMs ?? RETRIEVAL_TIMEOUT_MS;
    const overall = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
    const lexical = lexicalHits(this.store, botId, text, kinds, { accept: this.accept(botId) });

    let vector: Hit[] = [], vectorUsed = false;
    const embedding = this.config.embedding();
    if (embedding && !overall.aborted) {
      try {
        // Half of the time at most: the reranker needs the rest.
        const queryVector = await this.queryVector(botId, embedding, text.slice(-QUERY_CHARS), AbortSignal.any([overall, AbortSignal.timeout(Math.max(1, Math.floor(timeout / 2)))]), options.taskId);
        vector = this.vectorHits(botId, kinds, queryVector, embedding.model); vectorUsed = true;
      } catch { degraded.push('embedding'); }
    }

    const fused = new Map<string, { kind: PoolKind; refId: string; row: Row; rrf: number; sources: string[]; similarity?: number }>();
    for (const [source, hits] of [['bm25', lexical], ['vector', vector]] as const) hits.forEach((hit, index) => {
      const key = `${hit.kind}:${hit.refId}`, entry = fused.get(key) ?? { kind: hit.kind, refId: hit.refId, row: hit.row, rrf: 0, sources: [] };
      entry.rrf += 1 / (RRF_K + index + 1); entry.sources.push(source);
      if (source === 'vector') entry.similarity = hit.score;
      fused.set(key, entry);
    });
    let ranked = [...fused.values()].sort((a, b) => b.rrf - a.rrf || describe(b.kind, b.row).updatedAt - describe(a.kind, a.row).updatedAt).slice(0, FUSED_TOP)
      .map((entry) => ({ ...this.candidate(entry.kind, entry.row, entry.rrf, entry.sources), similarity: entry.similarity }));

    let reranked = false;
    const reranker = this.config.rerank();
    if (reranker && ranked.length && !overall.aborted) {
      try {
        const documents = ranked.map((item) => clipTokens(`${item.title}\n${item.text}`, RERANK_DOC_TOKENS)), clipped = text.slice(-QUERY_CHARS);
        // Scores are a pure function of the model, query and texts, so a repeat (e.g. the next model request of a task) needs no call.
        const key = hash(JSON.stringify([reranker.baseUrl, reranker.model, reranker.format, clipped, documents])), cached = this.reranks.get(key);
        let scores: Array<number | undefined>;
        if (cached && now() - cached.at < CACHE_MS) scores = cached.scores;
        else {
          scores = (await this.recorded({ botId, taskId: options.taskId, purpose: 'rerank', model: reranker.model, reserved: tokens(clipped) + tokens(documents) }, () => rerankDocuments(reranker, clipped, documents, overall))).scores;
          this.reranks.set(key, { at: now(), scores }); this.trim(this.reranks);
        }
        ranked = ranked.flatMap((item, index) => scores[index] !== undefined && scores[index]! >= RERANK_THRESHOLD ? [{ ...item, score: scores[index]!, sources: [...item.sources, 'rerank'] }] : []).sort((a, b) => b.score - a.score);
        reranked = true;
      } catch { degraded.push('rerank'); }
    }
    if (!reranked) ranked = ranked.filter((item) => item.sources.includes('bm25') || (item.similarity ?? 0) >= VECTOR_ONLY_MIN_SIMILARITY);
    return { candidates: ranked.slice(0, options.limit ?? FUSED_TOP).map(({ similarity: _similarity, ...item }) => item), reranked, vector: vectorUsed, budget: reranked ? RECALL_BUDGET : RECALL_BUDGET_UNRANKED, degraded };
  }

  /** Items of an assistant that still need an embedding under the configured model (at most `limit`). */
  pending(botId: string, settings: EmbeddingSettings, limit: number): PendingEmbedding[] {
    return pendingEmbeddings(this.store, botId, settings.model, settings.dimensions, limit);
  }
  /**
   * Embeds up to 32 pending items in one request and stores their vectors. An item whose text changed while the
   * request was out is skipped (it is pending again); a failed request stores nothing and throws.
   */
  async embed(botId: string, settings: EmbeddingSettings, items: PendingEmbedding[], signal?: AbortSignal): Promise<number> {
    if (!items.length) return 0;
    const { vectors } = await this.recorded({ botId, purpose: 'embed', model: settings.model, reserved: tokens(items.map((item) => item.input)) }, () => embedTexts(settings, items.map((item) => item.input), signal));
    return this.store.transaction(() => {
      let stored = 0;
      items.forEach((item, index) => {
        const row = sourceRow(this.store, item.kind, botId, item.refId);
        if (!row || embeddingHash(item.kind, row) !== item.hash) return;
        storeVector(this.store, item, settings.model, vectors[index], now()); stored++;
      });
      return stored;
    });
  }
  /** Tokens spent on embedding by an assistant since local midnight (query and background together). */
  embeddedToday(botId: string): number {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return Number(this.store.get("SELECT COALESCE(SUM(COALESCE(input_tokens,reserved_tokens)),0) n FROM assistant_usage WHERE bot_id=? AND purpose='embed' AND created_at>=?", botId, start.getTime())!.n);
  }
}
