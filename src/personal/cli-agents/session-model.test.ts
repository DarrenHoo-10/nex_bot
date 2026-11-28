// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliSessionKey } from "../../../shared/cli-agents";
import { device, session } from "./fixtures";
import { newlyWaiting, notifyWaiting, sessionStates } from "./notifications";
import { canAttach, composerMode, deviceBlocker, folderLabel, foldHistory, forkParentKey, groupSessions, hiddenCount, isScratchCwd, matchesTerms, moveProject, normalizePath, orderProjects, projectGroups, rememberProjects, projectOf, recentCwds, samePath, sendsOutside, sessionStatusLabel, sessionTitle, treeParents, waitingCount, worktreeName, worktreeRoot } from "./session-model";

describe("grouping", () => {
  it("groups by computer, then agent, newest first, online computers first", () => {
    const groups = groupSessions(
      [device({ id: "b", name: "笔记本", online: false }), device({ id: "a", name: "办公室电脑" })],
      [
        session({ deviceId: "a", nativeId: "1", cwd: "D:\\work\\alpha", lastActivityAt: 10 }),
        session({ deviceId: "a", nativeId: "2", engine: "codex", cwd: "D:\\work\\beta", lastActivityAt: 30 }),
        session({ deviceId: "a", nativeId: "3", cwd: "D:\\work\\beta", lastActivityAt: 20 }),
        session({ deviceId: "b", nativeId: "4", engine: "codex", cwd: "/home/me/app", online: false }),
      ],
    );
    expect(groups.map((group) => group.device.id)).toEqual(["a", "b"]);
    expect(groups[0].agents.map((agent) => agent.label)).toEqual(["Claude Code", "Codex"]);
    expect(groups[0].agents[0].sessions.map((row) => row.nativeId)).toEqual(["3", "1"]);
    expect(groups[0].agents[1].sessions.map((row) => row.nativeId)).toEqual(["2"]);
    expect(groups[1].agents.map((agent) => agent.engine)).toEqual(["codex"]);
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

  it("lists recent folders of one computer, skipping scratch folders", () => {
    const rows = [
      session({ nativeId: "1", cwd: "/a", lastActivityAt: 1 }),
      session({ nativeId: "2", cwd: "/b", lastActivityAt: 5 }),
      session({ nativeId: "3", cwd: "/a", lastActivityAt: 9 }),
      session({ nativeId: "4", engine: "zcode", cwd: String.raw`C:\Users\Administrator\.zcode\workspace\1794703687702-7d578be1-ce0d-474e-8389-aea8934f52f1`, lastActivityAt: 12 }),
      session({ nativeId: "5", engine: "codex", cwd: String.raw`C:\Users\Administrator\Documents\Codex\2026-11-18\new-chat`, lastActivityAt: 11 }),
      session({ nativeId: "6", engine: "agy", cwd: "", lastActivityAt: 10 }),
      session({ deviceId: "x", key: "x:claude:s", cwd: "/z" }),
    ];
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

  it("sends to a session on the computer through its inbox or daemon; only the inbox takes Stop while it works", () => {
    for (const sendVia of ["inbox", "daemon"] as const) {
      expect(composerMode(session({ liveIn: "terminal", terminal: undefined, sendVia }))).toEqual({ kind: "send", running: false, outside: true });
    }
    expect(composerMode(session({ liveIn: "desktop", terminal: undefined, state: "running", sendVia: "inbox" }))).toEqual({ kind: "send", running: true, outside: true });
    expect(composerMode(session({ liveIn: "desktop", terminal: undefined, state: "waiting", sendVia: "inbox" }))).toEqual({ kind: "send", running: true, outside: true });
    expect(composerMode(session({ liveIn: "desktop", terminal: undefined, state: "running", sendVia: "daemon" }))).toEqual({ kind: "send", running: false, outside: true });
    expect(composerMode(session({ engine: "codex", liveIn: "desktop", terminal: undefined, state: "running", sendVia: "inbox" }))).toEqual({ kind: "send", running: false, outside: true });
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
    expect(deviceBlocker(device({ cliAgents: { version: 1, engines: [], terminal: { name: "herdr-core", version: "0.1.21", ready: true } } }))).toBe("找不到可用的运行工具");
    const agy = device({ cliAgents: { version: 1, engines: ["agy"], terminal: { name: "herdr-core", version: "0.1.21", ready: false } } });
    expect(deviceBlocker(agy, "agy")).toBeNull();
    expect(deviceBlocker(agy, "codex")).toBe("终端组件不可用");
    expect(composerMode(session({ engine: "agy", liveIn: "background", terminal: undefined, sendVia: "acp", state: "waiting" }))).toEqual({ kind: "send", running: true });
    const zcode = device({ cliAgents: { version: 1, engines: ["zcode"], terminal: { name: "herdr-core", version: "0.1.21", ready: false } } });
    expect(deviceBlocker(zcode)).toBeNull();
    expect(deviceBlocker(zcode, "zcode")).toBeNull();
    expect(deviceBlocker(agy, "zcode")).toBe("找不到 ZCode");
    expect(sendsOutside(session({ engine: "zcode", sendVia: "host" }))).toBe(true);
    expect(composerMode(session({ engine: "zcode", liveIn: "background", terminal: undefined, sendVia: "host", state: "running" }))).toEqual({ kind: "send", running: true });
    expect(composerMode(session({ engine: "zcode", liveIn: "desktop", terminal: undefined, state: "running" }))).toEqual({ kind: "blocked", hint: "在 ZCode 桌面应用中打开" });
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

describe("worktree paths", () => {
  it("names the linked worktrees Claude Code and NexAgent create, and nothing else", () => {
    expect(worktreeName(String.raw`D:\ProgrammingProjects\nex_stock\.claude\worktrees\zen-kilby-6e0402`)).toBe("zen-kilby-6e0402");
    expect(worktreeName("/Users/me/app/.claude/worktrees/busy-chaum/src")).toBe("busy-chaum");
    expect(worktreeName(String.raw`D:\work\.nexbot-worktrees\alpha\feat-demo-1234abcd`)).toBe("feat-demo-1234abcd");
    expect(worktreeName(String.raw`D:\ProgrammingProjects\nex_stock`)).toBeNull();
  });

  it("compares paths across the long-path prefix, separators, case and a trailing slash", () => {
    expect(samePath(String.raw`\\?\D:\ProgrammingProjects\nex_stock`, "d:/programmingprojects/nex_stock/")).toBe(true);
    expect(samePath(String.raw`D:\a\b`, String.raw`D:\a\c`)).toBe(false);
    expect(normalizePath(String.raw`\\?\UNC\host\share\dir\\`)).toBe("/host/share/dir");
  });

  it("maps linked worktrees to their repository root and leaves other paths alone", () => {
    expect(worktreeRoot(String.raw`D:\ProgrammingProjects\nex_bot\.claude\worktrees\gallant-gagarin-443e9a`)).toBe(String.raw`D:\ProgrammingProjects\nex_bot`);
    expect(worktreeRoot(String.raw`\\?\D:\ProgrammingProjects\nex_bot\.claude\worktrees\gallant-gagarin-443e9a\src`)).toBe(String.raw`D:\ProgrammingProjects\nex_bot`);
    expect(worktreeRoot("/Users/me/app/.claude/worktrees/busy-chaum/src")).toBe("/Users/me/app");
    expect(worktreeRoot(String.raw`D:\work\.nexbot-worktrees\alpha\feat-demo-1234abcd`)).toBe(String.raw`D:\work\alpha`);
    expect(worktreeRoot("\\\\?\\D:\\ProgrammingProjects\\nex_stock\\")).toBe(String.raw`D:\ProgrammingProjects\nex_stock`);
  });
});


describe("projects", () => {
  it("recognises empty, Codex and ZCode scratch chats", () => {
    expect(isScratchCwd("")).toBe(true);
    expect(isScratchCwd("   ")).toBe(true);
    expect(isScratchCwd("/")).toBe(false);
    expect(isScratchCwd(String.raw`C:\Users\Administrator\Documents\Codex\2026-11-18\new-chat`)).toBe(true);
    expect(isScratchCwd(String.raw`\\?\C:\Users\Administrator\Documents\Codex\2026-11-18\new-chat-2`)).toBe(true);
    expect(isScratchCwd("/Users/me/Documents/Codex/2026-11-18")).toBe(true);
    expect(isScratchCwd(String.raw`C:\Users\Administrator\.zcode\workspace\1794703687702-7d578be1-ce0d-474e-8389-aea8934f52f1`)).toBe(true);
    expect(isScratchCwd(String.raw`C:\Users\Administrator\.zcode\workspace\default`)).toBe(true);
    expect(isScratchCwd("/Users/me/.zcode/workspace/1794703687702-7d578be1-ce0d-474e-8389-aea8934f52f1")).toBe(true);
    expect(isScratchCwd(String.raw`C:\Users\Administrator\.zcode\worktrees\c4ae\nex_bot`)).toBe(false);
    expect(isScratchCwd(String.raw`C:\Users\Administrator\.zcode\workspace\my-project`)).toBe(false);
    expect(isScratchCwd(String.raw`C:\Users\Administrator\Documents\Codex\notes`)).toBe(false);
    expect(isScratchCwd(String.raw`D:\ProgrammingProjects\nex_stock`)).toBe(false);
  });

  it("derives one project from worktrees, the long-path prefix and case", () => {
    const main = projectOf(session({ cwd: String.raw`D:\ProgrammingProjects\nex_stock` }));
    const prefixed = projectOf(session({ cwd: String.raw`\\?\D:\ProgrammingProjects\nex_stock` }));
    const lower = projectOf(session({ cwd: "d:/programmingprojects/nex_stock/" }));
    const worktree = projectOf(session({ cwd: String.raw`D:\ProgrammingProjects\nex_stock\.claude\worktrees\zen-kilby-6e0402` }));
    expect(new Set([main.key, prefixed.key, lower.key, worktree.key]).size).toBe(1);
    expect(worktree).toMatchObject({ label: "nex_stock", root: String.raw`D:\ProgrammingProjects\nex_stock`, scratch: false });
  });

  it("prefers the device-reported repo root, then an explicit override", () => {
    const row = session({ repoRoot: String.raw`D:\Repos\Main`, cwd: String.raw`D:\Elsewhere\feature-tree` });
    expect(projectOf(row)).toMatchObject({ label: "Main", root: String.raw`D:\Repos\Main` });
    expect(projectOf(row, String.raw`D:\Override`).label).toBe("Override");
    expect(projectOf(session({ cwd: "" }))).toMatchObject({ label: "未关联项目", root: "", scratch: true });
    expect(projectOf(session({ engine: "zcode", cwd: String.raw`C:\Users\Administrator\.zcode\workspace\1794703687702-7d578be1-ce0d-474e-8389-aea8934f52f1` }))).toMatchObject({ label: "未关联项目", root: "", scratch: true });
  });

  it("groups real projects by latest activity and puts scratch chats last under one label", () => {
    const groups = projectGroups([
      session({ nativeId: "1", engine: "codex", cwd: String.raw`C:\Users\Administrator\Documents\Codex\2026-11-18\new-chat`, lastActivityAt: 90 }),
      session({ nativeId: "2", engine: "codex", cwd: String.raw`C:\Users\Administrator\Documents\Codex\2026-11-17\new-chat`, lastActivityAt: 80 }),
      session({ nativeId: "3", cwd: String.raw`D:\ProgrammingProjects\nex_bot\.claude\worktrees\gallant-gagarin-443e9a`, lastActivityAt: 10 }),
      session({ nativeId: "4", cwd: String.raw`D:\ProgrammingProjects\nex_bot`, lastActivityAt: 20 }),
      session({ nativeId: "5", cwd: String.raw`D:\ProgrammingProjects\nex_stock`, lastActivityAt: 5 }),
      session({ nativeId: "6", cwd: String.raw`\\?\D:\ProgrammingProjects\nex_stock`, lastActivityAt: 6 }),
      session({ nativeId: "7", engine: "agy", cwd: "", lastActivityAt: 95 }),
      session({ nativeId: "8", engine: "zcode", cwd: String.raw`C:\Users\Administrator\.zcode\workspace\1794703687702-7d578be1-ce0d-474e-8389-aea8934f52f1`, lastActivityAt: 85 }),
    ]);
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.nativeId).sort()])).toEqual([
      ["nex_bot", ["3", "4"]],
      ["nex_stock", ["5", "6"]],
      ["未关联项目", ["1", "2", "7", "8"]],
    ]);
    expect(groups[2].scratch).toBe(true);
  });

  it("lists folders that show the same name as one project, opening new sessions in the one used last", () => {
    const older = String.raw`C:\Temp\nex-agy-native-check-z1FQ0M\workspace`, newer = String.raw`C:\Temp\nex-agy-roundtrip-e223BM\Workspace`;
    const groups = projectGroups([
      session({ nativeId: "1", engine: "agy", cwd: older, lastActivityAt: 10 }),
      session({ nativeId: "2", engine: "agy", cwd: newer, lastActivityAt: 30 }),
      session({ nativeId: "3", cwd: String.raw`D:\ProgrammingProjects\nex_bot`, lastActivityAt: 20 }),
    ]);
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.nativeId)])).toEqual([["Workspace", ["1", "2"]], ["nex_bot", ["3"]]]);
    expect(groups[0]).toMatchObject({ root: newer, roots: [older, newer], members: [normalizePath(older), normalizePath(newer)] });
    expect(groups[0].key).not.toBe(normalizePath(newer));
    // a project of one folder keeps that folder's key, so its saved place and fold state stay
    expect(groups[1].key).toBe(normalizePath(String.raw`D:\ProgrammingProjects\nex_bot`));
  });
});

describe("fork nesting", () => {
  it("reads the parent from forkOf on the same computer and agent only", () => {
    expect(forkParentKey(session({ nativeId: "s1", forkOf: "s0" }))).toBe("dev1:claude:s0");
    expect(forkParentKey(session({ nativeId: "s2", engine: "codex", forkOf: "s0" }))).toBe("dev1:codex:s0");
    expect(forkParentKey(session({ nativeId: "s1", forkOf: "s1" }))).toBeNull();
    expect(forkParentKey(session())).toBeNull();
  });

  it("keeps only parents that are listed and cuts loops so every row stays reachable", () => {
    const rows = [session({ nativeId: "a" }), session({ nativeId: "b" }), session({ nativeId: "c" }), session({ nativeId: "d" })];
    const links: Record<string, CliSessionKey> = { "dev1:claude:a": "dev1:claude:b", "dev1:claude:b": "dev1:claude:a", "dev1:claude:c": "dev1:claude:b", "dev1:claude:d": "dev1:claude:gone" };
    const parents = treeParents(rows, (row) => links[row.key]);
    expect(parents.get("dev1:claude:d")).toBeNull();
    expect(parents.get("dev1:claude:c")).toBe("dev1:claude:b");
    const roots = rows.filter((row) => !parents.get(row.key));
    expect(roots.map((row) => row.nativeId)).toContain("a");
    expect(parents.get("dev1:claude:b")).toBe("dev1:claude:a");
  });
});

describe("history fold", () => {
  const parents = (links: Record<string, string>) => treeParents(rows, (row) => links[row.nativeId] ? `dev1:claude:${links[row.nativeId]}` : null);
  const rows = ["a", "b", "c", "d", "e"].map((nativeId) => session({ nativeId }));
  const active = (...ids: string[]) => (row: { nativeId: string }) => ids.includes(row.nativeId);

  it("shows active sessions and their ancestors, and folds the rest", () => {
    const shown = foldHistory(rows, parents({ b: "a", c: "b" }), active("c"));
    expect([...shown].sort()).toEqual(["dev1:claude:a", "dev1:claude:b", "dev1:claude:c"]);
  });

  it("does not fold a single older session", () => {
    expect(foldHistory(rows, parents({}), active("a", "b", "c", "d")).size).toBe(5);
  });
});

describe("project order", () => {
  const group = (key: string, latest: number, scratch = false) => ({ key, root: key, label: key, scratch, latest });

  it("puts new projects first, keeps the saved order for the rest and the scratch group last", () => {
    const groups = [group("s", 9, true), group("a", 5), group("b", 7), group("c", 1), group("d", 3)];
    expect(orderProjects(groups, ["c", "a"]).map((g) => g.key)).toEqual(["b", "d", "c", "a", "s"]);
    // nothing saved yet: newest activity first
    expect(orderProjects(groups, []).map((g) => g.key)).toEqual(["b", "a", "d", "c", "s"]);
  });

  it("remembers new projects in front without moving known ones", () => {
    expect(rememberProjects([group("a", 1), group("n", 2), group("s", 3, true)], ["x", "a"])).toEqual(["n", "x", "a"]);
    expect(rememberProjects([group("a", 1)], ["x", "a"])).toEqual(["x", "a"]);
  });

  it("keeps a project that joined folders saved apart in the earliest of their places", () => {
    const merged = { ...group("w", 9), members: ["w1", "w2"] };
    const groups = [group("a", 5), merged, group("b", 7)];
    expect(orderProjects(groups, ["a", "w2", "b", "w1"]).map((g) => g.key)).toEqual(["a", "w", "b"]);
    const remembered = rememberProjects(groups, ["a", "w2", "b", "w1"]);
    expect(remembered).toEqual(["a", "w", "w2", "b", "w1"]);
    // once saved under its own key, it drags like any project
    expect(orderProjects(groups, moveProject(remembered, "w", "b", true)).map((g) => g.key)).toEqual(["a", "b", "w"]);
  });

  it("moves a dragged project before or after the one it was dropped on", () => {
    expect(moveProject(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
    expect(moveProject(["a", "b", "c"], "a", "b", true)).toEqual(["b", "a", "c"]);
    expect(moveProject(["a", "b"], "a", "missing", true)).toEqual(["a", "b"]);
  });
});

describe("search terms", () => {
  it("needs every term, in any order and case", () => {
    expect(matchesTerms("修复 Login 页面", "login 修复")).toBe(true);
    expect(matchesTerms("修复 Login 页面", "login 注册")).toBe(false);
    expect(matchesTerms("anything", "  ")).toBe(true);
  });
});
