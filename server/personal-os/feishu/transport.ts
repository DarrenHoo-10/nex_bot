import type { Brand } from "./api.ts";

/** SDK 的这些类型未导出，这里按类型定义原样复制。 */
export interface RegisterAppOptions {
  source?: string;
  signal?: AbortSignal;
  appPreset?: { name?: string; desc?: string };
  addons?: { scopes?: { tenant?: string[]; user?: string[] }; events?: { items?: { tenant?: string[]; user?: string[] } }; callbacks?: { items?: string[] } };
  appId?: string;
  createOnly?: boolean;
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  onStatusChange?: (info: { status: string; interval?: number }) => void;
}
export interface RegisterAppResult { client_id: string; client_secret: string; user_info?: { open_id?: string; tenant_brand?: string } }
export type RegisterAppFn = (options: RegisterAppOptions) => Promise<RegisterAppResult>;

/** 官方 SDK 的扫码注册。动态加载，避免未使用飞书时载入 SDK。 */
export const sdkRegisterApp: RegisterAppFn = async (options) => {
  const Lark = await import("@larksuiteoapi/node-sdk");
  return Lark.registerApp(options as Parameters<typeof Lark.registerApp>[0]);
};

export interface FeishuTransport {
  close(): Promise<void>;
}
export interface TransportHandlers {
  /** Must not block: the SDK acks the event when the handler returns. */
  onMessage(event: unknown): void;
  onCardAction(event: unknown): Promise<unknown>;
}
export type TransportFactory = (app: { appId: string; appSecret: string; brand: Brand }, handlers: TransportHandlers) => Promise<FeishuTransport>;

/** 真实传输：官方 SDK 长连接（WSClient）。SDK 自带断线重连；进程内只持有一个连接。 */
export const wsTransportFactory: TransportFactory = async (app, handlers) => {
  const Lark = await import("@larksuiteoapi/node-sdk");
  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data: unknown) => { handlers.onMessage(data); },
    "card.action.trigger": (data: unknown) => handlers.onCardAction(data),
  } as never);
  const client = new Lark.WSClient({ appId: app.appId, appSecret: app.appSecret, domain: app.brand === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu, loggerLevel: Lark.LoggerLevel.error });
  await client.start({ eventDispatcher: dispatcher });
  return { close: async () => { client.close(); } };
};
