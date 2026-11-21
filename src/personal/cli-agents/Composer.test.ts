// @vitest-environment happy-dom
// The message box for a session that runs on the computer outside nex_bot's terminals.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliApiError } from "./api";

const uploadAttachment = vi.hoisted(() => vi.fn(async (_key: string, file: File) => ({ path: "C:\\Temp\\nexbot-attachments\\claude-s1\\ab12cd34-" + file.name })));
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), uploadAttachment }));
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
  await act(async () => { root.render(createElement(Composer, { session: row, onSend, onInterrupt: async () => ({}) })); });
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

  it("keeps the next draft when a pending send finishes", async () => {
    let finish!:()=>void;
    await show(session({nativeId:"pending-draft"}),()=>new Promise<void>(resolve=>{finish=resolve}));
    await type("第一条");
    await submit();
    expect(sendButton().disabled).toBe(true);
    await type("下一条草稿");
    await act(async()=>finish());
    expect(area().value).toBe("下一条草稿");
    expect(sendButton().disabled).toBe(false);
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

describe("images", () => {
  const paste = async (file: File) => {
    await act(async () => {
      const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      event.clipboardData = { items: [{ kind: "file", type: file.type, getAsFile: () => file }], files: [file] };
      area().dispatchEvent(event);
    });
  };
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });

  it("takes a pasted screenshot, puts it on the computer and names its path in the message", async () => {
    const onSend = vi.fn(async (_text: string) => ({ turn: 1 }));
    const row = session({ nativeId: "s1" });
    await act(async () => { root.render(createElement(Composer, { session: row, onSend, onInterrupt: async () => ({}), features: ["attach"] })); });
    await paste(png());
    for (let i = 0; i < 20 && !container.querySelector(".na-file-thumb"); i++) await flush();
    expect(container.querySelector<HTMLImageElement>(".na-file-chip[data-image] img.na-file-thumb")?.src).toMatch(/^data:image\/png;base64,/);
    await type("看看这个报错");
    await submit();
    expect(uploadAttachment).toHaveBeenCalledWith(row.key, expect.objectContaining({ name: "shot.png" }));
    expect(onSend.mock.calls[0][0]).toBe("看看这个报错\n\n图片：shot.png\nC:\\Temp\\nexbot-attachments\\claude-s1\\ab12cd34-shot.png");
  });

  it("says the computer needs an update when its executor cannot take files", async () => {
    await act(async () => { root.render(createElement(Composer, { session: session({ nativeId: "s2" }), onSend: async () => ({}), onInterrupt: async () => ({}), features: [] })); });
    await paste(png());
    expect(container.querySelector(".na-file-chip")).toBeNull();
    expect(container.querySelector(".cli-composer-error")?.textContent).toBe("电脑端版本过旧，升级后可发送图片");
  });
});
