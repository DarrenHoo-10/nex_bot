import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createPersonalApp } from "./index.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

it("selects an assistant model independently and sends that model to the worker", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-agent-model-")), key = randomBytes(32);
  const fake = await startFakeModel();
  const options = { dir, key, token: "synthetic", identity: false as const, hostDevice: false as const, memoryRuntime: false as const, modelCatalog: { fetchDisabled: true } };
  let app = await createPersonalApp(options);
  try {
    const config = { provider: "openai", endpoint: fake.origin + "/v1", model: "fixture-model", apiKey: "synthetic-key" };
    app.store.saveConfig({ ...config, model: "fixture-reasoning", contextWindow: 90000, maxOutputTokens: 12345 });
    app.store.saveConfig(config);
    const bot = app.store.createBot("Selected"), other = app.store.createBot("Default");
    const select = (data: object, auth = true) => fetch(app.origin + "/api/bots/model", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer synthetic" } : {}) }, body: JSON.stringify({ id: bot, provider: config.provider, endpoint: config.endpoint, version: 0, model: "fixture-reasoning", ...data }) });
    expect((await select({}, false)).status).toBe(401);
    expect((await select({})).ok).toBe(true);
    expect((await select({})).ok).toBe(false);
    expect((await select({ id: "missing" })).ok).toBe(false);
    expect((await select({ endpoint: "https://other.example/v1", version: 1 })).ok).toBe(false);
    expect(app.store.modelConfig(bot)).toMatchObject({ model: "fixture-reasoning", maxOutputTokens: 12345 });
    expect(app.store.modelConfig(other).model).toBe("fixture-model");
    const state = await (await fetch(app.origin + "/api/state", { headers: { Authorization: "Bearer synthetic" } })).json() as { bots: Array<{ id: string; selected_model?: string }> };
    expect(state.bots.find((item: { id: string }) => item.id === bot)?.selected_model).toBe("fixture-reasoning");
    expect(JSON.stringify(state)).not.toContain("synthetic-key");
    fake.scripts.push({ kind: "openai-text", text: "selected model applied" });
    const sent = app.agents.send(bot, "hello", "model-input");
    expect((await select({ model: "", version: 1 })).ok).toBe(false);
    const deadline = Date.now() + 25000;
    while (app.store.get("SELECT status FROM tasks WHERE id=?", sent.taskId)?.status !== "succeeded" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    expect(app.store.get("SELECT status FROM tasks WHERE id=?", sent.taskId)?.status).toBe("succeeded");
    const body = JSON.parse(fake.requests.find(request => request.url.includes("completions"))!.body);
    expect(body.model).toBe("fixture-reasoning");
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(12345);
    await app.close(); app = await createPersonalApp(options);
    expect(app.store.modelConfig(bot).model).toBe("fixture-reasoning");
    app.store.saveConfig({ ...config, endpoint: fake.origin + "/other" });
    expect(app.store.modelConfig(bot).model).toBe("fixture-model");
    app.store.saveConfig(config);
    expect((await select({ model: "", version: 1 })).ok).toBe(true);
    expect(app.store.modelConfig(bot).model).toBe("fixture-model");
  } finally { await app.close(); await fake.close(); rmSync(dir, { recursive: true, force: true }); }
}, 35000);
