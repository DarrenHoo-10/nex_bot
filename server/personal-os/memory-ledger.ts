import { CoreStore, id, now, hash, canonical, type Row } from "./store.ts";
import { HindsightClient, HindsightError, type RetainSource } from "./hindsight.ts";
import { policyTools } from "./policy.ts";

// Sources remain in their owning modules. This ledger holds identity, scope and
// delivery state; extracted facts/entities/vectors exist only in Hindsight.
export function ensureMemoryBank(store: CoreStore, botId?: string): Row {
  const old = store.get(botId ? "SELECT * FROM memory_bank_bindings WHERE bot_id=?" : "SELECT * FROM memory_bank_bindings WHERE scope='workspace'", ...(botId ? [botId] : []));
  if (old) return old;
  const bankId = id();
  store.insert("memory_bank_bindings", { id: bankId, ...store.scope(), scope: botId ? "bot" : "workspace", bot_id: botId ?? null, provider_bank_id: id(), state: "provisioning" });
  return store.get("SELECT * FROM memory_bank_bindings WHERE id=?", bankId)!;
}
const sensitive = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|Bearer\s+[a-zA-Z0-9._-]{16,})|(?:api[_ -]?key|password|密码|密钥)\s*[:=：]\s*\S{6,}/i;
export class MemoryLedger {
  timer?: NodeJS.Timeout;
  pending?: Promise<void>;
  closing = false;
  lastError: string | null = null;
  authorizeWork?: () => Promise<boolean>;
  constructor(readonly store: CoreStore, public client?: HindsightClient, readonly changed: () => void = () => {}) {
    store.transaction(() => {
      store.run("UPDATE memory_transfers SET status='unknown' WHERE status='running'");
      store.run("UPDATE memory_model_invocations SET status='unknown',finished_at=? WHERE status='in_flight'", now());
      for (const bot of store.all("SELECT id FROM bots")) ensureMemoryBank(store, String(bot.id));
      // Import only current explicit notes, never old message history. Deleted
      // sources are excluded before enabling automatic incremental capture.
      for (const doc of store.all("SELECT d.*,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.status='active'")) this.document(doc);
    });
  }
  start() { if (!this.timer) this.timer = setInterval(() => { void this.flush(); }, 1500); void this.flush(); }
  status() {
    return { provider: "hindsight", release: "0.10.3", status: !this.client ? "not_installed" : this.lastError ? "unavailable" : "connected",
      revision: hash(canonical(this.store.all("SELECT id,provider_bank_id,content_generation,visibility_generation FROM memory_bank_bindings ORDER BY id"))),
      forgetting: Number(this.store.get("SELECT COUNT(*) n FROM memory_forget_rules WHERE status!='completed'")!.n),
      pending: Number(this.store.get("SELECT COUNT(*) n FROM memory_transfers WHERE status IN ('queued','running','unknown')")!.n),
      failed: Number(this.store.get("SELECT COUNT(*) n FROM memory_transfers WHERE status='failed'")!.n),
      quarantined: Number(this.store.get("SELECT COUNT(*) n FROM memory_bank_bindings WHERE state='quarantined'")!.n), error: this.lastError };
  }
  capture(bank: Row, kind: string, originalId: string, version: number, content: string, sourceClass: string, root: string, timestamp: number, taskId: Row[string] = null) {
    if (!content.trim() || sensitive.test(content)) return; // Never enqueue obvious credentials.
    if (this.store.get("SELECT content_hash FROM memory_tombstones WHERE content_hash=?", hash(content)) || (taskId && this.store.get("SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?", taskId))) return;
    if (this.store.get("SELECT id FROM memory_source_registry WHERE bank_id=? AND source_kind=? AND original_id=? AND source_version=?", bank.id, kind, originalId, version)) return;
    const sourceId = id();
    this.store.insert("memory_source_registry", { id: sourceId, bank_id: bank.id, source_kind: kind, original_id: originalId, source_version: version, content_hash: hash(content), source_class: sourceClass, root_origin_key: root, task_id: taskId, occurred_at: timestamp, status: "active" });
    this.store.insert("memory_provider_documents", { source_id: sourceId, bank_id: bank.id, provider_document_id: sourceId });
    if (taskId && sourceClass !== "user_stated") this.store.run("INSERT OR IGNORE INTO memory_source_edges SELECT ?,source_id FROM memory_task_sources WHERE task_id=? AND source_id!=?", sourceId, taskId, sourceId);
    this.enqueue(bank, sourceId, content);
  }
  enqueue(bank: Row, sourceId: string, content: string) {
    this.store.insert("memory_transfers", { id: id(), bank_id: bank.id, source_id: sourceId, kind: "retain", status: "queued", provider_operation_id: id(), request_hash: hash(canonical({ sourceId, content, providerBank: bank.provider_bank_id })), created_at: now() });
  }
  document(doc: Row) {
    const bank = ensureMemoryBank(this.store, doc.scope === "bot" ? String(doc.bot_id) : undefined);
    const actor = JSON.parse(String(doc.source_json));
    const task = actor.callId ? this.store.get("SELECT task_id FROM tool_calls WHERE id=?", actor.callId)?.task_id : null;
    this.capture(bank, "document", String(doc.id), Number(doc.version), String(doc.content), actor.actor === "agent" ? "agent_inferred" : "user_stated", `document:${doc.id}`, Number(doc.updated_at), task);
  }
  message(message: Row) {
    if (!["user", "assistant", "peer"].includes(String(message.role)) || String(message.source_key).startsWith("legacy:")) return;
    const policy = this.store.get("SELECT * FROM bot_policies WHERE bot_id=?", message.bot_id)!;
    if (!policyTools(policy).includes("memory.write")) return;
    const match = /^a2a-(?:received|returned|replied):(.+)$/.exec(String(message.source_key));
    this.capture(ensureMemoryBank(this.store, String(message.bot_id)), "message", String(message.id), 1, String(message.content), message.role === "user" ? "user_stated" : message.role === "peer" ? "peer_reported" : "agent_inferred", match ? `a2a:${match[1]}` : String(message.source_key), Number(message.created_at), message.task_id);
  }
  invalidate(bankId: string) {
    // Fence reads first. A late reply or deferred job on the retired bank can
    // never become visible again. Rebuild uses only currently valid sources.
    const bank = this.store.get("SELECT * FROM memory_bank_bindings WHERE id=?", bankId)!;
    this.store.run("INSERT OR IGNORE INTO memory_bank_retirements VALUES(?,?, 'queued',?)", bank.provider_bank_id, bankId, now());
    const physical = id();
    this.store.run("UPDATE memory_bank_bindings SET provider_bank_id=?,visibility_generation=visibility_generation+1,state='quarantined' WHERE id=?", physical, bankId);
    this.store.run("DELETE FROM memory_syntheses");
    this.store.run("DELETE FROM memory_transfer_receipts WHERE transfer_id IN (SELECT id FROM memory_transfers WHERE bank_id=?)", bankId);
    for (const transfer of this.store.all("SELECT * FROM memory_transfers WHERE bank_id=?", bankId)) {
      const source = this.store.get("SELECT * FROM memory_source_registry WHERE id=?", transfer.source_id);
      this.store.run("UPDATE memory_transfers SET status=?,provider_operation_id=?,attempts=0,next_attempt_at=0,error_code=NULL WHERE id=?", source?.status === "active" ? "queued" : "cancelled", id(), transfer.id);
    }
  }
  retractDocument(documentId: string) {
    const banks = this.store.all("SELECT DISTINCT bank_id FROM memory_source_registry WHERE source_kind='document' AND original_id=? AND status='active'", documentId);
    this.store.run("UPDATE memory_source_registry SET status='retracted' WHERE source_kind='document' AND original_id=?", documentId);
    for (const bank of banks) this.invalidate(String(bank.bank_id));
  }
  source(source: Row): RetainSource | undefined {
    const row = source.source_kind === "document" ? this.store.get("SELECT v.content FROM memory_document_versions v JOIN memory_documents d ON d.id=v.document_id WHERE v.document_id=? AND v.version=? AND d.status='active' AND d.version=v.version", source.original_id, source.source_version) : this.store.get("SELECT content FROM agent_messages WHERE id=?", source.original_id);
    if (!row || hash(String(row.content)) !== source.content_hash) return;
    return { content: String(row.content), documentId: String(source.id), timestamp: new Date(Number(source.occurred_at)).toISOString(), metadata: { source_id: String(source.id), source_class: String(source.source_class), root_origin: String(source.root_origin_key), content_hash: String(source.content_hash) }, context: `Source class: ${source.source_class}. Agent/peer content is unconfirmed experience, not a direct user assertion. Plans are not completed actions.` };
  }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.closing || !this.client) return Promise.resolve();
    this.pending = this.pump().catch((error: unknown) => { this.lastError = error instanceof HindsightError ? error.code : "memory_delivery_failed"; }).finally(() => { this.pending = undefined; if (!this.closing) this.changed(); });
    return this.pending;
  }
  async pump() {
    const client = this.client!;
    if (this.authorizeWork && !await this.authorizeWork().catch(() => false)) return;
    for (const retirement of this.store.all("SELECT * FROM memory_bank_retirements WHERE status!='succeeded'")) {
      const done = await client.retire(String(retirement.provider_bank_id));
      if (this.closing) return;
      this.store.run("UPDATE memory_bank_retirements SET status=? WHERE provider_bank_id=?", done ? "succeeded" : "running", retirement.provider_bank_id);
    }
    for (const bank of this.store.all("SELECT * FROM memory_bank_bindings WHERE state!='deleted'")) {
      if (this.closing) return;
      if (this.authorizeWork && !await this.authorizeWork().catch(() => false)) return;
      if (this.store.all("SELECT plan_json FROM memory_forget_rules WHERE status='pending'").some((rule) => (JSON.parse(String(rule.plan_json)) as { banks: string[] }).banks.includes(String(bank.id)))) continue;
      if (bank.bot_id && this.store.get("SELECT status FROM bots WHERE id=?", bank.bot_id)?.status !== "active") continue;
      await client.ensure(String(bank.provider_bank_id));
      const transfer = this.store.get("SELECT * FROM memory_transfers WHERE bank_id=? AND status IN ('queued','running','unknown') AND next_attempt_at<=? ORDER BY created_at LIMIT 1", bank.id, now());
      if (transfer) {
        const source = this.store.get("SELECT * FROM memory_source_registry WHERE id=? AND status='active'", transfer.source_id);
        const payload = source && this.source(source);
        if (!payload) { this.store.run("UPDATE memory_transfers SET status='cancelled' WHERE id=?", transfer.id); continue; }
        let state = await client.operation(String(bank.provider_bank_id), String(transfer.provider_operation_id));
        if (!state && transfer.status !== "queued") { this.store.run("UPDATE memory_transfers SET status='unknown',error_code='operation_missing',next_attempt_at=? WHERE id=?", now() + 60_000, transfer.id); continue; }
        // Intent/UUID is committed before sending. An ambiguous submission only
        // retries that same native id; never starts another billable extraction.
        if (!state) {
          this.store.run("UPDATE memory_transfers SET status='running',attempts=attempts+1 WHERE id=?", transfer.id);
          try { await client.retain(String(bank.provider_bank_id), String(transfer.provider_operation_id), payload); state = "pending"; }
          catch (error) { this.store.run("UPDATE memory_transfers SET status='unknown',error_code=?,next_attempt_at=? WHERE id=? AND provider_operation_id=?", error instanceof HindsightError ? error.code : "delivery_unknown", now() + 5000, transfer.id, transfer.provider_operation_id); throw error; }
        }
        if (this.closing) return;
        // A concurrent edit/delete may have changed generation during HTTP.
        if (this.store.get("SELECT provider_bank_id FROM memory_bank_bindings WHERE id=?", bank.id)?.provider_bank_id !== bank.provider_bank_id) continue;
        if (state === "completed") this.store.transaction(() => {
          this.store.run("UPDATE memory_bank_bindings SET content_generation=content_generation+1 WHERE id=?", bank.id);
          const generation = this.store.get("SELECT content_generation FROM memory_bank_bindings WHERE id=?", bank.id)!.content_generation;
          this.store.run("INSERT OR IGNORE INTO memory_transfer_receipts VALUES(?,?,?,?)", transfer.id, source!.content_hash, generation, now());
          this.store.run("UPDATE memory_transfers SET status='succeeded',error_code=NULL WHERE id=?", transfer.id);
        });
        else if (["failed", "cancelled"].includes(state)) this.store.run("UPDATE memory_transfers SET status='failed',error_code=? WHERE id=?", `engine_operation_${state}`, transfer.id);
      }
      if (!this.store.get("SELECT id FROM memory_transfers WHERE bank_id=? AND status IN ('queued','running','unknown','failed')", bank.id) && !this.store.get("SELECT provider_bank_id FROM memory_bank_retirements WHERE bank_id=? AND status!='succeeded'", bank.id)) this.store.run("UPDATE memory_bank_bindings SET state='ready' WHERE id=? AND provider_bank_id=?", bank.id, bank.provider_bank_id);
    }
    this.lastError = null;
    for (const rule of this.store.all("SELECT * FROM memory_forget_rules WHERE status='cleaning'")) {
      const banks = (JSON.parse(String(rule.plan_json)) as { banks: string[] }).banks;
      if (banks.every((bank) => this.store.get("SELECT state FROM memory_bank_bindings WHERE id=?", bank)?.state === "ready")) this.store.run("UPDATE memory_forget_rules SET status='completed',completed_at=? WHERE id=?", now(), rule.id);
    }
  }
  async recall(botId: string, query: string) {
    const policy = this.store.get("SELECT * FROM bot_policies WHERE bot_id=?", botId);
    const bot = this.store.get("SELECT status FROM bots WHERE id=?", botId);
    if (!policy || bot?.status !== "active" || !policyTools(policy).includes("memory.search")) return { status: "disabled", facts: [] };
    if (!this.client) return { status: "unavailable", facts: [] };
    const banks = this.store.all("SELECT * FROM memory_bank_bindings WHERE (bot_id=? OR scope='workspace') AND state='ready'", botId);
    const facts: Array<{ ref: string; refs: string[]; scope: string; text: string; sourceClass: string }> = [];
    try {
      for (const bank of banks) {
        const result = await this.client.recall(String(bank.provider_bank_id), query);
        if (this.closing) return { status: "unavailable", facts: [] };
        const current = this.store.get("SELECT * FROM memory_bank_bindings WHERE id=?", bank.id);
        if (current?.state !== "ready" || current.visibility_generation !== bank.visibility_generation || current.provider_bank_id !== bank.provider_bank_id) continue;
        if (this.store.get("SELECT version FROM bot_policies WHERE bot_id=?", botId)?.version !== policy.version || this.store.get("SELECT status FROM bots WHERE id=?", botId)?.status !== "active") return { status: "disabled", facts: [] };
        for (const fact of result) {
          if (typeof fact.text !== "string") continue;
          const sources = (fact.sources ?? [fact]).map((evidence) => typeof evidence.document_id === "string" ? this.store.get("SELECT s.* FROM memory_source_registry s JOIN memory_provider_documents m ON m.source_id=s.id AND m.bank_id=s.bank_id WHERE s.bank_id=? AND m.provider_document_id=? AND s.status='active'", bank.id, evidence.document_id) : undefined);
          if (!sources.length || sources.some((source) => !source || !this.source(source))) continue;
          const refs = [...new Set(sources.map((source) => String(source!.id)))];
          facts.push({ ref: refs[0], refs, scope: String(bank.scope), text: fact.text.slice(0, 1400), sourceClass: fact.sources ? "synthesized" : String(sources[0]!.source_class) });
        }
      }
      if (this.store.get("SELECT version FROM bot_policies WHERE bot_id=?", botId)?.version !== policy.version || this.store.get("SELECT status FROM bots WHERE id=?", botId)?.status !== "active") return { status: "disabled", facts: [] };
      if (banks.some((bank) => {
        const current = this.store.get("SELECT * FROM memory_bank_bindings WHERE id=?", bank.id);
        return current?.state !== "ready" || current.visibility_generation !== bank.visibility_generation || current.provider_bank_id !== bank.provider_bank_id;
      })) return { status: "pending", facts: [] };
      return { status: banks.length ? "available" : "pending", facts: facts.slice(0, 12) };
    } catch { return { status: "unavailable", facts: [] }; }
  }
  async close() { this.closing = true; clearInterval(this.timer); await this.pending; }
}
