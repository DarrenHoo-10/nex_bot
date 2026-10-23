import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installAndroidBridge } from "./android-bridge";

let host: Record<string, any>;
let connectNative: () => void;
let native: { request: ReturnType<typeof vi.fn>; action: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
beforeEach(() => {
  native = { request: vi.fn(), action: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() };
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
