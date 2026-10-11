import { describe, expect, it } from "vitest";
import { ComputerExecutor } from "./computer.ts";
function fixture() {
  const executor = new ComputerExecutor(), calls: string[] = [];
  let interrupt = false, unknown = false;
  executor.load = async () => ({
    async callTool(name: string) { calls.push(name); if (interrupt) throw new Error("synthetic interrupted native transport"); return { text: "synthetic", images: [], rawJson: "{}", isError: false, ...(unknown ? { action: { completion: 2 } } : {}) }; },
    async listToolsJson() { return '{"tools":[]}'; }, async shutdown() {},
  });
  return { executor, calls, interrupt() { interrupt = true; }, unknown() { unknown = true; } };
}
describe("computer use boundary", () => {
  it("refuses arbitrary connections, file outputs and global desktop input before entering the native driver", async () => {
    const f = fixture();
    for (const parameters of [{ session: "other" }, { screenshot_out_file: "private.txt" }, { scope: "desktop" }, { target: { kind: "desktop" } }]) await expect(f.executor.execute("get_window_state", parameters, 1000)).rejects.toThrow();
    await expect(f.executor.execute("kill_app", {}, 1000)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("requires a fresh observation and cannot approve actions by operating the host window", async () => {
    const f = fixture(), target = { pid: 100111, window_id: 42, text: "synthetic" };
    await expect(f.executor.execute("type_text", target, 1000)).rejects.toThrow("重新观察");
    await f.executor.execute("get_window_state", target, 1000);
    await expect(f.executor.execute("type_text", { ...target, pid: process.pid }, 1000)).rejects.toThrow("NexBot");
    await expect(f.executor.execute("type_text", { ...target, delivery_mode: "foreground" }, 1000)).rejects.toThrow("后台输入");
    await f.executor.execute("type_text", target, 1000);
    await expect(f.executor.execute("type_text", target, 1000)).rejects.toThrow("重新观察");
    expect(f.calls).toEqual(["get_window_state", "type_text"]);
  });
  it("reports interrupted native input as unknown rather than a retryable failure", async () => {
    const f = fixture(), target = { pid: 100111, window_id: 42, text: "synthetic" };
    await f.executor.execute("get_window_state", target, 1000); f.interrupt();
    expect(await f.executor.execute("type_text", target, 1000)).toMatchObject({ unknown: true });
    await expect(f.executor.execute("type_text", target, 1000)).rejects.toThrow("重新观察");
    expect(f.calls).toEqual(["get_window_state", "type_text"]);
  });
  it("consumes the observation when the native driver reports unknown completion", async () => {
    const f = fixture(), target = { pid: 100111, window_id: 42, text: "synthetic" };
    await f.executor.execute("get_window_state", target, 1000); f.unknown();
    expect(await f.executor.execute("type_text", target, 1000)).toMatchObject({ unknown: true });
    await expect(f.executor.execute("type_text", target, 1000)).rejects.toThrow("重新观察");
    expect(f.calls).toEqual(["get_window_state", "type_text"]);
  });
});
