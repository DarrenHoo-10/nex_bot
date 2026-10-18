export const continuitySchema = `
CREATE TABLE assistant_conversations(bot_id TEXT PRIMARY KEY REFERENCES bots(id),conversation_id TEXT NOT NULL REFERENCES conversations(id)) STRICT;
CREATE TABLE assistant_working_notes(bot_id TEXT PRIMARY KEY REFERENCES bots(id),content TEXT NOT NULL,task_id TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE assistant_memory_uses(task_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(task_id,message_id)) STRICT;
CREATE TABLE assistant_memory_imports(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),from_seq INTEGER NOT NULL,to_seq INTEGER NOT NULL,offset INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE assistant_memory_settings(bot_id TEXT PRIMARY KEY REFERENCES bots(id),enabled INTEGER NOT NULL DEFAULT 0,model TEXT NOT NULL DEFAULT '',daily_budget INTEGER NOT NULL DEFAULT 100000,cursor_seq INTEGER NOT NULL DEFAULT 0,cursor_offset INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,last_success INTEGER,last_error TEXT,next_attempt INTEGER NOT NULL DEFAULT 0,consolidated_at INTEGER NOT NULL DEFAULT 0,profile_at INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE assistant_memories(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),kind TEXT NOT NULL CHECK(kind IN ('fact','experience','observation','understanding')),title TEXT NOT NULL,content TEXT NOT NULL,refs_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
CREATE INDEX assistant_memories_bank ON assistant_memories(bot_id,status,kind);
CREATE VIRTUAL TABLE assistant_memory_search USING fts5(memory_id UNINDEXED,body,tokenize='unicode61');
CREATE TABLE assistant_memory_versions(id TEXT NOT NULL,version INTEGER NOT NULL,content TEXT NOT NULL,refs_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(id,version)) STRICT;
CREATE TABLE assistant_usage(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),task_id TEXT,purpose TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,reserved_tokens INTEGER NOT NULL,input_tokens INTEGER,cache_read INTEGER,cache_write INTEGER,output_tokens INTEGER,created_at INTEGER NOT NULL,finished_at INTEGER) STRICT;
CREATE INDEX assistant_usage_bank ON assistant_usage(bot_id,created_at);
CREATE TABLE context_checkpoints(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),task_id TEXT NOT NULL,conversation_id TEXT NOT NULL,summary TEXT NOT NULL,first_entry TEXT NOT NULL,last_entry TEXT NOT NULL,tokens_before INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;
ALTER TABLE model_invocations ADD COLUMN cache_read INTEGER;
ALTER TABLE model_invocations ADD COLUMN cache_write INTEGER;
ALTER TABLE model_invocations ADD COLUMN memory_tokens INTEGER;
`;
