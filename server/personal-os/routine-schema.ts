export const routineSchema = `
ALTER TABLE agent_routines ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'action' CHECK(task_kind IN ('reminder','monitor','report','action'));
ALTER TABLE agent_routines ADD COLUMN run_at INTEGER;
UPDATE agent_routines SET task_kind=CASE schedule_kind WHEN 'once' THEN 'reminder' WHEN 'interval' THEN 'monitor' ELSE 'report' END;
UPDATE agent_routines SET run_at=COALESCE(next_due_at,(SELECT MAX(scheduled_at) FROM routine_occurrences WHERE routine_id=agent_routines.id)) WHERE schedule_kind='once';
UPDATE agent_routines SET interval_ms=300000,version=version+1 WHERE schedule_kind='interval' AND interval_ms<300000;
CREATE TABLE routine_occurrences_v2 (
 id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES agent_routines(id), routine_version INTEGER NOT NULL,
 scheduled_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped')),
 task_id TEXT UNIQUE REFERENCES tasks(id), created_at INTEGER NOT NULL,
 name TEXT NOT NULL, prompt TEXT NOT NULL, task_kind TEXT NOT NULL,
 trigger_source TEXT NOT NULL CHECK(trigger_source IN ('schedule','manual')), expires_at INTEGER,
 reason TEXT, started_at INTEGER, finished_at INTEGER,
 UNIQUE(routine_id,scheduled_at), CHECK((status='running') <= (task_id IS NOT NULL))
) STRICT;
INSERT INTO routine_occurrences_v2
 SELECT o.id,o.routine_id,o.routine_version,o.scheduled_at,o.status,o.task_id,o.created_at,
 r.name,r.prompt,r.task_kind,CASE WHEN o.id LIKE 'manual:%' THEN 'manual' ELSE 'schedule' END,
 CASE WHEN o.id LIKE 'manual:%' THEN NULL ELSE o.scheduled_at + CASE r.task_kind WHEN 'reminder' THEN 300000 WHEN 'monitor' THEN MIN(COALESCE(r.interval_ms,900000),900000) WHEN 'report' THEN 43200000 ELSE 1800000 END END,
 NULL,t.created_at,t.ended_at
 FROM routine_occurrences o JOIN agent_routines r ON r.id=o.routine_id LEFT JOIN tasks t ON t.id=o.task_id;
DROP TABLE routine_occurrences;
ALTER TABLE routine_occurrences_v2 RENAME TO routine_occurrences;
CREATE INDEX routine_pending ON routine_occurrences(status,scheduled_at);
UPDATE routine_occurrences SET status='skipped',reason='已合并到最新一次执行',finished_at=created_at
 WHERE status='pending' AND trigger_source='schedule' AND EXISTS(
 SELECT 1 FROM routine_occurrences newer WHERE newer.routine_id=routine_occurrences.routine_id
 AND newer.status='pending' AND newer.trigger_source='schedule' AND newer.scheduled_at>routine_occurrences.scheduled_at);
`;
