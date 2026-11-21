import { describe, expect, it } from "vitest";
import { ITEM_TEXT_MAX, SUMMARY_MAX, TOOL_OUTPUT_MAX, parseCliItem, utf8ByteLength, type CliItem } from "../../../shared/cli-agents.ts";
import { claudeRecordToItems, codexRecordToItems, summarizeInput, type ItemContext } from "./items.ts";

const TS = "2026-11-15T10:00:00.000Z";
const MS = Date.parse(TS);

function ctx(extra: Partial<ItemContext> = {}): ItemContext {
  return { segment: "seg", offset: 42, tools: new Map(), ...extra };
}

function expectValid(items: CliItem[]): void {
  for (const item of items) expect(parseCliItem(item), JSON.stringify(item)).not.toBeNull();
}

function claude(record: unknown, c = ctx()) {
  const result = claudeRecordToItems(record, c);
  expectValid(result.items);
  return result;
}

function codex(record: unknown, c = ctx()) {
  const result = codexRecordToItems(record, c);
  expectValid(result.items);
  return result;
}

describe("claude: user records", () => {
  it("maps a string content to a user item", () => {
    const { items } = claude({ type: "user", uuid: "u1", timestamp: TS, message: { role: "user", content: "hello" } });
    expect(items).toEqual([{ kind: "user", id: "u1", ts: MS, text: "hello" }]);
  });

  it("joins text blocks and skips isMeta", () => {
    const { items } = claude({ type: "user", uuid: "u2", timestamp: TS, message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } });
    expect(items[0]).toMatchObject({ kind: "user", text: "a\n\nb" });
    expect(claude({ type: "user", uuid: "u3", isMeta: true, message: { content: "caveat" } }).items).toEqual([]);
  });

  it("records only local image paths, never image data", () => {
    const { items } = claude({
      type: "user",
      uuid: "u4",
      timestamp: TS,
      message: {
        content: [
          { type: "text", text: "see [Image: source: C:\\tmp\\a.png]" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "image", source: { type: "file", path: "/tmp/b.png" } },
        ],
      },
    });
    expect(items).toHaveLength(1);
    const user = items[0] as Extract<CliItem, { kind: "user" }>;
    expect(user.text).toBe("see");
    expect(user.images).toEqual(["/tmp/b.png", "C:\\tmp\\a.png"]);
    expect(JSON.stringify(items)).not.toContain("AAAA");
  });

  it("gives an image with no path a placeholder text", () => {
    const { items } = claude({ type: "user", uuid: "u5", message: { content: [{ type: "image", source: { type: "base64", data: "QQ" } }] } });
    expect(items[0]).toMatchObject({ kind: "user", text: "[image]" });
  });

  it("completes the matching tool from a tool_result block", () => {
    const c = ctx();
    const use = claude({ type: "assistant", uuid: "a1", timestamp: TS, message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } }] } }, c);
    expect(use.items[0]).toMatchObject({ kind: "tool", id: "a1:0", name: "Bash", input: "ls -la", status: "running" });
    const done = claude({ type: "user", uuid: "u6", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "file.txt" }] }] } }, c);
    expect(done.items).toEqual([{ kind: "tool", id: "a1:0", ts: MS, name: "Bash", input: "ls -la", status: "ok", output: "file.txt" }]);
    // the emitted running item was a copy, so it stays running
    expect(use.items[0]).toMatchObject({ status: "running" });
  });

  it("marks a failed tool_result as error and ignores unknown tool ids", () => {
    const c = ctx();
    claude({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x" } }] } }, c);
    const failed = claude({ type: "user", uuid: "u7", message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "no such file" }] } }, c);
    expect(failed.items[0]).toMatchObject({ status: "error", output: "no such file" });
    const orphan = claude({ type: "user", uuid: "u8", message: { content: [{ type: "tool_result", tool_use_id: "toolu_missing", content: "x" }] } }, c);
    expect(orphan.items).toEqual([]);
  });

  it("turns a compact summary into a notice without the summary body", () => {
    const { items } = claude({ type: "user", uuid: "u9", timestamp: TS, isCompactSummary: true, message: { content: "SECRET SUMMARY BODY" } });
    expect(items).toEqual([{ kind: "notice", id: "u9", ts: MS, level: "info", text: "上下文已压缩" }]);
  });
});

describe("claude: assistant records", () => {
  it("maps text, thinking and tool_use blocks with <uuid>:<blockIndex> ids", () => {
    const { items, row } = claude({
      type: "assistant",
      uuid: "a3",
      timestamp: TS,
      message: {
        model: "claude-opus-4",
        content: [
          { type: "thinking", thinking: "hmm", signature: "s" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a.ts", old_string: "x" } },
        ],
      },
    });
    expect(items.map((i) => [i.kind, i.id])).toEqual([["thinking", "a3:0"], ["assistant", "a3:1"], ["tool", "a3:2"]]);
    expect(items[2]).toMatchObject({ input: "/a.ts", status: "running" });
    expect(row).toEqual({ model: "claude-opus-4" });
  });

  it("skips empty thinking, empty text and synthetic models", () => {
    const { items, row } = claude({ type: "assistant", uuid: "a4", message: { model: "<synthetic>", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "  " }] } });
    expect(items).toEqual([]);
    expect(row).toBeUndefined();
  });

  it("maps an API error assistant message to an error notice", () => {
    const { items } = claude({ type: "assistant", uuid: "a5", timestamp: TS, isApiErrorMessage: true, message: { content: [{ type: "text", text: "API Error: 529 overloaded" }] } });
    expect(items).toEqual([{ kind: "notice", id: "a5:0", ts: MS, level: "error", text: "API Error: 529 overloaded" }]);
  });

  it("summarizes tool input as JSON when there is no well-known key", () => {
    const { items } = claude({ type: "assistant", uuid: "a6", message: { content: [{ type: "tool_use", id: "t", name: "Custom", input: { a: 1, b: [2] } }] } });
    expect(items[0]).toMatchObject({ input: '{"a":1,"b":[2]}' });
  });

  it("shows a sub-agent call by its task name, not its whole brief", () => {
    const prompt = "Read every file under src and report…\n".repeat(40);
    const { items } = claude({ type: "assistant", uuid: "a7", message: { content: [{ type: "tool_use", id: "t", name: "Agent", input: { description: "Survey the sidebar", prompt, subagent_type: "Explore" } }] } });
    expect(items[0]).toMatchObject({ name: "Agent", input: "Survey the sidebar" });
  });

  it("shows a Codex spawn_agent call by its task name", () => {
    expect(summarizeInput({ task_name: "review_sidebar", message: "Look at…\n".repeat(50), fork_turns: "none" })).toBe("review_sidebar");
  });
});

describe("claude: system, attachment, sidechain, metadata, ignored", () => {
  it("maps api_error, compact_boundary and local_command to notices", () => {
    const error = claude({ type: "system", subtype: "api_error", uuid: "s1", timestamp: TS, error: { status: 500, error: { error: { message: "boom" } } } });
    expect(error.items).toEqual([{ kind: "notice", id: "s1", ts: MS, level: "error", text: "boom" }]);
    const boundary = claude({ type: "system", subtype: "compact_boundary", uuid: "s2", timestamp: TS });
    expect(boundary.items).toEqual([{ kind: "notice", id: "s2", ts: MS, level: "info", text: "上下文已压缩" }]);
    const local = claude({ type: "system", subtype: "local_command", uuid: "s3", timestamp: TS, content: "<local-command-stdout>Set model to opus</local-command-stdout>" });
    expect(local.items).toEqual([{ kind: "notice", id: "s3", ts: MS, level: "info", text: "Set model to opus" }]);
  });

  it("ignores other system subtypes such as stop_hook_summary", () => {
    expect(claude({ type: "system", subtype: "stop_hook_summary", uuid: "s4" }).items).toEqual([]);
  });

  it("maps an attachment queued_command to a queued user item", () => {
    const { items } = claude({ type: "attachment", uuid: "t1", timestamp: TS, attachment: { type: "queued_command", prompt: "do it next", commandMode: "prompt" } });
    expect(items).toEqual([{ kind: "user", id: "t1", ts: MS, text: "do it next", queued: true }]);
    expect(claude({ type: "attachment", uuid: "t2", attachment: { type: "hook_success" } }).items).toEqual([]);
  });

  it("skips every isSidechain record", () => {
    expect(claude({ type: "assistant", uuid: "x", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } }).items).toEqual([]);
    expect(claude({ type: "user", uuid: "y", isSidechain: true, message: { content: "sub" } }).items).toEqual([]);
  });

  it("returns session-row updates for metadata records and no items", () => {
    expect(claude({ type: "custom-title", customTitle: "My title" })).toEqual({ items: [], row: { customTitle: "My title" } });
    expect(claude({ type: "agent-name", agentName: "builder" })).toEqual({ items: [], row: { agentName: "builder" } });
    expect(claude({ type: "mode", mode: "plan" })).toEqual({ items: [], row: { mode: "plan" } });
    expect(claude({ type: "pr-link", prNumber: 3, prUrl: "https://github.com/o/r/pull/3" })).toEqual({ items: [], row: { prUrl: "https://github.com/o/r/pull/3" } });
  });

  it("ignores housekeeping and unknown record types", () => {
    for (const type of ["queue-operation", "last-prompt", "file-history-snapshot", "api-request", "api-request-end", "cost-state", "tools-used", "atis-latch", "brand-new-type"]) {
      expect(claude({ type, uuid: "z", foo: 1 })).toEqual({ items: [] });
    }
    expect(claudeRecordToItems(null, ctx())).toEqual({ items: [] });
    expect(claudeRecordToItems("x", ctx())).toEqual({ items: [] });
    expect(claudeRecordToItems({}, ctx())).toEqual({ items: [] });
  });

  it("uses <segment>:<offset> ids when a record has no uuid", () => {
    const { items } = claude({ type: "user", message: { content: "hi" } }, ctx({ segment: "abc", offset: 1234 }));
    expect(items[0].id).toBe("abc:1234");
    const a = claude({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }, ctx({ segment: "abc", offset: 99 }));
    expect(a.items[0].id).toBe("abc:99:0");
  });
});

describe("truncation", () => {
  it("cuts assistant text, tool input, thinking and tool output at their byte limits", () => {
    const long = "字".repeat(200_000); // 600 KB
    const c = ctx();
    const { items } = claude({
      type: "assistant",
      uuid: "big",
      message: { content: [{ type: "text", text: long }, { type: "thinking", thinking: long }, { type: "tool_use", id: "tb", name: "Bash", input: { command: long } }] },
    }, c);
    expect(utf8ByteLength((items[0] as { text: string }).text)).toBeLessThanOrEqual(ITEM_TEXT_MAX);
    expect(utf8ByteLength((items[1] as { text: string }).text)).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(utf8ByteLength((items[2] as { input: string }).input)).toBeLessThanOrEqual(SUMMARY_MAX);
    const done = claude({ type: "user", uuid: "bigr", message: { content: [{ type: "tool_result", tool_use_id: "tb", content: long }] } }, c);
    expect(utf8ByteLength((done.items[0] as { output: string }).output)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX);
  });
});

// ---------------------------------------------------------------------------

function line(type: string, payload: Record<string, unknown>) {
  return { timestamp: TS, type, payload };
}

describe("codex: v2 item_completed", () => {
  const v2 = () => ctx({ codexV2: true, segment: "rollout-x", offset: 7 });
  const completed = (item: Record<string, unknown>) => line("event_msg", { type: "item_completed", thread_id: "t", turn_id: "turn1", item });

  it("maps UserMessage, AgentMessage and Reasoning", () => {
    const user = codex(completed({ type: "UserMessage", id: "i1", content: [{ type: "text", text: "hi" }, { type: "local_image", path: "/p.png" }] }), v2());
    expect(user.items).toEqual([{ kind: "user", id: "i1", ts: MS, text: "hi", images: ["/p.png"] }]);
    const agent = codex(completed({ type: "AgentMessage", id: "i2", content: [{ type: "Text", text: "done" }] }), v2());
    expect(agent.items).toEqual([{ kind: "assistant", id: "i2", ts: MS, text: "done" }]);
    const reasoning = codex(completed({ type: "Reasoning", id: "i3", summary_text: ["step one", "step two"], raw_content: [] }), v2());
    expect(reasoning.items).toEqual([{ kind: "thinking", id: "i3", ts: MS, text: "step one\nstep two" }]);
  });

  it("maps CommandExecution, McpToolCall, FileChange, ImageView and Extension to tools with completed/failed status", () => {
    const cmd = codex(completed({ type: "CommandExecution", id: "c1", command: ["bash", "-lc", "ls"], status: "completed", aggregated_output: "out", exit_code: 0 }), v2());
    expect(cmd.items[0]).toMatchObject({ kind: "tool", id: "c1", name: "shell", input: "bash -lc ls", status: "ok", output: "out" });
    const failedCmd = codex(completed({ type: "CommandExecution", id: "c2", command: "false", status: "failed", aggregated_output: "" }), v2());
    expect(failedCmd.items[0]).toMatchObject({ status: "error" });
    const mcp = codex(completed({ type: "McpToolCall", id: "m1", server: "fs", tool: "read", arguments: { path: "/a" }, status: "completed", result: { text: "ok" } }), v2());
    expect(mcp.items[0]).toMatchObject({ name: "fs.read", input: "/a", status: "ok", output: '{"text":"ok"}' });
    const mcpErr = codex(completed({ type: "McpToolCall", id: "m2", server: "fs", tool: "read", arguments: {}, status: "failed", error: { message: "denied" } }), v2());
    expect(mcpErr.items[0]).toMatchObject({ status: "error", output: "denied" });
    const file = codex(completed({ type: "FileChange", id: "f1", status: "completed", changes: [{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@" }] }), v2());
    expect(file.items[0]).toMatchObject({ name: "apply_patch", input: "a.ts", status: "ok", output: "@@ -1 +1 @@" });
    const image = codex(completed({ type: "ImageView", id: "v1", path: "/img.png" }), v2());
    expect(image.items[0]).toMatchObject({ name: "view_image", input: "/img.png", status: "ok" });
    const ext = codex(completed({ type: "Extension", id: "e1", name: "ext.tool", arguments: { q: 1 }, status: "completed" }), v2());
    expect(ext.items[0]).toMatchObject({ name: "ext.tool", status: "ok" });
  });

  it("maps ContextCompaction and SubAgentActivity to notices", () => {
    expect(codex(completed({ type: "ContextCompaction", id: "k1" }), v2()).items).toEqual([{ kind: "notice", id: "k1", ts: MS, level: "info", text: "上下文已压缩" }]);
    const sub = codex(completed({ type: "SubAgentActivity", id: "k2", description: "reviewer" }), v2());
    expect(sub.items[0]).toMatchObject({ kind: "notice", id: "k2", level: "info" });
  });

  it("uses <segment>:<offset> when the item has no id and ignores unknown item types", () => {
    const { items } = codex(completed({ type: "AgentMessage", content: [{ type: "Text", text: "x" }] }), v2());
    expect(items[0].id).toBe("rollout-x:7");
    expect(codex(completed({ type: "HologramThing", id: "q" }), v2()).items).toEqual([]);
  });

  it("ignores response_item and event_msg agent/user messages in a v2 file", () => {
    expect(codex(line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "dup" }] }), v2()).items).toEqual([]);
    expect(codex(line("event_msg", { type: "agent_message", message: "dup" }), v2()).items).toEqual([]);
    expect(codex(line("event_msg", { type: "user_message", message: "dup" }), v2()).items).toEqual([]);
  });
});

describe("codex: response_item fallback", () => {
  const plain = () => ctx({ segment: "rollout-y", offset: 100 });

  it("ignores item_completed when the file was not detected as v2", () => {
    expect(codex(line("event_msg", { type: "item_completed", item: { type: "AgentMessage", id: "z", content: [{ type: "Text", text: "x" }] } }), plain()).items).toEqual([]);
  });

  it("maps user and assistant messages and skips injected context and developer role", () => {
    const user = codex(line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] }), plain());
    expect(user.items).toEqual([{ kind: "user", id: "rollout-y:100", ts: MS, text: "fix it" }]);
    const assistant = codex(line("response_item", { type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: "ok" }] }), plain());
    expect(assistant.items).toEqual([{ kind: "assistant", id: "msg_1", ts: MS, text: "ok" }]);
    expect(codex(line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/x</cwd>" }] }), plain()).items).toEqual([]);
    expect(codex(line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] }), plain()).items).toEqual([]);
  });

  it("maps reasoning summaries and skips encrypted-only reasoning", () => {
    const r = codex(line("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "thinking about it" }], encrypted_content: "xx" }), plain());
    expect(r.items[0]).toMatchObject({ kind: "thinking", text: "thinking about it" });
    expect(codex(line("response_item", { type: "reasoning", summary: [], encrypted_content: "xx" }), plain()).items).toEqual([]);
  });

  it("maps function_call and its output to one tool", () => {
    const c = plain();
    const call = codex(line("response_item", { type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","ls"]}', call_id: "call_1" }), c);
    expect(call.items[0]).toMatchObject({ kind: "tool", id: "call_1", name: "shell", input: "bash -lc ls", status: "running" });
    const out = codex(line("response_item", { type: "function_call_output", call_id: "call_1", output: '{"output":"a\\nb","metadata":{"exit_code":0}}' }), c);
    expect(out.items[0]).toMatchObject({ id: "call_1", status: "ok", output: "a\nb" });
    const c2 = plain();
    codex(line("response_item", { type: "function_call", name: "shell", arguments: "{}", call_id: "call_2" }), c2);
    const bad = codex(line("response_item", { type: "function_call_output", call_id: "call_2", output: '{"output":"nope","metadata":{"exit_code":2}}' }), c2);
    expect(bad.items[0]).toMatchObject({ status: "error", output: "nope" });
  });

  it("maps custom_tool_call and custom_tool_call_output", () => {
    const c = plain();
    const call = codex(line("response_item", { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch", call_id: "call_3", status: "completed" }), c);
    expect(call.items[0]).toMatchObject({ name: "apply_patch", input: "*** Begin Patch", status: "running" });
    const out = codex(line("response_item", { type: "custom_tool_call_output", call_id: "call_3", output: "Done!" }), c);
    expect(out.items[0]).toMatchObject({ status: "ok", output: "Done!" });
    expect(codex(line("response_item", { type: "function_call_output", call_id: "unknown", output: "x" }), c).items).toEqual([]);
  });

  it("maps web_search_call", () => {
    const { items } = codex(line("response_item", { type: "web_search_call", status: "completed", action: { type: "search", query: "vitest docs" } }), plain());
    expect(items[0]).toMatchObject({ kind: "tool", name: "web_search", input: "vitest docs", status: "ok" });
  });

  it("ignores event_msg agent_message and user_message", () => {
    expect(codex(line("event_msg", { type: "agent_message", message: "dup" }), plain()).items).toEqual([]);
    expect(codex(line("event_msg", { type: "user_message", message: "dup" }), plain()).items).toEqual([]);
  });
});

describe("codex: turns, compaction, rows, unknown", () => {
  it("maps task_started, task_complete and turn_aborted to turn items", () => {
    expect(codex(line("event_msg", { type: "task_started", turn_id: "t1" })).items).toEqual([{ kind: "turn", id: "t1:started", ts: MS, phase: "started" }]);
    expect(codex(line("event_msg", { type: "task_complete", turn_id: "t1" })).items).toEqual([{ kind: "turn", id: "t1:ended", ts: MS, phase: "ended" }]);
    expect(codex(line("event_msg", { type: "turn_aborted", turn_id: "t2", reason: "interrupted" })).items).toEqual([{ kind: "turn", id: "t2:aborted", ts: MS, phase: "aborted" }]);
    expect(codex(line("event_msg", { type: "task_started" })).items[0].id).toBe("seg:42");
  });

  it("maps compacted and context_compacted to notices in both modes", () => {
    for (const c of [ctx(), ctx({ codexV2: true })]) {
      expect(codex(line("compacted", { message: "", replacement_history: [] }), c).items[0]).toMatchObject({ kind: "notice", text: "上下文已压缩" });
      expect(codex(line("event_msg", { type: "context_compacted" }), c).items[0]).toMatchObject({ kind: "notice" });
    }
  });

  it("turn_context.model updates the session row and makes no item", () => {
    expect(codex(line("turn_context", { model: "gpt-5-codex", cwd: "/x" }))).toEqual({ items: [], row: { model: "gpt-5-codex" } });
  });

  it("makes no item for token_count, world_state, session_meta or unknown records", () => {
    for (const [t, p] of [["event_msg", { type: "token_count" }], ["world_state", { a: 1 }], ["session_meta", { id: "x" }], ["something_new", { a: 1 }], ["event_msg", { type: "brand_new" }]] as const) {
      expect(codex(line(t, p as Record<string, unknown>)).items).toEqual([]);
    }
    expect(codexRecordToItems({ type: "event_msg" }, ctx())).toEqual({ items: [] });
    expect(codexRecordToItems(7, ctx())).toEqual({ items: [] });
  });

  it("truncates codex text and tool output", () => {
    const long = "x".repeat(400_000);
    const c = ctx();
    const text = codex(line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: long }] }), c);
    expect(utf8ByteLength((text.items[0] as { text: string }).text)).toBeLessThanOrEqual(ITEM_TEXT_MAX);
    codex(line("response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: long }), call_id: "big" }), c);
    const out = codex(line("response_item", { type: "function_call_output", call_id: "big", output: long }), c);
    expect(utf8ByteLength((out.items[0] as { output: string }).output)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX);
    expect(utf8ByteLength((c.tools!.get("big") as { input: string }).input)).toBeLessThanOrEqual(SUMMARY_MAX);
  });
});
