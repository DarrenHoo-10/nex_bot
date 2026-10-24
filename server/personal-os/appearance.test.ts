import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { createWorkspaceService } from "./workspaces.ts";
import { startFakeIdentity } from "./testing/fake-identity.ts";
import { graphicAvatarIds, type Appearance } from "../../shared/personal-appearance.ts";

it("syncs appearance across sessions, rejects stale/invalid/foreign changes and persists through restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-appearance-fixture-"));
  const provider = await startFakeIdentity();
  const options = { dir: root, key: randomBytes(32), token: "synthetic-bootstrap", memoryRuntime: false as const, identity: { fixtureOrigin: provider.origin } };
  let legacy: Awaited<ReturnType<typeof createPersonalApp>> | undefined;
  let app: Awaited<ReturnType<typeof createWorkspaceService>> | undefined;
  interface Body { token: string; id: string; bots: Array<{ id: string; appearance_json: string | null; appearance_version: number }>; }
  async function request(route: string, token: string, data?: unknown, origin?: string) {
    const res = await fetch(app!.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    return { status: res.status, body: await res.json() as Body };
  }
  async function login(account: string) {
    const start = await request("auth/start", "", { account, name: "Appearance fixture" });
    expect(start.status).toBe(200);
    const result = await request("auth/respond", "", { ...start.body, password: " synthetic password " });
    expect(result.status).toBe(200); return result.body.token;
  }
  try {
    legacy = await createPersonalApp(options);
    const operator = legacy.store.get("SELECT * FROM user_sessions WHERE id=?", legacy.store.session)!;
    const start = legacy.identity!.start({ account: "owner@example.test", name: "Owner fixture" }, operator);
    const owner = await legacy.identity!.respond({ ...start, password: " synthetic password " }, operator);
    const bot = legacy.store.createBot("Fixture companion");
    await legacy.close(); legacy = undefined;
    app = await createWorkspaceService(options);
    const secondSession = await login("owner@example.test"), other = await login("other@example.test");
    const before = (await request("state", owner.token)).body.bots[0];
    expect(before).toMatchObject({ appearance_json: null, appearance_version: 0 });
    const appearance: Appearance = { kind: "companion", shape: "bud", color: "plum" };
    const update = { id: bot, version: 0, appearance };
    expect((await request("bots/appearance", "", update)).status).toBe(401);
    expect((await request("bots/appearance", owner.token, update, "https://foreign.example.test")).status).toBe(403);
    expect((await request("bots/appearance", other, update)).status).toBe(400);
    expect((await request("bots/appearance", owner.token, { ...update, appearance: { kind: "companion", shape: "script", color: "url(https://example.test)" } })).status).toBe(400);
    expect((await request("bots/appearance", owner.token, update)).status).toBe(200);
    const synced = (await request("state", secondSession)).body.bots[0];
    expect(JSON.parse(synced.appearance_json!)).toEqual(appearance);
    expect(synced.appearance_version).toBe(1);
    expect((await request("bots/appearance", secondSession, { ...update, appearance: { kind: "portrait", id: "fox" } })).status).toBe(400);
    expect((await request("state", other)).body.bots).toEqual([]);
    await app.close(); app = undefined;
    app = await createWorkspaceService(options);
    expect((await request("state", secondSession)).body.bots[0]).toMatchObject(synced);
    expect((await request("bots/appearance", secondSession, { ...update, version: 1, appearance: { kind: "portrait", id: "fox" } })).status).toBe(200);
    expect(JSON.parse((await request("state", owner.token)).body.bots[0].appearance_json!)).toEqual({ kind: "portrait", id: "fox" });
    const classic = (await request("state", owner.token)).body.bots.find((item) => item.id === bot)!;
    const added = await request("bots", owner.token, { name: "Graphic appearance fixture", instructions: "Synthetic avatar check" });
    expect(added.status).toBe(200);
    const graphicBot = added.body.id;
    let graphicVersion = 0;
    expect((await request("bots/appearance", owner.token, { id: graphicBot, version: 0, appearance: { kind: "graphic", id: "https://foreign.example.test/avatar.svg" } })).status).toBe(400);
    for (const id of graphicAvatarIds) {
      expect((await request("bots/appearance", owner.token, { id: graphicBot, version: graphicVersion, appearance: { kind: "graphic", id } })).status).toBe(200);
      graphicVersion++;
      const saved = (await request("state", secondSession)).body.bots.find((item) => item.id === graphicBot)!;
      expect(JSON.parse(saved.appearance_json!)).toEqual({ kind: "graphic", id });
      expect(saved.appearance_version).toBe(graphicVersion);
    }
    const graphic = (await request("state", secondSession)).body.bots.find((item) => item.id === graphicBot)!;
    expect((await request("bots/appearance", secondSession, { id: graphicBot, version: 0, appearance: { kind: "graphic", id: "female-03" } })).status).toBe(400);
    await app.close(); app = undefined;
    app = await createWorkspaceService(options);
    const afterRestart = (await request("state", secondSession)).body.bots;
    expect(afterRestart.find((item) => item.id === graphicBot)).toMatchObject(graphic);
    expect(afterRestart.find((item) => item.id === bot)).toMatchObject(classic);
    expect((await request("bots/appearance", secondSession, { id: graphicBot, version: graphicVersion, appearance })).status).toBe(200);
    expect(JSON.parse((await request("state", owner.token)).body.bots.find((item) => item.id === graphicBot)!.appearance_json!)).toEqual(appearance);
  } finally {
    await app?.close(); await legacy?.close(); await provider.close();
    if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-appearance-fixture-")) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
