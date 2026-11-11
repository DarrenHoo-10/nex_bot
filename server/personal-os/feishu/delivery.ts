import { type CoreStore, now } from "../store.ts";

/** Additive, restart-safe channel ledger. No provider call takes place inside a DB transaction. */
export function ensureFeishuDeliverySchema(store: CoreStore) {
  store.transaction(() => {
    const add = (table: string, name: string, type: string) => {
      if (!store.all(`PRAGMA table_info(${table})`).some((c) => c.name === name)) store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    };
    // Old message ids were global. Scope them by application and chat before accepting new events.
    if (store.all("PRAGMA table_info(personal_feishu_messages)").filter((c) => Number(c.pk)).length === 1) {
      store.db.exec(`ALTER TABLE personal_feishu_messages RENAME TO personal_feishu_messages_legacy;
        CREATE TABLE personal_feishu_messages(message_id TEXT NOT NULL, app_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,chat_type TEXT NOT NULL,sender_open_id TEXT NOT NULL,task_id TEXT,created_at INTEGER NOT NULL,
        PRIMARY KEY(app_id,chat_id,message_id)) STRICT;
        INSERT INTO personal_feishu_messages SELECT * FROM personal_feishu_messages_legacy;
        DROP TABLE personal_feishu_messages_legacy;`);
    }
    for (const [name, type] of Object.entries({ conversation_id: "TEXT", root_id: "TEXT", parent_id: "TEXT", thread_id: "TEXT", payload: "TEXT", state: "TEXT NOT NULL DEFAULT 'pending'", attempts: "INTEGER NOT NULL DEFAULT 0", next_at: "INTEGER NOT NULL DEFAULT 0", error: "TEXT" })) add("personal_feishu_messages", name, type);
    // Historic records have no event payload and must never be replayed as new input.
    store.run("UPDATE personal_feishu_messages SET state=CASE WHEN task_id IS NULL THEN 'ignored' ELSE 'routed' END WHERE payload IS NULL AND state='pending'");
    store.db.exec(`CREATE TABLE IF NOT EXISTS feishu_topic_aliases(app_id TEXT NOT NULL,chat_id TEXT NOT NULL,alias TEXT NOT NULL,
      conversation_id TEXT NOT NULL,root_id TEXT NOT NULL,job_id TEXT,PRIMARY KEY(app_id,chat_id,alias)) STRICT;
      CREATE TABLE IF NOT EXISTS feishu_destinations(app_id TEXT NOT NULL,chat_id TEXT NOT NULL,chat_type TEXT NOT NULL,
      actor_open_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(app_id,chat_id)) STRICT;
      CREATE TABLE IF NOT EXISTS feishu_subscription_receipts(call_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS feishu_subscriptions(id TEXT PRIMARY KEY,app_id TEXT NOT NULL,chat_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,kinds_json TEXT NOT NULL,scenarios_json TEXT NOT NULL,audience TEXT NOT NULL,
      enabled INTEGER NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(app_id,chat_id,instance_id)) STRICT;
      CREATE TABLE IF NOT EXISTS feishu_delivery_parts(id TEXT PRIMARY KEY,source_key TEXT NOT NULL,app_id TEXT NOT NULL,chat_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,root_id TEXT,job_id TEXT,content TEXT NOT NULL,part INTEGER NOT NULL,
      operation TEXT NOT NULL DEFAULT 'send',target_id TEXT,message_id TEXT,uuid TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
      subscription_id TEXT,subscription_version INTEGER,content_kind TEXT,audience TEXT NOT NULL DEFAULT 'private',
      actor_open_id TEXT,created_at INTEGER NOT NULL,UNIQUE(source_key,app_id,chat_id,part)) STRICT;`);
    add("feishu_delivery_parts","scenario","TEXT NOT NULL DEFAULT 'proactive'");
    add("feishu_delivery_parts", "first_post_at", "INTEGER");
    add("feishu_delivery_parts", "post_tracking_version", "INTEGER NOT NULL DEFAULT 0");
    add("feishu_delivery_parts", "error", "TEXT");
    store.db.exec(`CREATE TABLE IF NOT EXISTS feishu_delivery_reconciliations(
      id TEXT PRIMARY KEY,part_id TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,
      evidence TEXT NOT NULL,message_id TEXT,previous_uuid TEXT NOT NULL,first_post_at INTEGER,
      recorded_at INTEGER NOT NULL) STRICT;`);
    // Legacy attempted POSTs have no trustworthy start time. Never infer it from queue creation.
    store.run("UPDATE feishu_delivery_parts SET state='needs_reconciliation',error='legacy_unknown_post_time' WHERE post_tracking_version=0 AND attempts>0 AND operation='send' AND state IN ('pending','sending')");
    store.run("UPDATE feishu_delivery_parts SET post_tracking_version=1 WHERE post_tracking_version=0 AND (attempts=0 OR operation='patch')");
  });
}

/** Feishu's UUID guarantee lasts one hour from the first actual POST, not queue creation. */
export const FEISHU_UUID_WINDOW_MS = 60 * 60 * 1000;
export function postWindowExpired(part: { first_post_at?: unknown }, at = now()) {
  return part.first_post_at != null && (at < Number(part.first_post_at) || at >= Number(part.first_post_at) + FEISHU_UUID_WINDOW_MS);
}

export function retryAt(attempts: number) { return now() + Math.min(60_000, 500 * 2 ** Math.min(attempts, 7)); }
