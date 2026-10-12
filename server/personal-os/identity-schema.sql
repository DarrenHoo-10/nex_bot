-- Identity binding is persisted; production uses the built-in NexorAI issuer.
CREATE TABLE identity_provider (
 id INTEGER PRIMARY KEY CHECK(id=1), type TEXT NOT NULL CHECK(type='nex-user'),
 base_url TEXT NOT NULL, display_name TEXT NOT NULL,
 external_identity_id TEXT REFERENCES external_identities(id),
 connected INTEGER NOT NULL DEFAULT 0 CHECK(connected IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK(connected=0 OR external_identity_id IS NOT NULL)
) STRICT;
CREATE TABLE identity_revocations (
 session_id TEXT PRIMARY KEY REFERENCES user_sessions(id),
 secret_ref TEXT NOT NULL REFERENCES secrets(id),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER sync_identity_provider_insert AFTER INSERT ON identity_provider
BEGIN INSERT INTO sync_events(kind,created_at) VALUES('state',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
CREATE TRIGGER sync_identity_provider_update AFTER UPDATE ON identity_provider
BEGIN INSERT INTO sync_events(kind,created_at) VALUES('state',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
