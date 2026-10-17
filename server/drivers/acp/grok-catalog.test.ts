import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GrokAgentDriver, grokModelCatalogPending, pinGrokSessionModel, readGrokModelCatalog, STATIC_GROK_MODELS } from "./grok.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchConfig(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-grok-catalog-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, ".grok"), { recursive: true });
  writeFileSync(join(dir, ".grok", "config.toml"), toml);
  return dir;
}

describe("readGrokModelCatalog", () => {
  it("returns the static cloud models when there is no config", () => {
    expect(readGrokModelCatalog({ HOME: join(tmpdir(), "omb-grok-missing-home") })).toEqual(STATIC_GROK_MODELS);
  });

  it("appends local slugs from config.toml and prefers their display names", () => {
    const home = scratchConfig(`
[models]
default = "ollama-ornith-35b-bf16"

[model."grok-4.6"]
name = "should not replace the cloud label"

[model."ollama-ornith-35b-bf16"]
model = "ornith:35b-bf16"
name = "ornith:35b-bf16 (Ollama)"
api_key = "must-not-leak"

[model.omlx-minimax-m3]
name = "MiniMax M3 4bit (oMLX)"
`);

    expect(readGrokModelCatalog({ HOME: home })).toEqual({
      default: "ollama-ornith-35b-bf16",
      options: [
        { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
        { id: "grok-4.6", label: "Grok 4.6" },
        { id: "grok-4.5", label: "Grok 4.5" },
        { id: "ollama-ornith-35b-bf16", label: "ornith:35b-bf16 (Ollama)", custom: true },
        { id: "omlx-minimax-m3", label: "MiniMax M3 4bit (oMLX)", custom: true },
      ],
    });
  });

  it("ignores invalid slugs and a default that is not in the catalog", () => {
    const home = scratchConfig(`
[models]
default = "not-installed"

[model."bad slug"]
name = "nope"

[model.ok-model]
name = "OK"
`);
    const catalog = readGrokModelCatalog({ HOME: home });
    expect(catalog.default).toBe("grok-4.7");
    expect(catalog.options.map((o) => o.id)).toEqual(["grok-4.7", "grok-4.6", "grok-4.5", "ok-model"]);
  });

  it("honors GROK_HOME over HOME", () => {
    const ignored = scratchConfig(`[model.ignored]\nname = "Ignored"\n`);
    const grokHomeParent = mkdtempSync(join(tmpdir(), "omb-grok-home-"));
    const grokHome = join(grokHomeParent, "grok");
    scratchDirs.push(grokHomeParent);
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(join(grokHome, "config.toml"), `[model.from-grok-home]\nname = "From GROK_HOME"\n`);
    const catalog = readGrokModelCatalog({ HOME: ignored, GROK_HOME: grokHome });
    expect(catalog.options.map((o) => o.id)).toContain("from-grok-home");
    expect(catalog.options.map((o) => o.id)).not.toContain("ignored");
  });

  it("ignores default keys outside the [models] table", () => {
    const home = scratchConfig(`
[cli]
default = "grok-4.5"

[model.ok-model]
name = "OK"
`);
    expect(readGrokModelCatalog({ HOME: home }).default).toBe("grok-4.7");
  });
});

describe("GrokAgentDriver catalog", () => {
  it("loads the config catalog when the instance is created", async () => {
    const home = scratchConfig(`[model.local-glm]\nname = "GLM local"\n`);
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-catalog",
      displayName: "Grok",
      environment: { HOME: home, USERPROFILE: home },
      enabled: true,
      config: GrokAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.some((o) => o.id === "local-glm" && o.label === "GLM local")).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });
});

describe("pinGrokSessionModel", () => {
  const unknown = new Error("Invalid params: unknown model id (session/set_model)");

  it("treats a cloud slug's unknown id as a catalog that is still loading", () => {
    expect(grokModelCatalogPending("grok-4.7", unknown)).toBe(true);
    expect(grokModelCatalogPending("local-glm", unknown)).toBe(false);
    expect(grokModelCatalogPending("grok-4.7", new Error("method not found"))).toBe(false);
  });

  it("retries a cloud slug until the catalog accepts it", async () => {
    const calls: string[] = [];
    let now = 0;
    await pinGrokSessionModel(
      async (_method, params) => {
        calls.push((params as { modelId: string }).modelId);
        if (calls.length < 3) throw unknown;
      },
      "session-1",
      "grok-4.7",
      { now: () => now, sleep: async (ms) => { now += ms; }, deadlineMs: 60_000, pollMs: 1_000 },
    );
    expect(calls).toEqual(["grok-4.7", "grok-4.7", "grok-4.7"]);
  });

  it("does not wait on a local slug or a non-catalog error", async () => {
    const calls: string[] = [];
    const request = async (_method: string, params: unknown) => {
      calls.push((params as { modelId: string }).modelId);
      throw unknown;
    };
    await expect(pinGrokSessionModel(request, "session-1", "local-glm", {
      now: () => 0, sleep: async () => { throw new Error("should not wait"); },
    })).rejects.toThrow(/local-glm/);
    await expect(pinGrokSessionModel(async () => { throw new Error("method not found"); }, "session-1", "grok-4.7", {
      now: () => 0, sleep: async () => { throw new Error("should not wait"); },
    })).rejects.toThrow(/method not found/);
    expect(calls).toEqual(["local-glm"]);
  });

  it("stops waiting once the catalog deadline passes", async () => {
    let now = 0;
    let calls = 0;
    await expect(pinGrokSessionModel(async () => { calls += 1; throw unknown; }, "session-1", "grok-4.7", {
      now: () => now,
      sleep: async (ms) => { now += ms; },
      deadlineMs: 2_000,
      pollMs: 1_000,
    })).rejects.toThrow(/unknown model id/);
    expect(calls).toBe(3);
    expect(now).toBe(2_000);
  });
});
