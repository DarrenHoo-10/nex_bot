// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliApiError } from "./api";
import { device, session } from "./fixtures";
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
const text = () => container.textContent ?? "";
const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); });
const button = (label: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label || entry.getAttribute("aria-label") === label) ?? null;

async function mount(rows: { devices: ReturnType<typeof device>[]; sessions: ReturnType<typeof session>[]; workbench?: unknown[] }, selected?: string) {
  fixture.fetchSnapshot.mockResolvedValue(rows);
  fixture.fetchSnapshotWithWorkbench.mockResolvedValue({ ...rows, workbench: rows.workbench ?? [], queues: [] });
  if (selected) localStorage.setItem("nexbot.cliSelected", selected);
  await act(async () => {
    root.render(createElement(CliAgentsWorkspace, { sidebar: createElement("div", { "data-testid": "sidebar" }), dark: false, collapsed: false, onNavigation: () => {}, stream }));
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  localStorage.clear();
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
    expect([...devices[0].querySelectorAll(".na-engine")].map((entry) => entry.getAttribute("title"))).toEqual(["Codex", "Claude Code"]);
    expect([...devices[0].querySelectorAll(".na-folder strong")].map((entry) => entry.textContent)).toEqual(["beta", "alpha"]);
    expect(devices[0].querySelector(".na-project > .na-branch > .na-node .cli-row-title")?.textContent).toBe("写测试");
    expect(devices[0].querySelector("[data-group]")).toBeNull();
    const chips = [...container.querySelectorAll(".cli-row .cli-chip")].map((entry) => entry.textContent);
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
    await click(container.querySelector('button[aria-label="模型设置"]'));
    const pick = async (label: string, value: string) => {
      const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      expect(select.disabled).toBe(false);
      await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    };
    await pick("模型", "opus");
    await pick("推理强度", "high");
    expect(container.querySelector('[data-panel="model"] small')?.textContent).toBe("继续会话时生效");
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "继续");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container.querySelector('button[aria-label="发送"]'));
    await flush();
    expect(fixture.continueSession).toHaveBeenCalledWith("dev1:claude:s1", { model: "opus", effort: "high" });
    expect(JSON.parse(localStorage.getItem("nexagent.launch.dev1:claude:s9")!)).toEqual({ model: "opus", effort: "high" });
  });

  it("switches a Claude running in a NexBot terminal with /model and /effort before the message", async () => {
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    await click(container.querySelector('button[aria-label="模型设置"]'));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!;
    await act(async () => { select.value = "sonnet"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "下一步");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container.querySelector('button[aria-label="发送"]'));
    await flush();
    expect(fixture.sendMessage.mock.calls.map((call) => call[1])).toEqual(["/model sonnet", "下一步"]);
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
  });

  it("stops a running turn through the workbench contract and pauses the queue", async () => {
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    await click(button("停止"));
    expect(fixture.stopSession).toHaveBeenCalledWith("dev1:claude:s1", expect.any(String));
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
    expect(box.querySelector('button[aria-label="模型设置"]')?.textContent).toBe("claude-opus");
    // running: a segmented switch and a stop button, no native select
    expect(box.querySelector("select")).toBeNull();
    const radios = [...box.querySelectorAll('[role=radiogroup][aria-label="发送方式"] [role=radio]')];
    expect(radios.map((el) => [el.textContent, el.getAttribute("aria-checked")])).toEqual([["排队", "true"], ["引导", "false"]]);
    await click(radios[1]);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(box.querySelector(".na-stop")?.getAttribute("aria-label")).toBe("停止");
  });

  it("keeps the delivery switch away from sessions that ignore it", async () => {
    await mount({ devices: [device()], sessions: [session({ state: "running", liveIn: "terminal", terminal: undefined, sendVia: "inbox" })] }, "dev1:claude:s1");
    expect(container.querySelector("[role=radiogroup]")).toBeNull();
  });

  it("shows the paused-queue note only while something waits", async () => {
    fixture.fetchQueue.mockResolvedValue({ workbenchId: "wb", sessionKey: "dev1:claude:s1", paused: true, pauseReason: "stopped", entries: [] });
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    await flush();
    expect(text()).not.toContain("队列已暂停");
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
    expect(container.querySelector(".na-progress")?.textContent).toBe("已送达，等待回复…");
  });

  it("does not claim delivery for a message that only joined the queue", async () => {
    fixture.sendMessage.mockResolvedValue({ queued: true, status: "pending" });
    await mount({ devices: [device()], sessions: [session()] }, "dev1:claude:s1");
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "稍后");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    expect(container.querySelector(".na-progress")).toBeNull();
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
  it("starts a session in an absolute folder and opens it", async () => {
    fixture.startSession.mockResolvedValue({ key: "dev1:claude:new1" });
    await mount({ devices: [device()], sessions: [session({ cwd: "D:\\work\\alpha" })] });
    await click(container.querySelector(".cli-device header button[aria-label$='上新建会话']"));
    const input = container.querySelector<HTMLInputElement>(".cli-dialog input")!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("relative/path");
    expect(container.querySelector(".cli-dialog [role=alert]")?.textContent).toBe("需要绝对路径");
    expect(container.querySelector<HTMLButtonElement>(".cli-dialog button[type=submit]")!.disabled).toBe(true);
    await click(button("alpha"));
    await act(async () => { container.querySelector(".cli-dialog")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(fixture.startSession).toHaveBeenCalledWith("dev1", "claude", "D:\\work\\alpha");
    expect(container.querySelector("[role=dialog]")).toBeNull();
    expect(localStorage.getItem("nexbot.cliSelected")).toBe("dev1:claude:new1");
  });

  it("names why a computer cannot start a session", async () => {
    await mount({ devices: [device({ online: false })], sessions: [] });
    await click(container.querySelector(".cli-device header button[aria-label$='上新建会话']"));
    expect(container.querySelector(".cli-dialog [role=status]")?.textContent).toBe("电脑离线");
    expect(container.querySelector<HTMLButtonElement>(".cli-dialog button[type=submit]")!.disabled).toBe(true);
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
