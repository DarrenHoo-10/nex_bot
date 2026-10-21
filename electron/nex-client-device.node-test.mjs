import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

function refreshFixture({ expiresIn, refresh, sessionRefreshed }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nex-device-refresh-"));
  const session = { origin: "https://fixture.invalid", token: "old-token", coreId: "core", sessionId: "session", expiresAt: Date.now() + expiresIn, name: "Fixture" };
  const live = new Set([session.token]), calls = [];
  let closed = 0;
  const device = new ClientDevice({
    directory, interval: 5, sessionRefreshed,
    safeStorage: { encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    createNode: () => ({ node: { configure() {}, publicState: () => ({ status: "已连接", connected: true }), computer: { available: () => false } }, async close() { closed++; } }),
    async request(_origin, route, data, token) {
      calls.push([route, data?.token ?? token]);
      if (route === "/api/session") return { authenticated: live.has(data.token), ...session };
      if (route === "/api/state") return { sync: { coreId: "core" }, devices: [{ id: "device", status: "bound" }] };
      if (route === "/api/devices") return { deviceId: "device", token: "device-token" };
      if (route === "/api/auth/refresh") { const next = await refresh(token); live.delete(token); live.add(next.token); return next; }
      return {};
    },
  });
  return { device, session, calls, closed: () => closed, cleanup: async () => { await device.stop(); rmSync(directory, { recursive: true, force: true }); } };
}
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(check()); };

test("a login close to expiry is refreshed, saved and used for later checks", async () => {
  const saved = [];
  const fixture = refreshFixture({ expiresIn: 10 * 60_000, refresh: async () => ({ token: "new-token", sessionId: "session", coreId: "core", expiresAt: Date.now() + 7 * 86_400_000 }), sessionRefreshed: async (next) => { saved.push(next); } });
  try {
    await fixture.device.start(fixture.session);
    await until(() => fixture.calls.some(([route, token]) => route === "/api/session" && token === "new-token"));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].token, "new-token");
    assert.equal(fixture.calls.filter(([route]) => route === "/api/auth/refresh").length, 1);
    assert.equal(fixture.closed(), 0);
    assert.equal(fixture.device.state().connected, true);
  } finally { await fixture.cleanup(); }
});

test("a login far from expiry, or a host without a refresh hook, is not refreshed", async () => {
  for (const options of [{ expiresIn: 60 * 60_000, sessionRefreshed: async () => {} }, { expiresIn: 10 * 60_000 }]) {
    const fixture = refreshFixture({ ...options, refresh: async () => { throw new Error("must not refresh"); } });
    try {
      await fixture.device.start(fixture.session);
      await until(() => fixture.calls.filter(([route]) => route === "/api/session").length >= 3);
      assert.equal(fixture.calls.filter(([route]) => route === "/api/auth/refresh").length, 0);
    } finally { await fixture.cleanup(); }
  }
});

test("a failed refresh keeps the current login and the running device", async () => {
  const fixture = refreshFixture({ expiresIn: 10 * 60_000, refresh: async () => { throw Object.assign(new Error("upstream unavailable"), { status: 503 }); }, sessionRefreshed: async () => { throw new Error("must not save"); } });
  try {
    await fixture.device.start(fixture.session);
    await until(() => fixture.calls.filter(([route]) => route === "/api/session").length >= 4);
    // Retries are spaced a minute apart, not on every check.
    assert.equal(fixture.calls.filter(([route]) => route === "/api/auth/refresh").length, 1);
    assert.equal(fixture.closed(), 0);
    assert.equal(fixture.device.state().connected, true);
  } finally { await fixture.cleanup(); }
});

function identityFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nex-device-identity-"));
  const devices = [], live = new Set(), calls = [];
  let paired = 0, closed = 0, failure;
  const safeStorage = { encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };
  const make = () => new ClientDevice({
    directory, safeStorage, interval: 5,
    createNode: () => ({ node: { configure() {}, publicState: () => ({ status: "已连接", connected: true }), computer: { available: () => false } }, async close() { closed++; } }),
    async request(_origin, route, data, token) {
      calls.push(route);
      if (failure && route === "/api/session") throw failure;
      if (route === "/api/session") return { authenticated: live.has(data.token), sessionId: data.token.replace("token-", ""), coreId: "core" };
      if (route === "/api/state") return { sync: { coreId: "workspace" }, devices: devices.map((id) => ({ id, status: "bound" })) };
      if (route === "/api/devices") { const id = `device-${++paired}`; devices.push(id); return { deviceId: id, token: `device-token-${paired}` }; }
      if (route === "/api/devices/revoke") { devices.splice(devices.indexOf(data.id), 1); return {}; }
      void token; return {};
    },
  });
  const session = (id) => { live.add(`token-${id}`); return { origin: "https://fixture.invalid", token: `token-${id}`, coreId: "core", sessionId: id, expiresAt: Date.now() + 3_600_000, name: "Fixture" }; };
  return { directory, devices, live, calls, make, session, paired: () => paired, closed: () => closed, fail: (error) => { failure = error; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("signing in again on the same computer keeps the same device", async () => {
  const f = identityFixture(), first = f.make();
  try {
    await first.start(f.session("a"));
    assert.equal(first.state().deviceId, "device-1");
    await first.stop();
    const second = f.make();
    await second.start(f.session("b"));
    assert.equal(second.state().deviceId, "device-1");
    assert.equal(f.paired(), 1);
    await second.stop();
  } finally { f.cleanup(); }
});

test("a revoked device stays revoked for its login, and a new login registers again", async () => {
  const f = identityFixture(), device = f.make();
  try {
    await device.start(f.session("a"));
    f.devices.splice(0);
    await device.start(f.session("a"));
    assert.equal(device.state().status, "此电脑已被撤销，请重新登录后连接");
    assert.equal(f.paired(), 1);
    await device.start(f.session("b"));
    assert.equal(device.state().deviceId, "device-2");
    await device.stop();
  } finally { f.cleanup(); }
});

test("an existing per-login device folder is carried over instead of registering a new device", async () => {
  const f = identityFixture();
  try {
    const legacy = path.join(f.directory, createHash("sha256").update(JSON.stringify(["https://fixture.invalid", "core", "a"])).digest("hex"));
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "binding.bin"), JSON.stringify({ deviceId: "legacy-device", token: "legacy-token" }));
    f.devices.push("legacy-device");
    const device = f.make();
    await device.start(f.session("a"));
    assert.equal(device.state().deviceId, "legacy-device");
    assert.equal(f.paired(), 0);
    assert.equal(existsSync(legacy), false);
    await device.stop();
  } finally { f.cleanup(); }
});

test("a network failure keeps the executor running; a rejected login stops it", async () => {
  const f = identityFixture(), device = f.make();
  try {
    await device.start(f.session("a"));
    f.fail(new Error("fetch failed"));
    const checks = f.calls.length;
    await until(() => f.calls.length >= checks + 3);
    assert.equal(f.closed(), 0);
    assert.equal(device.state().connected, true);
    f.fail(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await until(() => f.closed() === 1);
    assert.equal(device.state().connected, false);
    await device.stop();
  } finally { f.cleanup(); }
});
