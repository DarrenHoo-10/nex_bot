// Materializes the per-data-dir `bin/` directory (`nex`, `nex.cmd`, `nex.mjs`,
// `nex-mcp.mjs`) and constructs lead instructions and single-launch Codex MCP
// override flags for multi-agent collaboration ("协作", code name `team`).
//
// Zero global CLI config mutations: everything lives inside the executor's own
// data directory and is injected per launched session via PATH/env/argv.
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parsePureNexCommand, type CliTeamDispatchMode } from "../../../shared/cli-team.ts";

/** Returns true when `target` is equal to or lexically inside `root`. */
export function isInsideDir(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const rel = pathApi.relative(fold(pathApi.resolve(root)), fold(pathApi.resolve(target)));
  return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
}

/** Validates a pure standalone `nex` command for ask-mode auto-approval, and
 * ensures any `--file`/`--findings` paths resolve strictly inside `sessionCwd`
 * (including after symlink resolution) so ask mode cannot silently exfiltrate
 * out-of-workspace files without prompting the user. */
export function isSafeAutoApproveNexCommand(
  command: unknown,
  sessionCwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const parsed = parsePureNexCommand(command);
  if (!parsed) return false;
  if (parsed.fileArgs.length === 0) return true;
  if (!sessionCwd) return false;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(sessionCwd)) return false;
  let rootReal: string;
  try {
    rootReal = realpathSync(sessionCwd);
  } catch {
    return false;
  }
  for (const rawPath of parsed.fileArgs) {
    if (!rawPath || rawPath.startsWith("~") || /^[\\/]{2}/.test(rawPath) || rawPath.includes("\0")) return false;
    const candidate = pathApi.resolve(sessionCwd, rawPath);
    if (!isInsideDir(sessionCwd, candidate, platform)) return false;
    try {
      const targetReal = realpathSync(candidate);
      if (!isInsideDir(rootReal, targetReal, platform)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface TeamBinPaths {
  binDir: string;
  mcpScript: string;
}

export const NEX_MCP_TOOL_NAMES = [
  "nex_agents",
  "nex_models",
  "nex_start",
  "nex_status",
  "nex_inbox",
  "nex_send",
  "nex_reply",
  "nex_read",
  "nex_stop",
  "nex_done",
  "nex_guide",
  "nex_task",
  "nex_ask",
  "nex_report",
  "nex_escalate",
  "nex_note",
] as const;

/** Restrained, static lead-session trigger injected ONLY on new sessions
 * (AGY `systemPrompt.append` and Codex `-c developer_instructions=...`; never
 * mutated on resume to preserve KV prefix cache). Detailed rules live in
 * `nex guide` on demand. Empty when dispatch is off. */
export function leadInstruction(mode: CliTeamDispatchMode): string {
  if (mode === "off") return "";
  if (mode === "auto") {
    return "支持 NexAgent 协作模式（`nex` / `nex_*`）：用户要求协作或适合并行/独立审查时，先执行 `nex guide`。";
  }
  return "支持 NexAgent 协作模式（`nex` / `nex_*`）：仅在用户要求多 Agent 协作或独立审查时，先执行 `nex guide`。";
}

/** Single-launch Codex `-c` overrides to mount the out-of-sandbox MCP bridge
 * without modifying `~/.codex/config.toml` (Phase 0 verified). */
export function codexMcpArgs(input: {
  node: string;
  mcpScript: string;
  pipe: string;
  httpUrl?: string | null;
  sessionToken: string;
  allowInAsk: boolean;
}): string[] {
  const envEntries = [
    `ELECTRON_RUN_AS_NODE="1"`,
    `NEX_PIPE=${JSON.stringify(input.pipe)}`,
    `NEX_SESSION=${JSON.stringify(input.sessionToken)}`,
    ...(input.httpUrl ? [`NEX_HTTP=${JSON.stringify(input.httpUrl)}`] : []),
  ];
  const args = [
    "-c", `mcp_servers.nex.command=${JSON.stringify(input.node)}`,
    "-c", `mcp_servers.nex.args=[${JSON.stringify(input.mcpScript)}]`,
    "-c", `mcp_servers.nex.env={${envEntries.join(",")}}`,
  ];
  if (input.allowInAsk) {
    for (const tool of NEX_MCP_TOOL_NAMES) {
      args.push("-c", `mcp_servers.nex.tools.${tool}.approval_mode="approve"`);
    }
  }
  return args;
}

/** Prepends `binDir` onto a PATH string cleanly for the target platform. */
export function prependPath(binDir: string, currentPath: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const sep = platform === "win32" ? ";" : ":";
  const parts = (currentPath ?? "").split(sep).filter(Boolean);
  const norm = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  if (parts.length > 0 && norm(parts[0]!) === norm(binDir)) return parts.join(sep);
  return [binDir, ...parts.filter((part) => norm(part) !== norm(binDir))].join(sep);
}

/** Writes `nex.mjs`, `nex-mcp.mjs`, `nex`, and (on Windows) `nex.cmd` into
 * `<dataDir>/cli-agents-bin/` whenever content changed. Safe across restarts. */
export function ensureTeamBin(dataDir: string, nodePath: string, platform: NodeJS.Platform = process.platform): TeamBinPaths {
  const binDir = path.join(dataDir, "cli-agents-bin");
  mkdirSync(binDir, { recursive: true });
  const mcpScript = path.join(binDir, "nex-mcp.mjs");

  writeIfChanged(path.join(binDir, "nex.mjs"), NEX_CLI_SOURCE);
  writeIfChanged(mcpScript, NEX_MCP_SOURCE);
  writeIfChanged(path.join(binDir, "nex"), posixWrapper(nodePath), 0o755, platform);
  if (platform === "win32") {
    writeIfChanged(path.join(binDir, "nex.cmd"), windowsCmdWrapper(nodePath));
  }
  return { binDir, mcpScript };
}

function writeIfChanged(file: string, content: string, mode?: number, platform: NodeJS.Platform = process.platform): void {
  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // not created yet
  }
  if (existing !== content) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  }
  if (mode !== undefined && platform !== "win32") {
    try {
      chmodSync(file, mode);
    } catch {
      // ignore on filesystems without POSIX modes
    }
  }
}

function windowsCmdWrapper(nodePath: string): string {
  const safeNode = nodePath.replace(/%/g, "%%");
  return [
    "@echo off",
    "setlocal",
    'set "NEX_NODE=%NEXBOT_HOOK_NODE%"',
    `if "%NEX_NODE%"=="" set "NEX_NODE=${safeNode}"`,
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%NEX_NODE%" "%~dp0nex.mjs" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

function posixWrapper(nodePath: string): string {
  const escaped = nodePath.replace(/'/g, "'\\''");
  return [
    "#!/usr/bin/env sh",
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'SCRIPT="$DIR/nex.mjs"',
    "if command -v cygpath >/dev/null 2>&1; then",
    '  SCRIPT="$(cygpath -w "$SCRIPT")"',
    "fi",
    `NODE_BIN="\${NEXBOT_HOOK_NODE:-'${escaped}'}"`,
    'ELECTRON_RUN_AS_NODE=1 exec "$NODE_BIN" "$SCRIPT" "$@"',
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Zero-dependency `nex.mjs` CLI source (executed via ELECTRON_RUN_AS_NODE=1)

const NEX_CLI_SOURCE = `// NexAgent collaboration CLI (zero dependencies, runs inside NexBot sessions).
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";

const MUTATING = new Set(["start", "send", "reply", "stop", "done", "ask", "report", "escalate"]);
const MAX_FILE_BYTES = 64 * 1024;
const TIMEOUT_MS = 65_000;
const REPLY_LIMIT = 2 * 1024 * 1024;

function usage() {
  return [
    "用法: nex <命令> [选项] [--json]",
    "主会话命令: agents | models | start | status | inbox | send | reply | read | stop | done | guide",
    "工人命令:   task | ask | report | escalate | inbox | note",
    "运行 \`nex guide\` 查看完整协作说明。",
  ].join("\\n");
}

function readUtf8File(filePath, label) {
  try {
    const buf = readFileSync(filePath);
    if (buf.length > MAX_FILE_BYTES) {
      throw new Error(\`\${label} 文件超过 64 KB 上限: \${filePath}\`);
    }
    return buf.toString("utf8");
  } catch (error) {
    throw new Error(\`无法读取 \${label} 文件 (\${filePath}): \${error instanceof Error ? error.message : String(error)}\`);
  }
}

function parseCliArgs(argv) {
  let json = false;
  const positional = [];
  const flags = Object.create(null);
  const valueFlags = new Set(["file", "findings", "title", "role", "in", "after", "model", "effort", "permissions", "outcome", "files", "text", "options", "reason", "limit"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq > 2 ? arg.slice(2, eq) : arg.slice(2);
      if (valueFlags.has(name)) {
        const value = eq > 2 ? arg.slice(eq + 1) : argv[++i];
        if (value === undefined) throw new Error(\`选项 --\${name} 缺少参数值\`);
        flags[name] = value;
        continue;
      }
      throw new Error(\`未知选项: --\${name}\`);
    }
    positional.push(arg);
  }
  return { json, positional, flags };
}

function buildPayload(command, positional, flags) {
  const args = {};
  if (command === "start" || command === "models") {
    if (positional[0]) args.agent = positional[0];
  } else if (command === "send" || command === "read" || command === "stop") {
    if (positional[0]) args.worker = positional[0];
  } else if (command === "reply") {
    if (positional[0]) args.mailId = positional[0];
  }

  for (const key of ["title", "role", "in", "after", "model", "effort", "permissions", "outcome", "files", "text", "options", "reason"]) {
    if (flags[key] !== undefined) args[key] = flags[key];
  }
  if (flags.limit !== undefined) {
    const n = Number(flags.limit);
    if (!Number.isFinite(n) || n < 1) throw new Error("--limit 须为正整数");
    args.limit = Math.round(n);
  }
  if (flags.file !== undefined) {
    args.body = readUtf8File(flags.file, "--file");
  }
  if (flags.findings !== undefined) {
    const raw = readUtf8File(flags.findings, "--findings");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("--findings 文件不是有效的 JSON 数组");
    }
    if (!Array.isArray(parsed)) throw new Error("--findings 须为 JSON 数组");
    args.findings = parsed;
  }
  return args;
}

function callPipe(pipe, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let buffer = "";
    const socket = net.connect(pipe);
    const timer = setTimeout(() => {
      finish(new Error(sent ? "UNCERTAIN_TIMEOUT" : "CONNECT_TIMEOUT"));
    }, TIMEOUT_MS);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.on("error", (err) => finish(err));
    socket.on("close", () => finish(new Error(sent ? "UNCERTAIN_CLOSED" : "CONNECT_CLOSED")));
    socket.on("connect", () => {
      sent = true;
      socket.write(JSON.stringify(payload) + "\\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > REPLY_LIMIT) return finish(new Error("REPLY_TOO_LARGE"));
      const end = buffer.indexOf("\\n");
      if (end < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, end)));
      } catch {
        finish(new Error("INVALID_REPLY"));
      }
    });
  });
}

function callHttp(httpUrl, token, payload) {
  return new Promise((resolve, reject) => {
    let sent = false;
    const url = new URL("/team", httpUrl);
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          Authorization: \`Bearer \${token}\`,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size <= REPLY_LIMIT) chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("INVALID_REPLY"));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(sent ? "UNCERTAIN_TIMEOUT" : "CONNECT_TIMEOUT"));
    });
    req.on("error", (err) => reject(err));
    sent = true;
    req.end(body);
  });
}

async function sendRequest(command, args) {
  const pipe = process.env.NEX_PIPE;
  const httpUrl = process.env.NEX_HTTP;
  const token = process.env.NEX_SESSION;
  if (!token || (!pipe && !httpUrl)) {
    throw new Error("只能在 NexBot 启动的会话里使用 nex 命令。");
  }
  const payload = { v: 1, kind: "team", token, command, args };
  if (pipe) {
    try {
      return await callPipe(pipe, payload);
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (httpUrl && (code === "EPERM" || code === "EACCES" || code === "ENOENT")) {
        return await callHttp(httpUrl, token, payload);
      }
      throw error;
    }
  }
  return await callHttp(httpUrl, token, payload);
}

async function main() {
  const { json, positional, flags } = parseCliArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || flags.help) {
    process.stdout.write(usage() + "\\n");
    process.exit(0);
  }
  const args = buildPayload(command, positional.slice(1), flags);
  let reply;
  try {
    reply = await sendRequest(command, args);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (MUTATING.has(command) && msg.startsWith("UNCERTAIN_")) {
      const uncertain = { ok: false, uncertain: true, error: "结果待确认，请运行 \`nex status\` 或 \`nex inbox\` 确认，不要盲目重试。" };
      if (json) process.stdout.write(JSON.stringify(uncertain, null, 2) + "\\n");
      else process.stderr.write(uncertain.error + "\\n");
      process.exit(2);
    }
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + "\\n");
    else process.stderr.write(msg + "\\n");
    process.exit(1);
  }

  if (reply && reply.uncertain && MUTATING.has(command)) {
    const uncertain = { ok: false, uncertain: true, error: reply.error || "结果待确认，请运行 \`nex status\` 或 \`nex inbox\` 确认，不要盲目重试。" };
    if (json) process.stdout.write(JSON.stringify(uncertain, null, 2) + "\\n");
    else process.stderr.write(uncertain.error + "\\n");
    process.exit(2);
  }
  if (json) {
    process.stdout.write(JSON.stringify(reply, null, 2) + "\\n");
    process.exit(reply && reply.ok ? 0 : 1);
  }
  if (reply && reply.ok) {
    if (typeof reply.text === "string" && reply.text) process.stdout.write(reply.text + "\\n");
    process.exit(0);
  }
  process.stderr.write((reply && typeof reply.error === "string" ? reply.error : "协作命令失败") + "\\n");
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
  process.exit(1);
});
`;

// ---------------------------------------------------------------------------
// Zero-dependency `nex-mcp.mjs` stdio MCP server (for Codex sandbox / ask / readonly)

const NEX_MCP_SOURCE = `// Thin stdio MCP bridge for NexAgent collaboration (runs outside Codex sandbox).
// Security boundary: NEVER reads local file paths on behalf of a sandboxed model;
// callers pass UTF-8 strings inline via JSON tool arguments (body/text).
import http from "node:http";
import net from "node:net";

const TIMEOUT_MS = 65_000;
const REPLY_LIMIT = 2 * 1024 * 1024;

const TOOLS = [
  { name: "nex_guide", command: "guide", description: "打印当前版本的多 Agent 协作完整指南与规则。", inputSchema: { type: "object", properties: {} } },
  { name: "nex_agents", command: "agents", description: "查看本机可派活的 Agent 及各引擎当前可用模型 ID（所有工人固定以最高权限启动）。", inputSchema: { type: "object", properties: {} } },
  {
    name: "nex_models", command: "models", description: "查看指定（或全部）Agent 当前可用模型 ID、名称与推理强度，启动协作前用于选择准确 model。",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string", enum: ["claude", "codex", "agy"] } },
    },
  },
  {
    name: "nex_start", command: "start", description: "以最高权限模式派出一个协作工人（仅主会话可用）；指定 model 时请先从 nex_agents / nex_models 获取准确模型 ID。",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["claude", "codex", "agy"] },
        title: { type: "string" },
        body: { type: "string", description: "任务说明正文（直接传 UTF-8 字符串）" },
        role: { type: "string" },
        in: { type: "string", description: "here | worktree | <工人名>" },
        after: { type: "string", description: "逗号分隔的依赖工人名" },
        model: { type: "string", description: "来自 nex_agents / nex_models 的精确模型 ID" },
        effort: { type: "string" },
      },
      required: ["agent", "title", "body"],
    },
  },
  { name: "nex_status", command: "status", description: "查看当前协作及所有工人状态。", inputSchema: { type: "object", properties: {} } },
  { name: "nex_inbox", command: "inbox", description: "读取未读协作消息并标记已读。", inputSchema: { type: "object", properties: {} } },
  {
    name: "nex_send", command: "send", description: "向已有工人发送跟进或补充说明（仅主会话可用）。",
    inputSchema: {
      type: "object",
      properties: { worker: { type: "string" }, body: { type: "string", description: "消息正文（直接传 UTF-8 字符串）" } },
      required: ["worker", "body"],
    },
  },
  {
    name: "nex_reply", command: "reply", description: "回答工人的提问（仅主会话可用）。",
    inputSchema: {
      type: "object",
      properties: { mailId: { type: "string" }, text: { type: "string", description: "答复内容" } },
      required: ["mailId", "text"],
    },
  },
  {
    name: "nex_read", command: "read", description: "读取指定工人最近的对话记录（仅主会话可用）。",
    inputSchema: {
      type: "object",
      properties: { worker: { type: "string" }, limit: { type: "integer" } },
      required: ["worker"],
    },
  },
  {
    name: "nex_stop", command: "stop", description: "停止指定工人（仅主会话可用）。",
    inputSchema: {
      type: "object",
      properties: { worker: { type: "string" }, reason: { type: "string" } },
      required: ["worker"],
    },
  },
  {
    name: "nex_done", command: "done", description: "所有工人结算后结束协作并保存交付摘要（仅主会话可用）。",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string", description: "交付摘要正文" } },
      required: ["body"],
    },
  },
  { name: "nex_task", command: "task", description: "读取分配给当前工人的规则、任务说明和补充消息。", inputSchema: { type: "object", properties: {} } },
  {
    name: "nex_ask", command: "ask", description: "向主会话提问并结束本轮等待答复（工人用）。",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, options: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "nex_report", command: "report", description: "向主会话提交本次任务的最终汇报（工人用）。",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["succeeded", "failed"] },
        body: { type: "string", description: "汇报正文（直接传 UTF-8 字符串）" },
        files: { type: "array", items: { type: "string" } },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: { severity: { type: "string" }, file: { type: "string" }, line: { type: "integer" }, issue: { type: "string" } },
            required: ["file", "issue"],
          },
        },
      },
      required: ["outcome", "body"],
    },
  },
  {
    name: "nex_escalate", command: "escalate", description: "任务卡住时向主会话升级求助（工人用）。",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string", description: "升级说明正文" } },
      required: ["body"],
    },
  },
  {
    name: "nex_note", command: "note", description: "记录进度备注，不叫醒主会话（工人用）。",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function callPipe(pipe, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let buffer = "";
    const socket = net.connect(pipe);
    const timer = setTimeout(() => finish(new Error(sent ? "UNCERTAIN_TIMEOUT" : "CONNECT_TIMEOUT")), TIMEOUT_MS);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.on("error", (err) => finish(err));
    socket.on("close", () => finish(new Error(sent ? "UNCERTAIN_CLOSED" : "CONNECT_CLOSED")));
    socket.on("connect", () => {
      sent = true;
      socket.write(JSON.stringify(payload) + "\\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > REPLY_LIMIT) return finish(new Error("返回内容过大"));
      const end = buffer.indexOf("\\n");
      if (end < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, end)));
      } catch {
        finish(new Error("返回格式无效"));
      }
    });
  });
}

function callHttp(httpUrl, token, payload) {
  return new Promise((resolve, reject) => {
    let sent = false;
    const url = new URL("/team", httpUrl);
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          Authorization: \`Bearer \${token}\`,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size <= REPLY_LIMIT) chunks.push(chunk);
        });
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(new Error("返回格式无效")); }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(sent ? "UNCERTAIN_TIMEOUT" : "CONNECT_TIMEOUT")));
    req.on("error", reject);
    sent = true;
    req.end(body);
  });
}

async function invokeTeam(command, rawArgs) {
  const pipe = process.env.NEX_PIPE;
  const httpUrl = process.env.NEX_HTTP;
  const token = process.env.NEX_SESSION;
  if (!token || (!pipe && !httpUrl)) {
    return { ok: false, error: "只能在 NexBot 启动的会话里使用 nex 工具。" };
  }
  const args = { ...(rawArgs && typeof rawArgs === "object" ? rawArgs : {}) };
  if (args.file !== undefined) {
    return { ok: false, error: "MCP 工具不支持直接读取本地文件路径，请将正文内容通过 body 或 text 参数传入。" };
  }
  const payload = { v: 1, kind: "team", token, command, args };
  if (pipe) {
    try {
      return await callPipe(pipe, payload);
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      const msg = error instanceof Error ? error.message : String(error);
      // Only fall back to loopback HTTP when connecting failed BEFORE sending, never after a mutating write.
      if (httpUrl && !msg.startsWith("UNCERTAIN_") && (code === "EPERM" || code === "EACCES" || code === "ENOENT")) {
        return await callHttp(httpUrl, token, payload);
      }
      if (msg.startsWith("UNCERTAIN_")) {
        return { ok: false, uncertain: true, error: "结果待确认，请调用 nex_status 或 nex_inbox 确认，不要盲目重试。" };
      }
      return { ok: false, error: msg };
    }
  }
  try {
    return await callHttp(httpUrl, token, payload);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith("UNCERTAIN_")) {
      return { ok: false, uncertain: true, error: "结果待确认，请调用 nex_status 或 nex_inbox 确认，不要盲目重试。" };
    }
    return { ok: false, error: msg };
  }
}

let useContentLength = false;

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLength) {
    const len = Buffer.byteLength(json, "utf8");
    process.stdout.write(\`Content-Length: \${len}\\r\\n\\r\\n\${json}\`);
  } else {
    process.stdout.write(json + "\\n");
  }
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;
  if (method === "notifications/initialized" || id === undefined) return;

  if (method === "initialize") {
    const protocolVersion = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "nex", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "tools/list") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    });
    return;
  }

  if (method === "tools/call") {
    const name = params && typeof params.name === "string" ? params.name : "";
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      writeMessage({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: \`未知工具: \${name}\` }] } });
      return;
    }
    const reply = await invokeTeam(tool.command, params?.arguments ?? {});
    const text = reply && reply.ok ? (reply.text || JSON.stringify(reply.data ?? {})) : (reply?.error || "协作命令失败");
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        ...(reply && reply.ok ? {} : { isError: true }),
        content: [{ type: "text", text }],
      },
    });
    return;
  }

  writeMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: \`Method not found: \${String(method)}\` } });
}

let rawBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  rawBuf = Buffer.concat([rawBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  drain();
});

function drain() {
  for (;;) {
    // Strip leading CR/LF between frames
    while (rawBuf.length > 0 && (rawBuf[0] === 0x0a || rawBuf[0] === 0x0d)) {
      rawBuf = rawBuf.subarray(1);
    }
    if (rawBuf.length === 0) return;

    // Content-Length framed JSON-RPC
    if (rawBuf.subarray(0, 15).toString("ascii").toLowerCase().startsWith("content-length:")) {
      const sepIdx = rawBuf.indexOf("\\r\\n\\r\\n");
      if (sepIdx < 0) return;
      const header = rawBuf.subarray(0, sepIdx).toString("ascii");
      const match = /content-length:\\s*(\\d+)/i.exec(header);
      if (!match) {
        rawBuf = rawBuf.subarray(sepIdx + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = sepIdx + 4;
      if (rawBuf.length < start + len) return;
      useContentLength = true;
      const payload = rawBuf.subarray(start, start + len).toString("utf8");
      rawBuf = rawBuf.subarray(start + len);
      try {
        void handleRequest(JSON.parse(payload));
      } catch {
        // ignore malformed frame
      }
      continue;
    }

    // Newline-delimited JSON-RPC (Codex stdio MCP default)
    const nl = rawBuf.indexOf(0x0a);
    if (nl < 0) return;
    const line = rawBuf.subarray(0, nl).toString("utf8").trim();
    rawBuf = rawBuf.subarray(nl + 1);
    if (!line) continue;
    try {
      void handleRequest(JSON.parse(line));
    } catch {
      // ignore malformed frame
    }
  }
}
`;
