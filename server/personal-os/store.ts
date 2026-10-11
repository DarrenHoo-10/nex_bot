import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { basicActions } from "./policy.ts";

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
  private transactionDepth = 0;
  readonly db: DatabaseSync;
  readonly dir: string;
  readonly owner = "local-owner";
  readonly workspace = "personal";
  readonly session = "desktop-owner";
  constructor(dir: string, readonly key: Buffer, token: string) {
    if (key.length !== 32) throw new Error("Invalid credential vault key");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = realpathSync(dir);
    const legacy = process.env.OMB_DATA_DIR;
    if (legacy && existsSync(legacy) && realpathSync(legacy).toLowerCase() === this.dir.toLowerCase()) throw new Error("Personal OS data must be separate from legacy data");
    const marker = path.join(this.dir, "backend.json");
    if (existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).backend !== "personal-os") throw new Error("Incompatible data directory");
    writeFileSync(marker, JSON.stringify({ backend: "personal-os", format: 1 }), { mode: 0o600 });
    this.db = new DatabaseSync(path.join(this.dir, "core.db"));
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    const sql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    if (!this.get("SELECT name FROM sqlite_master WHERE name='schema_migrations'")) this.db.exec(sql);
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
  saveConfig(value: Record<string, unknown>) {
    const endpoint = new URL(text(value.endpoint, 2048));
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)))) throw new Error("API 地址须为 HTTPS；本地模型可使用 HTTP localhost");
    const provider = text(value.provider, 30);
    if (!["openai", "anthropic"].includes(provider)) throw new Error("不支持的协议");
    const model = text(value.model, 200);
    const secret = typeof value.apiKey === "string" && value.apiKey.trim() ? text(value.apiKey, 8192) : undefined;
    if (!secret && !this.get("SELECT id FROM secrets WHERE id='model-key'")) throw new Error("请配置 API Key");
    this.transaction(() => {
      if (secret) this.run("INSERT INTO secrets VALUES('model-key',?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", this.encrypt(secret));
      this.run("INSERT INTO model_connections(id,workspace_id,owner_user_id,display_name,provider_id,endpoint,credential_ref,default_model,status,created_at) VALUES('default',?,?,?,?,?,'model-key',?,'active',?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,endpoint=excluded.endpoint,default_model=excluded.default_model,version=version+1", this.workspace, this.owner, "Default", provider, endpoint.toString().replace(/\/$/, ""), model, now());
      this.run("UPDATE bots SET model_connection_id='default' WHERE model_connection_id IS NULL");
      this.audit("model.configure", "connection", "default", { provider, model });
    });
  }
  modelConfig() {
    const row = this.get("SELECT * FROM model_connections WHERE id='default' AND status='active'");
    const secret = this.get("SELECT ciphertext FROM secrets WHERE id='model-key'");
    if (!row || !secret) throw new Error("请先在设置中配置 API Key 和模型");
    return { provider: String(row.provider_id), endpoint: String(row.endpoint), model: String(row.default_model), apiKey: this.decrypt(String(secret.ciphertext)), version: Number(row.version) };
  }
  createBot(name: string, instructions?: unknown) {
    const botId = id();
    this.transaction(() => {
      this.insert("bots", { id: botId, ...this.scope(), name: text(name, 80), instructions: optionalText(instructions), model_connection_id: this.config() ? "default" : null, status: "active", created_at: now() });
      this.insert("bot_policies", { bot_id: botId, ...this.scope(), policy_json: JSON.stringify({ tools: basicActions }), approval_mode: "allow_scoped" });
      this.run("INSERT INTO agent_inboxes(bot_id,workspace_id,owner_user_id) VALUES(?,?,?)", botId, this.workspace, this.owner);
      this.insert("memory_bank_bindings", { id: id(), ...this.scope(), scope: "bot", bot_id: botId, provider_bank_id: id(), state: "provisioning" });
      this.insert("bot_public_profiles", { bot_id: botId, ...this.scope() });
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
  accept(conversationId: string, content: string, clientId: string) {
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
        const taskId = id();
        this.insert("tasks", { id: taskId, ...this.scope(), conversation_id: conversationId, bot_id: conv.bot_id, initiated_by_session_id: this.session, authorized_session_id: this.session, objective: content, status: "queued", max_model_calls: 24, max_tool_calls: 40, token_budget: 100_000, deadline_at: now() + 30 * 60_000, created_at: now() });
        task = this.get("SELECT * FROM tasks WHERE id=?", taskId)!;
      } else {
        if (task.status === "needs_reconciliation" || task.status === "cancelling") throw new Error("该任务须先处理不确定结果或取消");
        kind = task.status === "awaiting_approval" ? "supplement" : "steer";
        this.run("UPDATE approvals SET status='cancelled' WHERE tool_call_id IN (SELECT id FROM tool_calls WHERE task_id=?) AND status IN ('pending','approved')", task.id);
        this.run("UPDATE tool_calls SET status='cancelled',result_json=?,result_hash=? WHERE task_id=? AND status IN ('awaiting_approval','ready')", JSON.stringify({ error: "新的用户输入使旧审批失效" }), hash(JSON.stringify({ error: "新的用户输入使旧审批失效" })), task.id);
        this.run("UPDATE tasks SET status=CASE WHEN status IN ('awaiting_approval','paused') THEN 'queued' ELSE status END,version=version+1 WHERE id=?", task.id);
      }
      const inputId = id(), runtime = this.get("SELECT id FROM runtime_sessions WHERE conversation_id=? AND status='active'", conversationId)!;
      this.insert("conversation_inputs", { id: inputId, ...this.scope(), bot_id: conv.bot_id, conversation_id: conversationId, task_id: task.id, sender_session_id: this.session, client_message_id: clientId, input_seq: conv.next_input_seq, input_kind: kind, content_json: JSON.stringify({ text: content }), request_hash: requestHash, status: "accepted", created_at: now() });
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
    return { config: this.config(), bots: this.all("SELECT id,name,instructions,version FROM bots WHERE status='active'"), conversations: this.all("SELECT c.id,c.bot_id,c.title,c.created_at,t.id task_id,t.status task_status FROM conversations c LEFT JOIN tasks t ON t.conversation_id=c.id AND t.ended_at IS NULL WHERE c.status='open' ORDER BY c.created_at DESC"), approvals: this.all("SELECT a.id,a.argument_hash,a.expires_at,t.tool_name,t.arguments_json,t.bot_id,t.conversation_id,t.task_id,t.id call_id FROM approvals a JOIN tool_calls t ON t.id=a.tool_call_id WHERE a.status='pending' ORDER BY a.created_at"), delegations: this.all("SELECT * FROM a2a_messages ORDER BY created_at DESC LIMIT 100"), memories: this.all("SELECT d.id,d.scope,d.bot_id,d.title,d.version,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.status='active' ORDER BY d.updated_at DESC"), devices: this.all("SELECT id,name,status,capabilities_json FROM devices"), tasks: this.all("SELECT id,conversation_id,bot_id,objective,status,result_summary,created_at FROM tasks ORDER BY ended_at IS NULL DESC,created_at DESC LIMIT 200") };
  }
  close() { this.db.close(); }
}
