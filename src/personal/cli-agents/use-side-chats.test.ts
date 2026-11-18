// @vitest-environment happy-dom
// The production side chat: nothing exists in Core until the first send, which
// makes the row, starts the session bound to it and sends the quoted message.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliApiError } from "./api";
import { session } from "./fixtures";

const api = vi.hoisted(() => ({
  branchSession: vi.fn(),
  startSession: vi.fn(),
  sendMessage: vi.fn(),
  deleteWorkbenchSession: vi.fn(),
}));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...api }));

import { useSideChats, type SideChatHost } from "./use-side-chats";

const parent = session();
type Chats = ReturnType<typeof useSideChats>;
let latest: Chats;
let root: Root;
let container: HTMLDivElement;

function Harness(props: { sessions: ReturnType<typeof session>[]; host: SideChatHost }) {
  latest = useSideChats(parent.key, props.sessions, props.host);
  return null;
}

const emptyHost = () => ({ meta: new Map<string, never>() as SideChatHost["meta"], refresh: vi.fn() });
async function mount(host: SideChatHost, sessions = [parent]) {
  await act(async () => { root.render(createElement(Harness, { sessions, host })); });
}
const open = (quote = "竞态条件", fresh = false) => act(async () => { await latest.open(parent, quote, "m1", fresh); });
const send = (text: string) => act(async () => { await latest.send(latest.draft!, text); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.branchSession.mockResolvedValue({ id: "row-side", parentId: "row-main", version: 1 });
  api.startSession.mockResolvedValue({ key: "dev1:claude:side1" });
  api.sendMessage.mockResolvedValue({ status: "sent" });
  api.deleteWorkbenchSession.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("first send", () => {
  it("opens a draft tab without touching Core", async () => {
    await mount(emptyHost());
    await open();
    expect(latest.draft?.quote).toBe("竞态条件");
    expect(latest.tabs.map((tab) => tab.title)).toEqual(["竞态条件"]);
    expect(api.branchSession).not.toHaveBeenCalled();
    expect(api.startSession).not.toHaveBeenCalled();
  });

  it("creates the row, starts the bound session and sends the quote with the text, once each", async () => {
    const host = emptyHost();
    await mount(host);
    await open();
    await send("这里为什么会竞态？");
    expect(api.branchSession).toHaveBeenCalledTimes(1);
    expect(api.branchSession).toHaveBeenCalledWith(parent.key, "竞态条件", expect.any(String), "side");
    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(api.startSession).toHaveBeenCalledWith("dev1", "claude", parent.cwd, { parentId: "row-side" });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith("dev1:claude:side1", "引用「竞态条件」\n\n这里为什么会竞态？", {
      delivery: "send", clientMessageId: expect.any(String), requestId: expect.any(String),
    });
    expect(latest.draft).toMatchObject({ sent: true, target: "dev1:claude:side1", busy: false });
    expect(host.refresh).toHaveBeenCalled();
  });

  it("sends a plain message when the tab was opened without a quote", async () => {
    await mount(emptyHost());
    await open("", true);
    await send("随便问问");
    expect(api.sendMessage).toHaveBeenCalledWith("dev1:claude:side1", "随便问问", expect.anything());
    expect(api.branchSession).toHaveBeenCalledWith(parent.key, "侧边聊天", expect.any(String), "side");
  });

  it("retries a failed send without a second row or session, with the same ids", async () => {
    await mount(emptyHost());
    await open();
    api.sendMessage.mockRejectedValueOnce(new CliApiError("raw", "device_offline", 502));
    await expect(send("问题")).rejects.toThrow();
    await act(async () => {});
    expect(latest.draft?.sent).toBeFalsy();
    expect(latest.draft?.busy).toBe(false);
    await send("问题");
    expect(api.branchSession).toHaveBeenCalledTimes(1);
    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const [first, second] = api.sendMessage.mock.calls;
    expect(second[0]).toBe(first[0]);
    expect(second[2].requestId).toBe(first[2].requestId);
    expect(second[2].clientMessageId).toBe(first[2].clientMessageId);
    expect(latest.draft?.sent).toBe(true);
  });

  it("reuses the row when only the start failed, and takes new ids when the words changed", async () => {
    await mount(emptyHost());
    await open();
    api.startSession.mockRejectedValueOnce(new CliApiError("raw", "device_offline", 502));
    await expect(send("问题")).rejects.toThrow();
    expect(api.sendMessage).not.toHaveBeenCalled();
    api.sendMessage.mockRejectedValueOnce(new CliApiError("raw", "busy", 409));
    await expect(send("问题")).rejects.toThrow();
    expect(api.branchSession).toHaveBeenCalledTimes(1);
    expect(api.startSession).toHaveBeenCalledTimes(2);
    expect(api.startSession.mock.calls[1][3]).toEqual({ parentId: "row-side" });
    await send("换个问法");
    expect(api.startSession).toHaveBeenCalledTimes(2);
    const [first, second] = api.sendMessage.mock.calls;
    expect(second[1]).toContain("换个问法");
    expect(second[2].requestId).not.toBe(first[2].requestId);
  });

  it("waits for a session the device has not listed yet", async () => {
    await mount(emptyHost());
    await open();
    api.sendMessage.mockRejectedValueOnce(new CliApiError("raw", "not_found", 404)).mockRejectedValueOnce(new CliApiError("raw", "not_found", 404));
    await send("问题");
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    expect(api.branchSession).toHaveBeenCalledTimes(1);
    expect(api.startSession).toHaveBeenCalledTimes(1);
  });

  it("settles a row that never got a session when its draft is closed", async () => {
    await mount(emptyHost());
    await open();
    api.startSession.mockRejectedValueOnce(new CliApiError("raw", "device_offline", 502));
    await expect(send("问题")).rejects.toThrow();
    await act(async () => { latest.close(latest.draft!.id); });
    expect(api.deleteWorkbenchSession).toHaveBeenCalledWith({ id: "row-side", expectedVersion: 1 });
    expect(latest.tabs).toEqual([]);
  });
});

describe("drafts and tabs", () => {
  it("keeps drafts independent and keeps them when switching tabs", async () => {
    await mount(emptyHost());
    await open("第一段");
    const first = latest.draft!;
    await open("第二段");
    const second = latest.draft!;
    expect(second.id).not.toBe(first.id);
    expect(latest.tabs.map((tab) => tab.title)).toEqual(["第一段", "第二段"]);
    await act(async () => { latest.select(first.id); });
    expect(latest.draft?.quote).toBe("第一段");
    await send("只发第一个");
    expect(api.branchSession).toHaveBeenCalledTimes(1);
    expect(api.branchSession).toHaveBeenCalledWith(parent.key, "第一段", expect.any(String), "side");
    // the second draft has not started anything and is still there
    await act(async () => { latest.select(second.id); });
    expect(latest.draft?.quote).toBe("第二段");
    expect(latest.draft?.sent).toBeFalsy();
    expect(latest.tabs).toHaveLength(2);
  });

  it("lists Core's side rows of the open session as tabs again after a reload, and nothing else", async () => {
    const side = session({ nativeId: "side1", title: "x" });
    const elsewhere = session({ nativeId: "side2", title: "y" });
    const plain = session({ nativeId: "plain", title: "z" });
    const meta = new Map<ReturnType<typeof session>["key"], { title: string; parent?: ReturnType<typeof session>["key"] | null; kind?: "fork" | "side" }>([
      [side.key, { title: "竞态条件", parent: parent.key, kind: "side" }],
      [elsewhere.key, { title: "别的", parent: plain.key, kind: "side" }],
      [plain.key, { title: "普通" }],
    ]);
    await mount({ meta, refresh: vi.fn() }, [parent, side, elsewhere, plain]);
    expect(latest.tabs).toEqual([{ id: side.key, title: "竞态条件" }]);
    await act(async () => { latest.select(side.key); });
    expect(latest.session?.key).toBe(side.key);
    // a draft that was sent shows once as the session, not twice
    await open("引文");
    api.startSession.mockResolvedValue({ key: side.key });
    await send("问");
    expect(latest.tabs.map((tab) => tab.id)).toEqual([latest.draft!.id]);
  });

  it("does nothing outside the preview when no host is given", async () => {
    await act(async () => { root.render(createElement(() => { latest = useSideChats(parent.key, [parent]); return null; })); });
    await open();
    expect(latest.tabs).toEqual([]);
  });
});
