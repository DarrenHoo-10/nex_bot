import { describe, expect, it } from "vitest";
import type { CliItem } from "../../../shared/cli-agents";
import { formatWorkDuration } from "../components/MoreContent";
import { assistantItem, toolItem, userItem } from "./fixtures";
import { guideTimeline, activityStats, groupItems, transcriptRows, replyTails, mergeItems, oldestId, prependItems, resetItems, toolSummary, userTurns, type ActivityItem } from "./transcript";

const ids = (items: readonly CliItem[]) => items.map((item) => item.id);
const thinking = (id: string, ts: number): CliItem => ({ kind: "thinking", id, ts, text: "想一想" });
const asActivity = (items: CliItem[]) => items as ActivityItem[];

describe("mergeItems", () => {
  it("replaces an item with the same id in place", () => {
    const done = toolItem("t1", 2, "ok");
    const merged = mergeItems([userItem("u1", 1), toolItem("t1", 2, "running"), assistantItem("a1", 3)], [done]);
    expect(ids(merged)).toEqual(["u1", "t1", "a1"]);
    expect(merged[1]).toBe(done);
  });

  it("puts a new item after the last one that is not newer", () => {
    expect(ids(mergeItems([userItem("u1", 1), assistantItem("a1", 5)], [toolItem("t1", 3)]))).toEqual(["u1", "t1", "a1"]);
  });

  it("keeps the CLI record order for live guidance with an older timestamp", () => {
    const reply = assistantItem("reply", 5);
    const guide = userItem("guide", 3);
    const live = mergeItems([reply], [guide], false, true);
    expect(ids(live)).toEqual(["reply", "guide"]);
    expect(resetItems(live, [reply, guide]).items).toEqual(live);
  });

  it("appends newer items at the end", () => {
    expect(ids(mergeItems([userItem("u1", 1)], [assistantItem("a1", 2), assistantItem("a2", 3)]))).toEqual(["u1", "a1", "a2"]);
  });

  it("keeps ids unique when the same id arrives twice in one push", () => {
    const merged = mergeItems([], [userItem("u1", 1, "a"), userItem("u1", 1, "b")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ text: "b" });
  });

  it("swaps the list on reset and drops repeats", () => {
    expect(ids(mergeItems([userItem("old", 1)], [userItem("u1", 2), userItem("u1", 2)], true))).toEqual(["u1"]);
  });

  it("does not change its input", () => {
    const existing = [userItem("u1", 1)];
    mergeItems(existing, [assistantItem("a1", 2)]);
    expect(existing).toHaveLength(1);
  });
});

describe("resetItems", () => {
  it("keeps the earlier pages the reader loaded when the newest page is sent again", () => {
    const shown = [userItem("u1", 1), assistantItem("a1", 2), userItem("u2", 3), toolItem("t1", 4, "running")];
    const { items, kept } = resetItems(shown, [userItem("u2", 3), toolItem("t1", 4, "ok"), assistantItem("a2", 5)]);
    expect(ids(items)).toEqual(["u1", "a1", "u2", "t1", "a2"]);
    expect(items[3]).toMatchObject({ status: "ok" });
    expect(kept).toBe(true);
  });

  it("drops what the page no longer has after its first item (a rewind)", () => {
    const { items } = resetItems([userItem("u1", 1), userItem("u2", 2), assistantItem("gone", 3)], [userItem("u2", 2), assistantItem("a2", 4)]);
    expect(ids(items)).toEqual(["u1", "u2", "a2"]);
  });

  it("replaces everything when the page shares nothing with the list", () => {
    expect(resetItems([userItem("old", 1)], [userItem("u1", 2)])).toEqual({ items: [userItem("u1", 2)], kept: false });
    expect(resetItems([userItem("old", 1)], [])).toEqual({ items: [], kept: false });
  });
});

describe("guideTimeline", () => {
  it("keeps the text already shown above the click and subsequent streamed text below it", () => {
    const tail = { kind: "assistant" as const, id: "a", text: "正在查。", ts: 10 };
    const guide = { id: "1", text: "先查日志", at: 20, known: new Set(["a"]), tail };
    const updated = { ...tail, text: "正在查。找到原因了。", ts: 30 };
    const rows = guideTimeline([updated, userItem("echo", 50, guide.text)], [guide]);
    expect(rows.map(row => [row.kind, row.ts, "text" in row && row.text])).toEqual([
      ["assistant", 10, "正在查。"], ["user", 20, guide.text], ["assistant", 30, "找到原因了。"],
    ]);
  });
});

describe("userTurns", () => {
  it("counts user messages", () => {
    expect(userTurns([userItem("u1", 1), assistantItem("a1", 2), toolItem("t1", 3), userItem("u2", 4)])).toBe(2);
  });
});

describe("prependItems", () => {
  it("puts an older page in front and prefers what is already shown", () => {
    const merged = prependItems([userItem("u2", 2, "shown")], [userItem("u1", 1), userItem("u2", 2, "page copy")]);
    expect(ids(merged)).toEqual(["u1", "u2"]);
    expect(merged[1]).toMatchObject({ text: "shown" });
  });
});

describe("groupItems", () => {
  it("shows one compaction notice across adjacent source records and preserves later compactions", () => {
    const compact = (id: string) => ({ kind: "notice" as const, id, ts: 1, level: "info" as const, text: "上下文已压缩" });
    const rows = transcriptRows([compact("boundary"), { kind: "turn", id: "marker", ts: 1, phase: "started" }, compact("summary"), userItem("next", 2), compact("later")], false);
    expect(rows.map(row => row.id)).toEqual(["boundary", "next", "later"]);
  });
  it("leaves out command bookkeeping and words a model failure plainly", () => {
    const blocks = groupItems([
      userItem("c1", 1, "<command-name>/model</command-name>\n<command-args>sonnet</command-args>"),
      userItem("c2", 2, "<local-command-stdout>Set model to Sonnet 5.5</local-command-stdout>"),
      userItem("u1", 3, "帮我做一个贪吃蛇"),
      { kind: "notice", id: "e1", ts: 4, level: "error", text: "API Error: Request rejected (429) · Qoder: usage limit reached: the account's credits are used up (0 / 0 credits)" },
      { kind: "notice", id: "e2", ts: 5, level: "error", text: "电脑离线" },
    ]);
    expect(blocks.map((block) => block.id)).toEqual(["u1", "e1", "e2"]);
    expect(blocks[1]).toEqual({ kind: "notice", id: "e1", level: "error", text: "模型调用失败：模型服务的额度已用完", failure: true });
    expect(blocks[2]).toMatchObject({ text: "电脑离线" });
    expect(blocks[2]).not.toHaveProperty("failure");
  });

  it("hides task notices and legacy queued notifications, but renders user-pasted XML", () => {
    const text = "<task-notification><task-id>task-1</task-id><output-file>/private/task.log</output-file><status>completed</status><summary>private output</summary></task-notification>";
    const blocks = groupItems([
      toolItem("t1", 1),
      { kind: "notice", id: "event", ts: 2, text: "", level: "info", taskEnd: { id: "task-1", state: "completed" } },
      { kind: "notice", id: "old-notice", ts: 3, text, level: "info" },
      { kind: "user", id: "old-queued", ts: 4, text, queued: true },
      toolItem("t2", 5),
      { kind: "user", id: "input", ts: 6, text },
      { kind: "user", id: "queued-input", ts: 7, text, queued: true, queuedByUser: true },
    ]);
    expect(blocks.map(block => block.id)).toEqual(["t1", "input", "queued-input"]);
    expect(blocks[0]).toMatchObject({ kind: "activity", items: [{ id: "t1" }, { id: "t2" }] });
  });

  it("merges adjacent tool and thinking items into one activity block", () => {
    const blocks = groupItems([userItem("u1", 1), thinking("k1", 2), toolItem("t1", 3), assistantItem("a1", 4), toolItem("t2", 5)]);
    expect(blocks.map((block) => block.kind)).toEqual(["user", "activity", "assistant", "activity"]);
    expect(blocks[1]).toMatchObject({ kind: "activity", items: [{ id: "k1" }, { id: "t1" }] });
  });

  it("shows an interrupted turn as a notice and hides the other turn markers", () => {
    const blocks = groupItems([
      { kind: "turn", id: "n1", ts: 1, phase: "started" },
      assistantItem("a1", 2),
      { kind: "turn", id: "n2", ts: 3, phase: "aborted" },
      { kind: "turn", id: "n3", ts: 4, phase: "ended" },
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(["assistant", "notice"]);
    expect(blocks[1]).toMatchObject({ text: "已中断" });
  });

  it("keeps notices with their level", () => {
    expect(groupItems([{ kind: "notice", id: "x", ts: 1, level: "error", text: "出错了" }])[0]).toMatchObject({ kind: "notice", level: "error", text: "出错了" });
  });
});

describe("activityStats", () => {
  it("counts steps, failures and running tools", () => {
    const stats = activityStats(asActivity([toolItem("t1", 1, "ok"), toolItem("t2", 2, "error"), toolItem("t3", 3, "running"), thinking("k", 4)]));
    expect(stats.stepCount).toBe(4);
    expect(stats.live).toBe(true);
    expect(stats.steps.filter((step) => step.status === "failed")).toHaveLength(1);
    expect(stats.steps[3].tool_name).toBe("thinking");
  });

  it("is not live without a running tool", () => {
    expect(activityStats(asActivity([toolItem("t1", 1, "ok")])).live).toBe(false);
  });
});

describe("small helpers", () => {
  it("cuts a tool input to its first line", () => {
    expect(toolSummary("ls -la\nsecond")).toBe("ls -la");
    expect(toolSummary("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("names the oldest loaded id", () => {
    expect(oldestId([userItem("u1", 1), userItem("u2", 2)])).toBe("u1");
    expect(oldestId([])).toBeUndefined();
  });
});

describe("replyTails", () => {
  it("marks only the last assistant block of each reply", () => {
    const blocks = groupItems([
      userItem("u1", 1, "做个贪吃蛇"),
      assistantItem("a1", 2, "先看一下目录"),
      toolItem("t1", 3),
      assistantItem("a2", 4, "做好了"),
      userItem("u2", 5, "再加个计分"),
      assistantItem("a3", 6, "正在改"),
    ]);
    expect([...replyTails(blocks)]).toEqual(["a2", "a3"]);
  });
});

describe("progress duration", () => {
  it("records elapsed turn duration on folded progress rows and formats it cleanly", () => {
    const start = 1_700_000_000_000;
    const rows = transcriptRows([
      userItem("u1", start, "帮我排查"),
      toolItem("t1", start + 5_000, "ok"),
      assistantItem("a1", start + 4 * 60_000, "已定位原因"),
    ], false);
    const progress = rows.find((row) => row.kind === "progress");
    expect(progress).toMatchObject({ kind: "progress", durationMs: 4 * 60_000 });
    expect(formatWorkDuration(progress?.kind === "progress" ? progress.durationMs : undefined)).toBe("用时 4分钟");
    expect(formatWorkDuration(500)).toBeUndefined();
    expect(formatWorkDuration(12_000)).toBe("用时 12秒");
    expect(formatWorkDuration(90 * 60_000)).toBe("用时 1小时30分钟");
  });
});
