// Migration 35: topic entries (docs/plans/memory-recall.md sections 4.5, 4.9 and 5).
//  - assistant_memories gains the kind 'topic' (a title and a body of at most 400 tokens). SQLite cannot alter a CHECK
//    constraint, so the table is rebuilt once, keeping every row and its rowid; the migration is a no-op when the
//    table already allows topics, so running it twice changes nothing. Retired rows use status 'retired'.
//  - assistant_topic_evidence: the atomic facts (and folded observations) a topic rests on. The topic row's own
//    refs_json is the union of their source references, so `valid()` still checks a topic against the originals and
//    forgetting a source reaches every topic that cites it.
//  - assistant_topics: what the core memory index says about a topic (one summary line) and what was last written there.
//  - assistant_topic_state: when the core memory was last patched from topics, and how many facts were merged since.
//  - assistant_memory_migrations: one row per assistant and one-time migration (marker, snapshot and progress).
export const TOPIC_MIGRATION = 35;

export const assistantMemoriesTable = (name: string) => `CREATE TABLE ${name}(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),kind TEXT NOT NULL CHECK(kind IN ('fact','experience','observation','understanding','topic')),title TEXT NOT NULL,content TEXT NOT NULL,refs_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;`;

/** The statements that rebuild assistant_memories with the topic kind (run only when it does not allow it yet). */
export const rebuildMemories = `
${assistantMemoriesTable('assistant_memories_v35')}
INSERT INTO assistant_memories_v35(rowid,id,bot_id,kind,title,content,refs_json,version,status,created_at,updated_at) SELECT rowid,id,bot_id,kind,title,content,refs_json,version,status,created_at,updated_at FROM assistant_memories ORDER BY rowid;
DROP TABLE assistant_memories;
ALTER TABLE assistant_memories_v35 RENAME TO assistant_memories;
CREATE INDEX assistant_memories_bank ON assistant_memories(bot_id,status,kind);
`;

export const topicSchema = `
CREATE INDEX IF NOT EXISTS assistant_memories_bank ON assistant_memories(bot_id,status,kind);
CREATE TABLE IF NOT EXISTS assistant_topic_evidence(topic_id TEXT NOT NULL,memory_id TEXT NOT NULL,added_at INTEGER NOT NULL,PRIMARY KEY(topic_id,memory_id)) STRICT;
CREATE INDEX IF NOT EXISTS assistant_topic_evidence_memory ON assistant_topic_evidence(memory_id);
CREATE TABLE IF NOT EXISTS assistant_topics(topic_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,summary TEXT NOT NULL,indexed_title TEXT,indexed_summary TEXT,indexed_at INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS assistant_topic_state(bot_id TEXT PRIMARY KEY,core_patched_at INTEGER NOT NULL DEFAULT 0,facts_since_patch INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS assistant_memory_migrations(bot_id TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','done')),snapshot_rowid INTEGER NOT NULL,triaged_rowid INTEGER NOT NULL DEFAULT 0,retired INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL,completed_at INTEGER,PRIMARY KEY(bot_id,name)) STRICT;
DELETE FROM assistant_memory_steps WHERE step='understanding';
`;
