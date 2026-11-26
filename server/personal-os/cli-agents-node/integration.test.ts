// Agent mode end to end: a disposable Core, a real DeviceGateway socket, a real
// DeviceNode (as the desktop executor builds it) with the cli-agent bridge, and a
// simulated browser on the Core's stream socket. herdr-core is a fake unless
// NEX_HC_REAL=1 is set, which runs the packaged binary in an isolated session
// with scripts/testing/fake-tui.mjs as the program. No real claude or codex CLI
// runs and no home directory is read.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalApp } from "../index.ts";
import { createClientNode } from "../client-node.ts";
import { TERM_INPUT, TERM_OUTPUT, decodeTermFrame, encodeTermFrame } from "../../../shared/cli-agent-frames.ts";
import { HerdrCore, locateHerdrCore } from "./hc.ts";
import { FakeHc } from "./fake-hc.ts";
import type { HcScope } from "./bridge.ts";
import type { CommandRunner } from "./liveness.ts";
import { agyProxyEnvironment } from "./agy-native.ts";

const OWNER = "synthetic-cli-integration-owner";
const LSTART = "Sun Nov 15 09:00:00 2026";
const run: CommandRunner = async (_file, args) => ({ code: 0, stdout: args[args.length - 1].split(",").map((p) => `${p} ${LSTART}`).join("\n") });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await wait(15);
  }
}

function tempDir(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith(prefix)) throw Error("Unsafe cleanup");
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt > 20) throw error;
        // a terminal that was just stopped may still hold its folder for a moment
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
  });
  return root;
}

interface Browser {
  ws: WebSocket;
  msgs: Array<Record<string, any>>;
  bins: Uint8Array[];
  send(message: unknown): void;
  find(type: string, pred?: (m: Record<string, any>) => boolean): Promise<Record<string, any>>;
  output(sid: number): string;
}

async function connectBrowser(origin: string): Promise<Browser> {
  const ws = new WebSocket(origin.replace("http:", "ws:") + "/api/cli-agents/stream", { headers: { Cookie: "nex=" + OWNER, Origin: origin } });
  cleanups.push(() => void ws.terminate());
  const browser: Browser = {
    ws,
    msgs: [],
    bins: [],
    send: (message) => ws.send(JSON.stringify(message)),
    find: (type, pred = () => true) => until(() => browser.msgs.find((m) => m.type === type && pred(m)), type, 15_000),
    output: (sid) =>
      browser.bins
        .map((frame) => decodeTermFrame(frame))
        .filter((frame) => frame && frame.type === TERM_OUTPUT && frame.sid === sid)
        .map((frame) => Buffer.from(frame!.payload).toString("utf8"))
        .join(""),
  };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) browser.bins.push(new Uint8Array(raw as Buffer));
    else browser.msgs.push(JSON.parse(raw.toString()));
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
    ws.on("unexpected-response", (_r, res) => reject(new Error("refused " + res.statusCode)));
  });
  return browser;
}

interface Stack {
  origin: string;
  call: (route: string, data?: unknown) => Promise<{ status: number; data: Record<string, any> }>;
  deviceId: string;
  workDir: string;
  claudeDir: string;
  dataDir: string;
  closeNode: () => Promise<void>;
  listed: (count: number) => Promise<void>;
  hub: { list(): { sessions: Array<Record<string, any>> } };
}

async function stack(bridge: Record<string, unknown>, setup: (dirs: { claudeDir: string; workDir: string; root: string }) => void = () => undefined, root = tempDir("nex-cli-int-")): Promise<Stack> {
  const claudeDir = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const workDir = path.join(root, "work");
  const dataDir = path.join(root, "node");
  for (const dir of [claudeDir, codexHome, workDir]) mkdirSync(dir, { recursive: true });
  setup({ claudeDir, workDir, root });
  const app = await createPersonalApp({ dir: path.join(root, "core"), key: randomBytes(32), token: OWNER, identity: false, memoryRuntime: false, hostDevice: false, cliAgents: { graceMs: 0 } });
  cleanups.push(() => app.close());
  const call = async (route: string, data?: unknown) => {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  };
  const node = createClientNode(dataDir, randomBytes(32), () => undefined, undefined, {
    cliAgents: {
      claudeDirs: [claudeDir],
      codexHomes: [codexHome],
      discovery: { claudeLive: { isAlive: () => true, start: { platform: "linux", run } }, codex: { writer: () => "no" }, coalesceMs: 0, liveMs: 100, historyMs: 200 },
      cliVersion: async () => "9.9.9",
      homedir: path.join(root, "home"),
      launcher: async () => undefined,
      hasWindowsTerminal: false,
      rowWaitMs: 4000,
      coalesceMs: 5,
      // the Claude plugin is off unless a test turns it on
      pluginDir: null,
      ...bridge,
    },
  });
  let closed = false;
  const closeNode = async () => { if (!closed) { closed = true; await node.close(); } };
  cleanups.push(closeNode);
  const pair = app.gateway.pair("Integration device");
  node.node.configure({ origin: app.origin, token: pair.token, root: "", exec: false });
  await until(() => node.node.status === "已连接", "device connected", 15_000);
  return {
    origin: app.origin,
    call,
    deviceId: pair.deviceId,
    workDir,
    claudeDir,
    dataDir,
    closeNode,
    hub: app.cliHub as unknown as Stack["hub"],
    listed: async (count) => void (await until(() => app.cliHub.list().sessions.length >= count, `${count} listed sessions`, 15_000)),
  };
}

function claudeTranscript(claudeDir: string, id: string, text: string, cwd: string): void {
  const folder = path.join(claudeDir, "projects", "proj");
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "user", uuid: `u-${id.slice(-4)}`, timestamp: new Date().toISOString(), cwd, message: { role: "user", content: text } }) + "\n");
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
}

it("lets Windows AGY use a local system proxy while preserving an explicit proxy", async () => {
  const windows: CommandRunner = async () => ({ code: 0, stdout: "http=127.0.0.1:1234;https=127.0.0.1:2345" });
  expect(await agyProxyEnvironment("win32", {}, windows)).toEqual({ HTTP_PROXY: "http://127.0.0.1:1234", HTTPS_PROXY: "http://127.0.0.1:2345" });
  expect(await agyProxyEnvironment("win32", { https_proxy: "http://example.invalid:7890" }, windows)).toEqual({});
  expect(await agyProxyEnvironment("darwin", {}, windows)).toEqual({});
});

it("runs AGY through ACP without herdr and continues the native conversation once", async () => {
  const root = tempDir("nex-agy-int-");
  const agyDir = path.join(root, "agy-home");
  const fixture = path.join(root, "fake-agy.mjs");
  copyFileSync(fileURLToPath(new URL("./testdata/agy-acp-fixture.mjs", import.meta.url)), fixture);
  chmodSync(fixture, 0o755);
  const executable = process.platform === "win32" ? path.join(root, "agy.cmd") : fixture;
  if (process.platform === "win32") writeFileSync(executable, '@node "%~dp0fake-agy.mjs" %*\r\n');
  const nativeId = "c75d00aa-0000-4000-8000-000000000001";
  const transcript = path.join(agyDir, "brain", nativeId, ".system_generated", "logs", "transcript_full.jsonl");
  let writerOpen = true;
  const s = await stack({
    agyDir, binary: null,
    resolveCli: async (engine: string) => engine === "agy" ? executable : null,
    agyWriters: async () => ({ sessions: new Set(writerOpen ? [nativeId] : []), unknown: false }),
  }, ({ workDir }) => {
    mkdirSync(path.dirname(transcript), { recursive: true });
    const at = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(transcript, JSON.stringify({ type: "USER_INPUT", step_index: 0, created_at: at, content: "native context" }) + "\n");
    mkdirSync(path.join(agyDir, "cache"), { recursive: true });
    writeFileSync(path.join(agyDir, "cache", "conversation_metadata.json"), JSON.stringify({
      conversations: { [nativeId]: { summary: { Title: "Original AGY", UpdatedAt: at, WorkspaceURIs: [pathToFileURL(workDir).href] } } },
    }));
  }, root);
  await s.listed(1);
  const key = `${s.deviceId}:agy:${nativeId}`;
  expect(s.hub.list().sessions).toContainEqual(expect.objectContaining({ key, state: "idle", liveIn: "terminal" }));
  const refused = await s.call("cli-agents/continue", { key });
  expect(refused.data.code).toBe("open_elsewhere");

  const models = await s.call(`cli-agents/models?deviceId=${s.deviceId}&engine=agy`);
  expect(models.data.models).toEqual([{ id: "gemini-fixture", label: "Gemini Fixture", efforts: ["low", "high"] }]);

  writerOpen = false;
  const continued = await s.call("cli-agents/continue", { key });
  expect(continued).toEqual({ status: 200, data: { key } });
  const payload = { key, text: "continue in NexAgent", delivery: "send", clientMessageId: "agy-message", requestId: "agy-request" };
  const delivered = await s.call("cli-agents/send", payload);
  expect(delivered).toMatchObject({ status: 200, data: { status: "sent" } });
  const duplicate = await s.call("cli-agents/send", payload);
  expect(duplicate.data.messageId).toBe(delivered.data.messageId);
  await until(() => readFileSync(transcript, "utf8").includes("context native context"), "the native export");
  expect(readFileSync(transcript, "utf8").match(/continue in NexAgent/g)).toHaveLength(1);
  const history = await s.call(`cli-agents/items?key=${encodeURIComponent(key)}`);
  expect(history.data.items.filter((item: { kind: string }) => item.kind === "user").map((item: { text: string }) => item.text))
    .toEqual(["native context", "continue in NexAgent"]);
  expect(history.data.items.filter((item: { kind: string }) => item.kind === "assistant")).toMatchObject([{ text: "context native context" }]);

  const created = await s.call("cli-agents/start", { deviceId: s.deviceId, engine: "agy", cwd: s.workDir, effort: "low", permissions: "edits" });
  expect(created).toMatchObject({ status: 200, data: { key: `${s.deviceId}:agy:c75d00aa-0000-4000-8000-000000000002` } });
  // "auto-accept edits" is Antigravity's own `auto_edit` mode
  expect(readFileSync(path.join(agyDir, "modes.log"), "utf8").trim().split(/\r?\n/)).toEqual(["auto_edit"]);
  const freshKey = created.data.key as string;
  const sent = await s.call("cli-agents/send", { key: freshKey, text: "request approval" });
  expect(sent.status).toBe(200);
  let approval: { id: string; kind: string; summary: string } | undefined;
  for (const end = Date.now() + 8000; !approval && Date.now() < end; await wait(25)) {
    approval = (await s.call(`cli-agents/requests?key=${encodeURIComponent(freshKey)}`)).data.requests?.[0];
  }
  expect(approval).toMatchObject({ kind: "permission", summary: "Read fixture.txt" });
  expect((await s.call("cli-agents/answer", { id: approval!.id, decision: "allow" })).status).toBe(200);
  await until(() => s.hub.list().sessions.find((row) => row.key === freshKey)?.state === "idle", "the approved turn to end");
  const after = await s.call(`cli-agents/items?key=${encodeURIComponent(freshKey)}`);
  expect(after.data.items).toContainEqual(expect.objectContaining({ kind: "assistant", text: "approved fixture" }));
}, 40_000);

describe("Agent mode through Core, a real node and a fake herdr-core", () => {
  it("lists sessions, starts one, streams its terminal both ways and keeps it alive when the node pauses", async () => {
    const hc = new FakeHc();
    hc.onRun = (terminal) => {
      const index = terminal.argv.indexOf("--session-id");
      if (index >= 0) claudeTranscript(s.claudeDir, terminal.argv[index + 1], "new session", terminal.cwd);
    };
    const existing = "00000000-0000-4000-8000-000000000001";
    const s = await stack(
      { hc, binary: path.resolve("C:\\fake\\herdr-core.exe"), resolveCli: async (engine: string) => `/fake/bin/${engine}` },
      ({ claudeDir, workDir }) => claudeTranscript(claudeDir, existing, "an old conversation", workDir),
    );

    // The list holds the session found on disk.
    await s.listed(1);
    const list = await s.call("cli-agents");
    expect(list.status).toBe(200);
    expect(list.data.devices.map((d: any) => d.id)).toContain(s.deviceId);
    expect(list.data.sessions).toHaveLength(1);
    expect(list.data.sessions[0]).toMatchObject({ key: `${s.deviceId}:claude:${existing}`, engine: "claude" });

    // Start creates a terminal in herdr-core with the Agent mode labels.
    const started = await s.call("cli-agents/start", { deviceId: s.deviceId, engine: "claude", cwd: s.workDir });
    expect(started.status).toBe(200);
    expect(started.data.key).toMatch(new RegExp(`^${s.deviceId}:claude:`));
    expect(hc.runs).toHaveLength(1);
    expect(hc.last().labels).toMatchObject({ nexbot: "1", "nexbot.engine": "claude" });
    expect(hc.last().argv.slice(1, 2)).toEqual(["--session-id"]);

    // A browser opens the terminal: output flows to it, input flows back.
    const browser = await connectBrowser(s.origin);
    browser.send({ type: "term.open", req: "r1", key: started.data.key, cols: 100, rows: 30, observe: false });
    const opened = await browser.find("term.opened", (m) => m.req === "r1");
    expect(opened).toMatchObject({ observe: false });
    const stream = await until(() => hc.streamsOf(hc.last().address)[0], "terminal attach");
    stream.push("fake> ");
    await until(() => browser.output(opened.sid).includes("fake> "), "terminal output in the browser");
    browser.ws.send(encodeTermFrame(TERM_INPUT, opened.sid, Buffer.from("hello\r")), { binary: true });
    await until(() => stream.text() === "hello\r", "input at herdr-core");

    // A person typing at the computer blocks the web send instead of mixing text.
    hc.drafts.add(hc.last().address);
    const refused = await s.call("cli-agents/send", { key: started.data.key, text: "from the web" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.data.code).toBe("busy");
    expect(hc.last().sent).toHaveLength(0);
    hc.drafts.clear();

    // Pausing the node (the same as closing it) detaches and leaves the terminal running.
    const address = hc.last().address;
    await s.closeNode();
    expect(hc.closed).toBe(true);
    expect(hc.terminals.get(address)!.state).toBe("live");
    await browser.find("term.closed", (m) => m.sid === opened.sid);
  }, 60_000);

  it.each(["permission", "question"])("round trips a Claude %s through Core to the real hook script", async (mode) => {
    const hc = new FakeHc();
    let s: Stack;
    hc.onRun = (terminal) => {
      const index = terminal.argv.indexOf("--session-id");
      if (index >= 0) claudeTranscript(s.claudeDir, terminal.argv[index + 1], "new session", terminal.cwd);
    };
    s = await stack({
      hc,
      binary: path.resolve("C:\\fake\\herdr-core.exe"),
      resolveCli: async (engine: string) => `/fake/bin/${engine}`,
      pluginDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin"),
      hookNode: process.execPath,
      hookSocketDir: tempDir("nex-hook-"),
    });
    const started = await s.call("cli-agents/start", { deviceId: s.deviceId, engine: "claude", cwd: s.workDir });
    expect(started.status).toBe(200);
    const terminal = hc.last();
    expect(terminal.argv).toContain("--plugin-dir");

    const question = "是否批准演示操作？";
    const questions = [{ question, header: "审批测试", multiSelect: false, options: [{ label: "批准", description: "继续" }, { label: "拒绝", description: "停止" }] }];
    const hook = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin", "hooks", "hook.mjs"), mode], {
      env: { PATH: process.env.PATH, NEXBOT_HOOK_PIPE: terminal.env.NEXBOT_HOOK_PIPE, NEXBOT_HOOK_TOKEN: terminal.env.NEXBOT_HOOK_TOKEN },
      stdio: ["pipe", "pipe", "ignore"],
    });
    cleanups.push(() => void hook.kill());
    let stdout = "";
    hook.stdout.on("data", (chunk) => (stdout += chunk));
    const exited = new Promise<number | null>((resolve) => hook.on("close", resolve));
    const isQuestion = mode === "question";
    hook.stdin.end(JSON.stringify({
      hook_event_name: isQuestion ? "PreToolUse" : "PermissionRequest", session_id: "s", tool_use_id: "toolu_1",
      tool_name: isQuestion ? "AskUserQuestion" : "Bash", tool_input: isQuestion ? { questions } : { command: "npm test" },
    }));

    // The card reaches Core and shows in the list of open requests.
    let request: Record<string, any> | undefined;
    for (const end = Date.now() + 15_000; !request && Date.now() < end; await wait(50)) {
      const listed = await s.call(`cli-agents/requests?key=${encodeURIComponent(started.data.key)}`);
      request = listed.data.requests?.[0];
    }
    expect(request).toMatchObject(isQuestion
      ? { tool: "AskUserQuestion", summary: question, kind: "question", questions: [{ question, options: questions[0].options }] }
      : { tool: "Bash", summary: "npm test", kind: "permission" });

    const answers = { [question]: "拒绝" };
    const answered = await s.call("cli-agents/answer", { id: request!.id, decision: "allow", ...(isQuestion ? { answers } : {}) });
    expect(answered.status).toBe(200);
    expect(await exited).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput).toEqual(isQuestion
      ? { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { questions, answers } }
      : { hookEventName: "PermissionRequest", decision: { behavior: "allow" } });

    // A second answer for the same request is refused: the hook has gone.
    const late = await s.call("cli-agents/answer", { id: request!.id, decision: "allow" });
    expect(late.status).toBeGreaterThanOrEqual(400);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The packaged herdr-core, opt in: NEX_HC_REAL=1

const realBinary = locateHerdrCore();
const real = process.env.NEX_HC_REAL === "1" && process.platform === "win32" && realBinary !== null;

describe.runIf(real)("Agent mode with the real herdr-core (NEX_HC_REAL=1)", () => {
  it("starts a program in a ConPTY, relays its terminal and keeps it alive after detaching", async () => {
    const tui = path.resolve("scripts/testing/fake-tui.mjs");
    expect(existsSync(tui)).toBe(true);
    // Registered first, so it is removed last: after the terminal that runs in it has been stopped.
    const root = tempDir("nex-cli-int-");
    const shims = tempDir("nex-cli-shim-");
    const scopes: HcScope[] = [];
    const clients: HerdrCore[] = [];
    let claudeProjects = "";
    // The stand-in CLI: records a Claude-style transcript for the id it is given, then runs fake-tui.
    const wrapper = path.join(shims, "fake-claude.mjs");
    const shim = path.join(shims, "fake-claude.cmd");
    const writeShim = (claudeDir: string) => {
      claudeProjects = path.join(claudeDir, "projects", "proj");
      writeFileSync(
        wrapper,
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import path from "node:path";',
          'const id = process.argv[process.argv.indexOf("--session-id") + 1];',
          `const folder = ${JSON.stringify(claudeProjects)};`,
          "mkdirSync(folder, { recursive: true });",
          'writeFileSync(path.join(folder, id + ".jsonl"), JSON.stringify({ type: "user", uuid: "u-real", timestamp: new Date().toISOString(), cwd: process.cwd(), message: { role: "user", content: "real herdr-core session" } }) + "\\n");',
          `await import(${JSON.stringify(pathToFileURL(tui).href)});`,
          "",
        ].join("\n"),
      );
      writeFileSync(shim, `@"${process.execPath}" "${wrapper}" %*\r\n`);
    };
    let session = "";
    let socket = "";
    cleanups.push(async () => {
      // Stop the programs, the isolated core and its terminal holder, and delete its
      // state. Only this test's own session is touched; never any other herdr.
      if (!session || !/^nexbot-[0-9a-f]{8}$/.test(session)) return;
      try {
        const probe = new HerdrCore({ binary: realBinary!, session, socket });
        clients.push(probe);
        await probe.ensureStarted();
        for (const terminal of (await probe.list({ labels: { nexbot: "1" } })).terminals) {
          if (terminal.state === "live" && terminal.pid) execFileSync("taskkill.exe", ["/PID", String(terminal.pid), "/T", "/F"], { stdio: "ignore" });
        }
      } catch {
        // the core may already be gone
      }
      for (const client of clients) client.close();
      try {
        execFileSync(realBinary!, ["server", "stop"], { env: { ...process.env, HC_SESSION: session, HC_SOCKET: socket }, stdio: "ignore", timeout: 20_000 });
      } catch {
        // already stopped
      }
      try {
        const pipe = socket.split("\\").pop();
        const filter = "Get-CimInstance Win32_Process -Filter \"Name='herdr-core.exe'\" | Where-Object { $_.CommandLine -like '*" + pipe + ".holder*' -or $_.CommandLine -like '*" + pipe + " *' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
        execFileSync("powershell.exe", ["-NoProfile", "-Command", filter], { stdio: "ignore", timeout: 30_000 });
      } catch {
        // none left
      }
      await wait(500);
      if (process.env.LOCALAPPDATA) rmSync(path.join(process.env.LOCALAPPDATA, "herdr-core", session), { recursive: true, force: true });
    });
    const s = await stack(
      {
        binary: realBinary,
        resolveCli: async () => shim,
        hc: (scope: HcScope) => {
          scopes.push(scope);
          session = scope.session;
          socket = scope.socket;
          const client = new HerdrCore({ binary: scope.binary as string, session: scope.session, socket: scope.socket });
          clients.push(client);
          return client as never;
        },
      },
      ({ claudeDir }) => writeShim(claudeDir),
      root,
    );
    expect(claudeProjects).not.toBe("");

    const started = await s.call("cli-agents/start", { deviceId: s.deviceId, engine: "claude", cwd: s.workDir });
    expect(started.status).toBe(200);
    expect(scopes).toHaveLength(1);
    expect(session).toMatch(/^nexbot-[0-9a-f]{8}$/);

    const browser = await connectBrowser(s.origin);
    browser.send({ type: "term.open", req: "r1", key: started.data.key, cols: 100, rows: 30, observe: false });
    const opened = await browser.find("term.opened", (m) => m.req === "r1");
    await until(() => browser.output(opened.sid).includes("fake>"), "the prompt of the fake program", 20_000);
    browser.ws.send(encodeTermFrame(TERM_INPUT, opened.sid, Buffer.from("hello\r")), { binary: true });
    await until(() => browser.output(opened.sid).includes("you said: hello"), "the echoed line", 20_000);

    // Detaching (pause) leaves the program running in herdr-core.
    await s.closeNode();
    const probe = new HerdrCore({ binary: realBinary!, session, socket });
    clients.push(probe);
    await probe.ensureStarted();
    const live = await probe.list({ labels: { nexbot: "1" } });
    expect(live.terminals.filter((t) => t.state === "live")).toHaveLength(1);
  }, 120_000);
});
