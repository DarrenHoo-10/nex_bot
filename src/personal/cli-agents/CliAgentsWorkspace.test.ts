// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliApiError } from "./api";
import { device, session } from "./fixtures";
import { CliStream, type SocketLike } from "./stream";

const fixture = vi.hoisted(() => ({
  fetchSnapshot: vi.fn(),
  fetchItems: vi.fn(),
  startSession: vi.fn(),
  continueSession: vi.fn(),
  sendMessage: vi.fn(),
  interruptSession: vi.fn(),
  openLocal: vi.fn(),
  hideSession: vi.fn(),
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

async function mount(rows: { devices: ReturnType<typeof device>[]; sessions: ReturnType<typeof session>[] }, selected?: string) {
  fixture.fetchSnapshot.mockResolvedValue(rows);
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
  for (const key of ["fetchSnapshot", "fetchItems", "startSession", "continueSession", "sendMessage", "interruptSession", "openLocal", "hideSession"] as const) fixture[key].mockReset();
  fixture.fetchItems.mockResolvedValue({ items: [], more: false });
  fixture.sendMessage.mockResolvedValue({});
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
    await act(async () => { root.render(createElement(CliAgentsWorkspace, { sidebar: null, dark: false, collapsed: false, onNavigation: () => {}, stream })); });
    await flush();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("电脑离线");
    fixture.fetchSnapshot.mockResolvedValue({ devices: [device()], sessions: [session()] });
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

  it("hides a session at once and puts it back when Core refuses", async () => {
    await mount({ devices: [device()], sessions: [session()] });
    fixture.hideSession.mockRejectedValueOnce(new CliApiError("x", "device_offline", 502));
    await click(container.querySelector(".na-more"));
    await click([...document.querySelectorAll(".na-menu button")].find(el=>el.textContent==="隐藏")??null);
    await flush();
    expect(fixture.hideSession).toHaveBeenCalledWith("dev1:claude:s1", true);
    expect(text()).toContain("修复登录");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("电脑离线");
  });

  it("keeps hidden sessions behind a toggle", async () => {
    await mount({ devices: [device()], sessions: [session(), session({ nativeId: "2", title: "旧任务", hidden: true })] });
    expect(text()).not.toContain("旧任务");
    await click(button("已隐藏 1"));
    expect(text()).toContain("旧任务");
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
    expect(fixture.continueSession).toHaveBeenCalledWith("dev1:claude:s1");
    expect(fixture.sendMessage).toHaveBeenCalledWith("dev1:claude:s9","继续测试");
    expect(localStorage.getItem("nexbot.cliSelected")).toBe("dev1:claude:s9");
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
    expect(fixture.sendMessage).toHaveBeenCalledWith("dev1:claude:s1", "跑一下测试");
    expect(box.value).toBe("");

    fixture.sendMessage.mockRejectedValueOnce(new CliApiError("raw", "device_offline", 502));
    await type("再来一次");
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    expect(container.querySelector(".cli-composer-error")?.textContent).toContain("电脑离线");
    expect(box.value).toBe("再来一次");
  });

  it("offers an interrupt while the session runs", async () => {
    fixture.interruptSession.mockResolvedValue({});
    await mount({ devices: [device()], sessions: [session({ state: "running" })] }, "dev1:claude:s1");
    await click(button("中断"));
    expect(fixture.interruptSession).toHaveBeenCalledWith("dev1:claude:s1");
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
