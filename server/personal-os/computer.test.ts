import { describe, expect, it, vi } from "vitest";
import { ComputerExecutor } from "./computer.ts";
function fixture() {
  const executor = new ComputerExecutor(), calls: string[] = [];
  let interrupt = false, unknown = false, failObservation = false;
  executor.load = async () => ({
    async callTool(name: string) { calls.push(name); if (interrupt) throw new Error("synthetic interrupted native transport"); return { text: "synthetic", images: [], rawJson: "{}", isError: failObservation && name === "get_window_state", ...(name === "list_windows" ? { structuredJson: JSON.stringify({ windows: [{ pid: 100111, window_id: 42 }] }) } : {}), ...(unknown ? { action: { completion: 2 } } : {}) }; },
    async listToolsJson() { return '{"tools":[]}'; }, async shutdown() {},
  });
  return { executor, calls, interrupt() { interrupt = true; }, unknown() { unknown = true; }, failObservation() { failObservation = true; } };
}
describe("computer use boundary", () => {
  it("propagates a manual stop to native input and preserves unknown completion without replay", async () => {
    const f = fixture(), target = { pid: 100111, window_id: 42, text: "synthetic" };
    await f.executor.execute("get_window_state", target, 1000);
    let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    f.executor.load = async () => ({
      callTool: async (_name, _args, options) => new Promise((_resolve, reject) => { entered(); options?.signal?.addEventListener("abort", () => reject(new Error("synthetic manual stop")), { once: true }); }),
      async listToolsJson() { return '{"tools":[]}'; }, async shutdown() {},
    });
    const controller = new AbortController(), pending = f.executor.execute("type_text", target, 20_000, controller.signal);
    await ready; controller.abort(); expect(await pending).toMatchObject({ unknown: true });
    await expect(f.executor.execute("type_text", target, 1000)).rejects.toThrow("重新观察");
  });
  it("restores a genuinely enumerated window but requires a fresh screenshot before input", async () => {
    const f = fixture(), target = { pid: 100111, window_id: 42 };
    await expect(f.executor.execute("bring_to_front", target, 1000)).rejects.toThrow("list_windows");
    await f.executor.execute("list_windows", {}, 1000);
    await expect(f.executor.execute("bring_to_front", { ...target, window_id: 99 }, 1000)).rejects.toThrow("list_windows");
    await expect(f.executor.execute("click", target, 1000)).rejects.toThrow("get_window_state");
    await f.executor.execute("bring_to_front", target, 1000);
    await expect(f.executor.execute("type_text", target, 1000)).rejects.toThrow("get_window_state");
    await f.executor.execute("get_window_state", target, 1000);
    await f.executor.execute("type_text", target, 1000);
    expect(f.calls).toEqual(["list_windows", "bring_to_front", "get_window_state", "type_text"]);
  });
  it("expires enumerated targets and invalidates a prior screenshot when a new observation fails", async () => {
    const f = fixture(), target = { pid: 100111, window_id: 42 };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await f.executor.execute("list_windows", {}, 1000);
      clock.mockReturnValue(1_120_001);
      await expect(f.executor.execute("bring_to_front", target, 1000)).rejects.toThrow("list_windows");
      await f.executor.execute("get_window_state", target, 1000);
      f.failObservation(); await f.executor.execute("get_window_state", target, 1000);
      await expect(f.executor.execute("click", target, 1000)).rejects.toThrow("get_window_state");
    } finally { clock.mockRestore(); }
    expect(f.calls).toEqual(["list_windows", "get_window_state", "get_window_state"]);
  });
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
