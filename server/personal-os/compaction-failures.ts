import type { FileEntry } from '@earendil-works/pi-coding-agent';
import type { CoreStore } from './store.ts';
import { contextEntries } from './context-tools.ts';

// Compaction targets whose summary failed. A target is `entry:<id>` (one tool result) or `range:<first>..<last>`
// (a history batch: the first source entry of the fold up to the last of the batch). The original always stays;
// the record only keeps Core from asking the summarizer for the same thing again and again.
/** Wait after the 1st failure and after the 2nd; from the 3rd on the target is given up. */
export const BACKOFF_MS = [30 * 60_000, 6 * 3_600_000] as const;
/** `next_at` of a target that is not retried any more. */
export const GIVEN_UP = Number.MAX_SAFE_INTEGER;
/** Two failed maintenance runs in a row pause the conversation's background maintenance for this long. */
export const MAINTENANCE_PAUSE_MS = 6 * 3_600_000;

export class CompactionFailures {
  constructor(private readonly store: Pick<CoreStore, 'get' | 'all' | 'run'>, private readonly clock: () => number = Date.now) {}
  /** Notes one more failure of the target and sets its next allowed attempt. Returns the attempt count. */
  record(runtimeId: string, target: string, error: string): number {
    const at = this.clock(), attempts = Number(this.store.get('SELECT attempts FROM compaction_failures WHERE runtime_id=? AND target=?', runtimeId, target)?.attempts ?? 0) + 1;
    const nextAt = attempts > BACKOFF_MS.length ? GIVEN_UP : at + BACKOFF_MS[attempts - 1];
    this.store.run('INSERT INTO compaction_failures(runtime_id,target,attempts,next_at,last_error,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(runtime_id,target) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at,last_error=excluded.last_error,updated_at=excluded.updated_at', runtimeId, target, attempts, nextAt, error.slice(0, 500), at);
    return attempts;
  }
  clear(runtimeId: string, target: string) { this.store.run('DELETE FROM compaction_failures WHERE runtime_id=? AND target=?', runtimeId, target); }
  /** Targets that may not be tried now: inside their backoff window or given up. */
  blocked(runtimeId: string): Set<string> {
    return new Set(this.store.all('SELECT target FROM compaction_failures WHERE runtime_id=? AND next_at>?', runtimeId, this.clock()).map((row) => String(row.target)));
  }
  /** Records of a runtime, for inspection. */
  list(runtimeId: string) { return this.store.all('SELECT target,attempts,next_at,last_error FROM compaction_failures WHERE runtime_id=? ORDER BY target', runtimeId); }
  /** Drops the records of targets that left the model context (folded under a compaction): their summary is moot. */
  prune(runtimeId: string, entries: FileEntry[]) {
    const rows = this.store.all('SELECT target FROM compaction_failures WHERE runtime_id=?', runtimeId);
    if (!rows.length) return;
    const live = new Set(contextEntries(entries).map((entry) => entry.id));
    for (const row of rows) {
      const target = String(row.target), id = target.startsWith('entry:') ? target.slice(6) : target.startsWith('range:') ? target.slice(6).split('..')[0] : '';
      if (!live.has(id)) this.clear(runtimeId, target);
    }
  }
  clearRuntime(runtimeId: string) { this.store.run('DELETE FROM compaction_failures WHERE runtime_id=?', runtimeId); }
  /** Forgetting an assistant removes the records of all its runtimes. */
  clearBot(botId: string) { this.store.run('DELETE FROM compaction_failures WHERE runtime_id IN (SELECT id FROM runtime_sessions WHERE bot_id=?)', botId); }
}
