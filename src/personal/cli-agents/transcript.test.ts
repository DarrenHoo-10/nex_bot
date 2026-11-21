import { describe, expect, it } from "vitest";
import type { CliItem } from "../../../shared/cli-agents";
import { assistantItem, toolItem, userItem } from "./fixtures";
import { activityStats, groupItems, mergeItems, oldestId, prependItems, resetItems, toolSummary, userTurns, type ActivityItem } from "./transcript";

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
