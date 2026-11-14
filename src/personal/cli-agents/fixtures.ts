// Row builders shared by the Agent mode tests.
import type { CliDeviceView, CliItem, CliSessionView } from "../../../shared/cli-agents";

export function device(overrides: Partial<CliDeviceView> = {}): CliDeviceView {
  return {
    id: "dev1",
    name: "办公室电脑",
    online: true,
    cliAgents: { version: 1, engines: ["claude", "codex"], terminal: { name: "herdr-core", version: "0.1.21", ready: true } },
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
