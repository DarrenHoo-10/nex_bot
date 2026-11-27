import { describe, expect, it, vi } from "vitest";
import { tryManagedCodexQueue } from "./codex-native-queue.ts";

const threadId = "019a0000-0000-7000-8000-000000000009";
const target = { file: "C:\\Codex CLI\\codex.exe", version: "0.172.0", home: "C:\\profiles\\fixture", threadId, text: '--resume & "不是命令"\n第二行', cwd: "C:\\work", platform: "win32" as const, env: { Codex_Home: "wrong" } };
const ack = `Queued message q1 for thread ${threadId}.`;
const help = "Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>";
function commands(queued: () => string, version = "codex-cli 0.172.0", usage = help) {
  return vi.fn(async (_file: string, args: string[], _options: unknown) => ({ stdout: args[0] === "--version" ? version : args.includes("--help") ? usage : queued() }));
}

describe("Codex native queue for an owned terminal", () => {
  it("enqueues once for the exact owner without opening a turn, invoking a shell or touching its composer", async () => {
    const run = commands(() => ack), guard = vi.fn(async () => 5500);
    expect(await tryManagedCodexQueue(target, guard, run)).toBe(true);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.at(-1)).toEqual([target.file, ["queue", "--thread", threadId, "--message=" + target.text], expect.objectContaining({ cwd: target.cwd, env: { CODEX_HOME: target.home }, shell: false, timeout: 5500 })]);
  });

  it.each(["old consumer", "different version", "no queue", "cmd shim", "not a native id"])('does not write with %s', async (condition) => {
    const run = commands(() => { throw Error("unexpected write"); }, condition === "different version" ? "codex-cli 0.162.1" : undefined, condition === "no queue" ? "Unknown subcommand" : undefined);
    const input = { ...target, ...(condition === "old consumer" && { version: "0.162.1" }), ...(condition === "cmd shim" && { file: "C:\\bin\\codex.cmd" }), ...(condition === "not a native id" && { threadId: "a session name" }) };
    const guard = vi.fn(async () => 1000);
    expect(await tryManagedCodexQueue(input, guard, run)).toBe(false);
    expect(guard).not.toHaveBeenCalled();
  });

  it.each(["lost reply", "wrong thread", "missing receipt"])('never retries or falls through after a possible write: %s', async (failure) => {
    const run = commands(() => { if (failure === "lost reply") throw Error("timeout"); return failure === "wrong thread" ? ack.replace(threadId, "019a0000-0000-7000-8000-000000000010") : ""; });
    await expect(tryManagedCodexQueue(target, async () => 1000, run)).rejects.toMatchObject({ code: "unknown" });
    expect(run.mock.calls.filter(([, args]) => args.includes("--thread"))).toHaveLength(1);
  });

  it("does not enqueue after losing the originating session during a capability probe", async () => {
    const run = commands(() => ack);
    await expect(tryManagedCodexQueue(target, async () => { throw Error("disconnected"); }, run)).rejects.toThrow("disconnected");
    expect(run.mock.calls.some(([, args]) => args.includes("--thread"))).toBe(false);
  });
});
