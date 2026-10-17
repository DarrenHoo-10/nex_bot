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
