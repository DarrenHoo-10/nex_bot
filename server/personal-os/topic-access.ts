import { CoreStore, now, type Row } from './store.ts';

// Who may see a user topic (docs/plans/user-topics.md section 5). A user topic is an assistant_topics row with owner='user';
// its access rows say who reads it ('reader'), who looks after it ('steward': reads, writes and pays for the upkeep) and who is
// shut out ('none'), for one assistant or for '*' (every assistant). A topic inherits the rows of its container; its own rows
// win over the inherited ones, and the row of an assistant wins over the row of '*'. This file reads the store only, so the
// scopes of the retrieval pool (retrieval-index.ts) can use it.

export type Role = 'steward' | 'reader' | 'none';
export const EVERYONE = '*';
/** A principal that no assistant is: only the '*' rows apply to it (an assistant made later). */
const NEWCOMER = '\u0000newcomer';
interface UserTopic { parent: string | null; special: string | null; creator: string; title: string }
interface Graph { topics: Map<string, UserTopic>; rows: Map<string, Map<string, Role>> }

function graph(store: CoreStore): Graph | undefined {
  const topics = new Map<string, UserTopic>();
  for (const row of store.all("SELECT t.topic_id,t.parent_id,t.special,m.bot_id,m.title FROM assistant_topics t JOIN assistant_memories m ON m.id=t.topic_id WHERE t.owner='user' AND m.status='active'")) topics.set(String(row.topic_id), { parent: row.parent_id === null ? null : String(row.parent_id), special: row.special === null ? null : String(row.special), creator: String(row.bot_id), title: String(row.title) });
  if (!topics.size) return;
  const rows = new Map<string, Map<string, Role>>();
  for (const row of store.all('SELECT topic_id,principal,role FROM user_topic_access')) {
    const key = String(row.topic_id), map = rows.get(key) ?? new Map<string, Role>();
    map.set(String(row.principal), String(row.role) as Role); rows.set(key, map);
  }
  return { topics, rows };
}
function roleIn(g: Graph, topic: string, bot: string): Role {
  // The topic's own rows first, then its container's; an assistant's row before the '*' row of the same level.
  for (let key: string | null | undefined = topic, depth = 0; key && g.topics.has(key) && depth < 3; key = g.topics.get(key)!.parent, depth++) {
    const rows = g.rows.get(key), found = rows?.get(bot) ?? rows?.get(EVERYONE);
    if (found) return found;
  }
  return 'none';
}
/** The user topics an assistant may read, the ones it made but may not read (so its own rows do not show them), and all it may not read (so the facts it said that now rest in them do not show either). Undefined while there are no user topics. */
export function visibility(store: CoreStore, botId: string): { readable: string[]; hidden: string[]; unreadable: string[] } | undefined {
  const g = graph(store);
  if (!g) return;
  const readable: string[] = [], hidden: string[] = [], unreadable: string[] = [];
  for (const [key, topic] of g.topics) {
    if (roleIn(g, key, botId) !== 'none') readable.push(key); else { unreadable.push(key); if (topic.creator === botId) hidden.push(key); }
  }
  return { readable, hidden, unreadable };
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const term = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
/** The shortest quote of the user's words that authorizes a change. */
export const QUOTE_MIN_CHARS = 4;

export class TopicAccess {
  /** Called after any change of who may see what (the vector cache and the core memory lines follow). */
  changed: (botIds?: string[]) => void = () => {};
  constructor(readonly store: CoreStore) {}

  activeBots(): string[] {
    return this.store.all("SELECT id FROM bots WHERE status='active' AND workspace_id=? AND owner_user_id=? ORDER BY created_at,id", this.store.workspace, this.store.owner).map((row) => String(row.id));
  }
  private botName(key: string) { return String(this.store.get('SELECT name FROM bots WHERE id=?', key)?.name ?? key); }
  name(key: string) { return this.botName(key); }
  isUser(topic: string): boolean { return this.store.get("SELECT 1 n FROM assistant_topics WHERE topic_id=? AND owner='user'", topic) !== undefined; }

  role(topic: string, botId: string): Role { const g = graph(this.store); return g ? roleIn(g, topic, botId) : 'none'; }
  /** Every user topic (id) with the role the assistant has in it. */
  roles(botId: string): Map<string, Role> {
    const g = graph(this.store), result = new Map<string, Role>();
    if (g) for (const key of g.topics.keys()) result.set(key, roleIn(g, key, botId));
    return result;
  }
  readable(botId: string): string[] { return visibility(this.store, botId)?.readable ?? []; }
  stewards(topic: string): string[] { const g = graph(this.store); return g ? this.activeBots().filter((bot) => roleIn(g, topic, bot) === 'steward') : []; }
  readers(topic: string): string[] { const g = graph(this.store); return g ? this.activeBots().filter((bot) => roleIn(g, topic, bot) !== 'none') : []; }
  /** The top-level topic above this one (or itself). */
  top(topic: string): string { let key = topic; for (let i = 0; i < 3; i++) { const parent = this.store.get('SELECT parent_id FROM assistant_topics WHERE topic_id=?', key)?.parent_id; if (!parent) break; key = String(parent); } return key; }
  /** The same access for everyone, present and future: what two topics must have in common before they may be merged. */
  sameAccess(a: string, b: string): boolean {
    const g = graph(this.store);
    return !!g && [...this.activeBots(), NEWCOMER].every((bot) => roleIn(g, a, bot) === roleIn(g, b, bot));
  }
  /** The steward Core names for a question about the topic: the one that wrote it last, else the one made steward last. */
  pickSteward(topic: string): string | undefined {
    const stewards = this.stewards(this.top(topic));
    if (!stewards.length) return;
    const maintainer = this.store.get('SELECT maintainer FROM assistant_topics WHERE topic_id=?', topic)?.maintainer ?? this.store.get('SELECT maintainer FROM assistant_topics WHERE topic_id=?', this.top(topic))?.maintainer;
    if (maintainer && stewards.includes(String(maintainer))) return String(maintainer);
    const at = (bot: string) => Number(this.store.get('SELECT MAX(updated_at) n FROM user_topic_access WHERE topic_id=? AND principal IN (?,?)', topic, bot, EVERYONE)?.n ?? 0);
    return [...stewards].sort((a, b) => at(b) - at(a) || (a < b ? -1 : 1))[0];
  }
  /** Names of the top-level user topics an assistant looks after (the assistant map, section 7). */
  responsibilities(botId: string): string[] {
    const g = graph(this.store);
    if (!g) return [];
    return [...g.topics].filter(([key, topic]) => !topic.parent && !topic.special && roleIn(g, key, botId) === 'steward').map(([, topic]) => topic.title);
  }

  // ---- writing the rows -----------------------------------------------------------------------------------------

  rows(topic: string): Row[] { return this.store.all('SELECT principal,role,granted_by_bot,updated_at FROM user_topic_access WHERE topic_id=? ORDER BY updated_at,principal', topic); }
  own(topic: string, principal: string): Role | undefined { return this.store.get('SELECT role FROM user_topic_access WHERE topic_id=? AND principal=?', topic, principal)?.role as Role | undefined; }
  set(topic: string, principal: string, role: Role, by: string, taskId = '', quote = '') {
    this.store.run('INSERT INTO user_topic_access(topic_id,principal,role,granted_by_bot,task_id,quote,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(topic_id,principal) DO UPDATE SET role=excluded.role,granted_by_bot=excluded.granted_by_bot,task_id=excluded.task_id,quote=excluded.quote,updated_at=excluded.updated_at', topic, principal, role, by, taskId, quote, Math.max(now(), Number(this.store.get('SELECT MAX(updated_at) n FROM user_topic_access')?.n ?? 0) + 1));
    this.changed();
  }
  unset(topic: string, principal: string) { this.store.run('DELETE FROM user_topic_access WHERE topic_id=? AND principal=?', topic, principal); this.changed(); }
  /** A user topic starts with its creator as steward. */
  create(topic: string, steward: string) { this.set(topic, steward, 'steward', steward); }
  /**
   * A topic always has a steward (5.1). When the last one is gone, the assistant that can read it and was last spoken to
   * takes it over; with no reader left it goes back to the assistant that made it. Returns the new steward, if there was a change.
   */
  ensureSteward(topic: string, except?: string): string | undefined {
    const root = this.top(topic);
    if (!this.isUser(root) || this.stewards(root).filter((bot) => bot !== except).length) return;
    const readers = this.readers(root).filter((bot) => bot !== except), spoken = (bot: string) => Number(this.store.get("SELECT MAX(created_at) n FROM agent_messages WHERE bot_id=? AND role='user'", bot)?.n ?? 0);
    const creator = String(this.store.get('SELECT bot_id FROM assistant_memories WHERE id=?', root)?.bot_id ?? '');
    const successor = readers.length ? [...readers].sort((a, b) => spoken(b) - spoken(a))[0] : this.activeBots().includes(creator) && creator !== except ? creator : undefined;
    if (!successor) return;
    this.set(root, successor, 'steward', 'system');
    return successor;
  }

  // ---- what the user said (5.3) ------------------------------------------------------------------------------------

  /** The task was started by the user in a chat of their own with this assistant, and nothing else. */
  assertUserTask(taskId: string) {
    const link = this.store.get('SELECT origin FROM agent_task_links WHERE task_id=?', taskId);
    if (!link || link.origin !== 'owner' || this.store.get('SELECT 1 n FROM a2a_messages WHERE child_task_id=?', taskId)) throw new Error('只有用户在对话中直接发起的任务才能修改主题的访问权限（委派、例行任务和其他来源不行）');
  }
  /** The quote is the user's own words: a substring (white space normalized) of what the user typed in this task, four characters at least. */
  assertQuote(taskId: string, quote: unknown): string {
    const wanted = typeof quote === 'string' ? normalize(quote) : '';
    if (wanted.length < QUOTE_MIN_CHARS) throw new Error(`须在 quote 里填用户这次输入的原话（至少 ${QUOTE_MIN_CHARS} 个字）`);
    const inputs = this.store.all('SELECT content_json FROM conversation_inputs WHERE task_id=?', taskId).map((row) => { try { return normalize(String(JSON.parse(String(row.content_json)).text ?? '')); } catch { return ''; } });
    if (!inputs.some((input) => input.includes(wanted))) throw new Error('quote 不是用户这次输入的原话，不能据此修改权限');
    return wanted;
  }

  /** A user topic by id (or `memory:<id>`), or by the name, alias or anchor it is known by; ambiguous names are refused. */
  resolve(value: unknown): Row {
    if (typeof value !== 'string' || !value.trim()) throw new Error('topic 须为主题 id 或名称');
    const wanted = value.trim().replace(/^memory:/, ''), rows = this.store.all("SELECT m.*,t.anchor,t.aliases_json,t.parent_id,t.special,t.resident FROM assistant_topics t JOIN assistant_memories m ON m.id=t.topic_id WHERE t.owner='user' AND m.status='active' ORDER BY m.rowid");
    const byId = rows.find((row) => row.id === wanted);
    if (byId) return byId;
    const key = term(wanted), named = rows.filter((row) => [String(row.title), String(row.anchor), ...(JSON.parse(String(row.aliases_json)) as string[])].some((item) => key.length >= 2 && term(item) === key));
    if (named.length > 1) throw new Error(`「${wanted}」对应不止一个用户主题，请用 id 指明`);
    if (!named.length) throw new Error(`没有名为「${wanted}」的用户主题`);
    return named[0];
  }
  /** The bot a grant names: an id, or the exact name of an active assistant. */
  bot(value: unknown): string {
    if (value === EVERYONE) return EVERYONE;
    if (typeof value !== 'string' || !value.trim()) throw new Error('bot 须为助手 id、名称或 *');
    const bots = this.activeBots(), wanted = value.trim();
    if (bots.includes(wanted)) return wanted;
    const named = bots.filter((key) => this.botName(key) === wanted);
    if (named.length !== 1) throw new Error(`没有名为「${wanted}」的助手`);
    return named[0];
  }

}

/** The user topics an assistant carries in its core memory because the user made them resident (the user's own topic is the shared "about" block already). */
export function residentTopics(store: CoreStore, botId: string): Array<{ title: string; text: string }> {
  const seen = visibility(store, botId);
  if (!seen?.readable.length) return [];
  const readable = new Set(seen.readable);
  return store.all("SELECT m.id,m.title,m.content FROM assistant_topics t JOIN assistant_memories m ON m.id=t.topic_id WHERE t.owner='user' AND t.resident=1 AND t.special IS NULL AND m.status='active' ORDER BY m.rowid").filter((row) => readable.has(String(row.id))).map((row) => ({ title: String(row.title), text: String(row.content) }));
}

/**
 * The input of an episode archive without what came back from another assistant about a topic this one may not read
 * (section 6.1). `source` is the JSON list of items the summarizer reads (`{ref:'entry:<id>',role,content}`); after the
 * assistant entry that handed the question over, everything up to the next input of the user (the tool result and the
 * replies built on it) is replaced by the one line given.
 */
export function isolateSource(source: string, notes: ReadonlyArray<{ entry: string; line: string }>): string {
  let items: Array<{ ref?: string; role?: string; content?: unknown }>;
  try { items = JSON.parse(source); } catch { return source; }
  if (!Array.isArray(items)) return source;
  for (const note of notes) {
    const start = items.findIndex((item) => item.ref === `entry:${note.entry}`);
    if (start < 0) continue;
    let end = start + 1;
    while (end < items.length && items[end].role !== 'user' && items[end].role !== 'summary') end++;
    if (end > start + 1) items.splice(start + 1, end - start - 1, { ref: items[start + 1].ref, role: 'system', content: note.line });
  }
  return JSON.stringify(items);
}
