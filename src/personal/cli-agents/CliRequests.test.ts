// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliRequestView } from "../../../shared/cli-agents";
import { CliApiError } from "./api";
import { device, permissionRequest, questionRequest, session } from "./fixtures";
import { CliStream, type SocketLike } from "./stream";

const fixture = vi.hoisted(() => ({
  fetchSnapshot: vi.fn(),
  fetchItems: vi.fn(),
  answerRequest: vi.fn(),
  forkSession: vi.fn(),
  fetchSupervision: vi.fn(),
  saveSupervision: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...fixture }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options = {};
    unicode = { activeVersion: "6" };
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    onBinary() { return { dispose() {} }; }
    write(_data: Uint8Array, done?: () => void) { done?.(); }
    reset() {}
    resize() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { proposeDimensions() { return { cols: 120, rows: 40 }; } fit() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../AgentDesktop", () => ({ RichText: ({ value }: { value: string }) => createElement("p", null, value) }));

import { CliAgentsWorkspace } from "./CliAgentsWorkspace";

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send() {}
  close() {}
  open() { this.readyState = 1; this.onopen?.({}); }
  push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const KEY = "dev1:claude:s1";
let root: Root;
let container: HTMLDivElement;
let socket: FakeSocket;
let stream: CliStream;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); });
const button = (label: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label || entry.getAttribute("aria-label") === label) ?? null;
const push = (message: unknown) => act(async () => { socket.push(message); });
const submit = (form: Element) => act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

interface Rows { devices: ReturnType<typeof device>[]; sessions: ReturnType<typeof session>[]; requests?: CliRequestView[] }

async function open(rows: Rows = { devices: [device()], sessions: [session()] }, extra: Record<string, unknown> = {}) {
  fixture.fetchSnapshot.mockResolvedValue(rows);
  localStorage.setItem("nexbot.cliSelected", KEY);
  await act(async () => {
    root.render(createElement(CliAgentsWorkspace, { sidebar: null, dark: false, collapsed: false, onSwitchMode: () => {}, stream, ...extra }));
  });
  await flush();
  await act(async () => { socket.open(); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  localStorage.clear();
  for (const mock of Object.values(fixture)) mock.mockReset();
  fixture.fetchItems.mockResolvedValue({ items: [], more: false });
  fixture.answerRequest.mockResolvedValue({ outcome: "answered" });
  socket = new FakeSocket();
  stream = new CliStream({ url: "ws://test", createSocket: () => socket });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("request cards in the workspace", () => {
  it.each([true, false])("keeps the approval card in chat and the waiting tag on its session row (sidebar list: %s)", async (sidebarList) => {
    await open({ devices: [device()], sessions: [session(), session({ nativeId: "other", title: "另一条会话", lastActivityAt: Date.now() })] }, { sidebarList });
    await click(container.querySelector('.cli-list button[aria-current="true"]'));
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    const card = container.querySelector(".cli-request")!;
    expect(card.textContent).toContain("Bash");
    expect(card.textContent).toContain("rm -rf build");
    expect(card.getAttribute("data-state")).toBe("pending");
    expect([...card.querySelectorAll(".conversation-action")].map((button) => [button.textContent, button.getAttribute("data-tone")]))
      .toEqual([["拒绝", "dark"], ["允许", "light"]]);
    expect(container.querySelector(".na-workspace-status")).toBeNull();
    expect(container.querySelector('.cli-pane-head [data-tone="waiting"]')).toBeNull();
    expect(container.querySelector('.cli-list [aria-current="true"] .cli-waiting-tag')?.textContent).toBe("等你处理");
    const otherRow = container.querySelector('.cli-list button[title="另一条会话"]')!;
    expect(otherRow.querySelector(".cli-waiting-tag")).toBeNull();
  });

  it("takes the pending requests of the first HTTP read", async () => {
    await open({ devices: [device()], sessions: [session()], requests: [permissionRequest({ id: "r1" }), permissionRequest({ id: "r2", tool: "Edit", summary: "a.ts" })] });
    expect(container.querySelectorAll(".cli-request")).toHaveLength(2);
    expect(container.querySelector(".cli-row .cli-waiting-tag")?.textContent).toBe("等你处理 2");
    expect(container.querySelector(".na-workspace-status")).toBeNull();
  });

  it("replaces the pending list of a session without touching the others", async () => {
    const other = session({ nativeId: "s2", title: "写测试" });
    await open({ devices: [device()], sessions: [session(), other] });
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" }), permissionRequest({ id: "r2" })] });
    await push({ type: "requests", key: other.key, requests: [permissionRequest({ id: "r3", key: other.key })] });
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r2" })] });
    expect(container.querySelectorAll(".cli-request")).toHaveLength(1);
    expect([...container.querySelectorAll(".cli-device .cli-row .cli-waiting-tag")].map((entry) => entry.textContent)).toEqual(["等你处理", "等你处理"]);
  });

  it("marks a request handled in the terminal and does not bring it back", async () => {
    await open();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    await push({ type: "request.resolved", key: KEY, id: "r1", by: "terminal" });
    const card = container.querySelector(".cli-request")!;
    expect(card.getAttribute("data-state")).toBe("terminal");
    expect(card.textContent).toContain("已在终端处理");
    expect(card.querySelector("button")).toBeNull();
    expect(container.querySelector(".cli-waiting-tag")).toBeNull();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    expect(container.querySelector(".cli-request")!.getAttribute("data-state")).toBe("terminal");
  });

  it("drops what was pending when the list is sent again", async () => {
    await open();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    await push({ type: "list", devices: [device()], sessions: [session()] });
    expect(container.querySelector(".cli-request")).toBeNull();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    expect(container.querySelectorAll(".cli-request")).toHaveLength(1);
  });

  it("answers allow and shows the card as allowed", async () => {
    await open();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    await click(button("允许"));
    await flush();
    expect(fixture.answerRequest).toHaveBeenCalledWith("r1", "allow", undefined, undefined);
    const card = container.querySelector(".cli-request")!;
    expect(card.getAttribute("data-state")).toBe("allowed");
    expect(card.textContent).toContain("已允许");
    expect(container.querySelector(".cli-waiting-tag")).toBeNull();
    // Core's own request.resolved after the answer does not change what this page recorded
    await push({ type: "request.resolved", key: KEY, id: "r1", by: "nexbot" });
    expect(container.querySelector(".cli-request")!.getAttribute("data-state")).toBe("allowed");
  });

  it("omits raw parameter details and allows for the rest of the session when the request offers it", async () => {
    await open();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1", detail: JSON.stringify({ command: "rm -rf build" }, null, 2), always: true })] });
    const card = container.querySelector(".cli-request")!;
    expect(card.querySelector(".cli-request-detail")).toBeNull();
    await click(button("本会话总是允许"));
    await flush();
    expect(fixture.answerRequest).toHaveBeenCalledWith("r1", "allow", undefined, true);
    expect(container.querySelector(".cli-request")!.getAttribute("data-state")).toBe("always");
    expect(container.querySelector(".cli-request")!.textContent).toContain("本会话已允许");
  });

  it("offers no session-wide allow when the request does not", async () => {
    await open();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    expect(button("本会话总是允许")).toBeNull();
    expect(container.querySelector(".cli-request-detail")).toBeNull();
  });

  it("answers deny", async () => {
    await open();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    await click(button("拒绝"));
    await flush();
    expect(fixture.answerRequest).toHaveBeenCalledWith("r1", "deny", undefined, undefined);
    expect(container.querySelector(".cli-request")!.getAttribute("data-state")).toBe("denied");
  });

  it("keeps the card open and says why when Core refuses the answer", async () => {
    fixture.answerRequest.mockRejectedValueOnce(new CliApiError("x", "device_offline", 502));
    await open();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    await click(button("允许"));
    await flush();
    expect(container.querySelector(".cli-request")!.getAttribute("data-state")).toBe("pending");
    expect(container.querySelector(".cli-request [role=alert]")?.textContent).toContain("电脑离线");
  });

  it("sends the chosen options of a question", async () => {
    await open();
    await push({ type: "requests", key: KEY, requests: [questionRequest({ id: "q1" })] });
    expect(button("提交")!.hasAttribute("disabled")).toBe(true);
    const inputs = [...container.querySelectorAll<HTMLInputElement>(".cli-request input")];
    await click(inputs[1]);
    await click(inputs[2]);
    await click(inputs[3]);
    await click(button("提交"));
    await flush();
    expect(fixture.answerRequest).toHaveBeenCalledWith("q1", "allow", { "用哪个框架？": "Vue", "要哪些功能？": "路由, 测试" }, undefined);
    expect(container.querySelector(".cli-request")!.getAttribute("data-state")).toBe("answered");
  });

  it("supports custom '其他' input for single-choice and multi-choice questions", async () => {
    await open();
    await push({
      type: "requests",
      key: KEY,
      requests: [
        questionRequest({
          id: "q-other",
          questions: [
            {
              question: "用哪个框架？",
              header: "框架",
              options: [
                { label: "React", description: "组件化" },
                { label: "Vue", description: "渐进式" },
              ],
            },
          ],
        }),
      ],
    });
    const otherButton = container.querySelector(".na-island-other-trigger")!;
    await click(otherButton);
    expect(button("提交")!.hasAttribute("disabled")).toBe(true);
    const customInput = container.querySelector<HTMLInputElement>(".na-island-other-input")!;
    expect(customInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(customInput, "SolidJS");
      customInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("提交")!.hasAttribute("disabled")).toBe(false);
    await click(button("提交"));
    await flush();
    expect(fixture.answerRequest).toHaveBeenCalledWith("q-other", "allow", { "用哪个框架？": "SolidJS" }, undefined);
    expect(container.querySelector(".cli-request.is-resolved")?.getAttribute("data-state")).toBe("answered");
  });

  it("expires a card whose time ran out", async () => {
    await open();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      vi.setSystemTime(10_000);
      await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1", expiresAt: 12_000 })] });
      expect(container.querySelector(".cli-request")!.getAttribute("data-state")).toBe("pending");
      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
      expect(container.querySelector(".cli-request")!.getAttribute("data-state")).toBe("expired");
      expect(container.querySelector(".cli-waiting-tag")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("request notifications", () => {
  const shown: Array<{ title: string; options: NotificationOptions }> = [];
  beforeEach(() => {
    shown.length = 0;
    vi.stubGlobal("Notification", class {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions) { shown.push({ title, options }); }
      close() {}
    });
    localStorage.setItem("nexbot.cliNotify", "1");
  });
  afterEach(() => { delete (document as { hidden?: boolean }).hidden; });

  it("notifies for a new request while the page is hidden, not for the ones already there", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await open({ devices: [device()], sessions: [session()], requests: [permissionRequest({ id: "old" })] });
    expect(shown).toHaveLength(0);
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "old" }), permissionRequest({ id: "new", tool: "Edit", summary: "src/a.ts" })] });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("修复登录");
    expect(shown[0].options.body).toBe("Edit src/a.ts");
    expect(shown[0].options.tag).toBe(KEY);
  });

  it("says a request once even when the session starts waiting with it", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await open();
    await act(async () => {
      socket.push({ type: "list.delta", upserts: [session({ state: "waiting" })], removes: [] });
      socket.push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    });
    expect(shown.map((entry) => entry.options.body)).toEqual(["Bash rm -rf build"]);
    shown.length = 0;
    await push({ type: "list.delta", upserts: [session({ nativeId: "s2", title: "写测试", state: "waiting" })], removes: [] });
    expect(shown).toHaveLength(1);
  });

  it("stays quiet while the page is in front", async () => {
    await open();
    await push({ type: "requests", key: KEY, requests: [permissionRequest({ id: "r1" })] });
    expect(shown).toHaveLength(0);
  });
});

describe("hand over to an assistant", () => {
  const bots = [{ id: "bot1", name: "财务" }, { id: "bot2", name: "日常" }];

  it("offers it only when assistants and a way to open the topic are known", async () => {
    await open();
    expect(button("交给助手")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await open(undefined, { bots, onOpenTopic: () => {} });
    expect(button("交给助手")).not.toBeNull();
  });

  it("forks to the chosen assistant and opens its new topic", async () => {
    fixture.forkSession.mockResolvedValue({ botId: "bot2", conversationId: "conv9" });
    const onOpenTopic = vi.fn();
    localStorage.setItem("nexbot.selectedAgent", "bot1");
    await open(undefined, { bots, onOpenTopic });
    await click(button("交给助手"));
    const dialog = container.querySelector("[role=dialog][aria-label=交给助手]")!;
    expect(dialog.querySelector("[aria-pressed=true]")?.textContent).toBe("财务");
    await click([...dialog.querySelectorAll("button")].find((entry) => entry.textContent === "日常") ?? null);
    await submit(dialog);
    await flush();
    expect(fixture.forkSession).toHaveBeenCalledWith(KEY, "bot2");
    expect(onOpenTopic).toHaveBeenCalledWith("bot2", "conv9");
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("copies and branches from the selected conclusion, with no actions on interim replies", async () => {
    fixture.fetchItems.mockResolvedValue({ more: false, items: [
      { id: "u1", kind: "user", ts: 1, text: "First task" },
      { id: "progress", kind: "assistant", ts: 2, text: "Working on the task" },
      { id: "a1", kind: "assistant", ts: 3, text: "Earlier conclusion" },
      { id: "u2", kind: "user", ts: 4, text: "Second task" },
      { id: "a2", kind: "assistant", ts: 5, text: "Later conclusion" },
    ] });
    fixture.forkSession.mockResolvedValue({ botId: "bot1", conversationId: "conv9" });
    const onOpenTopic = vi.fn();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    try {
      await open(undefined, { bots, onOpenTopic });
      expect(container.textContent).not.toContain("Working on the task");
      await click(container.querySelector(".message-progress > button"));
      const [first, interim, last] = container.querySelectorAll('[data-testid="cli-assistant"]');
      expect(interim.textContent).toContain("Working on the task");
      expect(interim.querySelector('button[title="复制"], button[title="分支到新聊天"]')).toBeNull();
      expect(last.querySelector('button[title="复制"]')).not.toBeNull();
      const copy = first.querySelector(':scope > .na-reply-actions button[title="复制"], button[title="复制"]');
      const branch = first.querySelector(':scope > .na-reply-actions button[title="分支到新聊天"], button[title="分支到新聊天"]');
      expect(copy?.textContent).toBe("");
      expect(branch?.textContent).toBe("");
      await click(copy);
      expect(write).toHaveBeenCalledWith("Earlier conclusion");
      await click(branch);
      const dialog = container.querySelector('[role="dialog"][aria-label="分支到新聊天"]')!;
      await submit(dialog);
      expect(fixture.forkSession).toHaveBeenCalledWith(KEY, "bot1", "a1");
      expect(onOpenTopic).toHaveBeenCalledWith("bot1", "conv9");
    } finally {
      write.mockRestore();
    }
  });

  it("dismisses the selection menu when the highlight clears and copies only the selected text", async () => {
    fixture.fetchItems.mockResolvedValue({ more: false, items: [
      { id: "a1", kind: "assistant", ts: 1, text: "Part of the reply" },
    ] });
    await open();
    await flush();
    const paragraph = container.querySelector('[data-testid="cli-assistant"] p')!;
    const selection = window.getSelection()!;
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const menu = () => document.querySelector(".na-note-editor");
    const select = () => act(async () => {
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.firstChild!, 4);
      range.getBoundingClientRect = () => new DOMRect(10, 20, 30, 10);
      selection.addRange(range);
      paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    try {
      await select();
      expect(menu()?.textContent).toContain("添加注释");
      await act(async () => {
        selection.removeAllRanges();
        document.dispatchEvent(new Event("selectionchange"));
      });
      expect(menu()).toBeNull();
      await select();
      await click([...menu()!.querySelectorAll("button")].find(button => button.textContent === "复制") ?? null);
      expect(write).toHaveBeenCalledWith("Part");
      expect(menu()).toBeNull();
    } finally {
      selection.removeAllRanges();
      write.mockRestore();
    }
  });

  it("keeps the dialog open with Core's text when the fork fails", async () => {
    fixture.forkSession.mockRejectedValueOnce(new CliApiError("x", "device_offline", 502));
    const onOpenTopic = vi.fn();
    await open(undefined, { bots, onOpenTopic });
    await click(button("交给助手"));
    const dialog = container.querySelector("[role=dialog]")!;
    await submit(dialog);
    await flush();
    expect(onOpenTopic).not.toHaveBeenCalled();
    expect(dialog.querySelector("[role=alert]")?.textContent).toContain("电脑离线");
    expect(dialog.querySelector("button[type=submit]")!.hasAttribute("disabled")).toBe(false);
  });
});

describe("workspace header", () => {
  it("omits device breadcrumbs and the supervision gear", async () => {
    await open();
    expect(button("自动处理设置")).toBeNull();
    expect(container.querySelector(".na-breadcrumb")).toBeNull();
  });
});
