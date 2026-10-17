export const appearanceSchema = `CREATE TABLE bot_appearance (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id),
  appearance_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);`;
