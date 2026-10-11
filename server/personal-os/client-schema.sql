CREATE TABLE client_invites (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE client_sessions (
 session_id TEXT PRIMARY KEY REFERENCES user_sessions(id), name TEXT NOT NULL,
 last_seen_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sync_state (id INTEGER PRIMARY KEY CHECK(id=1), privacy_epoch INTEGER NOT NULL DEFAULT 0) STRICT;
INSERT INTO sync_state VALUES(1,0);
CREATE TABLE sync_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE routine_tool_receipts (
 call_id TEXT PRIMARY KEY REFERENCES tool_calls(id), argument_hash TEXT NOT NULL,
 result_json TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE routine_origins (
 routine_id TEXT NOT NULL REFERENCES agent_routines(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 PRIMARY KEY(routine_id,task_id)
) STRICT;
