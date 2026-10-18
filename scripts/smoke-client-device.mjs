// Disposable Core + device controller; never connects to a live account/device.
import assert from "node:assert/strict";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ClientDevice } from "../electron/nex-client-device.mjs";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";

const { createWorkspaceService } = await import(pathToFileURL(path.resolve("dist-personal/server/core/workspaces.js")));
const executorRoot = path.resolve(process.argv.find(a => a.startsWith("--executor-resources="))?.slice(21) ?? "dist-personal/client-executor");
const { createClientNode } = await import(pathToFileURL(path.join(executorRoot, "client-node/client-node.js")));
const root = mkdtempSync(path.join(os.tmpdir(), "nex-device-lifecycle-"));
const identity = await startFakeIdentity(), model = await startFakeModel(), key = randomBytes(32), cases = [];
const core = await createWorkspaceService({ dir: path.join(root, "core"), key: randomBytes(32), token: "synthetic-device-bootstrap", identity: { fixtureOrigin: identity.origin }, memoryRuntime: false });
const safeStorage = {
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
  decryptString(data) { const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(-16)); return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString(); },
};
async function request(origin, route, data, token) {
  const response = await fetch(origin + route, { method: data ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
async function wait(check, label) { const end = Date.now() + 30000; while (!await check()) { if (Date.now() > end) throw new Error("Timeout: " + label); await new Promise(resolve => setTimeout(resolve, 60)); } }
const device = new ClientDevice({ directory: path.join(root, "client"), safeStorage, request, createNode: createClientNode, interval: 150 });
const operator = core.store.get("SELECT * FROM user_sessions WHERE id=?", core.store.session);
const txn = core.identity.start({ account: "owner@example.test", name: "Fixture computer" }, operator);
const owner = { ...await core.identity.respond({ ...txn, password: " synthetic password " }, operator), origin: core.origin, name: "Fixture computer" };
const shared = path.join(root, "shared"); mkdirSync(shared); writeFileSync(path.join(shared, "read.txt"), "fixture content");
const pdfStream = "BT /F1 12 Tf 60 750 Td (PACKAGED_PDF_FIXTURE) Tj ET";
const pdfObjects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${pdfStream.length} >>\nstream\n${pdfStream}\nendstream`];
let pdf = "%PDF-1.4\n"; const offsets = [];
for (const [index, object] of pdfObjects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(path.join(shared, "paper.pdf"), pdf);
let sequence = 0;
try {
  await device.start(owner); await wait(() => device.state().connected && device.state().deviceId, "connected");
  const id = device.state().deviceId;
  assert.equal(device.state().exec, true); assert.equal(device.state().computer, device.state().computerSupported); assert.equal(device.state().root, os.homedir());
  assert.equal(JSON.stringify(device.state()).includes(device.record.token), false);
  assert.equal(readFileSync(device.recordFile).includes(Buffer.from(device.record.token)), false);
  cases.push("login-enables-control-encrypted-grant-no-renderer-secret");
  // Older installs may have declined the removed first-use dialog.
  const oldConsent = device.consentFile;
  await device.stop();
  writeFileSync(oldConsent, safeStorage.encryptString(JSON.stringify({ allowed: false, paused: false })));
  await device.start(owner); await wait(() => device.state().connected, "migrate old declined grant");
  assert.equal(device.state().authorized, true); assert.equal(device.state().exec, true); assert.equal(device.state().root, os.homedir());
  cases.push("old-declined-grant-migrates-to-login-control");
  await device.configure({ root: shared });
  await wait(() => core.gateway.inventory().find(d => d.id === id)?.granted.read, "file grant reaches Core");
  core.store.saveConfig({ provider: "openai", endpoint: model.origin + "/v1", model: "fixture-model", apiKey: "synthetic" });
  const botId = core.store.createBot("Fixture writer", "Only touch fixture data"); core.agents.ensure(botId);
  async function send(args) {
    await wait(() => !core.runtime.workers.size, "worker idle");
    const name = "fixture-device-" + ++sequence;
    model.scripts.push({ kind: "openai-tool", calls: [{ id: name, name: "broker", args: JSON.stringify({ ...args, deviceId: id }) }] }, { kind: "openai-text", text: "Fixture complete" });
    return core.agents.send(botId, "Execute fixture operation", name).taskId;
  }
  let task = await send({ action: "device.read", path: "read.txt" });
  await wait(() => core.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded", "file read");
  assert.match(String(core.store.get("SELECT result_json FROM tool_calls WHERE task_id=?", task)?.result_json), /fixture content/);
  task = await send({ action: "device.read", path: "../outside.txt" });
  await wait(() => core.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded", "outside rejected");
  assert.equal(core.store.get("SELECT status FROM tool_calls WHERE task_id=?", task)?.status, "failed");
  cases.push("authorized-file-read-and-path-boundary");
  task = await send({ action: "device.read", path: "paper.pdf" });
  await wait(() => core.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded", "packaged PDF read");
  assert.match(String(core.store.get("SELECT result_json FROM tool_calls WHERE task_id=?", task)?.result_json), /PACKAGED_PDF_FIXTURE/);
  cases.push("packaged-pdf-worker-and-native-canvas-load");
  await device.configure({ exec: true });
  await wait(() => core.gateway.inventory().find(d => d.id === id)?.granted.exec, "exec grant reaches Core");
  const writeStarted = Date.now();
  task = await send({ action: "device.exec", command: process.platform === "win32" ? "Set-Content -LiteralPath saved.md -Value 'fixture document'" : "printf 'fixture document' > saved.md" });
  await wait(() => core.store.get("SELECT status FROM tasks WHERE id=?", task)?.status === "succeeded", "automatic write");
  assert.equal(core.store.get("SELECT COUNT(*) n FROM approvals").n, 0);
  assert.match(readFileSync(path.join(shared, "saved.md"), "utf8"), /fixture document/);
  cases.push("ordinary-command-saves-local-file-without-approval");
  const fileSaveMs = Date.now() - writeStarted;
  await device.setPaused(true);
  await device.stop(); await device.start(owner);
  assert.equal(device.state().paused, true); assert.equal(device.state().connected, false);
  await device.setPaused(false); await wait(() => device.state().connected, "resume after restart");
  assert.equal(device.state().exec, true);
  assert.equal(device.state().deviceId, id);
  cases.push("restart-preserves-device-and-authorization");
  await device.configure({ exec: true, root: shared });
  await wait(() => core.gateway.inventory().find(d => d.id === id)?.granted.exec, "re-enable");
  task = await send({ action: "device.exec", command: process.platform === "win32" ? "Set-Content started.txt running; Start-Sleep -Seconds 8; Set-Content late.txt forbidden" : "printf running > started.txt; sleep 8; printf forbidden > late.txt" });
  await wait(() => existsSync(path.join(shared, "started.txt")), "command started");
  await device.stop({ revoke: true });
  assert.equal(core.store.get("SELECT status FROM devices WHERE id=?", id)?.status, "revoked");
  await new Promise(resolve => setTimeout(resolve, 8500));
  assert.equal(existsSync(path.join(shared, "late.txt")), false);
  cases.push("logout-stops-owned-process-tree-and-revokes-device");
  const deviceCount = core.store.get("SELECT COUNT(*) n FROM devices").n;
  await device.start(owner);
  assert.equal(device.state().connected, false);
  assert.match(device.state().status, /已被撤销/);
  assert.equal(core.store.get("SELECT COUNT(*) n FROM devices").n, deviceCount);
  await device.stop();
  cases.push("revocation-cannot-silently-register-replacement");
  const againTxn = core.identity.start({ account: "owner@example.test", name: "Fixture computer" }, operator);
  const again = { ...await core.identity.respond({ ...againTxn, password: " synthetic password " }, operator), origin: core.origin, name: "Fixture computer" };
  await device.start(again); await wait(() => device.state().connected, "new login restores authorization");
  assert.equal(device.state().authorized, true); assert.equal(device.state().exec, true);
  await device.setPaused(true);
  await device.stop({ revoke: true });
  cases.push("new-login-restores-control-without-prompt");
  const otherTxn = core.identity.start({ account: "other@example.test", name: "Other fixture" }, operator);
  const other = { ...await core.identity.respond({ ...otherTxn, password: " synthetic password " }, operator), origin: core.origin, name: "Other fixture" };
  await device.start(other); await wait(() => device.state().connected, "other account");
  assert.notEqual(device.state().deviceId, id); assert.equal(device.state().root, os.homedir()); assert.equal(device.state().exec, true);
  assert.equal(device.state().paused, false);
  assert.notEqual(device.consentFile, oldConsent);
  const otherId = device.state().deviceId;
  await request(other.origin, "/api/auth/logout", {}, other.token);
  await wait(() => !device.runtime, "expired session closes device without renderer");
  assert.equal(device.state().connected, false);
  cases.push("account-isolation-and-background-session-expiry");
  assert.ok(otherId);
  console.log(JSON.stringify({ passed: true, cases, fileSaveMs }));
} finally {
  await device.stop(); await core.close(); await model.close(); await identity.close();
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.warn("Owned fixture retained:", root); }
}
