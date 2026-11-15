import { describe, expect, it } from "vitest";
import type { CliItem } from "../../../shared/cli-agents";
import { sessionActivity } from "./session-activity";

function tool(name: string, data: unknown, status: "running" | "ok" | "error", output?: string): CliItem {
  return { kind: "tool", id: name, name, ts: 1, input: JSON.stringify(data), status, output };
}

describe("session activity", () => {
  it("shows a plan until the last remaining step is completed or the turn ends", () => {
    const plan = (status: string) => tool("TodoWrite", { todos: [{ content: "验证", status }] }, "ok");
    expect(sessionActivity([plan("in_progress")], "running", true).todos).toHaveLength(1);
    expect(sessionActivity([plan("in_progress"), plan("completed")], "running", true).todos).toEqual([]);
    expect(sessionActivity([plan("pending"), { kind: "turn", phase: "ended", ts: 2, id: "end" }], "running", true).todos).toEqual([]);
  });
  it("keeps detached work across a turn and removes each id on completion", () => {
    const calls = [tool("spawn_agent", { message: "检查目录" }, "ok", '{"agent_id":"a"}'),
      tool("exec_command", { cmd: "pnpm test" }, "ok", "Process running with session ID 13")];
    expect(sessionActivity(calls, "idle", true).jobs[0]?.title).toBe("pnpm test");
    const finished = [...calls, tool("wait_agent", {}, "ok", '{"status":{"a":{"completed":"done"}}}'),
      tool("write_stdin", { session_id: 13 }, "error", "Process exited with code 1")];
    expect(sessionActivity(finished, "running", true)).toEqual({ todos: [], agents: [], jobs: [] });
  });
  it("distinguishes an active agent from a returned call and tracks Claude background notifications", () => {
    expect(sessionActivity([tool("Agent", {}, "running")], "running", true).agents).toHaveLength(1);
    expect(sessionActivity([tool("Agent", {}, "ok", "finished")], "running", true).agents).toEqual([]);
    const job = tool("Bash", { command: "pnpm test", run_in_background: true }, "ok", "Command running in background with ID: test-1");
    const completed: CliItem = { kind: "notice", ts: 2, id: "end", level: "info", text: "<task-notification><task-id>test-1</task-id><status>completed</status></task-notification>" };
    expect(sessionActivity([job], "idle", true).jobs).toHaveLength(1);
    expect(sessionActivity([job, completed], "idle", true).jobs).toEqual([]);
    expect(sessionActivity([job], "stopped", true).jobs).toEqual([]);
  });
});
