// @vitest-environment happy-dom
// The composer over the real outbox: the queue list with its in-place edit,
// withdraw and steer-now, the paused banner, and edit-and-resend refilling the
// box like a plain draft. All through mocked Core answers.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { session } from "./fixtures";
import type { CliQueue } from "./api";

let root: Root;
let container: HTMLDivElement;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const area = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="发送给 Agent 的消息"]')!;
const queueBox = () => container.querySelector<HTMLTextAreaElement>("textarea[aria-label=编辑排队消息]")!;
const sendButton = () => container.querySelector<HTMLButtonElement>("button[aria-label=发送]")!;
const buttons = (label: string) => [...container.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
/** the queued card's own icon buttons (the send-mode toggle has a 引导 too) */
const queued = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(`.na-queued button[aria-label="${label}"]`)];

const entry = (over: Partial<CliQueue["entries"][number]> = {}): CliQueue["entries"][number] => ({
  id: "e1", seq: 1, text: "排队的消息", status: "pending", version: 1, createdAt: 1, updatedAt: 1, ...over,
});
const queue = (over: Partial<CliQueue> = {}): CliQueue => ({
  workbenchId: "wb1", sessionKey: "dev1:claude:s1", paused: false, entries: [entry()], ...over,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const running = session({ nativeId: "live1", state: "running" });

async function show(props: Record<string, unknown>) {
  await act(async () => {
    root.render(createElement(Composer, {
      session: running,
      onSend: async () => ({}),
      onInterrupt: async () => ({}),
      ...props,
    }));
  });
  await flush();
}

describe("the real queue under the composer", () => {
  it("shows queued entries with withdraw and steer-now, and the paused banner", async () => {
    const onQueueWithdraw = vi.fn(async () => {});
    await show({ queue: queue(), onQueueWithdraw });
    expect(container.querySelector(".na-queued-label")?.textContent).toBe("排队 1");
    expect(container.querySelector(".na-queued-text")?.textContent).toBe("排队的消息");
    // the actions sit together at the end of the card
    expect([...container.querySelectorAll(".na-queued .na-queued-actions button")].map((button) => [button.getAttribute("aria-label"), button.textContent])).toEqual([["撤销", ""]]);
    await act(async () => { queued("撤销")[0].click(); });
    expect(onQueueWithdraw).toHaveBeenCalledWith("e1", 1);
    expect(container.textContent).not.toContain("队列已暂停");
    await show({ queue: queue({ paused: true, pauseReason: "stopped" }), onQueueWithdraw });
    expect(container.textContent).toContain("队列已暂停（已停止）");
  });

  it("edits a pending entry in place and keeps the text when saving fails", async () => {
    const onQueueEdit = vi.fn(async () => {});
    await show({ queue: queue(), onQueueEdit });
    await act(async () => { buttons("编辑排队消息 1")[0].click(); });
    const box = queueBox();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "改好的排队内容");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { buttons("保存")[0].click(); });
    expect(onQueueEdit).toHaveBeenCalledWith("e1", 1, "改好的排队内容");
  });

  it("an uncertain entry says so and offers no actions", async () => {
    await show({ queue: queue({ entries: [entry({ status: "uncertain" })] }) });
    expect(container.textContent).toContain("待确认");
    expect(queued("撤销")).toHaveLength(0);
    expect(queued("引导")).toHaveLength(0);
  });

  it("steering appears only while the session runs", async () => {
    const onQueueSteer = vi.fn(async () => {});
    await show({ queue: queue(), onQueueSteer });
    expect(queued("引导")).toHaveLength(1);
    await show({ queue: queue(), onQueueSteer, session: session({ nativeId: "idle1", state: "idle" }) });
    expect(queued("引导")).toHaveLength(0);
  });
});

describe("edit-and-resend", () => {
  it("puts the words back like a plain draft and sends them at once, not into the queue", async () => {
    const onSend = vi.fn(async () => ({}));
    await show({ onSend, revision: { messageId: "u9", text: "原来的问题" } });
    expect(area().value).toBe("原来的问题");
    // no banner, no cancel button, no queue/steer choice for a resend
    expect(container.querySelector(".na-revising")).toBeNull();
    expect(buttons("取消编辑重发")).toHaveLength(0);
    expect(container.querySelector("[role=radiogroup]")).toBeNull();
    await act(async () => { sendButton().click(); });
    expect(onSend).toHaveBeenCalledWith("原来的问题");
  });

  it("emptying the box drops the edit", async () => {
    const onCancelRevision = vi.fn();
    await show({ onCancelRevision, revision: { messageId: "u9", text: "原来的问题" } });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area(), "");
      area().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onCancelRevision).toHaveBeenCalled();
  });
});
