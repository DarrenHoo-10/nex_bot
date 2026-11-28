// Isolated local interactive preview for the NexAgent multi-agent collaboration ("协作") UI.
// Serves the real personal.html frontend through Vite with an in-memory mock Core HTTP + WS API.
// Does not touch real databases, devices, or production Core.
import { createServer as createHttpServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.NEXAGENT_TEAM_PREVIEW_PORT) || 5299;
const DEVICE_ID = "dev-win";
const NOW = Date.now();
const min = (n) => NOW - n * 60_000;
const hour = (n) => NOW - n * 3_600_000;

function teamCardText(meta, body = "") {
  return `<!--nexagent-team:${JSON.stringify(meta)}-->\n${body}`.trim();
}

const LEAD_1 = `${DEVICE_ID}:claude:lead-rate-limit`;
const W_AGY_1 = `${DEVICE_ID}:agy:worker-agy-1`;
const W_CODEX_1 = `${DEVICE_ID}:codex:worker-codex-1`;
const W_CLAUDE_TEST = `${DEVICE_ID}:claude:worker-claude-1`;
const W_HIST_1 = `${DEVICE_ID}:codex:hist-research-1`;
const W_HIST_2 = `${DEVICE_ID}:agy:hist-bench-1`;

const LEAD_2 = `${DEVICE_ID}:claude:lead-cache-compare`;
const W_CMP_A = `${DEVICE_ID}:agy:cmp-agy-1`;
const W_CMP_B = `${DEVICE_ID}:codex:cmp-codex-1`;

const LEAD_3 = `${DEVICE_ID}:codex:lead-payment-idempotent`;
const FORK_3 = `${DEVICE_ID}:codex:fork-payment-edge`;
const W_PAY_FAIL = `${DEVICE_ID}:agy:pay-agy-fail`;

const devices = [
  {
    id: DEVICE_ID,
    name: "办公电脑 (Windows)",
    online: true,
    cliAgents: {
      version: 1,
      engines: ["claude", "codex", "agy"],
      forkEngines: ["claude", "codex"],
      features: ["search", "launchOptions", "attach", "models", "dirs", "permissions", "permissionModes", "skills", "gitBranch", "sessionManage"],
      terminal: { name: "herdr-core", version: "0.1.21", ready: true },
    },
  },
];

let sessions = [
  // Lead 1: active run (3 workers) + 1 historical finished run (2 workers)
  {
    key: LEAD_1,
    deviceId: DEVICE_ID,
    engine: "claude",
    nativeId: "lead-rate-limit",
    configDir: "~/.claude",
    cwd: "D:\\ProgrammingProjects\\nex_bot",
    repoRoot: "D:\\ProgrammingProjects\\nex_bot",
    title: "登录接口限流方案",
    gitBranch: "feat/login-rate-limit",
    state: "idle",
    liveIn: "nexbot",
    terminal: "pane-lead-1",
    sendVia: "terminal",
    model: "opus",
    context: { used: 68_400, window: 200_000 },
    lastActivityAt: min(1),
    hidden: false,
    online: true,
  },
  {
    key: W_AGY_1,
    deviceId: DEVICE_ID,
    engine: "agy",
    nativeId: "worker-agy-1",
    configDir: "~/.gemini",
    cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1",
    repoRoot: "D:\\ProgrammingProjects\\nex_bot",
    title: "实现登录限流中间件",
    gitBranch: "team/login-rate-limit/agy-1",
    state: "running",
    liveIn: "background",
    sendVia: "acp",
    model: "gemini-4-neon",
    context: { used: 42_000, window: 200_000 },
    lastActivityAt: min(0.5),
    hidden: false,
    online: true,
  },
  {
    key: W_CODEX_1,
    deviceId: DEVICE_ID,
    engine: "codex",
    nativeId: "worker-codex-1",
    configDir: "~/.codex",
    cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1",
    repoRoot: "D:\\ProgrammingProjects\\nex_bot",
    title: "审查登录限流",
    gitBranch: "team/login-rate-limit/agy-1",
    state: "idle",
    liveIn: "nexbot",
    terminal: "pane-codex-1",
    sendVia: "terminal",
    model: "gpt-6.2-sol",
    context: { used: 31_500, window: 200_000 },
    lastActivityAt: min(2),
    hidden: false,
    online: true,
  },
  {
    key: W_CLAUDE_TEST,
    deviceId: DEVICE_ID,
    engine: "claude",
    nativeId: "worker-claude-1",
    configDir: "~/.claude",
    cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1",
    repoRoot: "D:\\ProgrammingProjects\\nex_bot",
    title: "补充 Redis 降级单测",
    gitBranch: "team/login-rate-limit/agy-1",
    state: "waiting",
    waitingFor: "等待批准命令执行",
    liveIn: "nexbot",
    terminal: "pane-claude-test",
    sendVia: "terminal",
    model: "sonnet",
    context: { used: 24_800, window: 200_000 },
    lastActivityAt: min(1.2),
    hidden: false,
    online: true,
  },
  // Historical run workers under Lead 1 (folded under 历史协作 2)
  {
    key: W_HIST_1,
    deviceId: DEVICE_ID,
    engine: "codex",
    nativeId: "hist-research-1",
    configDir: "~/.codex",
    cwd: "D:\\ProgrammingProjects\\nex_bot",
    repoRoot: "D:\\ProgrammingProjects\\nex_bot",
    title: "调研滑动窗口与令牌桶",
    gitBranch: "feat/login-rate-limit",
    state: "stopped",
    liveIn: "nexbot",
    model: "gpt-6.2-astra",
    lastActivityAt: hour(5),
    hidden: false,
    online: true,
  },
  {
    key: W_HIST_2,
    deviceId: DEVICE_ID,
    engine: "agy",
    nativeId: "hist-bench-1",
    configDir: "~/.gemini",
    cwd: "D:\\ProgrammingProjects\\nex_bot",
    repoRoot: "D:\\ProgrammingProjects\\nex_bot",
    title: "编写压测基线脚本",
    gitBranch: "feat/login-rate-limit",
    state: "stopped",
    liveIn: "background",
    sendVia: "acp",
    model: "gemini-4-neon",
    lastActivityAt: hour(4.5),
    hidden: false,
    online: true,
  },
  // Lead 2: recently finished collaboration (kept expanded directly under lead)
  {
    key: LEAD_2,
    deviceId: DEVICE_ID,
    engine: "claude",
    nativeId: "lead-cache-compare",
    configDir: "~/.claude",
    cwd: "D:\\ProgrammingProjects\\nex_bot",
    repoRoot: "D:\\ProgrammingProjects\\nex_bot",
    title: "缓存穿透双方案对比",
    gitBranch: "main",
    state: "idle",
    liveIn: "nexbot",
    terminal: "pane-lead-2",
    sendVia: "terminal",
    model: "opus",
    lastActivityAt: min(25),
    hidden: false,
    online: true,
  },
  {
    key: W_CMP_A,
    deviceId: DEVICE_ID,
    engine: "agy",
    nativeId: "cmp-agy-1",
    configDir: "~/.gemini",
    cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-cache-agy-1",
    repoRoot: "D:\\ProgrammingProjects\\nex_bot",
    title: "布隆过滤器方案实现",
    gitBranch: "team/cache-compare/agy-1",
    state: "idle",
    liveIn: "background",
    sendVia: "acp",
    lastActivityAt: min(28),
    hidden: false,
    online: true,
  },
  {
    key: W_CMP_B,
    deviceId: DEVICE_ID,
    engine: "codex",
    nativeId: "cmp-codex-1",
    configDir: "~/.codex",
    cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-cache-codex-1",
    repoRoot: "D:\\ProgrammingProjects\\nex_bot",
    title: "Singleflight 空值缓存实现",
    gitBranch: "team/cache-compare/codex-1",
    state: "idle",
    liveIn: "nexbot",
    lastActivityAt: min(26),
    hidden: false,
    online: true,
  },
  // Lead 3: Codex lead in another repo + fork + cross-directory failed worker
  {
    key: LEAD_3,
    deviceId: DEVICE_ID,
    engine: "codex",
    nativeId: "lead-payment-idempotent",
    configDir: "~/.codex",
    cwd: "D:\\ProgrammingProjects\\nex_pay",
    repoRoot: "D:\\ProgrammingProjects\\nex_pay",
    title: "支付回调幂等重构",
    gitBranch: "fix/payment-idempotent",
    state: "idle",
    liveIn: "nexbot",
    terminal: "pane-lead-3",
    sendVia: "terminal",
    model: "gpt-6.2-sol",
    lastActivityAt: hour(2),
    hidden: false,
    online: true,
  },
  {
    key: FORK_3,
    deviceId: DEVICE_ID,
    engine: "codex",
    nativeId: "fork-payment-edge",
    configDir: "~/.codex",
    cwd: "D:\\ProgrammingProjects\\nex_pay",
    repoRoot: "D:\\ProgrammingProjects\\nex_pay",
    title: "排查超时重试边界（fork）",
    forkOf: "lead-payment-idempotent",
    gitBranch: "fix/payment-idempotent",
    state: "idle",
    liveIn: "nexbot",
    lastActivityAt: hour(1.8),
    hidden: false,
    online: true,
  },
  {
    key: W_PAY_FAIL,
    deviceId: DEVICE_ID,
    engine: "agy",
    nativeId: "pay-agy-fail",
    configDir: "~/.gemini",
    cwd: "D:\\Temp\\sandbox-verify",
    title: "回归支付沙箱对账脚本",
    state: "stopped",
    liveIn: "background",
    sendVia: "acp",
    lastActivityAt: hour(1.5),
    hidden: false,
    online: true,
  },
];

let workbench = [
  { id: "wb-lead-1", sessionKey: LEAD_1, deviceId: DEVICE_ID, engine: "claude", cwd: "D:\\ProgrammingProjects\\nex_bot", parentId: null, kind: "main", title: "登录接口限流方案", archived: false, deleted: false, version: 1, createdAt: hour(6), updatedAt: min(1) },
  { id: "wb-w-agy-1", sessionKey: W_AGY_1, deviceId: DEVICE_ID, engine: "agy", cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1", parentId: "wb-lead-1", kind: "worker", title: "实现登录限流中间件", archived: false, deleted: false, version: 1, createdAt: min(15), updatedAt: min(0.5) },
  { id: "wb-w-codex-1", sessionKey: W_CODEX_1, deviceId: DEVICE_ID, engine: "codex", cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1", parentId: "wb-lead-1", kind: "worker", title: "审查登录限流", archived: false, deleted: false, version: 1, createdAt: min(8), updatedAt: min(2) },
  { id: "wb-w-claude-1", sessionKey: W_CLAUDE_TEST, deviceId: DEVICE_ID, engine: "claude", cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1", parentId: "wb-lead-1", kind: "worker", title: "补充 Redis 降级单测", archived: false, deleted: false, version: 1, createdAt: min(5), updatedAt: min(1.2) },
  { id: "wb-hist-1", sessionKey: W_HIST_1, deviceId: DEVICE_ID, engine: "codex", cwd: "D:\\ProgrammingProjects\\nex_bot", parentId: "wb-lead-1", kind: "worker", title: "调研滑动窗口与令牌桶", archived: false, deleted: false, version: 1, createdAt: hour(6), updatedAt: hour(5) },
  { id: "wb-hist-2", sessionKey: W_HIST_2, deviceId: DEVICE_ID, engine: "agy", cwd: "D:\\ProgrammingProjects\\nex_bot", parentId: "wb-lead-1", kind: "worker", title: "编写压测基线脚本", archived: false, deleted: false, version: 1, createdAt: hour(5.5), updatedAt: hour(4.5) },

  { id: "wb-lead-2", sessionKey: LEAD_2, deviceId: DEVICE_ID, engine: "claude", cwd: "D:\\ProgrammingProjects\\nex_bot", parentId: null, kind: "main", title: "缓存穿透双方案对比", archived: false, deleted: false, version: 1, createdAt: hour(1), updatedAt: min(25) },
  { id: "wb-cmp-a", sessionKey: W_CMP_A, deviceId: DEVICE_ID, engine: "agy", cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-cache-agy-1", parentId: "wb-lead-2", kind: "worker", title: "布隆过滤器方案实现", archived: false, deleted: false, version: 1, createdAt: min(45), updatedAt: min(28) },
  { id: "wb-cmp-b", sessionKey: W_CMP_B, deviceId: DEVICE_ID, engine: "codex", cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-cache-codex-1", parentId: "wb-lead-2", kind: "worker", title: "Singleflight 空值缓存实现", archived: false, deleted: false, version: 1, createdAt: min(44), updatedAt: min(26) },

  { id: "wb-lead-3", sessionKey: LEAD_3, deviceId: DEVICE_ID, engine: "codex", cwd: "D:\\ProgrammingProjects\\nex_pay", parentId: null, kind: "main", title: "支付回调幂等重构", archived: false, deleted: false, version: 1, createdAt: hour(3), updatedAt: hour(2) },
  { id: "wb-fork-3", sessionKey: FORK_3, deviceId: DEVICE_ID, engine: "codex", cwd: "D:\\ProgrammingProjects\\nex_pay", parentId: "wb-lead-3", kind: "fork", title: "排查超时重试边界（fork）", archived: false, deleted: false, version: 1, createdAt: hour(2.2), updatedAt: hour(1.8) },
  { id: "wb-pay-fail", sessionKey: W_PAY_FAIL, deviceId: DEVICE_ID, engine: "agy", cwd: "D:\\Temp\\sandbox-verify", parentId: "wb-lead-3", kind: "worker", title: "回归支付沙箱对账脚本", archived: false, deleted: false, version: 1, createdAt: hour(2), updatedAt: hour(1.5) },
];

let teamRuns = [
  {
    id: "team_run_login_2",
    leadKey: LEAD_1,
    title: "登录限流实现与审查",
    status: "active",
    limit: 5,
    createdAt: min(15),
    updatedAt: min(0.5),
    workers: [
      {
        id: "wk-agy-1",
        runId: "team_run_login_2",
        name: "agy-1",
        engine: "agy",
        sessionKey: W_AGY_1,
        cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1",
        role: "实现",
        title: "实现登录限流中间件",
        permissions: "full",
        model: "gemini-4-neon",
        status: "running",
        context: { used: 42_000, window: 200_000 },
        createdAt: min(15),
        updatedAt: min(0.5),
      },
      {
        id: "wk-codex-1",
        runId: "team_run_login_2",
        name: "codex-1",
        engine: "codex",
        sessionKey: W_CODEX_1,
        cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1",
        role: "审查",
        title: "审查登录限流",
        permissions: "readonly",
        model: "gpt-6.2-sol",
        status: "reported",
        findingsCount: 2,
        context: { used: 31_500, window: 200_000 },
        createdAt: min(8),
        updatedAt: min(2),
      },
      {
        id: "wk-claude-1",
        runId: "team_run_login_2",
        name: "claude-1",
        engine: "claude",
        sessionKey: W_CLAUDE_TEST,
        cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1",
        role: "测试",
        title: "补充 Redis 降级单测",
        permissions: "ask",
        model: "sonnet",
        status: "waiting",
        context: { used: 24_800, window: 200_000 },
        createdAt: min(5),
        updatedAt: min(1.2),
      },
    ],
  },
  {
    id: "team_run_login_1",
    leadKey: LEAD_1,
    title: "限流算法预研与压测基线",
    status: "finished",
    limit: 5,
    summary: "已对比固定窗口与滑动日志，基线 QPS 4200，确定采用 Redis ZSET 滑动窗口 + 本地内存降级。",
    createdAt: hour(6),
    updatedAt: hour(4.5),
    finishedAt: hour(4.5),
    workers: [
      {
        id: "wk-hist-1",
        runId: "team_run_login_1",
        name: "codex-1",
        engine: "codex",
        sessionKey: W_HIST_1,
        cwd: "D:\\ProgrammingProjects\\nex_bot",
        role: "调研",
        title: "调研滑动窗口与令牌桶",
        permissions: "readonly",
        status: "reported",
        createdAt: hour(6),
        updatedAt: hour(5),
      },
      {
        id: "wk-hist-2",
        runId: "team_run_login_1",
        name: "agy-1",
        engine: "agy",
        sessionKey: W_HIST_2,
        cwd: "D:\\ProgrammingProjects\\nex_bot",
        role: "压测",
        title: "编写压测基线脚本",
        permissions: "full",
        status: "reported",
        createdAt: hour(5.5),
        updatedAt: hour(4.5),
      },
    ],
  },
  {
    id: "team_run_cache_1",
    leadKey: LEAD_2,
    title: "双方案对比（布隆 vs Singleflight）",
    status: "finished",
    limit: 5,
    summary: "两版均已跑通基准测试，最终推荐 Singleflight + 30s 短空值缓存，无需额外维护布隆过滤器同步。",
    createdAt: min(45),
    updatedAt: min(25),
    finishedAt: min(25),
    workers: [
      {
        id: "wk-cmp-a",
        runId: "team_run_cache_1",
        name: "agy-1",
        engine: "agy",
        sessionKey: W_CMP_A,
        cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-cache-agy-1",
        role: "方案 A",
        title: "布隆过滤器方案实现",
        permissions: "full",
        status: "reported",
        createdAt: min(45),
        updatedAt: min(28),
      },
      {
        id: "wk-cmp-b",
        runId: "team_run_cache_1",
        name: "codex-1",
        engine: "codex",
        sessionKey: W_CMP_B,
        cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-cache-codex-1",
        role: "方案 B",
        title: "Singleflight 空值缓存实现",
        permissions: "full",
        status: "reported",
        createdAt: min(44),
        updatedAt: min(26),
      },
    ],
  },
  {
    id: "team_run_pay_1",
    leadKey: LEAD_3,
    title: "支付沙箱回归验证",
    status: "finished",
    limit: 5,
    summary: "沙箱环境变量缺失导致回归脚本启动失败，待补齐凭据后重跑。",
    createdAt: hour(2),
    updatedAt: hour(1.5),
    finishedAt: hour(1.5),
    workers: [
      {
        id: "wk-pay-fail",
        runId: "team_run_pay_1",
        name: "agy-1",
        engine: "agy",
        sessionKey: W_PAY_FAIL,
        cwd: "D:\\Temp\\sandbox-verify",
        role: "回归",
        title: "回归支付沙箱对账脚本",
        permissions: "ask",
        status: "failed",
        createdAt: hour(2),
        updatedAt: hour(1.5),
      },
    ],
  },
];

let pendingRequests = [
  {
    id: "req-claude-test-1",
    key: W_CLAUDE_TEST,
    kind: "permission",
    tool: "Bash",
    summary: "pnpm vitest run server/auth/rate-limit.test.ts",
    detail: JSON.stringify({ command: "pnpm vitest run server/auth/rate-limit.test.ts", cwd: "D:\\ProgrammingProjects\\.nexbot-worktrees\\nex_bot\\team-login-agy-1" }, null, 2),
    always: true,
    createdAt: min(1.2),
    expiresAt: NOW + 3_600_000,
  },
];

let teamSettings = {
  dispatchMode: "prompt",
  maxWorkers: 5,
  allowNexInAsk: true,
  enabledEngines: ["claude", "codex", "agy"],
  installedEngines: ["claude", "codex", "agy"],
  defaultPermissions: { claude: "default", codex: "readonly", agy: "full" },
  limits: { mailPerHour: 60, idlePauseHours: 24, circuitBreakerFailures: 3 },
};

const transcripts = {
  [LEAD_1]: [
    { kind: "user", id: "l1-u1", ts: min(18), text: "方案你出，实现交给 agy，做完让 codex 只读审查，再派一个 claude 补 Redis 降级单测，最后给我结果。" },
    {
      kind: "assistant",
      id: "l1-a1",
      ts: min(16),
      replyPhase: "final",
      text: "收到，我已梳理现有登录路由与 Redis 客户端结构，方案写入 `plan.md`：\n\n1. **限流键**：按 `ip` + `account` 双维度计数（IP 30 次/分钟，账号 8 次/5 分钟）。\n2. **滑动窗口**：Redis Lua 脚本原子执行 `ZREMRANGEBYSCORE` + `ZCARD` + `ZADD`，并写入 `Retry-After` 响应头。\n3. **故障降级**：Redis 超时超过 150ms 自动切回进程内 LRU 计数桶，不阻断正常登录。\n\n我现在把实现任务派给 **AGY**。",
    },
    {
      kind: "user",
      id: "l1-card-1",
      ts: min(15),
      text: teamCardText({
        kind: "task",
        heading: "主会话 → AGY · 实现",
        subtitle: "实现登录限流中间件",
        actorEngine: "claude",
        targetSessionKey: W_AGY_1,
        role: "实现",
      }, "按 `plan.md` 在新 worktree `team/login-rate-limit/agy-1` 中实现 `server/auth/rate-limit.ts` 及登录路由接入，并覆盖基础单测。"),
    },
    {
      kind: "user",
      id: "l1-card-2",
      ts: min(9),
      text: teamCardText({
        kind: "report",
        heading: "AGY · 完成报告",
        subtitle: "实现登录限流中间件",
        actorEngine: "agy",
        sourceSessionKey: W_AGY_1,
        role: "实现",
        outcome: "succeeded",
        files: ["server/auth/rate-limit.ts", "server/auth/login-route.ts", "server/auth/rate-limit.test.ts"],
      }, "已完成双维度 Redis 滑动窗口限流与本地降级桶，基础 14 条用例通过；等待主控安排审查。"),
    },
    {
      kind: "user",
      id: "l1-card-3",
      ts: min(2),
      text: teamCardText({
        kind: "review",
        heading: "Codex · 审查：2 个问题",
        subtitle: "只读审查 · agy-1 工作树",
        actorEngine: "codex",
        sourceSessionKey: W_CODEX_1,
        role: "审查",
        outcome: "succeeded",
        findings: [
          { severity: "high", file: "server/auth/rate-limit.ts", line: 84, issue: "X-Forwarded-For 未校验可信代理列表，客户端可伪造 IP 绕过限流。" },
          { severity: "medium", file: "server/auth/rate-limit.ts", line: 129, issue: "Redis 降级切换时未重置本地桶过期计时器，可能造成首分钟放宽 2 倍配额。" },
        ],
      }, "其余 Lua 脚本原子性与响应头处理符合方案要求。"),
    },
    {
      kind: "user",
      id: "l1-card-4",
      ts: min(1),
      text: teamCardText({
        kind: "followup",
        heading: "主会话 → AGY · 修改要求",
        subtitle: "跟进修复 2 项审查问题",
        actorEngine: "claude",
        targetSessionKey: W_AGY_1,
        role: "实现",
      }, "请优先修复 Codex 指出的两处问题：1）从已配置 `trustedProxies` 提取真实 IP；2）降级切入本地桶时严格按窗口截止时间对齐。同时已派 `claude-1` 补充 Redis 降级单测。"),
    },
    {
      kind: "assistant",
      id: "l1-a2",
      ts: min(0.8),
      replyPhase: "final",
      text: "已将 Codex 的 2 条审查意见转给 `agy-1` 修复，并并行派 `claude-1` 补齐 Redis 降级路径单测（当前 `claude-1` 有一条命令审批等待你确认）。修复完成后我会再请 `codex-1` 复审。",
    },
  ],
  [W_AGY_1]: [
    {
      kind: "user",
      id: "w1-card-1",
      ts: min(15),
      text: teamCardText({
        kind: "task",
        heading: "主会话 · 任务派发",
        subtitle: "实现登录限流中间件",
        actorEngine: "claude",
        sourceSessionKey: LEAD_1,
        role: "实现",
      }, "请按 `plan.md` 实现登录限流中间件与路由接入；完成后运行 `nex report` 汇报改动文件与测试结果。"),
    },
    { kind: "tool", id: "w1-t1", ts: min(13), name: "write_file", input: "server/auth/rate-limit.ts", status: "ok", output: "Created 164 lines" },
    { kind: "tool", id: "w1-t2", ts: min(11), name: "Bash", input: "pnpm vitest run server/auth/rate-limit.test.ts", status: "ok", output: "14 passed (14)" },
    {
      kind: "assistant",
      id: "w1-a1",
      ts: min(9),
      replyPhase: "final",
      text: "已完成首版实现并通过 14 条单元测试，已调用 `nex report` 汇报给主会话。",
    },
    {
      kind: "user",
      id: "w1-card-2",
      ts: min(1),
      text: teamCardText({
        kind: "followup",
        heading: "主会话 · 修改要求",
        subtitle: "修复 Codex 审查指出的 2 个问题",
        actorEngine: "claude",
        sourceSessionKey: LEAD_1,
        role: "实现",
      }, "1. `rate-limit.ts:84` 校验 `trustedProxies`；\n2. `rate-limit.ts:129` 对齐降级本地桶过期时间。"),
    },
    { kind: "tool", id: "w1-t3", ts: min(0.5), name: "edit_file", input: "server/auth/rate-limit.ts", status: "running" },
  ],
  [W_CODEX_1]: [
    {
      kind: "user",
      id: "w2-card-1",
      ts: min(8),
      text: teamCardText({
        kind: "task",
        heading: "主会话 · 任务派发",
        subtitle: "只读审查登录限流实现",
        actorEngine: "claude",
        sourceSessionKey: LEAD_1,
        role: "审查",
      }, "在 `agy-1` 的 worktree 中只读审查 `server/auth/rate-limit.ts` 与路由接入，重点核对代理头信任、竞态与降级边界。"),
    },
    { kind: "tool", id: "w2-t1", ts: min(6), name: "Bash", input: "git diff main -- server/auth/", status: "ok", output: "3 files changed, 214 insertions(+)" },
    {
      kind: "user",
      id: "w2-card-2",
      ts: min(2),
      text: teamCardText({
        kind: "review",
        heading: "已汇报审查结果 · 2 个问题",
        actorEngine: "codex",
        outcome: "succeeded",
        findings: [
          { severity: "high", file: "server/auth/rate-limit.ts", line: 84, issue: "X-Forwarded-For 未校验可信代理列表，客户端可伪造 IP 绕过限流。" },
          { severity: "medium", file: "server/auth/rate-limit.ts", line: 129, issue: "Redis 降级切换时未重置本地桶过期计时器，可能造成首分钟放宽 2 倍配额。" },
        ],
      }),
    },
  ],
  [W_CLAUDE_TEST]: [
    {
      kind: "user",
      id: "w3-card-1",
      ts: min(5),
      text: teamCardText({
        kind: "task",
        heading: "主会话 · 任务派发",
        subtitle: "补充 Redis 降级单测",
        actorEngine: "claude",
        sourceSessionKey: LEAD_1,
        role: "测试",
      }, "针对 Redis 超时、断连恢复、并发降级三个场景补充单元测试，并确认全部通过。"),
    },
    { kind: "tool", id: "w3-t1", ts: min(2.5), name: "edit_file", input: "server/auth/rate-limit.test.ts", status: "ok", output: "Added 6 fallback test cases" },
    {
      kind: "assistant",
      id: "w3-a1",
      ts: min(1.3),
      text: "已新增 6 个 Redis 降级与恢复边界用例，准备运行测试套件验证（等待权限批准）。",
    },
  ],
  [W_HIST_1]: [
    {
      kind: "user",
      id: "wh1-card",
      ts: hour(6),
      text: teamCardText({ kind: "task", heading: "主会话 · 任务派发", subtitle: "调研滑动窗口与令牌桶", actorEngine: "claude", sourceSessionKey: LEAD_1, role: "调研" }, "调研现有基础设施下 Redis 滑动窗口与令牌桶方案的精度与开销。"),
    },
    {
      kind: "user",
      id: "wh1-rep",
      ts: hour(5),
      text: teamCardText({ kind: "report", heading: "Codex · 完成报告", actorEngine: "codex", outcome: "succeeded" }, "登录接口峰值低但突发探测敏感，推荐使用 Redis ZSET 滑动窗口；单次 Lua 脚本耗时 < 0.4ms。"),
    },
  ],
  [W_HIST_2]: [
    {
      kind: "user",
      id: "wh2-card",
      ts: hour(5.5),
      text: teamCardText({ kind: "task", heading: "主会话 · 任务派发", subtitle: "编写压测基线脚本", actorEngine: "claude", sourceSessionKey: LEAD_1, role: "压测" }, "产出本地可复现的登录接口基线压测脚本。"),
    },
    {
      kind: "user",
      id: "wh2-rep",
      ts: hour(4.5),
      text: teamCardText({ kind: "report", heading: "AGY · 完成报告", actorEngine: "agy", outcome: "succeeded", files: ["scripts/bench-login.mjs"] }, "基线无缓存限流吞吐 4200 req/s，P99 18ms。"),
    },
  ],
  [LEAD_2]: [
    { kind: "user", id: "l2-u1", ts: min(46), text: "让 agy 和 codex 各做一版缓存穿透防护，你比较后挑好的。" },
    {
      kind: "user",
      id: "l2-done",
      ts: min(25),
      text: teamCardText({
        kind: "done",
        heading: "协作完成 · 交付摘要",
        actorEngine: "claude",
        outcome: "succeeded",
      }, "已对比 `agy-1`（布隆过滤器）与 `codex-1`（Singleflight + 30s 空值缓存）两个 worktree 的 diff 与基准结果：\n\n- **推荐方案 B（Singleflight）**：改动仅 2 个文件，无过滤表重建运维成本，热点击穿压测下 DB QPS 下降 99.4%。"),
    },
  ],
  [W_CMP_A]: [
    { kind: "user", id: "ca-1", ts: min(45), text: teamCardText({ kind: "task", heading: "主会话 · 任务派发", subtitle: "布隆过滤器方案实现", actorEngine: "claude", sourceSessionKey: LEAD_2, role: "方案 A" }, "在独立 worktree 中实现布隆过滤器防缓存穿透方案。") },
    { kind: "user", id: "ca-2", ts: min(28), text: teamCardText({ kind: "report", heading: "AGY · 完成报告", actorEngine: "agy", outcome: "succeeded", files: ["server/cache/bloom-guard.ts"] }, "已完成布隆过滤器接入与单测，内存占用约 1.2 MB / 100 万 key。") },
  ],
  [W_CMP_B]: [
    { kind: "user", id: "cb-1", ts: min(44), text: teamCardText({ kind: "task", heading: "主会话 · 任务派发", subtitle: "Singleflight 空值缓存实现", actorEngine: "claude", sourceSessionKey: LEAD_2, role: "方案 B" }, "在独立 worktree 中实现 Singleflight + 短空值缓存方案。") },
    { kind: "user", id: "cb-2", ts: min(26), text: teamCardText({ kind: "report", heading: "Codex · 完成报告", actorEngine: "codex", outcome: "succeeded", files: ["server/cache/singleflight.ts", "server/cache/store.ts"] }, "已完成 Singleflight 合并并发回源与 30s 空值哨兵缓存，全部单测通过。") },
  ],
  [LEAD_3]: [
    { kind: "user", id: "l3-u1", ts: hour(2.1), text: "重构完支付回调幂等键之后，让 agy 去沙箱目录跑一下对账回归。" },
    {
      kind: "user",
      id: "l3-esc",
      ts: hour(1.5),
      text: teamCardText({
        kind: "escalation",
        heading: "异常升级 · agy-1 执行失败",
        subtitle: "回归支付沙箱对账脚本",
        actorEngine: "agy",
        sourceSessionKey: W_PAY_FAIL,
        outcome: "failed",
      }, "沙箱目录缺少 `PAY_SANDBOX_SECRET` 环境变量，对账脚本无法鉴权（`outcome=failed`）。请补齐测试凭据后决定是否重派。"),
    },
  ],
  [FORK_3]: [
    { kind: "user", id: "f3-1", ts: hour(1.9), text: "检查下重复回调并发到达时唯一索引冲突码的处理。" },
    { kind: "assistant", id: "f3-2", ts: hour(1.8), replyPhase: "final", text: "SQLite 返回 `SQLITE_CONSTRAINT_UNIQUE` 时已正确转为幂等成功返回，不会触发上游重试风暴。" },
  ],
  [W_PAY_FAIL]: [
    { kind: "user", id: "wf-1", ts: hour(2), text: teamCardText({ kind: "task", heading: "主会话 · 任务派发", subtitle: "回归支付沙箱对账脚本", actorEngine: "codex", sourceSessionKey: LEAD_3, role: "回归" }, "在 `D:\\Temp\\sandbox-verify` 执行对账回归脚本并汇报差异。") },
    { kind: "user", id: "wf-2", ts: hour(1.5), text: teamCardText({ kind: "report", heading: "AGY · 汇报失败", actorEngine: "agy", outcome: "failed" }, "缺少 `PAY_SANDBOX_SECRET`，无法连接沙箱环境。") },
  ],
};

const clients = new Set();

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function broadcastSnapshot() {
  broadcast({ type: "list", devices, sessions });
  broadcast({ type: "workbench", sessions: workbench });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function makeState() {
  const waiting = sessions.filter((s) => !s.archived && (s.state === "waiting" || pendingRequests.some((r) => r.key === s.key))).length;
  const running = sessions.filter((s) => !s.archived && s.state === "running").length;
  return {
    sync: { cursor: 1, privacyEpoch: 1, coreId: "local-team-preview", bootId: "boot-1" },
    config: { default_model: "claude-opus-5-5" },
    connections: [],
    bots: [
      { id: "bot-1", name: "个人助手", instructions: "日常协助与代码协作", unread_count: 0, version: 1, policy_version: 1, approval_setting: "full", approval_setting_version: 1 },
    ],
    conversations: [],
    approvals: [],
    memories: [],
    delegations: [],
    devices: [],
    tasks: [],
    onlineDevices: [DEVICE_ID],
    routines: [],
    occurrences: [],
    journal: [],
    cliAgents: { waiting, running },
    node: { status: "online", origin: `http://127.0.0.1:${PORT}`, root: "D:\\ProgrammingProjects\\nex_bot", exec: true, connected: true, unknownCalls: [] },
    dataDir: "preview-memory",
    address: `http://127.0.0.1:${PORT}`,
    lanEnabled: false,
  };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (p === "/api/auth/status") {
    json(res, 200, {
      authenticated: true,
      initialized: true,
      canInitialize: false,
      coreId: "local-team-preview",
      sessionId: "preview-session",
      expiresAt: Date.now() + 86_400_000,
      account: { displayName: "演示账号" },
    });
    return true;
  }
  if (p === "/api/state") { json(res, 200, makeState()); return true; }
  if (p === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const timer = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 25_000);
    req.on("close", () => clearInterval(timer));
    return true;
  }
  if (p === "/api/clients") {
    json(res, 200, {
      sessions: [{ session_id: "preview-session", name: "办公电脑 (Windows)", last_seen_at: Date.now(), expires_at: Date.now() + 86_400_000, revoked_at: null }],
      currentSessionId: "preview-session",
    });
    return true;
  }
  if (p === "/api/cli-agents" && req.method === "GET") {
    json(res, 200, { devices, sessions, requests: pendingRequests, workbench, queues: [] });
    return true;
  }
  if (p === "/api/cli-agents/teams" && req.method === "GET") {
    const lead = url.searchParams.get("lead");
    const filtered = lead ? teamRuns.filter((run) => run.leadKey === lead) : teamRuns;
    json(res, 200, { runs: filtered });
    return true;
  }
  const teamAction = /^\/api\/cli-agents\/teams\/([^/]+)\/(pause|resume|cancel)$/.exec(p);
  if (teamAction && req.method === "POST") {
    const [, rawId, action] = teamAction;
    const runId = decodeURIComponent(rawId);
    const run = teamRuns.find((entry) => entry.id === runId);
    if (!run) { json(res, 404, { error: "协作不存在" }); return true; }
    if (action === "pause") run.status = "paused";
    else if (action === "resume") run.status = "active";
    else if (action === "cancel") {
      run.status = "cancelled";
      run.finishedAt = Date.now();
      for (const worker of run.workers) {
        if (worker.status === "running" || worker.status === "starting" || worker.status === "waiting") {
          worker.status = "stopped";
          const session = sessions.find((s) => s.key === worker.sessionKey);
          if (session) session.state = "idle";
        }
      }
      pendingRequests = pendingRequests.filter((r) => !run.workers.some((w) => w.sessionKey === r.key));
    }
    run.updatedAt = Date.now();
    broadcastSnapshot();
    json(res, 200, { run });
    return true;
  }
  const workerStop = /^\/api\/cli-agents\/teams\/([^/]+)\/workers\/([^/]+)\/stop$/.exec(p);
  if (workerStop && req.method === "POST") {
    const [, rawId, rawName] = workerStop;
    const run = teamRuns.find((entry) => entry.id === decodeURIComponent(rawId));
    const worker = run?.workers.find((entry) => entry.name === decodeURIComponent(rawName));
    if (!run || !worker) { json(res, 404, { error: "工人不存在" }); return true; }
    worker.status = "stopped";
    worker.updatedAt = Date.now();
    const session = sessions.find((s) => s.key === worker.sessionKey);
    if (session) session.state = "idle";
    pendingRequests = pendingRequests.filter((r) => r.key !== worker.sessionKey);
    run.updatedAt = Date.now();
    broadcastSnapshot();
    json(res, 200, { run });
    return true;
  }
  if (p === "/api/cli-agents/team-settings") {
    if (req.method === "GET") { json(res, 200, { settings: teamSettings }); return true; }
    if (req.method === "PUT") {
      const body = await readBody(req);
      teamSettings = { ...teamSettings, ...body.settings };
      json(res, 200, { settings: teamSettings });
      return true;
    }
  }
  if (p === "/api/cli-agents/items" && req.method === "GET") {
    const key = url.searchParams.get("key") ?? "";
    json(res, 200, { items: transcripts[key] ?? [], more: false, translationEnabled: false });
    return true;
  }
  if (p === "/api/cli-agents/notes") { json(res, 200, { notes: [] }); return true; }
  if (p === "/api/cli-agents/queue") {
    const key = url.searchParams.get("key") ?? "";
    const wb = workbench.find((row) => row.sessionKey === key);
    json(res, 200, { queue: { workbenchId: wb?.id ?? "wb-default", sessionKey: key, paused: false, entries: [] } });
    return true;
  }
  if (p === "/api/cli-agents/sessions/git") {
    const key = url.searchParams.get("key") ?? "";
    const s = sessions.find((row) => row.key === key);
    json(res, 200, {
      source: s?.cwd?.includes("worktrees") ? "worktree" : "folder",
      project: s?.repoRoot ?? s?.cwd ?? "",
      worktree: s?.cwd ?? "",
      branch: s?.gitBranch ?? "main",
      head: "a84c91f",
      files: key === W_AGY_1 || key === W_CODEX_1 || key === W_CLAUDE_TEST
        ? ["server/auth/rate-limit.ts", "server/auth/login-route.ts", "server/auth/rate-limit.test.ts"]
        : ["plan.md"],
      added: 186,
      removed: 14,
    });
    return true;
  }
  if (p === "/api/cli-agents/models") {
    const engine = url.searchParams.get("engine") ?? "claude";
    const catalogs = {
      claude: { current: "opus", currentEffort: "high", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
      codex: { current: "gpt-6.2-sol", currentEffort: "high", models: [{ id: "gpt-6.2-sol", label: "gpt-6.2-sol" }, { id: "gpt-6.2-astra", label: "gpt-6.2-astra" }] },
      agy: { current: "gemini-4-neon", currentEffort: "high", models: [{ id: "gemini-4-neon", label: "Gemini 4 Neon" }] },
    };
    json(res, 200, catalogs[engine] ?? { models: [] });
    return true;
  }
  if (p === "/api/cli-agents/skills") { json(res, 200, { skills: [{ name: "nex", description: "多 Agent 协作命令指南" }] }); return true; }
  if (p === "/api/cli-agents/search") { json(res, 200, { hits: [] }); return true; }
  if (p === "/api/cli-agents/answer" && req.method === "POST") {
    const body = await readBody(req);
    const reqItem = pendingRequests.find((r) => r.id === body.id);
    if (reqItem) {
      pendingRequests = pendingRequests.filter((r) => r.id !== body.id);
      const session = sessions.find((s) => s.key === reqItem.key);
      if (session) { session.state = body.decision === "allow" ? "running" : "idle"; session.lastActivityAt = Date.now(); }
      for (const run of teamRuns) {
        const w = run.workers.find((entry) => entry.sessionKey === reqItem.key);
        if (w) { w.status = body.decision === "allow" ? "running" : "stopped"; w.updatedAt = Date.now(); }
      }
      broadcast({ type: "request.resolved", key: reqItem.key, id: reqItem.id, by: "nexbot" });
      broadcast({ type: "requests", key: reqItem.key, requests: [] });
      broadcastSnapshot();
    }
    json(res, 200, { outcome: "ok" });
    return true;
  }
  if (p === "/api/cli-agents/send" && req.method === "POST") {
    const body = await readBody(req);
    const key = body.key;
    const item = { kind: "user", id: "u-" + Date.now(), ts: Date.now(), text: String(body.text ?? "") };
    (transcripts[key] ??= []).push(item);
    broadcast({ type: "items", key, items: [item] });
    setTimeout(() => {
      const reply = { kind: "assistant", id: "a-" + Date.now(), ts: Date.now(), replyPhase: "final", text: "收到，已按你的最新指示处理（本地界面预览模式）。" };
      transcripts[key].push(reply);
      broadcast({ type: "items", key, items: [reply] });
    }, 500);
    json(res, 200, { turn: 1, started: true, delivery: "confirmed", messageId: item.id, status: "confirmed", version: 1, queued: false });
    return true;
  }
  if ((p === "/api/cli-agents/sessions/archive" || p === "/api/cli-agents/sessions/restore") && req.method === "POST") {
    const body = await readBody(req);
    const archived = p.endsWith("/archive");
    const row = workbench.find((entry) => entry.id === body.id || entry.sessionKey === body.key);
    if (row) { row.archived = archived; row.version++; }
    const session = sessions.find((s) => s.key === (row?.sessionKey ?? body.key));
    if (session) session.archived = archived;
    broadcastSnapshot();
    json(res, 200, { session: row ?? {} });
    return true;
  }
  if (p === "/api/cli-agents/sessions/rename" && req.method === "POST") {
    const body = await readBody(req);
    const row = workbench.find((entry) => entry.id === body.id || entry.sessionKey === body.key);
    if (row) { row.title = String(body.title ?? ""); row.version++; }
    broadcastSnapshot();
    json(res, 200, { session: row ?? {} });
    return true;
  }
  if (p === "/api/cli-agents/sessions/delete" && req.method === "POST") {
    const body = await readBody(req);
    const row = workbench.find((entry) => entry.id === body.id || entry.sessionKey === body.key);
    if (row) {
      workbench = workbench.filter((entry) => entry.id !== row.id);
      sessions = sessions.filter((s) => s.key !== row.sessionKey);
    }
    broadcastSnapshot();
    json(res, 200, { session: row ?? {} });
    return true;
  }
  if (p === "/api/cli-agents/interrupt" && req.method === "POST") {
    const body = await readBody(req);
    const session = sessions.find((s) => s.key === body.key);
    if (session) session.state = "idle";
    broadcastSnapshot();
    json(res, 200, { outcome: "interrupted" });
    return true;
  }
  if (p === "/api/agents/messages") { json(res, 200, { messages: [], streaming: [], sync: makeState().sync, hasMore: false }); return true; }
  if (p.startsWith("/api/")) { json(res, 200, { ok: true }); return true; }
  return false;
}

const vite = await createViteServer({
  configFile: "vite.config.ts",
  server: { middlewareMode: true, hmr: false },
  appType: "spa",
});

const server = createHttpServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(302, { Location: `/personal.html?page=cli&select=${encodeURIComponent(LEAD_1)}` });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    void handleApi(req, res).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    });
    return;
  }
  vite.middlewares(req, res);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", `http://127.0.0.1:${PORT}`).pathname;
  if (pathname !== "/api/cli-agents/stream") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        else if (msg.type === "sub.list") {
          ws.send(JSON.stringify({ type: "list", devices, sessions }));
          ws.send(JSON.stringify({ type: "workbench", sessions: workbench }));
        } else if (msg.type === "sub.session") {
          const reqs = pendingRequests.filter((r) => r.key === msg.key);
          ws.send(JSON.stringify({ type: "requests", key: msg.key, requests: reqs }));
        }
      } catch { /* ignore malformed client messages */ }
    });
    ws.on("close", () => clients.delete(ws));
  });
});

await new Promise((resolve, reject) => {
  server.once("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    } else {
      reject(err);
    }
  });
  server.listen(PORT, "127.0.0.1", resolve);
});

const address = server.address();
const actualPort = typeof address === "object" && address ? address.port : PORT;
console.log(`PREVIEW_READY http://127.0.0.1:${actualPort}/personal.html?page=cli&select=${encodeURIComponent(LEAD_1)}`);
console.log(`SETTINGS_URL  http://127.0.0.1:${actualPort}/personal.html?settings=team`);
