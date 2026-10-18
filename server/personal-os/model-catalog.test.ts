import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createPersonalApp } from "./index.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

it("authenticated catalog lookup keeps saved keys and configuration private and unchanged", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-model-catalog-"));
  const fake = await startFakeModel();
  const token = "synthetic-catalog-session";
  const app = await createPersonalApp({ dir, key: randomBytes(32), token, identity: false, hostDevice: false, memoryRuntime: false });
  try {
    app.store.saveConfig({ provider: "openai", endpoint: fake.origin + "/v1", model: "original-model", apiKey: "synthetic-key" });
    const query = { provider: "openai", endpoint: fake.origin + "/v1", apiKey: "" };
    const request = (data: unknown, authenticated = true) => fetch(app.origin + "/api/models/list", { method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(data) });
    expect((await request(query, false)).status).toBe(401);
    const response = await request(query); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: ["fixture-model", "fixture-reasoning"], hasMore: false });
    const changed = await request({ ...query, endpoint: fake.origin + "/other" });
    expect(changed.ok).toBe(false); expect(await changed.text()).not.toContain("synthetic-key");
    expect(app.store.modelConfig()).toMatchObject({ model: "original-model", apiKey: "synthetic-key" });
  } finally { await app.close(); await fake.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("visible models persist by connection, fence stale saves and preserve active models", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-model-visibility-")), key = randomBytes(32);
  const token = "synthetic-visibility-session";
  let app = await createPersonalApp({ dir, key, token, identity: false, hostDevice: false, memoryRuntime: false });
  const config = { provider: "openai", endpoint: "https://fixture.example/v1", model: "active-model", apiKey: "synthetic-key" };
  try {
    app.store.saveConfig(config);
    const request = (data: unknown, authenticated = true) => fetch(app.origin + "/api/models/visibility", { method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(data) });
    expect(app.store.modelVisibility()).toEqual({ models: null, version: 0 });
    const input = { provider: config.provider, endpoint: config.endpoint + "/", version: 0, models: ["model-a", "model-a", "manual-model"] };
    expect((await request(input, false)).status).toBe(401);
    expect(await (await request(input)).json()).toEqual({ models: ["model-a", "manual-model"], version: 1 });
    expect((await request(input)).ok).toBe(false);
    expect(app.store.modelConfig().model).toBe("active-model");
    app.store.saveConfig({ ...config, endpoint: "https://other.example/v1" });
    expect(app.store.modelVisibility()).toEqual({ models: null, version: 0 });
    expect((await request({ ...input, version: 1 })).ok).toBe(false);
    app.store.saveConfig(config);
    expect(app.store.state().modelVisibility.models).toEqual(["model-a", "manual-model"]);
    expect((await request({ ...input, version: 1, models: [1] })).ok).toBe(false);
    expect((await request({ ...input, version: 1, models: [] })).ok).toBe(true);
    expect(app.store.modelVisibility()).toEqual({ models: [], version: 2 });
    await app.close();
    app = await createPersonalApp({ dir, key, token, identity: false, hostDevice: false, memoryRuntime: false });
    expect(app.store.modelVisibility()).toEqual({ models: [], version: 2 });
    expect((await request({ ...input, version: 2, models: null })).ok).toBe(true);
    expect(app.store.modelVisibility()).toEqual({ models: null, version: 3 });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
