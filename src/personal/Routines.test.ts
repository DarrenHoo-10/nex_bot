// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineOccurrenceDetail as Detail } from "./api";
const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), api: fixture.api }));
import { RoutineDetail } from "./components/RoutineDetail";
import { RoutineOccurrenceDetail } from "./components/RoutineOccurrenceDetail";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("Assistant-managed routine detail", () => {
  const routine = { id: 'r', version: 3, name: '早间简报', prompt: '整理我的日程', schedule_kind: 'daily', local_time: '09:00', enabled: 1 };
  it('shows the plan without editable controls or manual execution', async () => {
    await act(async () => root.render(createElement(RoutineDetail, { routine, close: vi.fn(), showResult: vi.fn(), disable: vi.fn(), remove: vi.fn() })));
    expect(container.textContent).toContain('整理我的日程');
    expect(container.textContent).toContain('每天 09:00');
    expect(container.querySelector('input,select,textarea,form')).toBeNull();
    expect(container.textContent).not.toMatch(/编辑|立即执行|现在执行|保存|恢复/);
  });
  it.each(['disable', 'remove'] as const)('requires confirmation for %s and surfaces failures', async (action) => {
    const perform = vi.fn().mockRejectedValue(new Error('任务已修改，请刷新'));
    await act(async () => root.render(createElement(RoutineDetail, { routine, close: vi.fn(), showResult: vi.fn(), disable: action === 'disable' ? perform : vi.fn(), remove: action === 'remove' ? perform : vi.fn() })));
    const label = action === 'disable' ? '关闭' : '删除';
    const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!;
    await act(async () => button(label + '任务').click());
    expect(perform).not.toHaveBeenCalled();
    await act(async () => button('取消').click()); expect(perform).not.toHaveBeenCalled();
    await act(async () => button(label + '任务').click());
    await act(async () => button('确认' + label).click());
    expect(perform).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role=alert]')?.textContent).toContain('任务已修改');
  });
});

const detail = (status = "running"): Detail => ({ occurrence: { id: "o", name: "测试巡检", prompt: "检查状态", task_kind: "monitor", status: "running", task_status: status, reason: "", scheduled_at: 1000 }, task: { result_summary: "" }, messages: [], steps: [], streaming: "正在检查" });
async function mountDetail() { await act(async () => root.render(createElement(RoutineOccurrenceDetail, { id: "o", close: vi.fn(), renderContent: (text: string) => text }))); }
describe("Routine occurrence detail", () => {
  it("puts the final result first and keeps intermediate work collapsed", async () => {
    const data = detail("succeeded"); data.streaming = ""; data.task = { result_summary: "今天有两项待办" };
    data.messages = [{ id: "m", role: "assistant", content: "正在读取日程" }];
    fixture.api.mockResolvedValue(data); await mountDetail();
    const result = container.querySelector('[aria-label="本次结果"]')!;
    expect(result.textContent).toContain("今天有两项待办");
    expect(result.textContent).not.toContain("正在读取日程");
    const process = container.querySelector<HTMLDetailsElement>('.routine-process')!;
    expect(process.open).toBe(false); expect(process.textContent).toContain("正在读取日程");
    await act(async () => process.querySelector('summary')!.click());
    expect(process.open).toBe(true);
  });
  it.each(["queued", "running", "awaiting_approval", "paused", "needs_reconciliation"])("polls %s only while open and aborts pending requests on close", async (status) => {
    vi.useFakeTimers(); fixture.api.mockResolvedValue(detail(status));
    await mountDetail(); expect(container.textContent).toContain("检查状态"); expect(container.textContent).toContain("正在检查");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(fixture.api).toHaveBeenCalledTimes(2);
    const signal = fixture.api.mock.calls[0][2] as AbortSignal;
    await act(async () => root.render(null)); expect(signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); }); expect(fixture.api).toHaveBeenCalledTimes(2);
  });
  it("shows skipped reasons without creating a task or continuous terminal polling", async () => {
    vi.useFakeTimers(); const data = detail(); data.occurrence.status = "skipped"; data.occurrence.task_status = null; data.occurrence.reason = "已合并到最新一次执行"; data.task = null; data.streaming = "";
    fixture.api.mockResolvedValue(data); await mountDetail();
    expect(container.textContent).toContain("已跳过"); expect(container.textContent).toContain("已合并到最新一次执行"); expect(container.querySelector('.routine-process')?.hasAttribute('open')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); }); expect(fixture.api).toHaveBeenCalledTimes(1);
  });
  it("renders failure summaries even alongside messages and opens the tool preview API", async () => {
    const data = detail("failed"); data.streaming = ""; data.task = { result_summary: "设备连接失败" }; data.messages = [{ id: "m", role: "assistant", content: "部分输出" }]; data.steps = [{ id: "call", tool_name: "device.exec", status: "failed", summary: "", preview: "", created_at: 1 }];
    fixture.api.mockImplementation(async (route: string) => route.startsWith("preview?") ? { kind: "tool", title: "device.exec", arguments: '{"command":"test"}', content: "详细错误" } : data);
    await mountDetail(); expect(container.textContent).toContain("设备连接失败"); expect(container.textContent).toContain("部分输出");
    await act(async () => container.querySelector<HTMLButtonElement>(".step-row")!.click());
    expect(fixture.api).toHaveBeenCalledWith("preview?callId=call", undefined, expect.any(AbortSignal));
    expect(container.textContent).toContain("详细错误"); expect(container.textContent).toContain('"command":"test"');
  });
});
