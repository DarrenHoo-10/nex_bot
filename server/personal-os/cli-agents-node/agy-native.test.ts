import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SUMMARY_MAX, parseCliItems } from "../../../shared/cli-agents.ts";
import { agyRecordItems, agyUserText, deleteAgyConversation, isAgyArchived, scanAgyHistory, setAgyArchived } from "./agy-native.ts";

// What AGY 1.5.x records for a message sent after a model switch.
const WRAPPED = `<USER_REQUEST>
hi，测试一下新建会话
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-11-26T09:10:07+08:00.
</ADDITIONAL_METADATA>
<USER_SETTINGS_CHANGE>
The user changed setting \`Model Selection\` from None to Gemini 4 Neon (High). No need to comment on this change if the user doesn't ask about it.
</USER_SETTINGS_CHANGE>`;

describe("AGY user input", () => {
  it("keeps only what the user typed", () => {
    expect(agyUserText(WRAPPED)).toBe("hi，测试一下新建会话");
    expect(agyRecordItems({ type: "USER_INPUT", step_index: 3, created_at: "2026-11-26T01:10:07Z", content: WRAPPED }))
      .toEqual([{ id: "agy:3", ts: Date.parse("2026-11-26T01:10:07Z"), kind: "user", text: "hi，测试一下新建会话" }]);
  });

  it("drops input that is only AGY's own blocks and keeps plain text as it is", () => {
    expect(agyRecordItems({ type: "USER_INPUT", step_index: 4, content: "<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>" })).toEqual([]);
    expect(agyUserText("native context")).toBe("native context");
    expect(agyUserText("compare <b> and </b>")).toBe("compare <b> and </b>");
  });

  it("leaves the agent's replies alone", () => {
    expect(agyRecordItems({ type: "PLANNER_RESPONSE", step_index: 5, content: "<USER_REQUEST>x</USER_REQUEST>" })[0]).toMatchObject({ kind: "assistant", text: "<USER_REQUEST>x</USER_REQUEST>" });
  });

  it("summarizes known args and caps thinking and unknown tool input to SUMMARY_MAX so the page stays wire-valid", () => {
    const items = agyRecordItems({
      type: "PLANNER_RESPONSE",
      step_index: 85,
      created_at: "2026-11-26T13:37:25Z",
      thinking: "思".repeat(SUMMARY_MAX),
      content: "已完成修改",
      tool_calls: [
        { name: "edit_file", args: { Path: "HarnessMark.tsx", Replacement: "x".repeat(SUMMARY_MAX * 2) } },
        { name: "custom_blob_tool", args: { RawPayload: "y".repeat(SUMMARY_MAX * 2) } },
      ],
    });
    const parsed = parseCliItems(items);
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("expected valid wire items");
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({ kind: "thinking" });
    expect(parsed[1]).toMatchObject({ kind: "assistant", text: "已完成修改" });
    expect(parsed[2]).toMatchObject({ kind: "tool", name: "edit_file", input: "HarnessMark.tsx" });
    expect(parsed[3]).toMatchObject({ kind: "tool", name: "custom_blob_tool" });
    expect(parsed[0].kind === "thinking" && parsed[0].text.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(parsed[3].kind === "tool" && parsed[3].input.length).toBeLessThanOrEqual(SUMMARY_MAX);
  });

  it("skips empty 0-step ghost summaries with zero timestamp and no transcript", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agy-native-test-"));
    try {
      const db = new DatabaseSync(path.join(dir, "conversation_summaries.db"));
      db.exec(`CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, status TEXT, not_fully_idle INTEGER, killed INTEGER,
        title TEXT, workspace_uris TEXT, last_modified_time TEXT
      )`);
      const ghostId = "2cbe095e-7f88-4d82-b2d2-01bae7106ba2";
      const realId = "c1290c97-1ee2-4f68-8895-b37bf277cf9e";
      const stmt = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)");
      stmt.run(ghostId, "CASCADE_RUN_STATUS_IDLE", 0, 0, "", JSON.stringify(["/work/wt"]), "0001-01-01 00:00:00+00:00");
      stmt.run(realId, "CASCADE_RUN_STATUS_IDLE", 0, 0, "Real Session", JSON.stringify(["/work/wt"]), "2026-11-26T13:41:57Z");
      db.close();
      const rows = await scanAgyHistory(dir, "linux");
      expect(rows.map((entry) => entry.row.nativeId)).toEqual([realId]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archives, unarchives and permanently deletes an AGY conversation on disk", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agy-native-manage-"));
    try {
      const id = "c1290c97-1ee2-4f68-8895-b37bf277cf9e";
      const db = new DatabaseSync(path.join(dir, "conversation_summaries.db"));
      db.exec(`CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, status TEXT, not_fully_idle INTEGER, killed INTEGER,
        title TEXT, workspace_uris TEXT, last_modified_time TEXT
      )`);
      db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, "CASCADE_RUN_STATUS_IDLE", 0, 0, "Archive Me", JSON.stringify(["/work/wt"]), "2026-11-26T13:41:57Z");
      db.close();
      mkdirSync(path.join(dir, "conversations"), { recursive: true });
      mkdirSync(path.join(dir, "brain", id), { recursive: true });
      mkdirSync(path.join(dir, "cache"), { recursive: true });
      writeFileSync(path.join(dir, "conversations", `${id}.pb`), "pb");
      writeFileSync(path.join(dir, "brain", id, "note.md"), "note");
      writeFileSync(path.join(dir, "cache", "conversation_metadata.json"), JSON.stringify({ [id]: { title: "Archive Me" } }));

      expect(await isAgyArchived(dir, id)).toBe(false);
      await setAgyArchived(dir, id, true);
      expect(await isAgyArchived(dir, id)).toBe(true);
      expect((await scanAgyHistory(dir, "linux"))[0]?.row.archived).toBe(true);

      await setAgyArchived(dir, id, false);
      expect(await isAgyArchived(dir, id)).toBe(false);
      expect((await scanAgyHistory(dir, "linux"))[0]?.row.archived).toBeUndefined();

      await deleteAgyConversation(dir, id);
      expect(existsSync(path.join(dir, "conversations", `${id}.pb`))).toBe(false);
      expect(existsSync(path.join(dir, "annotations", `${id}.pbtxt`))).toBe(false);
      expect(existsSync(path.join(dir, "brain", id))).toBe(false);
      expect(await scanAgyHistory(dir, "linux")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
