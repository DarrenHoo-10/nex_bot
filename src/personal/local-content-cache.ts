import type { State } from "./api";

type Row = { key: string; scope: string; size: number; used: number; value: unknown };
type Write = { scope: string; key: string; value: unknown };
const maxEntry = 2 * 1024 * 1024;
const maxTotal = 32 * 1024 * 1024;
const maxRows = 160;
const maxQueued = 16;
let store: Promise<IDBDatabase | undefined> | undefined;
let active: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let writing = false;
let queue: Write[] = [];
let cleanup = false;

function database() {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  return store ??= new Promise<IDBDatabase | undefined>((resolve) => {
    const request = indexedDB.open("nexbot-private-cache-v1", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("records", { keyPath: "key" });
      db.createObjectStore("sizes", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => resolve(undefined);
  }).catch(() => undefined);
}

function valueSize(value: unknown): number {
  const pending = [value];
  let size = 0;
  while (pending.length && size <= maxEntry) {
    const part = pending.pop();
    size += 16;
    if (part instanceof Blob) size += part.size;
    else if (typeof part === "string") size += part.length * 2;
    else if (part && typeof part === "object") {
      for (const [key, child] of Object.entries(part)) {
        size += key.length * 2;
        pending.push(child);
      }
    }
  }
  return size;
}

function batch(db: IDBDatabase, write: Write | undefined, purge: boolean) {
  return new Promise<void>((resolve) => {
    const transaction = db.transaction(["records", "sizes"], "readwrite");
    const records = transaction.objectStore("records");
    const sizes = transaction.objectStore("sizes");
    transaction.oncomplete = transaction.onabort = transaction.onerror = () => resolve();
    const discard = (key: string) => { records.delete(key); sizes.delete(key); };
    if (write && write.scope === active) {
      const size = valueSize(write.value);
      if (size <= maxEntry) {
        const { key, scope, value } = write;
        const meta = { key, scope, size, used: Date.now() };
        records.put({ ...meta, value });
        sizes.put(meta);
      }
    }
    const scan = sizes.getAll();
    scan.onsuccess = () => {
      let bytes = 0;
      let count = 0;
      for (const row of (scan.result as Omit<Row, "value">[]).sort((a, b) => b.used - a.used)) {
        if ((purge && row.scope !== active) || bytes + row.size > maxTotal || count >= maxRows) {
          discard(row.key);
        } else { bytes += row.size; count++; }
      }
    };
  });
}

function schedule() {
  if (timer !== undefined || writing || (!cleanup && !queue.length)) return;
  // This runs after rendering and never participates in the login or fetch promise.
  timer = setTimeout(() => {
    timer = undefined;
    writing = true;
    void (async () => {
      const db = await database();
      const purge = cleanup;
      cleanup = false;
      const write = queue.shift();
      if (db) await batch(db, write, purge);
    })().catch(() => {}).finally(() => { writing = false; schedule(); });
  }, 250);
}

export function authorizeLocalCache(sync: State["sync"], sessionId: string | undefined) {
  if (!sessionId || !sync?.coreId || !sync.bootId || !Number.isSafeInteger(sync.privacyEpoch)) return;
  const scope = JSON.stringify([sessionId, sync.coreId, sync.bootId, sync.privacyEpoch]);
  if (scope === active) return;
  active = scope;
  queue = [];
  cleanup = true;
  schedule();
}

export function clearLocalCache() {
  active = undefined;
  queue = [];
  cleanup = true;
  schedule();
}

export async function purgeLocalCache() {
  clearLocalCache();
  const db = await database();
  if (db) await batch(db, undefined, true).catch(() => {});
}

export function localCacheScope() { return active; }

export function queueLocalCache(scope: string | undefined, key: string, value: unknown) {
  if (!scope || scope !== active) return;
  const fullKey = JSON.stringify([scope, key]);
  queue = [...queue.filter((item) => item.key !== fullKey), { scope, key: fullKey, value }].slice(-maxQueued);
  schedule();
}

export async function readLocalCache<T>(scope: string | undefined, key: string): Promise<T | undefined> {
  if (!scope || scope !== active) return;
  const lookup = async () => {
    const db = await database();
    if (!db || scope !== active) return;
    const row = await new Promise<Row | undefined>((resolve) => {
      const request = db.transaction("records").objectStore("records").get(JSON.stringify([scope, key]));
      request.onsuccess = () => resolve(request.result as Row | undefined);
      request.onerror = () => resolve(undefined);
    });
    if (scope === active) return row?.value as T | undefined;
  };
  let deadline: number | undefined;
  try {
    return await Promise.race([
      lookup(),
      new Promise<undefined>((resolve) => { deadline = window.setTimeout(() => resolve(undefined), 80); }),
    ]);
  } catch { /* A disabled or full cache must not affect the app. */ }
  finally { window.clearTimeout(deadline); }
}
