import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliSessionWire } from "../../../shared/cli-agents.ts";
import { parseTranscriptEdges } from "./claude.ts";
import { claudeUsed, claudeWindow, codexContext, resetContextSettings } from "./context-usage.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "cli-context-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); resetContextSettings(); });

describe("context usage", () => {
  it("adds up what a Claude request carried and what it wrote", () => {
    expect(claudeUsed({ input_tokens: 2, cache_creation_input_tokens: 1113, cache_read_input_tokens: 774788, output_tokens: 353 })).toBe(776256);
    expect(claudeUsed(undefined)).toBe(0);
    expect(claudeUsed({ input_tokens: "x" })).toBe(0);
  });

  it("reads Codex's last request and window from token_count", () => {
    expect(codexContext({ type: "token_count", info: { last_token_usage: { input_tokens: 144266, output_tokens: 450, total_tokens: 144716 }, model_context_window: 475000 } }))
      .toEqual({ used: 144716, window: 475000 });
    expect(codexContext({ type: "token_count", info: null })).toBeUndefined();
  });

  it("takes Claude's window from the settings, the env cap or a 1M default model, else 200K", () => {
    const dir = temp();
    expect(claudeWindow(dir, "claude-opus-5-5", 50_000, {})).toBe(200_000);
    expect(claudeWindow(dir, "claude-opus-5-5", 300_000, {})).toBe(1_000_000);
    expect(claudeWindow(dir, "claude-opus-5-5", 50_000, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000" })).toBe(400_000);
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "sonnet[1m]" }));
    resetContextSettings();
    expect(claudeWindow(dir, "claude-sonnet-5-5", 50_000, {})).toBe(1_000_000);
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ autoCompactWindow: 600000, modelSettings: { "claude-opus-5-5": { autoCompactWindow: 900000 } } }));
    resetContextSettings();
    expect(claudeWindow(dir, "claude-opus-5-5", 50_000, {})).toBe(900_000);
    expect(claudeWindow(dir, "claude-haiku-5-5", 50_000, {})).toBe(600_000);
  });

  it("gives a session the desktop app runs on a [1m] model 1M, whatever the general compaction window", () => {
    const dir = temp();
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ autoCompactWindow: 272000, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1050000" }, modelSettings: { "proxy/claude-opus-5-5": { autoCompactWindow: 262144 } } }));
    resetContextSettings();
    expect(claudeWindow(dir, "claude-opus-5-5", 240_400, {}, "magpie.claude-opus-5-5[1m]")).toBe(1_000_000);
    expect(claudeWindow(dir, "claude-opus-5-5", 240_400, {}, "claude-opus-5-5")).toBe(272_000);
    expect(claudeWindow(dir, "claude-opus-5-5", 240_400, {})).toBe(272_000);
    // a window set for the launched model itself still wins
    expect(claudeWindow(dir, "claude-opus-5-5", 50_000, {}, "proxy/claude-opus-5-5[1m]")).toBe(262_144);
  });

  it("keeps the last main-thread request of a transcript, not a subagent's", async () => {
    const file = path.join(temp(), "s1.jsonl");
    const lines = [
      { type: "user", message: { content: "hi" }, cwd: "/w", timestamp: "2026-11-22T01:00:00Z" },
      { type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 90 } }, timestamp: "2026-11-22T01:00:05Z" },
      { type: "assistant", isSidechain: true, message: { model: "claude-haiku-5-5", usage: { input_tokens: 99999 } }, timestamp: "2026-11-22T01:00:06Z" },
    ];
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const entry = await parseTranscriptEdges(file, "s1", 4096, Date.now());
    expect(entry?.contextUsed).toBe(5100);
  });

  it("travels on the session row, and a usage the other side cannot read drops only itself", () => {
    const row = { engine: "claude", nativeId: "s1", configDir: "", cwd: "/w", title: "t", state: "idle", lastActivityAt: 1 };
    expect(parseCliSessionWire({ ...row, context: { used: 5100, window: 200000 } })?.context).toEqual({ used: 5100, window: 200000 });
    const odd = parseCliSessionWire({ ...row, context: { used: -1 } });
    expect(odd).not.toBeNull();
    expect(odd?.context).toBeUndefined();
  });
});
