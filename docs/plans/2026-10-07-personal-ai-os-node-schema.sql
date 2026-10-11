-- Provisional Node journal pending P0; no shared transaction/database with Core.
-- Core supplied IDs have no foreign keys into Core; validate authenticated binding.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
BEGIN IMMEDIATE;

CREATE TABLE node_bindings (
  id TEXT PRIMARY KEY,
  core_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  core_origin TEXT NOT NULL,
  credential_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL,
  UNIQUE (core_id, device_id)
) STRICT;
CREATE UNIQUE INDEX node_one_binding ON node_bindings(status) WHERE status = 'active';

CREATE TABLE local_grants (
  binding_id TEXT NOT NULL REFERENCES node_bindings(id),
  id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  root_mapping_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, id)
) STRICT;

CREATE TABLE node_calls (
  binding_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  local_grant_id TEXT NOT NULL,
  local_policy_version INTEGER NOT NULL CHECK (local_policy_version > 0),
  capability TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
  canonical_envelope TEXT NOT NULL CHECK (json_valid(canonical_envelope)),
  argument_hash TEXT NOT NULL CHECK (length(argument_hash) = 64),
  digest_version INTEGER NOT NULL DEFAULT 1 CHECK (digest_version = 1),
  status TEXT NOT NULL CHECK (status IN ('received','running','succeeded','failed','cancelled','unknown')),
  lease_seq INTEGER NOT NULL CHECK (lease_seq > 0),
  lease_expires_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  process_identity_json TEXT CHECK (process_identity_json IS NULL OR json_valid(process_identity_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64),
  result_acknowledged_at INTEGER,
  received_at INTEGER NOT NULL,
  finished_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (binding_id, call_id),
  FOREIGN KEY (binding_id, local_grant_id) REFERENCES local_grants(binding_id, id),
  CHECK (lease_expires_at <= deadline_at),
  CHECK ((status IN ('succeeded','failed','cancelled')) = (finished_at IS NOT NULL)),
  CHECK (status NOT IN ('succeeded','failed') OR (result_json IS NOT NULL AND result_hash IS NOT NULL)),
  CHECK (result_acknowledged_at IS NULL OR result_hash IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX node_one_inflight ON node_calls(binding_id) WHERE status IN ('received','running','unknown');
CREATE TRIGGER node_call_input_immutable
BEFORE UPDATE OF arguments_json, canonical_envelope, argument_hash, digest_version, capability, local_grant_id, local_policy_version ON node_calls
WHEN NEW.arguments_json IS NOT OLD.arguments_json OR NEW.argument_hash IS NOT OLD.argument_hash
  OR NEW.canonical_envelope IS NOT OLD.canonical_envelope OR NEW.digest_version IS NOT OLD.digest_version
  OR NEW.capability IS NOT OLD.capability OR NEW.local_grant_id IS NOT OLD.local_grant_id
  OR NEW.local_policy_version IS NOT OLD.local_policy_version
BEGIN SELECT RAISE(ABORT, 'node call input is immutable'); END;

COMMIT;
