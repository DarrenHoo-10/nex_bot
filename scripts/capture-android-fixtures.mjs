// Capture the wire contract the Android :core tests decode.
//
// One disposable Core, synthetic identity, owned temp data. Volatile values
// (UUIDs, session tokens, timestamps, loopback URLs, temp paths, the sync
// cursor) are normalized through one map so references stay consistent across
// documents, which is what makes `--check` a stable drift gate:
//
//   node scripts/capture-android-fixtures.mjs            # write
//   node scripts/capture-android-fixtures.mjs --check    # compare, exit 1 on drift
//
// Requires a built Core (pnpm build:core). Never touches a live Core, account
// or workspace.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const coreFile = path.resolve(option("core") ?? path.join(repo, "dist-personal", "server", "core", "index.js"));
const outDir = path.resolve(option("out") ?? path.join(repo, "android", "core", "src", "test", "resources", "fixtures"));
const check = args.includes("--check");
if (!existsSync(coreFile)) throw new Error(`Built Core not found at ${coreFile}; run pnpm build:core first`);

const { createPersonalApp } = await import(pathToFileURL(coreFile).href);
const root = mkdtempSync(path.join(os.tmpdir(), "nex-android-fixtures-"));
const provider = await startFakeIdentity();
const app = await createPersonalApp({ dir: root, key: randomBytes(32), token: "synthetic-bootstrap", memoryRuntime: false, identity: { fixtureOrigin: provider.origin } });

let token = "";
const get = async (route, bearer = token) => {
  const response = await fetch(app.origin + "/api/" + route, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
  return { status: response.status, body: await response.json() };
};
const post = async (route, data, bearer = token, cookie) => {
  const response = await fetch(app.origin + "/api/" + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(data),
  });
  return { status: response.status, body: await response.json() };
};

// ---- normalizer ----------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HASH = /^[0-9a-f]{64}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const VOLATILE_KEYS = new Set(["cursor", "privacyEpoch"]);
const strings = new Map();
let stringIndex = 0;
const mapString = (value) => {
  if (!strings.has(value)) strings.set(value, `fixture-id-${++stringIndex}`);
  return strings.get(value);
};
const normalize = (value, key = "") => {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, name)]));
  if (typeof value === "string") {
    if (key === "dataDir") return "fixture-data-dir";
    if (key === "address") return "http://127.0.0.1:0";
    if (HASH.test(value)) return "fixture-hash";
    const loopback = value.replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:0");
    if (UUID.test(value) || TOKEN.test(value)) return mapString(value);
    return loopback.replace(UUID_ANY, (match) => mapString(match));
  }
  if (typeof value === "number") {
    if (VOLATILE_KEYS.has(key)) return 1;
    // Every wall-clock value becomes one stable instant. The fixtures are for
    // decoding shapes, not for re-testing time arithmetic (which lives in the
    // pure rules and their own tests).
    return value >= 1_000_000_000_000 ? 1_700_000_000_000 : value;
  }
  return value;
};

const documents = new Map();
const record = (name, value) => documents.set(name, `${JSON.stringify(normalize(value), null, 2)}\n`);

// The fixture is the phone's contract, not the host's capability report. Host
// computer support (and the tool policy derived from it) differs between a
// packaged Windows build and a Linux CI runner, so it is projected out here:
// what remains is exactly the document the Android model reads.
const projectState = (state) => ({
  ...(state.view === undefined ? {} : { view: state.view }),
  sync: state.sync,
  bots: (state.bots ?? []).map((bot) => ({
    id: bot.id,
    name: bot.name,
    instructions: bot.instructions,
    version: bot.version,
    read_seq: bot.read_seq,
    unread_count: bot.unread_count,
    last_message: bot.last_message,
    last_message_at: bot.last_message_at,
    policy_version: bot.policy_version,
    approval_setting: bot.approval_setting,
    approval_setting_version: bot.approval_setting_version,
  })),
  tasks: state.tasks ?? [],
  approvals: state.approvals ?? [],
  routines: state.routines ?? [],
  occurrences: state.occurrences ?? [],
  memories: state.memories ?? [],
  devices: (state.devices ?? []).map((device) => ({ id: device.id, name: device.name, status: device.status })),
  onlineDevices: state.onlineDevices ?? [],
  delegations: state.delegations ?? [],
  journal: state.journal ?? [],
});

// ---- seed and capture ----------------------------------------------------
try {
  const bootstrap = await fetch(app.origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "synthetic-bootstrap" }) });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const started = await post("auth/start", { account: "owner@example.test", name: "Android fixture" }, undefined, cookie);
  const login = await post("auth/respond", { ...started.body, password: " synthetic password " }, undefined, cookie);
  if (login.status !== 200) throw new Error(`Synthetic login failed: ${JSON.stringify(login.body)}`);
  token = login.body.token;

  const first = await post("bots", { name: "摘要联系人" });
  const second = await post("bots", { name: "第二个 Agent" });
  await post("memory", { botId: first.body.id, title: "发布节奏", content: "每周一上午整理发布清单。" });
  await post("routines", { botId: first.body.id, name: "周一发布检查", prompt: "检查发布清单", scheduleKind: "interval", intervalMinutes: 60, timeZone: "Asia/Shanghai" });
  app.agents.publish(first.body.id, "user", "message", "帮我看看这周的发布清单。", "fixture:user-1");
  app.agents.publish(first.body.id, "assistant", "message", "### 发布清单\n\n- 合并改动\n- 更新说明\n\n| 项 | 状态 |\n|---|---|\n| 构建 | 通过 |", "fixture:assistant-1", app.store.get("SELECT id FROM tasks LIMIT 1")?.id ?? null);
  app.agents.publish(second.body.id, "assistant", "message", "有什么可以帮你？", "fixture:assistant-2");

  record("identity.json", (await get("client/identity", "")).body);
  record("login-start.json", started.body);
  record("login-respond.json", login.body);
  record("state-full.json", projectState((await get("state")).body));
  record("state-summary.json", projectState((await get("state?view=summary")).body));
  record("messages.json", (await get(`agents/messages?bot=${encodeURIComponent(first.body.id)}`)).body);

  const abort = new AbortController();
  const events = await fetch(app.origin + "/api/events?after=0", { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (!raw.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  abort.abort();
  const frame = raw.slice(0, raw.indexOf("\n\n") + 2);
  let cursor = 0;
  const normalizedLines = frame
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data: ")) return line;
      const payload = normalize(JSON.parse(line.slice(6)));
      if (typeof payload.cursor === "number") cursor = payload.cursor;
      return `data: ${JSON.stringify(payload)}`;
    });
  const normalizedFrame = normalizedLines
    .map((line) => (line.startsWith("id: ") ? `id: ${cursor}` : line))
    .join("\n");
  documents.set("events.txt", normalizedFrame.endsWith("\n\n") ? normalizedFrame : `${normalizedFrame}\n\n`);

  if (check) {
    const drift = [];
    for (const [name, content] of documents) {
      const file = path.join(outDir, name);
      if (!existsSync(file) || readFileSync(file, "utf8") !== content) drift.push(name);
    }
    if (drift.length) {
      console.error(`Android fixtures drifted: ${drift.join(", ")}. Re-run without --check and review the diff.`);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ checked: documents.size, outDir }));
    }
  } else {
    mkdirSync(outDir, { recursive: true });
    for (const [name, content] of documents) writeFileSync(path.join(outDir, name), content);
    console.log(JSON.stringify({ written: [...documents.keys()], outDir }));
  }
} finally {
  await app.close();
  await provider.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
