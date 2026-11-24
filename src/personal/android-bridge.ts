import type { SocketLike } from "./cli-agents/stream";

interface NativeWorkspace {
  request(id: string, path: string, method: string, body: string): void;
  action(id: string, action: string, value: string): void;
  subscribe(id: string): void;
  unsubscribe(id: string): void;
  /** Agent mode socket relay: the native side owns the WebSocket and the bearer. */
  streamOpen(id: string): void;
  streamText(id: string, text: string): void;
  streamBinary(id: string, base64: string): void;
  streamClose(id: string, code: string): void;
}
type Reply = { status?: number; body?: string; binary?: string; mime?: string; error?: string; value?: unknown };
type NativeWindow = Window & {
  nex?: unknown;
  __nexReply?: (id: string, reply: Reply) => void;
  __nexEvent?: (id: string, event: string, data: string) => void;
  __nexStream?: (id: string, type: string, data: string) => void;
};

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}
function fromBase64(text: string): ArrayBuffer {
  const raw = atob(text), bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

/** Only the APK entry installs this adapter. Credentials stay in the native store. */
export function installAndroidBridge() {
  const host = window as NativeWindow;
  // Android transfers this port to the main frame at the exact bundled origin.
  // No addJavascriptInterface object is exposed to arbitrary child frames.
  let port: MessagePort | undefined;
  const queued: string[] = [];
  const send = (method: string, args: string[]) => {
    const message = JSON.stringify({ method, args });
    if (port) port.postMessage(message); else queued.push(message);
  };
  window.addEventListener('message', event => {
    if (port || event.source !== null || event.data !== 'nex-workspace-port' || event.ports.length !== 1) return;
    port = event.ports[0];
    for (const message of queued.splice(0)) port.postMessage(message);
  });
  const native: NativeWorkspace = {
    request: (...args) => send('request', args), action: (...args) => send('action', args),
    subscribe: (...args) => send('subscribe', args), unsubscribe: (...args) => send('unsubscribe', args),
    streamOpen: (...args) => send('streamOpen', args), streamText: (...args) => send('streamText', args),
    streamBinary: (...args) => send('streamBinary', args), streamClose: (...args) => send('streamClose', args),
  };
  let sequence = 0;
  const pending = new Map<string, { resolve(value: Reply): void; reject(error: Error): void }>();
  const streams = new Map<string, EventTarget>();
  function call(invoke: (id: string) => void): Promise<Reply> {
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { invoke(id); } catch (error) { pending.delete(id); reject(error); }
    });
  }
  host.__nexReply = (id, reply) => {
    const request = pending.get(id); if (!request) return;
    pending.delete(id);
    if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply);
  };
  const action = async (name: string, value = "") => (await call((id) => native.action(id, name, value))).value;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) throw new Error("不支持的请求地址");
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = init?.body ?? (input instanceof Request && method !== "GET" ? await input.text() : "");
    if (body && typeof body !== "string") throw new Error("不支持的请求格式");
    const reply = await call((id) => native.request(id, url.pathname + url.search, method, String(body ?? "")));
    if (reply.binary && reply.mime) return new Response(fromBase64(reply.binary), { status: reply.status ?? 200, headers: { "Content-Type": reply.mime } });
    return new Response(reply.body ?? "", { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  class NativeEvents extends EventTarget {
    readonly id = String(++sequence);
    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;
    onerror: ((event: Event) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(url: string | URL) {
      super(); this.url = String(url);
      if (this.url !== "/api/events") throw new Error("不支持的事件地址");
      streams.set(this.id, this); native.subscribe(this.id);
    }
    close() { this.readyState = 2; streams.delete(this.id); native.unsubscribe(this.id); }
    dispatchEvent(event: Event) {
      if (event.type === "open") { this.readyState = 1; this.onopen?.(event); }
      if (event.type === "error") { this.readyState = 0; this.onerror?.(event); }
      if (event.type === "message") this.onmessage?.(event as MessageEvent);
      return super.dispatchEvent(event);
    }
  }
  host.__nexEvent = (id, event, data) => streams.get(id)?.dispatchEvent(new MessageEvent(event, { data }));
  Object.defineProperty(window, "EventSource", { value: NativeEvents });
  // The Agent mode WebSocket. The page cannot open one (no connect-src, no Authorization
  // header), so the app holds it: text frames cross as strings, binary frames as base64.
  // The app never reconnects; it reports the close code and CliStream reconnects. Like
  // WebSocket it takes `string | Uint8Array` and delivers binary as ArrayBuffer, but a
  // close() made by the page is silent (no close event) because CliStream detaches first.
  const sockets = new Map<string, NativeStreamSocket>();
  class NativeStreamSocket implements SocketLike {
    readonly id = String(++sequence);
    binaryType = "arraybuffer";
    readyState = 0;
    onopen: SocketLike["onopen"] = null;
    onmessage: SocketLike["onmessage"] = null;
    onclose: SocketLike["onclose"] = null;
    onerror: SocketLike["onerror"] = null;
    constructor() { sockets.set(this.id, this); native.streamOpen(this.id); }
    send(data: string | Uint8Array) {
      if (this.readyState !== 1) throw new Error("连接未就绪");
      if (typeof data === "string") native.streamText(this.id, data); else native.streamBinary(this.id, toBase64(data));
    }
    close(code = 1000) {
      if (this.readyState >= 2) return;
      this.readyState = 3; sockets.delete(this.id); native.streamClose(this.id, String(code));
    }
    receive(type: string, data: string) {
      if (this.readyState >= 2) return;
      if (type === "open") { this.readyState = 1; this.onopen?.({}); }
      else if (type === "text") this.onmessage?.({ data });
      else if (type === "binary") this.onmessage?.({ data: fromBase64(data) });
      else if (type === "close") { this.readyState = 3; sockets.delete(this.id); this.onclose?.({ code: Number(data) || 1006 }); }
    }
  }
  host.__nexStream = (id, type, data) => sockets.get(id)?.receive(type, data);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: (text: string) => action("copy", text) } });
  host.nex = {
    mode: "client", platform: "android",
    openExternal: (url: string) => action("external", url),
    forgetLogin: () => action("forget"), disconnect: () => action("forget"),
    deviceState: async () => ({ available: false }),
    saveFile: (name: string, content: string) => action("save", JSON.stringify({ name, content })),
    downloadAttachment: (url: string, name: string) => action("download", JSON.stringify({ url, name })),
    minimize: () => action("background"),
    workspaceReady: () => action("ready"),
    openCliSocket: (): SocketLike => new NativeStreamSocket(),
    updateState: () => action("updateState"),
    checkUpdate: () => action("checkUpdate"),
    installUpdate: () => action("installUpdate"),
    onUpdateState: (callback: (state: unknown) => void) => {
      const listener = (event: Event) => callback((event as CustomEvent).detail);
      window.addEventListener("nex-android-update", listener);
      return () => window.removeEventListener("nex-android-update", listener);
    },
  };
  document.documentElement.dataset.platform = "android";
}
