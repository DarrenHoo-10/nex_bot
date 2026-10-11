CREATE UNIQUE INDEX tasks_agent_identity ON tasks(id,bot_id);
CREATE TABLE agent_bootstrap(id INTEGER PRIMARY KEY CHECK(id=1),completed_at INTEGER NOT NULL) STRICT;
CREATE TABLE agent_inboxes (
 bot_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
 active_task_id TEXT, read_seq INTEGER NOT NULL DEFAULT 0 CHECK(read_seq>=0),
 next_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_seq>read_seq),
 UNIQUE(bot_id,workspace_id,owner_user_id),
 FOREIGN KEY(bot_id,workspace_id,owner_user_id) REFERENCES bots(id,workspace_id,owner_user_id),
 FOREIGN KEY(active_task_id,bot_id) REFERENCES tasks(id,bot_id)
) STRICT;
CREATE TABLE agent_messages (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
 seq INTEGER NOT NULL CHECK(seq>0), role TEXT NOT NULL CHECK(role IN ('user','assistant','peer','system')),
 kind TEXT NOT NULL CHECK(kind IN ('message','request','result','activity','error')),
 sender_bot_id TEXT REFERENCES bots(id), task_id TEXT REFERENCES tasks(id),
 content TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
 UNIQUE(bot_id,seq),
 FOREIGN KEY(bot_id,workspace_id,owner_user_id) REFERENCES agent_inboxes(bot_id,workspace_id,owner_user_id)
) STRICT;
CREATE INDEX agent_messages_order ON agent_messages(bot_id,seq);
CREATE TABLE agent_input_receipts (
 bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id), client_message_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
 PRIMARY KEY(bot_id,client_message_id)
) STRICT;
CREATE TABLE agent_task_links (
 task_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id),
 origin TEXT NOT NULL CHECK(origin IN ('owner','routine')), source_key TEXT NOT NULL UNIQUE,
 FOREIGN KEY(task_id,bot_id) REFERENCES tasks(id,bot_id)
) STRICT;
CREATE TABLE agent_journal (
 task_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id),
 objective TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL,
 FOREIGN KEY(task_id,bot_id) REFERENCES tasks(id,bot_id)
) STRICT;
CREATE TABLE agent_routines (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id), name TEXT NOT NULL, prompt TEXT NOT NULL,
 schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('once','interval','daily')),
 interval_ms INTEGER, local_time TEXT, time_zone TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_due_at INTEGER,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at INTEGER NOT NULL,
 CHECK(enabled=0 OR next_due_at IS NOT NULL),
 CHECK((schedule_kind='interval' AND interval_ms>=60000) OR (schedule_kind!='interval' AND interval_ms IS NULL)),
 CHECK((schedule_kind='daily' AND local_time IS NOT NULL) OR (schedule_kind!='daily' AND local_time IS NULL))
) STRICT;
CREATE TABLE routine_occurrences (
 id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES agent_routines(id), routine_version INTEGER NOT NULL,
 scheduled_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
 task_id TEXT UNIQUE REFERENCES tasks(id), created_at INTEGER NOT NULL,
 UNIQUE(routine_id,scheduled_at), CHECK((status='running') <= (task_id IS NOT NULL))
) STRICT;
CREATE INDEX routine_pending ON routine_occurrences(status,scheduled_at);
