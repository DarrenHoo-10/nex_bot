-- Core owns delivery/source identity only. Hindsight owns extracted facts,
-- vectors, entities, observations and knowledge pages in its PostgreSQL.
CREATE TABLE bot_public_profiles (
 bot_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
 expertise_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(expertise_json) AND json_type(expertise_json)='array'),
 FOREIGN KEY(bot_id,workspace_id,owner_user_id) REFERENCES bots(id,workspace_id,owner_user_id)
) STRICT;
CREATE TABLE memory_bank_bindings (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('bot','workspace')), bot_id TEXT,
 provider_bank_id TEXT NOT NULL UNIQUE, content_generation INTEGER NOT NULL DEFAULT 0,
 visibility_generation INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('provisioning','ready','unavailable','quarantined','deleted')),
 CHECK((scope='bot' AND bot_id IS NOT NULL) OR (scope='workspace' AND bot_id IS NULL)),
 UNIQUE(id,workspace_id,owner_user_id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES memberships(workspace_id,user_id),
 FOREIGN KEY(bot_id,workspace_id,owner_user_id) REFERENCES bots(id,workspace_id,owner_user_id)
) STRICT;
CREATE UNIQUE INDEX private_bank ON memory_bank_bindings(bot_id) WHERE scope='bot';
CREATE UNIQUE INDEX shared_bank ON memory_bank_bindings(workspace_id) WHERE scope='workspace';
CREATE TABLE memory_document_versions (
 document_id TEXT NOT NULL REFERENCES memory_documents(id), version INTEGER NOT NULL,
 content TEXT NOT NULL, title TEXT NOT NULL, content_hash TEXT NOT NULL,
 PRIMARY KEY(document_id,version)
) STRICT;
CREATE TABLE memory_source_registry (
 id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES memory_bank_bindings(id),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('document','message')), original_id TEXT NOT NULL,
 source_version INTEGER NOT NULL, content_hash TEXT NOT NULL, source_class TEXT NOT NULL,
 root_origin_key TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), occurred_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','superseded','retracted')),
 UNIQUE(bank_id,source_kind,original_id,source_version), UNIQUE(id,bank_id)
) STRICT;
CREATE TABLE memory_transfers (
 id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES memory_bank_bindings(id),
 source_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('retain','rebuild')),
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','unknown','cancelled')),
 provider_operation_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, created_at INTEGER NOT NULL,
 FOREIGN KEY(source_id,bank_id) REFERENCES memory_source_registry(id,bank_id)
) STRICT;
CREATE UNIQUE INDEX retain_source_once ON memory_transfers(source_id) WHERE kind='retain';
CREATE UNIQUE INDEX one_rebuild ON memory_transfers(bank_id) WHERE kind='rebuild' AND status IN ('queued','running','unknown');
CREATE TABLE memory_transfer_receipts (
 transfer_id TEXT PRIMARY KEY REFERENCES memory_transfers(id), content_hash TEXT NOT NULL,
 committed_generation INTEGER NOT NULL, committed_at INTEGER NOT NULL
) STRICT;
CREATE TABLE memory_provider_documents (
 source_id TEXT PRIMARY KEY, bank_id TEXT NOT NULL, provider_document_id TEXT NOT NULL,
 UNIQUE(bank_id,provider_document_id), FOREIGN KEY(source_id,bank_id) REFERENCES memory_source_registry(id,bank_id)
) STRICT;
CREATE TABLE memory_bank_retirements (
 provider_bank_id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES memory_bank_bindings(id),
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','unknown')),
 created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE memory_model_invocations (
 id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES memory_bank_bindings(id),
 engine_operation_id TEXT NOT NULL, purpose TEXT NOT NULL, task_id TEXT REFERENCES tasks(id),
 reserved_tokens INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('in_flight','succeeded','failed','unknown')),
 input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
