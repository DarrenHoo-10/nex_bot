// Migration 32: the three full-text indexes of the memory pool use FTS5's trigram tokenizer, so Chinese, English and
// code identifiers are cut the same way on both sides (every 3 characters), and are rebuilt from their sources.
// Dropping and recreating makes the migration safe to run again. The row text is `title \n content`, the same
// text `indexBody` (retrieval-index.ts) writes later.
export const trigramSchema = `
DROP TABLE IF EXISTS assistant_memory_search;
CREATE VIRTUAL TABLE assistant_memory_search USING fts5(memory_id UNINDEXED,body,tokenize='trigram');
INSERT INTO assistant_memory_search(memory_id,body) SELECT id,title||char(10)||content FROM assistant_memories WHERE status='active';
DROP TABLE IF EXISTS conversation_episode_search;
CREATE VIRTUAL TABLE conversation_episode_search USING fts5(episode_id UNINDEXED,body,tokenize='trigram');
INSERT INTO conversation_episode_search(episode_id,body) SELECT id,title||char(10)||summary FROM conversation_episodes;
DROP TABLE IF EXISTS memory_search;
CREATE VIRTUAL TABLE memory_search USING fts5(document_id UNINDEXED,title,content,tokenize='trigram');
INSERT INTO memory_search(document_id,title,content) SELECT d.id,d.title,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.status='active';
`;

// Migration 33: embeddings of memories, episode archives and memory documents, and the user's own retrieval
// settings (one row per model kind; the API key is a separate row of the secrets table).
// A vector is only used while its model and dimensions match the configuration and its content_hash matches
// the current text, so it can never describe content that has since changed.
export const vectorSchema = `
CREATE TABLE IF NOT EXISTS memory_vectors(kind TEXT NOT NULL CHECK(kind IN ('memory','episode','document')),ref_id TEXT NOT NULL,model TEXT NOT NULL,dims INTEGER NOT NULL,vector BLOB NOT NULL,content_hash TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,ref_id)) STRICT;
CREATE TABLE IF NOT EXISTS memory_retrieval_settings(kind TEXT PRIMARY KEY CHECK(kind IN ('embedding','rerank')),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),format TEXT,base_url TEXT NOT NULL,model TEXT NOT NULL,dimensions INTEGER,version INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL) STRICT;
`;
