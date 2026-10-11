CREATE TABLE memory_task_sources (
 task_id TEXT NOT NULL REFERENCES tasks(id), source_id TEXT NOT NULL REFERENCES memory_source_registry(id),
 PRIMARY KEY(task_id,source_id)
) STRICT;
CREATE TABLE memory_task_dependencies (
 task_id TEXT NOT NULL REFERENCES tasks(id), parent_task_id TEXT NOT NULL REFERENCES tasks(id),
 PRIMARY KEY(task_id,parent_task_id), CHECK(task_id!=parent_task_id)
) STRICT;
CREATE TABLE memory_source_edges (
 source_id TEXT NOT NULL REFERENCES memory_source_registry(id), parent_id TEXT NOT NULL REFERENCES memory_source_registry(id),
 PRIMARY KEY(source_id,parent_id), CHECK(source_id!=parent_id)
) STRICT;
CREATE TABLE memory_forget_rules (
 id TEXT PRIMARY KEY, selector_hash TEXT NOT NULL, plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
 status TEXT NOT NULL CHECK(status IN ('pending','cleaning','completed')), created_at INTEGER NOT NULL, completed_at INTEGER
) STRICT;
CREATE TABLE memory_forgotten_tasks (task_id TEXT PRIMARY KEY REFERENCES tasks(id)) STRICT;
CREATE TABLE memory_tombstones (content_hash TEXT PRIMARY KEY) STRICT;
CREATE TABLE memory_privacy_maintenance (id INTEGER PRIMARY KEY CHECK(id=1),active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;
INSERT INTO memory_privacy_maintenance VALUES(1,0);
CREATE TABLE memory_syntheses (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), query TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 generations_json TEXT NOT NULL CHECK(json_valid(generations_json)), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE memory_publications (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES memory_source_registry(id), document_id TEXT NOT NULL REFERENCES memory_documents(id),
 source_hash TEXT NOT NULL, intent_hash TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
