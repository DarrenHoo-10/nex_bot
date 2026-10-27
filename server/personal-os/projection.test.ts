import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileEntry } from '@earendil-works/pi-coding-agent';
import { ProjectionStore } from './projection.ts';
import { dropStaleSystemEntries } from './context-tools.ts';

const dirs: string[] = [];
const stores: ProjectionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('nex-projection-')) throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
const file = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'nex-projection-')); dirs.push(dir); return path.join(dir, 'runtime.db'); };
const open = (target: string) => { const store = new ProjectionStore(target); stores.push(store); return store; };
const stamp = '2026-01-01T00:00:00.000Z';
const header = { type: 'session', version: 3, id: 'hdr', timestamp: stamp, cwd: '/' } as unknown as FileEntry;
const entry = (id: string, parentId: string | null, role: string, content = id) => ({ type: 'message', id, parentId, timestamp: stamp, message: { role, content, timestamp: 1 } }) as unknown as FileEntry;
const chain = (count: number): FileEntry[] => [header, ...Array.from({ length: count }, (_, i) => entry(`e${i}`, i ? `e${i - 1}` : null, i % 2 ? 'assistant' : 'user', `内容 ${i}`))];
const rows = (store: ProjectionStore, runtime: string) => store.db.prepare('SELECT seq,entry_id,json FROM projection_entries WHERE runtime_id=? ORDER BY seq').all(runtime) as Array<{ seq: number; entry_id: string; json: string }>;
const rowids = (store: ProjectionStore, runtime: string) => store.db.prepare('SELECT seq,rowid FROM projection_entries WHERE runtime_id=? ORDER BY seq').all(runtime).map((row) => `${row.seq}:${row.rowid}`);

describe('append-only projection storage', () => {
  it('stores the header as seq 0 and writes only the new tail of an append', () => {
    const store = open(file());
    expect(store.load('r1')).toBeUndefined();
    const first = chain(3);
    store.save('r1', first);
    expect(rows(store, 'r1').map((row) => [row.seq, row.entry_id])).toEqual([[0, 'hdr'], [1, 'e0'], [2, 'e1'], [3, 'e2']]);
    expect(store.load('r1')).toEqual(first);
    const before = rowids(store, 'r1');
    const longer = [...first, entry('e3', 'e2', 'user'), entry('e4', 'e3', 'assistant')];
    store.save('r1', longer);
    // Existing rows were not rewritten (same rowids); two rows were added.
    expect(rowids(store, 'r1').slice(0, before.length)).toEqual(before);
    expect(rows(store, 'r1')).toHaveLength(6);
    expect(store.load('r1')).toEqual(longer);
    // An unchanged list writes nothing.
    const changes = store.db.prepare('SELECT total_changes() n').get()!.n;
    store.save('r1', longer);
    expect(store.db.prepare('SELECT total_changes() n').get()!.n).toBe(changes);
    // Runtimes are independent.
    store.save('r2', chain(1));
    expect(store.load('r1')).toEqual(longer);
    expect(rows(store, 'r2')).toHaveLength(2);
  });
  it('rejects a list without a session header and leaves the stored state alone', () => {
    const store = open(file());
    store.save('r1', chain(2));
    expect(() => store.save('r1', [entry('x', null, 'user')])).toThrow('header');
    expect(store.load('r1')).toEqual(chain(2));
  });
  it('rewrites from the first difference after stale system entries are dropped and re-parented', () => {
    const store = open(file());
    const entries = [header, entry('s1', null, 'system'), entry('u1', 's1', 'user'), entry('a1', 'u1', 'assistant'), entry('s2', 'a1', 'system'), entry('u2', 's2', 'user'), entry('a2', 'u2', 'assistant')];
    store.save('r1', entries);
    const pruned = dropStaleSystemEntries(entries);
    expect(pruned).toHaveLength(entries.length - 1);
    store.save('r1', pruned);
    expect(store.load('r1')).toEqual(pruned);
    expect(rows(store, 'r1').map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows(store, 'r1').map((row) => row.entry_id)).toEqual(['hdr', 'u1', 'a1', 's2', 'u2', 'a2']);
    expect(store.entry('r1', 's1')).toBeUndefined();
    expect((store.entry('r1', 'u1') as { parentId: string | null }).parentId).toBeNull();
    // Appending after the rewrite is append-only again.
    const before = rowids(store, 'r1');
    const next = [...pruned, entry('u3', 'a2', 'user')];
    store.save('r1', next);
    expect(rowids(store, 'r1').slice(0, before.length)).toEqual(before);
    expect(store.load('r1')).toEqual(next);
  });
  it('makes the stored state equal the list for changed content, a shorter list and an unrelated list', () => {
    const store = open(file());
    const base = chain(5);
    store.save('r1', base);
    const edited = base.map((item, index) => index === 3 ? entry('e2', 'e1', 'user', '改过的内容') : item);
    store.save('r1', edited);
    expect(store.load('r1')).toEqual(edited);
    const shorter = edited.slice(0, 3);
    store.save('r1', shorter);
    expect(store.load('r1')).toEqual(shorter);
    expect(rows(store, 'r1')).toHaveLength(3);
    const unrelated = [{ ...header, id: 'other' } as FileEntry, entry('z0', null, 'user'), entry('z1', 'z0', 'assistant')];
    store.save('r1', unrelated);
    expect(store.load('r1')).toEqual(unrelated);
    expect(rows(store, 'r1').map((row) => row.entry_id)).toEqual(['other', 'z0', 'z1']);
  });
  it('rolls a failed save back completely', () => {
    const store = open(file());
    const base = chain(3);
    store.save('r1', base);
    // A duplicate entry id violates the unique index halfway through the insert.
    const duplicate = [...base, entry('n1', 'e2', 'user'), entry('e0', 'n1', 'assistant')];
    expect(() => store.save('r1', duplicate)).toThrow();
    expect(store.load('r1')).toEqual(base);
    expect(store.db.isTransaction).toBe(false);
  });
  it('looks up one original entry by id, never the session header, scoped to its runtime', () => {
    const store = open(file());
    const entries = chain(4);
    store.save('r1', entries);
    store.save('r2', [{ ...header, id: 'hdr2' } as FileEntry, entry('only-r2', null, 'user')]);
    expect(store.entry('r1', 'e2')).toEqual(entries[3]);
    expect(store.entry('r1', 'hdr')).toBeUndefined();
    expect(store.entry('r1', 'missing')).toBeUndefined();
    expect(store.entry('r1', 'only-r2')).toBeUndefined();
    expect(store.entry('r2', 'only-r2')).toBeDefined();
    expect(store.entry('nobody', 'e2')).toBeUndefined();
  });
  it('clears a runtime from both tables only', () => {
    const target = file();
    const legacy = new DatabaseSync(target);
    legacy.exec('CREATE TABLE projections(id TEXT PRIMARY KEY, entries TEXT NOT NULL) STRICT');
    legacy.prepare('INSERT INTO projections VALUES(?,?)').run('r1', JSON.stringify(chain(2)));
    legacy.prepare('INSERT INTO projections VALUES(?,?)').run('r2', JSON.stringify(chain(1)));
    legacy.close();
    const store = open(target);
    store.save('r3', chain(1));
    store.clear('r1');
    expect(store.load('r1')).toBeUndefined();
    expect(store.db.prepare("SELECT COUNT(*) n FROM projections WHERE id='r1'").get()!.n).toBe(0);
    expect(rows(store, 'r1')).toHaveLength(0);
    expect(store.load('r2')).toEqual(chain(1));
    expect(store.load('r3')).toEqual(chain(1));
    store.clear('r3');
    expect(store.load('r3')).toBeUndefined();
  });
});

describe('migration from the legacy blob table', () => {
  const seed = (target: string, blobs: Record<string, string>) => {
    const legacy = new DatabaseSync(target);
    legacy.exec('CREATE TABLE projections(id TEXT PRIMARY KEY, entries TEXT NOT NULL) STRICT');
    for (const [id, entries] of Object.entries(blobs)) legacy.prepare('INSERT INTO projections VALUES(?,?)').run(id, entries);
    legacy.close();
  };
  it('copies every blob into rows with equal content and leaves the legacy table byte-identical', () => {
    const target = file();
    const big = [...chain(40), { type: 'custom_message', id: 'img', parentId: 'e39', timestamp: stamp, customType: 'nex.input', content: '含图片 \u{1F600} "quote" \\ \n\t', display: false, details: { inputId: 'i', hash: 'h', seq: 1, nested: [1, 2.5, null, { a: true }] } } as unknown as FileEntry];
    const blobs = { r1: JSON.stringify(big), r2: JSON.stringify(chain(1)) };
    seed(target, blobs);
    const store = open(target);
    expect(store.migrationFailures).toEqual([]);
    expect(store.load('r1')).toEqual(big);
    expect(store.load('r2')).toEqual(chain(1));
    expect(rows(store, 'r1').map((row) => row.seq)).toEqual(Array.from({ length: big.length }, (_, i) => i));
    expect('[' + rows(store, 'r1').map((row) => row.json).join(',') + ']').toBe(blobs.r1);
    expect(store.entry('r1', 'img')).toEqual(big.at(-1));
    expect(Object.fromEntries(store.db.prepare('SELECT id,entries FROM projections').all().map((row) => [row.id, row.entries]))).toEqual(blobs);
    // Later saves append rows and never touch the rollback copy.
    store.save('r1', [...big, entry('after', 'img', 'assistant')]);
    expect(store.db.prepare("SELECT entries FROM projections WHERE id='r1'").get()!.entries).toBe(blobs.r1);
    expect(rows(store, 'r1')).toHaveLength(big.length + 1);
  });
  it('migrates only runtimes that have no rows yet and is idempotent across opens', () => {
    const target = file();
    seed(target, { r1: JSON.stringify(chain(2)) });
    const first = open(target);
    const newer = [...chain(2), entry('later', 'e1', 'user')];
    first.save('r1', newer);
    first.close(); stores.pop();
    const second = open(target);
    expect(second.load('r1')).toEqual(newer);
    expect(rows(second, 'r1')).toHaveLength(newer.length);
  });
  it('keeps a blob that cannot be verified served from the legacy table and reports it', () => {
    const target = file();
    // Duplicate entry ids cannot be stored; an invalid header is refused too.
    seed(target, { dup: JSON.stringify([header, entry('a', null, 'user'), entry('a', 'a', 'user')]), bad: JSON.stringify([entry('a', null, 'user')]), good: JSON.stringify(chain(1)) });
    const store = open(target);
    expect(store.migrationFailures.map((failure) => failure.split(':')[0]).sort()).toEqual(['bad', 'dup']);
    expect(rows(store, 'dup')).toHaveLength(0);
    expect(rows(store, 'good')).toHaveLength(2);
    expect(store.load('dup')).toHaveLength(3);
    expect(store.entry('dup', 'a')).toBeDefined();
    expect(store.load('good')).toEqual(chain(1));
    expect(store.db.isTransaction).toBe(false);
  });
});
