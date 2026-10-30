import { CoreStore, hash, type Row } from './store.ts';
import { vectorCache } from './vector-cache.ts';
import { visibility } from './topic-access.ts';

// The lexical half of memory retrieval, and the helpers the writers of the pool use to keep indexes and vectors
// in step with their sources. Dependency-free of the network on purpose: sync callers (the episode archive's
// related(), the memory document search) use it directly; the hybrid pipeline is in retrieval.ts.

/** One pool of retrievable text: assistant memories, episode archives, memory documents. */
export type PoolKind = 'memory' | 'episode' | 'document';
export const POOL_KINDS: readonly PoolKind[] = ['memory', 'episode', 'document'];
/** BM25 hands over this many candidates per kind before validity filtering (the cut to 50 happens after it). */
export const BM25_TOP = 50;
const SCAN_LIMIT = 200;
const MAX_TERMS = 128;

/** The text one pool item is indexed under; migration 32 writes the same shape in SQL. */
export const indexBody = (title: string, content: string) => `${title}\n${content}`;

const WORD = /[\p{L}\p{N}_]+(?:[./:@#\\-][\p{L}\p{N}_]+)*/gu;
const CJK_RUN = /([㐀-鿿]+)/;
const CONNECTOR = /[./:@#\\-]/;

/**
 * The terms of a query. `long` ones (3+ characters) can be matched by the trigram index: identifiers whole and in
 * their parts, and every 3 characters of a CJK run. `short` ones (2 characters) cannot, and are matched by
 * substring instead when a query has nothing else.
 */
export function queryTerms(query: string): { long: string[]; short: string[] } {
  const long = new Set<string>(), short = new Set<string>(), single = new Set<string>();
  const add = (term: string) => { if (term.length >= 3) long.add(term); else if (term.length === 2) short.add(term); };
  for (const [word] of query.toLocaleLowerCase().matchAll(WORD)) {
    word.split(CJK_RUN).forEach((piece, index) => {
      if (!piece) return;
      if (index % 2) {
        if (piece.length >= 3) for (let i = 0; i + 3 <= piece.length; i++) long.add(piece.slice(i, i + 3));
        else if (piece.length === 2) short.add(piece);
        else single.add(piece);
      } else {
        add(piece);
        const parts = piece.split(CONNECTOR);
        if (parts.length > 1) parts.forEach(add);
        else if (piece.length === 1) single.add(piece);
      }
    });
  }
  // The most recent terms are the end of the query.
  const result = { long: [...long].slice(-MAX_TERMS), short: [...short].slice(-MAX_TERMS) };
  if (!result.long.length && !result.short.length) result.short = [...single].slice(0, 4);
  return result;
}
/** An FTS5 MATCH expression: every term quoted, any of them may match (BM25 weighs how many and how rare). */
export const matchExpression = (terms: string[]) => terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' OR ');

interface Pool {
  /** The source rows (alias r; documents also c, which holds their content). */
  source: string;
  /** FROM clause: the full-text table joined to the source rows. */
  from: string; select: string; fts: string; columns: string[]; bm25: string;
  /** The rows of this pool one assistant may see. */
  scope(store: CoreStore, botId: string): { where: string; args: string[] };
}
const POOLS: Record<PoolKind, Pool> = {
  memory: {
    source: 'assistant_memories r',
    from: 'assistant_memory_search JOIN assistant_memories r ON r.id=assistant_memory_search.memory_id', select: 'r.*', fts: 'assistant_memory_search', columns: ['body'], bm25: 'bm25(assistant_memory_search)',
    // Its own rows, and the user topics it may read with their facts (topic-access.ts); a user topic it made but may no longer read is not its own any more.
    scope: (store, botId) => {
      const seen = visibility(store, botId);
      if (!seen) return { where: "r.bot_id=? AND r.status='active'", args: [botId] };
      const readable = JSON.stringify(seen.readable);
      return { where: "r.status='active' AND ((r.bot_id=? AND r.id NOT IN (SELECT value FROM json_each(?)) AND r.id NOT IN (SELECT memory_id FROM assistant_topic_evidence WHERE topic_id IN (SELECT value FROM json_each(?)))) OR r.id IN (SELECT value FROM json_each(?)) OR r.id IN (SELECT memory_id FROM assistant_topic_evidence WHERE topic_id IN (SELECT value FROM json_each(?))))", args: [botId, JSON.stringify(seen.hidden), JSON.stringify(seen.unreadable), readable, readable] };
    },
  },
  episode: {
    source: 'conversation_episodes r',
    from: 'conversation_episode_search JOIN conversation_episodes r ON r.id=conversation_episode_search.episode_id', select: 'r.*', fts: 'conversation_episode_search', columns: ['body'], bm25: 'bm25(conversation_episode_search)',
    scope: (_store, botId) => ({ where: 'r.bot_id=?', args: [botId] }),
  },
  document: {
    source: 'memory_documents r JOIN memory_content c ON c.document_id=r.id',
    from: 'memory_search JOIN memory_documents r ON r.id=memory_search.document_id JOIN memory_content c ON c.document_id=r.id', select: 'r.*,c.content', fts: 'memory_search', columns: ['title', 'content'], bm25: 'bm25(memory_search,0.0,4.0,1.0)',
    scope: (store, botId) => ({ where: "r.workspace_id=? AND r.owner_user_id=? AND r.status='active' AND (r.scope='workspace' OR r.bot_id=?)", args: [store.workspace, store.owner, botId] }),
  },
};

/** What a pool row is: its title, its text, its reference and when it last changed. */
export function describe(kind: PoolKind, row: Row) {
  if (kind === 'episode') return { title: String(row.title), text: String(row.summary), ref: `episode:${row.id}`, updatedAt: Number(row.ended_at) };
  return { title: String(row.title), text: String(row.content), ref: `memory:${row.id}`, updatedAt: Number(row.updated_at) };
}
/** Characters of one item that are embedded (and so hashed): the head of its title and text. */
export const EMBED_CHARS = 3000;
export function embeddingInput(kind: PoolKind, row: Row) {
  const { title, text } = describe(kind, row);
  return indexBody(title, text).slice(0, EMBED_CHARS);
}
export const embeddingHash = (kind: PoolKind, row: Row) => hash(embeddingInput(kind, row));

export interface Hit { kind: PoolKind; refId: string; row: Row; /** Higher is better; comparable only within a kind. */ score: number }
export interface LexicalOptions { limit?: number; /** Rejects a row (e.g. a memory whose sources no longer verify) before it counts. */ accept?: (kind: PoolKind, row: Row) => boolean }

function fullText(store: CoreStore, pool: Pool, botId: string, terms: { long: string[]; short: string[] }): Row[] {
  const scope = pool.scope(store, botId);
  if (terms.long.length) return store.all(`SELECT ${pool.select},${pool.bm25} AS hit_score FROM ${pool.from} WHERE ${pool.fts} MATCH ? AND ${scope.where} ORDER BY hit_score LIMIT ${SCAN_LIMIT}`, matchExpression(terms.long), ...scope.args);
  if (!terms.short.length) return [];
  // Terms shorter than a trigram cannot be matched by the index: substring match on the same table, best (most terms) first.
  const like = terms.short.flatMap((term) => pool.columns.map((column) => ({ clause: `${pool.fts}.${column} LIKE ? ESCAPE '\\'`, arg: '%' + term.replace(/[\\%_]/g, '\\$&') + '%' })));
  const rows = store.all(`SELECT ${pool.select} FROM ${pool.from} WHERE (${like.map((item) => item.clause).join(' OR ')}) AND ${scope.where} LIMIT ${SCAN_LIMIT}`, ...like.map((item) => item.arg), ...scope.args);
  return rows.map((row): Row => {
    const haystack = (String(row.title) + '\n' + String(row.content ?? row.summary ?? '')).toLocaleLowerCase();
    return { ...row, hit_score: terms.short.filter((term) => haystack.includes(term)).length };
  }).sort((a, b) => Number(b.hit_score) - Number(a.hit_score) || Number(b.updated_at ?? b.ended_at) - Number(a.updated_at ?? a.ended_at));
}

/**
 * BM25 candidates of one assistant over the requested pools, best first: each kind's list is ranked by FTS5 bm25()
 * (or by the number of short terms found), and the lists are interleaved by rank, since scores of different
 * indexes are not comparable.
 */
export function lexicalHits(store: CoreStore, botId: string, query: string, kinds: readonly PoolKind[] = POOL_KINDS, options: LexicalOptions = {}): Hit[] {
  const terms = queryTerms(query), limit = options.limit ?? BM25_TOP;
  const lists = kinds.map((kind) => {
    const hits: Hit[] = [];
    for (const row of fullText(store, POOLS[kind], botId, terms)) {
      if (options.accept && !options.accept(kind, row)) continue;
      const { hit_score: score, ...rest } = row;
      hits.push({ kind, refId: String(row.id), row: rest, score: terms.long.length ? -Number(score) : Number(score) });
      if (hits.length >= limit) break;
    }
    return hits;
  });
  const merged = lists.flatMap((hits) => hits.map((hit, position) => ({ hit, position })));
  merged.sort((a, b) => a.position - b.position || b.hit.score - a.hit.score);
  return merged.slice(0, limit).map((item) => item.hit);
}

/** One visible pool row by id (a document with its content), or undefined. */
export function sourceRow(store: CoreStore, kind: PoolKind, botId: string, refId: string): Row | undefined {
  const pool = POOLS[kind], scope = pool.scope(store, botId);
  return store.get(`SELECT ${pool.select} FROM ${pool.source} WHERE r.id=? AND ${scope.where}`, refId, ...scope.args);
}
/** The stored vectors of one assistant's visible items of a kind that were made by this model with these dimensions. */
export function vectorRows(store: CoreStore, kind: PoolKind, botId: string, model: string, dims: number): Row[] {
  const pool = POOLS[kind], scope = pool.scope(store, botId);
  return store.all(`SELECT v.ref_id,v.vector,v.content_hash FROM memory_vectors v, ${pool.source} WHERE v.kind=? AND v.model=? AND v.dims=? AND r.id=v.ref_id AND ${scope.where}`, kind, model, dims, ...scope.args);
}
export interface PendingEmbedding { kind: PoolKind; refId: string; input: string; hash: string }
/**
 * Items of one assistant that still need a vector under the configured model: none yet, made by another model
 * (or, if dimensions are configured, with others), or made from text that has since changed.
 */
export function pendingEmbeddings(store: CoreStore, botId: string, model: string, dimensions: number | undefined, limit: number): PendingEmbedding[] {
  const pending: PendingEmbedding[] = [];
  for (const kind of POOL_KINDS) {
    const pool = POOLS[kind], scope = pool.scope(store, botId);
    const rows = store.all(`SELECT ${pool.select},v.model v_model,v.dims v_dims,v.content_hash v_hash FROM ${pool.source} LEFT JOIN memory_vectors v ON v.kind=? AND v.ref_id=r.id WHERE ${scope.where} ORDER BY r.rowid DESC`, kind, ...scope.args);
    for (const row of rows) {
      const input = embeddingInput(kind, row), digest = hash(input);
      if (!input.trim()) continue;
      if (row.v_model === model && (!dimensions || row.v_dims === dimensions) && row.v_hash === digest) continue;
      pending.push({ kind, refId: String(row.id), input, hash: digest });
      if (pending.length >= limit) return pending;
    }
  }
  return pending;
}
/** `botId` names the assistant that owns the item; without it (and for documents, which an assistant may share) every assistant's cached vectors go stale (vector-cache.ts). */
export function storeVector(store: CoreStore, item: { kind: PoolKind; refId: string; hash: string }, model: string, vector: Float32Array, at: number, botId?: string) {
  vectorCache(store).invalidate(item.kind === 'document' ? undefined : botId);
  store.run('INSERT INTO memory_vectors(kind,ref_id,model,dims,vector,content_hash,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,ref_id) DO UPDATE SET model=excluded.model,dims=excluded.dims,vector=excluded.vector,content_hash=excluded.content_hash,updated_at=excluded.updated_at', item.kind, item.refId, model, vector.length, packVector(vector), item.hash, at);
}

/** Removes the vectors of items whose text changed or that were deleted, forgotten or redacted. */
export function dropVectors(store: CoreStore, kind: PoolKind, ...ids: string[]) {
  vectorCache(store).invalidate();
  for (const id of ids) store.run('DELETE FROM memory_vectors WHERE kind=? AND ref_id=?', kind, id);
}

export function packVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}
export function unpackVector(blob: unknown, dims: number): Float32Array | undefined {
  if (!(blob instanceof Uint8Array) || blob.byteLength !== dims * 4) return;
  return new Float32Array(blob.slice().buffer);
}
