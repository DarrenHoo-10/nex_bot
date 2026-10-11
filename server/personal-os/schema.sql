-- Provisional design contract, pending P0 runtime validation. NEW fixture databases only.
-- Normative behavior: 2026-10-07-personal-ai-os-domain-model.md
-- All times are UTC epoch milliseconds; JSON shapes require module-level validation.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
BEGIN IMMEDIATE;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','disabled','deleted')),
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  core_id TEXT NOT NULL UNIQUE,
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','disabled','deleted')),
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (workspace_id, user_id)
) STRICT;

CREATE TABLE external_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  protocol TEXT NOT NULL CHECK (protocol IN ('native-v1','oidc')),
  issuer TEXT NOT NULL COLLATE BINARY,
  subject TEXT NOT NULL COLLATE BINARY,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (protocol, issuer, subject),
  UNIQUE (id, user_id),
  UNIQUE (id, user_id, protocol),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
) STRICT;
CREATE TRIGGER external_identity_key_immutable
BEFORE UPDATE OF user_id, protocol, issuer, subject ON external_identities
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.protocol IS NOT OLD.protocol
  OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject
BEGIN SELECT RAISE(ABORT, 'external identity key is immutable'); END;

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  protocol TEXT NOT NULL CHECK (protocol IN ('local','native-v1','oidc')),
  external_identity_id TEXT,
  upstream_session_ref TEXT,
  revocation_mode TEXT NOT NULL CHECK (revocation_mode IN ('local','native_status','session_expiry','introspection')),
  status_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id),
  FOREIGN KEY (external_identity_id, user_id, protocol) REFERENCES external_identities(id, user_id, protocol),
  CHECK (expires_at > created_at),
  CHECK ((protocol = 'local' AND external_identity_id IS NULL AND revocation_mode = 'local')
    OR (protocol = 'native-v1' AND external_identity_id IS NOT NULL AND upstream_session_ref IS NOT NULL AND revocation_mode = 'native_status')
    OR (protocol = 'oidc' AND external_identity_id IS NOT NULL AND revocation_mode IN ('session_expiry','introspection'))),
  CHECK (revocation_mode != 'introspection' OR upstream_session_ref IS NOT NULL)
) STRICT;
CREATE INDEX user_sessions_user ON user_sessions(workspace_id, user_id, expires_at);

CREATE TABLE login_transactions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('native-v1','oidc')),
  client_binding_hash TEXT NOT NULL CHECK (length(client_binding_hash) = 64),
  nonce_hash TEXT NOT NULL UNIQUE CHECK (length(nonce_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending','consumed','denied','expired')),
  state_hash TEXT UNIQUE,
  secret_ref TEXT, -- encrypted verifier or upstream transaction reference, never passwords
  challenge_json TEXT CHECK (challenge_json IS NULL OR json_valid(challenge_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (expires_at > created_at),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK (protocol != 'oidc' OR state_hash IS NOT NULL),
  CHECK (protocol != 'oidc' OR status != 'pending' OR secret_ref IS NOT NULL),
  CHECK (status = 'pending' OR secret_ref IS NULL)
) STRICT;
CREATE INDEX login_transactions_expiry ON login_transactions(status, expires_at);

CREATE TABLE model_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  credential_ref TEXT,
  default_model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','disabled','revoked')),
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, workspace_id, owner_user_id),
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES memberships(workspace_id, user_id),
  CHECK (status != 'active' OR credential_ref IS NOT NULL)
) STRICT;

CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  model_connection_id TEXT,
  model_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','archived','deleted')),
  legacy_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, workspace_id, owner_user_id),
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES memberships(workspace_id, user_id),
  FOREIGN KEY (model_connection_id, workspace_id, owner_user_id) REFERENCES model_connections(id, workspace_id, owner_user_id)
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','archived','deleted')),
  legacy_thread_id TEXT UNIQUE,
  next_input_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_input_seq > 0),
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, workspace_id, owner_user_id, bot_id),
  FOREIGN KEY (bot_id, workspace_id, owner_user_id) REFERENCES bots(id, workspace_id, owner_user_id)
) STRICT;
CREATE INDEX conversations_bot ON conversations(workspace_id, bot_id, created_at);

CREATE TABLE bot_policies (
  bot_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('ask','allow_scoped')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (bot_id, workspace_id, owner_user_id) REFERENCES bots(id, workspace_id, owner_user_id)
) STRICT;

CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  sdk_version TEXT NOT NULL,
  format_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','closed','invalid')),
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, workspace_id, owner_user_id, conversation_id, bot_id),
  UNIQUE (id, workspace_id, owner_user_id, conversation_id),
  FOREIGN KEY (conversation_id, workspace_id, owner_user_id, bot_id) REFERENCES conversations(id, workspace_id, owner_user_id, bot_id)
) STRICT;
CREATE UNIQUE INDEX runtime_one_active ON runtime_sessions(conversation_id) WHERE status = 'active';

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  initiated_by_session_id TEXT NOT NULL,
  authorized_session_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_approval','paused','needs_reconciliation','cancelling','succeeded','failed','cancelled')),
  max_model_calls INTEGER NOT NULL CHECK (max_model_calls > 0),
  max_tool_calls INTEGER NOT NULL CHECK (max_tool_calls > 0),
  token_budget INTEGER NOT NULL CHECK (token_budget > 0),
  deadline_at INTEGER NOT NULL,
  run_generation INTEGER NOT NULL DEFAULT 0 CHECK (run_generation >= 0),
  result_summary TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, workspace_id, owner_user_id, conversation_id, bot_id),
  UNIQUE (id, workspace_id, owner_user_id),
  FOREIGN KEY (conversation_id, workspace_id, owner_user_id, bot_id) REFERENCES conversations(id, workspace_id, owner_user_id, bot_id),
  FOREIGN KEY (initiated_by_session_id, workspace_id, owner_user_id) REFERENCES user_sessions(id, workspace_id, user_id),
  FOREIGN KEY (authorized_session_id, workspace_id, owner_user_id) REFERENCES user_sessions(id, workspace_id, user_id),
  CHECK (deadline_at > created_at),
  CHECK ((status IN ('succeeded','failed','cancelled')) = (ended_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX tasks_one_open ON tasks(conversation_id) WHERE ended_at IS NULL;
CREATE INDEX tasks_scheduling ON tasks(status, deadline_at);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  run_no INTEGER NOT NULL CHECK (run_no > 0),
  worker_instance_id TEXT NOT NULL,
  model_connection_id TEXT NOT NULL,
  model_connection_version INTEGER NOT NULL CHECK (model_connection_version > 0),
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','waiting','ended','interrupted')),
  wait_started_at INTEGER,
  release_after_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (task_id, run_no),
  UNIQUE (id, task_id, workspace_id, owner_user_id, conversation_id, bot_id, runtime_session_id),
  FOREIGN KEY (task_id, workspace_id, owner_user_id, conversation_id, bot_id) REFERENCES tasks(id, workspace_id, owner_user_id, conversation_id, bot_id),
  FOREIGN KEY (runtime_session_id, workspace_id, owner_user_id, conversation_id, bot_id) REFERENCES runtime_sessions(id, workspace_id, owner_user_id, conversation_id, bot_id),
  FOREIGN KEY (model_connection_id, workspace_id, owner_user_id) REFERENCES model_connections(id, workspace_id, owner_user_id),
  CHECK ((status IN ('ended','interrupted')) = (ended_at IS NOT NULL)),
  CHECK ((wait_started_at IS NULL) = (release_after_at IS NULL)),
  CHECK (release_after_at IS NULL OR release_after_at >= wait_started_at),
  CHECK (status != 'waiting' OR release_after_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX runs_one_active ON task_runs(conversation_id) WHERE ended_at IS NULL;

CREATE TABLE model_invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  request_key TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('answer','compact','title','runtime_internal')),
  purpose_detail TEXT,
  status TEXT NOT NULL CHECK (status IN ('prepared','in_flight','succeeded','failed','cancelled','unknown')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_microusd INTEGER CHECK (cost_microusd IS NULL OR cost_microusd >= 0),
  usage_known INTEGER NOT NULL DEFAULT 0 CHECK (usage_known IN (0,1)),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (run_id, request_key),
  CHECK (usage_known = 0 OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
  CHECK ((purpose = 'runtime_internal' AND purpose_detail IS NOT NULL AND length(purpose_detail) BETWEEN 1 AND 64)
    OR (purpose != 'runtime_internal' AND purpose_detail IS NULL))
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  task_id TEXT,
  storage_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  media_type TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (id, workspace_id, owner_user_id),
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES memberships(workspace_id, user_id),
  FOREIGN KEY (task_id, workspace_id, owner_user_id) REFERENCES tasks(id, workspace_id, owner_user_id)
) STRICT;

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  assistant_entry_id TEXT NOT NULL,
  provider_tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('device','memory','connector')),
  target_id TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
  canonical_envelope TEXT NOT NULL CHECK (json_valid(canonical_envelope)),
  argument_hash TEXT NOT NULL CHECK (length(argument_hash) = 64),
  digest_version INTEGER NOT NULL DEFAULT 1 CHECK (digest_version = 1),
  status TEXT NOT NULL CHECK (status IN ('proposed','awaiting_approval','ready','executing','succeeded','failed','unknown','cancelled','rejected')),
  authorization_snapshot_json TEXT CHECK (authorization_snapshot_json IS NULL OR json_valid(authorization_snapshot_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
  result_artifact_id TEXT,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (runtime_session_id, assistant_entry_id, provider_tool_call_id),
  UNIQUE (id, workspace_id, owner_user_id, conversation_id),
  UNIQUE (id, workspace_id, owner_user_id, bot_id, target_kind, target_id),
  UNIQUE (id, workspace_id, owner_user_id, argument_hash),
  FOREIGN KEY (run_id, task_id, workspace_id, owner_user_id, conversation_id, bot_id, runtime_session_id)
    REFERENCES task_runs(id, task_id, workspace_id, owner_user_id, conversation_id, bot_id, runtime_session_id),
  FOREIGN KEY (result_artifact_id, workspace_id, owner_user_id) REFERENCES artifacts(id, workspace_id, owner_user_id),
  CHECK (status NOT IN ('succeeded','failed') OR (result_hash IS NOT NULL AND (result_json IS NOT NULL OR result_artifact_id IS NOT NULL)))
) STRICT;
CREATE INDEX tool_calls_task ON tool_calls(task_id, status);
CREATE TRIGGER tool_call_input_immutable
BEFORE UPDATE OF arguments_json, canonical_envelope, argument_hash, digest_version, tool_name, tool_version, target_kind, target_id ON tool_calls
WHEN NEW.arguments_json IS NOT OLD.arguments_json OR NEW.argument_hash IS NOT OLD.argument_hash
  OR NEW.canonical_envelope IS NOT OLD.canonical_envelope OR NEW.digest_version IS NOT OLD.digest_version
  OR NEW.tool_name IS NOT OLD.tool_name OR NEW.tool_version IS NOT OLD.tool_version
  OR NEW.target_kind IS NOT OLD.target_kind OR NEW.target_id IS NOT OLD.target_id
BEGIN SELECT RAISE(ABORT, 'tool call input is immutable'); END;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('windows','macos','linux')),
  protocol_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enrolling','bound','revoked')),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, workspace_id, owner_user_id),
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES memberships(workspace_id, user_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
) STRICT;

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  family_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  access_hash TEXT NOT NULL UNIQUE CHECK (length(access_hash) = 64),
  refresh_hash TEXT NOT NULL UNIQUE CHECK (length(refresh_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('active','rotated','revoked')),
  issued_at INTEGER NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_idle_expires_at INTEGER NOT NULL,
  family_expires_at INTEGER NOT NULL,
  UNIQUE (family_id, generation),
  CHECK (access_expires_at > issued_at AND refresh_idle_expires_at > issued_at),
  CHECK (refresh_idle_expires_at <= family_expires_at)
) STRICT;
CREATE UNIQUE INDEX credentials_one_current ON device_credentials(device_id) WHERE status = 'active';

CREATE TABLE device_enrollments (
  id TEXT PRIMARY KEY,
  poll_secret_hash TEXT NOT NULL UNIQUE CHECK (length(poll_secret_hash) = 64),
  verification_code_hash TEXT NOT NULL UNIQUE CHECK (length(verification_code_hash) = 64),
  registration_json TEXT NOT NULL CHECK (json_valid(registration_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','consumed','denied','expired')),
  workspace_id TEXT,
  owner_user_id TEXT,
  approved_by_session_id TEXT,
  device_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES memberships(workspace_id, user_id),
  FOREIGN KEY (approved_by_session_id, workspace_id, owner_user_id) REFERENCES user_sessions(id, workspace_id, user_id),
  FOREIGN KEY (device_id, workspace_id, owner_user_id) REFERENCES devices(id, workspace_id, owner_user_id),
  CHECK (expires_at > created_at),
  CHECK ((workspace_id IS NULL) = (owner_user_id IS NULL)),
  CHECK (status NOT IN ('approved','consumed') OR (workspace_id IS NOT NULL AND approved_by_session_id IS NOT NULL)),
  CHECK (status != 'consumed' OR device_id IS NOT NULL)
) STRICT;
CREATE INDEX device_enrollments_expiry ON device_enrollments(status, expires_at);

CREATE TABLE device_local_grants (
  device_id TEXT NOT NULL,
  local_grant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, local_grant_id),
  UNIQUE (device_id, local_grant_id, workspace_id, owner_user_id),
  FOREIGN KEY (device_id, workspace_id, owner_user_id) REFERENCES devices(id, workspace_id, owner_user_id)
) STRICT;

CREATE TABLE device_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  local_grant_id TEXT NOT NULL,
  local_policy_version INTEGER NOT NULL CHECK (local_policy_version > 0),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  status TEXT NOT NULL CHECK (status IN ('active','revoked','stale')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, workspace_id, owner_user_id, bot_id, device_id, local_grant_id),
  UNIQUE (id, workspace_id, owner_user_id),
  FOREIGN KEY (bot_id, workspace_id, owner_user_id) REFERENCES bots(id, workspace_id, owner_user_id),
  FOREIGN KEY (device_id, local_grant_id, workspace_id, owner_user_id) REFERENCES device_local_grants(device_id, local_grant_id, workspace_id, owner_user_id),
  CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX device_grants_lookup ON device_grants(bot_id, device_id, status, expires_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  argument_hash TEXT NOT NULL CHECK (length(argument_hash) = 64),
  bot_policy_version INTEGER NOT NULL CHECK (bot_policy_version > 0),
  device_grant_id TEXT,
  grant_version INTEGER CHECK (grant_version IS NULL OR grant_version > 0),
  local_policy_version INTEGER CHECK (local_policy_version IS NULL OR local_policy_version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','cancelled','consumed')),
  decided_by_session_id TEXT,
  decided_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tool_call_id, workspace_id, owner_user_id, argument_hash) REFERENCES tool_calls(id, workspace_id, owner_user_id, argument_hash),
  FOREIGN KEY (device_grant_id, workspace_id, owner_user_id) REFERENCES device_grants(id, workspace_id, owner_user_id),
  FOREIGN KEY (decided_by_session_id, workspace_id, owner_user_id) REFERENCES user_sessions(id, workspace_id, user_id),
  CHECK (expires_at > created_at),
  CHECK ((device_grant_id IS NULL AND grant_version IS NULL AND local_policy_version IS NULL)
    OR (device_grant_id IS NOT NULL AND grant_version IS NOT NULL AND local_policy_version IS NOT NULL)),
  CHECK (status NOT IN ('approved','rejected','consumed') OR (decided_by_session_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX approvals_one_live ON approvals(tool_call_id) WHERE status IN ('pending','approved');

CREATE TABLE device_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  target_kind TEXT NOT NULL DEFAULT 'device' CHECK (target_kind = 'device'),
  device_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  local_grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK (grant_version > 0),
  local_policy_version INTEGER NOT NULL CHECK (local_policy_version > 0),
  status TEXT NOT NULL CHECK (status IN ('queued','delivered','running','succeeded','failed','cancelled','unknown')),
  delivery_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  lease_seq INTEGER NOT NULL DEFAULT 0 CHECK (lease_seq >= 0),
  lease_issued_at INTEGER,
  lease_expires_at INTEGER,
  deadline_at INTEGER NOT NULL,
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  received_at INTEGER,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (id, workspace_id, owner_user_id, bot_id, target_kind, device_id)
    REFERENCES tool_calls(id, workspace_id, owner_user_id, bot_id, target_kind, target_id),
  FOREIGN KEY (grant_id, workspace_id, owner_user_id, bot_id, device_id, local_grant_id)
    REFERENCES device_grants(id, workspace_id, owner_user_id, bot_id, device_id, local_grant_id),
  CHECK (deadline_at > created_at),
  CHECK ((lease_issued_at IS NULL) = (lease_expires_at IS NULL)),
  CHECK (lease_expires_at IS NULL OR (lease_expires_at > lease_issued_at AND lease_expires_at <= lease_issued_at + 30000 AND lease_expires_at <= deadline_at)),
  CHECK (status NOT IN ('delivered','running') OR (lease_seq > 0 AND lease_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('succeeded','failed') OR (result_hash IS NOT NULL AND result_json IS NOT NULL AND received_at IS NOT NULL))
) STRICT;
CREATE INDEX device_calls_queue ON device_calls(device_id, status, created_at);
CREATE UNIQUE INDEX device_calls_one_inflight ON device_calls(device_id) WHERE status IN ('delivered','running','unknown');

CREATE TABLE runtime_deliveries (
  runtime_session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending','applied','blocked')),
  runtime_entry_id TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  PRIMARY KEY (runtime_session_id, tool_call_id),
  FOREIGN KEY (runtime_session_id, workspace_id, owner_user_id, conversation_id) REFERENCES runtime_sessions(id, workspace_id, owner_user_id, conversation_id),
  FOREIGN KEY (tool_call_id, workspace_id, owner_user_id, conversation_id) REFERENCES tool_calls(id, workspace_id, owner_user_id, conversation_id),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CHECK (status != 'applied' OR runtime_entry_id IS NOT NULL)
) STRICT;

CREATE TABLE memory_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('bot','workspace')),
  bot_id TEXT,
  title TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  status TEXT NOT NULL CHECK (status IN ('active','deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, workspace_id, owner_user_id),
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES memberships(workspace_id, user_id),
  FOREIGN KEY (bot_id, workspace_id, owner_user_id) REFERENCES bots(id, workspace_id, owner_user_id),
  CHECK ((scope = 'bot' AND bot_id IS NOT NULL) OR (scope = 'workspace' AND bot_id IS NULL))
) STRICT;
CREATE INDEX memory_documents_scope ON memory_documents(workspace_id, scope, bot_id, status);

-- Acknowledged user input is durable independently of a live SDK worker.
CREATE TABLE conversation_inputs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  sender_session_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  input_seq INTEGER NOT NULL CHECK (input_seq > 0),
  input_kind TEXT NOT NULL CHECK (input_kind IN ('start','steer','supplement')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('accepted','discarded')),
  discarded_reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, owner_user_id, client_message_id),
  UNIQUE (conversation_id, input_seq),
  UNIQUE (id, workspace_id, owner_user_id, conversation_id, bot_id),
  FOREIGN KEY (task_id, workspace_id, owner_user_id, conversation_id, bot_id)
    REFERENCES tasks(id, workspace_id, owner_user_id, conversation_id, bot_id),
  FOREIGN KEY (sender_session_id, workspace_id, owner_user_id) REFERENCES user_sessions(id, workspace_id, user_id),
  CHECK (status != 'discarded' OR discarded_reason IS NOT NULL)
) STRICT;
CREATE INDEX conversation_inputs_pending ON conversation_inputs(task_id, status, input_seq);
CREATE TRIGGER conversation_input_immutable
BEFORE UPDATE OF content_json, request_hash, client_message_id, input_seq, task_id, input_kind ON conversation_inputs
WHEN NEW.content_json IS NOT OLD.content_json OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.client_message_id IS NOT OLD.client_message_id OR NEW.input_seq IS NOT OLD.input_seq
  OR NEW.task_id IS NOT OLD.task_id OR NEW.input_kind IS NOT OLD.input_kind
BEGIN SELECT RAISE(ABORT, 'accepted input is immutable'); END;

-- First version pins an accepted input to one runtime binding; no automatic rebinding.
CREATE TABLE runtime_input_deliveries (
  input_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('prompt','steer')),
  status TEXT NOT NULL CHECK (status IN ('pending','applied','consumed','blocked','discarded')),
  runtime_entry_id TEXT,
  applied_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (input_id, workspace_id, owner_user_id, conversation_id, bot_id)
    REFERENCES conversation_inputs(id, workspace_id, owner_user_id, conversation_id, bot_id),
  FOREIGN KEY (runtime_session_id, workspace_id, owner_user_id, conversation_id, bot_id)
    REFERENCES runtime_sessions(id, workspace_id, owner_user_id, conversation_id, bot_id),
  CHECK (status NOT IN ('applied','consumed') OR (runtime_entry_id IS NOT NULL AND applied_at IS NOT NULL)),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
) STRICT;

CREATE TABLE memory_write_receipts (
  tool_call_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  target_kind TEXT NOT NULL DEFAULT 'memory' CHECK (target_kind = 'memory'),
  memory_document_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  committed_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  storage_key TEXT NOT NULL,
  result_hash TEXT NOT NULL CHECK (length(result_hash) = 64),
  committed_at INTEGER NOT NULL,
  FOREIGN KEY (tool_call_id, workspace_id, owner_user_id, bot_id, target_kind, memory_document_id)
    REFERENCES tool_calls(id, workspace_id, owner_user_id, bot_id, target_kind, target_id),
  FOREIGN KEY (memory_document_id, workspace_id, owner_user_id) REFERENCES memory_documents(id, workspace_id, owner_user_id),
  CHECK (committed_version = expected_version + 1)
) STRICT;
CREATE TRIGGER memory_receipt_no_update BEFORE UPDATE ON memory_write_receipts
BEGIN SELECT RAISE(ABORT, 'memory write receipts are immutable'); END;
CREATE TRIGGER memory_receipt_no_delete BEFORE DELETE ON memory_write_receipts
BEGIN SELECT RAISE(ABORT, 'memory write receipts are immutable'); END;

-- Evidence is append-only. State resolution requires application guards and a CAS.
CREATE TABLE call_reconciliations (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  argument_hash TEXT NOT NULL CHECK (length(argument_hash) = 64),
  decision_key TEXT NOT NULL,
  expected_call_version INTEGER NOT NULL CHECK (expected_call_version > 0),
  source TEXT NOT NULL CHECK (source IN ('device_result','tool_receipt','owner_attestation')),
  outcome TEXT NOT NULL CHECK (outcome IN ('confirmed_succeeded','confirmed_failed','confirmed_not_executed','confirmed_stopped','inconclusive')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  evidence_artifact_id TEXT,
  reviewed_by_session_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (tool_call_id, decision_key),
  FOREIGN KEY (tool_call_id, workspace_id, owner_user_id, argument_hash) REFERENCES tool_calls(id, workspace_id, owner_user_id, argument_hash),
  FOREIGN KEY (evidence_artifact_id, workspace_id, owner_user_id) REFERENCES artifacts(id, workspace_id, owner_user_id),
  FOREIGN KEY (reviewed_by_session_id, workspace_id, owner_user_id) REFERENCES user_sessions(id, workspace_id, user_id),
  CHECK (source != 'owner_attestation' OR reviewed_by_session_id IS NOT NULL)
) STRICT;
CREATE TRIGGER reconciliation_no_update BEFORE UPDATE ON call_reconciliations
BEGIN SELECT RAISE(ABORT, 'reconciliation evidence is append-only'); END;
CREATE TRIGGER reconciliation_no_delete BEFORE DELETE ON call_reconciliations
BEGIN SELECT RAISE(ABORT, 'reconciliation evidence is append-only'); END;

CREATE TABLE command_receipts (
  workspace_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, actor_user_id, command_type, idempotency_key),
  FOREIGN KEY (workspace_id, actor_user_id) REFERENCES memberships(workspace_id, user_id)
) STRICT;

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','processing','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at INTEGER NOT NULL,
  claim_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  CHECK (status != 'processing' OR claim_expires_at IS NOT NULL),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
) STRICT;
CREATE INDEX outbox_ready ON outbox_events(status, available_at);

CREATE TABLE audit_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, actor_user_id) REFERENCES memberships(workspace_id, user_id)
) STRICT;
CREATE INDEX audit_entity ON audit_records(workspace_id, entity_type, entity_id, created_at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_records
BEGIN SELECT RAISE(ABORT, 'audit records are append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_records
BEGIN SELECT RAISE(ABORT, 'audit records are append-only'); END;

COMMIT;
