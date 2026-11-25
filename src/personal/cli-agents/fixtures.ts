// Row builders shared by the Agent mode tests.
import type { CliDeviceView, CliItem, CliRequestView, CliSessionView } from "../../../shared/cli-agents";

export function device(overrides: Partial<CliDeviceView> = {}): CliDeviceView {
  return {
    id: "dev1",
    name: "办公室电脑",
    online: true,
    cliAgents: { version: 1, engines: ["claude", "codex"], forkEngines: ["claude", "codex"], terminal: { name: "herdr-core", version: "0.1.21", ready: true } },
    ...overrides,
  };
}

export function session(overrides: Partial<CliSessionView> = {}): CliSessionView {
  const deviceId = overrides.deviceId ?? "dev1";
  const engine = overrides.engine ?? "claude";
  const nativeId = overrides.nativeId ?? "s1";
  return {
    key: `${deviceId}:${engine}:${nativeId}`,
    deviceId,
    engine,
    nativeId,
    configDir: "~/.claude",
    cwd: "D:\\work\\alpha",
    title: "修复登录",
    state: "idle",
    liveIn: "nexbot",
    terminal: "pane-1",
    lastActivityAt: 1_000,
    hidden: false,
    online: true,
    ...overrides,
  };
}

export const userItem = (id: string, ts: number, text = "你好"): CliItem => ({ kind: "user", id, ts, text });
export const assistantItem = (id: string, ts: number, text = "好的"): CliItem => ({ kind: "assistant", id, ts, text });
export const toolItem = (id: string, ts: number, status: "running" | "ok" | "error" = "ok"): CliItem => ({ kind: "tool", id, ts, name: "Bash", input: "ls -la\nsecond", status, output: "ok" });

export function permissionRequest(overrides: Partial<CliRequestView> = {}): CliRequestView {
  return { id: "r1", key: "dev1:claude:s1", kind: "permission", tool: "Bash", summary: "rm -rf build", createdAt: 1_000, expiresAt: Date.now() + 600_000, ...overrides };
}

export function questionRequest(overrides: Partial<CliRequestView> = {}): CliRequestView {
  return {
    id: "q1",
    key: "dev1:claude:s1",
    kind: "question",
    tool: "AskUserQuestion",
    summary: "用哪个框架？",
    questions: [
      { question: "用哪个框架？", header: "框架", options: [{ label: "React" }, { label: "Vue", description: "渐进式" }] },
      { question: "要哪些功能？", multiSelect: true, options: [{ label: "路由" }, { label: "测试" }, { label: "国际化" }] },
    ],
    createdAt: 1_000,
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}
