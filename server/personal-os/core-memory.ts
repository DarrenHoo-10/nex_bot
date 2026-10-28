import { CoreStore, now, type Row } from './store.ts';
import { tokens } from './token-estimate.ts';

// Core memory (docs/plans/memory-recall.md section 4.2): the small, stable memory every request of an assistant
// carries in the cacheable system prompt. One per assistant plus one shared by the workspace, each stored as
// structured lines so that it is changed by line patches, and rendered to text deterministically, so the prompt
// prefix stays byte-identical until a line changes.
//   关于用户  long-term facts and preferences, one line each
//   主题索引  one line per topic: "- 标题 — 一句话 (memory:<id>)", pointing at the detail kept in the library

/** Everything rendered (an assistant's lines and the shared lines together) stays within this many tokens. */
export const CORE_MEMORY_TOKENS = 1500;
const MAX_LINES = 100, MAX_OPERATIONS = 60;
const ABOUT_CHARS = 300, TITLE_CHARS = 80, LINE_CHARS = 200;
const REF = /^(?:memory|episode):[\w-]{1,100}$/;
const SEPARATOR = ' — ';

export interface CoreTopic { title: string; line: string; ref: string }
export interface CoreContent { about: string[]; topics: CoreTopic[] }
export type CoreScope = 'bot' | 'workspace';
export interface CoreEntry { content: CoreContent; version: number; updatedAt: number }

export const emptyCore = (): CoreContent => ({ about: [], topics: [] });
const topicText = (item: CoreTopic) => `${item.title}${SEPARATOR}${item.line}${item.ref ? ` (${item.ref})` : ''}`;

/**
 * The text of the system prompt: the assistant's own lines first, then the shared ones tagged "[共享]". The header
 * carries the assistant's version, which `memory.core.update` must be given back as expectedVersion.
 */
export function renderCore(bot: CoreContent, workspace: CoreContent, version: number): string {
  const about = [...bot.about.map((item) => `- ${item}`), ...workspace.about.map((item) => `- [共享] ${item}`)];
  const topics = [...bot.topics.map((item) => `- ${topicText(item)}`), ...workspace.topics.map((item) => `- [共享] ${topicText(item)}`)];
  return [`核心记忆（版本 ${version}）`, about.length ? '关于用户：' : '关于用户：暂无', ...about, topics.length ? '主题索引：' : '主题索引：暂无', ...topics].join('\n');
}

function oneLine(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}须为文本`);
  const result = value.replace(/\s+/g, ' ').trim();
  if (!result) throw new Error(`${label}不能为空`);
  if (result.length > max) throw new Error(`${label}超过 ${max} 字，请精简`);
  return result;
}
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, unknown>;
};
export function parseTopic(value: unknown): CoreTopic {
  const item = object(value, '主题索引条目（须为 {title,line,ref}）');
  const title = oneLine(item.title, TITLE_CHARS, '主题标题').replaceAll(SEPARATOR, ' - ');
  const ref = item.ref === undefined || item.ref === null || item.ref === '' ? '' : oneLine(item.ref, 120, '主题引用');
  if (ref && !REF.test(ref)) throw new Error('主题引用须形如 memory:<id> 或 episode:<id>');
  return { title, line: oneLine(item.line, LINE_CHARS, '主题说明'), ref };
}
/** A whole content from the owner (the editor) or storage: every line validated. */
export function parseContent(value: unknown): CoreContent {
  const input = object(value, '核心记忆');
  if (!Array.isArray(input.about) || !Array.isArray(input.topics)) throw new Error('核心记忆须包含 about 与 topics 两个列表');
  if (input.about.length > MAX_LINES || input.topics.length > MAX_LINES) throw new Error(`每个列表最多 ${MAX_LINES} 行`);
  const topics = input.topics.map(parseTopic), refs = topics.map((item) => item.ref).filter(Boolean);
  if (new Set(refs).size !== refs.length) throw new Error('主题索引中有重复的引用');
  return { about: input.about.map((item) => oneLine(item, ABOUT_CHARS, '关于用户')), topics };
}
function stored(raw: unknown): CoreContent {
  try { return parseContent(JSON.parse(String(raw))); } catch { return emptyCore(); }
}

interface Operations { add: unknown[]; update: unknown[]; remove: unknown[] }
function operations(value: unknown, label: string): Operations {
  if (value === undefined || value === null) return { add: [], update: [], remove: [] };
  const input = object(value, label);
  for (const key of Object.keys(input)) if (!['add', 'update', 'remove'].includes(key)) throw new Error(`${label}只支持 add、update、remove`);
  const list = (name: string) => {
    const item = input[name];
    if (item === undefined) return [];
    if (!Array.isArray(item)) throw new Error(`${label}.${name} 须为数组`);
    return item;
  };
  const result = { add: list('add'), update: list('update'), remove: list('remove') };
  if (result.add.length + result.update.length + result.remove.length > MAX_OPERATIONS) throw new Error(`${label}一次最多 ${MAX_OPERATIONS} 处修改`);
  return result;
}

/** The content after a line patch: updates and removals address the lines as shown (1-based) before any change. */
export function applyPatch(current: CoreContent, patch: unknown): CoreContent {
  const input = object(patch, 'patch');
  for (const key of Object.keys(input)) if (key !== 'about' && key !== 'topics') throw new Error('patch 只支持 about 与 topics');

  const about = operations(input.about, 'about'), aboutTouched = new Set<number>();
  const aboutAt = (selector: unknown) => {
    const n = Number(selector);
    if (!Number.isInteger(n) || n < 1 || n > current.about.length) throw new Error(`关于用户没有第 ${String(selector)} 条（现有 ${current.about.length} 条）`);
    if (aboutTouched.has(n)) throw new Error(`关于用户第 ${n} 条被多次修改`);
    aboutTouched.add(n);
    return n - 1;
  };
  const lines = [...current.about];
  for (const item of about.update) { const entry = object(item, 'about.update 条目（须为 {index,text}）'); lines[aboutAt(entry.index)] = oneLine(entry.text, ABOUT_CHARS, '关于用户'); }
  const gone = new Set(about.remove.map((item) => aboutAt(typeof item === 'object' && item ? (item as Record<string, unknown>).index : item)));
  const nextAbout = lines.filter((_, index) => !gone.has(index));
  for (const item of about.add) { const added = oneLine(item, ABOUT_CHARS, '关于用户'); if (!nextAbout.includes(added)) nextAbout.push(added); }

  const topics = operations(input.topics, 'topics'), topicTouched = new Set<number>();
  const topicAt = (selector: unknown) => {
    const by = typeof selector === 'number' ? { index: selector } : typeof selector === 'string' ? { ref: selector } : object(selector, '主题定位（须含 index 或 ref）');
    let position: number;
    if (by.index !== undefined) {
      const n = Number(by.index);
      if (!Number.isInteger(n) || n < 1 || n > current.topics.length) throw new Error(`主题索引没有第 ${String(by.index)} 条（现有 ${current.topics.length} 条）`);
      position = n - 1;
    } else if (typeof by.ref === 'string' && by.ref) {
      position = current.topics.findIndex((item) => item.ref === by.ref);
      if (position < 0) throw new Error(`主题索引中没有引用 ${by.ref}`);
    } else throw new Error('主题定位须含 index 或 ref');
    if (topicTouched.has(position)) throw new Error(`主题索引第 ${position + 1} 条被多次修改`);
    topicTouched.add(position);
    return position;
  };
  const rows = [...current.topics];
  for (const item of topics.update) {
    const entry = object(item, 'topics.update 条目'), position = topicAt(entry);
    rows[position] = parseTopic({ ...rows[position], ...(entry.title !== undefined ? { title: entry.title } : {}), ...(entry.line !== undefined ? { line: entry.line } : {}), ...(entry.newRef !== undefined ? { ref: entry.newRef } : {}) });
  }
  const dropped = new Set(topics.remove.map(topicAt));
  const nextTopics = rows.filter((_, index) => !dropped.has(index));
  for (const item of topics.add) {
    const added = parseTopic(item);
    if (added.ref && nextTopics.some((row) => row.ref === added.ref)) throw new Error(`主题索引已有引用 ${added.ref}，请改用 update`);
    nextTopics.push(added);
  }
  const refs = nextTopics.map((item) => item.ref).filter(Boolean);
  if (new Set(refs).size !== refs.length) throw new Error('主题索引中有重复的引用');
  if (nextAbout.length > MAX_LINES || nextTopics.length > MAX_LINES) throw new Error(`每个列表最多 ${MAX_LINES} 行，请先合并或删除`);
  return { about: nextAbout, topics: nextTopics };
}

export class CoreMemory {
  constructor(readonly store: CoreStore) {}

  read(scope: CoreScope, botId = ''): CoreEntry {
    const row = this.store.get('SELECT content,version,updated_at FROM assistant_core_memory WHERE scope=? AND bot_id=?', scope, scope === 'bot' ? botId : '');
    return row ? { content: stored(row.content), version: Number(row.version), updatedAt: Number(row.updated_at) } : { content: emptyCore(), version: 0, updatedAt: 0 };
  }
  /** The prompt text for one assistant (its lines and the workspace's). */
  render(botId: string): string {
    const bot = this.read('bot', botId);
    return renderCore(bot.content, this.read('workspace').content, bot.version);
  }
  view(botId: string) {
    this.assertBot(botId);
    const rendered = this.render(botId);
    return { limit: CORE_MEMORY_TOKENS, tokens: tokens(rendered), rendered, bot: this.read('bot', botId), workspace: this.read('workspace') };
  }
  private assertBot(botId: string) {
    if (!this.store.get('SELECT id FROM bots WHERE id=? AND workspace_id=? AND owner_user_id=?', botId, this.store.workspace, this.store.owner)) throw new Error('助手不存在');
  }

  /** Throws when the lines would not fit with the other scope's: the workspace lines are carried by every assistant. */
  private assertFits(scope: CoreScope, next: CoreContent) {
    const measure = (bot: CoreContent, workspace: CoreContent) => tokens(renderCore(bot, workspace, 99999));
    const used = scope === 'bot'
      ? measure(next, this.read('workspace').content)
      : Math.max(measure(emptyCore(), next), ...this.store.all("SELECT bot_id FROM assistant_core_memory WHERE scope='bot'").map((row) => measure(this.read('bot', String(row.bot_id)).content, next)));
    if (used > CORE_MEMORY_TOKENS) throw new Error(`核心记忆超过 ${CORE_MEMORY_TOKENS} Token（改后约 ${used}）。请合并相近的行、缩短说明或删除不再需要的行后重试${scope === 'workspace' ? '（共享行与每个助手自己的行合计计算）' : ''}`);
  }

  private commit(scope: CoreScope, botId: string, expected: unknown, change: (current: CoreContent) => CoreContent, source: { actor: 'agent' | 'owner'; callId?: string }) {
    const expectedVersion = Number(expected);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('核心记忆版本无效');
    const key = scope === 'bot' ? botId : '';
    return this.store.transaction(() => {
      if (source.callId) {
        const receipt = this.store.get('SELECT result_json FROM core_memory_receipts WHERE tool_call_id=?', source.callId);
        if (receipt) return JSON.parse(String(receipt.result_json)) as CoreResult;
      }
      const current = this.read(scope, key);
      if (current.version !== expectedVersion) throw new Error(`核心记忆已被更新（当前版本 ${current.version}），请按最新版本重新提交`);
      const next = change(current.content), changed = JSON.stringify(next) !== JSON.stringify(current.content);
      let version = current.version;
      if (changed) {
        this.assertFits(scope, next);
        version += 1;
        this.store.run('INSERT INTO assistant_core_memory(scope,bot_id,content,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(scope,bot_id) DO UPDATE SET content=excluded.content,version=excluded.version,updated_at=excluded.updated_at', scope, key, JSON.stringify(next), version, now());
      }
      const result: CoreResult = { saved: true, scope, version, changed, tokens: tokens(this.render(key)), limit: CORE_MEMORY_TOKENS };
      if (source.callId) this.store.insert('core_memory_receipts', { tool_call_id: source.callId, scope, bot_id: key, expected_version: expectedVersion, committed_version: version, result_json: JSON.stringify(result), committed_at: now() });
      this.store.audit('memory.core.update', 'core_memory', key || 'workspace', { scope, botId: key, expectedVersion, version, changed, actor: source.actor, callId: source.callId ?? null });
      return result;
    });
  }

  /**
   * The model's `memory.core.update`: a line patch to the assistant's own core memory, checked against the version it
   * read. The shared workspace memory is the user's to edit (like shared memory documents), never the model's.
   * `exists` verifies that a topic's reference names something the assistant can open.
   */
  update(botId: string, args: { scope?: unknown; patch?: unknown; expectedVersion?: unknown }, callId?: string, exists?: (ref: string) => boolean): CoreResult {
    if (args.scope !== undefined && args.scope !== 'bot') throw new Error(args.scope === 'workspace' ? '共享核心记忆请由用户在记忆设置中编辑，模型只能更新自己的核心记忆' : '核心记忆范围无效');
    this.assertBot(botId);
    return this.commit('bot', botId, args.expectedVersion, (current) => {
      const next = applyPatch(current, args.patch);
      if (exists) for (const item of next.topics) if (item.ref && !current.topics.some((row) => row.ref === item.ref) && !exists(item.ref)) throw new Error(`引用 ${item.ref} 不存在或不可读取`);
      return next;
    }, { actor: 'agent', callId });
  }
  /** The owner's whole replacement of one scope (the editor): the same version check and cap as the model's patch. */
  replace(scope: CoreScope, botId: string, content: unknown, expectedVersion: unknown): CoreResult {
    if (scope !== 'bot' && scope !== 'workspace') throw new Error('核心记忆范围无效');
    if (scope === 'bot') this.assertBot(botId);
    return this.commit(scope, botId, expectedVersion, () => parseContent(content), { actor: 'owner' });
  }

  /** Removes the topic lines that point at forgotten sources, in every scope; returns how many rows changed. */
  dropRefs(refs: ReadonlySet<string>): number {
    if (!refs.size) return 0;
    let changed = 0;
    for (const row of this.store.all('SELECT scope,bot_id,content,version FROM assistant_core_memory') as Row[]) {
      const content = stored(row.content), kept = content.topics.filter((item) => !refs.has(item.ref));
      if (kept.length === content.topics.length) continue;
      this.store.run('UPDATE assistant_core_memory SET content=?,version=version+1,updated_at=? WHERE scope=? AND bot_id=?', JSON.stringify({ about: content.about, topics: kept }), now(), row.scope, row.bot_id);
      changed++;
    }
    return changed;
  }
}

export interface CoreResult { saved: true; scope: CoreScope; version: number; changed: boolean; tokens: number; limit: number }
