// Agent mode ("cli-agent") tables, migration 48. The SQL lives in a TS string,
// like todo-schema.ts, because the build copies only a fixed set of .sql files.
// No sync_events triggers: these tables change constantly, and a trigger would
// make every client refetch the whole state each time. The hub calls changed()
// itself when the waiting/running counts move.
export const cliAgentSchema = `
CREATE TABLE cli_agent_sessions (
  key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('claude','codex')),
  native_id TEXT NOT NULL,
  config_dir TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  git_branch TEXT,
  state TEXT NOT NULL CHECK (state IN ('running','waiting','idle','stopped')),
  waiting_for TEXT,
  live_in TEXT CHECK (live_in IN ('nexbot','terminal','desktop','background')),
  terminal TEXT,
  model TEXT,
  cli_version TEXT,
  last_activity_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cli_agent_sessions_recent ON cli_agent_sessions(device_id, last_activity_at DESC);

CREATE TABLE cli_agent_items (
  session_key TEXT NOT NULL REFERENCES cli_agent_sessions(key) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (session_key, item_id)
) STRICT;
CREATE INDEX cli_agent_items_ts ON cli_agent_items(session_key, ts);

CREATE TABLE cli_agent_ops (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  session_key TEXT,
  op TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','succeeded','failed','unknown')),
  error_code TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
`;
