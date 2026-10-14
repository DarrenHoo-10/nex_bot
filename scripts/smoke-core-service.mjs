// Genuine standalone Node service, synthetic identity/model, disposable data.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-service-fixture-"));
const collisionRoot = mkdtempSync(path.join(os.tmpdir(), "nex-service-fixture-port-"));
const entry = path.resolve(process.argv.find((arg) => arg.startsWith("--entry="))?.slice(8) ?? "dist-personal/server/core/service.js");
const provider = await startFakeIdentity(), model = await startFakeModel(), children = [], cases = [];
const environment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), NEX_IDENTITY_FIXTURE_URL: provider.origin };
function launch(command, input, raw = false, directory = root, port = 0) {
  const child = spawn(process.execPath, [entry, command, `--data-dir=${directory}`, `--port=${port}`, "--fixture", ...(input ? ["--input-json"] : [])], { env: environment, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  const instance = { child, stdout: "", stderr: "", exited: false, code: undefined }; children.push(instance);
  instance.closed = new Promise((resolve) => child.once("close", (code) => { instance.exited = true; instance.code = code; resolve(code); }));
  child.stdout.on("data", (data) => { instance.stdout += data; }); child.stderr.on("data", (data) => { instance.stderr += data; });
  if (input) child.stdin.end(raw ? input : JSON.stringify(input));
  return instance;
}
async function until(check, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error("Standalone service fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 40)); }
}
async function ready(instance) {
  await until(() => { if (instance.exited) throw new Error("Standalone service exited: " + instance.stderr); return instance.stdout.includes('"type":"ready"'); });
  return JSON.parse(instance.stdout.split("\n").find((line) => line.includes('"type":"ready"')));
}
async function stop(instance) { instance.child.kill("SIGTERM"); await until(() => instance.exited); if (instance.code !== 0) throw new Error("Service shutdown failed"); }
async function request(origin, route, data, token) {
  const response = await fetch(origin + "/api/" + route, { headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
  return { status: response.status, body: await response.json() };
}
try {
  const malformed = launch("init", "{password:'secret-must-not-be-echoed'}", true);
  await until(() => malformed.exited);
  if (malformed.code !== 1 || malformed.stderr.includes("secret-must-not-be-echoed") || malformed.stdout.includes("secret-must-not-be-echoed")) throw new Error("Malformed credential input leaked into logs");
  cases.push("malformed-login-input-redacted");
  const init = launch("init", { account: "owner@example.test", password: " synthetic password " });
  await until(() => init.exited); if (init.code !== 0 || !init.stdout.includes('"type":"initialized"')) throw new Error("Service account initialization failed: " + init.stderr);
  if (init.stdout.includes("synthetic password") || readFileSync(path.join(root, "core.db")).includes(Buffer.from(" synthetic password "))) throw new Error("Initialization stored a password");
  if (existsSync(path.join(root, "service.lock"))) throw new Error("Initialization retained its service lock");
  const key = readFileSync(path.join(root, "vault-key.bin")); cases.push("headless-owner-initialization", "no-password-storage", "private-server-vault");
  const first = launch("start"), state = await ready(first);
  if (!state.initialized || !(await fetch(state.origin + "/health")).ok || (await request(state.origin, "state")).status !== 401) throw new Error("Service identity gate failed");
  const wrong = await request(state.origin, "auth/start", { account: "owner@example.test", name: "fixture" });
  if ((await request(state.origin, "auth/respond", { ...wrong.body, password: "wrong" })).status !== 401) throw new Error("Wrong password accepted");
  const start = await request(state.origin, "auth/start", { account: "owner@example.test", name: "Service fixture client" });
  const login = await request(state.origin, "auth/respond", { ...start.body, password: " synthetic password " });
  if (login.status !== 200) throw new Error("Service login failed");
  const token = login.body.token;
  await request(state.origin, "config", { provider: "openai", endpoint: model.origin + "/v1", model: "fixture-model", apiKey: "synthetic-only" }, token);
  const bot = await request(state.origin, "bots", { name: "后端持久联系人" }, token);
  model.scripts.push({ kind: "openai-text", text: "独立后端 Agent 任务完成" });
  await request(state.origin, "agents/input", { botId: bot.body.id, text: "合成后台任务", clientId: randomUUID() }, token);
  await until(async () => (await request(state.origin, "state", undefined, token)).body.tasks.some((task) => task.status === "succeeded"));
  cases.push("authenticated-service-API", "actual-Pi-worker-task", "model-key-in-backend");
  const duplicate = launch("start"); await until(() => duplicate.exited); if (duplicate.code !== 1 || !duplicate.stderr.includes("已有后端")) throw new Error("Duplicate service accessed data");
  cases.push("single-writer-service-lock");
  const collision = launch("start", undefined, false, collisionRoot, Number(new URL(state.origin).port));
  await until(() => collision.exited);
  if (collision.code !== 1 || !collision.stderr.includes("EADDRINUSE") || collision.stdout.includes('"type":"ready"')) throw new Error("Service silently changed its configured port");
  cases.push("configured-port-does-not-drift");
  await stop(first);
  if (existsSync(path.join(root, "service.lock"))) throw new Error("Graceful stop retained lock");
  const second = launch("start"), next = await ready(second);
  if (next.coreId !== state.coreId || !readFileSync(path.join(root, "vault-key.bin")).equals(key)) throw new Error("Service restart changed identity or vault");
  const restored = await request(next.origin, "state", undefined, token);
  if (restored.status !== 200 || restored.body.bots[0]?.name !== "后端持久联系人") throw new Error("Restart lost account/data");
  if (restored.body.memoryPlugin.enabled || existsSync(path.join(root, "memory-runtime"))) throw new Error("Service launched bundled memory");
  await request(next.origin, "auth/logout", {}, token);
  if ((await request(next.origin, "state", undefined, token)).status !== 401) throw new Error("Logout retained business access");
  await stop(second); cases.push("persistent-service-restart", "no-bundled-memory", "upstream-logout", "graceful-service-stop");
  console.log(JSON.stringify({ passed: true, cases, serviceEntry: entry, modelRequests: model.requests.length }));
} finally {
  for (const instance of children) if (!instance.exited) { instance.child.kill("SIGTERM"); await until(() => instance.exited).catch(() => instance.child.kill("SIGKILL")); }
  await model.close(); await provider.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(collisionRoot, { recursive: true, force: true });
}
