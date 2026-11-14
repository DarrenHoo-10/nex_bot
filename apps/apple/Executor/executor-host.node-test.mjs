import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ClientDevice } from "../../../electron/nex-client-device.mjs";
import { captureLoginEnv, createSafeStorage, runHost } from "./executor-host.mjs";

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
  const calls = [], nodes = [], optionsSeen = [];
  const requestImpl = async (_origin, route, data, token) => {
    calls.push([route, data, token]);
    if (route === "/api/session") return { authenticated: true, ...session };
    if (route === "/api/state") return { devices: [{ id: "dev-1", status: "bound" }], sync: { coreId: "workspace" } };
    if (route === "/api/devices") return { deviceId: "dev-1", token: "dev-token" };
    return {};
  };
  const createNode = (_dir, key, changed, _origin, options) => {
    assert.equal(key.length, 32);
    optionsSeen.push(options);
    const node = { cfg: undefined, reconciled: [], computer: { available: () => false }, configure(c) { this.cfg = c; changed(); }, reconcile(...a) { this.reconciled.push(a); }, publicState: () => ({ status: "ready", connected: !!node.cfg, deviceId: "dev-1", unknownCalls: [], cliAgents: { hc: "ready", engines: [{ engine: "claude", version: "2.1.0" }] } }) };
    nodes.push(node);
    return { node, async close() { node.closed = true; } };
  };
  return { calls, nodes, optionsSeen, requestImpl, createNode };
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

test("cliAgents switches Agent sessions for this device and reports the CLI status", async () => {
  const h = harness(), f = fakes();
  const done = runHost({ input: h.input, output: h.output, directory: h.directory, ClientDevice, createNode: f.createNode, requestImpl: f.requestImpl });
  try {
    h.send({ op: "init", key: randomBytes(32).toString("base64") });
    h.send({ id: 1, op: "start", session });
    const started = await h.until((m) => m.id === 1);
    assert.deepEqual(started.state.cliAgents, { available: true, enabled: true, hc: "ready", engines: [{ engine: "claude", version: "2.1.0" }] });
    h.send({ id: 2, op: "cliAgents", enabled: false });
    const off = await h.until((m) => m.id === 2);
    assert.equal(off.ok, true);
    assert.equal(off.state.cliAgents.enabled, false);
    assert.equal(f.nodes.at(-1).cfg.cliAgents, false);
    h.send({ id: 3, op: "cliAgents", enabled: "yes" });
    assert.deepEqual(await h.until((m) => m.id === 3), { id: 3, ok: false, error: "invalid enabled" });
    h.send({ id: 4, op: "cliAgents", enabled: true });
    assert.equal((await h.until((m) => m.id === 4)).state.cliAgents.enabled, true);
    assert.equal(f.nodes.at(-1).cfg.cliAgents, true);
  } finally { h.input.end(); await done; h.cleanup(); }
});

test("Agent sessions get the login shell environment; nothing else about the node options changes", async () => {
  const h = harness(), f = fakes();
  const login = { PATH: "/opt/homebrew/bin:/usr/bin", HTTPS_PROXY: "http://127.0.0.1:7890" };
  const done = runHost({ input: h.input, output: h.output, directory: h.directory, ClientDevice, createNode: f.createNode, requestImpl: f.requestImpl, loginEnv: async () => ({ env: login, source: "login-shell" }) });
  try {
    h.send({ op: "init", key: randomBytes(32).toString("base64") });
    h.send({ id: 1, op: "start", session });
    await h.until((m) => m.id === 1);
    assert.equal(f.optionsSeen[0].autoConnect, false);
    assert.deepEqual(f.optionsSeen[0].cliAgents, { env: login });
    assert.ok(!JSON.stringify(h.received).includes("127.0.0.1:7890"), "variable values never reach the protocol");
  } finally { h.input.end(); await done; h.cleanup(); }
});

test("a failing or missing login environment leaves the node options as they were", async () => {
  for (const loginEnv of [undefined, async () => { throw new Error("boom"); }, async () => undefined]) {
    const h = harness(), f = fakes(), logs = [];
    const done = runHost({ input: h.input, output: h.output, directory: h.directory, ClientDevice, createNode: f.createNode, requestImpl: f.requestImpl, loginEnv, log: (m) => logs.push(m) });
    try {
      h.send({ op: "init", key: randomBytes(32).toString("base64") });
      h.send({ id: 1, op: "start", session });
      assert.equal((await h.until((m) => m.id === 1)).ok, true);
      assert.equal(f.optionsSeen[0].cliAgents, true);
    } finally { h.input.end(); await done; h.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// captureLoginEnv

const NUL = "\0";
function fakeSpawn(output, { close = true } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdout = new PassThrough();
    calls.push({ command, args, options, child });
    setImmediate(() => {
      for (const chunk of [].concat(output)) child.stdout.write(chunk);
      if (close) child.emit("close", 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}
const dump = (pairs) => pairs.join(NUL);

test("captureLoginEnv runs the user's shell as a login shell and merges what it prints over the fallback", async () => {
  const { spawnImpl, calls } = fakeSpawn([
    "Last login: noise from rc files\n",
    "NEXBOT_ENV_START_n1",
    dump(["PATH=/opt/homebrew/bin:/usr/bin", "HTTPS_PROXY=http://127.0.0.1:7890", "MULTI=a\nb=c", "_=/usr/bin/env", "SHLVL=2", "PWD=/x", "OLDPWD=/y", "bad name=1", "=novalue", "NOEQUALS", "EMPTY="]),
    "NEXBOT_ENV_END_n1",
    "\nmore noise",
  ]);
  const logs = [];
  const result = await captureLoginEnv({ fallback: { PATH: "/usr/bin:/bin", HOME: "/Users/me", TMPDIR: "/tmp/" }, shell: "/bin/zsh", spawnImpl, nonce: "n1", platform: "darwin", nodePath: "/App/node", log: (m) => logs.push(m) });
  assert.equal(result.source, "login-shell");
  assert.deepEqual(result.env, { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/me", TMPDIR: "/tmp/", HTTPS_PROXY: "http://127.0.0.1:7890", MULTI: "a\nb=c", EMPTY: "" });
  const [call] = calls;
  assert.equal(call.command, "/bin/zsh");
  assert.deepEqual(call.args.slice(0, 3), ["-l", "-i", "-c"]);
  assert.match(call.args[3], /^printf %s NEXBOT_ENV_START_n1; '\/App\/node' -e '.*'; printf %s NEXBOT_ENV_END_n1$/);
  assert.deepEqual(call.options.stdio, ["ignore", "pipe", "ignore"]);
  assert.equal(call.options.detached, true);
  assert.ok(logs.every((line) => !line.includes("127.0.0.1")), "values are never logged");
});

test("captureLoginEnv takes the shell from the minimal environment's SHELL and quotes the node path", async () => {
  const { spawnImpl, calls } = fakeSpawn(["NEXBOT_ENV_START_n2", "A=1", "NEXBOT_ENV_END_n2"]);
  await captureLoginEnv({ fallback: { SHELL: "/bin/bash" }, spawnImpl, nonce: "n2", platform: "darwin", nodePath: "/Users/o'brien/App Support/node" });
  assert.equal(calls[0].command, "/bin/bash");
  assert.ok(calls[0].args[3].includes(`'/Users/o'\\''brien/App Support/node' -e `));
});

test("captureLoginEnv falls back to the minimal environment on every failure", async () => {
  const fallback = { PATH: "/usr/bin", HOME: "/Users/me" };
  const expected = { env: fallback, source: "fallback" };
  // missing markers (a shell that exited early), empty dump, too much output
  assert.deepEqual(await captureLoginEnv({ fallback, shell: "/bin/zsh", platform: "darwin", ...fakeSpawn(["no markers"]) }), expected);
  assert.deepEqual(await captureLoginEnv({ fallback, shell: "/bin/zsh", platform: "darwin", nonce: "n3", ...fakeSpawn(["NEXBOT_ENV_START_n3NEXBOT_ENV_END_n3"]) }), expected);
  const killed = [];
  const huge = fakeSpawn([Buffer.alloc(1024 * 1024 + 1, "a")], { close: false });
  assert.deepEqual(await captureLoginEnv({ fallback, shell: "/bin/zsh", platform: "darwin", killImpl: (child) => killed.push(child.pid), ...huge }), expected);
  assert.deepEqual(killed, [424242]);
  // spawn throwing, spawn error event, unusable shells, Windows
  assert.deepEqual(await captureLoginEnv({ fallback, shell: "/bin/zsh", platform: "darwin", spawnImpl: () => { throw new Error("ENOENT"); } }), expected);
  const erroring = () => { const child = new EventEmitter(); child.stdout = new PassThrough(); setImmediate(() => child.emit("error", new Error("ENOENT"))); return child; };
  assert.deepEqual(await captureLoginEnv({ fallback, shell: "/bin/zsh", platform: "darwin", spawnImpl: erroring }), expected);
  for (const shell of ["zsh", "relative/zsh", "/bin/z\0sh"]) {
    const { spawnImpl, calls } = fakeSpawn([]);
    assert.deepEqual(await captureLoginEnv({ fallback, shell, platform: "darwin", spawnImpl }), expected);
    assert.equal(calls.length, 0);
  }
  const { spawnImpl, calls } = fakeSpawn([]);
  assert.deepEqual(await captureLoginEnv({ fallback, shell: "/bin/zsh", platform: "win32", spawnImpl }), expected);
  assert.equal(calls.length, 0);
});

test("captureLoginEnv gives up after the timeout and kills the shell", async () => {
  const fallback = { PATH: "/usr/bin" };
  const killed = [];
  const hung = fakeSpawn([], { close: false });
  const started = Date.now();
  const result = await captureLoginEnv({ fallback, shell: "/bin/zsh", platform: "darwin", timeoutMs: 30, killImpl: (child) => killed.push(child.pid), ...hung });
  assert.deepEqual(result, { env: fallback, source: "fallback" });
  assert.deepEqual(killed, [424242]);
  assert.ok(Date.now() - started < 2000);
});

test("captureLoginEnv with a real shell that prints the markers", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-login-shell-"));
  try {
    // A stand-in login shell: prints rc-file noise, then runs the -c script with plain sh.
    const shell = path.join(dir, "fake-shell");
    writeFileSync(shell, '#!/bin/sh\necho "welcome back"\nshift 3\nexec /bin/sh -c "$1"\n', { mode: 0o755 });
    const result = await captureLoginEnv({ fallback: { PATH: process.env.PATH, NEX_MARKER: "kept" }, shell, platform: "darwin" });
    assert.equal(result.source, "login-shell");
    assert.equal(result.env.NEX_MARKER, "kept");
    assert.ok(result.env.PATH);
    assert.equal(result.env._, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("captureLoginEnv really kills a login shell that never answers", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-login-hang-"));
  try {
    const pidFile = path.join(dir, "pid");
    const shell = path.join(dir, "hang-shell");
    writeFileSync(shell, `#!/bin/sh\n[ "$1" = warm ] && exit 0\necho $$ > '${pidFile}'\nsleep 30\n`, { mode: 0o755 });
    // The first run of a new executable can be slow on macOS (file scanning): warm it up so the timeout measures the hang.
    execFileSync(shell, ["warm"], { timeout: 20_000 });
    const result = await captureLoginEnv({ fallback: { PATH: "/usr/bin:/bin" }, shell, platform: "darwin", timeoutMs: 1500 });
    assert.equal(result.source, "fallback");
    for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0), "the shell is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
