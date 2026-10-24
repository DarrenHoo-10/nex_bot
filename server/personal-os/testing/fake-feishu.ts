import { createServer, type Server } from "node:http";

export interface FakeTransportEntry { handlers: { onMessage(event: unknown): void; onCardAction(event: unknown): Promise<unknown> } }

export function messageEvent(input: { messageId: string; chatId: string; chatType?: "p2p" | "group"; senderOpenId: string; senderType?: string; messageType?: string; content: string; mentions?: unknown[] }) {
  return {
    schema: "2.0",
    header: { event_id: `evt_${input.messageId}`, event_type: "im.message.receive_v1", create_time: String(Date.now()), tenant_key: "fake", app_id: "cli_fake" },
    event: {
      sender: { sender_id: { union_id: "un_x", user_id: "u_x", open_id: input.senderOpenId }, sender_type: input.senderType ?? "user", tenant_key: "fake" },
      message: { message_id: input.messageId, root_id: "", parent_id: "", create_time: String(Date.now()), chat_id: input.chatId, chat_type: input.chatType ?? "p2p", message_type: input.messageType ?? "text", content: input.content, ...(input.mentions ? { mentions: input.mentions } : {}) },
    },
  };
}

export function cardActionEvent(input: { openId: string; value: Record<string, unknown> }) {
  return {
    schema: "2.0",
    header: { event_id: `evt_card_${Math.random().toString(36).slice(2)}`, event_type: "card.action.trigger", create_time: String(Date.now()), tenant_key: "fake", app_id: "cli_fake" },
    event: { operator: { tenant_key: "fake", user_id: "u_x", open_id: input.openId }, token: "fake", host: "", action: { tag: "button", value: input.value } },
  };
}

export interface FakeFeishu {
  origin: string;
  close(): Promise<void>;
  registerApp(options: { onQRCodeReady(info: { url: string; expireIn: number }): void; signal?: AbortSignal }): Promise<{ client_id: string; client_secret: string; user_info?: { open_id?: string; tenant_brand?: string } }>;
  createTransport(app: { appId: string }, handlers: FakeTransportEntry["handlers"]): Promise<{ close(): Promise<void> }>;
  deliver(appId: string, event: unknown): void;
  card(appId: string, event: unknown): Promise<unknown>;
  sent: Array<{ path: string; body: Record<string, unknown> }>;
  setOnlineInstances(count: number): void;
  failRegister(message: string): void;
}

/** 假飞书：OpenAPI 子集 + 可注入的长连接传输。只监听 127.0.0.1。 */
export async function startFakeFeishu(): Promise<FakeFeishu> {
  const sent: FakeFeishu["sent"] = [];
  const transports = new Map<string, FakeTransportEntry>();
  let online = 0, tokenRequests = 0;
  let registerFailure = "";
  const server: Server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? "/", "http://fixture");
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) as Record<string, unknown> : {};
    const json = (value: unknown) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") { tokenRequests += 1; json({ code: 0, msg: "ok", tenant_access_token: `tenant-${tokenRequests}`, expire: 7200 }); return; }
    if (url.pathname === "/open-apis/event/v1/connection") { json({ code: 0, msg: "ok", online_instance_cnt: online }); return; }
    if (url.pathname === "/open-apis/bot/v3/info") { json({ code: 0, msg: "ok", bot: { open_id: "ou_fake_bot", activate_status: 2 } }); return; }
    if (url.pathname === "/open-apis/im/v1/messages" && url.searchParams.get("receive_id_type") === "chat_id") {
      sent.push({ path: "send", body: payload });
      json({ code: 0, msg: "success", data: { message_id: `om_out_${sent.length}` } });
      return;
    }
    if (/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(url.pathname)) {
      sent.push({ path: "reply", body: payload });
      json({ code: 0, msg: "success", data: { message_id: `om_out_${sent.length}` } });
      return;
    }
    json({ code: 99991672, msg: "fake fixture: endpoint not implemented" });
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${(address as { port: number }).port}`;
  return {
    origin, sent,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    async registerApp(options) {
      options.onQRCodeReady({ url: `${origin}/fake-qr?scan=1`, expireIn: 300 });
      if (registerFailure) throw new Error(registerFailure);
      return { client_id: "cli_fake", client_secret: "fake-secret", user_info: { open_id: "ou_owner", tenant_brand: "feishu" } };
    },
    async createTransport(app, handlers) {
      transports.set(app.appId, { handlers });
      return { close: async () => { transports.delete(app.appId); } };
    },
    deliver(appId, event) { transports.get(appId)?.handlers.onMessage(event); },
    card(appId, event) { return transports.get(appId)?.handlers.onCardAction(event) ?? Promise.resolve(undefined); },
    setOnlineInstances(count: number) { online = count; },
    failRegister(message: string) { registerFailure = message; },
  };
}
