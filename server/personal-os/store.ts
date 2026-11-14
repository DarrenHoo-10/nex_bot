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
import { episodeSchema } from "./episodes-schema.ts";
import { trigramSchema, vectorSchema } from "./retrieval-schema.ts";
import { recallSchema, WORKING_NOTE_TOKENS } from "./recall-schema.ts";
import { routineSchema } from "./routine-schema.ts";
import { rebuildMemories, topicSchema } from "./topic-schema.ts";
import { applyTreeSchema, treeMigrationSql } from "./topic-tree-schema.ts";
import { accessMigrationSql, applyAccessSchema, applyResidentSchema, residentMigrationSql } from "./topic-access-schema.ts";
import { clipTokens, tokens } from "./token-estimate.ts";
import { ModelCalibration } from "./calibration.ts";
import { ModelLimits, modelLimitScope, parseModelLimit, validateModelLimits, type ModelCatalogConfig, type ModelLimitOverrides } from "./model-limits.ts";

import { todoSchema } from "./todo-schema.ts";
import { jobSchema } from "./job-schema.ts";
import { connectionSchema, modelNameSchema } from "./connection-schema.ts";
import { parseReasoningChoice, parseReasoningLevels, resolveReasoning, type ReasoningLevel } from "./reasoning.ts";

export type Row = Record<string, string | number | null>;
export const id = () => randomUUID();
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const now = () => Date.now();
/** A provider's base URL: HTTPS, or HTTP on this machine for local models; no credentials, query or fragment. */
export function connectionEndpoint(value: unknown) {
  const endpoint = new URL(text(value, 2048));
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)))) throw new Error("API 地址须为 HTTPS；本地模型可使用 HTTP localhost");
  return endpoint.toString().replace(/\/+$/, "");
}
export function connectionProvider(value: unknown) {
  const provider = text(value, 30);
  if (!["openai", "anthropic"].includes(provider)) throw new Error("不支持的协议");
  return provider;
}
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
  readonly calibration = new ModelCalibration(this);
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
    if (!this.get("SELECT version FROM schema_migrations WHERE version=26")) this.transaction(() => {
      // Per-model ratio of real input tokens to the offline estimate; see calibration.ts.
      const schema = "CREATE TABLE IF NOT EXISTS model_calibration(provider TEXT NOT NULL,endpoint TEXT NOT NULL,model TEXT NOT NULL,ratio REAL NOT NULL,samples INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(provider,endpoint,model)) STRICT;";
      this.db.exec(schema);
      this.insert("schema_migrations", { version: 26, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=27")) this.transaction(() => {
      // Working context budget override (nullable: default is min(64k, input budget)); see model-limits.ts.
      const schema = "ALTER TABLE model_limit_overrides ADD COLUMN context_budget INTEGER;";
      if (!this.all("PRAGMA table_info(model_limit_overrides)").some((column) => column.name === "context_budget")) this.db.exec(schema);
      this.insert("schema_migrations", { version: 27, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=28")) this.transaction(() => {
      // Background context maintenance has no task, so it is not a task_run (whose task is required and
      // referenced by tool calls and model invocations): its own run table, one active run per conversation.
      // Maintenance summaries are told apart in assistant_usage by purpose 'maintain' and the conversation.
      const schema = `CREATE TABLE IF NOT EXISTS maintenance_runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,bot_id TEXT NOT NULL,runtime_session_id TEXT NOT NULL,model_id TEXT NOT NULL,reason TEXT NOT NULL CHECK(reason IN ('digest','budget')),status TEXT NOT NULL CHECK(status IN ('active','ended','failed','interrupted')),estimate INTEGER NOT NULL,error TEXT,started_at INTEGER NOT NULL,ended_at INTEGER,CHECK((status='active')=(ended_at IS NULL))) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_one_active ON maintenance_runs(conversation_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS maintenance_runs_conversation ON maintenance_runs(conversation_id,started_at);
ALTER TABLE assistant_usage ADD COLUMN conversation_id TEXT;
CREATE INDEX IF NOT EXISTS assistant_usage_maintain ON assistant_usage(conversation_id,purpose,created_at);`;
      const hasColumn = this.all("PRAGMA table_info(assistant_usage)").some((column) => column.name === "conversation_id");
      this.db.exec(hasColumn ? schema.replace("ALTER TABLE assistant_usage ADD COLUMN conversation_id TEXT;\n", "") : schema);
      this.insert("schema_migrations", { version: 28, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=29")) this.transaction(() => {
      // Episode archives, their index, one-shot new-topic marks and the memory pump's cursor over archives.
      this.db.exec(this.all("PRAGMA table_info(assistant_memory_settings)").some((column) => column.name === "episode_cursor") ? episodeSchema.replace("ALTER TABLE assistant_memory_settings ADD COLUMN episode_cursor INTEGER NOT NULL DEFAULT 0;\n", "") : episodeSchema);
      this.insert("schema_migrations", { version: 29, checksum: hash(episodeSchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=30")) this.transaction(() => {
      // Failure/backoff state of the background memory steps (retain, consolidate, understanding): one row per
      // assistant and step, present only while the step's latest attempts failed; a success deletes it.
      const schema = "CREATE TABLE IF NOT EXISTS assistant_memory_steps(bot_id TEXT NOT NULL REFERENCES bots(id),step TEXT NOT NULL,failures INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(bot_id,step)) STRICT;";
      this.db.exec(schema);
      this.insert("schema_migrations", { version: 30, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=31")) this.transaction(() => {
      // Compaction targets (a tool result, or the range of a history batch) whose summary failed, with the retry backoff; see compaction-failures.ts.
      const schema = "CREATE TABLE IF NOT EXISTS compaction_failures(runtime_id TEXT NOT NULL,target TEXT NOT NULL,attempts INTEGER NOT NULL,next_at INTEGER NOT NULL,last_error TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(runtime_id,target)) STRICT;";
      this.db.exec(schema);
      this.insert("schema_migrations", { version: 31, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=32")) this.transaction(() => {
      // Trigram full-text indexes for memories, episode archives and memory documents; rebuilt from the sources.
      this.db.exec(trigramSchema);
      this.insert("schema_migrations", { version: 32, checksum: hash(trigramSchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=33")) this.transaction(() => {
      // Embeddings of the memory pool and the user's embedding/rerank settings; see retrieval.ts.
      this.db.exec(vectorSchema);
      this.insert("schema_migrations", { version: 33, checksum: hash(vectorSchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=34")) this.transaction(() => {
      // Core memory, the once-per-task recall cache and per-conversation working notes; see recall-schema.ts.
      this.db.exec(recallSchema);
      // Each assistant's working note moves to its most recently active conversation (a delegated child conversation
      // is not one). The old table stays for rollback. A note over the 1000-token cap cannot be summarized here, so
      // it is cut at the cap and says so; the full text remains in the old table.
      for (const note of this.all("SELECT * FROM assistant_working_notes")) {
        const target = this.get("SELECT c.id FROM conversations c WHERE c.bot_id=? AND c.status='open' AND c.id NOT IN (SELECT child_conversation_id FROM a2a_messages) ORDER BY COALESCE((SELECT MAX(i.created_at) FROM conversation_inputs i WHERE i.conversation_id=c.id),c.created_at) DESC,c.created_at DESC,c.rowid DESC LIMIT 1", note.bot_id);
        if (!target) continue;
        const marker = "\n（已截断；完整内容在旧工作笔记表）", content = tokens(note.content) > WORKING_NOTE_TOKENS ? clipTokens(String(note.content), WORKING_NOTE_TOKENS - tokens(marker)).trimEnd() + marker : String(note.content);
        this.run("INSERT OR IGNORE INTO conversation_working_notes(conversation_id,bot_id,content,task_id,version,updated_at) VALUES(?,?,?,?,?,?)", target.id, note.bot_id, content, note.task_id, note.version, note.updated_at);
      }
      this.insert("schema_migrations", { version: 34, checksum: hash(recallSchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=35")) this.transaction(() => {
      // Topic entries: the memory table allows the kind 'topic' (rebuilt once, rows and rowids kept), plus the evidence,
      // core-index and migration-marker tables; see topic-schema.ts. Safe to run again.
      if (!String(this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='assistant_memories'")?.sql).includes("'topic'")) this.db.exec(rebuildMemories);
      this.db.exec(topicSchema);
      this.insert("schema_migrations", { version: 35, checksum: hash(topicSchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=36")) this.transaction(() => {
      this.db.exec(routineSchema);
      this.insert("schema_migrations", { version: 36, checksum: hash(routineSchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=37")) this.transaction(() => {
      const schema = "ALTER TABLE agent_routines ADD COLUMN deleted_at INTEGER;";
      this.db.exec(schema);
      this.insert("schema_migrations", { version: 37, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=38")) this.transaction(() => {
      this.db.exec(todoSchema);
      this.insert("schema_migrations", { version: 38, checksum: hash(todoSchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=39")) this.transaction(() => {
      // The two-level structure of assistant topics (containers), their members and moves; see topic-tree-schema.ts. No data moves.
      applyTreeSchema(this.db);
      this.insert("schema_migrations", { version: 39, checksum: hash(treeMigrationSql), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=40")) this.transaction(() => {
      // User topics and who may see them: access grants, delegations of questions, hints kept with the recall; see topic-access-schema.ts. No data moves.
      applyAccessSchema(this.db);
      this.insert("schema_migrations", { version: 40, checksum: hash(accessMigrationSql), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=41")) this.transaction(() => {
      // A resident topic shown shortened when its overview outgrows a reader's core memory; see topic-access-schema.ts.
      applyResidentSchema(this.db);
      this.insert("schema_migrations", { version: 41, checksum: hash(residentMigrationSql), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=42")) this.transaction(() => {
      const schema = "CREATE TABLE todo_tool_receipts (call_id TEXT PRIMARY KEY REFERENCES tool_calls(id), argument_hash TEXT NOT NULL, todo_id TEXT NOT NULL REFERENCES todos(id));";
      this.db.exec(schema);
      this.insert("schema_migrations", { version: 42, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=43")) this.transaction(() => {
      // Background jobs, their reports and device resource leases; see job-schema.ts. Existing rows are kept unchanged.
      this.db.exec(jobSchema);
      this.insert("schema_migrations", { version: 43, checksum: hash(jobSchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=44")) this.transaction(() => {
      // A Feishu reply to a background job's report names the job, so a reply to that message goes to the job.
      const schema = "ALTER TABLE personal_feishu_outbound ADD COLUMN job_id TEXT;";
      if (!this.all("PRAGMA table_info(personal_feishu_outbound)").some((column) => column.name === "job_id")) this.db.exec(schema);
      this.insert("schema_migrations", { version: 44, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=45")) this.transaction(() => {
      // Several model providers; see connection-schema.ts. The existing connection becomes the default provider.
      this.db.exec(connectionSchema);
      this.insert("schema_migrations", { version: 45, checksum: hash(connectionSchema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=46")) this.transaction(() => {
      // Display names from providers' model lists; see connection-schema.ts. A new, empty table only.
      this.db.exec(modelNameSchema);
      this.insert("schema_migrations", { version: 46, checksum: hash(modelNameSchema), applied_at: now() });
    });
    if (!this.get('SELECT version FROM schema_migrations WHERE version=47')) this.transaction(() => {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_topic_edits(bot_id TEXT NOT NULL REFERENCES bots(id),client_id TEXT NOT NULL,request_hash TEXT NOT NULL,PRIMARY KEY(bot_id,client_id)) STRICT;
CREATE TABLE IF NOT EXISTS agent_topic_children(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),root_conversation_id TEXT NOT NULL REFERENCES conversations(id)) STRICT;
CREATE TABLE IF NOT EXISTS agent_roles(workspace_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,role TEXT NOT NULL,bot_id TEXT NOT NULL REFERENCES bots(id),PRIMARY KEY(workspace_id,owner_user_id,role)) STRICT;
CREATE TABLE IF NOT EXISTS agent_topics(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),bot_id TEXT NOT NULL REFERENCES bots(id),audience TEXT NOT NULL CHECK(audience IN ('private','public')),source_context TEXT NOT NULL,read_seq INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS agent_topic_inputs(position INTEGER PRIMARY KEY AUTOINCREMENT,bot_id TEXT NOT NULL REFERENCES bots(id),client_id TEXT NOT NULL,request_hash TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES agent_topics(conversation_id),message_id TEXT NOT NULL,content TEXT NOT NULL,session_id TEXT NOT NULL,task_id TEXT REFERENCES tasks(id),status TEXT NOT NULL CHECK(status IN ('pending','accepted','cancelled')),UNIQUE(bot_id,client_id)) STRICT;`);
    if (!this.all('PRAGMA table_info(agent_messages)').some(c => c.name === 'conversation_id')) this.db.exec('ALTER TABLE agent_messages ADD COLUMN conversation_id TEXT REFERENCES conversations(id)');
    this.run('UPDATE agent_messages SET conversation_id=(SELECT conversation_id FROM tasks WHERE tasks.id=agent_messages.task_id) WHERE conversation_id IS NULL AND task_id IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS agent_messages_conversation ON agent_messages(conversation_id,seq); CREATE INDEX IF NOT EXISTS agent_topic_pending ON agent_topic_inputs(status,conversation_id,position);');
    for(const table of ['agent_topics','agent_topic_inputs']) for(const operation of ['INSERT','UPDATE','DELETE']) this.db.exec(`CREATE TRIGGER IF NOT EXISTS sync_${table}_${operation} AFTER ${operation} ON ${table} BEGIN INSERT INTO sync_events(kind,created_at) VALUES('state',CAST(unixepoch('subsec')*1000 AS INTEGER)); END;`);
      this.insert('schema_migrations',{version:47,checksum:hash('finance-topics-v1'),applied_at:now()});
    });
    if(!this.all('PRAGMA table_info(agent_topic_inputs)').some(column=>column.name==='model_selection_json'))this.db.exec('ALTER TABLE agent_topic_inputs ADD COLUMN model_selection_json TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS task_model_selections(task_id TEXT PRIMARY KEY REFERENCES tasks(id),selection_json TEXT NOT NULL) STRICT;');
    if (!this.get("SELECT version FROM schema_migrations WHERE version=48")) this.transaction(() => {
      const schema = `ALTER TABLE bots ADD COLUMN memory_epoch INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE bot_lifecycle_operations(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,bot_id TEXT NOT NULL REFERENCES bots(id),created_at INTEGER NOT NULL) STRICT;
        CREATE TABLE bot_lifecycle_objects(operation_id TEXT NOT NULL REFERENCES bot_lifecycle_operations(id),object_key TEXT NOT NULL,PRIMARY KEY(operation_id,object_key)) STRICT;
        CREATE TABLE bot_lifecycle_banks(operation_id TEXT NOT NULL REFERENCES bot_lifecycle_operations(id),provider_bank_id TEXT NOT NULL,PRIMARY KEY(operation_id,provider_bank_id)) STRICT;`;
      this.db.exec(schema);
      this.insert("schema_migrations", { version: 48, checksum: hash(schema), applied_at: now() });
    });
    if (!this.get("SELECT version FROM schema_migrations WHERE version=49")) this.transaction(() => {
      // Version 48 operations had already committed their local cleanup when they were recorded.
      const schema = `ALTER TABLE bot_lifecycle_operations ADD COLUMN phase TEXT NOT NULL DEFAULT 'done';
        ALTER TABLE bot_lifecycle_operations ADD COLUMN replacement_id TEXT REFERENCES bots(id);
        ALTER TABLE bot_lifecycle_operations ADD COLUMN page_cursor TEXT NOT NULL DEFAULT '';
        ALTER TABLE bot_lifecycle_operations ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX bot_lifecycle_pending ON bot_lifecycle_operations(retry_at,created_at) WHERE phase!='done';
        CREATE UNIQUE INDEX bot_lifecycle_replacement ON bot_lifecycle_operations(replacement_id);
        CREATE INDEX lifecycle_task_page ON tasks(bot_id,id);
        CREATE INDEX lifecycle_attachment_page ON chat_attachments(bot_id);
        CREATE INDEX lifecycle_routine_occurrences ON routine_occurrences(routine_id);
        CREATE INDEX lifecycle_conversations ON conversations(bot_id);
        CREATE INDEX lifecycle_memory_uses ON assistant_memory_uses(message_id);
        CREATE INDEX lifecycle_runtime_sessions ON runtime_sessions(bot_id,id);
        CREATE INDEX lifecycle_attachment_message ON chat_attachments(message_id);
        CREATE INDEX lifecycle_job_message ON agent_job_reports(message_id);
        CREATE INDEX lifecycle_doc_page ON memory_documents(bot_id,scope,id);
        CREATE INDEX lifecycle_busy_tasks ON tasks(bot_id) WHERE ended_at IS NULL;
        CREATE INDEX lifecycle_unknown_calls ON tool_calls(bot_id) WHERE status='unknown';`;
      // A preview is short lived. Track changes to its scope so confirmation never walks the history.
      // A separate revision table keeps ordinary message inserts from firing bot/profile sync triggers.
      const revisions = `CREATE TABLE bot_lifecycle_revisions(bot_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0) STRICT;`;
      const triggers = ["agent_messages","conversations","memory_documents","assistant_memories","agent_routines","todos","tasks","chat_attachments","memory_bank_bindings","assistant_topics"].flatMap(table =>
        (["INSERT","DELETE","UPDATE"] as const).map(event=>{
          const before = event==="INSERT" ? [] : ["OLD"], after = event==="DELETE" ? [] : ["NEW"];
          const ids = [...before,...after].map(row=>row+".bot_id");
          const sql = `INSERT INTO bot_lifecycle_revisions(bot_id,revision) SELECT id,1 FROM bots WHERE status='active' AND id IN (${ids.join(",")})
            ON CONFLICT(bot_id) DO UPDATE SET revision=revision+1;`;
          return `CREATE TRIGGER lifecycle_scope_${table}_${event} AFTER ${event} ON ${table} BEGIN ${sql} END;`;
        })).join("\n");
      this.db.exec(schema+revisions+triggers);
      this.insert("schema_migrations", { version: 49, checksum: hash(schema+revisions+triggers), applied_at: now() });
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
  // ── Model providers ("供应商") ──────────────────────────────────────────────────────────────────────────────
  // Several connections may exist; exactly one is the default. The legacy single-connection API (config, /api/config,
  // modelVisibility without a connection, bots/model without connectionId) keeps working against the default one.
  /** The default provider (any status, like the single row was), or undefined before one is configured. */
  defaultConnection(): Row | undefined {
    return this.get("SELECT * FROM model_connections WHERE is_default=1 AND status!='revoked'") ?? this.get("SELECT * FROM model_connections WHERE id='default' AND status!='revoked'");
  }
  /** A provider that has not been removed. */
  connection(connectionId: string): Row | undefined {
    return this.get("SELECT * FROM model_connections WHERE id=? AND status!='revoked'", connectionId);
  }
  connectionRows(): Row[] {
    return this.all("SELECT * FROM model_connections WHERE status!='revoked' ORDER BY is_default DESC,sort_order,created_at,rowid");
  }
  private connectionFor(input: Record<string, unknown>): Row | undefined {
    if (input.connectionId === undefined) return this.defaultConnection();
    const row = this.connection(text(input.connectionId, 100));
    if (!row) throw new Error("供应商不存在或已删除");
    return row;
  }
  config(): Row | undefined {
    const row = this.defaultConnection();
    if (!row) return;
    return { id: row.id, provider_id: row.provider_id, endpoint: row.endpoint, default_model: row.default_model, configured: row.credential_ref && this.get("SELECT id FROM secrets WHERE id=?", row.credential_ref) ? 1 : 0 };
  }
  /** Models a provider offers in pickers (its 启用 models): null means every model its directory lists. */
  modelVisibility(connectionId?: string) {
    const config = connectionId === undefined ? this.defaultConnection() : this.connection(connectionId);
    const row = config && this.get("SELECT models_json,version FROM model_visibility WHERE provider=? AND endpoint=?", config.provider_id, String(config.endpoint).replace(/\/+$/, ""));
    return { models: row?.models_json ? JSON.parse(String(row.models_json)) as string[] : null, version: Number(row?.version ?? 0) };
  }
  /** A provider's image generation models (the default provider without an id); always a list. */
  imageModelSelection(connectionId?: string) {
    const config = connectionId === undefined ? this.defaultConnection() : this.connection(connectionId);
    const row = config && this.get('SELECT models_json,version FROM image_model_selections WHERE provider=? AND endpoint=?', config.provider_id, String(config.endpoint).replace(/\/+$/, ''));
    return { models: row ? JSON.parse(String(row.models_json)) as string[] : [], version: Number(row?.version ?? 0) };
  }
  saveImageModelSelection(input: Record<string, unknown>) {
    // With connectionId: that provider; otherwise (older clients) the default provider, named by its format and address.
    const config = this.connectionFor(input);
    if (!config || (input.connectionId === undefined && (input.provider !== config.provider_id || input.endpoint !== config.endpoint))) throw new Error('模型连接已变化，请重新选择');
    if (config.provider_id !== 'openai') throw new Error('当前模型连接不支持生图');
    if (!Array.isArray(input.models) || input.models.length > 100 || input.models.some(model => typeof model !== 'string' || !model.trim() || model.length > 200)) throw new Error('生图模型选择无效');
    const models = [...new Set((input.models as string[]).map(model => model.trim()))];
    this.transaction(() => {
      const previous = this.imageModelSelection(String(config.id));
      if (input.version !== previous.version) throw new Error('生图模型选择已变化，请刷新');
      this.run('INSERT INTO image_model_selections VALUES(?,?,?,?) ON CONFLICT(provider,endpoint) DO UPDATE SET models_json=excluded.models_json,version=excluded.version', config.provider_id, String(config.endpoint).replace(/\/+$/, ''), JSON.stringify(models), previous.version + 1);
    });
    return this.imageModelSelection(String(config.id));
  }
  saveModelVisibility(input: Record<string, unknown>) {
    const config = this.connectionFor(input);
    const scope = input.connectionId === undefined ? modelLimitScope({ ...input, model: "visibility" }) : modelLimitScope({ provider: config?.provider_id, endpoint: config?.endpoint, model: "visibility" });
    if (!config || config.provider_id !== scope.provider || String(config.endpoint).replace(/\/+$/, "") !== scope.endpoint) throw new Error("模型连接已变化，请重新打开设置");
    if (input.models !== null && (!Array.isArray(input.models) || input.models.length > 10000 || input.models.some(value => typeof value !== "string" || !value.trim() || value.length > 200))) throw new Error("显示模型列表无效");
    const models = input.models === null ? null : [...new Set((input.models as string[]).map(value => value.trim()))];
    this.transaction(() => {
      const previous = this.modelVisibility(String(config.id));
      if (input.version !== previous.version) throw new Error("显示模型已被修改，请重新打开设置");
      this.run("INSERT INTO model_visibility VALUES(?,?,?,?) ON CONFLICT(provider,endpoint) DO UPDATE SET models_json=excluded.models_json,version=excluded.version", scope.provider, scope.endpoint, models === null ? null : JSON.stringify(models), previous.version + 1);
    });
    return this.modelVisibility(String(config.id));
  }
  modelLimitSettings(input: Record<string, unknown>) {
    const scope = modelLimitScope(input);
    const row = this.get("SELECT * FROM model_limit_overrides WHERE provider=? AND endpoint=? AND model=?", scope.provider, scope.endpoint, scope.model);
    const manual: ModelLimitOverrides = { contextWindow: row?.context_window == null ? null : Number(row.context_window), maxOutputTokens: row?.max_output_tokens == null ? null : Number(row.max_output_tokens), contextBudget: row?.context_budget == null ? null : Number(row.context_budget) };
    return this.modelLimits.resolve(scope, manual);
  }
  /** The legacy single-connection form: provider, endpoint, key, default model and its limits, for the default provider. */
  saveConfig(value: Record<string, unknown>) {
    const endpoint = connectionEndpoint(value.endpoint), provider = connectionProvider(value.provider);
    const model = text(value.model, 200);
    const scope = modelLimitScope({ provider, endpoint, model });
    const previous = this.modelLimitSettings(scope).manual;
    const manual = {
      contextWindow: value.contextWindow === undefined ? previous.contextWindow : parseModelLimit(value.contextWindow, "contextWindow"),
      maxOutputTokens: value.maxOutputTokens === undefined ? previous.maxOutputTokens : parseModelLimit(value.maxOutputTokens, "maxOutputTokens"),
      contextBudget: value.contextBudget === undefined ? previous.contextBudget : parseModelLimit(value.contextBudget, "contextBudget"),
    };
    validateModelLimits(this.modelLimits.resolve(scope, manual));
    const current = this.defaultConnection();
    this.transaction(() => {
      this.run("INSERT INTO model_limit_overrides(provider,endpoint,model,context_window,max_output_tokens,context_budget) VALUES(?,?,?,?,?,?) ON CONFLICT(provider,endpoint,model) DO UPDATE SET context_window=excluded.context_window,max_output_tokens=excluded.max_output_tokens,context_budget=excluded.context_budget", scope.provider, scope.endpoint, scope.model, manual.contextWindow, manual.maxOutputTokens, manual.contextBudget);
      const connectionId = this.writeConnection(current, { name: current ? String(current.display_name) : "Default", provider, endpoint, apiKey: value.apiKey, defaultModel: model, enabled: true });
      this.audit("model.configure", "connection", connectionId, { provider, model });
    });
  }
  /** Adds or edits a provider ("供应商"): name, API format, base URL, key (kept when left empty), default model, 启用. */
  saveConnection(value: Record<string, unknown>) {
    const existing = value.id === undefined || value.id === null || value.id === "" ? undefined : this.connection(text(value.id, 100));
    if (value.id && !existing) throw new Error("供应商不存在或已删除");
    if (existing && value.version !== Number(existing.version)) throw new Error("供应商已在其他设备修改，请刷新后再试");
    if (typeof value.name !== "string" || !value.name.trim()) throw new Error("请填写供应商名称");
    const name = text(value.name, 60);
    const enabled = value.enabled !== false;
    if (existing?.is_default && !enabled) throw new Error("默认供应商不能停用，请先把其他供应商设为默认");
    return this.transaction(() => {
      const connectionId = this.writeConnection(existing, { name, provider: connectionProvider(value.provider), endpoint: connectionEndpoint(value.endpoint), apiKey: value.apiKey, defaultModel: value.defaultModel, enabled });
      this.audit(existing ? "model.connection.update" : "model.connection.create", "connection", connectionId, { provider: value.provider, enabled });
      return connectionId;
    });
  }
  private writeConnection(existing: Row | undefined, value: { name: string; provider: string; endpoint: string; apiKey: unknown; defaultModel: unknown; enabled: boolean }) {
    if (!value.name) throw new Error("请填写供应商名称");
    const duplicate = this.get("SELECT display_name FROM model_connections WHERE provider_id=? AND endpoint=? AND status!='revoked' AND id!=?", value.provider, value.endpoint, existing?.id ?? "");
    if (duplicate) throw new Error(`「${duplicate.display_name}」已使用相同的 API 格式和地址`);
    const secret = typeof value.apiKey === "string" && value.apiKey.trim() ? text(value.apiKey.trim(), 8192) : undefined;
    const fresh = !this.defaultConnection();
    // The first provider keeps the legacy id and key slot, so older clients and code paths still find it.
    const connectionId = existing ? String(existing.id) : fresh ? "default" : id();
    const legacy = !existing && fresh ? this.get("SELECT credential_ref FROM model_connections WHERE id='default'") : undefined;
    const credential = existing?.credential_ref ? String(existing.credential_ref) : legacy?.credential_ref ? String(legacy.credential_ref) : connectionId === "default" ? "model-key" : `model-key:${connectionId}`;
    if (!secret && !this.get("SELECT id FROM secrets WHERE id=?", credential)) throw new Error("请配置 API Key");
    const defaultModel = value.defaultModel === undefined ? String(existing?.default_model ?? "") : value.defaultModel === "" || value.defaultModel === null ? "" : text(value.defaultModel, 200);
    if (secret) this.run("INSERT INTO secrets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", credential, this.encrypt(secret));
    if (existing) {
      this.run("UPDATE model_connections SET display_name=?,provider_id=?,endpoint=?,default_model=?,enabled=?,version=version+1 WHERE id=?", value.name, value.provider, value.endpoint, defaultModel, value.enabled ? 1 : 0, connectionId);
    } else {
      const order = Number(this.get("SELECT COALESCE(MAX(sort_order),0)+1 next FROM model_connections")?.next ?? 1);
      this.run("INSERT INTO model_connections(id,workspace_id,owner_user_id,display_name,provider_id,endpoint,credential_ref,default_model,status,created_at,enabled,is_default,sort_order) VALUES(?,?,?,?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,provider_id=excluded.provider_id,endpoint=excluded.endpoint,credential_ref=excluded.credential_ref,default_model=excluded.default_model,status='active',enabled=excluded.enabled,is_default=excluded.is_default,version=version+1", connectionId, this.workspace, this.owner, value.name, value.provider, value.endpoint, credential, defaultModel, now(), value.enabled ? 1 : 0, fresh ? 1 : 0, order);
    }
    if (fresh) this.run("UPDATE bots SET model_connection_id=? WHERE model_connection_id IS NULL AND status='active'", connectionId);
    return connectionId;
  }
  /** Makes a provider the default: new assistants and the legacy single-connection API use it. */
  setDefaultConnection(value: Record<string, unknown>) {
    const row = this.connection(text(value.id, 100));
    if (!row) throw new Error("供应商不存在或已删除");
    if (!row.enabled) throw new Error("请先启用这个供应商");
    if (!String(row.default_model)) throw new Error("请先为这个供应商选择默认模型");
    this.transaction(() => {
      this.run("UPDATE model_connections SET is_default=CASE WHEN id=? THEN 1 ELSE 0 END,version=version+1 WHERE is_default=1 OR id=?", row.id, row.id);
      this.audit("model.connection.default", "connection", String(row.id), {});
    });
  }
  /** Removes a provider: its key is erased and assistants using it go back to the default provider. */
  removeConnection(value: Record<string, unknown>) {
    const row = this.connection(text(value.id, 100));
    if (!row) throw new Error("供应商不存在或已删除");
    if (value.version !== Number(row.version)) throw new Error("供应商已在其他设备修改，请刷新后再试");
    if (row.is_default) throw new Error("默认供应商不能删除，请先把其他供应商设为默认");
    const fallback = this.defaultConnection();
    this.transaction(() => {
      this.run("UPDATE bots SET model_connection_id=? WHERE model_connection_id=?", fallback?.id ?? null, row.id);
      this.run("DELETE FROM secrets WHERE id=?", row.credential_ref);
      this.run("DELETE FROM model_options WHERE connection_id=?", row.id);
      // task_runs keep a foreign key to the row, so it stays, revoked and without a key.
      this.run("UPDATE model_connections SET status='revoked',enabled=0,version=version+1 WHERE id=?", row.id);
      this.audit("model.connection.remove", "connection", String(row.id), {});
    });
  }
  /** The key of a provider, for listing its models; undefined when none is saved. */
  connectionSecret(connectionId: string) {
    const row = this.connection(connectionId);
    const secret = row?.credential_ref ? this.get("SELECT ciphertext FROM secrets WHERE id=?", row.credential_ref) : undefined;
    return row && secret ? { provider: String(row.provider_id), endpoint: String(row.endpoint), apiKey: this.decrypt(String(secret.ciphertext)) } : undefined;
  }
  /** A model's settings on a provider: image input (null: not set) and the reasoning levels it offers. */
  modelOptions(connectionId: string, model: string) {
    const row = this.get("SELECT image_input,reasoning_levels_json,version FROM model_options WHERE connection_id=? AND model=?", connectionId, model);
    return { imageInput: row?.image_input == null ? null : !!row.image_input, reasoning: row ? parseReasoningLevels(JSON.parse(String(row.reasoning_levels_json))) : [] as ReasoningLevel[], version: Number(row?.version ?? 0) };
  }
  saveModelOptions(value: Record<string, unknown>) {
    const row = this.connection(text(value.connectionId, 100));
    if (!row) throw new Error("供应商不存在或已删除");
    const model = text(value.model, 200), previous = this.modelOptions(String(row.id), model);
    if (value.version !== previous.version) throw new Error("模型设置已在其他设备修改，请刷新后再试");
    const reasoning = value.reasoning === undefined ? previous.reasoning : parseReasoningLevels(value.reasoning);
    const imageInput = value.imageInput === undefined ? previous.imageInput : value.imageInput === null ? null : !!value.imageInput;
    // The model's context window and output ceiling may be set here too (null: automatic); its budget is kept.
    const scope = modelLimitScope({ provider: row.provider_id, endpoint: row.endpoint, model });
    const limits = value.contextWindow === undefined && value.maxOutputTokens === undefined ? undefined : (() => {
      const manual = this.modelLimitSettings(scope).manual;
      const next = { contextWindow: value.contextWindow === undefined ? manual.contextWindow : parseModelLimit(value.contextWindow, "contextWindow"), maxOutputTokens: value.maxOutputTokens === undefined ? manual.maxOutputTokens : parseModelLimit(value.maxOutputTokens, "maxOutputTokens"), contextBudget: manual.contextBudget };
      validateModelLimits(this.modelLimits.resolve(scope, next));
      return next;
    })();
    this.transaction(() => {
      if (limits) this.run("INSERT INTO model_limit_overrides(provider,endpoint,model,context_window,max_output_tokens,context_budget) VALUES(?,?,?,?,?,?) ON CONFLICT(provider,endpoint,model) DO UPDATE SET context_window=excluded.context_window,max_output_tokens=excluded.max_output_tokens,context_budget=excluded.context_budget", scope.provider, scope.endpoint, scope.model, limits.contextWindow, limits.maxOutputTokens, limits.contextBudget);
      this.run("INSERT INTO model_options(connection_id,model,image_input,reasoning_levels_json,version) VALUES(?,?,?,?,1) ON CONFLICT(connection_id,model) DO UPDATE SET image_input=excluded.image_input,reasoning_levels_json=excluded.reasoning_levels_json,version=version+1", row.id, model, imageInput === null ? null : imageInput ? 1 : 0, JSON.stringify(reasoning));
      this.audit("model.options.update", "connection", String(row.id), { model, reasoning, imageInput });
    });
    return this.modelOptions(String(row.id), model);
  }
  /**
   * Remembers the display names a saved provider's model list reported, replacing what that list said before; a list
   * for an address no provider uses is not kept. Partial lists only add names.
   */
  saveModelNames(provider: string, endpoint: string, models: string[], names: Record<string, string>, complete: boolean) {
    const address = endpoint.replace(/\/+$/, "");
    if (!this.get("SELECT id FROM model_connections WHERE provider_id=? AND endpoint=? AND status!='revoked'", provider, address)) return;
    this.transaction(() => {
      if (complete) this.run("DELETE FROM model_display_names WHERE provider=? AND endpoint=?", provider, address);
      else for (const model of models) this.run("DELETE FROM model_display_names WHERE provider=? AND endpoint=? AND model=?", provider, address, model);
      for (const [model, name] of Object.entries(names).slice(0, 10000)) {
        if (model.length <= 200 && typeof name === "string" && name.trim() && name.length <= 200) this.run("INSERT OR REPLACE INTO model_display_names VALUES(?,?,?,?)", provider, address, model, name.trim());
      }
    });
  }
  /** Every provider for /api/state, without keys: its enabled models and the settings of models that have any. */
  connections() {
    return this.connectionRows().map((row) => {
      const visibility = this.modelVisibility(String(row.id));
      const options = Object.fromEntries(this.all("SELECT model,image_input,reasoning_levels_json,version FROM model_options WHERE connection_id=?", row.id).map((option) => [String(option.model), { imageInput: option.image_input == null ? null : !!option.image_input, reasoning: parseReasoningLevels(JSON.parse(String(option.reasoning_levels_json))), version: Number(option.version) }]));
      const names = Object.fromEntries(this.all("SELECT model,display_name FROM model_display_names WHERE provider=? AND endpoint=?", row.provider_id, String(row.endpoint).replace(/\/+$/, "")).map((item) => [String(item.model), String(item.display_name)]));
      return { id: String(row.id), name: String(row.display_name), names, ...(row.provider_id === "openai" ? { imageModels: this.imageModelSelection(String(row.id)) } : {}), provider: String(row.provider_id), endpoint: String(row.endpoint), defaultModel: String(row.default_model), enabled: !!row.enabled, isDefault: !!row.is_default, configured: !!(row.credential_ref && this.get("SELECT id FROM secrets WHERE id=?", row.credential_ref)), version: Number(row.version), models: visibility.models, modelsVersion: visibility.version, options };
    });
  }
  /** The provider an assistant uses: its own choice while that one is usable, otherwise the default provider. */
  botConnection(botId: string): Row | undefined {
    const chosen = this.get("SELECT c.* FROM bots b JOIN model_connections c ON c.id=b.model_connection_id WHERE b.id=? AND c.status='active' AND c.enabled=1", botId);
    return chosen ?? this.defaultConnection();
  }
  botModelSelection(botId: string) {
    const connection = this.botConnection(botId);
    if (!connection) return undefined;
    const row = this.get("SELECT model,reasoning,version FROM agent_model_settings WHERE bot_id=? AND provider=? AND endpoint=?", botId, connection.provider_id, connection.endpoint);
    return { selected_connection: String(connection.id), selected_model: row ? String(row.model) : "", selected_reasoning: row?.reasoning == null ? null : String(row.reasoning), model_selection_version: Number(row?.version ?? 0) };
  }
  /** Chooses an assistant's provider, model and reasoning effort; the version is the one /api/state showed. */
  saveBotModel(botId: string, value: Record<string, unknown>) {
    const current = this.botModelSelection(botId);
    if (!current) throw new Error("请先配置模型连接");
    const connection = value.connectionId === undefined ? this.botConnection(botId)! : this.connection(text(value.connectionId, 100));
    if (!connection || connection.status !== "active") throw new Error("供应商不存在或已删除");
    if (!connection.enabled) throw new Error("这个供应商已停用");
    if (value.connectionId === undefined && (value.provider !== connection.provider_id || value.endpoint !== connection.endpoint)) throw new Error("模型连接已变化，请重新选择");
    if (value.version !== current.model_selection_version) throw new Error("模型已在其他设备更新，请重新选择");
    const model = value.model === "" ? "" : text(value.model, 200), reasoning = parseReasoningChoice(value.reasoning);
    const stored = this.get("SELECT reasoning,version FROM agent_model_settings WHERE bot_id=? AND provider=? AND endpoint=?", botId, connection.provider_id, connection.endpoint);
    // The new row's version moves past the one the client saw, so a write from a client that saw the old provider is refused.
    const version = Math.max(Number(stored?.version ?? 0), current.model_selection_version) + 1;
    this.run("UPDATE bots SET model_connection_id=? WHERE id=?", connection.id, botId);
    this.run("INSERT INTO agent_model_settings(bot_id,provider,endpoint,model,reasoning,version) VALUES(?,?,?,?,?,?) ON CONFLICT(bot_id,provider,endpoint) DO UPDATE SET model=excluded.model,reasoning=excluded.reasoning,version=excluded.version", botId, connection.provider_id, connection.endpoint, model, reasoning ?? (stored?.reasoning == null ? null : String(stored.reasoning)), version);
    return { model, reasoning };
  }
  /**
   * What a request uses: the assistant's provider, its model there (or the provider's default model) and the reasoning
   * level the model offers nearest to the assistant's choice. Without an assistant: the default provider and model.
   * `use` names another provider and/or model, for work that is not the assistant's chat (memory, tidy-up).
   */
  modelConfig(botId?: string, use: { connectionId?: string; model?: string } = {}) {
    const row = use.connectionId ? this.connection(use.connectionId) : botId ? this.botConnection(botId) : this.defaultConnection();
    const usable = row && row.status === "active" ? row : undefined;
    const secret = usable?.credential_ref ? this.get("SELECT ciphertext FROM secrets WHERE id=?", usable.credential_ref) : undefined;
    if (!usable || !secret) throw new Error("请先在设置中配置 API Key 和模型");
    const selection = botId ? this.get("SELECT model,reasoning FROM agent_model_settings WHERE bot_id=? AND provider=? AND endpoint=?", botId, usable.provider_id, usable.endpoint) : undefined;
    const model = String(use.model || selection?.model || usable.default_model);
    if (!model) throw new Error(`请先为「${usable.display_name}」选择模型`);
    const scope = modelLimitScope({ provider: usable.provider_id, endpoint: usable.endpoint, model });
    const limits = this.modelLimitSettings(scope);
    validateModelLimits(limits);
    const reasoning = resolveReasoning(selection?.reasoning == null ? null : String(selection.reasoning), this.modelOptions(String(usable.id), model).reasoning);
    return { ...scope, contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens, contextBudget: limits.contextBudget, apiKey: this.decrypt(String(secret.ciphertext)), version: Number(usable.version), connectionId: String(usable.id), reasoning };
  }
  /** Resolve a turn override through the same owned provider/configuration entry points as normal chat. No secret is persisted. */
  resolveInputModel(botId:string,value:unknown){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('单轮模型选择无效');
    const input=value as Record<string,unknown>;
    const connectionId=input.connectionId===undefined?this.botModelSelection(botId)?.selected_connection:text(input.connectionId,100);
    if(!connectionId)throw new Error('请先配置模型连接');
    const row=this.connection(connectionId);
    if(!row||row.workspace_id!==this.workspace||row.owner_user_id!==this.owner||!row.enabled)throw new Error('单轮模型连接不可用');
    const model=this.modelConfig(botId,{connectionId,...(input.model!==undefined&&input.model!==''?{model:text(input.model,200)}:{})});
    const enabled=this.modelVisibility(connectionId).models;
    if(enabled&&!enabled.includes(model.model))throw new Error('此模型未在本人连接中启用');
    if(input.provider!==undefined&&input.provider!==model.provider||input.endpoint!==undefined&&input.endpoint!==model.endpoint)throw new Error('单轮模型连接已变化');
    const reasoning=input.reasoning===undefined?model.reasoning:parseReasoningChoice(input.reasoning)!;
    if(reasoning!=='off'&&!this.modelOptions(connectionId,model.model).reasoning.includes(reasoning))throw new Error('此模型不支持指定的思考强度');
    return {connectionId,model:model.model,reasoning,provider:model.provider,endpoint:model.endpoint};
  }
  taskModelConfig(taskId:string){
    const task=this.get('SELECT bot_id FROM tasks WHERE id=?',taskId);
    if(!task)throw new Error('任务不存在');
    const saved=this.get('SELECT selection_json FROM task_model_selections WHERE task_id=?',taskId);
    if(!saved)return this.modelConfig(String(task.bot_id));
    const selection=this.resolveInputModel(String(task.bot_id),JSON.parse(String(saved.selection_json)));
    return {...this.modelConfig(String(task.bot_id),{connectionId:selection.connectionId,model:selection.model}),reasoning:selection.reasoning};
  }
  createBot(name: string, instructions?: unknown) {
    const botId = id();
    this.transaction(() => {
      this.insert("bots", { id: botId, ...this.scope(), name: text(name, 80), instructions: optionalText(instructions), model_connection_id: this.defaultConnection()?.id ?? null, status: "active", created_at: now() });
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
  accept(conversationId: string, content: string, clientId: string, sessionId = this.session, modelUse?:{connectionId?:string;model?:string}) {
    content = text(content); clientId = text(clientId, 200);
    const requestHash = hash(content);
    const conv = this.get("SELECT * FROM conversations WHERE id=? AND status='open' AND bot_id NOT IN (SELECT id FROM bots WHERE status='deleted')", conversationId);
    if (!conv) throw new Error("对话不存在");
    const old = this.get("SELECT * FROM conversation_inputs WHERE conversation_id=? AND client_message_id=?", conversationId, clientId);
    if (old) { if (old.request_hash !== requestHash) throw new Error("消息标识已用于不同内容"); return String(old.task_id); }
    this.modelConfig(String(conv.bot_id),modelUse);
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
      connections: this.connections(),
      modelVisibility: this.modelVisibility(),
      imageModelSelection: this.imageModelSelection(),
      bots: this.all("SELECT id,name,instructions,version FROM bots WHERE status='active'"),
      conversations: this.all("SELECT c.id,c.bot_id,c.title,c.created_at,t.id task_id,t.status task_status FROM conversations c LEFT JOIN tasks t ON t.conversation_id=c.id AND t.ended_at IS NULL WHERE c.status='open' AND c.bot_id NOT IN (SELECT id FROM bots WHERE status='deleted') ORDER BY c.created_at DESC"),
      approvals: this.all("SELECT a.id,a.argument_hash,a.expires_at,t.tool_name,t.arguments_json,t.authorization_snapshot_json,t.bot_id,t.conversation_id,t.task_id,t.id call_id FROM approvals a JOIN tool_calls t ON t.id=a.tool_call_id WHERE a.status='pending' AND t.bot_id NOT IN (SELECT id FROM bots WHERE status='deleted') ORDER BY a.created_at"),
      delegations: this.all("SELECT * FROM a2a_messages WHERE sender_bot_id NOT IN (SELECT id FROM bots WHERE status='deleted') AND receiver_bot_id NOT IN (SELECT id FROM bots WHERE status='deleted') ORDER BY created_at DESC LIMIT 100"),
      memories: this.all("SELECT d.id,d.scope,d.bot_id,d.title,d.version,d.updated_at,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.status='active' AND (d.scope='workspace' OR d.bot_id NOT IN (SELECT id FROM bots WHERE status='deleted')) ORDER BY d.updated_at DESC"),
      devices: this.all("SELECT id,name,status,capabilities_json FROM devices"),
      tasks: this.all("SELECT id,conversation_id,bot_id,objective,status,result_summary,created_at,ended_at,(SELECT origin FROM agent_task_links WHERE task_id=tasks.id) origin,(SELECT tool_name FROM tool_calls WHERE task_id=tasks.id AND status IN ('proposed','awaiting_approval','ready','executing','unknown') ORDER BY created_at DESC LIMIT 1) active_tool FROM tasks WHERE bot_id NOT IN (SELECT id FROM bots WHERE status='deleted') ORDER BY ended_at IS NULL DESC,created_at DESC LIMIT 200"),
      usage: this.all("SELECT r.bot_id,COUNT(m.id) calls,COALESCE(SUM(m.input_tokens),0) input_tokens,COALESCE(SUM(m.output_tokens),0) output_tokens FROM model_invocations m JOIN task_runs r ON r.id=m.run_id WHERE m.status='succeeded' GROUP BY r.bot_id"),
    };
  }
  close() { this.db.close(); }
}
