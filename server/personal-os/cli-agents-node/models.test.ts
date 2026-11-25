import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliModelCatalog } from "../../../shared/cli-agents.ts";
import { claudeCapabilities, claudeModels, codexModels, tomlTopLevel } from "./models.ts";

const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cli-models-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function claudeSettings(dir: string, settings: unknown): void {
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify(settings));
}

// no managed settings on the test machine: point them at an empty folder
const env = (extra: Record<string, string> = {}) => ({ ProgramFiles: path.join(os.tmpdir(), "no-such-program-files"), ...extra });

describe("Claude Code's /model rows", () => {
  it("lists the built-in lineup, renamed by the env, then the settings' modelPicker rows", async () => {
    const dir = home();
    claudeSettings(dir, {
      model: "sonnet[1m]",
      effortLevel: "high",
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "gw/opus-x",
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Opus via gateway",
        CLAUDE_CODE_MODEL_CAPABILITIES: "gw/opus-x=effort,xhigh_effort;auto/claude-opus-5-5=effort,xhigh_effort,max_effort",
      },
      modelPicker: { options: [
        { model: "auto/claude-opus-5-5[1m]", label: "Claude Opus 5.5 · routing group", description: "via magpie" },
        { model: "bad model name" },
      ] },
    });
    const catalog = await claudeModels({ platform: "win32", homedir: dir, env: env() });
    expect(catalog.current).toBe("sonnet[1m]");
    expect(catalog.currentEffort).toBe("high");
    expect(catalog.models.map((row) => [row.id, row.label])).toEqual([
      ["fable", "Fable"],
      ["opus", "Opus via gateway"],
      ["sonnet", "Sonnet"],
      ["haiku", "Haiku"],
      ["auto/claude-opus-5-5[1m]", "Claude Opus 5.5 · routing group"],
    ]);
    const byId = new Map(catalog.models.map((row) => [row.id, row]));
    expect(byId.get("opus")).toMatchObject({ description: "gw/opus-x", efforts: ["low", "medium", "high", "xhigh"] });
    expect(byId.get("sonnet")?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // `[1m]` shares the capabilities of the plain id
    expect(byId.get("auto/claude-opus-5-5[1m]")).toMatchObject({ description: "via magpie", efforts: ["low", "medium", "high", "xhigh", "max"] });
    // what Core and the page accept back
    expect(parseCliModelCatalog(catalog)).toEqual(catalog);
  });

  it("shows only the settings' rows with replaceBuiltInOptions, and only allowed models", async () => {
    const dir = home();
    claudeSettings(dir, {
      availableModels: ["gw/a", "opus"],
      modelPicker: { replaceBuiltInOptions: true, options: [{ model: "gw/a", label: "A" }, { model: "gw/b", label: "B" }] },
    });
    const catalog = await claudeModels({ platform: "linux", homedir: dir, env: {} });
    expect(catalog.models.map((row) => row.id)).toEqual(["gw/a"]);
  });

  it("reads CLAUDE_CONFIG_DIR and the custom model option; no settings is the lineup", async () => {
    const dir = home();
    const config = path.join(dir, "other");
    mkdirSync(config);
    writeFileSync(path.join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_CUSTOM_MODEL_OPTION: "my/model", ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Mine" } }));
    const custom = await claudeModels({ platform: "win32", homedir: dir, env: env({ CLAUDE_CONFIG_DIR: config }) });
    expect(custom.models.at(-1)).toEqual({ id: "my/model", label: "Mine" });
    const bare = await claudeModels({ platform: "win32", homedir: home(), env: env() });
    expect(bare.models.map((row) => row.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(bare.current).toBeUndefined();
  });

  it("parses CLAUDE_CODE_MODEL_CAPABILITIES", () => {
    expect([...claudeCapabilities("a=effort;b=effort,max_effort;c=;bad").entries()]).toEqual([
      ["a", ["low", "medium", "high"]],
      ["b", ["low", "medium", "high", "max"]],
      ["c", []],
    ]);
  });
});

describe("Codex's /model rows", () => {
  it("lists models_cache.json by priority without hidden rows, with config.toml's defaults", async () => {
    const dir = home();
    const codex = path.join(dir, ".codex");
    mkdirSync(codex);
    writeFileSync(path.join(codex, "models_cache.json"), JSON.stringify({ models: [
      { slug: "gpt-b", display_name: "GPT-B", visibility: "list", priority: 2, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "nonsense" }] },
      { slug: "gpt-a", display_name: "GPT-A", description: "fast", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "medium" }] },
      { slug: "gpt-hidden", visibility: "hide", priority: 0 },
    ] }));
    writeFileSync(path.join(codex, "config.toml"), 'model = "gpt-b"\nmodel_reasoning_effort = "high"\n\n[profiles.x]\nmodel = "other"\n');
    const catalog = await codexModels({ homedir: dir, env: {} });
    expect(catalog).toEqual({
      models: [
        { id: "gpt-a", label: "GPT-A", description: "fast", efforts: ["medium"] },
        { id: "gpt-b", label: "GPT-B", efforts: ["low", "high"] },
      ],
      current: "gpt-b",
      currentEffort: "high",
    });
  });

  it("falls back to the built-in suggestions without a cache", async () => {
    const catalog = await codexModels({ homedir: home(), env: {} });
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.current).toBeUndefined();
  });

  it("reads only top-level TOML keys", () => {
    expect(tomlTopLevel('# c\nmodel = "a"\n[x]\nmodel = "b"', "model")).toBe("a");
    expect(tomlTopLevel('[x]\nmodel = "b"', "model")).toBeUndefined();
    expect(tomlTopLevel("model_reasoning_effort = 'low'", "model_reasoning_effort")).toBe("low");
  });
});
