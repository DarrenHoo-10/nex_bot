import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SUMMARY_MAX, TOOL_OUTPUT_MAX, parseCliItems, type CliEngine } from "../../../shared/cli-agents.ts";
import { allHarnesses, createHarnessRegistry, harnessConfigEnv, harnessFor, type HarnessAdapter } from "./harness.ts";
import {
  appendItemText,
  buildAssistantItem,
  buildNoticeItem,
  buildThinkingItem,
  buildToolItem,
  buildUserItem,
  summarizeInput,
  updateToolItem,
} from "./items.ts";
import { cliArgs, registerLaunchStrategy } from "./launch.ts";
import { cliModels, registerModelProvider } from "./models.ts";
import { TranscriptReader } from "./reader.ts";
import { searchSessions } from "./search.ts";

describe("unified item builders and input summarization", () => {
  it("normalizes Claude, Codex and AGY tool arguments with one consistent priority order", () => {
    expect(summarizeInput({ command: "pnpm lint" })).toBe("pnpm lint");
    expect(summarizeInput({ CommandLine: "pnpm lint", Cwd: "D:/repo" })).toBe("pnpm lint");
    expect(summarizeInput({ file_path: "src/a.ts", new_string: "x".repeat(5000) })).toBe("src/a.ts");
    expect(summarizeInput({ Path: "HarnessMark.tsx", Replacement: "x".repeat(5000) })).toBe("HarnessMark.tsx");
    expect(summarizeInput({ Query: "MoreContent", SearchPath: "D:/repo" })).toBe("MoreContent");
    expect(summarizeInput({ DirectoryPath: "D:/repo" })).toBe("D:/repo");
    // Future harnesses may prioritize custom schema keys without editing items.ts
    expect(summarizeInput({ TargetSymbol: "HarnessRegistry", Fallback: "ignored" }, ["TargetSymbol"])).toBe("HarnessRegistry");
  });

  it("keeps every built and incrementally updated CliItem within wire protocol limits", () => {
    const thinking = buildThinkingItem({ id: "t1", ts: 1, text: "思".repeat(SUMMARY_MAX) });
    appendItemText(thinking, "额外思考".repeat(500));
    const tool = buildToolItem({ id: "tool1", ts: 2, name: "X".repeat(500), input: { Raw: "a".repeat(5000) }, status: "running" });
    updateToolItem(tool, { status: "ok", rawInput: { Blob: "b".repeat(5000) }, rawOutput: { Out: "c".repeat(TOOL_OUTPUT_MAX * 2) } });
    const items = [
      buildUserItem({ id: "u1", ts: 0, text: "hi" }),
      thinking,
      tool,
      buildAssistantItem({ id: "a1", ts: 3, text: "done" }),
      buildNoticeItem({ id: "n1", ts: 4, level: "error", text: "e".repeat(10_000) }),
    ];
    const parsed = parseCliItems(items);
    expect(parsed).not.toBeNull();
    expect(thinking.text.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(tool.input.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect((tool.output ?? "").length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX);
  });
});

describe("extensible harness registry and strategies", () => {
  it("declares features and configDir env declaratively for every built-in harness", () => {
    expect(allHarnesses().map((h) => h.id)).toEqual(["claude", "codex", "zcode", "agy"]);
    expect(harnessFor("claude")?.features).toMatchObject({ fork: true, hooks: true, modelPicker: true, screenPrompts: true });
    expect(harnessFor("codex")?.features).toMatchObject({ fork: true, transcriptTurnTails: true, unknownWriterCheck: true });
    expect(harnessFor("zcode")?.features).toMatchObject({ probe: "directory", fork: false, modelPicker: true });
    expect(harnessFor("agy")?.features).toMatchObject({ probe: "cli", fork: false, modelPicker: true, statusTurnFallback: true });
    expect(harnessConfigEnv("claude", "/home/u/.claude", "/home/u", "linux")).toEqual({});
    expect(harnessConfigEnv("claude", "/custom/claude", "/home/u", "linux")).toEqual({ CLAUDE_CONFIG_DIR: "/custom/claude" });
    expect(harnessConfigEnv("agy", "/custom/agy", "/home/u", "linux")).toEqual({ ANTIGRAVITY_CLI_CONFIG_DIR: "/custom/agy" });
  });

  it("supports isolated adapter registries, custom transcript strategies, and search across AGY transcripts", async () => {
    const custom: HarnessAdapter = {
      id: "claude",
      label: "Custom Override",
      features: { ...harnessFor("claude")!.features, fork: false },
      caps: () => ({ steer: false, interrupt: false, terminal: false, fork: "none" }),
    };
    const registry = createHarnessRegistry();
    const dispose = registry.register(custom);
    expect(registry.get("claude")?.label).toBe("Custom Override");
    dispose();
    expect(registry.get("claude")?.label).toBe("Claude Code");

    const dir = mkdtempSync(path.join(os.tmpdir(), "harness-ext-"));
    try {
      const agyFile = path.join(dir, "transcript_full.jsonl");
      writeFileSync(
        agyFile,
        [
          JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: "2026-11-26T10:00:00Z", content: "<USER_REQUEST>\n查找 HarnessRegistry 扩展\n</USER_REQUEST>" }),
          JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-26T10:00:05Z", content: "已定位到 harness.ts 适配器注册表" }),
        ].join("\n") + "\n",
      );
      // AGY transcripts now participate in searchSessions automatically via HarnessAdapter.transcript
      const hits = await searchSessions([{ ref: "agy:s1", engine: "agy", file: agyFile }], "适配器注册表");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ ref: "agy:s1" });

      // Custom transcript strategy plugs directly into TranscriptReader without engine branching
      const customFile = path.join(dir, "custom.jsonl");
      writeFileSync(customFile, JSON.stringify({ seq: 1, body: "hello from future harness" }) + "\n");
      const reader = new TranscriptReader({
        path: customFile,
        engine: "claude",
        watch: false,
        transcript: {
          mapRecord(record) {
            const row = record as { seq: number; body: string };
            return { items: [buildAssistantItem({ id: `future:${row.seq}`, ts: 1000, text: row.body })] };
          },
        },
      });
      const page = await reader.page();
      reader.close();
      expect(page.items).toEqual([{ kind: "assistant", id: "future:1", ts: 1000, text: "hello from future harness" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows registering and disposing custom launch and model strategies", async () => {
    const fakeEngine = "future-cli" as unknown as CliEngine;
    const disposeLaunch = registerLaunchStrategy(fakeEngine, {
      modeArgs: (mode, ids) => (mode === "resume" ? ["--id", ids.nativeId ?? "x"] : ["--new"]),
    });
    const disposeModels = registerModelProvider(fakeEngine, async () => ({
      models: [{ id: "future-1", label: "Future 1" }],
      current: "future-1",
    }));
    try {
      expect(cliArgs(fakeEngine, "new")).toEqual(["--new"]);
      expect(cliArgs(fakeEngine, "resume", { nativeId: "abc" })).toEqual(["--id", "abc"]);
      expect(await cliModels(fakeEngine)).toEqual({ models: [{ id: "future-1", label: "Future 1" }], current: "future-1" });
    } finally {
      disposeLaunch();
      disposeModels();
    }
    expect(await cliModels(fakeEngine)).toEqual({ models: [] });
  });
});
