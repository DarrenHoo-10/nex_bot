// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliApiError } from "./api";
import { assistantItem, device, session, toolItem } from "./fixtures";
import { CliStream, type SocketLike } from "./stream";

const fixture = vi.hoisted(() => ({
  fetchSnapshot: vi.fn(),
  fetchSnapshotWithWorkbench: vi.fn(),
  fetchItems: vi.fn(),
  fetchQueue: vi.fn(),
  fetchGit: vi.fn(),
  startSession: vi.fn(),
  continueSession: vi.fn(),
  sendMessage: vi.fn(),
  stopSession: vi.fn(),
  resumeQueue: vi.fn(),
  editQueued: vi.fn(),
  withdrawQueued: vi.fn(),
  steerQueued: vi.fn(),
  branchSession: vi.fn(),
  renameWorkbenchSession: vi.fn(),
  archiveWorkbenchSession: vi.fn(),
  deleteWorkbenchSession: vi.fn(),
  interruptSession: vi.fn(),
  openLocal: vi.fn(),
  hideSession: vi.fn(),
  fetchNotes: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  fetchModels: vi.fn(),
  listDirs: vi.fn(),
  uploadAttachment: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...fixture }));
vi.mock("../AgentDesktop", () => ({ RichText: ({ value }: { value: string }) => createElement("p", null, value) }));

import { CliAgentsWorkspace } from "./CliAgentsWorkspace";

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: string[] = [];
  send(data: string | Uint8Array) { if (typeof data === "string") this.sent.push(data); }
  close() {}
  open() { this.readyState = 1; this.onopen?.({}); }
  push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  messages() { return this.sent.map((entry) => JSON.parse(entry)); }
}

let root: Root;
let container: HTMLDivElement;
let socket: FakeSocket;
let stream: CliStream;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const typeText = (box: HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
});
const text = () => container.textContent ?? "";
const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); });
const button = (label: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label || entry.getAttribute("aria-label") === label) ?? null;
/** Opens the model menu and picks the row whose name is `label` ("默认" for the CLI's default). */
async function pickModel(label: string, scope: ParentNode = container) {
  const trigger = scope.querySelector<HTMLButtonElement>('button[aria-label="模型设置"]')!;
  if (trigger.getAttribute("aria-expanded") !== "true") await click(trigger);
  const row = [...document.querySelectorAll<HTMLButtonElement>('.na-model-menu [role=option]')].find((entry) => entry.querySelector(".model-menu-name")?.textContent === label);
  expect(row, label).toBeTruthy();
  expect(row!.disabled).toBe(false);
  await click(row!);
}
async function pickEffort(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="模型设置"]')!;
  if (trigger.getAttribute("aria-expanded") !== "true") await click(trigger);
  const button = [...document.querySelectorAll(".na-model-menu .model-menu-stops button")].find((entry) => entry.textContent === label);
  await click(button ?? null);
}

async function mount(rows: { devices: ReturnType<typeof device>[]; sessions: ReturnType<typeof session>[]; workbench?: unknown[] }, selected?: string, navigation?: { sidebarList: boolean; onNavigation: () => void }) {
  fixture.fetchSnapshot.mockResolvedValue(rows);
  fixture.fetchSnapshotWithWorkbench.mockResolvedValue({ ...rows, workbench: rows.workbench ?? [], queues: [] });
  if (selected) localStorage.setItem("nexbot.cliSelected", selected);
  await act(async () => {
    root.render(createElement(CliAgentsWorkspace, { sidebar: createElement("div", { "data-testid": "sidebar" }), dark: false, collapsed: false, onNavigation: () => {}, stream, ...navigation }));
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  HTMLElement.prototype.showPopover ??= function () {}; HTMLElement.prototype.hidePopover ??= function () {};
  localStorage.clear();
  fixture.fetchModels.mockReset();
  fixture.fetchModels.mockResolvedValue({ models: [] });
  for (const key of ["fetchSnapshot", "fetchSnapshotWithWorkbench", "fetchItems", "fetchQueue", "fetchGit", "startSession", "continueSession", "sendMessage", "stopSession", "resumeQueue", "editQueued", "withdrawQueued", "steerQueued", "branchSession", "renameWorkbenchSession", "archiveWorkbenchSession", "deleteWorkbenchSession", "interruptSession", "openLocal", "hideSession", "fetchNotes", "createNote", "updateNote", "deleteNote"] as const) fixture[key].mockReset();
  fixture.fetchNotes.mockResolvedValue([]);
  fixture.fetchItems.mockResolvedValue({ items: [], more: false });
  fixture.fetchQueue.mockResolvedValue({ workbenchId: "wb", sessionKey: "", paused: false, entries: [] });
  fixture.fetchGit.mockRejectedValue(new Error("no git in this test"));
  fixture.sendMessage.mockResolvedValue({});
  fixture.stopSession.mockResolvedValue({ outcome: "ok" });
  fixture.hideSession.mockResolvedValue({});
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

describe("session list", () => {
  it("opens the mobile directory from the new-session title without a separate navigation row or losing the draft", async () => {
    const onNavigation = vi.fn();
    await mount({ devices: [device()], sessions: [session({ state: "idle" })] }, undefined, { sidebarList: false, onNavigation });
    await act(async () => socket.open());
    const app = container.querySelector(".cli-app")!;
    const brand = () => container.querySelector(".na-workspace-status button");
    expect(brand()?.textContent).toBe("NexAgent");
    await click(brand());
    expect(onNavigation).toHaveBeenCalledTimes(1);

    await click(button("新建会话"));
    expect(app.getAttribute("data-mobile")).toBe("pane");
    expect(container.querySelector(".na-workspace-status")).toBeNull();
    const header = container.querySelector("[data-testid=cli-new-session] .cli-pane-head")!;
    const draft = container.querySelector<HTMLTextAreaElement>("[data-testid=cli-new-session] textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "保留新会话草稿");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(header.querySelector('button[aria-label="打开会话目录"]'));
    expect(app.getAttribute("data-mobile")).toBe("list");
    expect(brand()?.textContent).toBe("NexAgent");
    expect(onNavigation).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".cli-side .na-new-session")?.textContent).toBe("新建会话");
    await click(button("新建会话"));
    expect(app.getAttribute("data-mobile")).toBe("pane");
    expect(container.querySelector("[data-testid=cli-new-session] textarea")).toBe(draft);
    expect(draft.value).toBe("保留新会话草稿");
  });

  it("folds the pinned 进行中 section to its heading and remembers it", async () => {
    await mount({ devices: [device()], sessions: [session({ nativeId: "r1", title: "在跑", state: "running" }), session({ nativeId: "w1", title: "等我", state: "waiting" })] });
    const head = () => container.querySelector<HTMLButtonElement>(".na-active .na-section-head")!;
    const pinned = () => [...container.querySelectorAll(".na-active .cli-row-title")].map((entry) => entry.textContent);
    expect(pinned()).toEqual(["在跑", "等我"]);
    await click(head());
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(pinned()).toEqual([]);
    // folded, it still counts them and says one waits
    expect(head().textContent).toContain("2");
    expect(head().querySelector(".na-dot[data-tone=waiting]")).toBeTruthy();
    expect(localStorage.getItem("nexagent.activeFolded")).toBe("1");
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount({ devices: [device()], sessions: [session({ nativeId: "r1", title: "在跑", state: "running" })] });
    expect(head().getAttribute("aria-expanded")).toBe("false");
    await click(head());
    expect(pinned()).toEqual(["在跑"]);
  });

  it("groups sessions by computer and project, identifies each harness and surfaces actionable states", async () => {
    await mount({
      devices: [device({ id: "dev1", name: "办公室电脑" }), device({ id: "dev2", name: "笔记本", online: false })],
      sessions: [
        session({ nativeId: "1", cwd: "D:\\work\\alpha", title: "修复登录", state: "waiting" }),
        session({ nativeId: "2", engine: "codex", cwd: "D:\\work\\beta", title: "写测试", state: "running", lastActivityAt: 5_000 }),
        session({ deviceId: "dev2", nativeId: "3", cwd: "/home/me/app", title: "整理笔记", online: false }),
      ],
    });
    const devices = [...container.querySelectorAll(".cli-device")];
    expect(devices.map((entry) => entry.querySelector("strong")?.textContent)).toEqual(["办公室电脑", "笔记本"]);
    expect([...devices[0].querySelectorAll(".na-engine")].map((entry) => entry.getAttribute("title"))).toEqual(["Codex · 运行中", "Claude Code · 等你处理"]);
    // the two live sessions are pinned above the computers
    expect([...container.querySelectorAll(".na-active .cli-row-title")].map((entry) => entry.textContent)).toEqual(["写测试", "修复登录"]);
    expect([...container.querySelectorAll(".na-active .na-engine")].map((entry) => entry.getAttribute("data-tone"))).toEqual(["running", "waiting"]);
    expect([...devices[0].querySelectorAll(".na-folder strong")].map((entry) => entry.textContent)).toEqual(["beta", "alpha"]);
    expect(devices[0].querySelector(".na-project > .na-branch > .na-node .cli-row-title")?.textContent).toBe("写测试");
    expect(devices[0].querySelector("[data-group]")).toBeNull();
    const chips = [...container.querySelectorAll(".cli-device .cli-row .cli-chip")].map((entry) => entry.textContent);
    expect(chips).toEqual(["运行中", "等你处理", "电脑离线"]);
    expect(text()).toContain("选择一个会话");
  });

  it("says so when no computer is connected", async () => {
    await mount({ devices: [], sessions: [] });
    expect(text()).toContain("还没有电脑接入");
  });

  it("shows the Core error text when the first read fails", async () => {
    fixture.fetchSnapshot.mockRejectedValue(new CliApiError("raw", "device_offline", 502));
    fixture.fetchSnapshotWithWorkbench.mockRejectedValue(new CliApiError("raw", "device_offline", 502));
    await act(async () => { root.render(createElement(CliAgentsWorkspace, { sidebar: null, dark: false, collapsed: false, onNavigation: () => {}, stream })); });
    await flush();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("电脑离线");
    fixture.fetchSnapshot.mockResolvedValue({ devices: [device()], sessions: [session()] });
    fixture.fetchSnapshotWithWorkbench.mockResolvedValue({ devices: [device()], sessions: [session()], requests: [], workbench: [], queues: [] });
    await click(button("重新加载"));
    await flush();
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(text()).toContain("修复登录");
  });

  it("applies pushed list and delta messages", async () => {
    await mount({ devices: [device()], sessions: [session({ title: "修复登录" })] });
    await act(async () => { socket.open(); });
    expect(socket.messages()).toContainEqual({ type: "sub.list" });
    await act(async () => {
      socket.push({ type: "list.delta", upserts: [session({ nativeId: "2", title: "新任务", state: "running" })], removes: [session().key] });
    });
    expect(text()).toContain("新任务");
    expect(text()).not.toContain("修复登录");
  });

  it("archives a session that has no workbench row yet, by its key", async () => {
    fixture.archiveWorkbenchSession.mockResolvedValue({});
    await mount({ devices: [device()], sessions: [session()] });
    await click(container.querySelector(".na-more"));
    expect([...document.querySelectorAll(".na-menu button")].map((el) => el.textContent)).not.toContain("隐藏");
    await click([...document.querySelectorAll(".na-menu button")].find((el) => el.textContent === "归档会话") ?? null);
    await click([...document.querySelectorAll(".na-dialog button")].find((el) => el.textContent === "归档会话") ?? null);
    await flush();
    expect(fixture.archiveWorkbenchSession).toHaveBeenCalledWith({ key: "dev1:claude:s1" }, true);
    expect(document.querySelector(".na-dialog")).toBeNull();
  });

  it("lists older hidden sessions under 已归档 and restores them", async () => {
    await mount({ devices: [device()], sessions: [session(), session({ nativeId: "2", title: "旧任务", hidden: true })] });
    expect(text()).not.toContain("旧任务");
    await click(button("已归档"));
    expect(text()).toContain("旧任务");
    expect(text()).not.toContain("修复登录");
    await click(container.querySelector(".na-more"));
    await click([...document.querySelectorAll(".na-menu button")].find((el) => el.textContent === "恢复会话") ?? null);
    await flush();
    expect(fixture.hideSession).toHaveBeenCalledWith("dev1:claude:2", false);
    expect(fixture.archiveWorkbenchSession).not.toHaveBeenCalled();
  });

});

describe("session pane", () => {
  it("blocks the composer with a reason when the session runs elsewhere", async () => {
    await mount({ devices: [device()], sessions: [session({ liveIn: "terminal", terminal: undefined })] }, "dev1:claude:s1");
    expect(container.querySelector("[role=tablist]")).toBeNull();
    expect(container.querySelector("[data-testid=cli-composer]")?.textContent).toBe("在电脑上运行");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("continues a stopped session only on send and delivers to the returned key", async () => {
    fixture.continueSession.mockResolvedValue({ key: "dev1:claude:s9" });
    await mount({ devices: [device()], sessions: [session({ state: "stopped", terminal: undefined })] }, "dev1:claude:s1");
    expect(fixture.continueSession).not.toHaveBeenCalled();
    const input=container.querySelector("textarea")!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"继续测试");
      input.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await click(container.querySelector('button[aria-label="发送"]'));
    await flush();
    expect(fixture.continueSession).toHaveBeenCalledWith("dev1:claude:s1", undefined);
    expect(fixture.sendMessage).toHaveBeenCalledWith("dev1:claude:s9","继续测试", expect.objectContaining({ delivery: "send" }));
    expect(localStorage.getItem("nexbot.cliSelected")).toBe("dev1:claude:s9");
  });

  it("continues a stopped session with the model and effort picked in the composer", async () => {
    fixture.continueSession.mockResolvedValue({ key: "dev1:claude:s9" });
    const capable = device({ cliAgents: { ...device().cliAgents!, features: ["launchOptions", "attach"] } });
    await mount({ devices: [capable], sessions: [session({ state: "stopped", terminal: undefined })] }, "dev1:claude:s1");
    await pickModel("Opus");
    expect(document.querySelector(".na-model-menu .model-menu-stops [aria-pressed=true]")?.textContent).toBe("高");
    await pickEffort("中");
    expect(document.querySelector(".na-model-menu .na-model-note")?.textContent).toBe("继续会话时生效");
    expect(container.querySelector('button[aria-label="模型设置"]')?.textContent).toContain("中");
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "继续");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container.querySelector('button[aria-label="发送"]'));
    await flush();
    expect(fixture.continueSession).toHaveBeenCalledWith("dev1:claude:s1", { model: "opus", effort: "medium" });
    expect(JSON.parse(localStorage.getItem("nexagent.launch.dev1:claude:s9")!)).toEqual({ model: "opus", effort: "medium" });
  });

  it("switches a Claude running in a NexBot terminal with /model and /effort before the message", async () => {
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    await pickModel("Sonnet");
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "下一步");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container.querySelector('button[aria-label="发送"]'));
    await flush();
    expect(fixture.sendMessage.mock.calls.map((call) => call[1])).toEqual(["/model sonnet", "/effort high", "下一步"]);
  });

  it("shows how full the context is as a ring, with the numbers when opened", async () => {
    await mount({ devices: [device()], sessions: [session({ context: { used: 776256, window: 1000000 } })] }, "dev1:claude:s1");
    const ring = container.querySelector<HTMLButtonElement>("button[aria-label=上下文用量]")!;
    expect(ring.getAttribute("data-level")).toBe("high");
    expect(ring.getAttribute("title")).toBe("上下文 78% · 776K / 1M");
    expect(ring.querySelector(".na-context-fill")).toBeTruthy();
    await click(ring);
    expect(container.querySelector(".na-context-detail strong")?.textContent).toBe("78%");
    expect(container.querySelector(".na-context-detail small")?.textContent).toBe("已用 776K / 1M tokens");
  });

  it("says there is no usage yet before the session has answered", async () => {
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    const ring = container.querySelector<HTMLButtonElement>("button[aria-label=上下文用量]")!;
    expect(ring.getAttribute("data-level")).toBe("none");
    await click(ring);
    expect(container.querySelector(".na-context-detail small")?.textContent).toBe("还没有记录：会话回复过一次后显示");
  });

  it("lists the models the CLI offers on the computer, as NexBot's menu does", async () => {
    fixture.fetchModels.mockResolvedValue({
      current: "auto/claude-opus-5-5[1m]",
      models: [
        { id: "opus", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "auto/claude-opus-5-5[1m]", label: "Claude Opus 5.5 · routing group", description: "via gateway", efforts: ["low", "medium", "high"] },
      ],
    });
    const capable = device({ cliAgents: { ...device().cliAgents!, features: ["launchOptions", "models"] } });
    await mount({ devices: [capable], sessions: [session()] }, "dev1:claude:s1");
    expect(fixture.fetchModels).toHaveBeenCalledWith("dev1", "claude");
    await click(container.querySelector('button[aria-label="模型设置"]'));
    const rows = [...document.querySelectorAll(".na-model-menu [role=option] .model-menu-name")].map((entry) => entry.textContent);
    expect(rows).toEqual(["默认", "Opus", "Claude Opus 5.5 · routing group"]);
    // the default row names what the CLI's settings choose
    expect(document.querySelector(".na-model-menu [role=option] small")?.textContent).toBe("Claude Opus 5.5 · routing group");
    await pickModel("Claude Opus 5.5 · routing group");
    expect([...document.querySelectorAll(".na-model-menu .model-menu-stops button")].map((entry) => entry.textContent)).toEqual(["低", "中", "高", "很高", "最高"]);
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "继续");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container.querySelector('button[aria-label="发送"]'));
    await flush();
    expect(fixture.sendMessage.mock.calls.map((call) => call[1])).toEqual(["/model auto/claude-opus-5-5[1m]", "/effort high", "继续"]);
  });

  it("sends a message with Enter and shows Core's error text", async () => {
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("跑一下测试");
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    expect(fixture.sendMessage).toHaveBeenCalledWith("dev1:claude:s1", "跑一下测试", expect.objectContaining({ delivery: "send" }));
    expect(box.value).toBe("");

    fixture.sendMessage.mockRejectedValueOnce(new CliApiError("raw", "device_offline", 502));
    await type("再来一次");
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    expect(container.querySelector(".cli-composer-error")?.textContent).toContain("电脑离线");
    expect(box.value).toBe("再来一次");
    // drafts outlive the pane; leave none behind for the next session test
    await type("");
  });

  it("stops a running turn through the workbench contract and pauses the queue", async () => {
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    await click(button("停止"));
    expect(fixture.stopSession).toHaveBeenCalledWith("dev1:claude:s1", expect.any(String));
  });

  it("shows one button while a turn runs: Stop with an empty box, Send once there is text", async () => {
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    const box = container.querySelector("[data-testid=cli-composer]")!;
    const labels = () => [...box.querySelectorAll(".na-stop, button[type=submit]")].map((el) => el.getAttribute("aria-label"));
    const typeInto = async (element: HTMLTextAreaElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(labels()).toEqual(["停止"]);
    await typeInto(box.querySelector("textarea")!, "顺便看一下日志");
    expect(labels()).toEqual(["发送"]);
    await typeInto(box.querySelector("textarea")!, "");
    expect(labels()).toEqual(["停止"]);
  });

  it("titles the pane with the name Core keeps, not the CLI's own title", async () => {
    await mount({
      devices: [device()],
      sessions: [session({ title: "新会话已建立" })],
      workbench: [{ id: "wb1", sessionKey: "dev1:claude:s1", cwd: "D:\\work\\alpha", kind: "fork", title: "修复登录（fork）", archived: false, version: 1 }],
    }, "dev1:claude:s1");
    await flush();
    expect(container.querySelector(".cli-pane-title strong")?.textContent).toBe("修复登录（fork）");
  });

  it("offers the design's composer controls outside the review fixture", async () => {
    await mount({ devices: [device()], sessions: [session({ state: "running", model: "claude-opus" })] }, "dev1:claude:s1");
    const box = container.querySelector("[data-testid=cli-composer]")!;
    expect(box.querySelector("textarea")?.getAttribute("placeholder")).toBe("发消息，或输入 / 使用技能");
    expect(box.querySelector('button[aria-label="添加"]')).not.toBeNull();
    expect(box.querySelector('button[aria-label="上下文用量"]')).not.toBeNull();
    expect(box.querySelector('button[aria-label="模型设置"]')?.querySelector('span')?.textContent).toBe("claude-opus");
    // running with an empty box: only the stop button, no native select, no delivery switch
    expect(box.querySelector("select")).toBeNull();
    expect(box.querySelector("[role=radiogroup]")).toBeNull();
    expect(box.querySelector(".na-stop")?.getAttribute("aria-label")).toBe("停止");
    // a message typed while the agent works chooses between queueing and steering
    await typeText(box.querySelector("textarea")!, "再加个暂停键");
    const radios = [...box.querySelectorAll('[role=radiogroup][aria-label="发送方式"] [role=radio]')];
    expect(radios.map((el) => [el.textContent, el.getAttribute("aria-checked")])).toEqual([["排队", "true"], ["引导", "false"]]);
    await click(radios[1]);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
  });

  it("queues behind a busy Claude inbox without offering an unsupported steer", async () => {
    await mount({ devices: [device()], sessions: [session({ state: "running", liveIn: "terminal", terminal: undefined, sendVia: "inbox" })] }, "dev1:claude:s1");
    await typeText(container.querySelector("textarea")!, "还在吗");
    expect(container.querySelector("[role=radiogroup]")).toBeNull();
    await click(button("发送"));
    expect(fixture.sendMessage).toHaveBeenCalledWith("dev1:claude:s1", "还在吗", expect.objectContaining({ delivery: "queue" }));
  });

  it("shows the paused-queue note only while something waits", async () => {
    fixture.fetchQueue.mockResolvedValue({ workbenchId: "wb", sessionKey: "dev1:claude:s1", paused: true, pauseReason: "stopped", entries: [] });
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    await flush();
    expect(text()).not.toContain("队列已暂停");
  });

  it("shows a sent message at once and empties the box before Core answers", async () => {
    let answer!: (value: unknown) => void;
    fixture.sendMessage.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    await typeText(box, "做个贪吃蛇");
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(box.value).toBe("");
    expect(container.querySelector("[data-testid=cli-user-echo] .cli-bubble")?.textContent).toBe("做个贪吃蛇");
    expect(container.querySelector("[data-testid=cli-working]")).not.toBeNull();
    expect(container.querySelector(".na-busy-icon")).toBeNull();
    await act(async () => { answer({ status: "sent" }); });
    await flush();
  });

  it("puts a message that failed to send back in the box", async () => {
    fixture.sendMessage.mockRejectedValue(new Error("offline"));
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    await typeText(box, "做个贪吃蛇");
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    expect(box.value).toBe("做个贪吃蛇");
    expect(container.querySelector("[data-testid=cli-user-echo]")).toBeNull();
    expect(container.querySelector("[data-testid=cli-working]")).toBeNull();
  });

  it("offers edit-and-resend only for a fresh message nothing answered", async () => {
    const now = Date.now();
    fixture.fetchItems.mockResolvedValue({ more: false, items: [
      { kind: "user", id: "u2", ts: now - 60_000, text: "太久了" },
      { kind: "user", id: "u1", ts: now - 5_000, text: "已经答过" },
      { kind: "assistant", id: "a1", ts: now - 4_000, text: "好的" },
      { kind: "user", id: "u3", ts: now - 2_000, text: "刚发的" },
    ] });
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    await flush();
    const users = [...container.querySelectorAll("[data-testid=cli-user]")];
    expect(users.map((user) => [user.querySelector(".cli-bubble")?.textContent, !!user.querySelector(".na-edit-resend")]))
      .toEqual([["太久了", false], ["已经答过", false], ["刚发的", true]]);
    // no "你 · time" line over the user's own messages
    expect(container.querySelector(".na-byline.is-user")).toBeNull();
  });

  it("edit-and-resend takes the message out of the conversation and back into the box", async () => {
    const now = Date.now();
    fixture.fetchItems.mockResolvedValue({ more: false, items: [{ kind: "user", id: "u1", ts: now - 2_000, text: "做个贪吃蛇" }] });
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    await flush();
    await click(container.querySelector(".na-edit-resend")!);
    expect(container.querySelector("[data-testid=cli-user]")).toBeNull();
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("做个贪吃蛇");
    expect(container.querySelector(".na-revising")).toBeNull();
    // clearing the box drops the edit: the message is back in place
    await typeText(container.querySelector("textarea")!, "");
    expect(container.querySelector("[data-testid=cli-user] .cli-bubble")?.textContent).toBe("做个贪吃蛇");
  });

  it("shows a centred dialog when a model call fails while the page is open, not for old failures", async () => {
    const now = Date.now();
    fixture.fetchItems.mockResolvedValue({ more: false, items: [
      { kind: "user", id: "u0", ts: now - 600_000, text: "旧的" },
      { kind: "notice", id: "old", ts: now - 590_000, level: "error", text: "API Error: 529 overloaded" },
    ] });
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    await flush();
    expect(document.querySelector(".na-failure")).toBeNull();
    await act(async () => { socket.open(); socket.push({ type: "items", key: "dev1:claude:s1", items: [{ kind: "notice", id: "new", ts: Date.now(), level: "error", text: "API Error: Request rejected (429) · credits are used up" }] }); });
    await flush();
    const dialog = document.querySelector("[role=alertdialog].na-failure")!;
    expect(dialog.textContent).toContain("模型调用失败");
    expect(dialog.textContent).toContain("模型服务的额度已用完");
    expect(dialog.textContent).not.toContain("Qoder");
    await click(dialog.querySelector("button")!);
    expect(document.querySelector(".na-failure")).toBeNull();
  });

  it("says a sent message was delivered until the session answers", async () => {
    fixture.sendMessage.mockResolvedValue({ status: "sent" });
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hi");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    // only the dots: no delivery wording under them
    expect(container.querySelector("[data-testid=cli-working] .na-working-dots")).not.toBeNull();
    expect(container.querySelector("[data-testid=cli-working]")?.textContent).not.toContain("已送达");
  });

  it("names the agent once per reply and shows its work as dots in the conversation", async () => {
    fixture.fetchItems.mockResolvedValue({ more: false, items: [
      { kind: "user", id: "u1", ts: 1, text: "第一问" },
      { kind: "assistant", id: "a1", ts: 2, text: "先看看" },
      { kind: "tool", id: "t1", ts: 3, name: "Read", input: "a.ts", status: "ok" },
      { kind: "assistant", id: "a2", ts: 4, text: "看完了" },
      { kind: "user", id: "u2", ts: 5, text: "第二问" },
      { kind: "assistant", id: "a3", ts: 6, text: "继续" },
    ] });
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    const replies = [...container.querySelectorAll("[data-testid=cli-assistant]")];
    expect(replies.map((reply) => !!reply.querySelector(".na-byline"))).toEqual([true, false, true]);
    // the running turn already has a reply: the dots follow it without another name, inside the transcript
    const working = container.querySelector("[data-testid=cli-transcript] [data-testid=cli-working]")!;
    expect(working.querySelector(".na-byline")).toBeNull();
    expect(working.querySelectorAll(".na-working-dots > span")).toHaveLength(3);
    expect(working.textContent).toBe("");
  });

  it("only changes each operation list when its own summary is clicked", async () => {
    const running = toolItem("t1", 1, "running");
    fixture.fetchItems.mockResolvedValue({ more: false, items: [running] });
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    await act(async () => socket.open());
    const lists = () => [...container.querySelectorAll<HTMLDetailsElement>("[data-testid=tool-activity]")];
    const activity = lists()[0];
    expect(activity.open).toBe(false);
    expect(activity.querySelector("summary")?.textContent).toContain("正在执行");
    await click(activity.querySelector("summary"));
    expect(activity.open).toBe(true);
    await click(container.querySelector("textarea"));
    expect(activity.open).toBe(true);

    await act(async () => socket.push({ type: "items", key: "dev1:claude:s1", items: [
      { ...running, status: "ok", output: "完成" }, assistantItem("a1", 2), toolItem("t2", 3, "running"),
    ] }));
    const [first, second] = lists();
    expect(first).toBe(activity);
    expect(first.open).toBe(true);
    expect(first.querySelector("summary")?.textContent).not.toContain("正在执行");
    expect(second.open).toBe(false);
    await click(second.querySelector("summary"));
    expect([first.open, second.open]).toEqual([true, true]);
    await click(first.querySelector("summary"));
    expect([first.open, second.open]).toEqual([false, true]);
  });

  it("does not claim delivery when the computer could not see the message arrive", async () => {
    fixture.sendMessage.mockResolvedValue({ status: "sent", delivery: "unconfirmed" });
    await mount({ devices: [device()], sessions: [session({ state: "idle", liveIn: "terminal", terminal: undefined, sendVia: "inbox" })] }, "dev1:claude:s1");
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "能部署了吗");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    expect(container.querySelector("[data-testid=cli-working] .na-working-dots")).not.toBeNull();
    expect(container.querySelector("[data-testid=cli-composer-note]")?.textContent).toBe("已发送，未确认");
  });

  it("keeps a queued message visible across the send receipt and exposes its queue actions", async () => {
    let resolveQueue!: (queue: unknown) => void;
    fixture.fetchQueue.mockResolvedValueOnce({ workbenchId: "wb", sessionKey: "dev1:claude:s1", paused: false, entries: [] });
    fixture.fetchQueue.mockImplementationOnce(() => new Promise((resolve) => { resolveQueue = resolve; }));
    fixture.sendMessage.mockResolvedValue({ messageId: "q1", queued: true, status: "pending" });
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "稍后");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    expect(container.querySelector("[data-testid=cli-user-echo]")?.textContent).toContain("稍后");
    await act(async () => { resolveQueue({ workbenchId: "wb", sessionKey: "dev1:claude:s1", paused: false,
      entries: [{ id: "q1", seq: 1, text: "稍后", status: "pending", version: 1, createdAt: 1, updatedAt: 1 }] }); });
    expect(container.querySelector("[data-testid=cli-user-echo]")).toBeNull();
    expect(container.querySelector(".na-queued-text")?.textContent).toBe("稍后");
    expect(button("编辑排队消息 1")).not.toBeNull();
    expect(button("引导")).not.toBeNull();
    await click(button("引导"));
    // a running turn with no open question: the steer carries no question to cancel
    expect(fixture.steerQueued).toHaveBeenCalledWith("q1", 1, { questionId: undefined });
  });

  it("renders the transcript the Core returned", async () => {
    fixture.fetchItems.mockResolvedValue({ items: [{ kind: "user", id: "u1", ts: 1, text: "你好" }, { kind: "assistant", id: "a1", ts: 2, text: "已经修好" }], more: false });
    await mount({ devices: [device()], sessions: [session({ terminal: undefined, liveIn: "terminal" })] }, "dev1:claude:s1");
    await flush();
    await flush();
    expect(text()).toContain("你好");
    expect(text()).toContain("已经修好");
  });
});

it("opens attachable sessions directly in chat without subscribing to terminal output", async () => {
  await mount({ devices: [device()], sessions: [session(), session({ nativeId: "s2", title: "写测试" })] }, session().key);
  await act(async () => socket.open());
  await click(container.querySelector('.cli-row-main[title="写测试"]'));
  await flush();
  expect(container.querySelector(".cli-transcript")).not.toBeNull();
  expect(container.querySelector(".cli-composer textarea")).not.toBeNull();
  expect(container.querySelector(".cli-pane [role=tablist]")).toBeNull();
  expect(socket.messages().some(message => message.type === "term.open")).toBe(false);
});

describe("new session", () => {
  const ALPHA = "D:\\work\\alpha";
  const listing = (path: string) => path === ""
    ? { path: "", exists: true, entries: [{ name: "D:\\", path: "D:\\" }] }
    : path === ALPHA ? { path: ALPHA, parent: "D:\\work", exists: true, git: true, entries: [{ name: "src", path: ALPHA + "\\src" }] }
    : path === "D:\\work" ? { path: "D:\\work", parent: "D:\\", exists: true, entries: [{ name: "alpha", path: ALPHA, git: true }, { name: "beta", path: "D:\\work\\beta" }] }
    : { path, parent: "D:\\work", exists: false, entries: [] };
  const capable = () => device({ cliAgents: { ...device().cliAgents!, features: ["launchOptions", "models", "dirs"] } });
  const typeInto = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const openNew = async () => {
    await click(container.querySelector(".na-new-session"));
    await flush();
    return container.querySelector("[data-testid=cli-new-session]")!;
  };
  beforeEach(() => { fixture.listDirs.mockReset(); fixture.listDirs.mockImplementation(async (_device: string, path: string) => listing(path)); });

  it("replaces an open picker when another trigger is activated and dismisses on an outside tap", async () => {
    await mount({ devices: [capable()], sessions: [session({ cwd: ALPHA })] });
    const page = await openNew();
    const trigger = (label: string) => page.querySelector(`button[aria-label="${label}"]`);
    const openPickers = () => [...page.querySelectorAll('[role="dialog"]')].map(panel => panel.getAttribute("aria-label"));

    await click(trigger("运行工具"));
    expect(openPickers()).toEqual(["运行工具"]);
    await click(trigger("模型设置"));
    expect(openPickers()).toEqual(["模型设置"]);
    expect(trigger("运行工具")?.getAttribute("aria-expanded")).toBe("false");
    await click(page.querySelector('[role="dialog"] [role="option"]'));
    expect(openPickers()).toEqual(["模型设置"]);
    await click(trigger("运行工具"));
    expect(openPickers()).toEqual(["运行工具"]);
    const add = trigger("添加");
    await click(add);
    expect(openPickers()).toEqual([]);
    expect(page.querySelector('[aria-label="添加到消息"]')).toBeTruthy();
    await click(trigger("运行工具"));
    expect(openPickers()).toEqual(["运行工具"]);
    expect(page.querySelector('[aria-label="添加到消息"]')).toBeNull();

    const outside = page.querySelector("textarea")!;
    outside.addEventListener("pointerdown", event => event.stopPropagation(), { once: true });
    await act(async () => { outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); });
    expect(openPickers()).toEqual([]);
    expect(trigger("运行工具")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens in the pane, not a dialog, and shows the session with its first message while it starts", async () => {
    let started!: (value: { key: string }) => void;
    fixture.startSession.mockReturnValue(new Promise((resolve) => { started = resolve; }));
    await mount({ devices: [capable()], sessions: [session({ cwd: ALPHA })] });
    const page = await openNew();
    expect(page).toBeTruthy();
    expect(container.querySelector("[role=dialog]")).toBeNull();
    // the newest folder of that computer is chosen
    expect(page.querySelector("button[aria-label=工作目录]")?.textContent).toContain("alpha");
    await typeInto(page.querySelector("textarea")!, "修一下登录页");
    await act(async () => { page.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(container.querySelector("[data-testid=cli-new-session]")).toBeNull();
    expect(fixture.startSession).toHaveBeenCalledWith("dev1", "claude", ALPHA, {});
    const pane = container.querySelector("[data-testid=cli-launch]")!;
    expect(pane.querySelector(".cli-bubble")?.textContent).toBe("修一下登录页");
    expect(pane.querySelector("[data-testid=cli-working] .na-working-dots")).not.toBeNull();

    await act(async () => { started({ key: "dev1:claude:new1" }); });
    await flush();
    expect(fixture.sendMessage).toHaveBeenCalledWith("dev1:claude:new1", "修一下登录页", expect.objectContaining({ delivery: "send" }));
    socket.open();
    await act(async () => { socket.push({ type: "list.delta", upserts: [session({ nativeId: "new1", cwd: ALPHA, state: "running" })], removes: [] }); });
    await flush();
    expect(container.querySelector("[data-testid=cli-launch]")).toBeNull();
    expect(container.querySelector("[data-testid=cli-user-echo] .cli-bubble")?.textContent).toBe("修一下登录页");
    expect(localStorage.getItem("nexbot.cliSelected")).toBe("dev1:claude:new1");
  });

  it("stays in the mobile session list when a background launch is replaced by its real session", async () => {
    const computer = capable();
    const existing = session({ cwd: ALPHA });
    const launched = session({ nativeId: "mobile-new", cwd: ALPHA, title: "手机新会话", lastActivityAt: Date.now() });
    let sent!: (value: { status: string }) => void;
    fixture.startSession.mockResolvedValue({ key: launched.key });
    fixture.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { sent = resolve; }));
    await mount({ devices: [computer], sessions: [existing] }, undefined, { sidebarList: false, onNavigation: () => {} });
    const page = await openNew();
    await typeInto(page.querySelector("textarea")!, "请检查一下");
    await click(page.querySelector('button[type="submit"]'));
    await flush();
    expect(fixture.sendMessage).toHaveBeenCalledWith(launched.key, "请检查一下", expect.objectContaining({ delivery: "send" }));
    await click(container.querySelector('[data-testid="cli-launch"] .cli-back'));
    const app = container.querySelector(".cli-app")!;
    expect(app.getAttribute("data-mobile")).toBe("list");

    fixture.fetchSnapshot.mockResolvedValue({ devices: [computer], sessions: [existing, launched] });
    fixture.fetchItems.mockResolvedValue({ more: false, items: [assistantItem("first-reply", Date.now(), "检查好了")] });
    await act(async () => sent({ status: "sent" }));
    await flush();
    expect(container.querySelector('[data-testid="cli-launch"]')).toBeNull();
    expect(localStorage.getItem("nexbot.cliSelected")).toBe(launched.key);
    expect(app.getAttribute("data-mobile")).toBe("list");

    await click(container.querySelector('.cli-side button[title="手机新会话"]'));
    expect(app.getAttribute("data-mobile")).toBe("pane");
    expect(container.querySelector('[data-testid="cli-assistant"]')?.textContent).toContain("检查好了");
  });

  it("browses up and down, and creates a typed folder that does not exist", async () => {
    fixture.startSession.mockResolvedValue({ key: "dev1:claude:new4" });
    await mount({ devices: [capable()], sessions: [session({ cwd: ALPHA })] });
    const page = await openNew();
    await click(page.querySelector("button[aria-label=工作目录]"));
    await flush();
    const menu = () => document.querySelector(".na-dir-menu")!;
    const names = () => [...menu().querySelectorAll(".na-dir-row .na-dir-name")].map((row) => row.textContent);
    await flush();
    expect(names()).toEqual(["src"]);
    await click(menu().querySelector("button[aria-label=上一级]"));
    await flush();
    expect(names()).toEqual(["alpha", "beta"]);
    // down again, then a name that is not there becomes a new folder
    await click([...menu().querySelectorAll<HTMLButtonElement>(".na-dir-main")].find((button) => button.textContent?.includes("beta"))!);
    await flush();
    expect(fixture.listDirs).toHaveBeenLastCalledWith("dev1", "D:\\work\\beta");
    await click(menu().querySelector("button[aria-label=上一级]"));
    await flush();
    await typeInto(menu().querySelector("input")!, "gamma");
    expect(names()).toEqual(["新建文件夹 gamma"]);
    await act(async () => { menu().querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(page.querySelector("button[aria-label=工作目录]")?.textContent).toContain("gamma新建");
    await act(async () => { page.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(fixture.startSession).toHaveBeenCalledWith("dev1", "claude", "D:\\work\\gamma", { createDir: true });
  });

  it("offers a worktree for a Git folder, named nexagent/<random> unless changed", async () => {
    fixture.startSession.mockResolvedValue({ key: "dev1:claude:new2" });
    await mount({ devices: [capable()], sessions: [session({ cwd: ALPHA })] });
    const page = await openNew();
    await flush();
    const worktree = [...page.querySelectorAll("label")].find((label) => label.textContent === "Worktree")!.querySelector("input")!;
    expect(worktree.checked).toBe(false);
    await click(worktree);
    expect(worktree.checked).toBe(true);
    expect(page.querySelector("button[aria-label=分支名称]")?.textContent).toMatch(/^nexagent\/[a-z0-9]{6}$/);
    await click(page.querySelector("button[aria-label=分支名称]"));
    const branch = document.querySelector<HTMLInputElement>("input[aria-label=新分支名称]")!;
    expect(branch.value).toMatch(/^nexagent\/[a-z0-9]{6}$/);
    await typeInto(branch, "nexagent/login fix");
    expect(page.querySelector<HTMLButtonElement>("button[aria-label=发送]")!.disabled).toBe(true);
    await typeInto(branch, "nexagent/login-fix");
    await act(async () => { page.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(fixture.startSession).toHaveBeenCalledWith("dev1", "claude", ALPHA, expect.objectContaining({ worktreeBranch: "nexagent/login-fix", requestId: expect.any(String) }));
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps a failed start on the pane with a retry that reuses the worktree request", async () => {
    fixture.startSession.mockRejectedValueOnce(new CliApiError("工作树已存在", "invalid", 400, "工作树已存在")).mockResolvedValue({ key: "dev1:claude:new3" });
    await mount({ devices: [capable()], sessions: [session({ cwd: ALPHA })] });
    const page = await openNew();
    await flush();
    await click([...page.querySelectorAll("label")].find((label) => label.textContent === "Worktree")!.querySelector("input"));
    await act(async () => { page.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(container.querySelector("[data-testid=cli-launch] [role=alert]")?.textContent).toContain("工作树已存在");
    await click(button("重试"));
    await flush();
    const [first, second] = fixture.startSession.mock.calls.map((call) => call[3]);
    expect(second.requestId).toBe(first.requestId);
    expect(second.worktreeBranch).toBe(first.worktreeBranch);
  });

  it("is the same message box: images picked with + go to Core once the session runs", async () => {
    fixture.startSession.mockResolvedValue({ key: "dev1:claude:new5" });
    fixture.uploadAttachment.mockReset();
    fixture.uploadAttachment.mockResolvedValue({ path: "/api/cli-agents/images/12345678-0000-4000-8000-000000000000" });
    await mount({ devices: [device({ cliAgents: { ...device().cliAgents!, features: ["launchOptions", "models", "dirs", "attach"] } })], sessions: [session({ cwd: ALPHA })] });
    const page = await openNew();
    expect(page.querySelector("[data-testid=cli-composer] .na-add-trigger")).toBeTruthy();
    const picker = page.querySelector<HTMLInputElement>("input[aria-label=选择图片]")!;
    Object.defineProperty(picker, "files", { configurable: true, value: [new File([new Uint8Array([137, 80])], "shot.png", { type: "image/png" })] });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(page.querySelector(".na-file-chip")?.textContent).toContain("shot.png");
    await typeInto(page.querySelector("textarea")!, "看看这张图");
    await act(async () => { page.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(fixture.uploadAttachment).toHaveBeenCalledWith("dev1:claude:new5", expect.any(File));
    expect(fixture.sendMessage).toHaveBeenCalledWith("dev1:claude:new5", "看看这张图\n\n![shot.png](/api/cli-agents/images/12345678-0000-4000-8000-000000000000)", expect.objectContaining({ delivery: "send" }));
  });

  it("names why a computer cannot start a session", async () => {
    await mount({ devices: [device({ online: false })], sessions: [] });
    const page = await openNew();
    expect(page.querySelector(".na-new-path")?.textContent).toBe("电脑离线");
    expect(page.querySelector<HTMLButtonElement>("button[aria-label=发送]")!.disabled).toBe(true);
  });
});

const row = (overrides: Record<string, unknown>) => ({ id: "row", sessionKey: null, deviceId: "dev1", engine: "claude", cwd: "D:\\work\\alpha", parentId: null, kind: "main", title: "", archived: false, version: 1, ...overrides });

async function chooseFork() {
  await click(container.querySelector(".na-more"));
  await click([...document.querySelectorAll(".na-menu button")].find((el) => el.textContent === "创建分支") ?? null);
  await flush();
}

describe("fork", () => {
  it("starts the child as a real context fork of the parent", async () => {
    fixture.branchSession.mockResolvedValue({ id: "row-fork", parentId: "row-main", version: 1 });
    fixture.startSession.mockResolvedValue({ key: "dev1:claude:f1" });
    await mount({ devices: [device()], sessions: [session()] });
    await chooseFork();
    expect(fixture.branchSession).toHaveBeenCalledTimes(1);
    expect(fixture.startSession).toHaveBeenCalledWith("dev1", "claude", "D:\\work\\alpha", { parentId: "row-fork", forkFrom: "dev1:claude:s1" });
    expect(fixture.deleteWorkbenchSession).not.toHaveBeenCalled();
  });

  it("settles the pending row and shows the device's refusal when the start fails", async () => {
    fixture.branchSession.mockResolvedValue({ id: "row-fork", parentId: "row-main", version: 1 });
    fixture.startSession.mockRejectedValue(new CliApiError("raw", "invalid", 400, "电脑端版本过旧，无法分支"));
    fixture.deleteWorkbenchSession.mockResolvedValue({});
    await mount({ devices: [device()], sessions: [session()] });
    await chooseFork();
    expect(fixture.deleteWorkbenchSession).toHaveBeenCalledWith({ id: "row-fork", expectedVersion: 1 });
    expect([...container.querySelectorAll("[role=alert]")].map((entry) => entry.textContent)).toContain("电脑端版本过旧，无法分支");
  });
});

describe("side chats from Core", () => {
  it("lists the side rows of the open session as tabs, keeps them out of the tree and survives a reload", async () => {
    const rows = {
      devices: [device()],
      sessions: [session(), session({ nativeId: "side1", title: "侧边的会话" }), session({ nativeId: "other", title: "别的会话" }), session({ nativeId: "side2", title: "别处的侧聊" })],
    };
    const workbench = [
      row({ id: "main", sessionKey: "dev1:claude:s1" }),
      row({ id: "side-a", sessionKey: "dev1:claude:side1", parentId: "main", kind: "side", title: "竞态条件" }),
      row({ id: "other", sessionKey: "dev1:claude:other" }),
      row({ id: "side-b", sessionKey: "dev1:claude:side2", parentId: "other", kind: "side", title: "不属于这里" }),
    ];
    fixture.fetchSnapshot.mockResolvedValue(rows);
    fixture.fetchSnapshotWithWorkbench.mockResolvedValue({ ...rows, workbench, queues: [] });
    localStorage.setItem("nexbot.cliSelected", "dev1:claude:s1");
    const render = () => act(async () => { root.render(createElement(CliAgentsWorkspace, { sidebar: createElement("div"), dark: false, collapsed: false, onNavigation: () => {}, stream })); });
    await render();
    await flush();
    // never in the left tree
    const rowTitles = () => [...container.querySelectorAll(".cli-row-title")].map((entry) => entry.textContent);
    expect(rowTitles()).toContain("别的会话");
    expect(rowTitles()).not.toContain("侧边的会话");
    expect(rowTitles()).not.toContain("别处的侧聊");
    // a reload reads the same rows again: only this session's own side chat is a tab, one click away
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render();
    await flush();
    expect(rowTitles()).not.toContain("侧边的会话");
    expect(container.querySelector(".na-side")).toBeNull();
    expect(button("侧边会话 1")).not.toBeNull();
    await click(button("侧边会话 1"));
    await flush();
    const tabs = [...container.querySelectorAll(".na-side [role=tab]")].map((entry) => entry.textContent);
    expect(tabs).toEqual(["竞态条件"]);
    expect(button("侧边会话 1")).toBeNull();
    expect(container.querySelector(".na-side .cli-pane")).not.toBeNull();
  });

  it("does not offer a side chat for a session whose computer is offline or cannot run its tool", async () => {
    await mount({ devices: [device({ online: false })], sessions: [session({ online: false })] }, "dev1:claude:s1");
    expect(container.querySelector('button[aria-label="新建侧边聊天"]')).toBeNull();
  });
});
