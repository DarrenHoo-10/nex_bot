-- Frozen schema v1 fields are historical compatibility data only. Rename
-- them explicitly; manual task execution does not consult numeric limits.
ALTER TABLE tasks RENAME COLUMN max_model_calls TO legacy_max_model_calls;
ALTER TABLE tasks RENAME COLUMN max_tool_calls TO legacy_max_tool_calls;
ALTER TABLE tasks RENAME COLUMN token_budget TO legacy_token_budget;
ALTER TABLE tasks RENAME COLUMN deadline_at TO legacy_deadline_at;
