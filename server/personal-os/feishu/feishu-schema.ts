export const feishuSchema = `
ALTER TABLE personal_connectors ADD COLUMN kind TEXT NOT NULL DEFAULT 'mcp';
CREATE TABLE personal_feishu_apps (
 connector_id TEXT PRIMARY KEY REFERENCES personal_connectors(id) ON DELETE CASCADE,
 app_id TEXT NOT NULL UNIQUE, brand TEXT NOT NULL CHECK(brand IN ('feishu','lark')),
 app_secret TEXT NOT NULL, owner_open_id TEXT, bind_code TEXT, bind_expires_at INTEGER,
 bot_id TEXT NOT NULL REFERENCES bots(id), bot_open_id TEXT,
 user_token TEXT, user_scopes_json TEXT NOT NULL DEFAULT '[]', user_token_expires_at INTEGER,
 connection TEXT NOT NULL DEFAULT 'idle' CHECK(connection IN ('idle','connected','busy','disabled','error')),
 error TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE personal_feishu_messages (
 message_id TEXT PRIMARY KEY, app_id TEXT NOT NULL,
 chat_id TEXT NOT NULL, chat_type TEXT NOT NULL, sender_open_id TEXT NOT NULL,
 task_id TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE personal_feishu_outbound (
 source_key TEXT PRIMARY KEY, app_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 message_id TEXT, created_at INTEGER NOT NULL
) STRICT;
`;
