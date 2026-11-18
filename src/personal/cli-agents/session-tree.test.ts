// @vitest-environment happy-dom
// The project tree in the session list: grouping by normalized project, fork nesting,
// the earlier-history fold, search through the fold and which harnesses may fork.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliSessionKey } from "../../../shared/cli-agents";
import { device, session } from "./fixtures";
import { groupSessions } from "./session-model";
import { SessionList, type WorkbenchActions, type WorkbenchMeta } from "./SessionList";

const DAY = 86_400_000;
const now = Date.now();
const recent = (minutes: number) => now - minutes * 60_000;
const old = (days: number) => now - days * DAY;

const forked = (forkOf: string, overrides: Parameters<typeof session>[0] = {}) => session({ ...overrides, forkOf });

let root: Root;
let container: HTMLDivElement;
const onSelect = vi.fn();
const actions: WorkbenchActions = { fork: vi.fn(), rename: vi.fn(), archive: vi.fn(), remove: vi.fn() };

type Row = ReturnType<typeof session>;
async function mount(sessions: Row[], options: { selectedKey?: CliSessionKey; workbench?: Map<CliSessionKey, WorkbenchMeta>; device?: ReturnType<typeof device> } = {}) {
  await act(async () => {
    root.render(createElement(SessionList, {
      groups: groupSessions([options.device ?? device()], sessions, true),
      selectedKey: options.selectedKey ?? null,
      workbench: options.workbench,
      onWorkbenchAction: actions,
      onSelect,
      onNew: () => {},
      reloadSessions: async () => {},
    }));
  });
}

const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); });
const folders = () => [...container.querySelectorAll(".na-folder strong")].map((entry) => entry.textContent);
const titles = (scope: ParentNode = container) => [...scope.querySelectorAll(".cli-row-title")].map((entry) => entry.textContent);
const older = () => container.querySelector<HTMLButtonElement>(".na-older");
const project = (label: string) => [...container.querySelectorAll(".na-project")].find((entry) => entry.querySelector(".na-folder strong")?.textContent === label)!;
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>(".na-search input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openMenu(title: string) {
  await click(container.querySelector(`[aria-label="${title}的操作"]`));
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button[role="menuitem"]')];
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSelect.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.querySelectorAll('[role="menu"]').forEach((entry) => entry.remove());
  vi.unstubAllGlobals();
});

describe("project grouping", () => {
  it("folds worktrees, long-path prefixes and Codex scratch chats into one project each", async () => {
    await mount([
      session({ nativeId: "m", title: "主线", cwd: String.raw`D:\ProgrammingProjects\nex_bot`, lastActivityAt: recent(5) }),
      session({ nativeId: "w1", title: "工作树一", cwd: String.raw`D:\ProgrammingProjects\nex_bot\.claude\worktrees\gallant-gagarin-443e9a`, lastActivityAt: recent(6) }),
      session({ nativeId: "w2", title: "工作树二", cwd: String.raw`D:\ProgrammingProjects\nex_bot\.claude\worktrees\zen-kilby-6e0402`, lastActivityAt: recent(7) }),
      session({ nativeId: "s1", title: "行情", cwd: String.raw`\\?\D:\ProgrammingProjects\nex_stock`, lastActivityAt: recent(20) }),
      session({ nativeId: "s2", title: "选股", cwd: String.raw`D:\ProgrammingProjects\nex_stock`, lastActivityAt: recent(21) }),
      session({ nativeId: "c1", engine: "codex", title: "随手问一", cwd: String.raw`C:\Users\Administrator\Documents\Codex\2026-11-18\new-chat`, lastActivityAt: recent(1) }),
      session({ nativeId: "c2", engine: "codex", title: "随手问二", cwd: String.raw`C:\Users\Administrator\Documents\Codex\2026-11-18\new-chat-2`, lastActivityAt: recent(2) }),
      session({ nativeId: "c3", engine: "codex", title: "随手问三", cwd: String.raw`\\?\C:\Users\Administrator\Documents\Codex\2026-11-17\new-chat`, lastActivityAt: recent(3) }),
    ]);
    // real projects by latest activity, the scratch group last even though it is the newest
    expect(folders()).toEqual(["nex_bot", "nex_stock", "未关联项目"]);
    expect(titles(project("nex_bot"))).toEqual(["主线", "工作树一", "工作树二"]);
    expect(titles(project("nex_stock"))).toEqual(["行情", "选股"]);
    expect(titles(project("未关联项目"))).toEqual(["随手问一", "随手问二", "随手问三"]);
    expect(project("nex_bot").querySelector(".na-folder strong")?.getAttribute("title")).toBe(String.raw`D:\ProgrammingProjects\nex_bot`);
    expect(project("nex_stock").querySelector(".na-folder strong")?.getAttribute("title")).toBe(String.raw`D:\ProgrammingProjects\nex_stock`);
    expect(project("nex_bot").querySelector(".na-folder small")?.textContent).toBe("3");
  });

  it("finds a project by its name or a session by its title", async () => {
    await mount([
      session({ nativeId: "a", title: "修复登录", cwd: String.raw`D:\work\alpha`, lastActivityAt: recent(1) }),
      session({ nativeId: "b", title: "写测试", cwd: String.raw`D:\work\beta`, lastActivityAt: recent(2) }),
    ]);
    await search("beta");
    expect(folders()).toEqual(["beta"]);
    await search("登录");
    expect(folders()).toEqual(["alpha"]);
  });
});

describe("fork nesting", () => {
  it("nests a fork under the session it came from, newest first within a level", async () => {
    await mount([
      session({ nativeId: "a", title: "根", lastActivityAt: recent(30) }),
      forked("a", { nativeId: "b", title: "分支旧", lastActivityAt: recent(20) }),
      forked("a", { nativeId: "c", title: "分支新", lastActivityAt: recent(10) }),
      forked("c", { nativeId: "d", title: "孙分支", lastActivityAt: recent(5) }),
    ]);
    const tops = [...project("alpha").querySelectorAll(":scope > .na-branch > .na-node")];
    expect(tops).toHaveLength(1);
    const children = [...tops[0].querySelectorAll(":scope > .na-branch > .na-node")];
    expect(children.map((node) => node.querySelector(".cli-row-title")?.textContent)).toEqual(["分支新", "分支旧"]);
    expect(titles(children[0].querySelector(":scope > .na-branch")!)).toEqual(["孙分支"]);
  });

  it("lets the workbench parent win over forkOf and ignores a fork of an unlisted session", async () => {
    const workbench = new Map<CliSessionKey, WorkbenchMeta>([["dev1:claude:b", { title: "B", parent: "dev1:claude:c" }]]);
    await mount([
      session({ nativeId: "a", title: "甲", lastActivityAt: recent(30) }),
      forked("a", { nativeId: "b", title: "乙", lastActivityAt: recent(20) }),
      session({ nativeId: "c", title: "丙", lastActivityAt: recent(10) }),
      forked("missing", { nativeId: "d", title: "丁", lastActivityAt: recent(5) }),
    ], { workbench });
    const tops = [...project("alpha").querySelectorAll(":scope > .na-branch > .na-node")];
    expect(tops.map((node) => node.querySelector(".cli-row-title")?.textContent)).toEqual(["丁", "丙", "甲"]);
    expect(titles(tops[1].querySelector(":scope > .na-branch")!)).toEqual(["B"]);
  });

  it("keeps sessions reachable when forkOf forms a loop", async () => {
    await mount([
      forked("b", { nativeId: "a", title: "环甲", lastActivityAt: recent(2) }),
      forked("a", { nativeId: "b", title: "环乙", lastActivityAt: recent(1) }),
    ]);
    expect(titles().sort()).toEqual(["环乙", "环甲"].sort());
  });
});

describe("earlier history", () => {
  const history = () => [
    session({ nativeId: "n", title: "今天", lastActivityAt: recent(5) }),
    session({ nativeId: "o1", title: "旧一", state: "stopped", lastActivityAt: old(10) }),
    session({ nativeId: "o2", title: "旧二", state: "stopped", lastActivityAt: old(20) }),
    session({ nativeId: "o3", title: "旧三", state: "stopped", lastActivityAt: old(30) }),
  ];

  it("folds sessions older than a week behind a per-project toggle, collapsed by default", async () => {
    await mount(history());
    expect(titles()).toEqual(["今天"]);
    expect(older()?.textContent).toBe("更早 3");
    expect(older()?.getAttribute("aria-expanded")).toBe("false");
    await click(older());
    expect(titles()).toEqual(["今天", "旧一", "旧二", "旧三"]);
    expect(older()?.getAttribute("aria-expanded")).toBe("true");
    await click(older());
    expect(titles()).toEqual(["今天"]);
  });

  it("keeps running, waiting and selected sessions, and the parents of recent ones, out of the fold", async () => {
    await mount([
      session({ nativeId: "n", title: "今天", lastActivityAt: recent(5) }),
      session({ nativeId: "run", title: "老任务在跑", state: "running", lastActivityAt: old(40) }),
      session({ nativeId: "wait", title: "老任务等你", state: "waiting", lastActivityAt: old(41) }),
      session({ nativeId: "sel", title: "正打开的", state: "stopped", lastActivityAt: old(42) }),
      session({ nativeId: "p", title: "老父", state: "stopped", lastActivityAt: old(43) }),
      forked("p", { nativeId: "kid", title: "新子", lastActivityAt: recent(9) }),
      session({ nativeId: "x1", title: "沉底一", state: "stopped", lastActivityAt: old(44) }),
      session({ nativeId: "x2", title: "沉底二", state: "stopped", lastActivityAt: old(45) }),
    ], { selectedKey: "dev1:claude:sel" });
    expect(titles().sort()).toEqual(["今天", "老任务在跑", "老任务等你", "正打开的", "老父", "新子"].sort());
    expect(older()?.textContent).toBe("更早 2");
  });

  it("does not hide a lone older session behind a toggle", async () => {
    await mount([session({ nativeId: "n", title: "今天", lastActivityAt: recent(5) }), session({ nativeId: "o", title: "旧一", state: "stopped", lastActivityAt: old(10) })]);
    expect(titles()).toEqual(["今天", "旧一"]);
    expect(older()).toBeNull();
  });

  it("remembers the choice per project and lets search ignore the fold", async () => {
    await mount([
      ...history(),
      session({ nativeId: "b1", title: "乙项目新", cwd: String.raw`D:\work\beta`, lastActivityAt: recent(3) }),
      session({ nativeId: "b2", title: "乙项目旧一", cwd: String.raw`D:\work\beta`, state: "stopped", lastActivityAt: old(12) }),
      session({ nativeId: "b3", title: "乙项目旧二", cwd: String.raw`D:\work\beta`, state: "stopped", lastActivityAt: old(13) }),
    ]);
    await click(project("alpha").querySelector(".na-older"));
    expect(titles(project("alpha"))).toHaveLength(4);
    expect(titles(project("beta"))).toEqual(["乙项目新"]);
    await search("旧三");
    expect(titles()).toEqual(["旧三"]);
    expect(older()).toBeNull();
    await search("乙项目旧二");
    expect(titles()).toEqual(["乙项目旧二"]);
    await search("");
    expect(titles(project("beta"))).toEqual(["乙项目新"]);
    expect(titles(project("alpha"))).toHaveLength(4);
  });

  it("does not fold the archive view", async () => {
    const rows = history();
    const workbench = new Map<CliSessionKey, WorkbenchMeta>(rows.map((row) => [row.key, { title: row.title, archived: true, id: `wb-${row.nativeId}`, version: 1 }]));
    await mount(rows, { workbench });
    expect(titles()).toEqual([]);
    await click([...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes("已归档")) ?? null);
    expect(titles()).toEqual(["今天", "旧一", "旧二", "旧三"]);
    expect(older()).toBeNull();
  });
});

describe("fork menu", () => {
  const caps = (forkEngines?: ("claude" | "codex")[]) => device({ cliAgents: { version: 1, engines: ["claude", "codex"], ...(forkEngines ? { forkEngines } : {}), terminal: { name: "herdr-core", version: "0.1.21", ready: true } } });

  it("offers 创建分支 only for the harnesses the executor can fork", async () => {
    await mount([
      session({ nativeId: "cl", title: "克劳德", lastActivityAt: recent(2) }),
      session({ nativeId: "cx", engine: "codex", title: "码仔", lastActivityAt: recent(1) }),
    ], { device: caps(["claude"]) });
    const forkItem = (items: HTMLButtonElement[]) => items.find((entry) => entry.textContent === "创建分支")!;
    const claude = forkItem(await openMenu("克劳德"));
    expect(claude.disabled).toBe(false);
    expect(claude.title).toBe("");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const codex = forkItem(await openMenu("码仔"));
    expect(codex.disabled).toBe(true);
    expect(codex.title).toBe("该 Harness 暂不支持分支");
  });

  it("says the executor is too old when it reports no fork engines", async () => {
    await mount([session({ nativeId: "cl", title: "克劳德", lastActivityAt: recent(2) })], { device: caps() });
    const claude = (await openMenu("克劳德")).find((entry) => entry.textContent === "创建分支")!;
    expect(claude.disabled).toBe(true);
    expect(claude.title).toBe("电脑端版本过旧，升级后可分叉会话");
  });
});
