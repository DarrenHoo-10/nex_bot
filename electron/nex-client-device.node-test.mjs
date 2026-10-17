import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientDevice } from "./nex-client-device.mjs";

test("logout during registration revokes the late grant without starting a runtime", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nex-device-race-"));
  const session = { origin: "https://fixture.invalid", token: "synthetic", coreId: "core", sessionId: "session", expiresAt: Date.now() + 60000, name: "Fixture" };
  let releasePair, paired, created = 0;
  const pairing = new Promise(resolve => { paired = resolve; });
  const calls = [];
  const device = new ClientDevice({ directory, safeStorage: {}, createNode() { created++; throw new Error("must not start"); },
    async request(_origin, route, data) {
      calls.push([route, data]);
      if (route === "/api/session") return { authenticated: true, ...session };
      if (route === "/api/state") return { devices: [] };
      if (route === "/api/devices") { paired(); return new Promise(resolve => { releasePair = resolve; }); }
      return {};
    },
  });
  try {
    const starting = device.start(session);
    await pairing;
    const stopping = device.stop({ revoke: true });
    releasePair({ deviceId: "late-device", token: "late-synthetic-token" });
    await Promise.all([starting, stopping]);
    assert.equal(created, 0);
    assert.equal(device.state().connected, false);
    assert.ok(calls.some(([route, data]) => route === "/api/devices/revoke" && data.id === "late-device"));
  } finally { await device.stop(); rmSync(directory, { recursive: true, force: true }); }
});
