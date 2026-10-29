export const todoSchema = `
CREATE TABLE todos (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 owner_user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', bot_id TEXT REFERENCES bots(id),
 due_date TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL CHECK(priority IN ('高','普通','低')),
 status TEXT NOT NULL CHECK(status IN ('todo','running','review','done')),
 steps_json TEXT NOT NULL DEFAULT '[]', task_id TEXT REFERENCES tasks(id),
 version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 deleted_at INTEGER
) STRICT;
CREATE TABLE todo_events(id INTEGER PRIMARY KEY, todo_id TEXT NOT NULL REFERENCES todos(id),
 label TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE todo_runs(client_id TEXT PRIMARY KEY, todo_id TEXT NOT NULL REFERENCES todos(id),
 request_hash TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id)) STRICT;
CREATE TRIGGER todo_task_ended AFTER UPDATE ON tasks
WHEN NEW.ended_at IS NOT NULL AND EXISTS(SELECT 1 FROM todos WHERE task_id=NEW.id AND status='running') BEGIN
 INSERT INTO todo_events(todo_id,label,created_at)
 SELECT id,CASE NEW.status WHEN 'succeeded' THEN 'AI 已交付，等待验收' WHEN 'cancelled' THEN '执行已停止' ELSE '执行未完成，可重试' END,NEW.ended_at
 FROM todos WHERE task_id=NEW.id AND status='running';
 UPDATE todos SET status=CASE NEW.status WHEN 'succeeded' THEN 'review' ELSE 'todo' END,
 version=version+1,updated_at=NEW.ended_at WHERE task_id=NEW.id AND status='running';
END;
CREATE INDEX todos_updated ON todos(workspace_id,deleted_at,updated_at);
${["INSERT", "UPDATE", "DELETE"].map((op) => `CREATE TRIGGER sync_todos_${op} AFTER ${op} ON todos BEGIN INSERT INTO sync_events(kind,created_at) VALUES('state',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;`).join("\n")}
`;
