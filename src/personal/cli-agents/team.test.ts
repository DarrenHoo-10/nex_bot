// @vitest-environment happy-dom
// Collaboration UI behavior: failed collaborators are hidden from lists & panels,
// and collaborator report/review cards render concise briefings instead of raw dumps.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliSessionKey } from "../../../shared/cli-agents";
import { device, session } from "./fixtures";
import { groupSessions } from "./session-model";
import { indexTeams, parseTeamCard, type CliTeamRunView } from "./team";

vi.mock("../AgentDesktop", () => ({
  RichText: ({ value }: { value: string }) => createElement("p", null, value),
}));

import { SessionList } from "./SessionList";
import { TeamMessageCard } from "./TeamMessageCard";
import { TeamPanel } from "./TeamPanel";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const LEAD_KEY: CliSessionKey = "d1:claude:lead-1";
const FAIL_KEY: CliSessionKey = "d1:agy:worker-fail";
const OK_KEY: CliSessionKey = "d1:agy:worker-ok";
const REV_KEY: CliSessionKey = "d1:codex:worker-rev";

function sampleRun(status: CliTeamRunView["status"] = "active"): CliTeamRunView {
  return {
    id: "team_1",
    leadKey: LEAD_KEY,
    title: "测试协作模式",
    status,
    limit: 5,
    createdAt: 1000,
    updatedAt: 2000,
    workers: [
      {
        id: "w-fail-1",
        runId: "team_1",
        name: "agy-1",
        engine: "agy",
        sessionKey: null,
        cwd: "/repo",
        role: "实现",
        title: "实现贪吃蛇（启动失败）",
        permissions: "ask",
        status: "failed",
        createdAt: 1001,
        updatedAt: 1002,
      },
      {
        id: "w-fail-2",
        runId: "team_1",
        name: "agy-2",
        engine: "agy",
        sessionKey: FAIL_KEY,
        cwd: "/repo",
        role: "实现",
        title: "实现贪吃蛇（中途失败）",
        permissions: "full",
        status: "failed",
        createdAt: 1003,
        updatedAt: 1004,
      },
      {
        id: "w-ok",
        runId: "team_1",
        name: "agy-3",
        engine: "agy",
        sessionKey: OK_KEY,
        cwd: "/repo",
        role: "实现",
        title: "实现贪吃蛇",
        permissions: "full",
        status: "reported",
        createdAt: 1005,
        updatedAt: 1006,
      },
      {
        id: "w-rev",
        runId: "team_1",
        name: "codex-1",
        engine: "codex",
        sessionKey: REV_KEY,
        cwd: "/repo",
        role: "代码审查",
        title: "审查贪吃蛇",
        permissions: "readonly",
        status: "reported",
        findingsCount: 3,
        createdAt: 1007,
        updatedAt: 1008,
      },
    ],
  };
}

describe("collaboration failed-worker hiding and concise briefings", () => {
  it("hides failed collaborators in TeamPanel (active and history) and counts only visible workers", async () => {
    const activeRun = sampleRun("active");
    const failedOnlyHistory: CliTeamRunView = {
      id: "team_old_fail",
      leadKey: LEAD_KEY,
      title: "全部失败的历史协作",
      status: "cancelled",
      limit: 5,
      createdAt: 500,
      updatedAt: 600,
      workers: [activeRun.workers[0]!],
    };

    await act(async () => {
      root.render(createElement(TeamPanel, {
        runs: [activeRun, failedOnlyHistory],
        selectedKey: LEAD_KEY,
        onOpenSession: vi.fn(),
        onPause: vi.fn(async () => {}),
        onResume: vi.fn(async () => {}),
        onCancel: vi.fn(async () => {}),
        onStopWorker: vi.fn(async () => {}),
      }));
    });

    const text = container.textContent ?? "";
    expect(container.querySelectorAll(".na-team-worker-item")).toHaveLength(2);
    expect(text).toContain("agy-3");
    expect(text).toContain("codex-1");
    expect(text).not.toContain("agy-1");
    expect(text).not.toContain("agy-2");
    expect(text).not.toContain("全部失败的历史协作");
  });

  it("hides failed collaborator sessions from SessionList", async () => {
    const now = Date.now();
    const sessions = [
      session({ key: LEAD_KEY, engine: "claude", nativeId: "lead-1", title: "主控会话", lastActivityAt: now }),
      session({ key: FAIL_KEY, engine: "agy", nativeId: "worker-fail", title: "失败协作者", lastActivityAt: now - 1000 }),
      session({ key: OK_KEY, engine: "agy", nativeId: "worker-ok", title: "实现贪吃蛇", lastActivityAt: now - 500 }),
    ];
    const teams = indexTeams([sampleRun("active")]);

    await act(async () => {
      root.render(createElement(SessionList, {
        groups: groupSessions([device()], sessions, true),
        selectedKey: LEAD_KEY,
        teams,
        onSelect: vi.fn(),
        onNew: vi.fn(),
        reloadSessions: async () => {},
      }));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("主控会话");
    expect(text).toContain("实现贪吃蛇");
    expect(text).not.toContain("失败协作者");
  });

  it("parses and renders review and implementer reports as concise briefings without raw protocol headers or essays", async () => {
    const rawReview = [
      `<!-- nexagent-team:${JSON.stringify({
        kind: "review",
        heading: "codex-1 · 代码审查",
        subtitle: "审查果园贪吃蛇",
        actorEngine: "codex",
        sourceSessionKey: REV_KEY,
        outcome: "succeeded",
      })} -->`,
      "[NexAgent team] From codex-1 · report · 审查果园贪吃蛇",
      "",
      "果园贪吃蛇独立代码审查",
      "交付结论：建议修复两项 P2 输入缺陷后再交付。另有一项 P3 可一并修复。",
      "",
      "1. [P2] 一次触摸可能重复入队，改变蛇的走位。长段落细节...",
      "2. [P2] 长按空格会反复暂停和恢复。长段落细节...",
      "3. [P3] 鼠标移出十字键再松开，会吞掉第一次后续键盘激活。",
      "",
      "验证范围",
      "• 静态检查内联 HTML、CSS 和 JavaScript",
      "",
      "如需跟进请运行 `nex send codex-1 --file <说明>`，全部完成后运行 `nex done --file <摘要>`。",
    ].join("\n");

    const card = parseTeamCard(rawReview);
    expect(card).not.toBeNull();
    expect(card!.findingCounts).toEqual([
      { severity: "p2", label: "P2", count: 2 },
      { severity: "p3", label: "P3", count: 1 },
    ]);
    expect(card!.brief).toContain("建议修复两项 P2 输入缺陷后再交付");
    expect(card!.brief).not.toContain("[NexAgent team]");
    expect(card!.brief).not.toContain("验证范围");
    expect(card!.brief).not.toContain("如需跟进");

    const onSelect = vi.fn();
    await act(async () => {
      root.render(createElement(TeamMessageCard, { card: card!, onSelectSession: onSelect }));
    });

    const rendered = container.textContent ?? "";
    expect(rendered).toContain("发现 3 个问题");
    expect(rendered).toContain("2 个 P2");
    expect(rendered).toContain("1 个 P3");
    expect(rendered).toContain("建议修复两项 P2 输入缺陷后再交付");
    expect(rendered).not.toContain("[NexAgent team]");
    expect(rendered).not.toContain("验证范围");
    expect(rendered).not.toContain("长段落细节");

    const jumpBtn = container.querySelector<HTMLButtonElement>(".na-team-card-jump");
    expect(jumpBtn).not.toBeNull();
    await act(async () => { jumpBtn!.click(); });
    expect(onSelect).toHaveBeenCalledWith(REV_KEY);

    // Implementer report with explicit brief & file list renders concise summary + capped files.
    const rawImpl = [
      `<!-- nexagent-team:${JSON.stringify({
        kind: "report",
        heading: "agy-3 · 实现",
        subtitle: "实现贪吃蛇",
        actorEngine: "agy",
        sourceSessionKey: OK_KEY,
        outcome: "succeeded",
        brief: "- 修复触摸方向重复入队\n- 修复长按空格反复暂停",
        files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      })} -->`,
      "[NexAgent team] From agy-3 · report · 实现贪吃蛇",
      "",
      "完整详细修改说明不应直接铺满主会话卡片。",
    ].join("\n");

    const implCard = parseTeamCard(rawImpl);
    expect(implCard).not.toBeNull();
    expect(implCard!.brief).toContain("修复触摸方向重复入队");

    await act(async () => {
      root.render(createElement(TeamMessageCard, { card: implCard!, onSelectSession: onSelect }));
    });

    const implRendered = container.textContent ?? "";
    expect(implRendered).toContain("修复触摸方向重复入队");
    expect(implRendered).toContain("+1 个文件");
    expect(implRendered).not.toContain("完整详细修改说明");
  });
});
