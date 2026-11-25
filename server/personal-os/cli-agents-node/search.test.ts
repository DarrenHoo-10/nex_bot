// Content search over transcript files and database chats. Synthetic files in
// a temp directory only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_SEARCH, type CliItem, type CliSessionRef } from "../../../shared/cli-agents.ts";
import { searchSessions, searchTerms, snippetAround, type SearchSource } from "./search.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "nexbot-search-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (name: string, records: unknown[]): string => {
  const file = path.join(root, name);
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return file;
};

const claudeUser = (uuid: string, text: string) => ({ type: "user", uuid, timestamp: "2026-11-20T10:00:00Z", message: { role: "user", content: text } });
const claudeAssistant = (uuid: string, text: string) => ({ type: "assistant", uuid, timestamp: "2026-11-20T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const claudeTool = (uuid: string, output: string) => ({ type: "user", uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: output }] } });
const claudeToolUse = (uuid: string, command: string) => ({ type: "assistant", uuid, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] } });
const claudeThinking = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { content: [{ type: "thinking", thinking: text }] } });

const claudeSource = (id: string, records: unknown[]): SearchSource => ({ ref: `claude:${id}` as CliSessionRef, engine: "claude", file: jsonl(`${id}.jsonl`, records) });

describe("searchTerms and snippets", () => {
  it("splits on whitespace, lower-cases and dedupes", () => {
    expect(searchTerms("  Deploy  MAIN\tdeploy\n")).toEqual(["deploy", "main"]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("keeps a short text whole and on one line", () => {
    expect(snippetAround("fix the\n\nbuild   please", 8)).toBe("fix the build please");
  });

  it("cuts a long text around the hit with ellipses and stays within the cap", () => {
    const text = `${"a".repeat(500)} NEEDLE ${"b".repeat(500)}`;
    const snippet = snippetAround(text, 501);
    expect(snippet.length).toBeLessThanOrEqual(CLI_SEARCH.snippetMax);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("NEEDLE");
    expect(snippetAround(`NEEDLE ${"x".repeat(300)}`, 0)).toMatch(/^NEEDLE x+…$/);
    expect(snippetAround(`${"x".repeat(300)} NEEDLE`, 301)).toMatch(/^…x+ NEEDLE$/);
  });
});

describe("searchSessions", () => {
  it("matches when every term occurs somewhere in user or assistant text, across messages", async () => {
    const both = claudeSource("both", [claudeUser("u1", "Please Deploy the site"), claudeAssistant("a1", "Merged into MAIN and pushed")]);
    const one = claudeSource("one", [claudeUser("u1", "deploy only")]);
    const hits = await searchSessions([both, one], "deploy main");
    expect(hits).toEqual([{ ref: "claude:both", snippet: "Please Deploy the site" }]);
  });

  it("never counts tool output, tool input or thinking", async () => {
    const tools = claudeSource("tools", [
      claudeUser("u1", "run it"),
      claudeToolUse("a1", "echo zebra"),
      claudeTool("u2", "zebra output"),
      claudeThinking("a2", "thinking about zebra"),
    ]);
    expect(await searchSessions([tools], "zebra")).toEqual([]);
  });

  it("shows the first term where it first occurs and keeps the caller's order", async () => {
    const newer = claudeSource("newer", [claudeAssistant("a1", "nothing yet"), claudeUser("u1", "the Alpha plan"), claudeAssistant("a2", "alpha again")]);
    const older = claudeSource("older", [claudeUser("u1", "alpha first")]);
    const hits = await searchSessions([newer, older], "ALPHA");
    expect(hits).toEqual([{ ref: "claude:newer", snippet: "the Alpha plan" }, { ref: "claude:older", snippet: "alpha first" }]);
  });

  it("stops at the limit and when the budget runs out", async () => {
    const sources = Array.from({ length: 5 }, (_, i) => claudeSource(`s${i}`, [claudeUser("u1", "common word")]));
    expect(await searchSessions(sources, "common", { limit: 2 })).toHaveLength(2);
    let clock = 0;
    const hits = await searchSessions(sources, "common", { budgetMs: 10, now: () => (clock += 6) });
    expect(hits.length).toBeLessThan(5);
  });

  it("finds escaped and non-ASCII text, and terms JSON would escape", async () => {
    const source = claudeSource("cjk", [claudeUser("u1", '部署到 "main" 分支\nC:\\work'), claudeAssistant("a1", "好的")]);
    expect(await searchSessions([source], "部署 分支")).toHaveLength(1);
    expect(await searchSessions([source], '"main"')).toHaveLength(1);
    expect(await searchSessions([source], "c:\\work")).toHaveLength(1);
  });

  it("reads files in chunks: lines split across reads, a long line in the middle, no trailing newline", async () => {
    const file = path.join(root, "chunks.jsonl");
    const lines = [claudeUser("u1", "x".repeat(300)), claudeToolUse("a0", "y".repeat(5000)), claudeUser("u2", "needle in the middle"), claudeAssistant("a1", "final haystack")];
    writeFileSync(file, lines.map((record) => JSON.stringify(record)).join("\n"));
    const hits = await searchSessions([{ ref: "claude:chunks", engine: "claude", file }], "needle haystack", { chunkBytes: 64 });
    expect(hits).toEqual([{ ref: "claude:chunks", snippet: "needle in the middle" }]);
  });

  it("reads Codex v1 and v2 files and skips their injected context and tool output", async () => {
    const v1 = jsonl("v1.jsonl", [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>quokka</environment_context>" }] } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "quokka" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "the wombat" }] } },
    ]);
    const v2 = jsonl("v2.jsonl", [{ type: "event_msg", payload: { type: "item_completed", item: { type: "agentMessage", id: "m1", text: "a quokka appears" } } }]);
    const sources: SearchSource[] = [
      { ref: "codex:v1", engine: "codex", file: v1 },
      { ref: "codex:v2", engine: "codex", file: v2 },
    ];
    expect(await searchSessions(sources, "quokka")).toEqual([{ ref: "codex:v2", snippet: "a quokka appears" }]);
    expect(await searchSessions(sources, "wombat")).toEqual([{ ref: "codex:v1", snippet: "the wombat" }]);
  });

  it("searches database chats through their items and skips sources that fail", async () => {
    const items: CliItem[] = [
      { kind: "user", id: "1", ts: 1, text: "rename the table" },
      { kind: "tool", id: "2", ts: 2, name: "shell", input: "sqlite", status: "ok", output: "sqlite" },
      { kind: "assistant", id: "3", ts: 3, text: "renamed in sqlite" },
    ];
    const sources: SearchSource[] = [
      { ref: "zcode:broken", engine: "zcode", items: async () => { throw new Error("locked"); } },
      { ref: "codex:app", engine: "codex", items: async () => items },
      { ref: "claude:gone", engine: "claude", file: path.join(root, "missing.jsonl") },
    ];
    expect(await searchSessions(sources, "table sqlite")).toEqual([{ ref: "codex:app", snippet: "rename the table" }]);
  });
});
