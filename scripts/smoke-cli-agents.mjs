// Agent mode, end to end in a real browser (plan 8.2).
//
// An isolated fixture Core (fake identity), the real DeviceNode + CLI agent bridge
// in its own process, the real herdr-core (own session and pipe), and a stand-in
// `claude.cmd` that runs scripts/testing/fake-tui.mjs. Headless Edge/Chrome is driven
// over CDP. The real `claude` / `codex` are never started and no file under the
// user's ~/.claude or ~/.codex is read: the device sees only temporary directories and
// a restricted PATH. Windows only (herdr-core + ConPTY).
//
//   node scripts/smoke-cli-agents.mjs [--skip-build] [--keep-going]
//   node scripts/smoke-cli-agents.mjs --serve[=PORT]   same isolated fixture, left running for a person to try
//     in a browser (default port 8765) until Ctrl-C; no browser steps run.
//   CHROME_BIN=<path to chrome or msedge> overrides the browser.
//
// Screenshots go to release/agent-mode-smoke/ (git-ignored). Exit code 1 when any
// step fails; everything started here is stopped and deleted either way.
import { build } from "esbuild";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { decodePng } from "./testing/png.ts";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repo);
const argv = new Set(process.argv.slice(2));
const serveArg = process.argv.slice(2).find((arg) => arg === "--serve" || arg.startsWith("--serve="));
const servePort = serveArg ? Number(serveArg.split("=")[1] || 8765) : 0;
class Served extends Error {}
const shotDir = path.join(repo, "release", "agent-mode-smoke");
const OWNER_EMAIL = "owner@example.test";
const OWNER_PASSWORD = " synthetic password ";
const DEVICE_NAME = "演示电脑";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[smoke] ${message}`);
const results = [];
const findings = [];
const cleanups = [];
let browserLogs = "";
const pageErrors = [];

async function until(check, label, timeout = 30_000, interval = 100) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms: ${label}${last ? ` (last error: ${last.message})` : ""}`);
    await pause(interval);
  }
}

async function step(name, run, { fatal = false } = {}) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, detail: detail ?? "", ms: Date.now() - started });
    log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
    return true;
  } catch (error) {
    results.push({ name, ok: false, detail: error.message, ms: Date.now() - started });
    log(`FAIL ${name}: ${error.message}`);
    if (fatal) throw new Error(`Fatal step failed: ${name}`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runInherit(command, args) {
  const result = spawnSync(command, args, { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const found = candidates.find((file) => existsSync(file));
  if (!found) throw new Error("No Chrome or Edge found; set CHROME_BIN");
  return found;
}

function productVersion(file) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Item '${file}').VersionInfo.ProductVersion`], { encoding: "utf8", timeout: 20_000 }).trim();
  } catch {
    return "unknown";
  }
}

function herdrProcesses() {
  // informational: the user's classic herdr.exe must be unchanged by this run
  try {
    const out = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq herdr.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 20_000 });
    return out.split(/\r?\n/).filter((line) => line.toLowerCase().includes("herdr.exe")).map((line) => line.split('","')[1]);
  } catch {
    return [];
  }
}

function pngCheck(file) {
  const png = decodePng(readFileSync(file));
  const colors = new Set();
  let sampled = 0;
  const stepX = Math.max(1, Math.floor(png.width / 120));
  const stepY = Math.max(1, Math.floor(png.height / 120));
  const histogram = new Map();
  for (let y = 0; y < png.height; y += stepY) {
    for (let x = 0; x < png.width; x += stepX) {
      const [r, g, b] = png.pixel(x, y);
      const key = (r << 16) | (g << 8) | b;
      colors.add(key);
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      sampled += 1;
    }
  }
  const dominant = Math.max(...histogram.values()) / sampled;
  return { width: png.width, height: png.height, colors: colors.size, dominant: Number(dominant.toFixed(3)) };
}

// ---------------------------------------------------------------------------
// the stand-in `claude`

function wrapperSource({ configDir, tui }) {
  return `
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.0 (Claude Code)"); process.exit(0); }
const after = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : ""; };
const fresh = after("--session-id");
const id = fresh || after("--resume");
if (!id) { console.error("stand-in claude: no session id"); process.exit(2); }
const configDir = ${JSON.stringify(configDir)};
const projects = path.join(configDir, "projects");
let transcript = "";
if (!fresh && existsSync(projects)) {
  for (const folder of readdirSync(projects)) {
    const candidate = path.join(projects, folder, id + ".jsonl");
    if (existsSync(candidate)) transcript = candidate;
  }
}
if (!transcript) {
  const folder = path.join(projects, "smoke-" + process.cwd().replace(/[^a-zA-Z0-9]+/g, "-"));
  mkdirSync(folder, { recursive: true });
  transcript = path.join(folder, id + ".jsonl");
}
let serial = 0;
const stamp = () => new Date().toISOString();
const base = () => ({ uuid: "smoke-" + id.slice(0, 8) + "-" + process.pid + "-" + (++serial), sessionId: id, timestamp: stamp(), cwd: process.cwd(), isSidechain: false, entrypoint: "cli", version: "2.1.0" });
const add = (record) => appendFileSync(transcript, JSON.stringify(record) + "\\n");
const say = (role, text) => add(role === "user"
  ? { type: "user", ...base(), message: { role: "user", content: text } }
  : { type: "assistant", ...base(), message: { role: "assistant", model: "stand-in", content: [{ type: "text", text }] } });
const live = path.join(configDir, "sessions", process.pid + ".json");
mkdirSync(path.dirname(live), { recursive: true });
const status = (value) => writeFileSync(live, JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd(), kind: "interactive", entrypoint: "cli", status: value, updatedAt: Date.now(), version: "2.1.0" }));
process.on("exit", () => { try { rmSync(live, { force: true }); } catch {} });
if (fresh) say("user", "Start of the smoke session");
status("idle");
let line = "";
process.stdin.on("data", (chunk) => {
  for (const char of chunk.toString("utf8")) {
    if (char === "\\x03") { line = ""; status("idle"); }
    else if (char === "\\r" || char === "\\n") {
      const text = line.trim();
      line = "";
      if (!text) continue;
      say("user", text);
      if (/^work/i.test(text)) status("busy");
      else { say("assistant", "you said: " + text); status("idle"); }
    }
    else if (char === "\\x7f" || char === "\\b") line = line.slice(0, -1);
    else if (char >= " ") line += char;
  }
});
await import(${JSON.stringify(pathToFileURL(tui).href)});
`;
}

// ---------------------------------------------------------------------------
// synthetic sessions

function writeJsonl(file, records, ageMs) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}

const HOUR = 3_600_000;
const IDS = {
  alphaOne: "a1111111-1111-4111-8111-111111111111",
  alphaTwo: "a2222222-2222-4222-8222-222222222222",
  betaCodex: "019a0000-0000-7000-8000-0000000000b3",
};

function seedSessions({ claudeDir, codexHome, work }) {
  const claudeRecord = (id, cwd, ageMs, user, assistant) => {
    const t = (offset) => new Date(Date.now() - ageMs + offset).toISOString();
    return [
      { type: "user", uuid: `${id.slice(0, 2)}-u1`, sessionId: id, timestamp: t(0), cwd, gitBranch: "main", entrypoint: "cli", version: "2.1.0", isSidechain: false, message: { role: "user", content: user } },
      { type: "assistant", uuid: `${id.slice(0, 2)}-a1`, sessionId: id, timestamp: t(1000), isSidechain: false, message: { role: "assistant", model: "stand-in", content: [{ type: "text", text: assistant }] } },
    ];
  };
  writeJsonl(path.join(claudeDir, "projects", "alpha", `${IDS.alphaOne}.jsonl`), claudeRecord(IDS.alphaOne, path.join(work, "alpha"), 2 * HOUR, "重构解析器", "已经拆成三个函数。"), 2 * HOUR);
  writeJsonl(path.join(claudeDir, "projects", "alpha", `${IDS.alphaTwo}.jsonl`), claudeRecord(IDS.alphaTwo, path.join(work, "alpha"), 3 * HOUR, "Fix the flaky test", "The race is in the setup step."), 3 * HOUR);
  const when = new Date(Date.now() - 4 * HOUR);
  const day = (n) => String(n).padStart(2, "0");
  const rollout = path.join(codexHome, "sessions", String(when.getFullYear()), day(when.getMonth() + 1), day(when.getDate()), `rollout-${when.getFullYear()}-${day(when.getMonth() + 1)}-${day(when.getDate())}T${day(when.getHours())}-00-00-${IDS.betaCodex}.jsonl`);
  const at = (offset) => new Date(Date.now() - 4 * HOUR + offset).toISOString();
  writeJsonl(rollout, [
    { timestamp: at(0), type: "session_meta", payload: { id: IDS.betaCodex, cwd: path.join(work, "beta"), originator: "codex_cli_rs", cli_version: "0.120.0", source: "cli" } },
    { timestamp: at(1000), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { timestamp: at(1100), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "整理发布说明" }] } },
    { timestamp: at(1200), type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "turn-1", item: { type: "UserMessage", id: "item-1", content: [{ type: "text", text: "整理发布说明" }] } } },
    { timestamp: at(3000), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "发布说明已整理。" }] } },
    { timestamp: at(3100), type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "turn-1", item: { type: "AgentMessage", id: "item-3", content: [{ type: "Text", text: "发布说明已整理。" }] } } },
    { timestamp: at(4000), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ], 4 * HOUR);
}

// ---------------------------------------------------------------------------
// herdr-core cleanup: only the session this run's device created

async function cleanupHerdr(scopeFile, binary) {
  if (!existsSync(scopeFile)) return "no herdr-core session was started";
  const scope = JSON.parse(readFileSync(scopeFile, "utf8"));
  const session = String(scope.session ?? "");
  const socket = String(scope.socket ?? "");
  const hex = session.slice("nexbot-".length);
  if (!/^nexbot-[0-9a-f]{8}$/.test(session) || socket !== `\\\\.\\pipe\\nexbot-hc-${hex}`) throw new Error(`Refusing to clean unexpected herdr-core session: ${session}`);
  const { HerdrCore } = await import(pathToFileURL(path.join(repo, "server/personal-os/cli-agents-node/hc.ts")).href);
  const probe = new HerdrCore({ binary, session, socket });
  try {
    await probe.ensureStarted();
    for (const terminal of (await probe.list({ labels: { nexbot: "1" } })).terminals) {
      if (terminal.state === "live" && terminal.pid) {
        try { execFileSync("taskkill.exe", ["/PID", String(terminal.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
      }
    }
  } catch {
    // the core may already be gone
  } finally {
    try { probe.close(); } catch { /* ignore */ }
  }
  // Stop the core over its own pipe (the `server stop` command answers stopped:false for an isolated session).
  await new Promise((resolve) => {
    const socketConnection = net.connect(socket);
    const done = () => { try { socketConnection.destroy(); } catch { /* ignore */ } resolve(); };
    socketConnection.on("error", done);
    socketConnection.on("connect", () => {
      socketConnection.write(JSON.stringify({ id: 1, method: "hello", params: {} }) + "\n");
      setTimeout(() => { try { socketConnection.write(JSON.stringify({ id: 2, method: "server.stop", params: {} }) + "\n"); } catch { /* ignore */ } }, 300);
      setTimeout(done, 2500);
    });
  });
  const pipe = socket.split("\\").pop();
  // Anything of this binary that is still around (the terminal holder carries the pipe name; the binary lives in this run's own tree).
  const survivors = () => {
    const query = `Get-CimInstance Win32_Process -Filter "Name='herdr-core.exe'" | Where-Object { $_.ExecutablePath -eq '${binary}' -or $_.CommandLine -like '*${pipe}*' } | ForEach-Object { $_.ProcessId }`;
    try { return execFileSync("powershell.exe", ["-NoProfile", "-Command", query], { encoding: "utf8", timeout: 30_000 }).split(/\s+/).filter(Boolean); } catch { return []; }
  };
  for (const pid of survivors()) {
    try { execFileSync("taskkill.exe", ["/PID", pid, "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
  }
  await pause(700);
  const left = survivors();
  const stateDir = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "herdr-core", session) : "";
  if (stateDir) rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  const pipeGone = await new Promise((resolve) => {
    const probeSocket = net.connect(socket);
    probeSocket.on("error", () => resolve(true));
    probeSocket.on("connect", () => { probeSocket.destroy(); resolve(false); });
  });
  return `herdr-core session ${session}: ${left.length ? `STILL RUNNING pids ${left.join(",")}` : "no core or holder process left"}, pipe ${pipeGone ? "gone" : "STILL ANSWERING"}, state dir ${stateDir && existsSync(stateDir) ? "STILL PRESENT" : "removed"}`;
}

// ---------------------------------------------------------------------------
// main

if (process.platform !== "win32") {
  console.log("SKIP: this smoke needs Windows (herdr-core ConPTY).");
  process.exit(0);
}

const classicBefore = herdrProcesses();
const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "nex-agent-smoke-"));
cleanups.push(async () => {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try { rmSync(root, { recursive: true, force: true }); return `temp dir removed: ${root}`; } catch { await pause(300); }
  }
  return `temp dir RETAINED: ${root}`;
});

let core;
let identity;
let device;
let browser;
let evaluate;
let command;
let ownerToken = "";
let deviceId = "";
const scopeFile = path.join(root, "hc-scope.json");
const herdrBinary = path.join(repo, "dist-native", "herdr-core", `${process.platform}-${process.arch}`, "herdr-core.exe");
let browserPath = "";
let browserVersion = "";
// Registered before the device, so it runs after the device (its client) and before the temp directory goes.
cleanups.push(() => cleanupHerdr(scopeFile, herdrBinary));

try {
  // ----- prerequisites -----
  await step("prerequisites", async () => {
    browserPath = findBrowser();
    browserVersion = productVersion(browserPath);
    if (!argv.has("--skip-build")) {
      // Always rebuild: an existing dist-personal can be an older build without Agent mode.
      log("building Core: node scripts/build-personal.mjs --core");
      runInherit("node", ["scripts/build-personal.mjs", "--core"]);
      if (!existsSync(herdrBinary)) {
        log("staging herdr-core: corepack pnpm build:herdr-core");
        runInherit("corepack", ["pnpm", "build:herdr-core"]);
      }
    }
    assert(existsSync(path.join(repo, "dist-personal/server/core/index.js")), "dist-personal is not built (run node scripts/build-personal.mjs --core)");
    assert(existsSync(herdrBinary), `herdr-core is not staged at ${herdrBinary}`);
    const version = execFileSync(herdrBinary, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
    return `node ${process.version}, ${path.basename(browserPath)} ${browserVersion}, ${version}`;
  }, { fatal: true });

  // ----- fixture layout -----
  const dirs = {
    claude: path.join(root, "claude-config"),
    codex: path.join(root, "codex-home"),
    home: path.join(root, "home"),
    work: path.join(root, "work"),
    shims: path.join(root, "shims"),
    device: path.join(root, "device"),
    bundle: path.join(root, "bundle"),
    profile: path.join(root, "browser-profile"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  for (const name of ["alpha", "beta", "gamma"]) mkdirSync(path.join(dirs.work, name), { recursive: true });
  seedSessions({ claudeDir: dirs.claude, codexHome: dirs.codex, work: dirs.work });

  const tui = path.join(repo, "scripts", "testing", "fake-tui.mjs");
  assert(existsSync(tui), "fake-tui.mjs is missing");
  writeFileSync(path.join(dirs.shims, "claude.mjs"), wrapperSource({ configDir: dirs.claude, tui }));
  writeFileSync(path.join(dirs.shims, "claude.cmd"), `@"${process.execPath}" "${path.join(dirs.shims, "claude.mjs")}" %*\r\n`);

  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const deviceEnv = {
    PATH: [dirs.shims, path.dirname(process.execPath), `${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`, `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`].join(";"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: systemRoot,
    ComSpec: process.env.ComSpec ?? `${systemRoot}\\System32\\cmd.exe`,
    USERPROFILE: dirs.home,
    HOME: dirs.home,
    APPDATA: path.join(dirs.home, "AppData", "Roaming"),
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? path.join(dirs.home, "AppData", "Local"),
    TEMP: root,
    TMP: root,
    CLAUDE_CONFIG_DIR: dirs.claude,
    CODEX_HOME: dirs.codex,
    NEX_HERDR_CORE_PATH: herdrBinary,
  };
  mkdirSync(deviceEnv.APPDATA, { recursive: true });

  await step("isolation pre-flight", async () => {
    const where = (name) => {
      try { return execFileSync("where.exe", [name], { env: deviceEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/); } catch { return []; }
    };
    const claude = where("claude");
    // os.tmpdir() can be an 8.3 short path; compare real paths
    const same = (a, b) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
    assert(claude.length === 1 && same(claude[0], path.join(dirs.shims, "claude.cmd")),`claude on the device PATH is not only the stand-in: ${JSON.stringify(claude)}`);
    assert(where("codex").length === 0, "a codex executable is reachable from the device PATH");
    const version = execFileSync("cmd.exe", ["/d", "/s", "/c", `""${claude[0]}" --version"`], { env: deviceEnv, encoding: "utf8", windowsVerbatimArguments: true }).trim();
    assert(/Claude Code/.test(version), `stand-in --version: ${version}`);
    return `PATH resolves claude only to ${path.basename(claude[0])} (${version}); no codex`;
  }, { fatal: true });

  // ----- Core -----
  identity = await startFakeIdentity({ displayName: "演示账号" });
  cleanups.push(async () => { await identity.close?.(); return "fake identity stopped"; });
  const bootstrap = "synthetic-agent-smoke-bootstrap";
  const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
  core = await createPersonalApp({
    dir: path.join(root, "core"), key: randomBytes(32), token: bootstrap, ...(servePort ? { port: servePort, strictPort: true } : {}),
    uiDir: path.resolve("dist-personal/server/ui"), memoryRuntime: false, hostDevice: false,
    modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} },
    identity: { fixtureOrigin: identity.origin },
  });
  cleanups.push(async () => { await core.close(); return "fixture Core stopped"; });
  log(`fixture Core at ${core.origin}`);

  const api = async (route, data, token = ownerToken) => {
    const response = await fetch(`${core.origin}/api/${route}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.error ?? `HTTP ${response.status}`), { status: response.status, value });
    return value;
  };

  await step("fixture Core: sign in and pair the device", async () => {
    const boot = await fetch(`${core.origin}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: bootstrap }) });
    const cookie = boot.headers.get("set-cookie").split(";", 1)[0];
    const login = async (route, data) => {
      const response = await fetch(`${core.origin}/api/${route}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!response.ok) throw new Error("fixture login failed");
      return response.json();
    };
    const transaction = await login("auth/start", { account: OWNER_EMAIL, name: "Agent smoke" });
    ownerToken = (await login("auth/respond", { ...transaction, password: OWNER_PASSWORD })).token;
    const paired = await api("devices", { name: DEVICE_NAME });
    deviceId = paired.deviceId;
    core.store.run("UPDATE devices SET name=? WHERE id=?", DEVICE_NAME, deviceId);
    const unauthenticated = await fetch(`${core.origin}/api/cli-agents`);
    assert(unauthenticated.status === 401, `unauthenticated /api/cli-agents answered ${unauthenticated.status}`);
    // The device keeps its pairing token in this file for the child process.
    writeFileSync(path.join(root, "pair.json"), JSON.stringify({ origin: core.origin, token: paired.token }));
    return `device ${deviceId.slice(0, 8)}; /api/cli-agents is 401 without a session`;
  }, { fatal: true });

  // ----- the device: real DeviceNode + bridge in its own process -----
  await step("device process: bridge connects with real herdr-core", async () => {
    const entry = `
import { createClientNode } from ${JSON.stringify(path.join(repo, "server/personal-os/client-node.ts").split("\\").join("/"))};
import { HerdrCore } from ${JSON.stringify(path.join(repo, "server/personal-os/cli-agents-node/hc.ts").split("\\").join("/"))};
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const pair = JSON.parse(readFileSync(process.env.SMOKE_PAIR, "utf8"));
const client = createClientNode(process.env.SMOKE_DEVICE_DIR, randomBytes(32), () => undefined, undefined, {
  cliAgents: {
    binary: process.env.NEX_HERDR_CORE_PATH,
    claudeDirs: [process.env.CLAUDE_CONFIG_DIR],
    codexHomes: [process.env.CODEX_HOME],
    homedir: process.env.USERPROFILE,
    discovery: { liveMs: 500, historyMs: 1500, coalesceMs: 100 },
    rowWaitMs: 10000,
    coalesceMs: 50,
    hc: (scope) => {
      writeFileSync(process.env.SMOKE_SCOPE, JSON.stringify(scope));
      return new HerdrCore({ binary: scope.binary, session: scope.session, socket: scope.socket });
    },
    log: (level, message) => { if (level !== "debug") console.log("[bridge " + level + "] " + message); },
  },
});
client.node.configure({ origin: pair.origin, token: pair.token, root: "", exec: false, computer: false, cliAgents: true });
console.log("device started");
const stop = async () => { try { await client.close(); } finally { process.exit(0); } };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 60_000);
`;
    await build({
      stdin: { contents: entry, loader: "js", resolveDir: repo },
      outfile: path.join(dirs.bundle, "device.mjs"), bundle: true, platform: "node", target: "node22", format: "esm",
      external: ["pdfjs-dist/legacy/build/pdf.mjs"], logLevel: "error",
      banner: { js: "import { createRequire as nexRequire } from 'node:module'; const require = nexRequire(import.meta.url);" },
    });
    copyFileSync(path.join(repo, "server/personal-os/node-schema.sql"), path.join(dirs.bundle, "node-schema.sql"));
    let output = "";
    device = spawn(process.execPath, [path.join(dirs.bundle, "device.mjs")], {
      cwd: dirs.device, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...deviceEnv, SMOKE_PAIR: path.join(root, "pair.json"), SMOKE_DEVICE_DIR: path.join(dirs.device, "data"), SMOKE_SCOPE: scopeFile },
    });
    device.stdout.on("data", (data) => { output += data; });
    device.stderr.on("data", (data) => { output += data; });
    let exited = false;
    device.on("exit", () => { exited = true; });
    cleanups.push(async () => {
      if (device?.pid && !exited) {
        try { execFileSync("taskkill.exe", ["/PID", String(device.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
      }
      if (output.trim()) console.log("[device output]\n" + output.trim().split("\n").slice(-25).join("\n"));
      return "device process stopped";
    });
    const snapshot = await until(async () => {
      if (exited) throw new Error(`device exited early: ${output.slice(-1500)}`);
      const data = await api("cli-agents");
      const row = data.devices?.find((entry) => entry.id === deviceId);
      return row?.online && row.cliAgents?.terminal?.ready && data.sessions?.length >= 3 ? { row, data } : null;
    }, "device online with herdr-core ready and 3 sessions", 60_000, 500);
    const sessions = snapshot.data.sessions;
    assert(sessions.every((session) => !session.online === false), "a synthetic session is reported offline");
    return `engines ${JSON.stringify(snapshot.row.cliAgents.engines)}, ${sessions.length} synthetic sessions visible to Core`;
  }, { fatal: true });

  if (servePort) {
    log(`PREVIEW READY ${core.origin}  sign in as ${OWNER_EMAIL} with password ${JSON.stringify(OWNER_PASSWORD)}; Ctrl-C to stop`);
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); process.once("SIGBREAK", resolve); });
    throw new Served();
  }

  // ----- browser -----
  await step("browser: start and open Core", async () => {
    browser = spawn(browserPath, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dirs.profile}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--no-proxy-server", "--disable-gpu", "--hide-scrollbars", "about:blank",
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    browser.stdout.on("data", (data) => { browserLogs += data; });
    browser.stderr.on("data", (data) => { browserLogs += data; });
    // The launcher process may exit while the browser keeps running, so every browser
    // process that was started with this run's profile directory is stopped by command line.
    cleanups.push(async () => {
      if (browser?.pid) {
        try { execFileSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
      }
      const exe = path.basename(browserPath);
      const filter = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | Where-Object { $_.CommandLine -like '*${dirs.profile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      try { execFileSync("powershell.exe", ["-NoProfile", "-Command", filter], { stdio: "ignore", timeout: 30_000 }); } catch { /* none left */ }
      await pause(1000);
      return "browser stopped";
    });
    const portFile = path.join(dirs.profile, "DevToolsActivePort");
    await until(() => existsSync(portFile), `DevToolsActivePort (browser output: ${browserLogs.slice(-500)})`);
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const target = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((entry) => entry.type === "page");
    }, "a page target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    cleanups.push(async () => { try { ws.close(); } catch { /* ignore */ } return "devtools socket closed"; });
    let sequence = 0;
    const replies = new Map();
    ws.on("message", (raw) => {
      const event = JSON.parse(raw);
      if (event.method === "Runtime.exceptionThrown") pageErrors.push(event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
      if (event.method === "Runtime.consoleAPICalled" && event.params.type === "error") pageErrors.push("console.error: " + event.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 300));
      const pending = replies.get(event.id);
      if (pending) {
        replies.delete(event.id);
        if (event.error) pending.reject(new Error(`${event.error.message}`)); else pending.resolve(event.result);
      }
    });
    command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { replies.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
      replies.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
    evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Network.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // The page starts with the bootstrap session only: the login form must appear.
    await command("Network.setCookie", { name: "nex", value: bootstrap, url: core.origin, httpOnly: true, sameSite: "Strict" });
    await command("Page.navigate", { url: core.origin });
    await until(() => evaluate("!!document.querySelector('.login-form')"), "login form");
    return `${path.basename(browserPath)} ${browserVersion} headless, profile in the fixture directory`;
  }, { fatal: true });

  // ----- UI helpers -----
  const click = (selector) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing: '+${JSON.stringify(selector)});if(el.disabled)throw new Error('Disabled: '+${JSON.stringify(selector)});el.click();return true;})()`);
  const clickText = (scope, text) => evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(scope)});if(!root)throw new Error('Missing scope');const el=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!el)throw new Error('No button '+${JSON.stringify(text)});if(el.disabled)throw new Error('Disabled '+${JSON.stringify(text)});el.click();return true;})()`);
  const setValue = (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);
  const screenText = () => evaluate("document.querySelector('.cli-term .xterm-rows')?.innerText ?? ''");
  const typeKeys = async (value) => {
    for (const char of value) {
      if (char === "\r") {
        await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
        await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      } else {
        await command("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char, unmodifiedText: char });
        await command("Input.dispatchKeyEvent", { type: "keyUp", key: char });
      }
    }
  };
  const focusTerminal = () => evaluate("(()=>{const t=document.querySelector('.cli-term .xterm-helper-textarea');if(!t)throw new Error('terminal input missing');t.focus();return document.activeElement===t;})()");
  const rows = () => evaluate(`[...document.querySelectorAll('.cli-device')].map(d=>({device:d.querySelector('header strong')?.textContent,agents:[...d.querySelectorAll('.cli-agent')].map(a=>({name:a.querySelector('.cli-agent-name span')?.textContent,sessions:[...a.querySelectorAll('.cli-row')].map(r=>({title:r.querySelector('.cli-row-title')?.textContent,chip:r.querySelector('.cli-chip')?.textContent,folder:r.querySelector('.cli-row-folder')?.textContent,selected:r.classList.contains('is-selected')}))}))}))`);
  const rowByTitle = async (title) => {
    for (const device of await rows()) for (const agent of device.agents) for (const row of agent.sessions) if (row.title === title) return { ...row, agent: agent.name };
    return null;
  };
  const clickRow = (title) => evaluate(`(()=>{const el=[...document.querySelectorAll('.cli-row')].find(r=>r.querySelector('.cli-row-title')?.textContent===${JSON.stringify(title)});if(!el)throw new Error('No row '+${JSON.stringify(title)});el.querySelector('.cli-row-main').click();return true;})()`);
  const termStatus = () => text(".cli-term-status");
  const shot = async (name) => {
    await pause(400);
    mkdirSync(shotDir, { recursive: true });
    const file = path.join(shotDir, `${name}.png`);
    writeFileSync(file, Buffer.from((await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64"));
    const check = pngCheck(file);
    assert(check.colors >= 12 && check.dominant < 0.985, `screenshot ${name} looks blank: ${JSON.stringify(check)}`);
    return `${path.relative(repo, file)} ${check.width}x${check.height}, ${check.colors} sampled colours, dominant ${check.dominant}`;
  };
  const noOverflow = () => evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,termRight:document.querySelector('.cli-term-scale')?.getBoundingClientRect().right??0})");
  let startedTitle = "Start of the smoke session";
  const shots = [];

  // ----- 1. login, entry and list -----
  await step("browser: log in through the form", async () => {
    await evaluate(`document.querySelector('[name=email]').value=${JSON.stringify(OWNER_EMAIL)};document.querySelector('[name=password]').value=${JSON.stringify(OWNER_PASSWORD)};document.querySelector('.login-form').requestSubmit();true`);
    await until(() => evaluate("!!document.querySelector('.contact-item')"), "workspace after login");
    assert(!(await evaluate("!!document.querySelector('.login-form')")), "login form still shown");
    return "signed in as the fixture owner";
  }, { fatal: true });

  await step("NexAgent switch and grouped session list", async () => {
    await click(".mode-switcher-button");
    await until(() => evaluate("!!document.querySelector('.mode-menu')"), "mode menu");
    await evaluate("document.querySelectorAll('.mode-menu [role=menuitemradio]')[1].click(),true");
    await until(() => evaluate("!!document.querySelector('.cli-app') && !!document.querySelector('.cli-row')"), "Agent session list", 30_000);
    await until(async () => (await evaluate("document.querySelectorAll('.cli-row').length")) >= 3, "three synthetic rows", 30_000);
    const groups = await rows();
    assert(groups.length === 1 && groups[0].device === DEVICE_NAME, `device groups: ${JSON.stringify(groups.map((g) => g.device))}`);
    const names = groups[0].agents.map((agent) => agent.name);
    assert(JSON.stringify(names) === JSON.stringify(["Claude Code", "Codex"]), `agents: ${JSON.stringify(names)}`);
    const claude = groups[0].agents[0].sessions.map((row) => `${row.title}@${row.folder}`).sort();
    assert(JSON.stringify(claude) === JSON.stringify(["Fix the flaky test@alpha", "重构解析器@alpha"].sort()), `Claude Code rows: ${JSON.stringify(claude)}`);
    const codex = groups[0].agents[1].sessions;
    assert(codex.length === 1 && codex[0].title === "整理发布说明" && codex[0].folder === "beta", `Codex rows: ${JSON.stringify(codex)}`);
    assert(groups[0].agents.flatMap((agent) => agent.sessions).every((row) => row.chip === "已停止"), "synthetic history rows are not all shown as stopped");
    return "device 演示电脑 > Claude Code (2 rows in alpha) + Codex (1 row in beta), all 已停止";
  });

  // ----- 2. a new session in a nex_bot terminal -----
  let started = false;
  await step("start a new Claude session", async () => {
    await click("button[aria-label='新建会话']");
    await until(() => evaluate("!!document.querySelector('[role=dialog][aria-label=\"新建 Agent 会话\"]')"), "new session dialog");
    const hint = await text("[role=dialog] .cli-field-hint[role=status]");
    assert(!hint, `new session dialog is blocked: ${hint}`);
    const engines = await evaluate("[...document.querySelectorAll('[role=dialog] .cli-segment button')].map(b=>b.textContent.trim())");
    assert(engines.includes("Claude"), `engines: ${JSON.stringify(engines)}`);
    await setValue("[role=dialog] .cli-field input", path.join(dirs.work, "gamma"));
    await until(() => evaluate("!document.querySelector('[role=dialog] button[type=submit]').disabled"), "start enabled");
    await click("[role=dialog] button[type=submit]");
    await until(() => evaluate("!document.querySelector('[role=dialog]')"), "dialog closes after start", 30_000);
    await until(async () => (await rowByTitle(startedTitle))?.folder === "gamma", "the new session under folder gamma", 30_000);
    const row = await rowByTitle(startedTitle);
    assert(row.chip === "空闲" && row.agent === "Claude Code", `new row: ${JSON.stringify(row)}`);
    await until(() => evaluate("!!document.querySelector('.cli-pane')"), "pane for the new session");
    started = true;
    return `row "${startedTitle}" in gamma, chip ${row.chip}`;
  });

  // ----- 3. terminal: observe, control, type -----
  await step("terminal: observe shows the prompt", async () => {
    assert(started, "no started session");
    await until(() => evaluate("!!document.querySelector('.cli-term')"), "terminal view");
    await until(async () => (await termStatus()) === "只看", "observing status", 30_000);
    await until(async () => (await screenText()).includes("fake>"), "prompt of the stand-in program", 30_000);
    const tabs = await evaluate("[...document.querySelectorAll('.cli-tabs [role=tab]')].map(t=>t.textContent+':'+t.getAttribute('aria-selected'))");
    assert(JSON.stringify(tabs) === JSON.stringify(["终端:true", "对话:false"]), `tabs: ${JSON.stringify(tabs)}`);
    return "status 只看, screen shows 'fake>'";
  });

  await step("terminal: 操作, type a line, see the echo", async () => {
    await clickText(".cli-term-modes", "操作");
    await until(async () => (await termStatus()) === "操作中", "controlling status", 30_000);
    await focusTerminal();
    await typeKeys("hello agent\r");
    await until(async () => (await screenText()).includes("you said: hello agent"), "echo of the typed line", 20_000);
    return "typed 'hello agent', screen shows 'you said: hello agent'";
  });

  await step("screenshot: terminal at 1440", async () => {
    const detail = await shot("desktop-1440-terminal");
    shots.push("desktop-1440-terminal.png");
    return detail;
  });

  // ----- 4. transcript view and composer -----
  await step("transcript: shows the session and the line typed in the terminal", async () => {
    await clickText(".cli-tabs", "对话");
    await until(() => evaluate("!!document.querySelector('[data-testid=cli-transcript]')"), "transcript view");
    await until(async () => (await evaluate("document.querySelector('[data-testid=cli-transcript]').innerText")).includes("you said: hello agent"), "assistant reply of the typed line in the transcript", 30_000);
    const users = await evaluate("[...document.querySelectorAll('[data-testid=cli-user]')].map(e=>e.innerText.trim())");
    assert(users.includes("Start of the smoke session") && users.includes("hello agent"), `user messages: ${JSON.stringify(users)}`);
    return `user messages ${JSON.stringify(users)}`;
  });

  await step("composer: send a message to the running session", async () => {
    await until(() => evaluate("!!document.querySelector('[data-testid=cli-composer] textarea')"), "composer");
    await setValue("[data-testid=cli-composer] textarea", "from the composer");
    await until(() => evaluate("!document.querySelector('[data-testid=cli-composer] button[type=submit]').disabled"), "send enabled");
    await click("[data-testid=cli-composer] button[type=submit]");
    await until(async () => (await evaluate("document.querySelector('[data-testid=cli-transcript]').innerText")).includes("you said: from the composer"), "the reply to the composed message in the transcript", 30_000);
    const users = await evaluate("[...document.querySelectorAll('[data-testid=cli-user]')].map(e=>e.innerText.trim())");
    assert(users.includes("from the composer"), `user messages: ${JSON.stringify(users)}`);
    assert(await evaluate("document.querySelector('[data-testid=cli-composer] textarea').value===''"), "composer was not cleared after sending");
    assert(!(await evaluate("!!document.querySelector('.cli-composer-error')")), "composer shows an error after a good send");
    return "message sent, composer cleared, user and assistant bubbles appeared";
  });

  // ----- 5. interrupt -----
  await step("interrupt a running session", async () => {
    await setValue("[data-testid=cli-composer] textarea", "work on the long task");
    await until(() => evaluate("!document.querySelector('[data-testid=cli-composer] button[type=submit]').disabled"), "send enabled");
    await click("[data-testid=cli-composer] button[type=submit]");
    await until(async () => (await rowByTitle(startedTitle))?.chip === "运行中", "row shows 运行中", 30_000);
    await until(() => evaluate("!!document.querySelector('[data-testid=cli-composer] button[aria-label=\"中断\"]')"), "中断 button while running", 20_000);
    await click("[data-testid=cli-composer] button[aria-label='中断']");
    await until(async () => (await rowByTitle(startedTitle))?.chip === "空闲", "row returns to 空闲 after the interrupt", 30_000);
    await until(() => evaluate("!document.querySelector('[data-testid=cli-composer] button[aria-label=\"中断\"]')"), "中断 button hides again", 20_000);
    // the interrupt really reached the program: its screen says so
    await clickText(".cli-tabs", "终端");
    await until(async () => (await screenText()).includes("[interrupted]"), "[interrupted] on the program's screen", 30_000);
    return "运行中 -> 中断 -> 空闲, program printed [interrupted]";
  });

  // ----- 6. draft refusal -----
  await step("composer refuses while a person has an unsent draft", async () => {
    await until(async () => (await termStatus()) === "操作中" || (await termStatus()) === "只看", "terminal reopened", 30_000);
    if ((await termStatus()) !== "操作中") await clickText(".cli-term-modes", "操作");
    await until(async () => (await termStatus()) === "操作中", "controlling status", 30_000);
    await focusTerminal();
    await typeKeys("draftx");
    await until(async () => (await screenText()).includes("draftx"), "unsent draft on screen", 20_000);
    await setValue("[data-testid=cli-composer] textarea", "must be refused");
    await until(() => evaluate("!document.querySelector('[data-testid=cli-composer] button[type=submit]').disabled"), "send enabled");
    await click("[data-testid=cli-composer] button[type=submit]");
    const message = await until(() => evaluate("document.querySelector('.cli-composer-error')?.textContent||''"), "a refusal in the composer", 40_000);
    const screen = await screenText();
    assert(!screen.includes("you said: must be refused") && !screen.includes("draftxmust"), "the refused text reached the terminal");
    // the draft is left alone; clear it so later steps are clean
    await focusTerminal();
    await typeKeys("\r");
    await until(async () => (await screenText()).includes("you said: draftx"), "draft submitted by the person", 20_000);
    await pause(300);
    if (!message.includes("正在输入")) {
      findings.push({ id: "draft-refusal-text", text: `a refused send shows "${message}" instead of saying a person is typing` });
      throw new Error(`refusal is shown as "${message}"; the user should be told someone is typing on the computer ("电脑上有人正在输入")`);
    }
    return `refused with "${message}", nothing was sent`;
  });

  // ----- 7. continue a stopped session -----
  await step("continue a stopped Claude session", async () => {
    await clickRow("Fix the flaky test");
    await until(async () => (await rowByTitle("Fix the flaky test"))?.selected === true, "stopped row selected");
    const composer = await evaluate("document.querySelector('[data-testid=cli-composer] .primary')?.textContent?.trim()");
    assert(composer === "继续", `stopped session composer offers "${composer}", expected 继续`);
    await click("[data-testid=cli-composer] .primary");
    await until(async () => { const row = await rowByTitle("Fix the flaky test"); return row && row.chip !== "已停止"; }, "resumed row leaves 已停止", 40_000);
    await until(() => evaluate("!!document.querySelector('.cli-tabs')"), "terminal and transcript tabs after continuing", 30_000);
    const diag = async () => JSON.stringify({ tabs: await evaluate("[...document.querySelectorAll('.cli-tabs [role=tab]')].map(t=>t.textContent+':'+t.getAttribute('aria-selected'))"), status: await termStatus(), screen: (await screenText()).slice(0, 300), pane: (await text(".cli-pane"))?.slice(0, 300) });
    try {
      // the page keeps the tab chosen for the previous session; look at the terminal explicitly
      await clickText(".cli-tabs", "终端");
      await until(async () => (await screenText()).includes("fake>"), "prompt of the resumed program", 30_000);
    } catch (error) {
      throw new Error(error.message + " " + await diag());
    }
    const row = await rowByTitle("Fix the flaky test");
    return `resumed in a nex_bot terminal, chip ${row.chip}`;
  });

  // ----- 8. screenshots at 1440 and 390 -----
  await step("screenshots at 1440 (list + transcript)", async () => {
    await clickRow(startedTitle);
    await until(() => evaluate("!!document.querySelector('.cli-tabs')"), "tabs");
    await clickText(".cli-tabs", "对话");
    await until(async () => (await evaluate("document.querySelector('[data-testid=cli-transcript]')?.innerText||''")).includes("from the composer"), "transcript content");
    const geometry = await noOverflow();
    assert(geometry.scroll <= geometry.width, `horizontal overflow at 1440: ${JSON.stringify(geometry)}`);
    const detail = await shot("desktop-1440-list-transcript");
    shots.push("desktop-1440-list-transcript.png");
    return detail;
  });

  await step("screenshots at 390 (list, then session pane)", async () => {
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await pause(600);
    await evaluate("(()=>{const back=document.querySelector('.cli-back');if(back&&back.getClientRects().length)back.click();return true;})()");
    await until(() => evaluate("document.querySelector('.cli-app')?.dataset.mobile==='list'"), "mobile list view", 15_000);
    let geometry = await noOverflow();
    assert(geometry.scroll <= geometry.width, `horizontal overflow in the 390 list: ${JSON.stringify(geometry)}`);
    const listShot = await shot("mobile-390-list");
    shots.push("mobile-390-list.png");
    await clickRow("Fix the flaky test");
    await until(() => evaluate("document.querySelector('.cli-app')?.dataset.mobile==='pane'"), "mobile pane view", 15_000);
    await clickText(".cli-tabs", "终端");
    await until(async () => (await screenText()).includes("fake>"), "terminal in the mobile pane", 30_000);
    await pause(500);
    geometry = await noOverflow();
    assert(geometry.scroll <= geometry.width, `horizontal overflow in the 390 pane: ${JSON.stringify(geometry)}`);
    assert(geometry.termRight <= geometry.width + 1, `the terminal is wider than the 390 viewport: ${JSON.stringify(geometry)}`);
    const paneShot = await shot("mobile-390-terminal");
    shots.push("mobile-390-terminal.png");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    return `${listShot}; ${paneShot}`;
  });

  await step("no uncaught page errors", async () => {
    const real = pageErrors.filter((entry) => !/ResizeObserver loop/.test(entry));
    assert(real.length === 0, `page errors: ${JSON.stringify(real.slice(0, 5))}`);
    return "no uncaught exceptions or console.error output";
  });
} catch (error) {
  if (!(error instanceof Served)) log(`ABORTED: ${error.message}`);
} finally {
  // ----- cleanup, in reverse order; each part independent -----
  log("cleaning up");
  const notes = [];
  for (const cleanup of [...cleanups].reverse()) {
    try {
      const note = await cleanup();
      if (note) notes.push(note);
    } catch (error) {
      notes.push(`cleanup problem: ${error.message}`);
    }
  }
  const classicAfter = herdrProcesses();
  notes.push(`classic herdr.exe pids before ${JSON.stringify(classicBefore)} / after ${JSON.stringify(classicAfter)}: ${JSON.stringify(classicBefore) === JSON.stringify(classicAfter) ? "unchanged" : "CHANGED"}`);
  for (const note of notes) log(note);
  const failed = results.filter((entry) => !entry.ok);
  console.log("\n=== Agent mode smoke ===");
  for (const entry of results) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name} (${entry.ms} ms)${entry.detail ? `\n      ${entry.detail}` : ""}`);
  if (findings.length) console.log(`\nFindings:\n${findings.map((finding) => `  - ${finding.id}: ${finding.text}`).join("\n")}`);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? `, ${failed.length} failed` : ""}.`);
  process.exitCode = failed.length || results.length === 0 ? 1 : 0;
}
