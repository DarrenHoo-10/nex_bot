// Migration 37: user topics and who may see them (docs/plans/user-topics.md sections 3, 5, 6 and 10.1, phase 2).
//  - assistant_topics gains `special` ('about_me' or NULL: the user's own topic, open to every assistant), `resident` (1: its
//    overview is carried by the core memory of every assistant that may read it) and `maintainer` (the assistant whose pass
//    last wrote the topic, which decides who is asked when several assistants look after it). `owner` ('bot' | 'user') came
//    with migration 36; this migration changes no row, so every topic stays an assistant topic and nobody sees more.
//  - user_topic_access: who may read a user topic ('reader'), who looks after it ('steward': reads, writes, pays for the
//    upkeep), and who was shut out ('none'); the principal is an assistant id or '*' (every assistant, those made later too).
//    A topic inherits the rows of its container; its own rows win, and a row for an assistant wins over '*'.
//  - user_topic_indexed: the index line (title and summary) a user topic was given in the core memory of one assistant, so a line
//    the owner edited by hand is kept and a topic more than one assistant reads has a line in each of them.
//  - topic_delegations: a question handed to the steward of a topic the asking assistant may not read, once per task and topic.
//  - task_recall.hints_json: the hints (topic, steward) that were put in the task's recall, kept so every request of the task
//    carries the same text and the task's later messages can be held back from the asking assistant's memory.
// Safe to run again: columns are added only where missing.
export const ACCESS_MIGRATION = 37;

export const accessColumns: ReadonlyArray<readonly [string, string, string]> = [
  ['assistant_topics', 'special', 'TEXT'],
  ['assistant_topics', 'resident', 'INTEGER NOT NULL DEFAULT 0'],
  ['assistant_topics', 'maintainer', 'TEXT'],
  ['task_recall', 'hints_json', "TEXT NOT NULL DEFAULT '[]'"],
];

export const accessSchema = `
CREATE TABLE IF NOT EXISTS user_topic_access(topic_id TEXT NOT NULL,principal TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('steward','reader','none')),granted_by_bot TEXT NOT NULL,task_id TEXT NOT NULL,quote TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(topic_id,principal)) STRICT;
CREATE INDEX IF NOT EXISTS user_topic_access_principal ON user_topic_access(principal);
CREATE TABLE IF NOT EXISTS user_topic_indexed(topic_id TEXT NOT NULL,bot_id TEXT NOT NULL,title TEXT,summary TEXT,indexed_at INTEGER NOT NULL,PRIMARY KEY(topic_id,bot_id)) STRICT;
CREATE TABLE IF NOT EXISTS topic_delegations(task_id TEXT NOT NULL,topic_id TEXT NOT NULL,target_bot_id TEXT NOT NULL,call_id TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(task_id,topic_id)) STRICT;
`;
export const accessMigrationSql = accessColumns.map(([table, name, type]) => `ALTER TABLE ${table} ADD COLUMN ${name} ${type};`).join('\n') + '\n' + accessSchema;
export function applyAccessSchema(db: { exec(sql: string): void; prepare(sql: string): { all(): unknown[] } }) {
  for (const [table, name, type] of accessColumns) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type};`);
  }
  db.exec(accessSchema);
}
