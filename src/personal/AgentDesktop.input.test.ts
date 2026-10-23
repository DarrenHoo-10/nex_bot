// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { State } from "./api";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), api: fixture.api }));
vi.mock("./auth", () => ({ useAccount: () => ({ status: {}, logout: vi.fn() }), AccountControls: () => null }));
import { AgentDesktop } from "./AgentDesktop";

let root: Root, container: HTMLDivElement;
const sync = { cursor: 1, privacyEpoch: 1, coreId: "fixture", bootId: "boot" };
let state: State;
const sources: FakeEventSource[] = [];
const observers: FakeResizeObserver[] = [];
class FakeEventSource {
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, (event: Event) => void>();
  constructor(public url: string) { sources.push(this); }
  addEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, listener); }
  close() {}
  emit(type: string, data: unknown) { this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) })); }
}
class FakeResizeObserver {
  constructor(public callback: ResizeObserverCallback) { observers.push(this); }
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(async () => {
  sources.length = 0;
  observers.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:preview";
  if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};
  state = {
    sync, bots: [{ id: "agent", name: "Fixture", instructions: "" }],
    conversations: [], approvals: [], memories: [], delegations: [], devices: [], tasks: [], onlineDevices: [],
    routines: [], occurrences: [], journal: [], dataDir: "", address: "", lanEnabled: false,
    node: { status: "", origin: "", root: "", exec: false, connected: false, unknownCalls: [] },
  };
  localStorage.clear();
  localStorage.setItem("nexbot.selectedAgent", "agent");
  fixture.api.mockReset().mockImplementation(async (route: string) => {
    if (route === "state") return state;
    if (route.startsWith("agents/messages")) return { sync, messages: [], streaming: [], hasMore: false };
    return {};
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(AgentDesktop)); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function composer() { return container.querySelector<HTMLTextAreaElement>(".composer textarea")!; }
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer(), text);
    composer().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function enter(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...options });
  await act(async () => { composer().dispatchEvent(event); });
  return event;
}

describe("Personal composer (Web, Electron and Android WebView)", () => {
  it("turns the send key into a stop key while the Agent works and the composer is empty", async () => {
    state = { ...state, connected: true, tasks: [{ id: "task-1", bot_id: "agent", status: "running", objective: "fixture" }] } as State;
    await act(async () => { sources[0].emit("change", sync); await new Promise((resolve) => setTimeout(resolve, 300)); });
    const stop = container.querySelector<HTMLButtonElement>('.composer .send[aria-label="停止任务"]');
    expect(stop).not.toBeNull();
    expect(container.querySelector('.task-status [aria-label="停止任务"]')).toBeNull();
    await act(async () => { stop!.click(); });
    expect(fixture.api).toHaveBeenCalledWith("cancel", { taskId: "task-1" });
    await type("补充一句");
    expect(container.querySelector('.composer .send[aria-label="停止任务"]')).toBeNull();
    expect(container.querySelector('.composer .send[aria-label="发送消息"]')).not.toBeNull();
  });
  it("expands the real model settings in the notice and keeps the conversation and draft", async () => {
    await type("保留的草稿");
    const toggle = container.querySelector<HTMLButtonElement>(".model-chooser-notice button")!;
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".model-chooser-notice [data-model-settings]")).not.toBeNull();
    expect(container.querySelector(".preferences-page")).toBeNull();
    expect(composer().value).toBe("保留的草稿");
    await act(async () => { toggle.click(); });
    expect(container.querySelector("[data-model-settings]")).toBeNull();
    expect(composer().value).toBe("保留的草稿");
  });

  it("does not submit an IME confirmation or Shift+Enter, and sends after the 150ms guard", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    await type("中文消息");
    await enter({ isComposing: true });
    await act(async () => { composer().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    vi.mocked(Date.now).mockReturnValue(2_149);
    await enter();
    expect(fixture.api.mock.calls.some(([route]) => route === "agents/input")).toBe(false);
    vi.mocked(Date.now).mockReturnValue(2_150);
    expect((await enter({ shiftKey: true })).defaultPrevented).toBe(false);
    expect(fixture.api.mock.calls.some(([route]) => route === "agents/input")).toBe(false);
    await enter();
    expect(fixture.api).toHaveBeenCalledWith("agents/input", expect.objectContaining({ text: "中文消息" }));
  });

  it("keeps history on screen when the event stream resets or drops", async () => {
    const history = [
      { id: "m1", role: "user", kind: "message", content: "更早的问题", created_at: 1, seq: 1 },
      { id: "m2", role: "assistant", kind: "message", content: "更早的回答", created_at: 2, seq: 2 },
    ];
    fixture.api.mockImplementation(async (route: string) => {
      if (route === "state") return state;
      if (route.startsWith("agents/messages")) return { sync, messages: history, streaming: [], hasMore: false };
      return {};
    });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(container.textContent).toContain("更早的问题");
    expect(container.textContent).toContain("更早的回答");
    await act(async () => {
      sources.at(-1)!.emit("change", { ...sync, reset: true });
      sources.at(-1)!.onerror?.(new Event("error"));
    });
    expect(container.querySelector(".boot")).toBeNull();
    expect(container.textContent).toContain("更早的问题");
    expect(container.textContent).toContain("更早的回答");
  });

  it("shows the outgoing message immediately and replaces it once when the server row arrives", async () => {
    const history = [{ id: "m1", role: "user", kind: "message", content: "更早的问题", created_at: 1, seq: 1, source_key: "older" }];
    fixture.api.mockImplementation(async (route: string) => {
      if (route === "state") return state;
      if (route.startsWith("agents/messages")) return { sync, messages: history, streaming: [], hasMore: false };
      return {};
    });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    let clientId = "";
    let releaseInput: () => void = () => {};
    fixture.api.mockImplementation((route: string, body?: { clientId?: string }) => {
      if (route === "state") return Promise.resolve(state);
      if (route === "agents/input") {
        clientId = String(body?.clientId ?? "");
        return new Promise((resolve) => { releaseInput = () => resolve({}); });
      }
      if (route.startsWith("agents/messages")) {
        const after = Number(new URLSearchParams(route.slice(route.indexOf("?"))).get("after") ?? 0);
        const sent = clientId ? [{ id: "sent", role: "user", kind: "message", content: "刚发出去", created_at: 3, seq: 3, source_key: `agent-input:agent:${clientId}` }] : [];
        return Promise.resolve({ sync, messages: [...history, ...sent].filter((row) => Number(row.seq) > after), streaming: [], hasMore: false });
      }
      return Promise.resolve({});
    });
    await type("刚发出去");
    await enter();
    const transcript = () => container.querySelector(".transcript")!.textContent ?? "";
    expect(transcript()).toContain("更早的问题");
    expect(transcript().split("刚发出去").length - 1).toBe(1);
    expect(composer().value).toBe("");
    expect(container.querySelector(".boot")).toBeNull();
    await act(async () => { releaseInput(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(transcript()).toContain("更早的问题");
    expect(transcript().split("刚发出去").length - 1).toBe(1);
  });

  it("follows tail growth until the reader scrolls up, then follows again at the bottom", async () => {
    const el = container.querySelector<HTMLDivElement>(".transcript")!;
    let top = 0;
    let height = 400;
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    el.scrollTo = ((options?: ScrollToOptions) => { if (options && typeof options.top === "number") top = options.top; }) as typeof el.scrollTo;
    const follow = () => observers.at(-1)!.callback([], observers.at(-1) as unknown as ResizeObserver);
    top = 300;
    await act(async () => { el.dispatchEvent(new Event("scroll")); });
    height = 700;
    await act(async () => { el.dispatchEvent(new Event("scroll")); });
    await act(async () => { follow(); });
    expect(top).toBe(700);
    await act(async () => { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -40 })); });
    height = 900;
    await act(async () => { follow(); });
    expect(top).toBe(700);
    await type("在上面");
    await enter();
    await act(async () => { follow(); });
    expect(top).toBe(700);
    top = 800;
    await act(async () => { el.dispatchEvent(new Event("scroll")); });
    height = 1100;
    await act(async () => { follow(); });
    expect(top).toBe(1100);
  });

  it("attaches a pasted screenshot and leaves a text paste alone", async () => {
    fixture.api.mockImplementation(async (route: string, body?: { name?: string }) => {
      if (route === "state") return state;
      if (route.startsWith("agents/messages")) return { sync, messages: [], streaming: [], hasMore: false };
      if (route === "attachments") return { id: "file-1", botId: "agent", name: body?.name, size: 4 };
      return {};
    });
    const png = new File([Uint8Array.from([1, 2, 3, 4])], "", { type: "" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { items: [{ kind: "file", type: "image/png", getAsFile: () => png }], files: [] },
    });
    await act(async () => { composer().dispatchEvent(paste); });
    expect(paste.defaultPrevented).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(fixture.api).toHaveBeenCalledWith("attachments", expect.objectContaining({ botId: "agent", name: "截图.png" }));
    // Images show as compact thumbnails inside the composer, not as file chips.
    const preview = container.querySelector<HTMLImageElement>(".composer.conversation-input .attachment-image-draft img.attachment-thumb-tile");
    expect(preview?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(preview?.alt).toBe("截图.png");
    expect(container.querySelector(".attachment-draft")).toBeNull();
    await act(async () => { preview!.closest("button")!.click(); });
    const remove = document.querySelector<HTMLButtonElement>(".image-lightbox-delete");
    expect(remove?.getAttribute("aria-label")).toBe("移除图片");
    await act(async () => { remove!.click(); });
    expect(container.querySelector(".attachment-image-draft")).toBeNull();
    const text = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(text, "clipboardData", {
      value: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], files: [] },
    });
    await act(async () => { composer().dispatchEvent(text); });
    expect(text.defaultPrevented).toBe(false);
    expect(fixture.api.mock.calls.filter(([route]) => route === "attachments")).toHaveLength(1);
  });

  it("shows only a pulsing gray placeholder until the upload succeeds", async () => {
    let finish!: (value: unknown) => void;
    fixture.api.mockImplementation(async (route: string) => {
      if (route === "state") return state;
      if (route.startsWith("agents/messages")) return { sync, messages: [], streaming: [], hasMore: false };
      if (route === "attachments") return new Promise((resolve) => { finish = resolve; });
      return {};
    });
    const png = new File([Uint8Array.from([1, 2, 3, 4])], "", { type: "" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { items: [{ kind: "file", type: "image/png", getAsFile: () => png }], files: [] },
    });
    await act(async () => { composer().dispatchEvent(paste); });
    const pending = container.querySelector(".attachment-image-draft.is-uploading");
    expect(pending).not.toBeNull();
    expect(pending?.textContent).toBe("");
    expect(container.querySelector(".attachment-tile-remove")).toBeNull();
    expect(container.querySelector(".attachment-file-draft")).toBeNull();
    await act(async () => { for (let i = 0; i < 50 && !finish; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); finish({ id: "file-1", botId: "agent", name: "截图.png", size: 4, mime: "image/png" }); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector(".attachment-image-draft.is-uploading")).toBeNull();
    expect(container.querySelector<HTMLImageElement>(".attachment-image-draft img.attachment-thumb-tile")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });
});
