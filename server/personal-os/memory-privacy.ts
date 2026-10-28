import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { CoreStore, canonical, hash, id, now, text, type Row } from "./store.ts";
import { Episodes } from "./episodes.ts";
import { CoreMemory } from "./core-memory.ts";
import { dropVectors } from "./retrieval-index.ts";

export interface ForgetPlan { sources: string[]; documents: string[]; messages: string[]; tasks: string[]; bots: string[]; banks: string[]; hashes: string[]; selectorHash: string; revision: string }
const redacted = "[已遗忘]";
export class MemoryPrivacy {
  readonly episodes: Episodes;
  constructor(readonly store: CoreStore) { this.episodes = new Episodes(store); }
  preview(botId: string, selector: Record<string, unknown>): ForgetPlan {
    if (!this.store.get("SELECT id FROM bots WHERE id=?", botId)) throw new Error("Agent 不存在");
    const document = typeof selector.documentId === "string" ? text(selector.documentId, 100) : undefined;
    const query = document ? "" : text(selector.query, 200).normalize("NFKC").toLocaleLowerCase();
    const docs = this.store.all("SELECT d.*,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.bot_id=? OR d.scope='workspace'", botId);
    if (document && !docs.some((d) => d.id === document)) throw new Error("记忆不属于当前范围");
    const messages = this.store.all("SELECT * FROM agent_messages WHERE bot_id=?", botId);
    const matches = (row: Row) => String(row.content).normalize("NFKC").toLocaleLowerCase().includes(query) || String(row.title ?? "").normalize("NFKC").toLocaleLowerCase().includes(query);
    const documents = new Set(docs.filter((d) => document ? d.id === document : matches(d)).map((d) => String(d.id)));
    if (!document) for (const version of this.store.all("SELECT v.* FROM memory_document_versions v JOIN memory_documents d ON d.id=v.document_id WHERE d.bot_id=? OR d.scope='workspace'", botId)) if (matches(version)) documents.add(String(version.document_id));
    const messageIds = new Set(document ? [] : messages.filter(matches).map((m) => String(m.id)));
    // Archives of closed episodes are derived from the conversation. One that matches, or that a matching memory
    // rests on, is forgotten with the assistant's other derived data (redact removes every archive of a reached assistant).
    const hitEpisodes = new Set<string>();
    if (!document) for (const episode of this.store.all("SELECT title,summary,open_items,id FROM conversation_episodes WHERE bot_id=?", botId)) if (matches({ title: episode.title, content: `${episode.summary}\n${episode.open_items}` })) hitEpisodes.add(`episode:${episode.id}`);
    if(!document)for(const memory of this.store.all('SELECT * FROM assistant_memories WHERE bot_id=?',botId))if(matches(memory))for(const ref of JSON.parse(String(memory.refs_json)))(String(ref.id).startsWith('episode:')?hitEpisodes:messageIds).add(String(ref.id));
    const sources = new Set<string>(), tasks = new Set<string>(), banks = new Set<string>(), bots = new Set<string>();
    if (messageIds.size || hitEpisodes.size) bots.add(botId);
    for(const use of this.store.all('SELECT * FROM assistant_memory_uses'))if(messageIds.has(String(use.message_id))||hitEpisodes.has(String(use.message_id)))tasks.add(String(use.task_id));
    const all = this.store.all("SELECT * FROM memory_source_registry"), edges = this.store.all("SELECT * FROM memory_source_edges"), uses = this.store.all("SELECT * FROM memory_task_sources");
    const allTasks = this.store.all("SELECT id,bot_id,ended_at FROM tasks"), dependencies = this.store.all("SELECT * FROM memory_task_dependencies");
    for (const source of all) if ((source.source_kind === "document" && documents.has(String(source.original_id))) || (source.source_kind === "message" && messageIds.has(String(source.original_id)))) sources.add(String(source.id));
    for (const message of messages) if (messageIds.has(String(message.id)) && message.task_id) tasks.add(String(message.task_id));
    // Conservative causal closure: a mixed-source answer is removed whole.
    let changed = true;
    while (changed) {
      const before = sources.size + tasks.size;
      for (const use of uses) if (sources.has(String(use.source_id))) tasks.add(String(use.task_id));
      for (const dependency of dependencies) if (tasks.has(String(dependency.parent_task_id))) tasks.add(String(dependency.task_id));
      for (const origin of this.store.all("SELECT o.task_id parent_task_id,c.task_id FROM routine_origins o JOIN routine_occurrences c ON c.routine_id=o.routine_id WHERE c.task_id IS NOT NULL")) if (tasks.has(String(origin.parent_task_id))) tasks.add(String(origin.task_id));
      for (const edge of edges) if (sources.has(String(edge.parent_id))) sources.add(String(edge.source_id));
      const sameHashes = new Set(all.filter((s) => sources.has(String(s.id))).map((s) => s.content_hash));
      for (const source of all) if (sameHashes.has(source.content_hash)) sources.add(String(source.id));
      for (const source of all) if (source.task_id && tasks.has(String(source.task_id))) sources.add(String(source.id));
      for (const link of this.store.all("SELECT parent_task_id,child_task_id,root_task_id FROM a2a_messages")) if ([link.parent_task_id, link.child_task_id, link.root_task_id].some((t) => tasks.has(String(t)))) for (const t of [link.parent_task_id, link.child_task_id, link.root_task_id]) tasks.add(String(t));
      for (const source of all) if (sources.has(String(source.id))) {
        const bank = this.store.get("SELECT * FROM memory_bank_bindings WHERE id=?", source.bank_id)!;
        if (bank.bot_id) bots.add(String(bank.bot_id));
        else for (const bot of this.store.all("SELECT id FROM bots")) bots.add(String(bot.id));
      }
      // Legacy messages can select a task with no registry entry. Its Bot and
      // current work still belong inside the causal fixed point.
      for (const task of allTasks) if (tasks.has(String(task.id))) bots.add(String(task.bot_id));
      for (const task of allTasks) if (task.ended_at === null && bots.has(String(task.bot_id))) tasks.add(String(task.id));
      changed = before !== sources.size + tasks.size;
    }
    for (const source of all) if (sources.has(String(source.id))) {
      banks.add(String(source.bank_id));
      (source.source_kind === "document" ? documents : messageIds).add(String(source.original_id));
    }
    for (const message of this.store.all("SELECT id,bot_id,task_id FROM agent_messages")) if (tasks.has(String(message.task_id))) { messageIds.add(String(message.id)); bots.add(String(message.bot_id)); }
    for (const task of this.store.all("SELECT id,bot_id FROM tasks")) if (tasks.has(String(task.id))) bots.add(String(task.bot_id));
    for (const bank of this.store.all("SELECT * FROM memory_bank_bindings")) if (banks.has(String(bank.id))) { if (bank.bot_id) bots.add(String(bank.bot_id)); else for (const bot of this.store.all("SELECT id FROM bots")) bots.add(String(bot.id)); }
    // Stop current work of affected contacts: its live Pi context may contain
    // raw history even if it hasn't reached a model-request boundary yet.
    for (const task of this.store.all("SELECT id,bot_id FROM tasks WHERE ended_at IS NULL")) if (bots.has(String(task.bot_id))) tasks.add(String(task.id));
    for (const source of all) if (tasks.has(String(source.task_id))) { sources.add(String(source.id)); banks.add(String(source.bank_id)); (source.source_kind === "document" ? documents : messageIds).add(String(source.original_id)); }
    const hashes = new Set(all.filter((s) => sources.has(String(s.id))).map((s) => String(s.content_hash)));
    for (const doc of docs) if (documents.has(String(doc.id))) hashes.add(hash(String(doc.content)));
    for (const message of this.store.all("SELECT id,content FROM agent_messages")) if (messageIds.has(String(message.id))) hashes.add(hash(String(message.content)));
    const result = { sources: [...sources].sort(), documents: [...documents].sort(), messages: [...messageIds].sort(), tasks: [...tasks].sort(), banks: [...banks].sort(), bots: [...bots].sort(), hashes: [...hashes].sort(), selectorHash: hash(canonical({ botId, document, query })) };
    const revision = hash(canonical({ ...result, sources: all.filter((s) => sources.has(String(s.id))), docs: this.store.all("SELECT id,version,content_hash FROM memory_documents"), seqs: this.store.all("SELECT bot_id,next_seq FROM agent_inboxes") }));
    return { ...result, revision };
  }
  persist(plan: ForgetPlan) {
    const file = path.join(this.store.dir, "forget-journal.json"), records = existsSync(file) ? JSON.parse(this.store.decrypt(readFileSync(file, "utf8"))) as Array<{ id: string; plan: ForgetPlan }> : [];
    const record = { id: id(), plan }; records.push(record);
    // Write before SQLite mutation, so a crash or an older Core DB restored
    // into this profile must replay its identity-only tombstones before reads.
    const temporary = file + ".tmp"; writeFileSync(temporary, this.store.encrypt(JSON.stringify(records)), { mode: 0o600 }); renameSync(temporary, file);
    return record;
  }
  replay(apply: (plan: ForgetPlan) => void) {
    const file = path.join(this.store.dir, "forget-journal.json");
    if (!existsSync(file)) return;
    for (const record of JSON.parse(this.store.decrypt(readFileSync(file, "utf8"))) as Array<{ id: string; plan: ForgetPlan }>) if ([undefined, "pending"].includes(this.store.get("SELECT status FROM memory_forget_rules WHERE id=?", record.id)?.status as string | undefined)) {
      this.redact(record.plan, record.id); apply(record.plan);
    }
  }
  redact(plan: ForgetPlan, ruleId: string) {
    this.store.transaction(() => {
      this.store.run("UPDATE memory_privacy_maintenance SET active=1 WHERE id=1");
      for (const digest of plan.hashes) this.store.run("INSERT OR IGNORE INTO memory_tombstones VALUES(?)", digest);
      for (const source of plan.sources) this.store.run("UPDATE memory_source_registry SET status='retracted' WHERE id=?", source);
      for (const document of plan.documents) {
        this.store.run("UPDATE memory_documents SET version=version+CASE WHEN status='active' THEN 1 ELSE 0 END,status='deleted',title=?,updated_at=? WHERE id=?", redacted, now(), document);
        this.store.run("UPDATE memory_content SET content='' WHERE document_id=?", document);
        this.store.run("UPDATE memory_document_versions SET content='',title=? WHERE document_id=?", redacted, document);
        this.store.run("DELETE FROM memory_search WHERE document_id=?", document);
        dropVectors(this.store, "document", document);
        this.store.run("UPDATE memory_publications SET revoked_at=? WHERE document_id=? OR source_id IN (SELECT id FROM memory_source_registry WHERE source_kind='document' AND original_id=?)", now(), document, document);
      }
      for (const message of plan.messages) this.store.run("UPDATE agent_messages SET content=? WHERE id=?", redacted, message);
      for (const task of plan.tasks) {
        if (!this.store.get("SELECT id FROM tasks WHERE id=?", task)) continue;
        this.store.run("INSERT OR IGNORE INTO memory_forgotten_tasks VALUES(?)", task);
        // The task's recalled memories and its conversation's working note are derived from what is forgotten.
        this.store.run("DELETE FROM conversation_working_notes WHERE conversation_id=(SELECT conversation_id FROM tasks WHERE id=?)", task);
        this.store.run("DELETE FROM task_recall WHERE task_id=?", task);
        this.store.run("UPDATE tasks SET objective=?,result_summary=? WHERE id=?", redacted, redacted, task);
        this.store.run("UPDATE conversation_inputs SET content_json=? WHERE task_id=?", JSON.stringify({ text: redacted }), task);
        this.store.run("UPDATE transcript SET content=? WHERE task_id=?", redacted, task);
        this.store.run("UPDATE agent_messages SET content=? WHERE task_id=?", redacted, task);
        this.store.run("UPDATE agent_journal SET objective=?,result=? WHERE task_id=?", redacted, redacted, task);
        this.store.run("UPDATE tool_calls SET arguments_json='{}',canonical_envelope='{}',result_json=? WHERE task_id=?", JSON.stringify({ forgotten: true }), task);
        this.store.run("UPDATE routine_tool_receipts SET result_json=? WHERE call_id IN (SELECT id FROM tool_calls WHERE task_id=?)", JSON.stringify({ forgotten: true }), task);
        for (const origin of this.store.all("SELECT routine_id FROM routine_origins WHERE task_id=?", task)) {
          this.store.run("UPDATE agent_routines SET name=?,prompt=?,enabled=0,next_due_at=NULL,version=version+1 WHERE id=?", redacted, redacted, origin.routine_id);
          this.store.run("UPDATE routine_occurrences SET status='cancelled' WHERE routine_id=? AND status='pending'", origin.routine_id);
          this.store.run("UPDATE routine_tool_receipts SET result_json=? WHERE call_id IN (SELECT id FROM tool_calls WHERE tool_name='routine.save' AND (target_id=? OR id=?))", JSON.stringify({ forgotten: true }), origin.routine_id, String(origin.routine_id).replace(/^tool:/, ""));
        }
        this.store.run("UPDATE call_reconciliations SET evidence_json='{}' WHERE tool_call_id IN (SELECT id FROM tool_calls WHERE task_id=?)", task);
        this.store.run("UPDATE audit_records SET details_json='{}' WHERE entity_id=? OR entity_id IN (SELECT id FROM tool_calls WHERE task_id=?)", task, task);
        this.store.run("UPDATE a2a_messages SET payload=?,result=? WHERE parent_task_id=? OR child_task_id=?", redacted, JSON.stringify({ result: redacted }), task, task);
        this.store.run("UPDATE conversations SET title=? WHERE id=(SELECT conversation_id FROM tasks WHERE id=?)", redacted, task);
        this.store.run("UPDATE routine_occurrences SET status='cancelled' WHERE task_id=? AND status IN ('pending','running')", task);
      }
      // Topic lines of core memory that point at something forgotten go with it.
      const forgotten = new Set<string>(plan.documents.map((document) => `memory:${document}`));
      for (const bot of plan.bots) {
        this.store.run("DELETE FROM memory_syntheses WHERE bot_id=?", bot);
        this.store.run('DELETE FROM context_checkpoints WHERE bot_id=?',bot);
        this.store.run('DELETE FROM assistant_working_notes WHERE bot_id=?',bot);
        this.store.run('DELETE FROM conversation_working_notes WHERE bot_id=?',bot);
        this.store.run('DELETE FROM task_recall WHERE bot_id=?',bot);
        // Episode archives and their index are derived data like checkpoints: all of the reached assistant's go,
        // and with them every memory that rests on one.
        const archives=this.episodes.forgetBot(bot);
        for(const ref of archives)forgotten.add(ref);
        // Remove complete mixed-source records (including prior versions),
        // while retaining unrelated facts in this assistant's bank.
        for(const memory of this.store.all('SELECT * FROM assistant_memories WHERE bot_id=?',bot)){
          const versions=[memory,...this.store.all('SELECT refs_json FROM assistant_memory_versions WHERE id=?',memory.id)];
          if(versions.some(version=>(JSON.parse(String(version.refs_json)) as Array<{id:string}>).some(ref=>plan.messages.includes(ref.id)||archives.has(ref.id)))){
            forgotten.add('memory:'+memory.id);
            this.store.run('DELETE FROM assistant_memory_versions WHERE id=?',memory.id);
            this.store.run('DELETE FROM assistant_memory_search WHERE memory_id=?',memory.id);
            dropVectors(this.store,'memory',String(memory.id));
            this.store.run('DELETE FROM assistant_memories WHERE id=?',memory.id);
          }
        }
        this.store.run('DELETE FROM assistant_memory_imports WHERE bot_id=?',bot);
        this.store.run('DELETE FROM assistant_memory_steps WHERE bot_id=?',bot);
        this.store.run('UPDATE assistant_memory_settings SET version=version+1,consolidated_at=0,profile_at=0 WHERE bot_id=?',bot);
      }
      new CoreMemory(this.store).dropRefs(forgotten);
      this.store.run("INSERT INTO memory_forget_rules VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at", ruleId, plan.selectorHash, JSON.stringify(plan), plan.banks.length ? "cleaning" : "completed", now(), plan.banks.length ? null : now());
      this.store.run("UPDATE memory_privacy_maintenance SET active=0 WHERE id=1");
      this.store.audit("memory.forget", "forget", ruleId, { documents: plan.documents.length, messages: plan.messages.length, banks: plan.banks.length });
    });
  }
}
