import { CoreStore, hash, id, now, text, type Row } from "./store.ts";
import { MemoryLedger } from "./memory-ledger.ts";
import { policyTools } from "./policy.ts";

export class MemoryModule {
  readonly ledger: MemoryLedger;
  constructor(readonly store: CoreStore, changed: () => void = () => {}) { this.ledger = new MemoryLedger(store, undefined, changed); }
  list(botId: string): Row[] {
    return this.store.all("SELECT d.id,d.title,d.scope,d.bot_id,d.version,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.workspace_id=? AND d.owner_user_id=? AND d.status='active' AND (d.scope='workspace' OR d.bot_id=?) ORDER BY d.updated_at DESC LIMIT 50", this.store.workspace, this.store.owner, botId);
  }
  read(botId: string, documentId: string) {
    const row = this.store.get("SELECT d.id,d.title,d.scope,d.bot_id,d.version,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.id=? AND d.workspace_id=? AND d.owner_user_id=? AND d.status='active' AND (d.scope='workspace' OR d.bot_id=?)", documentId, this.store.workspace, this.store.owner, botId);
    if (!row) throw new Error("记忆不存在或不属于该 Agent / 共享工作区");
    return row;
  }
  search(botId: string, query: string) {
    const needle = "%" + text(query, 200).replace(/[\\%_]/g, "\\$&") + "%";
    return this.store.all("SELECT d.id,d.title,d.scope,d.bot_id,d.version,c.content FROM memory_documents d JOIN memory_content c ON c.document_id=d.id WHERE d.workspace_id=? AND d.owner_user_id=? AND d.status='active' AND (d.scope='workspace' OR d.bot_id=?) AND (d.title LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\') ORDER BY d.updated_at DESC LIMIT 10", this.store.workspace, this.store.owner, botId, needle, needle);
  }
  prompt(botId: string) {
    const policy = this.store.get("SELECT * FROM bot_policies WHERE bot_id=?", botId);
    if (!policy || !policyTools(policy).includes("memory.search")) return "长期记忆检索已禁用";
    return this.list(botId).slice(0, 15).map((m) => `[${m.scope === "workspace" ? "共享" : "私有"}记忆 id=${m.id} v=${m.version}] ${m.title}\n${String(m.content).slice(0, 1200)}`).join("\n\n").slice(0, 12_000);
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
      this.ledger.retractDocument(documentId);
      this.store.audit("memory.delete", "memory", documentId, { expectedVersion });
    });
  }
  async recall(botId: string, query: string) { return this.ledger.recall(botId, query); }
}
