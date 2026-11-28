// Multi-agent collaboration ("协作", code name `team`) Phase 1 test suite:
// pure `nex` command validation, worktree trust / codexEmptyComposer fixes,
// session pipe + `nex.mjs` + `nex-mcp.mjs` + `hook.mjs nex_pre`, SQLite migration 62,
// end-to-end flows 9.1 & 9.2, `--after` dependencies, worker `start` refusal,
// 6th-worker cap, boundary confirmation card, silent-worker nudge/escalation,
// disconnect/reconnect no-loss/no-dup delivery, HTTP routes, WebSocket `cli.team`
// & `workbench` streaming, and cascade archive/restore.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_FEATURES, parseServerMessage, type CliSessionRef, type DeviceCliMessage } from "../../../shared/cli-agents.ts";
import { isPureNexCommand } from "../../../shared/cli-team.ts";
import { createPersonalApp, type AppOptions } from "../index.ts";
import { codexEmptyComposer } from "../cli-agents-node/codex-first-input.ts";
import { HookServer, TurnTracker } from "../cli-agents-node/hooks.ts";
import { parsePromptScreen } from "../cli-agents-node/screen-prompts.ts";
import { codexMcpArgs, ensureTeamBin, leadInstruction } from "../cli-agents-node/team-cli.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(here, "../cli-agents-node/plugin/hooks/hook.mjs");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OWNER = "synthetic-team-owner";
const CAP = {
  version: 1,
  engines: ["claude", "codex", "agy"],
  features: [...CLI_FEATURES],
  terminal: { name: "herdr-core", version: "0.1.21", ready: true },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | null | false, what = "condition", ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await wait(15);
  }
}

function tempDir(prefix = "nex-team-"): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith(prefix)) throw Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function runNode(script: string, args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function fixture(tuning: NonNullable<AppOptions["cliAgents"]> = { graceMs: 0, opTimeoutMs: 2000 }) {
  const root = tempDir();
  const app = await createPersonalApp({
    dir: root,
    key: randomBytes(32),
    token: OWNER,
    identity: false,
    memoryRuntime: false,
    hostDevice: false,
    cliAgents: tuning,
  });
  // Speed up delivery/nudge timers for deterministic tests
  const teams = app.cliTeams as unknown as {
    userInputGuardMs: number;
    deliveryRetryMs: number;
    nudgeDelayMs: number;
  };
  teams.userInputGuardMs = 50;
  teams.deliveryRetryMs = 30;
  teams.nudgeDelayMs = 80;
  cleanups.push(() => app.close());

  const call = async (route: string, data?: unknown, method = "POST") => {
    const response = await fetch(app.origin + "/api/" + route, {
      headers: { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" },
      method,
      ...(data !== undefined && method !== "GET" ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  };
  const get = async (route: string) => {
    const response = await fetch(app.origin + "/api/" + route, { headers: { Authorization: "Bearer " + OWNER } });
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  };
  return { app, root, call, get };
}

interface FakeDevice {
  id: string;
  token: string;
  ws: WebSocket;
  msgs: Array<Record<string, any>>;
  seq: number;
  sentTexts: Array<{ ref: string; text: string }>;
  started: Array<{ engine: string; cwd: string; ref: string; team?: Record<string, unknown>; permissions?: string; model?: string; effort?: string; worktree?: Record<string, unknown> }>;
  archivedOps: Array<{ ref: string; archived: boolean }>;
  interruptedRefs: string[];
  onOp: (message: Record<string, any>) => Record<string, any> | Promise<Record<string, any> | undefined> | undefined;
  send(message: unknown): void;
  sessions(upserts: unknown[], extra?: { full?: boolean; removes?: string[]; seq?: number }): void;
  turn(ref: string, turn: number): void;
  teamCall(ref: CliSessionRef, command: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
}

async function connectDevice(f: Awaited<ReturnType<typeof fixture>>, name = "win-dev"): Promise<FakeDevice> {
  const pair = (await f.call("devices", { name })).data as { deviceId: string; token: string };
  const origin = f.app.origin.replace("http:", "ws:");
  let workerSeq = 0;

  const device: FakeDevice = {
    id: String(pair.deviceId),
    token: String(pair.token),
    ws: undefined as unknown as WebSocket,
    msgs: [],
    seq: 0,
    sentTexts: [],
    started: [],
    archivedOps: [],
    interruptedRefs: [],
    onOp: (message) => {
      if (message.op === "git") return { ok: true, result: { source: "folder", head: "abc1234", branch: "main" } };
      if (message.op === "models") {
        const engine = String(message.args.engine);
        if (engine === "agy") {
          return {
            ok: true,
            result: {
              current: "MODEL_PLACEHOLDER_M525",
              currentEffort: "high",
              models: [
                { id: "MODEL_PLACEHOLDER_M525", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high"] },
                { id: "MODEL_PLACEHOLDER_M500", label: "Claude Sonnet 4.6", efforts: ["low", "high"] },
              ],
            },
          };
        }
        if (engine === "codex") {
          return {
            ok: true,
            result: {
              current: "gpt-6.2-sol",
              models: [
                { id: "gpt-6.2-sol", label: "gpt-6.2-sol", efforts: ["low", "medium", "high"] },
                { id: "gpt-5.4", label: "gpt-5.4", efforts: ["medium", "high"] },
              ],
            },
          };
        }
        return {
          ok: true,
          result: {
            current: "claude-opus-4-6",
            models: [{ id: "claude-opus-4-6", label: "Claude Opus 4.6", efforts: ["low", "medium", "high"] }],
          },
        };
      }
      if (message.op === "start") {
        // Mirror real DeviceGit.worktree validation so invalid requestId formats fail tests immediately.
        if (message.args.worktree && !/^[A-Za-z0-9-]{8,64}$/.test(String(message.args.worktree.requestId ?? ""))) {
          return { ok: false, error: { code: "invalid", message: "创建请求无效" } };
        }
        const engine = String(message.args.engine);
        const nativeId = `w-${++workerSeq}`;
        const ref = `${engine}:${nativeId}`;
        const cwd = message.args.worktree ? `${String(message.args.cwd)}/.wt/${nativeId}` : String(message.args.cwd);
        device.started.push({
          engine,
          cwd,
          ref,
          team: message.args.team,
          permissions: message.args.permissions,
          model: message.args.model,
          effort: message.args.effort,
          worktree: message.args.worktree,
        });
        // Announce the newly launched worker session as idle right away
        device.sessions([{
          engine,
          nativeId,
          configDir: "C:/cfg",
          cwd,
          title: message.args.team?.title || nativeId,
          state: "idle",
          liveIn: engine === "agy" ? "background" : "nexbot",
          sendVia: engine === "agy" ? "acp" : "terminal",
          ...(engine === "agy" ? {} : { terminal: `hc://${nativeId}` }),
          lastActivityAt: Date.now(),
        }]);
        return {
          ok: true,
          result: { ref, ...(engine === "agy" ? {} : { terminal: `hc://${nativeId}` }), cwd },
        };
      }
      if (message.op === "send") {
        device.sentTexts.push({ ref: String(message.args.ref), text: String(message.args.text) });
        return { ok: true, result: { turn: 1, started: true, delivery: "confirmed" } };
      }
      if (message.op === "interrupt") {
        device.interruptedRefs.push(String(message.args.ref));
        return { ok: true, result: { outcome: "interrupted" } };
      }
      if (message.op === "read") return { ok: true, result: { items: [], more: false } };
      if (message.op === "archive") {
        device.archivedOps.push({ ref: String(message.args.ref), archived: Boolean(message.args.archived) });
        return { ok: true, result: {} };
      }
      return { ok: true, result: {} };
    },
    send(message) {
      device.ws.send(JSON.stringify(message));
    },
    sessions(upserts, extra = {}) {
      device.send({ type: "cli.sessions", full: extra.full ?? false, upserts, removes: extra.removes ?? [], seq: extra.seq ?? ++device.seq });
    },
    turn(ref, turn) {
      device.send({ type: "cli.turn", ref, turn, endedAt: Date.now(), reason: "end" });
    },
    async teamCall(ref, command, args = {}) {
      const callId = `call-${Math.random().toString(36).slice(2, 10)}`;
      device.send({ type: "cli.team.call", callId, ref, command, args });
      return until(() => device.msgs.find((m) => m.type === "cli.team.result" && m.callId === callId), `cli.team.result:${command}`);
    },
    async disconnect() {
      const ws = device.ws;
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.terminate();
      await closed;
    },
    async reconnect() {
      const prevBoundCount = device.msgs.filter((m) => m.type === "bound").length;
      await openWs();
      await until(() => device.msgs.filter((m) => m.type === "bound").length > prevBoundCount, "re-bound");
    },
  };

  async function openWs() {
    const ws = new WebSocket(origin + "/dcp/v1/connect", { headers: { Authorization: "Bearer " + device.token } });
    device.ws = ws;
    cleanups.push(() => ws.terminate());
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString()) as Record<string, any>;
      device.msgs.push(message);
      if (message.type === "cli.op") {
        const reply = device.onOp(message);
        if (reply && typeof (reply as Promise<unknown>).then === "function") {
          void (reply as Promise<Record<string, any> | undefined>).then((resolved) => {
            if (resolved && device.ws === ws && ws.readyState === WebSocket.OPEN) {
              device.send({ type: "cli.reply", opId: message.opId, ...resolved });
            }
          });
        } else if (reply) {
          device.send({ type: "cli.reply", opId: message.opId, ...reply });
        }
      }
    });
    const failed = new Promise<never>((_, reject) => ws.on("error", reject));
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "hello",
        policyVersion: 1,
        read: true,
        exec: true,
        computer: false,
        platform: "win32",
        identity: { hostname: name, supported: ["device.info"] },
        cliAgents: CAP,
      }));
    });
    await Promise.race([until(() => device.msgs.some((m) => m.type === "bound"), "bound"), failed]);
  }

  await openWs();
  return device;
}

describe("pure nex command validator & worktree trust fixes", () => {
  it("allows only standalone pure nex commands and rejects all shell chaining/metacharacters", () => {
    expect(isPureNexCommand("nex status")).toBe(true);
    expect(isPureNexCommand("nex start agy --role 实现 --title \"登录限流\" --file C:\\tmp\\plan.md")).toBe(true);
    expect(isPureNexCommand("nex.cmd report --outcome=succeeded --file report.md")).toBe(true);
    expect(isPureNexCommand("nex --help")).toBe(true);

    expect(isPureNexCommand("nex status && echo LEAK")).toBe(false);
    expect(isPureNexCommand("nex status || echo LEAK")).toBe(false);
    expect(isPureNexCommand("nex status; whoami")).toBe(false);
    expect(isPureNexCommand("nex status | cat")).toBe(false);
    expect(isPureNexCommand("nex status $(whoami)")).toBe(false);
    expect(isPureNexCommand("nex status `whoami`")).toBe(false);
    expect(isPureNexCommand("nex status > out.txt")).toBe(false);
    expect(isPureNexCommand("nex status\necho LEAK")).toBe(false);
    expect(isPureNexCommand("nex note --text (whoami)")).toBe(false);
    expect(isPureNexCommand("nex note --text $env:SECRET")).toBe(false);
    expect(isPureNexCommand("nex note --text '%PATH%'")).toBe(false);
    expect(isPureNexCommand("nex note --text “curly”")).toBe(false);
    expect(isPureNexCommand("nex note --text \"a\\\"b\"")).toBe(false);
    expect(isPureNexCommand("echo hi && nex status")).toBe(false);
    expect(isPureNexCommand("nex evil_subcommand")).toBe(false);
    expect(isPureNexCommand("nex start agy --title \"unclosed")).toBe(false);
  });

  it("rejects Codex Folder access dialog in codexEmptyComposer and parses trust dialogs in screen-prompts", () => {
    const codexTrustScreen = [
      "Folder access",
      "Trust this folder?",
      "D:\\repo\\.worktrees\\agy-1",
      "› 1. Trust and continue",
      "  2. Continue without trusting",
      "enter continue · esc back",
    ].join("\n");
    expect(codexEmptyComposer(codexTrustScreen, 100)).toBeNull();

    const parsedCodex = parsePromptScreen(codexTrustScreen);
    expect(parsedCodex).not.toBeNull();
    expect(parsedCodex!.allow.number).toBe("1");
    expect(parsedCodex!.deny.number).toBe("2");

    const claudeInvertedTrust = [
      "Do you trust the files in this folder?",
      "D:\\repo\\.worktrees\\claude-1",
      "❯ 1. No, exit",
      "  2. Yes, I trust this folder",
    ].join("\n");
    const parsedClaude = parsePromptScreen(claudeInvertedTrust);
    expect(parsedClaude).not.toBeNull();
    expect(parsedClaude!.allow.number).toBe("2");
    expect(parsedClaude!.deny.number).toBe("1");
  });

  it("builds single-launch Codex MCP flags and lead instructions", () => {
    expect(leadInstruction("off")).toBe("");
    expect(leadInstruction("prompt")).toContain("nex guide");
    expect(leadInstruction("prompt")).toContain("仅在用户要求");
    expect(leadInstruction("auto")).toContain("并行/独立审查");

    const args = codexMcpArgs({
      node: "C:\\node\\node.exe",
      mcpScript: "C:\\data\\nex-mcp.mjs",
      pipe: "\\\\.\\pipe\\nexbot-hook-test",
      sessionToken: "abc.codex:1",
      allowInAsk: true,
    });
    expect(args).toContain('mcp_servers.nex.tools.nex_models.approval_mode="approve"');
    expect(args).toContain('mcp_servers.nex.tools.nex_start.approval_mode="approve"');
    expect(args).toContain('mcp_servers.nex.tools.nex_report.approval_mode="approve"');
  });
});

describe("session pipe, nex.mjs, nex-mcp.mjs, and Claude PreToolUse nex_pre", () => {
  it("routes nex CLI via pipe + HTTP fallback, MCP stdio JSON-RPC, AGY alias, and Claude PreToolUse pure-nex allow", async () => {
    const dir = tempDir("nex-pipe-");
    const live = new Set<string>(["claude:c1", "codex:x1", "agy:real-agy-1"]);
    let allowInAsk = true;
    const seen: Array<{ ref: string; command: string; args: Record<string, unknown> }> = [];

    const messages: DeviceCliMessage[] = [];
    const emit = (m: DeviceCliMessage) => (messages.push(m), true);
    const server = new HookServer({
      dir,
      emit,
      turns: new TurnTracker(emit),
      active: () => true,
      isLive: (ref) => live.has(ref),
      isTeamLive: (ref) => live.has(ref),
      sessionCwd: () => dir,
      allowNexInAsk: () => allowInAsk,
      enableHttpFallback: true,
      socketDir: dir,
      teamCall: async (ref, command, args) => {
        seen.push({ ref, command, args });
        return { ok: true, text: `OK:${ref}:${command}:${String(args.body ?? "")}`, data: { ref, command } };
      },
    });
    cleanups.push(() => server.close());
    await server.start();
    expect(server.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const { binDir, mcpScript } = ensureTeamBin(dir, process.execPath, process.platform);
    const specFile = path.join(dir, "spec.md");
    writeFileSync(specFile, "中文任务说明 100% \"quoted\"\n第二行", "utf8");

    // 1. nex.mjs via named pipe with --file UTF-8 + AGY launch alias resolution
    const pendingRef: CliSessionRef = "agy:pending-launch-1";
    const agyToken = server.sessionTokenFor(pendingRef);
    server.aliasSession(pendingRef, "agy:real-agy-1");
    const pipeRun = await runNode(
      path.join(binDir, "nex.mjs"),
      ["start", "codex", "--title", "测试", "--file", specFile],
      { ...process.env, NEX_PIPE: server.pipe, NEX_SESSION: agyToken },
    );
    expect(pipeRun.code).toBe(0);
    expect(pipeRun.stdout).toContain("OK:agy:real-agy-1:start:中文任务说明 100% \"quoted\"");

    // 2. nex.mjs via HTTP fallback (simulating Windows restricted sandbox where pipe fails)
    const codexToken = server.sessionTokenFor("codex:x1");
    const httpRun = await runNode(
      path.join(binDir, "nex.mjs"),
      ["status", "--json"],
      { ...process.env, NEX_HTTP: server.httpUrl!, NEX_SESSION: codexToken },
    );
    expect(httpRun.code).toBe(0);
    expect(JSON.parse(httpRun.stdout)).toMatchObject({ ok: true, data: { ref: "codex:x1", command: "status" } });

    // 3. nex-mcp.mjs over newline-delimited stdio JSON-RPC (Codex format) — and refuses host file reads
    const outsideDir = tempDir("nex-secret-");
    const secretFile = path.join(outsideDir, "secret.txt");
    writeFileSync(secretFile, "TOP_SECRET_DO_NOT_LEAK", "utf8");
    const mcpInput = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nex_status", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nex_report", arguments: { outcome: "succeeded", file: secretFile } } }),
    ].join("\n") + "\n";
    const mcpRun = await runNode(
      mcpScript,
      [],
      { ...process.env, NEX_PIPE: server.pipe, NEX_SESSION: codexToken },
      mcpInput,
    );
    expect(mcpRun.code).toBe(0);
    const mcpLines = mcpRun.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(mcpLines.find((m) => m.id === 1)?.result?.serverInfo?.name).toBe("nex");
    expect(mcpLines.find((m) => m.id === 2)?.result?.tools?.length).toBeGreaterThanOrEqual(15);
    expect(mcpLines.find((m) => m.id === 3)?.result?.content?.[0]?.text).toContain("OK:codex:x1:status:");
    const mcpFileAttempt = mcpLines.find((m) => m.id === 4)?.result;
    expect(mcpFileAttempt?.isError).toBe(true);
    expect(mcpFileAttempt?.content?.[0]?.text).not.toContain("TOP_SECRET_DO_NOT_LEAK");

    // 4. Claude hook.mjs nex_pre: pure nex allowed on both Bash and PowerShell, chained / oversized / out-of-cwd --file rejected
    const claudeEnv = { ...process.env, ...server.environment("claude:c1", process.execPath) };
    const allowBash = await runNode(
      HOOK_SCRIPT,
      ["nex_pre"],
      claudeEnv,
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "nex status" } }),
    );
    expect(JSON.parse(allowBash.stdout)?.hookSpecificOutput?.permissionDecision).toBe("allow");

    const allowInWorkspaceFile = await runNode(
      HOOK_SCRIPT,
      ["nex_pre"],
      claudeEnv,
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `nex report --outcome succeeded --file "${specFile}"` } }),
    );
    expect(JSON.parse(allowInWorkspaceFile.stdout)?.hookSpecificOutput?.permissionDecision).toBe("allow");

    const blockOutsideFile = await runNode(
      HOOK_SCRIPT,
      ["nex_pre"],
      claudeEnv,
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `nex report --outcome succeeded --file "${secretFile}"` } }),
    );
    expect(blockOutsideFile.stdout.trim()).toBe("");

    // Oversized command padded past 2000 chars must NEVER be truncated into a false allow
    const oversizedCmd = `nex status ${" ".repeat(2020)}; echo LEAK`;
    const blockOversized = await runNode(
      HOOK_SCRIPT,
      ["nex_pre"],
      claudeEnv,
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: oversizedCmd } }),
    );
    expect(blockOversized.stdout.trim()).toBe("");

    const allowPs = await runNode(
      HOOK_SCRIPT,
      ["nex_pre"],
      claudeEnv,
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "PowerShell", tool_input: { command: "nex inbox" } }),
    );
    expect(JSON.parse(allowPs.stdout)?.hookSpecificOutput?.permissionDecision).toBe("allow");

    const blockChain = await runNode(
      HOOK_SCRIPT,
      ["nex_pre"],
      claudeEnv,
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "nex status && echo LEAK" } }),
    );
    expect(blockChain.stdout.trim()).toBe("");

    // Toggle allowNexInAsk off -> pure nex no longer auto-allowed
    allowInAsk = false;
    const toggledOff = await runNode(
      HOOK_SCRIPT,
      ["nex_pre"],
      claudeEnv,
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "nex status" } }),
    );
    expect(toggledOff.stdout.trim()).toBe("");
  });
});

describe("Core TeamScheduler end-to-end (Phase 1 acceptance)", () => {
  it("runs Flow 9.1 (Claude lead -> AGY impl -> Codex readonly review -> follow-up -> done), enforces worker refusal & 5-worker cap", async () => {
    const f = await fixture();
    const dev = await connectDevice(f);
    const leadRef: CliSessionRef = "claude:lead-1";
    const leadKey = `${dev.id}:${leadRef}`;

    // Verify migration 62 FK integrity
    expect(f.app.store.all("PRAGMA foreign_key_check")).toEqual([]);

    // Connect browser WebSocket stream to verify `workbench` & `cli.team` push
    const wsMsgs: Array<Record<string, any>> = [];
    const browserWs = new WebSocket(f.app.origin.replace("http:", "ws:") + "/api/cli-agents/stream", {
      headers: { Authorization: "Bearer " + OWNER },
    });
    cleanups.push(() => browserWs.terminate());
    browserWs.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const parsed = parseServerMessage(JSON.parse(raw.toString()));
      if (parsed) wsMsgs.push(parsed as Record<string, any>);
    });
    await new Promise<void>((resolve) => browserWs.once("open", () => resolve()));
    browserWs.send(JSON.stringify({ type: "sub.list" }));
    await until(() => wsMsgs.some((m) => m.type === "cli.team" && Array.isArray(m.runs)), "initial cli.team snapshot");

    // Announce lead session
    dev.sessions([{
      engine: "claude",
      nativeId: "lead-1",
      configDir: "C:/cfg",
      cwd: "C:/repo",
      title: "登录接口限流方案",
      state: "idle",
      liveIn: "nexbot",
      sendVia: "inbox",
      terminal: "hc://lead-1",
      lastActivityAt: Date.now(),
    }], { full: true });
    await until(() => f.app.cliHub.session(leadKey), "lead registered");

    // 1. Lead starts AGY implementer
    const startAgy = await dev.teamCall(leadRef, "start", {
      agent: "agy",
      role: "实现",
      title: "实现登录限流中间件",
      body: "按 plan.md 实现双维度限流。",
      in: "worktree",
    });
    expect(startAgy.ok).toBe(true);
    expect(startAgy.data?.worker).toBe("agy-1");
    expect(dev.started[0]?.team).toMatchObject({ workerName: "agy-1", role: "实现" });

    const agyRef = dev.started[0]!.ref as CliSessionRef;
    // AGY receives structured envelope directly
    const agyFirstMsg = await until(() => dev.sentTexts.find((s) => s.ref === agyRef), "agy task delivered");
    expect(agyFirstMsg.text).toContain("<!-- nexagent-team:");
    expect(agyFirstMsg.text).toContain("按 plan.md 实现双维度限流");

    // Workbench tree has worker under lead AND browser stream got cli.team + workbench updates
    const wbRows = f.app.cliWorkbench.list();
    const leadWb = wbRows.find((r) => r.sessionKey === leadKey);
    const agyWb = wbRows.find((r) => r.sessionKey === `${dev.id}:${agyRef}`);
    expect(agyWb?.kind).toBe("worker");
    expect(agyWb?.parentId).toBe(leadWb?.id);
    await until(() => wsMsgs.some((m) => m.type === "cli.team" && m.run?.workers?.length === 1), "ws cli.team run push");
    // Browser parseServerMessage must accept workbench snapshots containing root sessions (parentId: null)
    await until(() => wsMsgs.some((m) => m.type === "workbench" && Array.isArray(m.sessions) && m.sessions.some((row: any) => row.parentId === null)), "ws workbench root push");

    // HARD RULE: Worker calling `nex start` MUST be refused!
    const workerStart = await dev.teamCall(agyRef, "start", { agent: "codex", title: "偷派", body: "nope" });
    expect(workerStart.ok).toBe(false);
    expect(workerStart.error).toContain("工人不能派活");

    // Lead cannot call `nex done` while agy-1 is still running
    const earlyDone = await dev.teamCall(leadRef, "done", { body: "提前结束" });
    expect(earlyDone.ok).toBe(false);
    expect(earlyDone.error).toContain("agy-1");

    // 2. AGY submits report -> lead receives structured report card
    const agyReport = await dev.teamCall(agyRef, "report", {
      outcome: "succeeded",
      body: "已完成限流中间件，14 条单测通过。",
      files: ["server/auth/rate-limit.ts"],
    });
    expect(agyReport.ok).toBe(true);
    const leadReportMsg = await until(() => dev.sentTexts.find((s) => s.ref === leadRef && s.text.includes("已完成限流中间件")), "lead receives agy report");
    expect(leadReportMsg.text).toContain("<!-- nexagent-team:");

    // 3. Lead starts Codex readonly reviewer inside agy-1's worktree
    const startCodex = await dev.teamCall(leadRef, "start", {
      agent: "codex",
      role: "审查",
      title: "审查登录限流",
      body: "只读审查边界问题。",
      in: "agy-1",
      permissions: "readonly",
    });
    expect(startCodex.ok).toBe(true);
    expect(startCodex.data?.worker).toBe("codex-1");
    expect(dev.started[1]?.cwd).toBe(dev.started[0]?.cwd);
    expect(dev.started[1]?.permissions).toBe("full");

    const codexRef = dev.started[1]!.ref as CliSessionRef;
    // Codex terminal worker gets constant 1-line pointer, NOT pasted spec
    const codexFirstMsg = await until(() => dev.sentTexts.find((s) => s.ref === codexRef), "codex task pointer");
    expect(codexFirstMsg.text).toBe("[NexAgent] The lead assigned you a task. Run `nex task` and follow it.");

    // Codex runs `nex task` to read full spec + base_ref
    const codexTask = await dev.teamCall(codexRef, "task");
    expect(codexTask.ok).toBe(true);
    expect(codexTask.text).toContain("只读审查边界问题");
    expect(codexTask.text).toContain("abc1234");

    // Codex reports findings
    const codexReport = await dev.teamCall(codexRef, "report", {
      outcome: "succeeded",
      body: "发现 1 个高优先级问题。",
      findings: [{ severity: "high", file: "server/auth/rate-limit.ts", line: 84, issue: "未校验可信代理" }],
    });
    expect(codexReport.ok).toBe(true);
    const leadReviewMsg = await until(() => dev.sentTexts.find((s) => s.ref === leadRef && s.text.includes("发现 1 个高优先级问题")), "lead receives codex review");
    expect(leadReviewMsg.text).toContain("\"kind\":\"review\"");

    // 4. Lead sends follow-up to agy-1 (opens round 2), AGY reports again
    const followUp = await dev.teamCall(leadRef, "send", { worker: "agy-1", body: "请修复 trustedProxies 校验" });
    expect(followUp.ok).toBe(true);
    expect(followUp.data?.followUp).toBe(true);
    await until(() => dev.sentTexts.some((s) => s.ref === agyRef && s.text.includes("trustedProxies")), "agy follow-up delivered");
    const agyReport2 = await dev.teamCall(agyRef, "report", { outcome: "succeeded", body: "已修复并补测。" });
    expect(agyReport2.ok).toBe(true);

    // 5. HARD RULE: 6th worker MUST be refused (default maxWorkers=5)
    for (let i = 3; i <= 5; i++) {
      const res = await dev.teamCall(leadRef, "start", { agent: "agy", title: `额外任务 ${i}`, body: `任务 ${i}` });
      expect(res.ok).toBe(true);
    }
    const sixth = await dev.teamCall(leadRef, "start", { agent: "agy", title: "第 6 个工人", body: "超限" });
    expect(sixth.ok).toBe(false);
    expect(sixth.error).toContain("上限");

    const teamsRes = await f.get(`cli-agents/teams?lead=${encodeURIComponent(leadKey)}`);
    expect(teamsRes.status).toBe(200);
    expect(teamsRes.data.runs[0].workers).toHaveLength(5);
    expect(teamsRes.data.runs[0].limitHit).toContain("上限");

    // Stop extra workers 3..5 and finish via `nex done`
    for (const w of ["agy-2", "agy-3", "agy-4"]) {
      expect((await dev.teamCall(leadRef, "stop", { worker: w })).ok).toBe(true);
    }
    const done = await dev.teamCall(leadRef, "done", { body: "登录限流实现并复审通过。" });
    expect(done.ok).toBe(true);
    const finishedRuns = await f.get(`cli-agents/teams?lead=${encodeURIComponent(leadKey)}`);
    expect(finishedRuns.data.runs[0].status).toBe("finished");
    expect(finishedRuns.data.runs[0].summary).toContain("登录限流实现并复审通过");

    // Cascade archive lead -> archives workers too
    const archiveRes = await f.call("cli-agents/sessions/archive", { key: leadKey });
    expect(archiveRes.status).toBe(200);
    expect(dev.archivedOps.some((op) => op.ref === leadRef && op.archived)).toBe(true);
    expect(dev.archivedOps.some((op) => op.ref === agyRef && op.archived)).toBe(true);
    expect(dev.archivedOps.some((op) => op.ref === codexRef && op.archived)).toBe(true);
  });

  it("handles --after dependencies, boundary confirmation card, silent-worker nudge/escalation, and disconnect/reconnect with no lost or duplicated mail", async () => {
    const f = await fixture();
    const dev = await connectDevice(f);
    const leadRef: CliSessionRef = "agy:lead-2";
    const leadKey = `${dev.id}:${leadRef}`;

    dev.sessions([{
      engine: "agy",
      nativeId: "lead-2",
      configDir: "C:/cfg",
      cwd: "C:/repo",
      title: "并行与容错测试",
      state: "idle",
      liveIn: "background",
      sendVia: "acp",
      lastActivityAt: Date.now(),
    }], { full: true });
    await until(() => f.app.cliHub.session(leadKey), "lead-2 registered");

    // Settings update pushes cli.team.config to device
    const putSettings = await f.call("cli-agents/team-settings", { settings: { dispatchMode: "auto", maxWorkers: 5, allowNexInAsk: true } }, "PUT");
    expect(putSettings.status).toBe(200);
    expect(putSettings.data.settings.dispatchMode).toBe("auto");
    await until(() => dev.msgs.some((m) => m.type === "cli.team.config" && m.config?.dispatchMode === "auto"), "cli.team.config pushed");

    // Parallel worktree workers + downstream `--after` worker
    const w1 = await dev.teamCall(leadRef, "start", { agent: "agy", title: "前端", body: "做前端", in: "worktree" });
    const w2 = await dev.teamCall(leadRef, "start", { agent: "codex", title: "后端", body: "做后端", in: "worktree" });
    const w3 = await dev.teamCall(leadRef, "start", { agent: "agy", title: "联调测试", body: "跑集成测试", after: "agy-1,codex-1" });
    expect(w1.ok && w2.ok && w3.ok).toBe(true);
    expect(w3.data?.status).toBe("waiting");
    expect(dev.started).toHaveLength(2); // w3 NOT started yet!

    const w1Ref = dev.started[0]!.ref as CliSessionRef;
    const w2Ref = dev.started[1]!.ref as CliSessionRef;

    // Silent worker nudge -> second silent turn escalates to lead
    dev.turn(w1Ref, 1);
    await until(() => dev.sentTexts.some((s) => s.ref === w1Ref && s.text.includes("Your turn ended without a report")), "first nudge sent");
    dev.turn(w1Ref, 2);
    await until(() => dev.sentTexts.some((s) => s.ref === leadRef && s.text.includes("停下了但没有汇报")), "escalation sent to lead");

    // Both upstream workers succeed -> w3 auto-launches!
    expect((await dev.teamCall(w1Ref, "report", { outcome: "succeeded", body: "前端完成" })).ok).toBe(true);
    expect(dev.started).toHaveLength(2);
    expect((await dev.teamCall(w2Ref, "report", { outcome: "succeeded", body: "后端完成" })).ok).toBe(true);
    await until(() => dev.started.length === 3, "downstream --after worker auto-launched");
    const w3Ref = dev.started[2]!.ref as CliSessionRef;

    // Boundary-word protection: lead sends "git push" instruction -> held & raises Core confirmation card
    const boundarySend = await dev.teamCall(leadRef, "send", { worker: "agy-2", body: "请执行 git push 推送到远程主分支" });
    expect(boundarySend.ok).toBe(true);
    expect(boundarySend.data?.held).toBe(true);
    const boundaryReq = await until(() => f.app.cliHub.requests(leadKey).find((r) => r.tool === "nexbot:team:boundary"), "boundary confirmation card");
    expect(dev.sentTexts.some((s) => s.ref === w3Ref && s.text.includes("git push"))).toBe(false);
    // User denies boundary request -> message never delivered to worker
    await f.app.cliHub.answer("owner", boundaryReq.id, "deny");
    await wait(80);
    expect(dev.sentTexts.some((s) => s.ref === w3Ref && s.text.includes("git push"))).toBe(false);

    // Pause -> Disconnect device -> Worker reports -> Resume & Reconnect -> delivered ONCE (no loss, no dup!)
    const runId = (await f.get(`cli-agents/teams?lead=${encodeURIComponent(leadKey)}`)).data.runs[0].id as string;
    expect((await f.call(`cli-agents/teams/${runId}/pause`, {})).status).toBe(200);
    expect((await dev.teamCall(w3Ref, "report", { outcome: "succeeded", body: "联调 100% 通过-唯一回执" })).ok).toBe(true);

    // Disconnect device before resuming so delivery cannot go out while offline
    await dev.disconnect();
    expect((await f.call(`cli-agents/teams/${runId}/resume`, {})).status).toBe(200);
    await wait(120);
    expect(dev.sentTexts.filter((s) => s.ref === leadRef && s.text.includes("联调 100% 通过-唯一回执"))).toHaveLength(0);

    // Reconnect device and re-announce lead session as idle
    await dev.reconnect();
    dev.sessions([{
      engine: "agy",
      nativeId: "lead-2",
      configDir: "C:/cfg",
      cwd: "C:/repo",
      title: "并行与容错测试",
      state: "idle",
      liveIn: "background",
      sendVia: "acp",
      lastActivityAt: Date.now(),
    }], { full: true });
    await until(() => dev.sentTexts.some((s) => s.ref === leadRef && s.text.includes("联调 100% 通过-唯一回执")), "post-reconnect delivery");
    await wait(150);
    expect(dev.sentTexts.filter((s) => s.ref === leadRef && s.text.includes("联调 100% 通过-唯一回执"))).toHaveLength(1);
  });

  it("blocks nex task on held/denied initial boundary tasks, keeps boundary card alive across lead turn-end, respects pause for --after workers, and survives reconnect stopped flash", async () => {
    const f = await fixture();
    const dev = await connectDevice(f);
    const leadRef: CliSessionRef = "claude:lead-3";
    const leadKey = `${dev.id}:${leadRef}`;

    dev.sessions([{
      engine: "claude",
      nativeId: "lead-3",
      configDir: "C:/cfg",
      cwd: "C:/repo",
      title: "审查回归测试",
      state: "idle",
      liveIn: "nexbot",
      sendVia: "inbox",
      terminal: "hc://lead-3",
      lastActivityAt: Date.now(),
    }], { full: true });
    await until(() => f.app.cliHub.session(leadKey), "lead-3 registered");

    // 1. Initial task containing boundary action: held -> nex task blocked, lead turn-end keeps card alive, deny settles worker & still blocks nex task
    const startBoundary = await dev.teamCall(leadRef, "start", {
      agent: "codex",
      title: "发布上线",
      body: "执行 git push 并部署到生产环境",
    });
    expect(startBoundary.ok).toBe(true);
    expect(startBoundary.data?.held).toBe(true);
    const boundaryWorkerRef = dev.started[0]!.ref as CliSessionRef;
    const heldCard = await until(() => f.app.cliHub.requests(leadKey).find((r) => r.tool === "nexbot:team:boundary"), "initial boundary card");

    // Worker calling `nex task` while held MUST NOT receive the spec
    const taskWhileHeld = await dev.teamCall(boundaryWorkerRef, "task");
    expect(taskWhileHeld.ok).toBe(false);
    expect(taskWhileHeld.text ?? "").not.toContain("git push");

    // Lead ending its turn MUST NOT clear the team boundary card (supervisor only closes nexbot:triage)
    dev.turn(leadRef, 1);
    await wait(60);
    expect(f.app.cliHub.requests(leadKey).some((r) => r.id === heldCard.id)).toBe(true);

    // Simulate Core restart losing in-memory map: answering card still works via persisted SQLite request id
    (f.app.cliTeams as unknown as { boundaryHoldRequests: Map<string, string> }).boundaryHoldRequests.clear();
    await f.app.cliHub.answer("owner", heldCard.id, "deny");
    await wait(60);
    const taskAfterDeny = await dev.teamCall(boundaryWorkerRef, "task");
    expect(taskAfterDeny.ok).toBe(false);
    expect(taskAfterDeny.text ?? "").not.toContain("git push");

    // 2. Paused run MUST NOT launch downstream --after worker when upstream reports; resume launches it
    const upstream = await dev.teamCall(leadRef, "start", { agent: "agy", title: "上游", body: "上游实现" });
    expect(upstream.ok).toBe(true);
    const upstreamRef = dev.started[1]!.ref as CliSessionRef;
    const downstream = await dev.teamCall(leadRef, "start", { agent: "agy", title: "下游", body: "下游测试", after: "agy-1" });
    expect(downstream.ok).toBe(true);
    expect(downstream.data?.status).toBe("waiting");
    const runId = (await f.get(`cli-agents/teams?lead=${encodeURIComponent(leadKey)}`)).data.runs[0].id as string;

    // Brief `stopped` flash during reconnect must NOT fail an active worker
    dev.sessions([{
      engine: "agy", nativeId: upstreamRef.slice(4), configDir: "C:/cfg", cwd: "C:/repo",
      title: "上游", state: "stopped", liveIn: "background", sendVia: "acp", lastActivityAt: Date.now(),
    }]);
    await wait(30);
    dev.sessions([{
      engine: "agy", nativeId: upstreamRef.slice(4), configDir: "C:/cfg", cwd: "C:/repo",
      title: "上游", state: "idle", liveIn: "background", sendVia: "acp", lastActivityAt: Date.now(),
    }]);
    await wait(30);
    expect((await f.get(`cli-agents/teams?lead=${encodeURIComponent(leadKey)}`)).data.runs[0].workers.find((w: any) => w.name === "agy-1")?.status).not.toBe("failed");

    // Pause run, then upstream succeeds -> downstream stays unlaunched until resumed
    expect((await f.call(`cli-agents/teams/${runId}/pause`, {})).status).toBe(200);
    expect((await dev.teamCall(upstreamRef, "report", { outcome: "succeeded", body: "上游完成" })).ok).toBe(true);
    await wait(80);
    expect(dev.started).toHaveLength(2);

    // Resume run -> downstream ready task now auto-launches!
    expect((await f.call(`cli-agents/teams/${runId}/resume`, {})).status).toBe(200);
    await until(() => dev.started.length === 3, "downstream launched after resume");
    const downstreamRef = dev.started[2]!.ref as CliSessionRef;

    // Stop downstream worker -> cancels pending mail so it never wakes back up
    expect((await f.call(`cli-agents/teams/${runId}/workers/agy-2/stop`, {})).status).toBe(200);
    const sentBefore = dev.sentTexts.filter((s) => s.ref === downstreamRef).length;
    await wait(120);
    expect(dev.sentTexts.filter((s) => s.ref === downstreamRef).length).toBe(sentBefore);
  });

  it("enforces full-access permissions for collaboration workers, falls back to pointers above 32 KiB, and propagates multi-level --after failures", async () => {
    const f = await fixture();
    const dev = await connectDevice(f);
    const leadRef: CliSessionRef = "agy:lead-r2";
    const leadKey = `${dev.id}:${leadRef}`;
    dev.sessions([{
      engine: "agy", nativeId: "lead-r2", configDir: "C:/cfg", cwd: "C:/repo",
      title: "主控 R2", state: "idle", liveIn: "background", sendVia: "acp", lastActivityAt: Date.now(),
    }], { full: true });
    await until(() => f.app.cliHub.session(leadKey)?.online, "lead online");

    // 1. Collaboration workers always launch with permissions="full" (even if omitted or `ask` is passed).
    const bigSpec = "X".repeat(40 * 1024);
    const s1 = await dev.teamCall(leadRef, "start", { agent: "agy", title: "大任务", body: bigSpec, permissions: "ask" });
    expect(s1.ok).toBe(true);
    expect(dev.started[0]?.permissions).toBe("full");
    const run1 = (await f.get(`cli-agents/teams?lead=${encodeURIComponent(leadKey)}`)).data.runs[0];
    expect(run1.workers[0].permissions).toBe("full");

    // 8a. AGY task > 32 KiB falls back to 1-line `nex task` pointer; `nex task` returns full 40 KiB spec.
    const w1Ref = dev.started[0]!.ref as CliSessionRef;
    await until(() => dev.sentTexts.some((entry) => entry.ref === w1Ref), "w1 task delivered");
    const w1Delivered = dev.sentTexts.find((entry) => entry.ref === w1Ref)!.text;
    expect(w1Delivered).toContain("nex task");
    expect(Buffer.byteLength(w1Delivered, "utf8")).toBeLessThanOrEqual(32 * 1024);
    const readSpec = await dev.teamCall(w1Ref, "task");
    expect(readSpec.ok).toBe(true);
    expect(readSpec.text).toContain(bigSpec);

    // 9. Multi-level dependency chain: agy-2 waits on agy-1, agy-3 waits on agy-2.
    const s2 = await dev.teamCall(leadRef, "start", { agent: "agy", title: "中游", body: "中游任务", after: "agy-1" });
    expect(s2.ok).toBe(true);
    const s3 = await dev.teamCall(leadRef, "start", { agent: "agy", title: "末端", body: "末端任务", after: "agy-2" });
    expect(s3.ok).toBe(true);

    // 8b + 9. agy-1 fails with a 40 KiB report:
    // - Both agy-2 AND agy-3 must transition to `blocked` so `nex done` succeeds.
    // - Lead receives 1-line `nex inbox` pointer (<= 32 KiB) instead of oversized envelope, and `nex inbox` returns the full 40 KiB report.
    const bigReport = "R".repeat(40 * 1024);
    const rep = await dev.teamCall(w1Ref, "report", { outcome: "failed", body: bigReport });
    expect(rep.ok).toBe(true);

    const tasks = f.app.store.all("SELECT status FROM cli_team_tasks WHERE run_id=? ORDER BY created_at ASC, rowid ASC", run1.id);
    expect(tasks.map((t) => t.status)).toEqual(["failed", "blocked", "blocked"]);

    await until(() => dev.sentTexts.some((entry) => entry.ref === leadRef), "lead woken");
    const leadWoke = dev.sentTexts.find((entry) => entry.ref === leadRef)!.text;
    expect(leadWoke).toContain("nex inbox");
    expect(Buffer.byteLength(leadWoke, "utf8")).toBeLessThanOrEqual(32 * 1024);

    const inbox = await dev.teamCall(leadRef, "inbox");
    expect(inbox.ok).toBe(true);
    expect(inbox.text).toContain(bigReport);

    const done = await dev.teamCall(leadRef, "done", { text: "全部已结算" });
    expect(done.ok).toBe(true);
  });

  it("claims tasks atomically across git probe pause/resume and preserves ready tasks while device is offline on recover", async () => {
    const f = await fixture();
    const dev = await connectDevice(f);
    const leadRef: CliSessionRef = "agy:lead-claim";
    const leadKey = `${dev.id}:${leadRef}`;
    dev.sessions([{
      engine: "agy", nativeId: "lead-claim", configDir: "C:/cfg", cwd: "C:/repo",
      title: "主控领取", state: "idle", liveIn: "background", sendVia: "acp", lastActivityAt: Date.now(),
    }], { full: true });
    await until(() => f.app.cliHub.session(leadKey)?.online, "lead online");

    // 3. Delay git reply while pause + resume races: task must launch at most ONCE.
    const baseOnOp = dev.onOp;
    let releaseGit!: () => void;
    let gitEntered!: () => void;
    const gitWaiting = new Promise<void>((resolve) => { gitEntered = resolve; });
    dev.onOp = (message) => {
      if (message.op === "git") {
        gitEntered();
        return new Promise((resolve) => {
          releaseGit = () => resolve({ ok: true, result: { source: "folder", head: "deadbeef", branch: "main" } });
        });
      }
      return baseOnOp(message);
    };

    const startPromise = dev.teamCall(leadRef, "start", { agent: "agy", title: "并发领取", body: "只应启动一次" });
    await gitWaiting;
    const runId = (await f.get(`cli-agents/teams?lead=${encodeURIComponent(leadKey)}`)).data.runs[0].id as string;
    expect((await f.call(`cli-agents/teams/${runId}/pause`, {})).status).toBe(200);
    expect((await f.call(`cli-agents/teams/${runId}/resume`, {})).status).toBe(200);
    releaseGit();
    const startedRes = await startPromise;
    expect(startedRes.ok).toBe(true);
    await wait(80);
    expect(dev.started).toHaveLength(1);

    // 5. Queue a downstream worker, make it ready while device is offline, and run `recover()`:
    //    it must remain `ready` (not `failed`) until the device reconnects, then auto-launch.
    dev.onOp = baseOnOp;
    const w1Ref = dev.started[0]!.ref as CliSessionRef;
    expect((await dev.teamCall(leadRef, "start", { agent: "agy", title: "离线就绪", body: "重连后启动", after: "agy-1" })).ok).toBe(true);
    expect((await f.call(`cli-agents/teams/${runId}/pause`, {})).status).toBe(200);
    expect((await dev.teamCall(w1Ref, "report", { outcome: "succeeded", body: "完成" })).ok).toBe(true);
    // Downstream task is now `ready` while paused; flip run back to active in DB while device is disconnected and call `recover()`.
    await dev.disconnect();
    await until(() => !f.app.cliHub.list().devices.find((d) => d.id === dev.id)?.online, "device offline");
    f.app.store.run("UPDATE cli_team_runs SET status='active' WHERE id=?", runId);
    f.app.cliTeams.recover();
    await wait(80);
    const readyRow = f.app.store.get("SELECT t.status AS tstatus, w.status AS wstatus FROM cli_team_tasks t JOIN cli_team_workers w ON w.id=t.worker_id WHERE w.name='agy-2' AND w.run_id=?", runId);
    expect(readyRow).toEqual({ tstatus: "ready", wstatus: "starting" });

    // Reconnect device -> agy-2 launches automatically!
    await dev.reconnect();
    dev.sessions([{
      engine: "agy", nativeId: "lead-claim", configDir: "C:/cfg", cwd: "C:/repo",
      title: "主控领取", state: "idle", liveIn: "background", sendVia: "acp", lastActivityAt: Date.now(),
    }], { full: true });
    await until(() => dev.started.length === 2, "ready task launched on device online");
  });

  it("recovers lost start receipts by start_op_id (stopping late-discovered stopped workers) and reconciles uncertain outbox deliveries", async () => {
    const f = await fixture({ graceMs: 0, opTimeoutMs: 400 });
    const dev = await connectDevice(f);
    const leadRef: CliSessionRef = "agy:lead-rec";
    const leadKey = `${dev.id}:${leadRef}`;
    dev.sessions([{
      engine: "agy", nativeId: "lead-rec", configDir: "C:/cfg", cwd: "C:/repo",
      title: "主控恢复", state: "idle", liveIn: "background", sendVia: "acp", lastActivityAt: Date.now(),
    }], { full: true });
    await until(() => f.app.cliHub.session(leadKey)?.online, "lead online");

    // 4a. Drop start reply -> dispatch enters `unknown` with persisted `start_op_id`; late reply recovers worker & delivers task.
    const baseOnOp = dev.onOp;
    let droppedStartOpId = "";
    let dropNextStart = true;
    dev.onOp = (message) => {
      if (message.op === "start" && dropNextStart) {
        dropNextStart = false;
        droppedStartOpId = String(message.opId);
        return undefined; // simulate lost receipt
      }
      return baseOnOp(message);
    };

    const s1 = await dev.teamCall(leadRef, "start", { agent: "agy", title: "丢失回执1", body: "恢复启动" });
    expect(s1.ok).toBe(false);
    expect(droppedStartOpId).toBeTruthy();
    const disp1 = f.app.store.get("SELECT status, start_op_id FROM cli_team_dispatches WHERE start_op_id=?", droppedStartOpId);
    expect(disp1).toEqual({ status: "unknown", start_op_id: droppedStartOpId });

    // Reconnect asks device to reconcile unknown opId, and late `cli.reply` binds session_key + delivers task.
    await dev.disconnect();
    await dev.reconnect();
    await until(() => dev.msgs.some((m) => m.type === "cli.resync" && Array.isArray(m.reconcileOps) && m.reconcileOps.includes(droppedStartOpId)), "resync reconcileOps");
    const recoveredRef: CliSessionRef = "agy:w-recovered-1";
    dev.sessions([
      { engine: "agy", nativeId: "lead-rec", configDir: "C:/cfg", cwd: "C:/repo", title: "主控恢复", state: "idle", liveIn: "background", sendVia: "acp", lastActivityAt: Date.now() },
      { engine: "agy", nativeId: "w-recovered-1", configDir: "C:/cfg", cwd: "C:/repo", title: "丢失回执1", state: "idle", liveIn: "background", sendVia: "acp", lastActivityAt: Date.now() },
    ], { full: true });
    dev.send({ type: "cli.reply", opId: droppedStartOpId, ok: true, result: { ref: recoveredRef, cwd: "C:/repo" } });
    await until(() => dev.sentTexts.some((entry) => entry.ref === recoveredRef), "recovered worker received task");

    // 4b. Drop start reply for worker 2, stop worker 2 while unknown, then late reply arrives -> Core stops real device session!
    dropNextStart = true;
    let droppedStopOpId = "";
    dev.onOp = (message) => {
      if (message.op === "start" && dropNextStart) {
        dropNextStart = false;
        droppedStopOpId = String(message.opId);
        return undefined;
      }
      return baseOnOp(message);
    };
    const s2 = await dev.teamCall(leadRef, "start", { agent: "agy", title: "丢失回执2", body: "随后被停止" });
    expect(s2.ok).toBe(false);
    expect((await dev.teamCall(leadRef, "stop", { worker: "agy-2", reason: "取消" })).ok).toBe(true);
    const lateStoppedRef: CliSessionRef = "agy:w-recovered-2";
    dev.send({ type: "cli.reply", opId: droppedStopOpId, ok: true, result: { ref: lateStoppedRef, cwd: "C:/repo" } });
    await until(() => dev.interruptedRefs.includes(lateStoppedRef), "late-discovered stopped worker interrupted on device");

    // 7. Uncertain outbox delivery must NOT mark `cli_team_mail` as `delivered`; late failed (`busy`) reply triggers clean retry.
    let dropLeadSend = true;
    let uncertainSendOpId = "";
    dev.onOp = (message) => {
      if (message.op === "send" && message.args.ref === leadRef && dropLeadSend) {
        dropLeadSend = false;
        uncertainSendOpId = String(message.opId);
        return undefined; // timeout -> uncertain
      }
      return baseOnOp(message);
    };
    const reportRes = await dev.teamCall(recoveredRef, "report", { outcome: "succeeded", body: "汇报测试" });
    expect(reportRes.ok).toBe(true);
    const reportMailId = String(reportRes.data?.mailId);
    await until(() => Boolean(uncertainSendOpId), "lead send reached device");
    await until(() => {
      const m = f.app.store.get("SELECT status, hold_reason, outbox_id FROM cli_team_mail WHERE id=?", reportMailId);
      return m?.status === "queued" && m?.hold_reason === "uncertain" && Boolean(m?.outbox_id);
    }, "mail stays queued/uncertain, not delivered");

    // Late reply confirms transient `busy` failure -> team withdraws failed outbox, lifts pause, retries & delivers!
    dev.send({ type: "cli.reply", opId: uncertainSendOpId, ok: false, error: { code: "busy", message: "busy" } });
    await until(() => {
      const m = f.app.store.get("SELECT status FROM cli_team_mail WHERE id=?", reportMailId);
      return m?.status === "delivered";
    }, "mail retried and delivered after confirmed busy failure");
    expect(dev.sentTexts.filter((entry) => entry.ref === leadRef && entry.text.includes("汇报测试"))).toHaveLength(1);
  });

  it("exposes live harness models, resolves/validates --model upfront, enforces full permissions, and excludes launch failures from maxWorkers", async () => {
    const f = await fixture();
    const dev = await connectDevice(f);
    const leadRef: CliSessionRef = "claude:lead-models";
    const leadKey = `${dev.id}:${leadRef}`;
    dev.sessions([{
      engine: "claude", nativeId: "lead-models", configDir: "C:/cfg", cwd: "C:/repo",
      title: "模型与名额测试", state: "idle", liveIn: "nexbot", sendVia: "inbox", terminal: "hc://lead-models", lastActivityAt: Date.now(),
    }], { full: true });
    await until(() => f.app.cliHub.session(leadKey)?.online, "lead-models online");

    // 1. `nex models` & `nex agents` expose live model catalogs from `hub.models`.
    const modelsAll = await dev.teamCall(leadRef, "models");
    expect(modelsAll.ok).toBe(true);
    expect(modelsAll.text).toContain("MODEL_PLACEHOLDER_M525");
    expect(modelsAll.text).toContain("Gemini 4 Hydrogen");
    expect(modelsAll.text).toContain("gpt-6.2-sol");

    const modelsAgy = await dev.teamCall(leadRef, "models", { agent: "agy" });
    expect(modelsAgy.ok).toBe(true);
    expect(modelsAgy.text).toContain("MODEL_PLACEHOLDER_M525");
    expect(modelsAgy.text).not.toContain("gpt-6.2-sol");

    const agentsRes = await dev.teamCall(leadRef, "agents");
    expect(agentsRes.ok).toBe(true);
    expect(agentsRes.text).toContain("MODEL_PLACEHOLDER_M525");
    expect(agentsRes.text).toContain("full（固定最高权限）");

    // 2. Invalid `--model` is rejected upfront with the live available model list and creates NO worker or run row.
    const badModel = await dev.teamCall(leadRef, "start", { agent: "agy", title: "无效模型", body: "测模型校验", model: "nonexistent-99" });
    expect(badModel.ok).toBe(false);
    expect(badModel.error).toContain("MODEL_PLACEHOLDER_M525");
    expect(dev.started).toHaveLength(0);
    expect((await f.get(`cli-agents/teams?lead=${encodeURIComponent(leadKey)}`)).data.runs).toHaveLength(0);

    // 3. Nicknames / display labels resolve cleanly to exact harness model IDs, and permissions stay forced to "full".
    const byHydrogen = await dev.teamCall(leadRef, "start", {
      agent: "agy", title: "写贪吃蛇", body: "实现贪吃蛇", model: "hydrogen", effort: "high", permissions: "edits",
    });
    expect(byHydrogen.ok).toBe(true);
    expect(dev.started[0]?.model).toBe("MODEL_PLACEHOLDER_M525");
    expect(dev.started[0]?.effort).toBe("high");
    expect(dev.started[0]?.permissions).toBe("full");

    const byCodexLabel = await dev.teamCall(leadRef, "start", {
      agent: "codex", title: "审查", body: "只读审查", model: "6.2 sol", permissions: "readonly",
    });
    expect(byCodexLabel.ok).toBe(true);
    expect(dev.started[1]?.model).toBe("gpt-6.2-sol");
    expect(dev.started[1]?.permissions).toBe("full");

    // 4. Launch-failed workers (`status='failed'`, `session_key=NULL`) MUST NOT consume `maxWorkers` (default 5).
    const baseOnOp = dev.onOp;
    let failStarts = 2;
    dev.onOp = (message) => {
      if (message.op === "start" && failStarts > 0) {
        failStarts--;
        return { ok: false, error: { code: "cwd_missing", message: "simulated launch failure" } };
      }
      return baseOnOp(message);
    };
    const f1 = await dev.teamCall(leadRef, "start", { agent: "agy", title: "失败启动1", body: "模拟失败" });
    const f2 = await dev.teamCall(leadRef, "start", { agent: "agy", title: "失败启动2", body: "模拟失败" });
    expect(f1.ok).toBe(false);
    expect(f2.ok).toBe(false);
    expect(f.app.store.all("SELECT name FROM cli_team_workers WHERE status='failed' AND session_key IS NULL ORDER BY name").map((row) => row.name)).toEqual(["agy-2", "agy-3"]);
    dev.onOp = baseOnOp;

    // Already have 2 live workers + 2 launch-failed workers -> 3 more live workers must STILL succeed (total 5 live)!
    for (let i = 1; i <= 3; i++) {
      const ok = await dev.teamCall(leadRef, "start", { agent: "agy", title: `有效工人${i}`, body: `任务${i}` });
      expect(ok.ok).toBe(true);
    }
    // Now 5 live workers exist -> 6th live worker must hit the cap.
    const overCap = await dev.teamCall(leadRef, "start", { agent: "agy", title: "超限工人", body: "应被拒绝" });
    expect(overCap.ok).toBe(false);
    expect(overCap.error).toContain("上限");

    const statusRes = await dev.teamCall(leadRef, "status");
    expect(statusRes.ok).toBe(true);
    expect(statusRes.text).toContain("有效工人 5/5");
  });
});
