import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { basicActions } from "./policy.ts";
import { isLegacyDefaultTools } from "./policy-defaults.ts";
import type { AttachmentObjects } from './attachment-objects.ts';
import { connectorSchema } from "./connector-schema.ts";
import { feishuSchema } from "./feishu/feishu-schema.ts";
import { appearanceSchema } from "./appearance-schema.ts";
import { continuitySchema } from "./continuity-schema.ts";
import { ModelLimits, modelLimitScope, parseModelLimit, validateModelLimits, type ModelCatalogConfig, type ModelLimitOverrides } from "./model-limits.ts";

export type Row = Record<string, string | number | null>;
export const id = () => randomUUID();
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const now = () => Date.now();
export function text(value: unknown, max = 32_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("请输入有效内容（长度超出限制或为空）");
  return value.trim();
}
export function optionalText(value: unknown, max = 32_000): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max) throw new Error("请输入有效内容（长度超出限制或类型不正确）");
  return value.trim();
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

// Business facts use the frozen Core schema. These additive tables hold the
// renderer transcript, adapter projection, content and durable local A2A inbox.
const extension = `
CREATE TABLE secrets(id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL) STRICT;
CREATE TABLE transcript(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 task_id TEXT REFERENCES tasks(id), role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
 content TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT;
CREATE INDEX transcript_order ON transcript(conversation_id,created_at);
CREATE TABLE memory_content(document_id TEXT PRIMARY KEY REFERENCES memory_documents(id), content TEXT NOT NULL) STRICT;
CREATE VIRTUAL TABLE memory_search USING fts5(document_id UNINDEXED,title,content,tokenize='unicode61');
CREATE TABLE a2a_messages(id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE REFERENCES tool_calls(id),
 parent_task_id TEXT NOT NULL REFERENCES tasks(id), sender_bot_id TEXT NOT NULL REFERENCES bots(id),
 receiver_bot_id TEXT NOT NULL REFERENCES bots(id), child_conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
 child_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), root_task_id TEXT NOT NULL REFERENCES tasks(id),
 depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 3), status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 payload TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, finished_at INTEGER) STRICT;
`;

export class CoreStore {
  attachmentObjects?: AttachmentObjects;
  readonly attachmentJobs = new Map<string, Promise<void>>();
  private transactionDepth = 0;
  readonly db: DatabaseSync;
  readonly dir: string;
  readonly owner = "local-owner";
  readonly workspace = "personal";
  readonly session = "desktop-owner";
  readonly modelLimits: ModelLimits;
  constructor(dir: string, readonly key: Buffer, token: string, catalog?: ModelCatalogConfig) {
    if (key.length !== 32) throw new Error("Invalid credential vault key");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = realpathSync(dir);
    this.modelLimits = new ModelLimits(this.dir, catalog);
    const legacy = process.env.OMB_DATA_DIR;
    if (legacy && existsSync(legacy) && realpathSync(legacy).toLowerCase() === this.dir.toLowerCase()) throw new Error("Personal OS data must be separate from legacy data");
    const marker = path.join(this.dir, "backend.json");
    if (existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).backend !== "personal-os") throw new Error("Incompatible data directory");
    writeFileSync(marker, JSON.stringify({ backend: "personal-os", format: 1 }), { mode: 0o600 });
    this.db = new DatabaseSync(path.join(this.dir, "core.db"));
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS model_limit_overrides (provider TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, context_window INTEGER, max_output_tokens INTEGER, PRIMARY KEY(provider,endpoint,model))");
    const sql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    if (!this.get("SELECT name FROM sqlite_master WHERE name='schema_migrations'")) this.db.exec(sql);
    this.db.exec("CREATE TABLE IF NOT EXISTS agent_model_settings (bot_id TEXT NOT NULL REFERENCES bots(id),provider TEXT NOT NULL,endpoint TEXT NOT NULL,model TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(bot_id,provider,endpoint)) STRICT");
    if (!this.get("SELECT version FROM schema_migrations WHERE version=1")) {
      this.transaction(() => {
        this.db.exec(extension);
        this.insert("schema_migrations", { version: 1, checksum: hash(sql + extension), applied_at: now() });
        this.insert("users", { id: this.owner, display_name: "Owner", status: "active", created_at: now() });
        this.insert("workspaces", { id: this.workspace, core_id: id(), owner_user_id: this.owner, name: "Personal", status: "active", created_at: now() });
        this.insert("memberships", { workspace_id: this.workspace, user_id: this.owner, status: "active", created_at: now() });
      });
    }
    this.run("INSERT INTO user_sessions(id,workspace_id,user_id,token_hash,protocol,revocation_mode,created_at,expires_at) VALUES(?,?,?,?, 'local','local',?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at", this.session, this.workspace, this.owner, hash(token), now(), now() + 365 * 86_400_000);
    if (!this.get("SELECT version FROM schema_migrations WHERE version=2")) {
      const agentSql = readFileSync(new URL("./agent-schema.sql", import.meta.url), "utf8");
      this.transaction(() => {
        this.db.exec(agentSql);
        this.insert("schema_migrations", { version: 2, checksum: hash(agentSql), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=3")) {
      const memorySql = readFileSync(new URL("./memory-schema.sql", import.meta.url), "utf8");
      this.transaction(() => {
        this.db.exec(memorySql);
        this.run("INSERT INTO memory_document_versions(document_id,version,content,title,content_hash) SELECT d.id,d.version,c.content,d.title,d.content_hash FROM memory_documents d JOIN memory_content c ON c.document_id=d.id");
        this.run("INSERT INTO bot_public_profiles(bot_id,workspace_id,owner_user_id) SELECT id,workspace_id,owner_user_id FROM bots");
        this.insert("schema_migrations", { version: 3, checksum: hash(memorySql), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=4")) {
      const lifecycle = readFileSync(new URL("./memory-lifecycle-schema.sql", import.meta.url), "utf8");
      this.transaction(() => {
        this.db.exec(lifecycle);
        // A reviewed privacy purge may redact payloads while retaining stable
        // identities and original hashes. Ordinary writes remain immutable.
        for (const name of ["tool_call_input_immutable", "conversation_input_immutable", "audit_no_update", "reconciliation_no_update"]) {
          const trigger = this.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", name);
          if (!trigger) continue;
          this.db.exec(`DROP TRIGGER ${name}`);
          this.db.exec(String(trigger.sql).replace(/SELECT RAISE\((ABORT, '[^']*')\);/g, "SELECT CASE WHEN (SELECT active FROM memory_privacy_maintenance WHERE id=1)=0 THEN RAISE($1) END;"));
        }
        this.insert("schema_migrations", { version: 4, checksum: hash(lifecycle), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=5")) {
      const clientSql = readFileSync(new URL("./client-schema.sql", import.meta.url), "utf8");
      this.transaction(() => {
        this.db.exec(clientSql);
        // Body-free durable change markers; SQL triggers also cover mutations
        // committed by recovery/privacy paths which do not call the renderer.
        for (const table of ["bots", "bot_policies", "bot_public_profiles", "agent_messages", "agent_inboxes", "tasks", "approvals", "agent_routines", "routine_occurrences", "memory_documents", "memory_content", "memory_forget_rules", "client_sessions", "user_sessions", "devices", "device_local_grants"]) {
          if (!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table)) continue;
          for (const operation of ["INSERT", "UPDATE", "DELETE"]) this.db.exec(`CREATE TRIGGER sync_${table}_${operation} AFTER ${operation} ON ${table} BEGIN INSERT INTO sync_events(kind,created_at) VALUES('state',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;`);
        }
        for (const [table, condition] of [["agent_messages", "OLD.content IS NOT NEW.content"], ["memory_content", "OLD.content IS NOT NEW.content"]]) {
          this.db.exec(`CREATE TRIGGER privacy_${table}_update AFTER UPDATE ON ${table} WHEN ${condition} BEGIN UPDATE sync_state SET privacy_epoch=privacy_epoch+1 WHERE id=1; END; CREATE TRIGGER privacy_${table}_delete AFTER DELETE ON ${table} BEGIN UPDATE sync_state SET privacy_epoch=privacy_epoch+1 WHERE id=1; END;`);
        }
        this.db.exec("CREATE TRIGGER privacy_memory_status AFTER UPDATE OF status ON memory_documents WHEN OLD.status IS NOT NEW.status BEGIN UPDATE sync_state SET privacy_epoch=privacy_epoch+1 WHERE id=1; END;");
        // Upgrade only the two former standard policies. Deliberately restricted
        // custom policies retain their exact grants.
        const previous = ["memory.search", "memory.reflect", "memory.read", "memory.write", "memory.delete", "memory.forget", "agent.directory", "agent.delegate"];
        for (const policy of this.all("SELECT * FROM bot_policies")) {
          const tools = (JSON.parse(String(policy.policy_json)) as { tools?: string[] }).tools ?? [];
          const normalized = [...new Set(tools)].sort().join(",");
          if ([previous, [...previous, "device.list", "device.read", "device.exec"]].some((p) => [...p].sort().join(",") === normalized)) this.run("UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?", JSON.stringify({ ...JSON.parse(String(policy.policy_json)), tools: [...tools, ...basicActions.filter((a) => a.startsWith("routine."))] }), policy.bot_id);
        }
        this.insert("schema_migrations", { version: 5, checksum: hash(clientSql), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=6")) {
      const legacyTools = ["memory.search", "memory.read", "memory.write", "agent.delegate", "device.read", "device.list", "device.exec"].sort();
      this.transaction(() => {
        // The original desktop seeded this exact policy at version 1. A user
        // edit increments the policy version, so even an identical edited set
        // is preserved. New capabilities must not depend on contact names.
        for (const policy of this.all("SELECT * FROM bot_policies WHERE version=1")) {
          const value = JSON.parse(String(policy.policy_json)) as { tools?: string[] };
          if ([...new Set(value.tools ?? [])].sort().join(",") !== legacyTools.join(",")) continue;
          this.run("UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?", JSON.stringify({ ...value, tools: [...value.tools!, ...basicActions.filter((action) => action.startsWith("routine."))] }), policy.bot_id);
        }
        this.insert("schema_migrations", { version: 6, checksum: hash(JSON.stringify({ legacyTools, added: basicActions.filter((action) => action.startsWith("routine.")), uneditedVersion: 1 })), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=7")) {
      // Freeze the shipped migration; later defaults must not change its hash.
      const version7Actions = basicActions.filter((action) => !["device.exec", "agent.create", "agent.update"].includes(action));
      const oldBasic = ["memory.search", "memory.reflect", "memory.read", "memory.write", "memory.delete", "memory.forget", "agent.directory", "agent.delegate", "routine.list", "routine.save", "routine.toggle", "routine.run"];
      const legacy = ["memory.search", "memory.read", "memory.write", "agent.delegate", "device.read", "device.list", "device.exec", "routine.list", "routine.save", "routine.toggle", "routine.run"];
      const standardSets = [oldBasic, [...oldBasic, "device.list", "device.read", "device.exec"], legacy].map((tools) => [...tools].sort().join(","));
      this.transaction(() => {
        for (const policy of this.all("SELECT * FROM bot_policies")) {
          if (this.get("SELECT id FROM audit_records WHERE action='agent.policy.update' AND entity_id=?", policy.bot_id)) continue;
          const value = JSON.parse(String(policy.policy_json)) as { tools?: string[] };
          if (!standardSets.includes([...new Set(value.tools ?? [])].sort().join(","))) continue;
          this.run("UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?", JSON.stringify({ ...value, tools: [...new Set([...value.tools!, ...version7Actions])] }), policy.bot_id);
        }
        this.insert("schema_migrations", { version: 7, checksum: hash(JSON.stringify({ standardSets, basicActions: version7Actions })), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=8")) {
      const previous = basicActions.filter((action) => action !== "device.exec").sort().join(",");
      const legacyPrevious = basicActions.filter((action) => !["device.exec", "agent.create", "agent.update"].includes(action)).sort().join(",");
      this.transaction(() => {
        for (const policy of this.all("SELECT * FROM bot_policies")) {
          if (this.get("SELECT id FROM audit_records WHERE action='agent.policy.update' AND entity_id=?", policy.bot_id)) continue;
          const value = JSON.parse(String(policy.policy_json)) as { tools?: string[] };
          if (![previous, legacyPrevious].includes([...new Set(value.tools ?? [])].sort().join(","))) continue;
          this.run("UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?", JSON.stringify({ ...value, tools: [...value.tools!, "device.exec"] }), policy.bot_id);
        }
        this.insert("schema_migrations", { version: 8, checksum: hash(JSON.stringify({ previous: legacyPrevious, added: "device.exec", preserveEdited: true })), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=9")) {
      const taskControl = readFileSync(new URL("./task-control-schema.sql", import.meta.url), "utf8");
      this.transaction(() => {
        this.db.exec(taskControl);
        this.insert("schema_migrations", { version: 9, checksum: hash(taskControl), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=10")) {
      const identitySql = readFileSync(new URL("./identity-schema.sql", import.meta.url), "utf8");
      this.transaction(() => {
        this.db.exec(identitySql);
        this.insert("schema_migrations", { version: 10, checksum: hash(identitySql), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=11")) {
      this.transaction(() => {
        this.db.exec(connectorSchema);
        this.insert("schema_migrations", { version: 11, checksum: hash(connectorSchema), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=12")) {
      this.transaction(() => {
        this.db.exec(appearanceSchema);
        this.insert("schema_migrations", { version: 12, checksum: hash(appearanceSchema), applied_at: now() });
      });
    }
    if (!this.get("SELECT version FROM schema_migrations WHERE version=13")) this.transaction(() => {
      const schema = `CREATE TABLE agent_approval_settings(bot_id TEXT PRIMARY KEY REFERENCES bots(id),mode TEXT NOT NULL CHECK(mode IN ('standard','full')),version INTEGER NOT NULL DEFAULT 1) STRICT;
        CREATE TABLE chat_attachments(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),session_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,ciphertext TEXT NOT NULL,created_at INTEGER NOT NULL,message_id TEXT REFERENCES agent_messages(id)) STRICT;`;
      this.db.exec(schema);
      for (const policy of this.all("SELECT * FROM bot_policies")) {
        const value = JSON.parse(String(policy.policy_json));
        if ([...new Set(value.tools ?? [])].sort().join(",") === basicActions.filter((a) => a !== "attachment.read").sort().join(",")) this.run("UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?", JSON.stringify({ ...value, tools: [...value.tools, "attachment.read"] }), policy.bot_id);
      }
      this.insert("schema_migrations", { version: 13, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=14")) this.transaction(() => {
      this.db.exec(continuitySchema);
      this.insert("schema_migrations", { version: 14, checksum: hash(continuitySchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=15")) this.transaction(() => {
      const schema = `CREATE TABLE model_visibility(provider TEXT NOT NULL,endpoint TEXT NOT NULL,models_json TEXT,version INTEGER NOT NULL,PRIMARY KEY(provider,endpoint)) STRICT;`;
      this.db.exec(schema);
      this.insert("schema_migrations", { version: 15, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=16")) this.transaction(() => {
      const schema = `CREATE TABLE workspace_memory_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),version INTEGER NOT NULL DEFAULT 0) STRICT;`;
      this.db.exec(schema);
      // Mixed legacy settings must not silently opt previously disabled assistants in.
      const bots = this.get("SELECT COUNT(*) n,SUM(COALESCE(s.enabled,0)) enabled FROM bots b LEFT JOIN assistant_memory_settings s ON s.bot_id=b.id WHERE b.status='active'")!;
      const enabled = Number(bots.n)>0 && Number(bots.n)===Number(bots.enabled) ? 1 : 0;
      this.run('INSERT INTO workspace_memory_settings(id,enabled) VALUES(1,?)', enabled);
      this.run('UPDATE assistant_memory_settings SET enabled=?,version=version+1', enabled);
      this.insert('schema_migrations', { version: 16, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=17")) this.transaction(() => {
      const schema = "ALTER TABLE workspace_memory_settings ADD COLUMN model TEXT NOT NULL DEFAULT '';";
      this.db.exec(schema);
      const models = this.all("SELECT DISTINCT model FROM assistant_memory_settings WHERE model<>''");
      if (models.length===1) this.run('UPDATE workspace_memory_settings SET model=? WHERE id=1',models[0].model);
      this.insert('schema_migrations', { version: 17, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=18")) this.transaction(() => {
      // A device remembers the client session that paired it, so a message's sender session identifies the sending device.
      const schema = "ALTER TABLE devices ADD COLUMN session_id TEXT;";
      if (!this.all("PRAGMA table_info(devices)").some((column) => column.name === "session_id")) this.db.exec(schema);
      // Devices paired before this version: link only when exactly one live session carries the same client name.
      for (const device of this.all("SELECT id,workspace_id,name FROM devices WHERE status='bound' AND session_id IS NULL")) {
        const sessions = this.all("SELECT s.id FROM client_sessions c JOIN user_sessions s ON s.id=c.session_id WHERE c.name=? AND s.workspace_id=? AND s.revoked_at IS NULL AND s.expires_at>?", device.name as string, device.workspace_id as string, now());
        if (sessions.length === 1) this.run("UPDATE devices SET session_id=? WHERE id=?", sessions[0].id as string, device.id as string);
      }
      this.insert("schema_migrations", { version: 18, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=19")) this.transaction(() => {
      const schema = 'CREATE TABLE image_models(id TEXT PRIMARY KEY,name TEXT NOT NULL,endpoint TEXT NOT NULL,model TEXT NOT NULL,ciphertext TEXT NOT NULL,version INTEGER NOT NULL) STRICT;';
      this.db.exec(schema);
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) this.db.exec(`CREATE TRIGGER sync_image_models_${operation} AFTER ${operation} ON image_models BEGIN INSERT INTO sync_events(kind,created_at) VALUES('state',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;`);
      const oldDefault = basicActions.filter(action => !action.startsWith('image.')).sort().join(',');
      for (const policy of this.all('SELECT * FROM bot_policies')) {
        const value = JSON.parse(String(policy.policy_json)) as { tools?: string[] };
        if ([...new Set(value.tools ?? [])].sort().join(',') === oldDefault) this.run('UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?', JSON.stringify({ ...value, tools: basicActions }), policy.bot_id);
      }
      this.insert('schema_migrations', { version: 19, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get('SELECT version FROM schema_migrations WHERE version=20')) this.transaction(() => {
      const schema = 'CREATE TABLE image_model_selections(provider TEXT NOT NULL,endpoint TEXT NOT NULL,models_json TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(provider,endpoint)) STRICT;';
      this.db.exec(schema);
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) this.db.exec(`CREATE TRIGGER sync_image_model_selections_${operation} AFTER ${operation} ON image_model_selections BEGIN INSERT INTO sync_events(kind,created_at) VALUES('state',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;`);
      this.insert('schema_migrations', { version: 20, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get('SELECT version FROM schema_migrations WHERE version=21')) this.transaction(() => {
      const schema = 'CREATE TABLE attachment_objects(attachment_id TEXT PRIMARY KEY REFERENCES chat_attachments(id) ON DELETE CASCADE,object_key TEXT NOT NULL,ciphertext_hash TEXT NOT NULL) STRICT;';
      this.db.exec(schema);
      this.insert('schema_migrations', { version: 21, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get('SELECT version FROM schema_migrations WHERE version=22')) this.transaction(() => {
      for (const policy of this.all('SELECT * FROM bot_policies')) {
        if (this.get("SELECT id FROM audit_records WHERE action='agent.policy.update' AND entity_id=?", policy.bot_id)) continue;
        // A peer created by another Agent may carry that creator's restrictions.
        if (this.get("SELECT id FROM audit_records WHERE action='steward.agent.create' AND json_extract(details_json,'$.botId')=?", policy.bot_id)) continue;
        const value = JSON.parse(String(policy.policy_json));
        if (!isLegacyDefaultTools(value.tools)) continue;
        this.run('UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?', JSON.stringify({ ...value, tools: basicActions, inheritDefaults: true }), policy.bot_id);
      }
      this.insert('schema_migrations', { version: 22, checksum: hash('default-capability-inheritance-v1'), applied_at: now() });
    });
    if (!this.get('SELECT version FROM schema_migrations WHERE version=23')) this.transaction(() => {
      const schema = `CREATE TABLE agent_approval_rules(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),action TEXT NOT NULL,target_id TEXT NOT NULL,operation TEXT NOT NULL,policy_version INTEGER NOT NULL,resource_version INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(bot_id,action,target_id,operation)) STRICT;`;
      this.db.exec(schema);
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) this.db.exec(`CREATE TRIGGER sync_agent_approval_rules_${operation} AFTER ${operation} ON agent_approval_rules BEGIN INSERT INTO sync_events(kind,created_at) VALUES('state',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;`);
      this.insert('schema_migrations', { version: 23, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get('SELECT version FROM schema_migrations WHERE version=24')) this.transaction(() => {
      const schema = `ALTER TABLE personal_connectors ADD COLUMN provider TEXT NOT NULL DEFAULT 'mcp' CHECK(provider IN ('mcp','gmail'));
ALTER TABLE personal_connectors ADD COLUMN account TEXT;
CREATE UNIQUE INDEX personal_connector_account ON personal_connectors(workspace_id,owner_user_id,provider,account) WHERE provider!='mcp';`;
      this.db.exec(schema);
      this.insert('schema_migrations', { version: 24, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=25")) this.transaction(() => {
      this.db.exec(feishuSchema);
      this.insert("schema_migrations", { version: 25, checksum: hash(feishuSchema), applied_at: now() });
    });
    this.db.exec("PRAGMA secure_delete=ON;");
  }
  scope() { return { workspace_id: this.workspace, owner_user_id: this.owner }; }
  get(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  all(sql: string, ...args: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  insert(table: string, data: Record<string, SQLInputValue>) {
    const fields = Object.keys(data);
    this.run(`INSERT INTO ${table}(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`, ...Object.values(data));
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } finally { this.transactionDepth--; }
  }
  encrypt(secret: string): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    return Buffer.concat([iv, cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
  }
  decrypt(value: string): string {
    const buffer = Buffer.from(value, "base64"), decipher = createDecipheriv("aes-256-gcm", this.key, buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(-16));
    return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]).toString("utf8");
  }
  config(): Row | undefined {
    const row = this.get("SELECT * FROM model_connections WHERE id='default'");
    if (!row) return;
    return { id: row.id, provider_id: row.provider_id, endpoint: row.endpoint, default_model: row.default_model, configured: row.credential_ref ? 1 : 0 };
  }
  modelVisibility() {
    const config = this.config();
    const row = config && this.get("SELECT models_json,version FROM model_visibility WHERE provider=? AND endpoint=?", config.provider_id, String(config.endpoint).replace(/\/+$/, ""));
    return { models: row?.models_json ? JSON.parse(String(row.models_json)) as string[] : null, version: Number(row?.version ?? 0) };
  }
  imageModelSelection() {
    const config = this.config();
    const row = config && this.get('SELECT models_json,version FROM image_model_selections WHERE provider=? AND endpoint=?', config.provider_id, String(config.endpoint).replace(/\/+$/, ''));
    return { models: row ? JSON.parse(String(row.models_json)) as string[] : [], version: Number(row?.version ?? 0) };
  }
  saveImageModelSelection(input: Record<string, unknown>) {
    const config = this.config();
    if (!config || input.provider !== config.provider_id || input.endpoint !== config.endpoint) throw new Error('模型连接已变化，请重新选择');
    if (config.provider_id !== 'openai') throw new Error('当前模型连接不支持生图');
    if (!Array.isArray(input.models) || input.models.length > 100 || input.models.some(model => typeof model !== 'string' || !model.trim() || model.length > 200)) throw new Error('生图模型选择无效');
    const models = [...new Set((input.models as string[]).map(model => model.trim()))];
    this.transaction(() => {
      const previous = this.imageModelSelection();
      if (input.version !== previous.version) throw new Error('生图模型选择已变化，请刷新');
      this.run('INSERT INTO image_model_selections VALUES(?,?,?,?) ON CONFLICT(provider,endpoint) DO UPDATE SET models_json=excluded.models_json,version=excluded.version', config.provider_id, String(config.endpoint).replace(/\/+$/, ''), JSON.stringify(models), previous.version + 1);
    });
    return this.imageModelSelection();
  }
  saveModelVisibility(input: Record<string, unknown>) {
    const scope = modelLimitScope({ ...input, model: "visibility" }), config = this.config();
    if (!config || config.provider_id !== scope.provider || String(config.endpoint).replace(/\/+$/, "") !== scope.endpoint) throw new Error("模型连接已变化，请重新打开设置");
    if (input.models !== null && (!Array.isArray(input.models) || input.models.length > 10000 || input.models.some(value => typeof value !== "string" || !value.trim() || value.length > 200))) throw new Error("显示模型列表无效");
    const models = input.models === null ? null : [...new Set((input.models as string[]).map(value => value.trim()))];
    this.transaction(() => {
      const previous = this.modelVisibility();
      if (input.version !== previous.version) throw new Error("显示模型已被修改，请重新打开设置");
      this.run("INSERT INTO model_visibility VALUES(?,?,?,?) ON CONFLICT(provider,endpoint) DO UPDATE SET models_json=excluded.models_json,version=excluded.version", scope.provider, scope.endpoint, models === null ? null : JSON.stringify(models), previous.version + 1);
    });
    return this.modelVisibility();
  }
  modelLimitSettings(input: Record<string, unknown>) {
    const scope = modelLimitScope(input);
    const row = this.get("SELECT * FROM model_limit_overrides WHERE provider=? AND endpoint=? AND model=?", scope.provider, scope.endpoint, scope.model);
    const manual: ModelLimitOverrides = { contextWindow: row?.context_window == null ? null : Number(row.context_window), maxOutputTokens: row?.max_output_tokens == null ? null : Number(row.max_output_tokens) };
    return this.modelLimits.resolve(scope, manual);
  }
  saveConfig(value: Record<string, unknown>) {
    const endpoint = new URL(text(value.endpoint, 2048));
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)))) throw new Error("API 地址须为 HTTPS；本地模型可使用 HTTP localhost");
    const provider = text(value.provider, 30);
    if (!["openai", "anthropic"].includes(provider)) throw new Error("不支持的协议");
    const model = text(value.model, 200);
    const scope = modelLimitScope({ provider, endpoint: endpoint.toString(), model });
    const previous = this.modelLimitSettings(scope).manual;
    const manual = {
      contextWindow: value.contextWindow === undefined ? previous.contextWindow : parseModelLimit(value.contextWindow, "contextWindow"),
      maxOutputTokens: value.maxOutputTokens === undefined ? previous.maxOutputTokens : parseModelLimit(value.maxOutputTokens, "maxOutputTokens"),
    };
    validateModelLimits(this.modelLimits.resolve(scope, manual));
    const secret = typeof value.apiKey === "string" && value.apiKey.trim() ? text(value.apiKey, 8192) : undefined;
    if (!secret && !this.get("SELECT id FROM secrets WHERE id='model-key'")) throw new Error("请配置 API Key");
    this.transaction(() => {
      this.run("INSERT INTO model_limit_overrides VALUES(?,?,?,?,?) ON CONFLICT(provider,endpoint,model) DO UPDATE SET context_window=excluded.context_window,max_output_tokens=excluded.max_output_tokens", scope.provider, scope.endpoint, scope.model, manual.contextWindow, manual.maxOutputTokens);
      if (secret) this.run("INSERT INTO secrets VALUES('model-key',?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", this.encrypt(secret));
      this.run("INSERT INTO model_connections(id,workspace_id,owner_user_id,display_name,provider_id,endpoint,credential_ref,default_model,status,created_at) VALUES('default',?,?,?,?,?,'model-key',?,'active',?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,endpoint=excluded.endpoint,default_model=excluded.default_model,version=version+1", this.workspace, this.owner, "Default", provider, endpoint.toString().replace(/\/$/, ""), model, now());
      this.run("UPDATE bots SET model_connection_id='default' WHERE model_connection_id IS NULL");
      this.audit("model.configure", "connection", "default", { provider, model });
    });
  }
  botModelSelection(botId: string) {
    const config = this.config();
    return config ? this.get("SELECT model selected_model,version model_selection_version FROM agent_model_settings WHERE bot_id=? AND provider=? AND endpoint=?", botId, config.provider_id, config.endpoint) : undefined;
  }
  modelConfig(botId?: string) {
    const row = this.get("SELECT * FROM model_connections WHERE id='default' AND status='active'");
    const secret = this.get("SELECT ciphertext FROM secrets WHERE id='model-key'");
    if (!row || !secret) throw new Error("请先在设置中配置 API Key 和模型");
    const scope = modelLimitScope({ provider: row.provider_id, endpoint: row.endpoint, model: (botId && this.botModelSelection(botId)?.selected_model) || row.default_model });
    const limits = this.modelLimitSettings(scope);
    validateModelLimits(limits);
    return { ...scope, contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens, apiKey: this.decrypt(String(secret.ciphertext)), version: Number(row.version) };
  }
  createBot(name: string, instructions?: unknown) {
    const botId = id();
    this.transaction(() => {
      this.insert("bots", { id: botId, ...this.scope(), name: text(name, 80), instructions: optionalText(instructions), model_connection_id: this.config() ? "default" : null, status: "active", created_at: now() });
      this.insert("bot_policies", { bot_id: botId, ...this.scope(), policy_json: JSON.stringify({ tools: basicActions, inheritDefaults: true }), approval_mode: "allow_scoped" });
      this.run("INSERT INTO agent_inboxes(bot_id,workspace_id,owner_user_id) VALUES(?,?,?)", botId, this.workspace, this.owner);
      this.insert("memory_bank_bindings", { id: id(), ...this.scope(), scope: "bot", bot_id: botId, provider_bank_id: id(), state: "provisioning" });
      this.insert("bot_public_profiles", { bot_id: botId, ...this.scope() });
      if (this.get('SELECT enabled FROM workspace_memory_settings WHERE id=1')?.enabled) {
        this.run('INSERT INTO assistant_memory_settings(bot_id,enabled,updated_at) VALUES(?,1,?)', botId, now());
      }
    });
    return botId;
  }
  createConversation(botId: string, title = "新对话") {
    if (!this.get("SELECT id FROM bots WHERE id=? AND status='active'", botId)) throw new Error("Agent 不存在");
    const conversationId = id(), runtimeId = id();
    this.transaction(() => {
      this.insert("conversations", { id: conversationId, ...this.scope(), bot_id: botId, title: text(title, 160), status: "open", created_at: now() });
      this.insert("runtime_sessions", { id: runtimeId, ...this.scope(), conversation_id: conversationId, bot_id: botId, storage_key: runtimeId, sdk_version: "1.0.4", format_version: "pi-public-v1", status: "active", created_at: now() });
    });
    return conversationId;
  }
  accept(conversationId: string, content: string, clientId: string, sessionId = this.session) {
    content = text(content); clientId = text(clientId, 100);
    const requestHash = hash(content);
    const old = this.get("SELECT * FROM conversation_inputs WHERE conversation_id=? AND client_message_id=?", conversationId, clientId);
    if (old) { if (old.request_hash !== requestHash) throw new Error("消息标识已用于不同内容"); return String(old.task_id); }
    const conv = this.get("SELECT * FROM conversations WHERE id=? AND status='open'", conversationId);
    if (!conv) throw new Error("对话不存在");
    this.modelConfig();
    return this.transaction(() => {
      let task = this.get("SELECT * FROM tasks WHERE conversation_id=? AND ended_at IS NULL", conversationId);
      let kind = "start";
      if (!task) {
        const taskId = id(), createdAt = now();
        // Compatibility fields satisfy the frozen v1 checks only. No effective
        // task limit, deadline or large finite substitute for infinity exists.
        this.insert("tasks", { id: taskId, ...this.scope(), conversation_id: conversationId, bot_id: conv.bot_id, initiated_by_session_id: sessionId, authorized_session_id: sessionId, objective: content, status: "queued", legacy_max_model_calls: 1, legacy_max_tool_calls: 1, legacy_token_budget: 1, legacy_deadline_at: createdAt + 1, created_at: createdAt });
        task = this.get("SELECT * FROM tasks WHERE id=?", taskId)!;
      } else {
        if (task.status === "needs_reconciliation" || task.status === "cancelling") throw new Error("该任务须先处理不确定结果或取消");
        kind = task.status === "awaiting_approval" ? "supplement" : "steer";
        this.run("UPDATE approvals SET status='cancelled' WHERE tool_call_id IN (SELECT id FROM tool_calls WHERE task_id=?) AND status IN ('pending','approved')", task.id);
        this.run("UPDATE tool_calls SET status='cancelled',result_json=?,result_hash=? WHERE task_id=? AND status IN ('awaiting_approval','ready')", JSON.stringify({ error: "新的用户输入使旧审批失效" }), hash(JSON.stringify({ error: "新的用户输入使旧审批失效" })), task.id);
        this.run("UPDATE tasks SET status=CASE WHEN status IN ('awaiting_approval','paused') THEN 'queued' ELSE status END,version=version+1 WHERE id=?", task.id);
      }
      const inputId = id(), runtime = this.get("SELECT id FROM runtime_sessions WHERE conversation_id=? AND status='active'", conversationId)!;
      this.insert("conversation_inputs", { id: inputId, ...this.scope(), bot_id: conv.bot_id, conversation_id: conversationId, task_id: task.id, sender_session_id: sessionId, client_message_id: clientId, input_seq: conv.next_input_seq, input_kind: kind, content_json: JSON.stringify({ text: content }), request_hash: requestHash, status: "accepted", created_at: now() });
      this.insert("runtime_input_deliveries", { input_id: inputId, ...this.scope(), bot_id: conv.bot_id, conversation_id: conversationId, runtime_session_id: runtime.id, channel: kind === "start" ? "prompt" : "steer", status: "pending", created_at: now() });
      this.run("UPDATE conversations SET next_input_seq=next_input_seq+1,version=version+1,title=CASE WHEN next_input_seq=1 THEN ? ELSE title END WHERE id=?", content.slice(0, 60), conversationId);
      this.message(conversationId, String(task.id), "user", content, `input:${inputId}`);
      return String(task.id);
    });
  }
  message(conv: string, task: string | null, role: string, content: string, source: string) {
    this.run("INSERT OR IGNORE INTO transcript(id,conversation_id,task_id,role,content,source_key,created_at) VALUES(?,?,?,?,?,?,?)", id(), conv, task, role, content, source, now());
  }
  pending(taskId: string) {
    return this.all("SELECT i.*,d.runtime_entry_id FROM conversation_inputs i JOIN runtime_input_deliveries d ON d.input_id=i.id WHERE i.task_id=? AND d.status IN ('pending','applied') ORDER BY input_seq", taskId);
  }
  audit(action: string, entityType: string, entityId: string, details: unknown) {
    this.insert("audit_records", { id: id(), workspace_id: this.workspace, actor_user_id: this.owner, action, entity_type: entityType, entity_id: entityId, details_json: JSON.stringify(details), created_at: now() });
  }
  state() {
    return {
      config: this.config(),
      modelVisibility: this.modelVisibility(),
      imageModelSelection: this.imageModelSelection(),
      bots: this.all("SELECT id,name,instructions,version FROM bots WHERE status='active'"),
      conversations: this.all("SELECT c.id,c.bot_id,c.title,c.created_at,t.id task_id,t.status task_status FROM conversations c LEFT JOIN tasks t ON t.conversation_id=c.id AND t.ended_at IS NULL WHERE c.status='open' ORDER BY c.created_at DESC"),
      approvals: this.all("SELECT a.id,a.argument_hash,a.expires_at,t.tool_name,t.arguments_json,t.authorization_snapshot_json,t.bot_id,t.conversation_id,t.task_id,t.id call_id FROM approvals a JOIN tool_calls t ON t.id=a.tool_call_id WHERE a.status='pending' ORDER BY a.created_at"),
      delegations: this.all("SELECT * FROM a2a_messages ORDER BY created_at DESC LIMIT 100"),
      memories: this.all("SELECT d.id,d.scope,d.bot_id,d.title,d.version,d.updated_at,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.status='active' ORDER BY d.updated_at DESC"),
      devices: this.all("SELECT id,name,status,capabilities_json FROM devices"),
      tasks: this.all("SELECT id,conversation_id,bot_id,objective,status,result_summary,created_at,ended_at,(SELECT tool_name FROM tool_calls WHERE task_id=tasks.id AND status IN ('proposed','awaiting_approval','ready','executing','unknown') ORDER BY created_at DESC LIMIT 1) active_tool FROM tasks ORDER BY ended_at IS NULL DESC,created_at DESC LIMIT 200"),
      usage: this.all("SELECT r.bot_id,COUNT(m.id) calls,COALESCE(SUM(m.input_tokens),0) input_tokens,COALESCE(SUM(m.output_tokens),0) output_tokens FROM model_invocations m JOIN task_runs r ON r.id=m.run_id WHERE m.status='succeeded' GROUP BY r.bot_id"),
    };
  }
  close() { this.db.close(); }
}
