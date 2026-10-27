import { CoreStore, hash, id, now, type Row } from './store.ts';
import { jsonObject } from './assistant-model.ts';
import { tokens } from './token-estimate.ts';
import { matchExpression, relevance, searchTerms } from './search-terms.ts';

// An episode is a stretch of one conversation about one thing. A conversation is continuous for the user, so
// episodes are cut by time (a long gap since the previous user input) or by the user starting a new topic.
// When an episode closes, the worker archives it (one structured summary, validated here) and folds it into a
// short "上一段要点" so the next episode starts from a clean working context. Originals and entry:<id> retrieval
// are untouched; the archive is derived data, searchable as episode:<id> and as text.

/** A user input this long after the previous one opens a new episode. */
export const EPISODE_GAP_MS = 6 * 60 * 60_000;
/** The short summary that stays in the next episode's context. */
export const BRIEF_TOKENS = 300;
/** Recall puts at most this many archive summaries, this many tokens in all, into the volatile reminder. */
export const RECALL_EPISODES = 3;
export const RECALL_TOKENS = 1500;

export interface EpisodeArchive {
  title: string; brief: string; topics: string[];
  decisions: Array<{ decision: string; reason: string }>;
  operations: Array<{ operation: string; outcome: 'success' | 'failure' | 'unknown'; identifiers: string[]; detail: string }>;
  openItems: string[]; refs: string[];
  /** The updated working note the summarizer offers; Core applies it with the version check. */
  workingNote?: string;
}

function clipTokens(value: string, limit: number) {
  if (tokens(value) <= limit) return value;
  let end = value.length;
  while (end > 0 && tokens(value.slice(0, end) + '…') > limit) end = Math.floor(end * .9);
  return value.slice(0, end) + '…';
}
const invalid = (detail: string) => new Error(`段落档案无效（${detail}），原段落保持打开`);

/**
 * Validates the summarizer's archive. Structure problems make it invalid (the episode then stays open);
 * references to entries that are not in the conversation are dropped rather than trusted.
 */
export function parseArchive(output: string, known: Set<string>): EpisodeArchive {
  let value: Record<string, unknown>;
  try { value = jsonObject(output); } catch { throw invalid('不是 JSON 对象'); }
  const str = (item: unknown, max: number) => typeof item === 'string' ? item.trim().slice(0, max) : '';
  const list = (item: unknown, name: string, max: number): unknown[] => { if (!Array.isArray(item)) throw invalid(`缺少 ${name}`); return item.slice(0, max); };
  const title = str(value.title, 120), brief = clipTokens(str(value.brief, 4000), BRIEF_TOKENS);
  if (!title || !brief) throw invalid('缺少标题或要点');
  const object = (item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
  const outcome = (item: unknown): 'success' | 'failure' | 'unknown' => {
    const word = String(item ?? '').trim().toLowerCase();
    return /^(success|succeeded|ok|done|成功|完成)$/.test(word) ? 'success' : /^(fail|failure|failed|error|失败|错误)$/.test(word) ? 'failure' : 'unknown';
  };
  return {
    title, brief,
    topics: list(value.topics, 'topics', 20).map((item) => str(item, 200)).filter(Boolean),
    decisions: list(value.decisions, 'decisions', 30).flatMap((item) => {
      const entry = typeof item === 'string' ? { decision: item, reason: '' } : object(item);
      const decision = str(entry?.decision, 500);
      return decision ? [{ decision, reason: str(entry?.reason, 500) }] : [];
    }),
    operations: list(value.operations, 'operations', 60).flatMap((item) => {
      const entry = object(item), operation = str(entry?.operation, 300);
      if (!entry || !operation) return [];
      const identifiers = (Array.isArray(entry.identifiers) ? entry.identifiers : [entry.identifiers]).map((one) => str(one, 200)).filter(Boolean).slice(0, 12);
      return [{ operation, outcome: outcome(entry.outcome), identifiers, detail: str(entry.detail, 500) }];
    }),
    openItems: list(value.openItems, 'openItems', 30).map((item) => str(item, 500)).filter(Boolean),
    refs: [...new Set(list(value.refs, 'refs', 100).map((item) => str(item, 200)).filter((ref) => ref.startsWith('entry:') && known.has(ref.slice(6))))],
    workingNote: str(value.workingNote, 6000) || undefined,
  };
}

const outcomeLabel = { success: '成功', failure: '失败', unknown: '结果未知' };
/** The archive as readable text: what search shows, what the memory pump reads and what the index covers. */
export function archiveText(archive: EpisodeArchive): string {
  const lines = [`标题：${archive.title}`, `要点：${archive.brief}`];
  if (archive.topics.length) lines.push(`主题：${archive.topics.join('；')}`);
  if (archive.decisions.length) lines.push('决定：', ...archive.decisions.map((item) => `- ${item.decision}${item.reason ? `（原因：${item.reason}）` : ''}`));
  if (archive.operations.length) lines.push('工具操作：', ...archive.operations.map((item) => `- [${outcomeLabel[item.outcome]}] ${item.operation}${item.identifiers.length ? `（标识：${item.identifiers.join('、')}）` : ''}${item.detail ? ` ${item.detail}` : ''}`));
  if (archive.openItems.length) lines.push('未完成：', ...archive.openItems.map((item) => `- ${item}`));
  if (archive.refs.length) lines.push(`原文引用：${archive.refs.join(' ')}`);
  return lines.join('\n');
}

/** Everything of an archive that a long-term memory may rest on, as one text. Its sha-256 is the source hash. */
export const episodeText = (row: Row) => [row.title, row.summary, row.open_items, row.refs_json, row.detail_json].map(String).join('\n');
export const episodeHash = (row: Row) => hash(episodeText(row));

export class Episodes {
  constructor(readonly store: CoreStore) {}

  /**
   * Whether the fresh input that starts a run opens a new episode: the user said "new topic" before it (a
   * one-shot mark on exactly that input), or it comes 6 h or more after the conversation's previous input.
   * Undefined for a first input and for runs resuming already-applied inputs (steering never opens one).
   */
  boundary(taskId: string): { reason: 'gap' | 'topic'; inputId: string } | undefined {
    const task = this.store.get('SELECT conversation_id FROM tasks WHERE id=?', taskId);
    const opening = this.store.pending(taskId).find((row) => row.runtime_entry_id == null);
    if (!task || !opening) return;
    const conversation = String(task.conversation_id);
    let mark = this.store.get('SELECT input_seq FROM conversation_topic_marks WHERE conversation_id=?', conversation);
    // A mark that an input has already passed can no longer open an episode.
    if (mark && Number(mark.input_seq) < Number(opening.input_seq)) { this.store.run('DELETE FROM conversation_topic_marks WHERE conversation_id=?', conversation); mark = undefined; }
    const previous = this.store.get('SELECT created_at FROM conversation_inputs WHERE conversation_id=? AND input_seq<? ORDER BY input_seq DESC LIMIT 1', conversation, opening.input_seq);
    if (!previous) return;
    const inputId = String(opening.id);
    if (mark && Number(mark.input_seq) === Number(opening.input_seq)) return { reason: 'topic', inputId };
    if (Number(opening.created_at) - Number(previous.created_at) >= EPISODE_GAP_MS) return { reason: 'gap', inputId };
  }

  /** Marks the conversation so that its next input opens a new episode. False when there is nothing to separate yet. */
  markTopic(conversationId: string): boolean {
    const conversation = this.store.get('SELECT next_input_seq FROM conversations WHERE id=? AND status=\'open\'', conversationId);
    if (!conversation || Number(conversation.next_input_seq) <= 1) return false;
    this.store.run('INSERT INTO conversation_topic_marks(conversation_id,input_seq,created_at) VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET input_seq=excluded.input_seq,created_at=excluded.created_at', conversationId, conversation.next_input_seq, now());
    return true;
  }

  /** Stores the archive of a closed episode, replacing an earlier attempt for the same range, and consumes the mark. */
  save(args: { botId: string; conversationId: string; firstEntry: string; lastEntry: string; startedAt: number; endedAt: number; archive: EpisodeArchive }): string {
    const { archive } = args, summary = archiveText(archive);
    return this.store.transaction(() => {
      const earlier = this.store.get('SELECT id FROM conversation_episodes WHERE conversation_id=? AND last_entry=?', args.conversationId, args.lastEntry);
      if (earlier) this.remove(String(earlier.id));
      const key = id(), created = Math.max(now(), Number(this.store.get('SELECT COALESCE(MAX(created_at),0) n FROM conversation_episodes WHERE bot_id=?', args.botId)!.n) + 1);
      this.store.insert('conversation_episodes', {
        id: key, bot_id: args.botId, conversation_id: args.conversationId, first_entry: args.firstEntry, last_entry: args.lastEntry,
        started_at: args.startedAt, ended_at: Math.max(args.endedAt, args.startedAt), title: archive.title, summary,
        open_items: JSON.stringify(archive.openItems), refs_json: JSON.stringify(archive.refs), tokens: tokens(summary), created_at: created,
        brief: archive.brief, detail_json: JSON.stringify({ topics: archive.topics, decisions: archive.decisions, operations: archive.operations }),
      });
      this.store.run('INSERT INTO conversation_episode_search VALUES(?,?)', key, searchTerms(archive.title + ' ' + summary).join(' '));
      this.store.run('DELETE FROM conversation_topic_marks WHERE conversation_id=?', args.conversationId);
      return key;
    });
  }
  remove(episodeId: string) {
    this.store.run('DELETE FROM conversation_episode_search WHERE episode_id=?', episodeId);
    this.store.run('DELETE FROM conversation_episodes WHERE id=?', episodeId);
  }

  get(botId: string, episodeId: string): Row | undefined {
    return this.store.get('SELECT * FROM conversation_episodes WHERE id=? AND bot_id=?', episodeId, botId);
  }
  /** The archive as search returns it. */
  view(row: Row) {
    return {
      id: row.id, ref: `episode:${row.id}`, title: row.title, content: row.summary, openItems: JSON.parse(String(row.open_items)) as string[],
      refs: JSON.parse(String(row.refs_json)) as string[], ...(JSON.parse(String(row.detail_json)) as object),
      startedAt: row.started_at, endedAt: row.ended_at, conversationId: row.conversation_id, firstEntry: row.first_entry, lastEntry: row.last_entry,
    };
  }

  /** Archives of one assistant matching a query, best first. */
  private ranked(botId: string, query: string) {
    const expression = matchExpression(query);
    if (!expression) return [];
    return this.store.all('SELECT e.* FROM conversation_episode_search s JOIN conversation_episodes e ON e.id=s.episode_id WHERE conversation_episode_search MATCH ? AND e.bot_id=? ORDER BY rank LIMIT 50', expression, botId)
      .map((row) => ({ row, score: relevance(query, row.title + '\n' + row.summary) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.row.ended_at) - Number(a.row.ended_at))
      .map((item) => item.row);
  }
  /** Text search for memory.search: ranked archives, each clipped, within a token budget. */
  search(botId: string, query: string, limit = 5, budget = 3000) {
    const found: Array<ReturnType<Episodes['summary']>> = [];
    let remaining = budget;
    for (const row of this.ranked(botId, query)) {
      if (found.length >= limit || remaining < 150) break;
      const item = this.summary(row, Math.min(remaining, 800));
      found.push(item); remaining -= tokens(item);
    }
    return found;
  }
  /** The archives that fit the current input best, for the volatile reminder: a few, bounded in tokens in all. */
  related(botId: string, query: string, budget = RECALL_TOKENS, limit = RECALL_EPISODES) {
    // The list is serialized with separators of its own: keep a margin under the budget.
    return this.search(botId, query, limit, budget - 100);
  }
  private summary(row: Row, limit: number) {
    return { ref: `episode:${row.id}`, title: row.title, endedAt: row.ended_at, summary: clipTokens(String(row.summary), Math.max(100, limit - 100)), openItems: JSON.parse(String(row.open_items)) as string[] };
  }

  /** Removes every archive of an assistant (a forget plan reached it); returns their ids as memory source ids. */
  forgetBot(botId: string): Set<string> {
    const ids = new Set<string>();
    for (const row of this.store.all('SELECT id FROM conversation_episodes WHERE bot_id=?', botId)) { ids.add('episode:' + row.id); this.remove(String(row.id)); }
    this.store.run('DELETE FROM conversation_topic_marks WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id=?)', botId);
    return ids;
  }
}
