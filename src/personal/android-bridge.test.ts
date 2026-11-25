import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installAndroidBridge } from "./android-bridge";

let host: Record<string, any>;
let connectNative: () => void;
let native: Record<"request" | "action" | "subscribe" | "unsubscribe" | "streamOpen" | "streamText" | "streamBinary" | "streamClose", ReturnType<typeof vi.fn>>;
beforeEach(() => {
  native = { request: vi.fn(), action: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), streamOpen: vi.fn(), streamText: vi.fn(), streamBinary: vi.fn(), streamClose: vi.fn() };
  const events = new EventTarget();
  host = { addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) };
  vi.stubGlobal("window", host);
  vi.stubGlobal("location", { origin: "https://fixture.nexbot.invalid" });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  vi.stubGlobal("navigator", {});
  installAndroidBridge();
  const port = { postMessage: (text: string) => { const { method, args } = JSON.parse(text); (native[method as keyof typeof native] as (...args: string[]) => unknown)(...args); } };
  const handshake = new MessageEvent('message', { data: 'nex-workspace-port' });
  Object.defineProperty(handshake, 'ports', { value: [port] });
  connectNative = () => host.dispatchEvent(handshake);
});
it('ignores a child-frame port before the native handshake and queues requests', async () => {
  const forged = vi.fn();
  const event = new MessageEvent('message', { data: 'nex-workspace-port' });
  Object.defineProperties(event, { source: { value: {} }, ports: { value: [{ postMessage: forged }] } });
  host.dispatchEvent(event);
  const result = host.nex.saveFile('example.txt', 'fixture');
  expect(native.action).not.toHaveBeenCalled();
  connectNative();
  const id = native.action.mock.calls[0][0]; host.__nexReply(id, { value: true }); await result;
  expect(forged).not.toHaveBeenCalled();
  expect(host.NexAndroid).toBeUndefined();
});
afterEach(() => vi.unstubAllGlobals());

it("sends settings JSON to the native transport and preserves conflict errors", async () => {
  connectNative();
  const result = host.fetch("/api/config", { method: "POST", body: '{"model":"test"}' });
  const [id, path, method, body] = native.request.mock.calls[0];
  expect([path, method, body]).toEqual(["/api/config", "POST", '{"model":"test"}']);
  host.__nexReply(id, { status: 409, body: '{"error":"版本冲突"}' });
  const response = await result;
  expect(response.ok).toBe(false);
  expect(await response.json()).toEqual({ error: "版本冲突" });
});
it("relays a NexAgent image as bytes through the Android bridge", async () => {
  connectNative();
  const path = "/api/cli-agents/images?key=device%3Aclaude%3Asession";
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const pending = host.fetch(path, { method: "POST", body: blob });
  await vi.waitFor(() => expect(native.request).toHaveBeenCalledTimes(1));
  const [id, route, method, body] = native.request.mock.calls[0];
  expect([route, method, body]).toEqual([path, "POST", "iVBORw=="]);
  host.__nexReply(id, { status: 200, body: '{"path":"/api/cli-agents/images/12345678-0000-4000-8000-000000000000"}' });
  expect((await pending).ok).toBe(true);
  await expect(host.fetch("/api/config", { method: "POST", body: blob })).rejects.toThrow();
});

it("keeps authenticated preview bytes intact for the local cache", async () => {
  connectNative();
  const path = "/api/attachments/image-1?preview=1";
  const pending = host.fetch(path);
  const [id, route, method] = native.request.mock.calls[0];
  expect([route, method]).toEqual([path, "GET"]);
  host.__nexReply(id, { status: 200, binary: "iVBORw==", mime: "image/png" });
  const response = await pending;
  expect(response.headers.get("content-type")).toBe("image/png");
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([137, 80, 78, 71]);
});

it("does not forward off-origin requests or arbitrary bodies", async () => {
  connectNative();
  await expect(host.fetch("https://elsewhere.test/api/state")).rejects.toThrow();
  await expect(host.fetch("/api/config", { method: "POST", body: new FormData() })).rejects.toThrow();
  expect(native.request).not.toHaveBeenCalled();
});
it("preserves remembered approval and scoped revocation through native transport", async () => {
  connectNative();
  for (const [path, payload] of [
    ["/api/approvals", { id: "a1", hash: "fixture-hash", allow: true, remember: true }],
    ["/api/approvals/revoke", { id: "r1", botId: "b1" }],
  ] as const) {
    const result = host.fetch(path, { method: "POST", body: JSON.stringify(payload) });
    const [id, actualPath, method, body] = native.request.mock.calls.at(-1)!;
    expect([actualPath, method, JSON.parse(body)]).toEqual([path, "POST", payload]);
    host.__nexReply(id, { status: 200, body: '{"ok":true}' });
    expect(await (await result).json()).toEqual({ ok: true });
  }
});
it("dispatches SSE changes and unsubscribes on close", () => {
  connectNative();
  const stream = new host.EventSource("/api/events");
  const listener = vi.fn(); stream.addEventListener("change", listener);
  const id = native.subscribe.mock.calls[0][0];
  host.__nexEvent(id, "change", '{"cursor":9}');
  expect(listener.mock.calls[0][0].data).toBe('{"cursor":9}');
  stream.close();
  host.__nexEvent(id, "change", "{}");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(native.unsubscribe).toHaveBeenCalledWith(id);
});
it("delegates export and clipboard without exposing a session token", async () => {
  connectNative();
  const result = host.nex.saveFile("对话.md", "# 对话");
  const [id, action, value] = native.action.mock.calls[0];
  expect(action).toBe("save"); expect(JSON.parse(value)).toEqual({ name: "对话.md", content: "# 对话" });
  host.__nexReply(id, { value: true }); await result;
  expect(host.nex.token).toBeUndefined();
  expect(await host.nex.deviceState()).toEqual({ available: false });
});

it("opens Google authorization through the native browser and preserves failure for retry", async () => {
  connectNative();
  const url = "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic";
  const pending = host.nex.openExternal(url);
  const [id, action, value] = native.action.mock.calls[0];
  expect([action, value]).toEqual(["external", url]);
  const failure = expect(pending).rejects.toThrow("无法打开浏览器，请重试");
  host.__nexReply(id, { error: "无法打开浏览器，请重试" });
  await failure;
  const retry = host.nex.openExternal(url);
  host.__nexReply(native.action.mock.calls[1][0], { value: true });
  await retry;
});

it("routes Gmail OAuth over native authenticated transport without browser cookies", async () => {
  connectNative();
  for (const [path, method, body] of [
    ["/api/connectors/oauth/start", "POST", '{"provider":"gmail"}'],
    ["/api/connectors/oauth/status?id=synthetic", "GET", ""],
    ["/api/connectors/oauth/cancel", "POST", '{"id":"synthetic"}'],
  ]) {
    const pending = host.fetch(path, { method, ...(body ? { body } : {}) });
    const [id, route, verb, content] = native.request.mock.calls.at(-1)!;
    expect([route, verb, content]).toEqual([path, method, body]);
    host.__nexReply(id, { status: 200, body: '{"ok":true}' });
    expect((await pending).ok).toBe(true);
  }
});

interface Handlers { onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: { code: number }) => void) | null }
it("relays the Agent stream over the native socket: text, binary as base64, close codes", () => {
  connectNative();
  const socket = host.nex.openCliSocket() as Handlers & { send(data: string | Uint8Array): void; close(code?: number): void; readyState: number; binaryType: string };
  const id = native.streamOpen.mock.calls[0][0];
  expect(socket.binaryType).toBe("arraybuffer");
  expect(() => socket.send("{}")).toThrow(); // not open yet, like a WebSocket
  const opened = vi.fn(), received: unknown[] = [], closed = vi.fn();
  socket.onopen = opened; socket.onmessage = (event) => received.push(event.data); socket.onclose = closed;
  host.__nexStream(id, "open", "");
  expect([opened.mock.calls.length, socket.readyState]).toEqual([1, 1]);

  host.__nexStream(id, "text", '{"type":"list"}');
  host.__nexStream(id, "binary", "AQAAAAdoaQ==");
  expect(received[0]).toBe('{"type":"list"}');
  expect(received[1]).toBeInstanceOf(ArrayBuffer);
  expect([...new Uint8Array(received[1] as ArrayBuffer)]).toEqual([1, 0, 0, 0, 7, 104, 105]);

  socket.send('{"type":"ping"}');
  socket.send(new Uint8Array([2, 0, 0, 0, 7, 104, 105]));
  expect(native.streamText).toHaveBeenCalledWith(id, '{"type":"ping"}');
  expect(native.streamBinary).toHaveBeenCalledWith(id, "AgAAAAdoaQ==");

  host.__nexStream(id, "close", "4401");
  expect(closed).toHaveBeenCalledWith({ code: 4401 });
  expect(socket.readyState).toBe(3);
  host.__nexStream(id, "text", "late");
  expect(received).toHaveLength(2);
  expect(native.streamClose).not.toHaveBeenCalled();
});

it("keeps sockets apart, closes one silently and survives large binary frames", () => {
  connectNative();
  const first = host.nex.openCliSocket(), second = host.nex.openCliSocket();
  const [a, b] = native.streamOpen.mock.calls.map((call) => call[0]);
  expect(a).not.toBe(b);
  const heard: string[] = [];
  first.onmessage = () => heard.push("first"); second.onmessage = () => heard.push("second");
  first.onclose = () => heard.push("first closed");
  host.__nexStream(a, "open", ""); host.__nexStream(b, "open", "");
  host.__nexStream(b, "text", "x");
  first.close();
  expect(native.streamClose).toHaveBeenCalledWith(a, "1000");
  host.__nexStream(a, "text", "late"); host.__nexStream(a, "close", "1006");
  expect(heard).toEqual(["second"]); // a page-side close is silent
  first.close(); // closing twice sends nothing more
  expect(native.streamClose).toHaveBeenCalledTimes(1);
  const big = new Uint8Array(200_000).map((_, index) => index % 251);
  second.send(big);
  const sent = atob(native.streamBinary.mock.calls[0][1]);
  expect(sent).toHaveLength(big.length);
  expect(sent.charCodeAt(150_000)).toBe(150_000 % 251);
});

it("queues the stream open until the native port is connected and only the Android entry gets the hook", () => {
  const socket = host.nex.openCliSocket();
  expect(native.streamOpen).not.toHaveBeenCalled();
  connectNative();
  expect(native.streamOpen).toHaveBeenCalledTimes(1);
  host.__nexStream(native.streamOpen.mock.calls[0][0], "open", "");
  expect(socket.readyState).toBe(1);
  expect(host.nex.platform).toBe("android");
  expect(host.nex.token).toBeUndefined();
});
