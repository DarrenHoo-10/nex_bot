import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createPersonalApp } from "./index.ts";
import { CoreStore } from "./store.ts";
import { matchModelLimits, modelInputBudget, parseModelLimit, workingContextBudget } from "./model-limits.ts";
import { trimModelsDevCatalog } from "../model-catalog/trim.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

const catalog = (endpoint = "https://models.example/v1") => ({ fixture: { id: "fixture", name: "Fixture", env: [], api: endpoint, models: {
  "fixture-model": { id: "fixture-model", name: "Fixture model", tool_call: true, modalities: { input: ["text"] }, limit: { context: 120_000, output: 24_000 } },
  "fixture-other": { id: "fixture-other", name: "Other", tool_call: true, modalities: { input: ["text"] }, limit: { context: 80_000, output: 10_000 } },
  "fixture-full-output": { id: "fixture-full-output", name: "Full output", tool_call: true, modalities: { input: ["text"] }, limit: { context: 500_000, output: 500_000 } },
} } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const directory = () => { const root = mkdtempSync(path.join(os.tmpdir(), "nex-model-limits-")); roots.push(root); return root; };
const config = { provider: "openai", endpoint: "https://models.example/v1", model: "fixture-model", apiKey: "synthetic-secret" };

it("retains per-model overrides across model, endpoint, protocol switches and restarts", () => {
  const root = directory(), key = randomBytes(32);
  let store = new CoreStore(root, key, "fixture", { readSnapshot: () => undefined, fetchDisabled: true });
  try {
    store.saveConfig({ ...config, contextWindow: "160000", maxOutputTokens: "12000" });
    store.saveConfig({ ...config, model: "fixture-other", contextWindow: 32000, maxOutputTokens: 2048 });
    expect(store.modelConfig()).toMatchObject({ contextWindow: 32000, maxOutputTokens: 2048 });
    store.saveConfig({ ...config, endpoint: "https://another.example/v1" });
    expect(store.modelConfig()).toMatchObject({ contextWindow: 256000, maxOutputTokens: 32000 });
    store.saveConfig({ ...config, provider: "anthropic" });
    expect(store.modelConfig().contextWindow).toBe(256000);
    store.db.close(); store = new CoreStore(root, key, "fixture", { readSnapshot: () => undefined, fetchDisabled: true });
    store.saveConfig(config);
    expect(store.modelConfig()).toMatchObject({ contextWindow: 160000, maxOutputTokens: 12000 });
    const before = store.modelConfig();
    for (const contextWindow of [-1, 0, 123.5, "1e5", true, 10_000_001]) expect(() => store.saveConfig({ ...config, contextWindow })).toThrow();
    expect(store.modelConfig()).toEqual(before);
    store.saveConfig({ ...config, contextWindow: 100000, maxOutputTokens: 128000 });
    store.db.close(); store = new CoreStore(root, key, "fixture", { readSnapshot: () => undefined, fetchDisabled: true });
    expect(store.modelConfig()).toMatchObject({ contextWindow: 100000, maxOutputTokens: 128000 });
    store.saveConfig({ ...config, contextWindow: 10000, maxOutputTokens: "" });
    expect(store.modelConfig()).toMatchObject({ contextWindow: 10000, maxOutputTokens: 32000 });
    store.saveConfig({ ...config, contextWindow: "", maxOutputTokens: "" });
    expect(store.modelConfig()).toMatchObject({ contextWindow: 256000, maxOutputTokens: 32000 });
  } finally { store.db.close(); }
});

it("resolves the soft compaction threshold: default 256k, never above 80% of the window or the input budget minus 2k, null clears", () => {
  // modelInputBudget(400000, 4096) = 320000, (1,000,000) = 800000, (128000) = 102400.
  expect(workingContextBudget(null, 320000)).toBe(256000);
  expect(workingContextBudget(null, 320000, 400000)).toBe(256000);
  expect(workingContextBudget(null, 51200)).toBe(49152);
  expect(workingContextBudget(null, 5000)).toBe(2952);
  expect(workingContextBudget(null, 800000, 1000000)).toBe(256000);
  expect(workingContextBudget(null, 102400, 128000)).toBe(100352);
  expect(workingContextBudget(100000, 320000)).toBe(100000);
  expect(workingContextBudget(500000, 320000)).toBe(317952);
  expect(workingContextBudget(500000, 320000, 400000)).toBe(317952);
  // The 80% share of the window caps it when the input budget is looser than that.
  expect(workingContextBudget(500000, 399000, 400000)).toBe(320000);
  expect(workingContextBudget(1024, 320000)).toBe(8000);
  expect(workingContextBudget(1024, 5000)).toBe(2952);
  expect(workingContextBudget(1024, 1500)).toBe(1);
  expect(parseModelLimit("2048", "contextBudget")).toBe(2048);
  for (const value of [0, 1023, 123.5, "1e5", true, 10_000_001]) expect(() => parseModelLimit(value, "contextBudget")).toThrow("压缩阈值");
  const root = directory(), key = randomBytes(32);
  let store = new CoreStore(root, key, "fixture", { readSnapshot: () => undefined, fetchDisabled: true });
  try {
    store.saveConfig({ ...config, contextWindow: 400000, maxOutputTokens: 4096 });
    expect(store.modelConfig()).toMatchObject({ contextWindow: 400000, contextBudget: 256000 });
    expect(store.modelLimitSettings(config)).toMatchObject({ manual: { contextBudget: null }, contextBudget: 256000, source: { contextBudget: "default" } });
    store.saveConfig({ ...config, contextBudget: "120000" });
    expect(store.modelConfig().contextBudget).toBe(120000);
    // Omitted keeps the saved value; an invalid value changes nothing; the threshold never reaches the input budget.
    store.saveConfig(config);
    expect(store.modelLimitSettings(config)).toMatchObject({ manual: { contextBudget: 120000 }, source: { contextBudget: "manual" } });
    expect(() => store.saveConfig({ ...config, contextBudget: 100 })).toThrow("压缩阈值");
    expect(store.modelConfig().contextBudget).toBe(120000);
    store.saveConfig({ ...config, contextWindow: 100000 });
    expect(store.modelConfig()).toMatchObject({ contextWindow: 100000, contextBudget: modelInputBudget(100000, 4096) - 2048 });
    store.db.close(); store = new CoreStore(root, key, "fixture", { readSnapshot: () => undefined, fetchDisabled: true });
    expect(store.modelLimitSettings(config).manual.contextBudget).toBe(120000);
    store.saveConfig({ ...config, contextWindow: 400000, contextBudget: null });
    expect(store.modelConfig().contextBudget).toBe(256000);
    expect(store.modelLimitSettings(config).manual.contextBudget).toBeNull();
  } finally { store.db.close(); }
});

it("round-trips the compaction threshold through the authenticated model routes", async () => {
  const token = "synthetic-token";
  const app = await createPersonalApp({ dir: directory(), key: randomBytes(32), token, identity: false, hostDevice: false, memoryRuntime: false, modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined } });
  const request = (route: string, data: unknown) => fetch(app.origin + "/api/" + route, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(data) });
  try {
    const scope = { provider: config.provider, endpoint: config.endpoint, model: config.model };
    expect((await request("config", { ...config, contextWindow: 400000, maxOutputTokens: 4096, contextBudget: 90000 })).ok).toBe(true);
    expect(await (await request("models/limits", scope)).json()).toMatchObject({ manual: { contextBudget: 90000 }, contextBudget: 90000, source: { contextBudget: "manual" }, automatic: { contextBudget: 202752, source: { contextBudget: "default" } } });
    const rejected = await request("config", { ...config, contextBudget: 12 });
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(await rejected.json())).toContain("压缩阈值");
    expect((await request("config", { ...config, contextBudget: null })).ok).toBe(true);
    expect(await (await request("models/limits", scope)).json()).toMatchObject({ manual: { contextBudget: null }, contextBudget: 256000 });
  } finally { await app.close(); }
});

it("matches exact models, refuses conflicts and does not strip arbitrary suffixes", () => {
  const data = catalog();
  const providers = trimModelsDevCatalog({ ...data, other: { ...data.fixture, id: "other", api: "https://other.example/v1", models: { "fixture-model": { ...data.fixture.models["fixture-model"], limit: { context: 64000, output: 8192 } } } } });
  expect(matchModelLimits(providers, "fixture-model", config.endpoint).model?.limit).toEqual({ context: 120000, output: 24000 });
  expect(matchModelLimits(providers, "fixture-model", "https://proxy.example").ambiguous).toBe(true);
  expect(matchModelLimits(providers, "fixture/fixture-model", "https://proxy.example").model?.limit?.context).toBe(120000);
  expect(matchModelLimits(providers, "fixture-model-thinking", config.endpoint)).toEqual({});
  expect(parseModelLimit("8192", "maxOutputTokens")).toBe(8192);
  expect(modelInputBudget(128000, 64000)).toBe(102400);
  expect(modelInputBudget(500000, 500000)).toBe(400000);
  expect(modelInputBudget(1000000, 8192)).toBe(800000);
});

it("fetches only the public directory, caches output limits and preserves manual fields on refresh", async () => {
  const root = directory(), key = randomBytes(32), token = "synthetic-token";
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog()));
  const options = { dir: root, key, token, identity: false as const, hostDevice: false as const, memoryRuntime: false as const, modelCatalog: { fetch: fetcher, readSnapshot: () => undefined, log: () => {} } };
  const app = await createPersonalApp(options);
  const request = (route: string, data: unknown, authenticated = true) => fetch(app.origin + "/api/" + route, { method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(data) });
  try {
    app.store.saveConfig({ ...config, contextWindow: 200000 });
    expect((await request("models/limits/refresh", config, false)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await request("models/limits/refresh", config);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contextWindow: 200000, maxOutputTokens: 24000, source: { contextWindow: "manual", maxOutputTokens: "models.dev" } });
    expect(fetcher.mock.calls[0][0]).toBe("https://models.dev/api.json");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("synthetic-secret");
    await request("models/limits/refresh", config);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(app.store.modelConfig()).toMatchObject({ contextWindow: 200000, maxOutputTokens: 24000 });
    expect(app.store.modelLimitSettings({ ...config, model: "fixture-full-output" })).toMatchObject({ contextWindow: 500000, maxOutputTokens: 500000, source: { maxOutputTokens: "models.dev" } });
    expect(JSON.stringify(app.store.config())).not.toContain("synthetic-secret");
  } finally { await app.close(); }
  const store = new CoreStore(root, key, token, { fetchDisabled: true, readSnapshot: () => undefined });
  try { expect(store.modelConfig()).toMatchObject({ contextWindow: 200000, maxOutputTokens: 24000 }); } finally { store.db.close(); }
});

it("offline lookup reports failure and retains usable defaults", async () => {
  const app = await createPersonalApp({ dir: directory(), key: randomBytes(32), token: "offline", identity: false, hostDevice: false, memoryRuntime: false,
    modelCatalog: { fetch: async () => { throw new Error("offline"); }, readSnapshot: () => undefined, log: () => {} } });
  try {
    const response = await fetch(app.origin + "/api/models/limits/refresh", { method: "POST", headers: { Authorization: "Bearer offline", "Content-Type": "application/json" }, body: JSON.stringify(config) });
    expect(await response.json()).toMatchObject({ refresh: "failed", status: "unknown", contextWindow: 256000, maxOutputTokens: 32000 });
  } finally { await app.close(); }
});

it.each(["openai", "anthropic"])("passes the saved output ceiling to real %s worker requests", async provider => {
  const fake = await startFakeModel();
  const app = await createPersonalApp({ dir: directory(), key: randomBytes(32), token: "runtime", identity: false, hostDevice: false, memoryRuntime: false, modelCatalog: { fetchDisabled: true } });
  try {
    app.store.saveConfig({ provider, endpoint: fake.origin + "/v1", model: "fixture-model", apiKey: "synthetic-key", contextWindow: 180000, maxOutputTokens: 12345 });
    const bot = app.store.createBot("Fixture"); app.agents.ensure(bot);
    fake.scripts.push(provider === "openai" ? { kind: "openai-text", text: "limits applied" } : { kind: "anthropic-text", text: "limits applied" });
    const sent = app.agents.send(bot, "hello", "limits-input");
    const deadline = Date.now() + 25000;
    while (app.store.get("SELECT status FROM tasks WHERE id=?", sent.taskId)?.status !== "succeeded" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    expect(app.store.get("SELECT status,result_summary FROM tasks WHERE id=?", sent.taskId)).toMatchObject({ status: "succeeded" });
    const body = JSON.parse(fake.requests.find(request => request.url.includes(provider === "openai" ? "completions" : "messages"))!.body);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(12345);
  } finally { await app.close(); await fake.close(); }
}, 30000);
