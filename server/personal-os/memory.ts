import { CoreStore, hash, id, now, text, type Row } from "./store.ts";
import { MemoryLedger } from "./memory-ledger.ts";
import { policyTools } from "./policy.ts";
import { MemoryPrivacy, type ForgetPlan } from "./memory-privacy.ts";
import { AssistantMemory } from './assistant-memory.ts';
import { dropVectors, lexicalHits, sourceRow } from './retrieval-index.ts';
import { CoreMemory } from './core-memory.ts';
import type { Retrieval, RetrievalResult } from './retrieval.ts';

export class MemoryModule {
  readonly personal: AssistantMemory;
  /** The always-loaded core memory (an assistant's and the workspace's). */
  readonly core: CoreMemory;
  /** Hybrid retrieval over memories, episode archives and documents (and its embedding / rerank settings). */
  get retrieval(): Retrieval { return this.personal.retrieval; }
  readonly ledger: MemoryLedger;
  readonly privacy: MemoryPrivacy;
  constructor(readonly store: CoreStore, changed: () => void = () => {}, readonly fence: (plan: ForgetPlan) => void = () => {}) {
    this.personal=new AssistantMemory(store,changed);
    this.core=new CoreMemory(store);
    this.privacy = new MemoryPrivacy(store);
    // Replay before capture/backfill or opening history to the renderer.
    const replayed: ForgetPlan[] = [];
    this.privacy.replay((plan) => { fence(plan); replayed.push(plan); });
    this.ledger = new MemoryLedger(store, undefined, changed);
    for (const plan of replayed) for (const bank of plan.banks) if (store.get("SELECT id FROM memory_bank_bindings WHERE id=?", bank)) this.ledger.invalidate(bank);
    for (const rule of store.all("SELECT plan_json FROM memory_forget_rules WHERE status='cleaning'")) for (const bank of (JSON.parse(String(rule.plan_json)) as ForgetPlan).banks) if (store.get("SELECT state FROM memory_bank_bindings WHERE id=?", bank)?.state === "ready") this.ledger.invalidate(bank);
  }
  list(botId: string): Row[] {
    return this.store.all("SELECT d.id,d.title,d.scope,d.bot_id,d.version,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.workspace_id=? AND d.owner_user_id=? AND d.status='active' AND (d.scope='workspace' OR d.bot_id=?) ORDER BY d.updated_at DESC LIMIT 50", this.store.workspace, this.store.owner, botId);
  }
  read(botId: string, documentId: string) {
    const row = this.store.get("SELECT d.id,d.title,d.scope,d.bot_id,d.version,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.id=? AND d.workspace_id=? AND d.owner_user_id=? AND d.status='active' AND (d.scope='workspace' OR d.bot_id=?)", documentId, this.store.workspace, this.store.owner, botId);
    if (!row) throw new Error("记忆不存在或不属于该 Agent / 共享工作区");
    return row;
  }
  /** Documents matching a query, best first: those of a hybrid retrieval the caller already made, else BM25. */
  search(botId: string, query: string, found?: RetrievalResult): Row[] {
    const needle = text(query, 200);
    const rows = found ? found.candidates.filter((item) => item.kind === 'document').map((item) => item.row) : lexicalHits(this.store, botId, needle, ['document']).map((hit) => hit.row);
    return rows.slice(0, 10).map((row) => ({ id: row.id, title: row.title, scope: row.scope, bot_id: row.bot_id, version: row.version, content: row.content }));
  }
  prompt(botId: string) {
    if(this.personal.settings(botId).version && !this.personal.enabled(botId)) return '长期记忆已关闭；连续对话和原文历史检索仍可使用。';
    const policy = this.store.get("SELECT * FROM bot_policies WHERE bot_id=?", botId);
    if (!policy || !policyTools(policy).includes("memory.search")) return "长期记忆检索已禁用";
    // Only the small core memory is always loaded; its text changes only when a line does, so the prompt prefix
    // stays cacheable. Documents, facts and archives are recalled per task or searched on demand.
    return this.core.render(botId);
  }
  /** Whether a topic reference names a memory, document or archive this assistant can open. */
  refExists(botId: string, ref: string): boolean {
    const [kind, ident] = ref.split(':');
    if (kind === 'episode') return !!sourceRow(this.store, 'episode', botId, ident);
    return !!sourceRow(this.store, 'memory', botId, ident) || !!sourceRow(this.store, 'document', botId, ident);
  }
  write(botId: string, data: Record<string, unknown>, callId?: string) {
    const scope = data.scope === "workspace" ? "workspace" : "bot";
    const documentId = typeof data.documentId === "string" ? text(data.documentId, 100) : id();
    const title = text(data.title, 200), content = text(data.content, 20_000);
    const expectedVersion = Number(data.expectedVersion ?? 0);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("记忆版本无效");
    return this.store.transaction(() => {
      if (callId) {
        const receipt = this.store.get("SELECT * FROM memory_write_receipts WHERE tool_call_id=?", callId);
        if (receipt) return { documentId: receipt.memory_document_id, version: receipt.committed_version, saved: true };
      }
      const old = this.store.get("SELECT * FROM memory_documents WHERE id=?", documentId);
      if (old && (old.status !== "active" || old.scope !== scope || (scope === "bot" && old.bot_id !== botId))) throw new Error("禁止修改其他 Agent 的记忆或更换记忆范围");
      if (Number(old?.version ?? 0) !== expectedVersion) throw new Error("记忆已被更新，请重新读取后提交");
      const contentHash = hash(content), storageKey = `memory/${documentId}`;
      if (!old) this.store.insert("memory_documents", { id: documentId, ...this.store.scope(), scope, bot_id: scope === "bot" ? botId : null, title, storage_key: storageKey, content_hash: contentHash, source_json: JSON.stringify({ actor: callId ? "agent" : "owner", callId: callId ?? null }), status: "active", created_at: now(), updated_at: now() });
      else this.store.run("UPDATE memory_documents SET title=?,content_hash=?,source_json=?,updated_at=?,version=version+1 WHERE id=? AND version=?", title, contentHash, JSON.stringify({ actor: callId ? "agent" : "owner", callId: callId ?? null }), now(), documentId, expectedVersion);
      this.store.run("INSERT INTO memory_content VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET content=excluded.content", documentId, content);
      this.store.run("DELETE FROM memory_search WHERE document_id=?", documentId);
      this.store.run("INSERT INTO memory_search(document_id,title,content) VALUES(?,?,?)", documentId, title, content);
      dropVectors(this.store, "document", documentId);
      const result = { documentId, version: expectedVersion + 1, saved: true };
      this.store.insert("memory_document_versions", { document_id: documentId, version: result.version, title, content, content_hash: contentHash });
      if (old) this.ledger.retractDocument(documentId);
      this.ledger.document(this.store.get("SELECT d.*,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.id=?", documentId)!);
      if (callId) {
        this.store.insert("memory_write_receipts", { tool_call_id: callId, ...this.store.scope(), bot_id: botId, target_kind: "memory", memory_document_id: documentId, expected_version: expectedVersion, committed_version: expectedVersion + 1, content_hash: contentHash, storage_key: storageKey, result_hash: hash(JSON.stringify(result)), committed_at: now() });
        this.store.run("UPDATE tool_calls SET status='succeeded',result_json=?,result_hash=?,version=version+1 WHERE id=?", JSON.stringify(result), hash(JSON.stringify(result)), callId);
      }
      this.store.audit("memory.write", "memory", documentId, { scope, botId, version: result.version, callId: callId ?? null });
      return result;
    });
  }
  remove(documentId: string, expectedVersion: number) {
    this.store.transaction(() => {
      if (this.store.run("UPDATE memory_documents SET status='deleted',version=version+1,updated_at=? WHERE id=? AND version=? AND status='active'", now(), documentId, expectedVersion).changes !== 1) throw new Error("记忆版本已变化");
      this.store.run("DELETE FROM memory_search WHERE document_id=?", documentId);
      dropVectors(this.store, "document", documentId);
      this.store.run("DELETE FROM assistant_topic_members WHERE kind='document' AND ref_id=?", documentId);
      this.store.run("DELETE FROM assistant_topic_member_scan WHERE kind='document' AND ref_id=?", documentId);
      this.ledger.retractDocument(documentId);
      this.store.audit("memory.delete", "memory", documentId, { expectedVersion });
    });
  }
  forget(botId: string, selector: Record<string, unknown>, revision: string) {
    const plan = this.privacy.preview(botId, selector);
    if (revision !== plan.revision) throw new Error("清理范围已变化，请重新预览");
    const record = this.privacy.persist(plan);
    this.store.transaction(() => {
      this.store.insert("memory_forget_rules", { id: record.id, selector_hash: plan.selectorHash, plan_json: JSON.stringify(plan), status: "pending", created_at: now() });
      for (const bank of plan.banks) this.store.run("UPDATE memory_bank_bindings SET state='quarantined' WHERE id=?", bank);
    });
    this.fence(plan);
    this.store.transaction(() => { this.privacy.redact(plan, record.id); for (const bank of plan.banks) this.ledger.invalidate(bank); });
    this.ledger.changed(); void this.ledger.flush();
    return { id: record.id, status: plan.banks.length ? "cleaning" : "completed", documents: plan.documents.length, messages: plan.messages.length };
  }
  consume(taskId: string, references: string[] = [], documents: string[] = []) {
    const bot = this.store.get("SELECT bot_id FROM tasks WHERE id=?", taskId)?.bot_id;
    if (!bot) return;
    const notes = new Set([...documents, ...this.list(String(bot)).slice(0, 15).map((doc) => String(doc.id))]);
    const history = this.store.all("SELECT id,task_id FROM agent_messages WHERE bot_id=? AND (task_id IS NULL OR task_id!=?) ORDER BY seq DESC", bot, taskId);
    for(const message of history)this.store.run('INSERT OR IGNORE INTO assistant_memory_uses VALUES(?,?)',taskId,message.id);
    const rawMessages = new Set(history.map((message) => String(message.id)));
    const refs = new Set(references);
    for (const source of this.store.all("SELECT s.* FROM memory_source_registry s JOIN memory_bank_bindings b ON b.id=s.bank_id WHERE s.status='active' AND (b.bot_id=? OR b.scope='workspace')", bot)) if (refs.has(String(source.id)) || (source.source_kind === "document" ? notes.has(String(source.original_id)) : rawMessages.has(String(source.original_id)))) this.store.run("INSERT OR IGNORE INTO memory_task_sources VALUES(?,?)", taskId, source.id);
    for (const row of [...history, ...this.store.all("SELECT task_id FROM agent_journal WHERE bot_id=? AND task_id!=? ORDER BY created_at DESC LIMIT 3", bot, taskId)]) if (row.task_id && row.task_id !== taskId) this.store.run("INSERT OR IGNORE INTO memory_task_dependencies VALUES(?,?)", taskId, row.task_id);
    const parent = this.store.get("SELECT parent_task_id FROM a2a_messages WHERE child_task_id=?", taskId);
    if (parent) this.store.run("INSERT OR IGNORE INTO memory_task_sources SELECT ?,source_id FROM memory_task_sources WHERE task_id=?", taskId, parent.parent_task_id);
  }
  expand(botId: string, ref: string) {
    if(ref.startsWith('message:')) return {ref,sourceClass:'original',content:this.personal.source(botId,ref.slice(8)).content};
    if(ref.startsWith('episode:')) return {ref,sourceClass:'synthesized',content:this.personal.source(botId,ref).content};
    const source = this.store.get("SELECT s.* FROM memory_source_registry s JOIN memory_bank_bindings b ON b.id=s.bank_id WHERE s.id=? AND s.status='active' AND (b.bot_id=? OR b.scope='workspace')", ref, botId);
    if (!source) throw new Error("来源已撤回或不可见");
    const payload = this.ledger.source(source); if (!payload) throw new Error("来源已变化");
    return { ref, sourceClass: source.source_class, content: payload.content, contentHash: source.content_hash };
  }
  publish(botId: string, ref: string, sourceHash: string, intent: string) {
    const source = this.store.get("SELECT s.* FROM memory_source_registry s JOIN memory_bank_bindings b ON b.id=s.bank_id WHERE s.id=? AND s.status='active' AND b.bot_id=?", ref, botId);
    if (!source || source.content_hash !== sourceHash) throw new Error("来源已变化，请重新查看");
    const content = this.expand(botId, ref).content;
    const result = this.write(botId, { title: "用户共享的记忆", content, scope: "workspace" });
    this.store.insert("memory_publications", { id: id(), source_id: ref, document_id: result.documentId, source_hash: sourceHash, intent_hash: hash(text(intent, 200)), created_at: now() });
    const copy = this.store.get("SELECT id FROM memory_source_registry WHERE source_kind='document' AND original_id=?", result.documentId)!;
    this.store.run("INSERT OR IGNORE INTO memory_source_edges VALUES(?,?)", copy.id, ref);
    return result;
  }
  async recall(botId: string, query: string, taskId?: string, found?: RetrievalResult) {
    if(this.personal.settings(botId).version){
      if(!this.personal.enabled(botId))return {status:'disabled',facts:[]};
      return {status:'available',facts:await this.personal.recall(botId,query,Math.min(2000,Math.floor(this.store.modelConfig(botId).contextWindow*.05)),taskId,found)};
    }
    return this.ledger.client ? this.ledger.recall(botId,query) : {status:'disabled',facts:[]};
  }
  async reflect(botId: string, query: string, taskId?: string) {
    query = text(query, 1000);
    const policy = this.store.get("SELECT * FROM bot_policies WHERE bot_id=?", botId);
    if (!policy || !policyTools(policy).includes("memory.search") || (taskId && this.store.get("SELECT bot_id FROM tasks WHERE id=? AND ended_at IS NULL", taskId)?.bot_id !== botId)) throw new Error("该 Agent 无权综合记忆");
    if(this.personal.settings(botId).version) return this.personal.reflect(botId,query,taskId);
    const client = this.ledger.client; if (!client) throw new Error("语义记忆服务尚未就绪");
    const banks = this.store.all("SELECT * FROM memory_bank_bindings WHERE (bot_id=? OR scope='workspace') AND state='ready'", botId);
    const answers: Array<{ scope: Row[string]; text: string; refs: string[] }> = [];
    for (const bank of banks) {
      const result = await client.reflect(String(bank.provider_bank_id), query, taskId);
      const current = this.store.get("SELECT * FROM memory_bank_bindings WHERE id=?", bank.id);
      if (current?.state !== "ready" || current.provider_bank_id !== bank.provider_bank_id || current.visibility_generation !== bank.visibility_generation || current.content_generation !== bank.content_generation || this.store.get("SELECT version FROM bot_policies WHERE bot_id=?", botId)?.version !== policy.version || this.store.get("SELECT status FROM bots WHERE id=?", botId)?.status !== "active" || (taskId && this.store.get("SELECT ended_at FROM tasks WHERE id=?", taskId)?.ended_at !== null)) throw new Error("记忆或权限已变化，请重新检索");
      const evidence = (result.based_on as { memories?: Array<{ document_id?: string }> } | undefined)?.memories ?? [];
      const refs = evidence.map((fact) => this.store.get("SELECT s.id FROM memory_source_registry s JOIN memory_provider_documents d ON d.source_id=s.id WHERE s.bank_id=? AND d.provider_document_id=? AND s.status='active'", bank.id, fact.document_id ?? "")?.id);
      if (!evidence.length) continue;
      if (refs.some((ref) => !ref)) throw new Error("综合结果缺少有效来源");
      answers.push({ scope: bank.scope, text: text(result.text, 20_000), refs: [...new Set(refs.map(String))] });
      if (taskId) this.consume(taskId, refs.map(String));
    }
    // A previously checked private bank may change while the shared-bank
    // reflection is awaiting its model. Check the entire read snapshot again
    // before caching or returning either answer.
    if (banks.some((bank) => {
      const current = this.store.get("SELECT * FROM memory_bank_bindings WHERE id=?", bank.id);
      return current?.state !== "ready" || current.provider_bank_id !== bank.provider_bank_id || current.visibility_generation !== bank.visibility_generation || current.content_generation !== bank.content_generation;
    }) || this.store.get("SELECT version FROM bot_policies WHERE bot_id=?", botId)?.version !== policy.version || this.store.get("SELECT status FROM bots WHERE id=?", botId)?.status !== "active" || (taskId && this.store.get("SELECT ended_at FROM tasks WHERE id=?", taskId)?.ended_at !== null)) throw new Error("记忆或权限已变化，请重新检索");
    const result = { answers, status: answers.length ? "available" : "no_evidence" };
    this.store.insert("memory_syntheses", { id: id(), bot_id: botId, query, result_json: JSON.stringify(result), generations_json: JSON.stringify(banks.map((b) => ({ id: b.id, physical: b.provider_bank_id, content: b.content_generation, visibility: b.visibility_generation }))), created_at: now() });
    return result;
  }
}
