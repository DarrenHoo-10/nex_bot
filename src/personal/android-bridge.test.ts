import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installAndroidBridge } from "./android-bridge";

let host: Record<string, any>;
let native: { request: ReturnType<typeof vi.fn>; action: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
beforeEach(() => {
  native = { request: vi.fn(), action: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() };
  host = { NexAndroid: native };
  vi.stubGlobal("window", host);
  vi.stubGlobal("location", { origin: "https://fixture.nexbot.invalid" });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  vi.stubGlobal("navigator", {});
  installAndroidBridge();
});
afterEach(() => vi.unstubAllGlobals());

it("sends settings JSON to the native transport and preserves conflict errors", async () => {
  const result = host.fetch("/api/config", { method: "POST", body: '{"model":"test"}' });
  const [id, path, method, body] = native.request.mock.calls[0];
  expect([path, method, body]).toEqual(["/api/config", "POST", '{"model":"test"}']);
  host.__nexReply(id, { status: 409, body: '{"error":"版本冲突"}' });
  const response = await result;
  expect(response.ok).toBe(false);
  expect(await response.json()).toEqual({ error: "版本冲突" });
});
it("does not forward off-origin requests or arbitrary bodies", async () => {
  await expect(host.fetch("https://elsewhere.test/api/state")).rejects.toThrow();
  await expect(host.fetch("/api/config", { method: "POST", body: new FormData() })).rejects.toThrow();
  expect(native.request).not.toHaveBeenCalled();
});
it("dispatches SSE changes and unsubscribes on close", () => {
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
  const result = host.nex.saveFile("对话.md", "# 对话");
  const [id, action, value] = native.action.mock.calls[0];
  expect(action).toBe("save"); expect(JSON.parse(value)).toEqual({ name: "对话.md", content: "# 对话" });
  host.__nexReply(id, { value: true }); await result;
  expect(host.nex.token).toBeUndefined();
  expect(await host.nex.deviceState()).toEqual({ available: false });
});

it("opens Google authorization through the native browser and preserves failure for retry", async () => {
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
