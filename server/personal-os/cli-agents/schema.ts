// Agent mode ("cli-agent") tables, migration 50. The SQL lives in a TS string,
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

// Migration 51: pending permission / question requests from the Claude hook
// (design section 8) and the supervisor's settings and action log (section 9).
// The request text is encrypted at rest like cached transcript items; `tool`
// is only a tool name. No sync_events triggers, for the same reason as above.
export const cliAgentRequestSchema = `
CREATE TABLE cli_agent_requests (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('permission','question')),
  tool TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  options_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','answered','resolved','expired')),
  decided_by TEXT,
  decision_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cli_agent_requests_session ON cli_agent_requests(session_key, status);
CREATE INDEX cli_agent_requests_pending ON cli_agent_requests(status, expires_at);

CREATE TABLE cli_agent_supervision (
  scope TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE cli_agent_supervision_actions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  turn INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('retry','usage_limit','wakeup')),
  attempt INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','recovered','skipped','failed','cancelled')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (session_key, turn, ended_at)
) STRICT;
CREATE INDEX cli_agent_supervision_actions_session ON cli_agent_supervision_actions(session_key, created_at);
CREATE INDEX cli_agent_supervision_actions_due ON cli_agent_supervision_actions(status, due_at);
`;

// Migration 55 (workbench plan section 3): the engine column becomes an open
// Harness id, and the workbench gets logical sessions, the outbox queue and
// per-queue state. `cli_agent_sessions` must be rebuilt without the fixed
// engine CHECK; the copy runs with foreign keys off so the drop cannot cascade
// into the cached items. Sensitive text (outbox bodies) is encrypted by the
// store like transcript items, never here.
export const cliAgentSessionsRebuild = `
CREATE TABLE cli_agent_sessions_m55 (
  key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  engine TEXT NOT NULL,
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
INSERT INTO cli_agent_sessions_m55
  SELECT key,device_id,engine,native_id,config_dir,cwd,title,git_branch,state,waiting_for,live_in,terminal,model,cli_version,last_activity_at,hidden,first_seen_at,updated_at
  FROM cli_agent_sessions;
DROP TABLE cli_agent_sessions;
ALTER TABLE cli_agent_sessions_m55 RENAME TO cli_agent_sessions;
CREATE INDEX cli_agent_sessions_recent ON cli_agent_sessions(device_id, last_activity_at DESC);
`;

export const cliAgentWorkbenchSchema = `
CREATE TABLE cli_agent_workbench (
  id TEXT PRIMARY KEY,
  session_key TEXT,
  device_id TEXT,
  engine TEXT,
  cwd TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES cli_agent_workbench(id),
  kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main','fork','side')),
  title TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cli_agent_workbench_key ON cli_agent_workbench(session_key);
CREATE INDEX cli_agent_workbench_children ON cli_agent_workbench(parent_id, created_at);

CREATE TABLE cli_agent_outbox (
  id TEXT PRIMARY KEY,
  workbench_id TEXT NOT NULL REFERENCES cli_agent_workbench(id),
  session_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  client_message_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  body TEXT NOT NULL,
  revises_message_id TEXT,
  delivery TEXT NOT NULL CHECK (delivery IN ('send','queue','steer')),
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','sent','confirmed','failed','withdrawn','uncertain')),
  error_code TEXT,
  /** the cli_agent_ops row of the dispatch in flight or last attempted */
  op_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workbench_id, client_message_id)
) STRICT;
CREATE INDEX cli_agent_outbox_queue ON cli_agent_outbox(workbench_id, seq);

CREATE TABLE cli_agent_queue_state (
  workbench_id TEXT PRIMARY KEY REFERENCES cli_agent_workbench(id),
  session_key TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  pause_reason TEXT,
  next_seq INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE cli_agent_send_requests (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  outbox_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
`;
