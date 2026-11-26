// The model picker rows each CLI shows in its own terminal, read from the CLI's
// files on this computer, so NexAgent offers the same choices.
//
// Claude Code 2.1 (`/model`): the built-in lineup (aliases, renamed through
// ANTHROPIC_DEFAULT_<ALIAS>_MODEL[_NAME|_DESCRIPTION]), ANTHROPIC_CUSTOM_MODEL_OPTION,
// then `modelPicker.options` from managed or user settings (the highest source that
// defines it wins outright; `replaceBuiltInOptions` hides the lineup), all filtered by
// `availableModels`. Effort levels per model come from CLAUDE_CODE_MODEL_CAPABILITIES.
//
// Codex 0.163 (`/model`): `models_cache.json` in CODEX_HOME, rows not hidden, by
// priority, each with its reasoning levels; `model` / `model_reasoning_effort` in
// config.toml are the defaults.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLI_EFFORTS, CLI_MODELS, isCliModel, type CliEngine, type CliModelCatalog, type CliModelOption } from "../../../shared/cli-agents.ts";

export interface ModelSourceOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

const FILE_MAX = 8 * 1024 * 1024;

type Json = Record<string, unknown>;

async function readJson(file: string): Promise<Json | null> {
  try {
    const text = await readFile(file, "utf8");
    if (text.length > FILE_MAX) return null;
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function managedSettingsFile(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return path.win32.join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json");
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** `claude-opus-5-5[1m]` and `claude-opus-5-5` share their capabilities. */
const baseModel = (id: string) => id.replace(/\[[^\]]*\]$/, "").toLowerCase();

/** CLAUDE_CODE_MODEL_CAPABILITIES: `model=effort,xhigh_effort,max_effort;…`. */
export function claudeCapabilities(value: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of (value ?? "").split(";")) {
    const at = entry.indexOf("=");
    if (at <= 0) continue;
    const flags = new Set(entry.slice(at + 1).split(",").map((flag) => flag.trim()));
    const levels = [
      ...(flags.has("effort") ? ["low", "medium", "high"] : []),
      ...(flags.has("xhigh_effort") ? ["xhigh"] : []),
      ...(flags.has("max_effort") ? ["max"] : []),
    ];
    out.set(baseModel(entry.slice(0, at).trim()), levels);
  }
  return out;
}

const CLAUDE_ALIAS_ENV: Record<string, string> = { fable: "FABLE", opus: "OPUS", sonnet: "SONNET", haiku: "HAIKU" };

export async function claudeModels(options: ModelSourceOptions = {}): Promise<CliModelCatalog> {
  const platform = options.platform ?? process.platform;
  const processEnv = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const configDir = processEnv.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const [user, managed] = await Promise.all([readJson(path.join(configDir, "settings.json")), readJson(managedSettingsFile(platform, processEnv))]);
  const envOf = (settings: Json | null) => (settings?.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {});
  // settings env is applied over the process environment, managed settings last
  const env: Record<string, unknown> = { ...processEnv, ...envOf(user), ...envOf(managed) };
  const setting = (key: string): unknown => (managed && key in managed ? managed[key] : user?.[key]);
  const picker = (managed?.modelPicker ?? user?.modelPicker) as { options?: unknown; replaceBuiltInOptions?: unknown } | undefined;
  const capabilities = claudeCapabilities(text(env.CLAUDE_CODE_MODEL_CAPABILITIES));
  const effortsOf = (...ids: (string | undefined)[]): string[] | undefined => {
    for (const id of ids) if (id && capabilities.has(baseModel(id))) return capabilities.get(baseModel(id));
    return undefined;
  };

  const rows: CliModelOption[] = [];
  const add = (row: CliModelOption) => { if (isCliModel(row.id) && !rows.some((entry) => entry.id === row.id)) rows.push(row); };
  if (picker?.replaceBuiltInOptions !== true) {
    for (const builtin of CLI_MODELS.claude) {
      const name = CLAUDE_ALIAS_ENV[builtin.id];
      const mapped = name ? text(env[`ANTHROPIC_DEFAULT_${name}_MODEL`]) : undefined;
      const description = (name ? text(env[`ANTHROPIC_DEFAULT_${name}_MODEL_DESCRIPTION`]) : undefined) ?? mapped;
      const efforts = effortsOf(mapped, builtin.id) ?? (mapped ? undefined : [...CLI_EFFORTS.claude]);
      add({ id: builtin.id, label: (name ? text(env[`ANTHROPIC_DEFAULT_${name}_MODEL_NAME`]) : undefined) ?? builtin.label, ...(description ? { description } : {}), ...(efforts ? { efforts } : {}) });
    }
    const custom = text(env.ANTHROPIC_CUSTOM_MODEL_OPTION);
    if (custom) {
      const description = text(env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION);
      const efforts = effortsOf(custom);
      add({ id: custom, label: text(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME) ?? custom, ...(description ? { description } : {}), ...(efforts ? { efforts } : {}) });
    }
  }
  for (const entry of Array.isArray(picker?.options) ? picker.options : []) {
    const row = entry && typeof entry === "object" ? (entry as Json) : {};
    const id = text(row.model);
    if (!id) continue;
    const description = text(row.description);
    const efforts = effortsOf(id, text(row.behavesAs));
    add({ id, label: text(row.label) ?? id, ...(description ? { description } : {}), ...(efforts ? { efforts } : {}) });
  }
  const allowed = setting("availableModels");
  const allow = Array.isArray(allowed) ? new Set(allowed.filter((entry): entry is string => typeof entry === "string").map(baseModel)) : null;
  const models = allow ? rows.filter((row) => allow.has(baseModel(row.id))) : rows;
  const current = text(setting("model")) ?? text(env.ANTHROPIC_MODEL);
  const effort = text(setting("effortLevel"));
  return {
    models,
    ...(current && isCliModel(current) ? { current } : {}),
    ...(effort && CLI_EFFORTS.claude.includes(effort) ? { currentEffort: effort } : {}),
  };
}

/** Top-level `key = "value"` of a TOML file, before its first table. Enough for config.toml's `model`. */
export function tomlTopLevel(source: string, key: string): string | undefined {
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) return undefined;
    const match = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(trimmed);
    if (match) return match[1] ?? match[2];
  }
  return undefined;
}

export async function codexModels(options: ModelSourceOptions = {}): Promise<CliModelCatalog> {
  const env = options.env ?? process.env;
  const home = env.CODEX_HOME || path.join(options.homedir ?? os.homedir(), ".codex");
  const [cache, config] = await Promise.all([
    readJson(path.join(home, "models_cache.json")),
    readFile(path.join(home, "config.toml"), "utf8").catch(() => ""),
  ]);
  const known = CLI_EFFORTS.codex;
  const rows: Array<CliModelOption & { priority: number }> = [];
  for (const entry of Array.isArray(cache?.models) ? cache.models : []) {
    const row = entry && typeof entry === "object" ? (entry as Json) : {};
    const id = text(row.slug);
    if (!id || !isCliModel(id) || row.visibility === "hide" || rows.some((other) => other.id === id)) continue;
    const levels = Array.isArray(row.supported_reasoning_levels)
      ? row.supported_reasoning_levels.map((level) => (typeof level === "string" ? level : text((level as Json | null)?.effort))).filter((level): level is string => !!level && known.includes(level))
      : undefined;
    const description = text(row.description);
    rows.push({
      id,
      label: text(row.display_name) ?? id,
      ...(description ? { description } : {}),
      ...(levels ? { efforts: levels } : {}),
      priority: typeof row.priority === "number" ? row.priority : Number.MAX_SAFE_INTEGER,
    });
  }
  const models: CliModelOption[] = rows.length
    ? rows.sort((a, b) => a.priority - b.priority).map(({ priority: _priority, ...row }) => row)
    : CLI_MODELS.codex.map((row) => ({ ...row }));
  const current = tomlTopLevel(config, "model");
  const effort = tomlTopLevel(config, "model_reasoning_effort");
  return {
    models,
    ...(current && isCliModel(current) ? { current } : {}),
    ...(effort && known.includes(effort) ? { currentEffort: effort } : {}),
  };
}

export type ModelProvider = (options?: ModelSourceOptions) => Promise<CliModelCatalog>;

const MODEL_PROVIDERS = new Map<string, ModelProvider>([
  ["claude", claudeModels],
  ["codex", codexModels],
]);

/** Registers a model catalog provider for a harness; returns a disposer. */
export function registerModelProvider(engine: CliEngine | string, provider: ModelProvider): () => void {
  const previous = MODEL_PROVIDERS.get(engine);
  MODEL_PROVIDERS.set(engine, provider);
  return () => {
    if (MODEL_PROVIDERS.get(engine) !== provider) return;
    if (previous) MODEL_PROVIDERS.set(engine, previous);
    else MODEL_PROVIDERS.delete(engine);
  };
}

/** The picker rows of `engine` on this computer; harnesses without a file-based catalog return none. */
export function cliModels(engine: CliEngine, options: ModelSourceOptions = {}): Promise<CliModelCatalog> {
  const provider = MODEL_PROVIDERS.get(engine);
  return provider ? provider(options) : Promise.resolve({ models: [] });
}
