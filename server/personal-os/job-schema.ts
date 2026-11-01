// Background jobs: an assistant's long work runs in its own conversation and reports back to the one message stream.
// Rebuilds agent_task_links (only its CHECK changes, every row is kept), adds the job, report, receipt and device
// lease tables, and makes the todo trigger skip jobs, whose todos follow the job's reports instead (see jobs.ts).
export const jobSchema = `
CREATE TABLE agent_task_links_v2 (
 task_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id),
 origin TEXT NOT NULL CHECK(origin IN ('owner','routine','job')), source_key TEXT NOT NULL UNIQUE,
 FOREIGN KEY(task_id,bot_id) REFERENCES tasks(id,bot_id)
) STRICT;
INSERT INTO agent_task_links_v2 SELECT task_id,bot_id,origin,source_key FROM agent_task_links;
DROP TABLE agent_task_links;
ALTER TABLE agent_task_links_v2 RENAME TO agent_task_links;
CREATE TABLE agent_jobs (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id),
 conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
 origin_task_id TEXT REFERENCES tasks(id), todo_id TEXT REFERENCES todos(id),
 title TEXT NOT NULL, brief_json TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE,
 progress TEXT, progress_at INTEGER, stopped_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX agent_jobs_bot ON agent_jobs(bot_id,created_at);
CREATE INDEX agent_jobs_todo ON agent_jobs(todo_id);
CREATE TABLE agent_job_reports (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES agent_jobs(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 state TEXT NOT NULL CHECK(state IN ('ready','question','blocked','failed','dropped')),
 summary TEXT NOT NULL, question TEXT, waiting_for TEXT, automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)),
 message_id TEXT REFERENCES agent_messages(id), created_at INTEGER NOT NULL,
 CHECK((state='question') = (question IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX agent_job_reports_task ON agent_job_reports(task_id);
CREATE INDEX agent_job_reports_job ON agent_job_reports(job_id,created_at);
CREATE TABLE job_tool_receipts (call_id TEXT PRIMARY KEY REFERENCES tool_calls(id), argument_hash TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
CREATE TABLE device_resource_leases (
 device_id TEXT NOT NULL REFERENCES devices(id), resource TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id), acquired_at INTEGER NOT NULL,
 PRIMARY KEY(device_id,resource)
) STRICT;
CREATE INDEX device_resource_leases_task ON device_resource_leases(task_id);
${["INSERT", "UPDATE", "DELETE"].flatMap((op) => ["agent_jobs", "agent_job_reports"].map((table) => `CREATE TRIGGER sync_${table}_${op} AFTER ${op} ON ${table} BEGIN INSERT INTO sync_events(kind,created_at) VALUES('state',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;`)).join("\n")}
DROP TRIGGER todo_task_ended;
CREATE TRIGGER todo_task_ended AFTER UPDATE ON tasks
WHEN NEW.ended_at IS NOT NULL AND EXISTS(SELECT 1 FROM todos WHERE task_id=NEW.id AND status='running')
 AND NOT EXISTS(SELECT 1 FROM agent_task_links WHERE task_id=NEW.id AND origin='job') BEGIN
 INSERT INTO todo_events(todo_id,label,created_at)
 SELECT id,CASE NEW.status WHEN 'succeeded' THEN 'AI 已交付，等待验收' WHEN 'cancelled' THEN '执行已停止' ELSE '执行未完成，可重试' END,NEW.ended_at
 FROM todos WHERE task_id=NEW.id AND status='running';
 UPDATE todos SET status=CASE NEW.status WHEN 'succeeded' THEN 'review' ELSE 'todo' END,
 version=version+1,updated_at=NEW.ended_at WHERE task_id=NEW.id AND status='running';
END;
`;
