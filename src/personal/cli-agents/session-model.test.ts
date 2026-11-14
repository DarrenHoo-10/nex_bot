// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { device, session } from "./fixtures";
import { newlyWaiting, notifyWaiting, sessionStates } from "./notifications";
import { canAttach, composerMode, deviceBlocker, folderLabel, groupSessions, hiddenCount, recentCwds, sendsOutside, sessionStatusLabel, sessionTitle, waitingCount } from "./session-model";

describe("grouping", () => {
  it("groups by computer, then folder, newest first, online computers first", () => {
    const groups = groupSessions(
      [device({ id: "b", name: "笔记本", online: false }), device({ id: "a", name: "办公室电脑" })],
      [
        session({ deviceId: "a", nativeId: "1", cwd: "D:\\work\\alpha", lastActivityAt: 10 }),
        session({ deviceId: "a", nativeId: "2", cwd: "D:\\work\\beta", lastActivityAt: 30 }),
        session({ deviceId: "a", nativeId: "3", cwd: "D:\\work\\alpha", lastActivityAt: 20 }),
        session({ deviceId: "b", nativeId: "4", cwd: "/home/me/app", online: false }),
      ],
    );
    expect(groups.map((group) => group.device.id)).toEqual(["a", "b"]);
    expect(groups[0].folders.map((folder) => folder.label)).toEqual(["beta", "alpha"]);
    expect(groups[0].folders[1].sessions.map((row) => row.nativeId)).toEqual(["3", "1"]);
    expect(groups[1].folders[0].label).toBe("app");
  });

  it("keeps a computer without sessions and invents one for orphan sessions", () => {
    const groups = groupSessions([device({ id: "empty", name: "空电脑" })], [session({ deviceId: "ghost", key: "ghost:claude:s1" })]);
    expect(groups.map((group) => [group.device.id, group.count])).toEqual([["empty", 0], ["ghost", 1]]);
  });

  it("hides hidden sessions unless asked", () => {
    const rows = [session({ nativeId: "1" }), session({ nativeId: "2", hidden: true })];
    expect(groupSessions([device()], rows)[0].count).toBe(1);
    expect(groupSessions([device()], rows, true)[0].count).toBe(2);
    expect(hiddenCount(rows)).toBe(1);
  });

  it("lists recent folders of one computer", () => {
    const rows = [session({ nativeId: "1", cwd: "/a", lastActivityAt: 1 }), session({ nativeId: "2", cwd: "/b", lastActivityAt: 5 }), session({ nativeId: "3", cwd: "/a", lastActivityAt: 9 }), session({ deviceId: "x", key: "x:claude:s", cwd: "/z" })];
    expect(recentCwds(rows, "dev1")).toEqual(["/a", "/b"]);
  });

  it("labels folders and titles", () => {
    expect(folderLabel("D:\\work\\alpha\\")).toBe("alpha");
    expect(folderLabel("")).toBe("未知目录");
    expect(sessionTitle(session({ title: " " }))).toBe("Claude 会话");
    expect(sessionTitle(session({ title: "修复登录" }))).toBe("修复登录");
  });
});

describe("status", () => {
  it("names each state and lets offline win", () => {
    expect(sessionStatusLabel({ state: "running", online: true })).toBe("运行中");
    expect(sessionStatusLabel({ state: "waiting", online: true })).toBe("等你处理");
    expect(sessionStatusLabel({ state: "idle", online: true })).toBe("空闲");
    expect(sessionStatusLabel({ state: "stopped", online: true })).toBe("已停止");
    expect(sessionStatusLabel({ state: "running", online: false })).toBe("电脑离线");
  });

  it("counts waiting sessions that are visible and online", () => {
    expect(waitingCount([session({ state: "waiting" }), session({ nativeId: "2", state: "waiting", hidden: true }), session({ nativeId: "3", state: "waiting", online: false }), session({ nativeId: "4" })])).toBe(1);
  });
});

describe("what the composer offers", () => {
  it("sends in a nex_bot terminal, with interrupt while running", () => {
    expect(composerMode(session())).toEqual({ kind: "send", running: false });
    expect(composerMode(session({ state: "running" }))).toEqual({ kind: "send", running: true });
  });

  it("offers continue for a stopped session", () => {
    expect(composerMode(session({ state: "stopped" }))).toEqual({ kind: "stopped", hint: undefined });
  });

  it("sends to a session on the computer through its inbox or daemon, without an interrupt", () => {
    for (const sendVia of ["inbox", "daemon"] as const) {
      expect(composerMode(session({ liveIn: "terminal", terminal: undefined, sendVia }))).toEqual({ kind: "send", running: false, outside: true });
      expect(composerMode(session({ liveIn: "desktop", terminal: undefined, state: "running", sendVia }))).toEqual({ kind: "send", running: false, outside: true });
    }
    expect(sendsOutside(session({ sendVia: "terminal" }))).toBe(false);
    expect(sendsOutside(session())).toBe(false);
  });

  it("still blocks an offline or stopped session that has a route", () => {
    expect(composerMode(session({ sendVia: "inbox", online: false }))).toEqual({ kind: "blocked", hint: "电脑离线" });
    expect(composerMode(session({ sendVia: "inbox", state: "stopped" }))).toEqual({ kind: "stopped", hint: undefined });
  });

  it("keeps the terminal composer for a session in a nex_bot terminal", () => {
    expect(composerMode(session({ sendVia: "terminal", state: "running" }))).toEqual({ kind: "send", running: true });
  });

  it("explains why it cannot send", () => {
    expect(composerMode(session({ online: false }))).toEqual({ kind: "blocked", hint: "电脑离线" });
    expect(composerMode(session({ liveIn: "terminal", terminal: undefined }))).toEqual({ kind: "blocked", hint: "在电脑上运行" });
    expect(composerMode(session({ liveIn: "desktop", terminal: undefined }))).toEqual({ kind: "blocked", hint: "在 Claude 桌面应用中打开" });
  });

  it("attaches only to a live nex_bot terminal", () => {
    expect(canAttach(session())).toBe(true);
    expect(canAttach(session({ terminal: undefined }))).toBe(false);
    expect(canAttach(session({ state: "stopped" }))).toBe(false);
    expect(canAttach(session({ liveIn: "terminal" }))).toBe(false);
  });
});

describe("new session blockers", () => {
  it("names the reason a computer cannot start one", () => {
    expect(deviceBlocker(device())).toBeNull();
    expect(deviceBlocker(device({ online: false }))).toBe("电脑离线");
    expect(deviceBlocker(device({ cliAgents: null }))).toBe("未开启 Agent 会话");
    expect(deviceBlocker(device({ cliAgents: { version: 1, engines: [], terminal: { name: "herdr-core", version: "0.1.21", ready: true } } }))).toBe("找不到 Claude 或 Codex");
    expect(deviceBlocker(device({ cliAgents: { version: 1, engines: ["claude"], terminal: { name: "herdr-core", version: "0.1.21", ready: false } } }))).toBe("终端组件不可用");
  });
});

describe("notifications", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports only sessions that began waiting after the first list", () => {
    const rows = [session({ state: "waiting" }), session({ nativeId: "2", state: "running" })];
    expect(newlyWaiting(null, rows)).toEqual([]);
    expect(newlyWaiting(sessionStates(rows), rows)).toEqual([]);
    const later = [session({ state: "waiting" }), session({ nativeId: "2", state: "waiting" })];
    expect(newlyWaiting(sessionStates(rows), later).map((row) => row.nativeId)).toEqual(["2"]);
  });

  it("shows a notification only when enabled and the page is hidden", () => {
    const made: Array<{ title: string; options: NotificationOptions; onclick?: () => void; close: () => void }> = [];
    class FakeNotification {
      static permission = "granted";
      onclick?: () => void;
      close = vi.fn();
      constructor(title: string, options: NotificationOptions) { made.push(Object.assign(this, { title, options })); }
    }
    vi.stubGlobal("Notification", FakeNotification);
    localStorage.setItem("nexbot.cliNotify", "1");
    const open = vi.fn();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    expect(notifyWaiting(session({ state: "waiting" }), open)).toBe(false);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    expect(notifyWaiting(session({ state: "waiting" }), open)).toBe(true);
    expect(made[0]).toMatchObject({ title: "修复登录", options: { body: "等你处理", tag: "dev1:claude:s1" } });
    made[0].onclick?.();
    expect(open).toHaveBeenCalledWith("dev1:claude:s1");
    localStorage.setItem("nexbot.cliNotify", "0");
    expect(notifyWaiting(session({ state: "waiting" }), open)).toBe(false);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });
});
