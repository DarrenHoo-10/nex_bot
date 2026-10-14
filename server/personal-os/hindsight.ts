import { isIP } from "node:net";

// Fixed v0.10.3 HTTP boundary. Engine DTOs never enter Agent/Device protocols.
export function memoryEndpoint(value: string) {
  const url = new URL(value);
  const privateHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || (isIP(url.hostname) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname));
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("记忆服务须为 HTTPS 或本机/私有网络 HTTP 根地址，不能包含凭据或路径");
  return url.origin;
}
export interface RetainSource {
  content: string; documentId: string; timestamp: string;
  metadata: Record<string, string>; context: string;
}
export interface RecallFact { id: string; text: string; fact_type?: string; type?: string; document_id?: string; source_fact_ids?: string[]; sources?: RecallFact[] }
export class HindsightError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code); }
}
export class HindsightClient {
  readonly endpoint: string;
  private readonly requests = new Map<string, Set<AbortController>>();
  constructor(endpoint: string, readonly token: string) {
    this.endpoint = memoryEndpoint(endpoint);
  }
  cancelTask(taskId: string) { for (const controller of this.requests.get(taskId) ?? []) controller.abort(); }
  async request(route: string, method = "GET", body?: unknown, taskId?: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    if (taskId) { const pending = this.requests.get(taskId) ?? new Set<AbortController>(); pending.add(controller); this.requests.set(taskId, pending); }
    try {
    let response: Response;
    try { response = await fetch(this.endpoint + route, { method, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(taskId ? { "x-nex-task-id": taskId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(route.endsWith("/reflect") ? 120_000 : 15_000)]), redirect: "error" }); }
    catch { throw new HindsightError("engine_unavailable"); }
    if (!response.ok) { await response.body?.cancel(); throw new HindsightError(`engine_http_${response.status}`, response.status); }
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new HindsightError("engine_response_too_large");
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { throw new HindsightError("engine_invalid_response"); }
    } finally {
      if (taskId) { const pending = this.requests.get(taskId); pending?.delete(controller); if (!pending?.size) this.requests.delete(taskId); }
    }
  }
  bank(bank: string) { return `/v1/default/banks/${encodeURIComponent(bank)}`; }
  ensure(bank: string) { return this.request(this.bank(bank), "PUT", { name: "Personal memory" }); }
  async retain(bank: string, operation: string, source: RetainSource) {
    const result = await this.request(this.bank(bank) + "/memories", "POST", { operation_id: operation, async: true, items: [{ content: source.content, document_id: source.documentId, timestamp: source.timestamp, context: source.context, metadata: source.metadata }] });
    if (result.operation_id !== operation) throw new HindsightError("engine_operation_identity_conflict");
  }
  async operation(bank: string, operation: string): Promise<string | undefined> {
    try {
      const status = String((await this.request(this.bank(bank) + `/operations/${encodeURIComponent(operation)}`)).status);
      if (status === "not_found") return;
      if (!["pending", "processing", "completed", "failed", "cancelled"].includes(status)) throw new HindsightError("engine_invalid_operation_state");
      return status;
    }
    catch (error) { if (error instanceof HindsightError && error.status === 404) return; throw error; }
  }
  async recall(bank: string, query: string): Promise<RecallFact[]> {
    const result = await this.request(this.bank(bank) + "/memories/recall", "POST", { query, budget: "mid", max_tokens: 700, types: ["world", "experience", "observation"], include: { source_facts: { max_tokens: 2500 } } });
    if (!Array.isArray(result.results)) throw new HindsightError("engine_invalid_recall");
    const sources = (result.source_facts ?? {}) as Record<string, RecallFact>;
    return (result.results as RecallFact[]).flatMap((fact) => {
      if ((fact.type ?? fact.fact_type) !== "observation") return [fact];
      // A truncated provenance map is not proof of visibility. Withhold that
      // observation rather than present a synthesis with dangling citations.
      const ids = fact.source_fact_ids;
      return ids?.length && ids.every((ref) => sources[ref]?.document_id) ? [{ ...fact, sources: ids.map((ref) => sources[ref]) }] : [];
    });
  }
  reflect(bank: string, query: string, taskId?: string) {
    return this.request(this.bank(bank) + "/reflect", "POST", { query, budget: "low", max_tokens: 1200, include: { facts: {} }, fact_types: ["world", "experience"], exclude_mental_models: true }, taskId);
  }
  async retire(bank: string): Promise<boolean> {
    try {
      const operations: Array<{ id: string; status: string }> = [];
      // Pinned native API caps each page at 100. The previous 1000 request
      // returned 422 and left every genuine bank retirement stuck forever.
      for (let offset = 0; ; offset += 100) {
        const result = await this.request(this.bank(bank) + `/operations?limit=100&offset=${offset}`);
        if (!Array.isArray(result.operations) || Number(result.total ?? result.operations.length) > 100_000) throw new HindsightError("engine_retirement_requires_reconciliation");
        operations.push(...result.operations as Array<{ id: string; status: string }>);
        if (offset + 100 >= Number(result.total ?? result.operations.length)) break;
      }
      const live = operations.filter((op) => ["pending", "processing"].includes(op.status));
      for (const op of live) {
        try { await this.request(this.bank(bank) + `/operations/${encodeURIComponent(op.id)}`, "DELETE"); }
        catch (error) { if (!(error instanceof HindsightError && error.status === 409)) throw error; }
      }
      if (live.length) return false;
      await this.request(this.bank(bank), "DELETE");
      return true;
    } catch (error) { if (error instanceof HindsightError && error.status === 404) return true; throw error; }
  }
}
