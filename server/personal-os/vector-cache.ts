import type { CoreStore } from './store.ts';
import { unpackVector, vectorRows, type PoolKind } from './retrieval-index.ts';

// The vectors of one assistant, kept in memory (docs/plans/user-topics.md section 8.4). A query reads every vector the
// assistant can see; above VECTOR_CACHE_MIN of them the rows are read once and kept as one packed matrix per kind, keyed by
// (assistant, model, dimensions). A write or delete of a vector makes the entries of the assistant stale (they are rebuilt
// on the next query), and all entries together stay under VECTOR_CACHE_BYTES: the least recently used go first. Scores are
// computed exactly as the per-row scan does, so the ranking is identical.

/** Vectors of an assistant above which they are kept in memory. */
export const VECTOR_CACHE_MIN = 2000;
export const VECTOR_CACHE_BYTES = 128 * 1024 * 1024;
/** What an entry costs besides its matrix: the ids and hash held per row. */
const ROW_OVERHEAD = 200;

export interface Scored { kind: PoolKind; refId: string; similarity: number; hash: string }
interface Matrix { kind: PoolKind; refs: string[]; hashes: string[]; data: Float32Array; dims: number }
interface Entry { version: number; matrices: Map<PoolKind, Matrix>; bytes: number }

const size = (matrix: Matrix) => matrix.data.byteLength + matrix.refs.length * ROW_OVERHEAD;

export class VectorCache {
  private readonly entries = new Map<string, Entry>();
  private readonly versions = new Map<string, number>();
  private global = 0;
  /** Assistants whose vectors were found above the threshold: their other kinds are kept as they are read. */
  private readonly large = new Set<string>();
  constructor(public limit = VECTOR_CACHE_BYTES, public minimum = VECTOR_CACHE_MIN) {}

  /** Bytes held by the cache (matrices and their ids). */
  get bytes() { let total = 0; for (const entry of this.entries.values()) total += entry.bytes; return total; }
  /** Whether a usable entry exists for the assistant (a test hook). */
  has(botId: string, model: string, dims: number, kind: PoolKind) { return !!this.fresh(botId, model, dims)?.matrices.has(kind); }
  /** A counter that changes whenever the vectors the assistant can see may have changed. */
  version(botId: string) { return this.global + (this.versions.get(botId) ?? 0); }

  /** A vector of this assistant was written or deleted (a shared item changes every assistant's view: no botId). */
  invalidate(botId?: string) {
    if (botId) this.versions.set(botId, (this.versions.get(botId) ?? 0) + 1); else this.global++;
  }
  /** Forgets everything held for an assistant (it was forgotten). */
  drop(botId: string) {
    this.invalidate(botId); this.large.delete(botId);
    for (const key of this.entries.keys()) if (key.startsWith(botId + '\u0000')) this.entries.delete(key);
  }

  private key(botId: string, model: string, dims: number) { return `${botId}\u0000${model}\u0000${dims}`; }
  private fresh(botId: string, model: string, dims: number): Entry | undefined {
    const key = this.key(botId, model, dims), entry = this.entries.get(key);
    if (!entry) return;
    if (entry.version !== this.version(botId)) { this.entries.delete(key); return; }
    // Least recently used last.
    this.entries.delete(key); this.entries.set(key, entry);
    return entry;
  }
  private evict(keep: string) {
    while (this.bytes > this.limit) {
      const oldest = [...this.entries.keys()].find((key) => key !== keep);
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  /** Every visible vector of the kinds scored against `query`, best first (ties in the order the rows were read). */
  scan(store: CoreStore, kinds: readonly PoolKind[], botId: string, model: string, query: Float32Array): Scored[] {
    const dims = query.length, key = this.key(botId, model, dims);
    let entry = this.fresh(botId, model, dims);
    const missing = kinds.filter((kind) => !entry?.matrices.has(kind));
    const loaded = new Map<PoolKind, Matrix>();
    if (missing.length) {
      const rows = new Map<PoolKind, ReturnType<typeof vectorRows>>(), version = this.version(botId);
      for (const kind of missing) rows.set(kind, vectorRows(store, kind, botId, model, dims));
      const total = [...rows.values()].reduce((sum, list) => sum + list.length, 0) + [...(entry?.matrices.values() ?? [])].reduce((sum, matrix) => sum + matrix.refs.length, 0);
      const keep = total > this.minimum || this.large.has(botId);
      for (const [kind, list] of rows) {
        const refs: string[] = [], hashes: string[] = [], data = new Float32Array(list.length * dims);
        for (const row of list) {
          const vector = unpackVector(row.vector, dims);
          if (!vector) continue;
          data.set(vector, refs.length * dims); refs.push(String(row.ref_id)); hashes.push(String(row.content_hash));
        }
        loaded.set(kind, { kind, refs, hashes, data: refs.length * dims === data.length ? data : data.slice(0, refs.length * dims), dims });
      }
      if (keep) {
        this.large.add(botId);
        if (!entry) entry = { version, matrices: new Map(), bytes: 0 };
        for (const [kind, matrix] of loaded) entry.matrices.set(kind, matrix);
        entry.bytes = [...entry.matrices.values()].reduce((sum, matrix) => sum + size(matrix), 0);
        this.entries.delete(key); this.entries.set(key, entry);
        this.evict(key);
        // One assistant larger than the whole cache is not kept (its next query reads the rows again).
        if (entry.bytes > this.limit) this.entries.delete(key);
      }
    }
    const scored: Scored[] = [];
    for (const kind of kinds) {
      const matrix = loaded.get(kind) ?? entry!.matrices.get(kind)!;
      for (let row = 0, offset = 0; row < matrix.refs.length; row++, offset += dims) {
        let similarity = 0;
        for (let i = 0; i < dims; i++) similarity += matrix.data[offset + i] * query[i];
        scored.push({ kind, refId: matrix.refs[row], similarity, hash: matrix.hashes[row] });
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored;
  }
}

const caches = new WeakMap<CoreStore, VectorCache>();
/** The cache of a store (one per database). */
export function vectorCache(store: CoreStore): VectorCache {
  let cache = caches.get(store);
  if (!cache) caches.set(store, cache = new VectorCache());
  return cache;
}
