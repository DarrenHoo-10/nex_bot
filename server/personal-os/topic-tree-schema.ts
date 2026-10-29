// Migration 36: the two-level structure of an assistant's topics (docs/plans/user-topics.md sections 4 and 10.1, phase 1).
//  - assistant_topics gains the structure of a topic: `role` ('leaf' is today's topic; a 'container' has only children and a
//    summarized overview and rests on no evidence of its own), `parent_id` (the container of a leaf; two levels at most),
//    the container's `anchor` and `aliases_json`, who placed it (`placed_by` 'auto' | 'owner': the owner's placement is
//    never undone by background work), `split_from` (the leaf a sub-topic was split off), and `overview_stale` /
//    `overview_at` (when the overview was last written; 1 asks for a rewrite, 2 means a forgotten child took it down).
//    `owner` is 'bot' for every topic: user topics are phase 2. No row moves: every existing topic stays a top-level leaf.
//  - assistant_topic_members: the episode archives and memory documents that belong to a leaf (at most 3 each), and
//    assistant_topic_member_scan: the ones already judged, so they are not judged again. The scan is per assistant (the
//    plan keys it by kind and id alone, which would hide a shared document from every assistant but the first).
//  - assistant_topic_moves: every grouping change, with what it was before and after, so it can be undone. The actions of
//    the later phases (promote, grant, revoke, resident) are allowed now so that phase 2 needs no table rebuild.
//  - assistant_topic_organize: when an assistant's containers were last judged and which groups were turned down.
//  - task_recall.topic_ids: the containers a task's recall was routed to.
// Safe to run again: columns are added only where missing.
export const TREE_MIGRATION = 36;

export const treeColumns: ReadonlyArray<readonly [string, string]> = [
  ['owner', "TEXT NOT NULL DEFAULT 'bot'"],
  ['role', "TEXT NOT NULL DEFAULT 'leaf'"],
  ['parent_id', 'TEXT'],
  ['anchor', "TEXT NOT NULL DEFAULT ''"],
  ['aliases_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['placed_by', "TEXT NOT NULL DEFAULT 'auto'"],
  ['split_from', 'TEXT'],
  ['overview_stale', 'INTEGER NOT NULL DEFAULT 0'],
  ['overview_at', 'INTEGER'],
];

export const treeSchema = `
CREATE INDEX IF NOT EXISTS assistant_topics_parent ON assistant_topics(parent_id);
CREATE TABLE IF NOT EXISTS assistant_topic_members(topic_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('episode','document')),ref_id TEXT NOT NULL,bot_id TEXT NOT NULL,placed_by TEXT NOT NULL DEFAULT 'auto',added_at INTEGER NOT NULL,PRIMARY KEY(topic_id,kind,ref_id)) STRICT;
CREATE INDEX IF NOT EXISTS assistant_topic_members_ref ON assistant_topic_members(kind,ref_id);
CREATE TABLE IF NOT EXISTS assistant_topic_member_scan(bot_id TEXT NOT NULL,kind TEXT NOT NULL,ref_id TEXT NOT NULL,scanned_at INTEGER NOT NULL,PRIMARY KEY(bot_id,kind,ref_id)) STRICT;
CREATE TABLE IF NOT EXISTS assistant_topic_moves(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,topic_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('contain','release','create','promote','merge','dissolve','rename','grant','revoke','resident','revert')),before_json TEXT NOT NULL,after_json TEXT NOT NULL,actor TEXT NOT NULL CHECK(actor IN ('auto','owner','model')),reverted_by TEXT,created_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS assistant_topic_moves_bot ON assistant_topic_moves(bot_id,created_at);
CREATE TABLE IF NOT EXISTS assistant_topic_organize(bot_id TEXT PRIMARY KEY,checked_at INTEGER NOT NULL DEFAULT 0,rejected_json TEXT NOT NULL DEFAULT '[]') STRICT;
`;
/** The migration's column additions as SQL (the checksum covers them), and the statements that apply the missing ones. */
export const treeMigrationSql = treeColumns.map(([name, type]) => `ALTER TABLE assistant_topics ADD COLUMN ${name} ${type};`).join('\n') + '\nALTER TABLE task_recall ADD COLUMN topic_ids TEXT NOT NULL DEFAULT \'[]\';\n' + treeSchema;
export function applyTreeSchema(db: { exec(sql: string): void; prepare(sql: string): { all(): unknown[] } }) {
  const have = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  const topics = have('assistant_topics');
  for (const [name, type] of treeColumns) if (!topics.has(name)) db.exec(`ALTER TABLE assistant_topics ADD COLUMN ${name} ${type};`);
  if (!have('task_recall').has('topic_ids')) db.exec("ALTER TABLE task_recall ADD COLUMN topic_ids TEXT NOT NULL DEFAULT '[]';");
  db.exec(treeSchema);
}
