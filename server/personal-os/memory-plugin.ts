import { CoreStore, canonical, optionalText, text } from "./store.ts";
import { HindsightClient, memoryEndpoint } from "./hindsight.ts";
import { MemoryLedger } from "./memory-ledger.ts";

interface Settings { provider: string; enabled: boolean; endpoint: string; token: string }
// Plugins are reviewed adapters, not arbitrary code downloaded into Core.
const adapters = new Map([["hindsight", {
  name: "Hindsight", protocol: "HTTP API v1 · 0.10.3",
  create: (settings: Settings) => new HindsightClient(settings.endpoint, settings.token),
}]]);
const secretId = "memory-plugin-settings";

export class ExternalMemoryPlugin {
  readonly active?: Settings;
  state = "disabled";
  error: string | null = null;
  private pending?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private closing = false;
  private saving = false;
  constructor(readonly store: CoreStore, readonly ledger: MemoryLedger, readonly changed: () => void) {
    this.active = this.read();
  }
  private read(): Settings | undefined {
    const row = this.store.get("SELECT ciphertext FROM secrets WHERE id=?", secretId);
    return row ? JSON.parse(this.store.decrypt(String(row.ciphertext))) as Settings : undefined;
  }
  private parse(data: Record<string, unknown>): Settings {
    if (typeof data.enabled !== "boolean") throw new Error("插件启用状态无效");
    const provider = text(data.provider, 100);
    if (!adapters.has(provider)) throw new Error("不支持的记忆插件");
    const previous = this.read();
    const endpoint = optionalText(data.endpoint, 2000) ? memoryEndpoint(text(data.endpoint, 2000)) : "";
    // A credential may only be reused for the same provider and origin.
    const token = optionalText(data.token, 8192) || (previous?.provider === provider && previous.endpoint === endpoint ? previous.token : "");
    if (data.enabled && (!endpoint || !token)) throw new Error("请填写记忆服务地址和访问令牌");
    return { provider, enabled: data.enabled, endpoint, token };
  }
  status() {
    const settings = this.read();
    return { providers: [...adapters].map(([id, adapter]) => ({ id, name: adapter.name, protocol: adapter.protocol })),
      provider: settings?.provider ?? "hindsight", enabled: settings?.enabled ?? false,
      endpoint: settings?.endpoint ?? "", hasToken: !!settings?.token,
      restartRequired: canonical(settings ?? null) !== canonical(this.active ?? null),
      status: this.state === "ready" && this.ledger.lastError ? "unavailable" : this.state,
      error: this.error ?? this.ledger.lastError };
  }
  async test(data: Record<string, unknown>) {
    const settings = this.parse({ ...data, enabled: true });
    const client = adapters.get(settings.provider)!.create(settings);
    try {
      const result = await client.request("/v1/default/banks");
      if (!Array.isArray(result.banks)) throw new Error("invalid_response");
    } catch { throw new Error("记忆插件连接失败，请检查地址、令牌和 Hindsight API 版本"); }
    return { ok: true, provider: settings.provider };
  }
  private async checkMigration(client: HindsightClient) {
    const bound = this.store.get("SELECT ciphertext FROM secrets WHERE id='memory-plugin-origin'");
    if (bound && this.store.decrypt(String(bound.ciphertext)) === client.endpoint) return;
    // Never declare a blank replacement service to contain previously indexed
    // memories, nor send retirement requests to a different empty service.
    const banks = this.store.all("SELECT provider_bank_id FROM memory_bank_bindings b WHERE EXISTS (SELECT 1 FROM memory_transfers t WHERE t.bank_id=b.id AND t.attempts>0) UNION SELECT provider_bank_id FROM memory_bank_retirements WHERE status!='succeeded'");
    for (const bank of banks) {
      try { await client.request(client.bank(String(bank.provider_bank_id))); }
      catch { throw new Error("原记忆索引尚未迁移到此服务。请先迁移 Hindsight 数据库，或继续连接原服务；本地记录不会删除。"); }
    }
  }
  async save(data: Record<string, unknown>, authorize: () => Promise<void> = async () => {}) {
    if (this.saving) throw new Error("正在保存记忆插件配置");
    this.saving = true;
    try {
      const settings = this.parse(data);
      if (settings.enabled) await this.checkMigration(adapters.get(settings.provider)!.create(settings));
      await authorize();
      if (this.closing) throw new Error("Core 正在关闭");
      this.store.run("INSERT INTO secrets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", secretId, this.store.encrypt(JSON.stringify(settings)));
      this.changed();
      return this.status();
    } finally { this.saving = false; }
  }
  start() {
    if (!this.active?.enabled || this.pending || this.closing) return;
    this.state = "connecting";
    this.pending = (async () => {
      const adapter = adapters.get(this.active!.provider);
      if (!adapter) throw new Error("不支持的记忆插件");
      const client = adapter.create(this.active!);
      const result = await client.request("/v1/default/banks");
      if (!Array.isArray(result.banks)) throw new Error("记忆服务协议不匹配");
      await this.checkMigration(client);
      if (this.closing) return;
      this.store.run("INSERT INTO secrets VALUES('memory-plugin-origin',?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", this.store.encrypt(client.endpoint));
      this.ledger.client = client; this.ledger.lastError = null;
      this.state = "ready"; this.error = null;
      void this.ledger.flush();
    })().catch(() => {
      this.state = "unavailable"; this.error = "记忆服务无法连接，或原索引尚未迁移";
      if (!this.closing) this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, 30_000);
    }).finally(() => { this.pending = undefined; if (!this.closing) this.changed(); });
  }
  async close() { this.closing = true; clearTimeout(this.retry); await this.pending; }
}
