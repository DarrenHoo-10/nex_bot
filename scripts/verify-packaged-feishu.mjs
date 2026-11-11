import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const server = path.resolve(process.argv[2] ?? "dist-personal/server");
const entry = path.join(server, "core/index.js");
const require = createRequire(entry);
const sdkName = "@larksuiteoapi/node-sdk";
const manifest = require.resolve(sdkName + "/package.json");
assert.equal(manifest, path.join(server, "core/node_modules", sdkName, "package.json"));
const sdk = require(sdkName);
assert.equal(typeof sdk.WSClient, "function");
assert.equal(typeof sdk.EventDispatcher, "function");
// Keep the packaged SDK, its interceptors and QR construction in the path.
// Only the provider's HTTP response is synthetic, and accidental egress fails locally.
process.env.HTTPS_PROXY = process.env.HTTP_PROXY = "http://127.0.0.1:1";
process.env.https_proxy = process.env.http_proxy = process.env.HTTPS_PROXY;
process.env.no_proxy = process.env.NO_PROXY = "localhost,127.0.0.1,::1";
const actions = [];
sdk.defaultHttpInstance.defaults.adapter = async (config) => {
  assert.equal(new URL(config.url).pathname, "/oauth/v1/app/registration");
  assert.equal(config.method, "post");
  const params = new URLSearchParams(config.data);
  const action = params.get("action");
  actions.push(action);
  assert.equal(config.headers.get("User-Agent"), "oapi-node-sdk/" + require(manifest).version);
  if (action === "poll") {
    assert.equal(params.get("device_code"), "fixture");
    return { config, status: 200, statusText: "OK", headers: {}, data: { error: "authorization_pending" } };
  }
  assert.equal(action, "begin");
  return { config, status: 200, statusText: "OK", headers: {}, data: {
    verification_uri_complete: "https://accounts.feishu.cn/fixture?code=synthetic", device_code: "fixture", expires_in: 300, interval: 60,
  } };
};

const { createPersonalApp } = await import(pathToFileURL(entry).href);
const dir = mkdtempSync(path.join(os.tmpdir(), "nex-packaged-feishu-"));
let app;
try {
  app = await createPersonalApp({ dir, key: randomBytes(32), token: "fixture", identity: false,
    hostDevice: false, memoryRuntime: false, modelCatalog: { fetchDisabled: true } });
  const api = async (route, body) => {
    const response = await fetch(app.origin + "/api/" + route, {
      headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const { botId } = await api("agents/finance");
  await api("feishu/register/start", { botId });
  let job;
  const deadline = Date.now() + 5000;
  do {
    job = (await api("state")).feishu.job;
    if (job?.stage !== "preparing") break;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(job?.stage, "qr", job?.error);
  const qr = new URL(job.url);
  assert.equal(qr.origin, "https://accounts.feishu.cn");
  assert.equal(qr.searchParams.get("createOnly"), "true");
  assert.equal(qr.searchParams.get("name"), "金融助手");
  assert.match(job.scanPath, /^\/feishu\/s\/[\w-]{22}$/);
  const scan = new URL(job.scanPath, app.origin);
  const landing = await fetch(scan, { redirect: "manual" });
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get("location"), job.url);
  assert.equal(landing.headers.get("cache-control"), "no-store");
  assert.equal(landing.headers.get("referrer-policy"), "no-referrer");
  await api("feishu/register/cancel", {});
  assert.equal((await api("state")).feishu.job ?? null, null);
  assert.equal((await fetch(scan, { redirect: "manual" })).status, 410);
  assert.equal(actions[0], "begin");
  assert.equal(actions.filter(action => action === "begin").length, 1);
  console.log("Packaged Feishu SDK: registration QR, SDK version and cancellation verified.");
} finally {
  try { await app?.close(); }
  finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}
