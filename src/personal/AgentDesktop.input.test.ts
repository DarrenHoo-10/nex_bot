// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { State } from "./api";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), api: fixture.api }));
vi.mock("./auth", () => ({ useAccount: () => ({ status: {}, logout: vi.fn() }), AccountControls: () => null }));
vi.mock("../../shared/html-preview", async (original) => {
  const actual = await original<typeof import("../../shared/html-preview")>();
  return { ...actual, htmlPreviewParts: vi.fn(actual.htmlPreviewParts) };
});
import { htmlPreviewParts } from "../../shared/html-preview";
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
  readonly targets: Element[] = [];
  constructor(public callback: ResizeObserverCallback) { observers.push(this); }
  observe(target: Element) { this.targets.push(target); }
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
  it("reuses unchanged rich history while typing, sending and syncing", async () => {
    const content = "## 已有结果\n\n| 项目 | 状态 |\n| --- | --- |\n| 设备 | 在线 |";
    const history = [{ id: "rich-history", role: "assistant", kind: "message", content, created_at: 1, seq: 1 }];
    fixture.api.mockImplementation(async (route: string) => {
      if (route === "state") return { ...state };
      if (route.startsWith("agents/messages")) return { sync, messages: route.includes("after=") ? [] : history.map(row => ({ ...row })), streaming: [], hasMore: false };
      return {};
    });
    await act(async () => { sources[0].emit("change", { ...sync, reset: true }); await new Promise(resolve => setTimeout(resolve, 200)); });
    const parses = () => vi.mocked(htmlPreviewParts).mock.calls.filter(([text]) => text === content).length;
    const before = parses(); expect(before).toBeGreaterThan(0);
    await type("补充一句"); await enter();
    await act(async () => { sources[0].emit("change", { ...sync, reset: true }); await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(parses()).toBe(before);
    expect(container.textContent).toContain("已有结果");
  });

  it("keeps the processing row until the finished task's reply is ready to commit", async () => {
    state = { ...state, tasks: [{ id: "t1", bot_id: "agent", origin: "owner", status: "running" }] };
    await act(async () => { sources[0].emit("change", sync); await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(container.querySelector(".processing-message")).not.toBeNull();
    state = { ...state, tasks: [{ id: "t1", bot_id: "agent", origin: "owner", status: "succeeded" }] };
    let finishFeed!: (value: unknown) => void;
    fixture.api.mockImplementation(async (route: string) => {
      if (route === "state") return state;
      if (route.startsWith("agents/messages")) return new Promise(resolve => { finishFeed = resolve; });
      return {};
    });
    await act(async () => { sources[0].emit("change", sync); await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(container.querySelector(".processing-message")).not.toBeNull();
    await act(async () => { finishFeed({ sync, messages: [{ id: "answer", role: "assistant", kind: "message", content: "完整回复", created_at: 1, seq: 1 }], streaming: [], hasMore: false }); });
    expect(container.querySelector(".processing-message")).toBeNull();
    expect(container.textContent).toContain("完整回复");
  });
  it("sends a remembered approval only when Always allow is selected", async () => {
    state.approvals = [{ id: "approval", bot_id: "agent", argument_hash: "digest", tool_name: "device.exec", arguments_json: '{"action":"device.exec","deviceId":"fixture","command":"fixture"}', authorization_snapshot_json: "{}", remember_label: "执行终端命令 · Fixture device" }];
    await act(async () => { window.dispatchEvent(new Event("focus")); await new Promise((resolve) => setTimeout(resolve, 200)); });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".approval .actions button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["允许一次", "始终允许", "拒绝"]);
    expect(buttons[1].title).toContain("Fixture device");
    await act(async () => { buttons[1].click(); });
    expect(fixture.api).toHaveBeenCalledWith("approvals", { id: "approval", hash: "digest", allow: true, remember: true });
  });
  it("opens a read-only routine and allows only confirmed shutdown or deletion", async () => {
    state.routines = [{ id: "r", bot_id: "agent", name: "例行巡检", prompt: "检查状态", schedule_kind: "interval", task_kind: "monitor", interval_ms: 300000, enabled: 1, next_due_at: 1900000000000 }];
    state.occurrences = [{ id: "occ", bot_id: "agent", name: "例行巡检", status: "skipped", reason: "已过期", scheduled_at: 1800000000000 }];
    await act(async () => { sources[0].emit("change", sync); await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(container.querySelector(".routine-row")!.textContent).toContain("下次");
    expect(container.querySelector(".routine-summary")!.textContent).toContain("巡检");
    expect(container.querySelector('.routine-run, .routine-toggle, [aria-label="添加定时任务"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.routine-summary')!.click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).not.toMatch(/现在执行|编辑|恢复/);
    expect(dialog.querySelector('input, select, textarea')).toBeNull();
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '关闭任务')!.click());
    expect(fixture.api).not.toHaveBeenCalledWith('routines/toggle', expect.anything());
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '确认关闭')!.click());
    expect(fixture.api).toHaveBeenCalledWith('routines/toggle', { id: 'r', version: undefined, enabled: false });
  });
  it("does not select a routine, background job or delegated child as the chat task or contact activity", async () => {
    // A delegated child has no inbox link, so Core reports no origin for it.
    state.tasks = [{ id: "routine-task", bot_id: "agent", origin: "routine", status: "running", objective: "后台巡检" }, { id: "job-task", bot_id: "agent", origin: "job", status: "running", objective: "后台整理" }, { id: "child-task", bot_id: "agent", origin: null, status: "running", objective: "委派子任务" }];
    await act(async () => { sources[0].emit("change", sync); await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(container.querySelector('.composer .send[aria-label="停止任务"]')).toBeNull();
    expect(container.querySelector(".processing-message")).toBeNull();
    expect(container.querySelector('.contact-item[data-working="true"]')).toBeNull();
    state.tasks.push({ id: "chat-task", bot_id: "agent", origin: "owner", status: "running" });
    await act(async () => { sources[0].emit("change", sync); await new Promise(resolve => setTimeout(resolve, 200)); });
    await act(async () => container.querySelector<HTMLButtonElement>('.composer .send[aria-label="停止任务"]')!.click());
    expect(fixture.api).toHaveBeenCalledWith("cancel", { taskId: "chat-task" });
    expect(fixture.api).not.toHaveBeenCalledWith("cancel", { taskId: "job-task" });
    expect(fixture.api).not.toHaveBeenCalledWith("cancel", { taskId: "child-task" });
  });
  it("turns the send key into a stop key while the Agent works and the composer is empty", async () => {
    state = { ...state, connected: true, tasks: [{ id: "task-1", bot_id: "agent", origin: "owner", status: "running", objective: "fixture" }] } as State;
    await act(async () => { sources[0].emit("change", sync); await new Promise((resolve) => setTimeout(resolve, 300)); });
    const stop = container.querySelector<HTMLButtonElement>('.composer .send[aria-label="停止任务"]');
    expect(stop).not.toBeNull();
    expect(container.querySelector('.task-status')).toBeNull();
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
    const optimisticElement = container.querySelector('[data-message-id^="optimistic:"]');
    expect(container.querySelector(".processing-caption")?.textContent).toBe("正在发送…");
    expect(container.querySelector(".task-status")).toBeNull();
    await act(async () => { releaseInput(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(transcript()).toContain("更早的问题");
    expect(transcript().split("刚发出去").length - 1).toBe(1);
    expect(container.querySelector('[data-message-id="sent"]')).toBe(optimisticElement);
  });

  it("keeps the in-progress row when a newer sync supersedes the send reload", async () => {
    const gates: Array<(value: State) => void> = [];
    fixture.api.mockImplementation((route: string) => {
      if (route === "state") return new Promise<State>((resolve) => { gates.push(resolve); });
      if (route === "agents/input") return Promise.resolve({});
      if (route.startsWith("agents/messages")) return Promise.resolve({ sync, messages: [], streaming: [], hasMore: false });
      return Promise.resolve({});
    });
    await type("你好");
    await act(async () => {
      composer().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(gates).toHaveLength(1);
    expect(container.querySelector(".processing-caption")?.textContent).toBe("正在发送…");
    await act(async () => {
      sources.at(-1)!.emit("change", sync);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(gates).toHaveLength(2);
    await act(async () => { gates[0](state); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".processing-message")).not.toBeNull();
    expect(container.querySelector(".processing-caption")?.textContent).toBe("正在发送…");
    await act(async () => {
      gates[1]({ ...state, tasks: [{ id: "t1", bot_id: "agent", status: "running", origin: "owner" }] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector(".processing-message")).not.toBeNull();
    expect(container.querySelector(".processing-caption")?.textContent).toBe("执行中");
  });

  it("does not paint the live reply again once that text is in the transcript", async () => {
    const history = [{ id: "answer", role: "assistant", kind: "message", content: "完整回复", created_at: 2, seq: 2, task_id: "t1" }];
    fixture.api.mockImplementation(async (route: string) => {
      if (route === "state") return { ...state, tasks: [{ id: "t1", bot_id: "agent", status: "succeeded", origin: "owner" }] };
      if (route.startsWith("agents/messages")) return { sync, messages: history, streaming: [{ taskId: "t1", text: "完整回复" }, { taskId: "t2", text: "另一段" }], hasMore: false };
      return {};
    });
    await act(async () => { sources[0].emit("change", sync); await new Promise((resolve) => setTimeout(resolve, 200)); });
    const transcript = container.querySelector(".transcript")!.textContent ?? "";
    expect(transcript.split("完整回复").length - 1).toBe(1);
    expect(transcript).toContain("另一段");
    expect(transcript).toContain("正在回复…");
    expect(container.querySelector(".processing-message")).toBeNull();
  });

  it("preserves scrollback until sending, then returns to and follows the bottom", async () => {
    const el = container.querySelector<HTMLDivElement>(".transcript")!;
    let top = 0;
    let height = 400;
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    el.scrollTo = ((options?: ScrollToOptions) => { if (options && typeof options.top === "number") top = options.top; }) as typeof el.scrollTo;
    const follow = () => observers.at(-1)!.callback([], observers.at(-1) as unknown as ResizeObserver);
    expect(observers.at(-1)!.targets).toContain(el);
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
    expect(top).toBe(900);
    expect(container.querySelector(".scroll-pill")).toBeNull();
    height = 1000;
    await act(async () => { follow(); });
    expect(top).toBe(1000);
    await act(async () => { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -40 })); });
    top = 800;
    height = 1100;
    await act(async () => { follow(); });
    expect(top).toBe(800);
    top = 1000;
    await act(async () => { el.dispatchEvent(new Event("scroll")); });
    height = 1200;
    await act(async () => { follow(); });
    expect(top).toBe(1200);
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
    await type("保留草稿");
    const remove = container.querySelector<HTMLButtonElement>(".attachment-tile-remove");
    expect(remove?.getAttribute("aria-label")).toBe("移除 截图.png");
    expect(remove?.closest(".attachment-image-preview")).toBeNull();
    await act(async () => { remove!.click(); });
    expect(container.querySelector(".attachment-image-draft")).toBeNull();
    expect(document.querySelector(".image-lightbox")).toBeNull();
    expect(composer().value).toBe("保留草稿");
    expect(fixture.api.mock.calls.some(([route]) => route === "agents/input")).toBe(false);
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
    expect(container.querySelector(".attachment-tile-remove")?.getAttribute("aria-label")).toBe("取消上传 截图.png");
    expect(container.querySelector(".attachment-file-draft")).toBeNull();
    await act(async () => { for (let i = 0; i < 50 && !finish; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); finish({ id: "file-1", botId: "agent", name: "截图.png", size: 4, mime: "image/png" }); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector(".attachment-image-draft.is-uploading")).toBeNull();
    expect(container.querySelector<HTMLImageElement>(".attachment-image-draft img.attachment-thumb-tile")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });
});

describe("Background jobs in the chat (Web, Electron and Android WebView)", () => {
  const job = (overrides: Record<string, unknown> = {}) => ({ id: "job-1", botId: "agent", title: "整理下载文件夹", stage: "running", taskId: "job-task", originTaskId: "owner-task", todoId: null, todoVersion: null, todoStatus: null, progress: null, latestReport: null, createdAt: 1, endedAt: null, ...overrides });
  const report = (state: string, extra: Record<string, unknown> = {}) => ({ id: "report-msg", role: state === "blocked" || state === "failed" ? "system" : "assistant", kind: state === "question" ? "request" : state === "ready" ? "result" : "error", content: `后台任务「整理下载文件夹」\n已整理 12 个文件${state === "question" ? "\n\n要保留截图吗？" : ""}`, source_key: "job-report:r1", job_id: "job-1", job_title: "整理下载文件夹", job_state: state, created_at: 2, seq: 2, ...extra });
  async function show(jobs: unknown[], messages: unknown[], tasks: State["tasks"] = []) {
    state = { ...state, jobs, tasks } as State;
    fixture.api.mockImplementation(async (route: string) => {
      if (route === "state") return state;
      if (route.startsWith("agents/messages")) return { sync, messages: route.includes("after=") ? [] : messages, streaming: [], hasMore: false };
      return {};
    });
    await act(async () => { sources[0].emit("change", { ...sync, reset: true }); await new Promise(resolve => setTimeout(resolve, 250)); });
  }
  const cardButtons = () => [...container.querySelectorAll<HTMLButtonElement>(".job-card .actions button")].map(button => button.textContent);
  const cardButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".job-card .actions button")].find(button => button.textContent === label)!;

  it("shows the hand-off as a marker and the report as a card whose actions follow the job's current stage", async () => {
    const latest = { id: "r1", state: "question", summary: "已整理 12 个文件", question: "要保留截图吗？", messageId: "report-msg", createdAt: 2 };
    await show([job({ stage: "question", latestReport: latest })], [
      { id: "start-msg", role: "system", kind: "activity", content: "已交给后台：整理下载文件夹", source_key: "job-start:job-1", job_id: "job-1", job_title: "整理下载文件夹", created_at: 1, seq: 1 },
      report("question"),
    ]);
    expect(container.querySelector(".job-marker")?.textContent).toContain("已交给后台");
    expect(container.querySelector(".job-card header")?.textContent).toBe("整理下载文件夹等待你回答");
    expect(container.querySelector(".job-card-body")?.textContent).toContain("要保留截图吗？");
    expect(container.querySelector(".job-card-body")?.textContent).not.toContain("后台任务「");
    expect(cardButtons()).toEqual(["回复", "停止"]);
    await show([job({ stage: "running", latestReport: latest })], [report("question")]);
    expect(cardButtons()).toEqual(["停止"]);
    await act(async () => cardButton("停止").click());
    expect(fixture.api).toHaveBeenCalledWith("jobs/stop", { jobId: "job-1" });
    await show([job({ stage: "done", endedAt: 3, latestReport: { ...latest, state: "ready", question: null } })], [report("ready")]);
    expect(cardButtons()).toEqual([]);
    // A failed job still waits for a person: its card can stop it.
    await show([job({ stage: "failed", latestReport: { ...latest, state: "failed", question: null } })], [report("failed")]);
    expect(cardButtons()).toEqual(["停止"]);
    // An older report of the job carries no actions.
    await show([job({ stage: "question", latestReport: { ...latest, messageId: "newer" } })], [report("question")]);
    expect(cardButtons()).toEqual([]);
  });

  it("accepts or revises a todo's delivery from the card with the todo's version", async () => {
    const latest = { id: "r1", state: "ready", summary: "已整理 12 个文件", question: null, messageId: "report-msg", createdAt: 2 };
    await show([job({ stage: "review", todoId: "todo-1", todoVersion: 7, todoStatus: "review", latestReport: latest })], [report("ready")]);
    expect(cardButtons()).toEqual(["验收", "修改"]);
    await act(async () => cardButton("验收").click());
    expect(fixture.api).toHaveBeenCalledWith("todos/action", { id: "todo-1", version: 7, action: "complete" });
    await act(async () => cardButton("修改").click());
    const dialog = container.querySelector('[role="dialog"]')!;
    await act(async () => {
      const field = dialog.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "加上截图");
      dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fixture.api).toHaveBeenCalledWith("todos/action", expect.objectContaining({ id: "todo-1", version: 7, action: "start", feedback: "加上截图" }));
  });

  it("replies to a job's question through jobs/input, not the main chat, and keeps the draft when refused", async () => {
    const latest = { id: "r1", state: "question", summary: "已整理 12 个文件", question: "要保留截图吗？", messageId: "report-msg", createdAt: 2 };
    await show([job({ stage: "question", latestReport: latest })], [report("question")]);
    await act(async () => cardButton("回复").click());
    expect(container.querySelector(".reply-job-bar")?.textContent).toContain("回复后台任务：整理下载文件夹");
    await type("保留"); await enter();
    expect(fixture.api).toHaveBeenCalledWith("jobs/input", expect.objectContaining({ jobId: "job-1", text: "保留", clientId: expect.any(String) }));
    expect(fixture.api.mock.calls.some(([route]) => route === "agents/input")).toBe(false);
    expect(container.querySelector(".reply-job-bar")).toBeNull();
    // A refused reply (a stopped job) restores the draft and the reply target.
    fixture.api.mockImplementation(async (route: string) => {
      if (route === "jobs/input") throw new Error("后台任务已停止，不能再补充");
      if (route === "state") return state;
      if (route.startsWith("agents/messages")) return { sync, messages: [report("question")], streaming: [], hasMore: false };
      return {};
    });
    await act(async () => cardButton("回复").click());
    await type("再补充"); await enter();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(composer().value).toBe("再补充");
    expect(container.querySelector(".reply-job-bar")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("已停止");
    // Cancelling the reply returns to the main chat.
    await act(async () => container.querySelector<HTMLButtonElement>('.reply-job-bar button[aria-label="取消回复"]')!.click());
    await type("主对话的问题"); await enter();
    expect(fixture.api).toHaveBeenCalledWith("agents/input", expect.objectContaining({ text: "主对话的问题" }));
  });

  it("lists open jobs in the header and the profile with their own stop, and the stop key stops only the main chat", async () => {
    await show([job(), job({ id: "job-2", title: "导出报告", stage: "question", taskId: "job-task-2" }), job({ id: "job-3", title: "旧任务", stage: "done", endedAt: 5 })], [],
      [{ id: "owner-task", bot_id: "agent", origin: "owner", status: "running" }, { id: "job-task", bot_id: "agent", origin: "job", status: "running" }]);
    const pill = container.querySelector<HTMLButtonElement>(".jobs-pill")!;
    expect(pill.textContent).toBe("2 项后台任务");
    await act(async () => pill.click());
    const rows = [...container.querySelectorAll(".jobs-popover-row")];
    expect(rows.map(row => row.textContent)).toEqual(["整理下载文件夹执行中", "导出报告等待你回答"]);
    await act(async () => rows[1].querySelector<HTMLButtonElement>('button[aria-label="停止 导出报告"]')!.click());
    expect(fixture.api).toHaveBeenCalledWith("jobs/stop", { jobId: "job-2" });
    await act(async () => container.querySelector<HTMLButtonElement>('.composer .send[aria-label="停止任务"]')!.click());
    expect(fixture.api).toHaveBeenCalledWith("cancel", { taskId: "owner-task" });
    expect(fixture.api).not.toHaveBeenCalledWith("cancel", { taskId: "job-task" });
    expect([...container.querySelectorAll(".inspector .job-entry b")].map(item => item.textContent)).toEqual(["整理下载文件夹", "导出报告"]);
    expect(container.querySelector(".inspector .routine-history")?.textContent).toContain("旧任务");
    await act(async () => container.querySelector<HTMLButtonElement>(".inspector .stop-all button")!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "确认")!.click());
    expect(fixture.api).toHaveBeenCalledWith("agents/stop-all", { botId: "agent" });
    expect(container.querySelector('.contact-item[data-working="true"]')).not.toBeNull();
  });
});
