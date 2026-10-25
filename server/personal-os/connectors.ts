import { isIP } from "node:net";
import { RemoteMcpClient, McpHttpError } from "../mcp-http.ts";
import { id, now, text, type CoreStore, type Row } from "./store.ts";
import { ConnectorOAuth } from "./connector-oauth.ts";
import { GmailProvider, GmailProviderError, validateGmailArguments, type GmailConfiguration } from "./gmail-provider.ts";
import type { ConnectorTool, ConnectorView } from "../../shared/personal-connectors.ts";
export type { ConnectorTool, ConnectorView } from "../../shared/personal-connectors.ts";

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redact));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), redactValue(entry, redact)]));
  return value;
}
export function connectorUrl(value: unknown): string {
  const url = new URL(text(value, 2048));
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateHost = host === "localhost" || host === "::1" || (isIP(host) === 4 && /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host));
  if (url.username || url.password || url.hash || url.search || !["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && !privateHost)) throw new Error("请使用 HTTPS 地址；本机或私有网络可使用 HTTP。令牌请填写在独立字段。");
  if (host === "0.0.0.0" || host === "::" || host.startsWith("169.254.") || (isIP(host) === 6 && /^fe[89ab]/i.test(host))) throw new Error("不能连接未指定地址或链路本地地址");
  return url.href;
}
export function connectorAccess(store: CoreStore, botId: string, args: Record<string, unknown>) {
  const connectorId = text(args.connectorId, 100);
  const row = store.get("SELECT c.*,g.tools_json allowed_tools FROM personal_connectors c JOIN personal_connector_grants g ON g.connector_id=c.id WHERE c.id=? AND g.bot_id=? AND c.enabled=1 AND c.workspace_id=? AND c.owner_user_id=?", connectorId, botId, store.workspace, store.owner);
  if (!row) throw new Error("连接器未启用或未授权给当前 Agent");
  if (row.provider === "gmail" && !row.credential) throw new Error("Gmail 授权已失效，请重新连接");
  if (args.action === "connector.call") {
    const name = text(args.tool, 200);
    if (!(JSON.parse(String(row.allowed_tools)) as string[]).includes(name) || !(JSON.parse(String(row.tools_json)) as ConnectorTool[]).some((tool) => tool.name === name)) throw new Error("该 Agent 未获准使用这个工具");
    if (!object(args.parameters ?? {}) || JSON.stringify(args.parameters ?? {}).length > 32_000) throw new Error("连接器参数无效或过大");
    if (args.connectorVersion !== row.version) throw new Error("连接器配置或工具目录已变化，请重新读取工具目录");
    if (row.provider === "gmail") validateGmailArguments(name, (args.parameters ?? {}) as Record<string, unknown>);
  }
  return row;
}

/** Reuses the repository's bounded HTTP/SSE client; credentials stay in the Core vault. */
export class ConnectorModule {
  private readonly active = new Map<AbortController, { connectorId: string; taskId?: string }>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  readonly oauth: ConnectorOAuth;
  constructor(readonly store: CoreStore, readonly changed: () => void, gmail?: GmailConfiguration) { this.oauth = new ConnectorOAuth(store, changed, gmail ? new GmailProvider(gmail) : undefined); }
  catalog() { return [{ id: "gmail" as const, name: "Gmail", available: !!this.oauth.provider }]; }
  private row(connectorId: string) {
    const row = this.store.get("SELECT * FROM personal_connectors WHERE id=? AND workspace_id=? AND owner_user_id=?", connectorId, this.store.workspace, this.store.owner);
    if (!row) throw new Error("连接器不存在");
    return row;
  }
  list(): ConnectorView[] {
    return this.store.all("SELECT * FROM personal_connectors WHERE workspace_id=? AND owner_user_id=? ORDER BY created_at,id", this.store.workspace, this.store.owner).map((row) => ({
      id: String(row.id), provider: row.provider as "mcp" | "gmail", account: row.account as string | null, name: String(row.name), url: String(row.url), transport: row.transport as "http" | "sse", enabled: row.enabled === 1, version: Number(row.version), hasToken: !!row.credential,
      tools: JSON.parse(String(row.tools_json)), checkedAt: row.checked_at as number | null, error: row.error as string | null,
      grants: this.store.all("SELECT bot_id,tools_json FROM personal_connector_grants WHERE connector_id=?", row.id).map((grant) => ({ botId: String(grant.bot_id), tools: JSON.parse(String(grant.tools_json)) as string[] })),
    }));
  }
  save(data: Record<string, unknown>) {
    const previous = data.id ? this.row(text(data.id, 100)) : undefined;
    if (previous && previous.provider !== "mcp") throw new Error("Gmail 连接请使用 Google 重新授权");
    if (previous && previous.version !== data.version) throw new Error("连接器已被修改，请刷新后重试");
    const name = text(data.name, 80), url = connectorUrl(data.url), transport = data.transport === "sse" ? "sse" : "http";
    if (data.token !== undefined && (typeof data.token !== "string" || data.token.length > 4096 || /[\r\n\0]/.test(data.token))) throw new Error("令牌格式无效");
    const token = typeof data.token === "string" ? data.token.trim() : "";
    const sameTarget = previous?.url === url && previous.transport === transport;
    const credential = token ? this.store.encrypt(token) : data.clearToken === true ? null : sameTarget ? previous?.credential ?? null : null;
    const connectorId = previous ? String(previous.id) : id();
    this.abortConnector(connectorId);
    this.store.transaction(() => {
      if (previous) {
        this.store.run("UPDATE personal_connectors SET name=?,url=?,transport=?,credential=?,enabled=?,version=version+1,tools_json='[]',checked_at=NULL,error=NULL WHERE id=?", name, url, transport, credential, data.enabled === false ? 0 : 1, connectorId);
        // A changed destination cannot inherit authorization for identically named tools.
        if (!sameTarget) this.store.run("DELETE FROM personal_connector_grants WHERE connector_id=?", connectorId);
      } else this.store.insert("personal_connectors", { id: connectorId, ...this.store.scope(), name, url, transport, credential, enabled: data.enabled === false ? 0 : 1, created_at: now() });
      this.store.audit("connector.save", "connector", connectorId, {});
    });
    this.changed(); return { id: connectorId };
  }
  grant(data: Record<string, unknown>) {
    const row = this.row(text(data.id, 100)), botId = text(data.botId, 100);
    if (row.version !== data.version) throw new Error("连接器已变化，请刷新后授权");
    if (!this.store.get("SELECT id FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", botId, this.store.workspace, this.store.owner)) throw new Error("Agent 不存在");
    const known = new Set((JSON.parse(String(row.tools_json)) as ConnectorTool[]).map((tool) => tool.name));
    if (!Array.isArray(data.tools) || data.tools.some((tool) => typeof tool !== "string" || !known.has(tool))) throw new Error("请选择工具目录中的工具");
    const tools = [...new Set(data.tools as string[])];
    this.abortConnector(String(row.id));
    this.store.transaction(() => {
      this.store.run("INSERT INTO personal_connector_grants VALUES(?,?,?) ON CONFLICT(connector_id,bot_id) DO UPDATE SET tools_json=excluded.tools_json", row.id, botId, JSON.stringify(tools));
      const policy = this.store.get("SELECT * FROM bot_policies WHERE bot_id=?", botId)!;
      const parsed = JSON.parse(String(policy.policy_json));
      if (tools.length) parsed.tools = [...new Set([...(parsed.tools ?? []), "connector.list", "connector.tools", "connector.call"])];
      this.store.run("UPDATE bot_policies SET policy_json=?,version=version+1 WHERE bot_id=?", JSON.stringify(parsed), botId);
      this.store.run("UPDATE personal_connectors SET version=version+1 WHERE id=?", row.id);
      this.store.audit("connector.grant", "connector", String(row.id), { botId, tools });
    });
    this.changed(); return { ok: true };
  }
  toggle(data: Record<string, unknown>) {
    const row = this.row(text(data.id, 100));
    if (row.version !== data.version || typeof data.enabled !== "boolean") throw new Error("连接器已变化，请刷新后重试");
    this.abortConnector(String(row.id));
    this.store.run("UPDATE personal_connectors SET enabled=?,version=version+1 WHERE id=?", data.enabled ? 1 : 0, row.id);
    this.changed(); return { ok: true };
  }
  async remove(data: Record<string, unknown>) {
    const row = this.row(text(data.id, 100));
    if (row.version !== data.version) throw new Error("连接器已变化，请刷新后重试");
    this.abortConnector(String(row.id)); this.store.run("DELETE FROM personal_connectors WHERE id=?", row.id); this.changed();
    return row.provider === "gmail" ? this.oauth.disconnect(row) : { ok: true };
  }
  private async session<T>(row: Row, taskId: string | undefined, operation: (client: RemoteMcpClient, signal: AbortSignal, redact: (value: string) => string) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("连接器正在关闭");
    const controller = new AbortController(); this.active.set(controller, { connectorId: String(row.id), taskId });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(taskId ? 60_000 : 15_000)]);
    const token = row.credential ? this.store.decrypt(String(row.credential)) : "";
    const redact = (value: string) => token ? value.split(token).join("[redacted]") : value;
    const client = new RemoteMcpClient({ type: row.transport as "http" | "sse", url: String(row.url), headers: token ? { Authorization: `Bearer ${token}` } : {} }, {
      fetch: async (input, init) => {
        const destination = new URL(input instanceof Request ? input.url : String(input));
        if (destination.origin !== new URL(String(row.url)).origin) throw new Error("连接器不能转发凭据到其他站点");
        return fetch(input, { ...init, redirect: "error" });
      },
    });
    const pending = (async () => { try { await client.initialize("NexBot", signal); return await operation(client, signal, redact); } finally { await client.close(); this.active.delete(controller); } })();
    this.pending.add(pending);
    try { return await pending; } finally { this.pending.delete(pending); }
  }
  async test(data: Record<string, unknown>, authorize: () => Promise<void> = async () => {}) {
    const row = this.row(text(data.id, 100));
    if (row.version !== data.version) throw new Error("连接器已变化，请刷新后测试");
    if (row.provider === "gmail") {
      try {
        await this.oauth.withCredential(row, undefined, authorize, async (provider, credential, signal) => {
          if (await provider.account(credential, signal) !== row.account) throw new Error("邮箱身份已变化，请重新连接");
        });
        const updated = this.store.run("UPDATE personal_connectors SET checked_at=?,error=NULL,version=version+1 WHERE id=? AND version=?", now(), row.id, row.version);
        if (!updated.changes) throw new Error("连接器已变化，请重新测试");
        this.changed(); return { ok: true, count: this.oauth.provider!.tools.length };
      } catch (error) {
        await authorize();
        const message = error instanceof GmailProviderError ? error.message : "Gmail 连接失败或配置已变化，请重试";
        this.store.run("UPDATE personal_connectors SET error=? WHERE id=? AND version=?", message, row.id, row.version);
        this.changed(); throw new Error(message);
      }
    }
    try {
      const tools = await this.session(row, undefined, async (client, signal, redact) => {
        const tools: ConnectorTool[] = []; let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const result = await client.request("tools/list", cursor ? { cursor } : {}, signal);
          if (!object(result) || !Array.isArray(result.tools)) throw new Error("工具目录无效");
          for (const entry of result.tools) {
            if (!object(entry) || typeof entry.name !== "string" || !/^[\w.:-]{1,200}$/.test(entry.name) || !object(entry.inputSchema) || entry.inputSchema.type !== "object") throw new Error("工具目录无效");
            if (tools.some((tool) => tool.name === entry.name)) throw new Error("工具名称重复");
            const annotations = object(entry.annotations) ? Object.fromEntries(["readOnlyHint", "destructiveHint"].filter((key) => typeof (entry.annotations as Record<string, unknown>)[key] === "boolean").map((key) => [key, (entry.annotations as Record<string, unknown>)[key]])) : undefined;
            tools.push({ name: redact(entry.name), description: redact(typeof entry.description === "string" ? entry.description.slice(0, 2000) : ""), inputSchema: redactValue(entry.inputSchema, redact) as Record<string, unknown>, ...(annotations ? { annotations } : {}) });
          }
          if (tools.length > 200 || JSON.stringify(tools).length > 256_000) throw new Error("工具目录过大");
          if (!result.nextCursor) return tools;
          if (typeof result.nextCursor !== "string" || cursor === result.nextCursor) throw new Error("工具目录分页无效");
          cursor = result.nextCursor;
        }
        throw new Error("工具目录分页过多");
      });
      await authorize();
      if (this.row(String(row.id)).version !== row.version) throw new Error("连接器已变化，请重新测试");
      this.store.run("UPDATE personal_connectors SET tools_json=?,checked_at=?,error=NULL,version=version+1 WHERE id=?", JSON.stringify(tools), now(), row.id);
      this.changed(); return { ok: true, count: tools.length };
    } catch (error) {
      await authorize();
      const message = error instanceof McpHttpError && error.status ? `连接失败（HTTP ${error.status}），请检查地址与认证信息。` : "连接失败，请检查服务地址、认证信息及 MCP 工具目录。";
      this.store.run("UPDATE personal_connectors SET error=? WHERE id=? AND version=?", message, row.id, row.version);
      this.changed(); throw new Error(message);
    }
  }
  directory(botId: string) {
    return this.list().filter((item) => item.enabled && (item.provider === "mcp" || item.hasToken) && item.grants.some((grant) => grant.botId === botId && grant.tools.length)).map((item) => ({ id: item.id, name: item.account ? `${item.name} (${item.account})` : item.name, version: item.version, tools: item.grants.find((grant) => grant.botId === botId)!.tools }));
  }
  async execute(call: Row, args: Record<string, unknown>, authorize: () => Promise<void>) {
    if (args.action === "connector.list") return { connectors: this.directory(String(call.bot_id)) };
    const row = connectorAccess(this.store, String(call.bot_id), args);
    const tools = JSON.parse(String(row.tools_json)) as ConnectorTool[], allowed = JSON.parse(String(row.allowed_tools)) as string[];
    if (args.action === "connector.tools") return { connectorId: row.id, connectorVersion: row.version, tools: tools.filter((tool) => allowed.includes(tool.name)) };
    if (row.provider === "gmail") {
      const result = await this.oauth.withCredential(row, String(call.task_id), async () => { await authorize(); connectorAccess(this.store, String(call.bot_id), args); }, (provider, credential, signal) => provider.call(String(args.tool), (args.parameters ?? {}) as Record<string, unknown>, credential, signal));
      return { text: JSON.stringify(result), structured: result, isError: false };
    }
    let dispatched = false;
    try {
      return await this.session(row, String(call.task_id), async (client, signal, redact) => {
        await authorize();
        connectorAccess(this.store, String(call.bot_id), args);
        if (signal.aborted) throw new Error("已取消");
        dispatched = true;
        const raw = await client.request("tools/call", { name: args.tool, arguments: args.parameters ?? {} }, signal);
        if (!object(raw) || !Array.isArray(raw.content)) throw new Error("工具结果无效");
        await authorize();
        connectorAccess(this.store, String(call.bot_id), args);
        const resultText = raw.content.filter((item) => object(item) && item.type === "text" && typeof item.text === "string").map((item) => redact(String(item.text))).join("\n");
        const images = raw.content.filter((item) => object(item) && item.type === "image" && ["image/png", "image/jpeg", "image/webp"].includes(String(item.mimeType)) && typeof item.data === "string").slice(0, 2).map((item) => ({ type: "image", data: item.data, mimeType: item.mimeType }));
        return { text: resultText, images, ...(raw.structuredContent !== undefined ? { structured: redactValue(raw.structuredContent, redact) } : {}), isError: raw.isError === true };
      });
    } catch {
      if (dispatched) {
        this.store.run("UPDATE tool_calls SET status='unknown' WHERE id=? AND status='executing'", call.id);
        throw new Error("连接器调用中断或授权已变化，结果未知；请核实外部服务，不会自动重放。");
      }
      throw new Error("连接器连接失败或授权已变化，未发送工具调用。");
    }
  }
  cancelTask(taskId: string) { this.oauth.cancelTask(taskId); for (const [controller, active] of this.active) if (active.taskId === taskId) controller.abort(); }
  private abortConnector(connectorId: string) { this.oauth.abortConnector(connectorId); for (const [controller, active] of this.active) if (active.connectorId === connectorId) controller.abort(); }
  async close() { this.closed = true; for (const controller of this.active.keys()) controller.abort(); await this.oauth.close(); await Promise.allSettled(this.pending); }
}
