// Isolated persistent Core preview. Uses only synthetic identity/model data.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { startFakeIdentity } from "../../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../../server/runtime/pi/p0/fake-model.ts";
const root = mkdtempSync(path.join(tmpdir(), "nex-todo-preview-"));
const { createPersonalApp } = await import(
  pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href
);
const identity = await startFakeIdentity({ displayName: "待办验收" }),
  model = await startFakeModel();
const core = await createPersonalApp({
  dir: root,
  key: randomBytes(32),
  token: "synthetic-todo-preview",
  uiDir: path.resolve("dist-personal/server/ui"),
  memoryRuntime: false,
  hostDevice: false,
  modelCatalog: {
    fetchDisabled: true,
    readSnapshot: () => undefined,
    log: () => {},
  },
  identity: { fixtureOrigin: identity.origin },
});
const bootstrap = await fetch(core.origin + "/api/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "synthetic-todo-preview" }),
});
const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
async function login(route, data) {
  const response = await fetch(core.origin + "/api/" + route, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error("Synthetic fixture login failed");
  return response.json();
}
const transaction = await login("auth/start", {
  account: "owner@example.test",
  name: "待办验收",
});
const { token } = await login("auth/respond", {
  ...transaction,
  password: " synthetic password ",
});
core.store.saveConfig({
  provider: "openai",
  endpoint: model.origin + "/v1",
  model: "fixture-model",
  apiKey: "synthetic-only",
});
for (const name of ["个人助手", "研究伙伴"]) {
  const bot = core.store.createBot(name);
  core.agents.ensure(bot);
}
for (let i = 0; i < 20; i++)
  model.scripts.push({
    kind: "openai-text",
    text: "项目进展已整理：完成待办界面、持久化与验收。下一步：确认交付内容。",
  });
console.log(
  JSON.stringify({
    url: core.origin + "/#token=" + encodeURIComponent(token),
    dataDir: root,
    synthetic: true,
  }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await core.close();
    await model.close();
    await identity.close();
    process.exit(0);
  });
