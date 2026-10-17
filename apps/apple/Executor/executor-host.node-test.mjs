import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ClientDevice } from "../../../electron/nex-client-device.mjs";
import { createSafeStorage, runHost } from "./executor-host.mjs";

test("safeStorage round-trips and rejects tampering and a wrong key", () => {
  const a = createSafeStorage(randomBytes(32)), b = createSafeStorage(randomBytes(32));
  const sealed = a.encryptString("secret-ünicode");
  assert.equal(a.decryptString(sealed), "secret-ünicode");
  assert.ok(!sealed.includes("secret"));
  assert.throws(() => b.decryptString(sealed));
  sealed[20] ^= 1;
  assert.throws(() => a.decryptString(sealed));
  assert.throws(() => createSafeStorage(Buffer.alloc(8)));
});

function harness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nex-host-test-"));
  const input = new PassThrough(), output = new PassThrough();
  const received = [], waiters = [];
  output.setEncoding("utf8");
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk; let i;
    while ((i = buffer.indexOf("\n")) >= 0) { const line = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); received.push(line); waiters.splice(0).forEach((w) => w()); }
  });
  const until = async (predicate) => { for (let n = 0; n < 200; n++) { const hit = received.find(predicate); if (hit) return hit; await new Promise((r) => setTimeout(r, 10)); } throw new Error("timeout " + JSON.stringify(received)); };
  const send = (value) => input.write(JSON.stringify(value) + "\n");
  return { directory, input, output, received, until, send, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

const session = { origin: "https://fixture.invalid", name: "Test Mac", token: "synthetic-token", coreId: "core", sessionId: "session", expiresAt: Date.now() + 600000 };

function fakes() {
  const calls = [], nodes = [];
  const requestImpl = async (_origin, route, data, token) => {
    calls.push([route, data, token]);
    if (route === "/api/session") return { authenticated: true, ...session };
    if (route === "/api/state") return { devices: [{ id: "dev-1", status: "bound" }], sync: { coreId: "workspace" } };
    if (route === "/api/devices") return { deviceId: "dev-1", token: "dev-token" };
    return {};
  };
  const createNode = (_dir, key, changed) => {
    assert.equal(key.length, 32);
    const node = { cfg: undefined, reconciled: [], computer: { available: () => false }, configure(c) { this.cfg = c; changed(); }, reconcile(...a) { this.reconciled.push(a); }, publicState: () => ({ status: "ready", connected: !!node.cfg, deviceId: "dev-1", unknownCalls: [] }) };
    nodes.push(node);
    return { node, async close() { node.closed = true; } };
  };
  return { calls, nodes, requestImpl, createNode };
}

test("protocol: init, start, pause, resume, reconcile, stop with revoke", async () => {
  const h = harness(), f = fakes();
  const done = runHost({ input: h.input, output: h.output, directory: h.directory, ClientDevice, createNode: f.createNode, requestImpl: f.requestImpl });
  try {
    h.send({ op: "init", key: randomBytes(32).toString("base64") });
    h.send({ id: 1, op: "start", session });
    const started = await h.until((m) => m.id === 1);
    assert.equal(started.ok, true);
    assert.equal(started.state.connected, true);
    assert.equal(started.state.deviceId, "dev-1");
    assert.ok(h.received.some((m) => m.event === "state"));
    assert.ok(!JSON.stringify(h.received).includes("synthetic-token"));
    // Binding is stored encrypted with the master key, never plaintext.
    const folder = readdirSync(h.directory).find((n) => !n.startsWith("consent"));
    assert.ok(!readFileSync(path.join(h.directory, folder, "binding.bin")).includes("dev-token"));

    h.send({ id: 2, op: "pause", paused: true });
    const paused = await h.until((m) => m.id === 2);
    assert.equal(paused.state.paused, true); assert.equal(paused.state.connected, false);
    h.send({ id: 3, op: "pause", paused: false });
    assert.equal((await h.until((m) => m.id === 3)).state.connected, true);
    h.send({ id: 4, op: "reconcile", callId: "call-1", version: 3 });
    assert.equal((await h.until((m) => m.id === 4)).ok, true);
    assert.deepEqual(f.nodes.at(-1).reconciled, [["call-1", 3]]);
    h.send({ id: 5, op: "bogus" });
    assert.deepEqual(await h.until((m) => m.id === 5), { id: 5, ok: false, error: "unknown op" });
    h.send({ id: 6, op: "start", session: { ...session, token: "" } });
    assert.equal((await h.until((m) => m.id === 6)).ok, false);

    h.send({ id: 7, op: "start", session });
    await h.until((m) => m.id === 7);
    h.send({ id: 8, op: "stop", revoke: true });
    const stopped = await h.until((m) => m.id === 8);
    assert.equal(stopped.state.connected, false);
    assert.ok(f.calls.some(([route, data, token]) => route === "/api/devices/revoke" && data.id === "dev-1" && token === "synthetic-token"));
  } finally { h.input.end(); await done; h.cleanup(); }
});

test("stdin EOF stops the device without revoking", async () => {
  const h = harness(), f = fakes();
  const done = runHost({ input: h.input, output: h.output, directory: h.directory, ClientDevice, createNode: f.createNode, requestImpl: f.requestImpl });
  h.send({ op: "init", key: randomBytes(32).toString("base64") });
  h.send({ id: 1, op: "start", session });
  await h.until((m) => m.id === 1);
  h.input.end();
  await done;
  assert.equal(f.nodes.at(-1).closed, true);
  assert.ok(!f.calls.some(([route]) => route === "/api/devices/revoke"));
  h.cleanup();
});

test("a missing init line makes the host exit without running anything", async () => {
  const h = harness(), f = fakes();
  const done = runHost({ input: h.input, output: h.output, directory: h.directory, ClientDevice, createNode: f.createNode, requestImpl: f.requestImpl });
  h.send({ id: 1, op: "state" }); h.input.end();
  await done;
  assert.equal(h.received.length, 0);
  h.cleanup();
});
