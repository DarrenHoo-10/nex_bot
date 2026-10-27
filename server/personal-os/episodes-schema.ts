// Episode archives: one row per closed stretch of a conversation (see episodes.ts), their full-text index,
// the one-shot "new topic" marks of conversations, and the memory pump's cursor over archives.
// All of it is derived data: originals (agent_messages, projection entries) are never changed by it.
export const episodeSchema = `
CREATE TABLE IF NOT EXISTS conversation_episodes(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),conversation_id TEXT NOT NULL,first_entry TEXT NOT NULL,last_entry TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,open_items TEXT NOT NULL,refs_json TEXT NOT NULL,tokens INTEGER NOT NULL,created_at INTEGER NOT NULL,brief TEXT NOT NULL,detail_json TEXT NOT NULL,UNIQUE(conversation_id,last_entry)) STRICT;
CREATE INDEX IF NOT EXISTS conversation_episodes_bot ON conversation_episodes(bot_id,created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_episode_search USING fts5(episode_id UNINDEXED,body,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS conversation_topic_marks(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),input_seq INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;
ALTER TABLE assistant_memory_settings ADD COLUMN episode_cursor INTEGER NOT NULL DEFAULT 0;
`;
