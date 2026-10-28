// Migration 34: what enters the prompt (docs/plans/memory-recall.md sections 4.2, 4.3 and 4.4).
//  - assistant_core_memory: the small always-loaded memory, one row per assistant (scope 'bot') and one for the
//    workspace (scope 'workspace', bot_id ''). `content` is JSON {about, topics}; see core-memory.ts.
//  - core_memory_receipts: one row per tool call that changed it, so a replayed call returns its first result.
//  - task_recall: the memories recalled for a task, computed once before its first model request (an empty block
//    is stored too, so a skipped or failed recall is not retried), and reused by every later request and run.
//  - conversation_working_notes: the working note of one conversation. assistant_working_notes (per assistant) is
//    kept untouched for rollback; the notes it holds are copied by the migration.
/** A conversation's working note may hold at most this many tokens; Core-written notes are compressed to WORKING_NOTE_TARGET first. */
export const WORKING_NOTE_TOKENS = 1000;
export const WORKING_NOTE_TARGET = 800;
export const recallSchema = `
CREATE TABLE IF NOT EXISTS assistant_core_memory(scope TEXT NOT NULL CHECK(scope IN ('bot','workspace')),bot_id TEXT NOT NULL,content TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,bot_id),CHECK((scope='workspace')=(bot_id=''))) STRICT;
CREATE TABLE IF NOT EXISTS core_memory_receipts(tool_call_id TEXT PRIMARY KEY,scope TEXT NOT NULL,bot_id TEXT NOT NULL,expected_version INTEGER NOT NULL,committed_version INTEGER NOT NULL,result_json TEXT NOT NULL,committed_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS task_recall(task_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,input_seq INTEGER NOT NULL,status TEXT NOT NULL,block TEXT NOT NULL,tokens INTEGER NOT NULL,refs_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS task_recall_created ON task_recall(created_at);
CREATE INDEX IF NOT EXISTS task_recall_bot ON task_recall(bot_id);
CREATE TABLE IF NOT EXISTS conversation_working_notes(conversation_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,content TEXT NOT NULL,task_id TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS conversation_working_notes_bot ON conversation_working_notes(bot_id);
`;
