export const connectorSchema = `
CREATE TABLE personal_connectors (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
 name TEXT NOT NULL, url TEXT NOT NULL, transport TEXT NOT NULL CHECK(transport IN ('http','sse')),
 enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
 credential TEXT, tools_json TEXT NOT NULL DEFAULT '[]', checked_at INTEGER,
 error TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE personal_connector_grants (
 connector_id TEXT NOT NULL REFERENCES personal_connectors(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 tools_json TEXT NOT NULL, PRIMARY KEY(connector_id,bot_id)
) STRICT;
`;
