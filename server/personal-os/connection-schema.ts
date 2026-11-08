// Several model providers ("供应商") per Core (migration v45). model_connections had one row, id 'default'; it
// becomes the first provider and the default one. Rows are only added to, never rewritten: existing values stay.
// A removed provider is status='revoked' (task_runs keep a foreign key to it), so it is never deleted.
export const connectionSchema = `
ALTER TABLE model_connections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1));
ALTER TABLE model_connections ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1));
ALTER TABLE model_connections ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE model_connections SET is_default=1 WHERE id='default';
CREATE TABLE model_options (
  connection_id TEXT NOT NULL REFERENCES model_connections(id),
  model TEXT NOT NULL,
  image_input INTEGER CHECK (image_input IS NULL OR image_input IN (0,1)),
  reasoning_levels_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (connection_id, model)
) STRICT;
ALTER TABLE agent_model_settings ADD COLUMN reasoning TEXT;
`;

// Model display names a provider's list reports (migration v46): some proxies rewrite ids and keep the real name in
// display_name. Keyed like model_visibility, so it applies to whichever provider uses that format and address.
export const modelNameSchema = `
CREATE TABLE model_display_names (
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (provider, endpoint, model)
) STRICT;
`;
