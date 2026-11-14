// @vitest-environment happy-dom
// The message box for a session that runs on the computer outside nex_bot's terminals.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliApiError } from "./api";
import { Composer, deliveryNote, OUTSIDE_NOTE, UNCONFIRMED_NOTE, WAITING_NOTE } from "./Composer";
import { session } from "./fixtures";

let root: Root;
let container: HTMLDivElement;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const area = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const note = () => container.querySelector("[data-testid=cli-composer-note]")?.textContent;
const sendButton = () => container.querySelector<HTMLButtonElement>("button[aria-label=发送]")!;

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

async function show(row = session({ nativeId: "outside", liveIn: "terminal", terminal: undefined, sendVia: "inbox" }), onSend: (text: string) => Promise<unknown> = async () => ({ turn: 0 })) {
  await act(async () => { root.render(createElement(Composer, { session: row, onSend, onInterrupt: async () => ({}), onContinue: async () => ({}) })); });
}

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(area(), value);
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const submit = async () => { await act(async () => { sendButton().click(); }); await flush(); };

describe("what a send says about a session on the computer", () => {
  it("builds the line from the result", () => {
    expect(deliveryNote({ turn: 0, delivery: "unconfirmed" })).toBe(UNCONFIRMED_NOTE);
    expect(deliveryNote({ turn: 0, delivery: "unconfirmed", waiting: true })).toBe(`${UNCONFIRMED_NOTE}，${WAITING_NOTE}`);
    expect(deliveryNote({ turn: 0, waiting: true })).toBe(WAITING_NOTE);
    expect(deliveryNote({ turn: 0, delivery: "confirmed" })).toBe("");
    expect(deliveryNote(undefined)).toBe("");
  });
});

describe("composer for a session outside nex_bot's terminals", () => {
  it("takes a message and says where it goes, with no interrupt", async () => {
    await show(session({ nativeId: "o1", liveIn: "desktop", terminal: undefined, state: "running", sendVia: "inbox" }));
    expect(area()).not.toBeNull();
    expect(note()).toBe(OUTSIDE_NOTE);
    expect(container.querySelector("button[aria-label=中断]")).toBeNull();
    expect(container.querySelector("[data-testid=cli-composer]")?.classList.contains("is-blocked")).toBe(false);
  });

  it("sends, then reports a delivery it could not confirm", async () => {
    const onSend = vi.fn(async () => ({ turn: 0, started: false, delivery: "unconfirmed" }));
    await show(undefined, onSend);
    await type("  继续  ");
    expect(sendButton().disabled).toBe(false);
    await submit();
    expect(onSend).toHaveBeenCalledWith("继续");
    expect(area().value).toBe("");
    expect(note()).toBe(UNCONFIRMED_NOTE);
    await type("下一条");
    expect(note()).toBe(OUTSIDE_NOTE);
  });

  it("tells a waiting session when its answer will be read", async () => {
    await show(undefined, async () => ({ turn: 0, delivery: "unconfirmed", waiting: true }));
    await type("选 2");
    await submit();
    expect(note()).toBe(`${UNCONFIRMED_NOTE}，${WAITING_NOTE}`);
  });

  it("says nothing extra for a confirmed delivery", async () => {
    await show(undefined, async () => ({ turn: 0, delivery: "confirmed" }));
    await type("好");
    await submit();
    expect(note()).toBe(OUTSIDE_NOTE);
  });

  it("keeps the text and shows the reason when the send is refused", async () => {
    await show(undefined, async () => { throw new CliApiError("x", "invalid", 400, "不能发送斜杠命令"); });
    await type("/clear");
    await submit();
    expect(area().value).toBe("/clear");
    expect(container.querySelector("[role=alert]")?.textContent).toBe("不能发送斜杠命令");
    expect(note()).toBe(OUTSIDE_NOTE);
  });

  it("shows no such line in a nex_bot terminal, and blocks a session with no route", async () => {
    await show(session());
    expect(area()).not.toBeNull();
    expect(note()).toBeUndefined();
    await show(session({ nativeId: "o2", liveIn: "terminal", terminal: undefined }));
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("在电脑上运行");
  });

  it("does not offer sending when the computer is offline", async () => {
    await show(session({ nativeId: "o3", liveIn: "terminal", terminal: undefined, sendVia: "daemon", online: false }));
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("电脑离线");
  });
});
