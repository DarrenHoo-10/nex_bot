// Owned, synthetic data only. Connect an emulator using adb reverse for this port.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";
import { startFakeMcp } from "../server/personal-os/testing/fake-mcp.ts";

const output = path.resolve(process.argv[2] || "release/android-workspace"); mkdirSync(output, { recursive: true });
const dir = mkdtempSync(path.join(os.tmpdir(), "nex-android-workspace-"));
const identity = await startFakeIdentity({ displayName: "演示账号" }), model = await startFakeModel(), mcp = await startFakeMcp();
model.scripts.push(...Array.from({ length: 20 }, () => ({ kind: "openai-text", text: "## 今日进度\n\n已整理好资料。\n\n| 项目 | 状态 |\n| --- | --- |\n| 资料整理 | 已完成 |\n| 下一步 | 等待安排 |" })));
const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
const app = await createPersonalApp({ port: process.argv[3] ? Number(process.argv[3]) : undefined, strictPort: true, dir, key: randomBytes(32), token: "synthetic-bootstrap", memoryRuntime: false,
  modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} }, identity: { fixtureOrigin: identity.origin } });
const bootstrap = await fetch(app.origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "synthetic-bootstrap" }) });
const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
const login = async (route, data) => (await fetch(app.origin + "/api/" + route, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(data) })).json();
const start = await login("auth/start", { account: "owner@example.test", name: "演示电脑" });
const { token } = await login("auth/respond", { ...start, password: " synthetic password " });
async function api(route, data) {
  const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
  if (!response.ok) throw new Error(`Fixture setup failed: ${route} ${response.status}`);
  return response.json();
}
await api("config", { provider: "openai", endpoint: model.origin + "/v1", model: "fixture-model", apiKey: "synthetic-only" });
const bot = await api("bots", { name: "工作助手", instructions: "整理资料，帮助你推进每天的工作。" });
await api("bots", { name: "研究伙伴", instructions: "研究问题，整理依据。" });
app.store.run("UPDATE devices SET name=?", "演示电脑");
writeFileSync(path.join(output, "fixture.json"), JSON.stringify({ origin: app.origin, model: model.origin, mcp: mcp.origin, bot: bot.id, dir, token }));
console.log(JSON.stringify({ origin: app.origin, output }));
try {
  await new Promise(resolve => {
    const timer = setInterval(() => { if (existsSync(path.join(output, "stop"))) { clearInterval(timer); resolve(); } }, 1000);
    process.once("SIGINT", () => { clearInterval(timer); resolve(); });
    process.once("SIGTERM", () => { clearInterval(timer); resolve(); });
  });
} finally { await app.close(); await model.close(); await mcp.close(); await identity.close(); }
