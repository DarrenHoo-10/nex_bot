// @vitest-environment happy-dom
// The message box for a session that runs on the computer outside nex_bot's terminals.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliApiError } from "./api";

const uploadAttachment = vi.hoisted(() => vi.fn(async () => ({ path: "/api/cli-agents/images/12345678-0000-4000-8000-000000000000" })));
const fetchSkills = vi.hoisted(() => vi.fn(async () => [
  { name: "agent-reach", description: "全网调研" },
  { name: "archive", description: "整理归档" },
]));
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), uploadAttachment, fetchSkills }));
const layout = vi.hoisted(() => ({ compact: false }));
vi.mock("../components/use-compact-composer", () => ({ useCompactComposer: () => layout.compact }));
import { Composer, deliveryNote, UNCONFIRMED_NOTE, WAITING_NOTE } from "./Composer";
import { session } from "./fixtures";

let root: Root;
let container: HTMLDivElement;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const area = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const note = () => container.querySelector("[data-testid=cli-composer-note]")?.textContent;
const sendButton = () => container.querySelector<HTMLButtonElement>("button[aria-label=发送]")!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // the model menu is a popover; the test DOM has no popover API
  HTMLElement.prototype.showPopover ??= function () {};
  HTMLElement.prototype.hidePopover ??= function () {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  layout.compact = false;
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

it.each(["codex", "claude"] as const)("finds a %s skill by partial name and description and keeps the pending draft", async engine => {
  const row = session({ nativeId: "pick-skill", engine, liveIn: "terminal", terminal: undefined, sendVia: engine === "claude" ? "inbox" : "daemon" });
  const onSend = vi.fn(async () => ({}));
  await act(async () => root.render(createElement(Composer, { session: row, features: ["skills"], onSend, onInterrupt: async () => ({}) })));
  await type("分析这个项目");
  await act(async () => container.querySelector<HTMLButtonElement>("[aria-label=添加]")!.click());
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "技能")!.click());
  const search = container.querySelector<HTMLInputElement>("[aria-label=搜索技能]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "agrc 调研");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const rows = container.querySelectorAll<HTMLButtonElement>("[data-skill-result]");
  expect(rows).toHaveLength(1);
  await act(async () => rows[0]!.click());
  expect(area().value).toBe("分析这个项目");
  expect(onSend).not.toHaveBeenCalled();
  await submit();
  const invocation = engine === "codex" ? "$agent-reach" : "请调用 Skill 工具使用「agent-reach」技能。";
  expect(onSend).toHaveBeenCalledWith(invocation + "\n\n分析这个项目");
});

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
  it("takes a message without redundant resting copy, with no interrupt", async () => {
    await show(session({ nativeId: "o1", liveIn: "desktop", terminal: undefined, state: "running", sendVia: "inbox" }));
    expect(area()).not.toBeNull();
    expect(note()).toBeUndefined();
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
    expect(note()).toBeUndefined();
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
    expect(note()).toBeUndefined();
  });

  it("keeps the text and shows the reason when the send is refused", async () => {
    await show(undefined, async () => { throw new CliApiError("x", "invalid", 400, "不能发送斜杠命令"); });
    await type("/clear");
    await submit();
    expect(area().value).toBe("/clear");
    expect(container.querySelector("[role=alert]")?.textContent).toBe("不能发送斜杠命令");
    expect(note()).toBeUndefined();
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

  it("sends a pasted screenshot as a private Core link", async () => {
    const onSend = vi.fn(async (_text: string) => ({ turn: 1 }));
    const row = session({ nativeId: "s1" });
    await act(async () => { root.render(createElement(Composer, { session: row, onSend, onInterrupt: async () => ({}), features: ["attach"] })); });
    await paste(png());
    for (let i = 0; i < 20 && !container.querySelector(".na-file-thumb"); i++) await flush();
    expect(container.querySelector<HTMLImageElement>(".na-file-chip[data-image] img.na-file-thumb")?.src).toMatch(/^data:image\/png;base64,/);
    await type("看看这个报错");
    await submit();
    expect(uploadAttachment).toHaveBeenCalledWith(row.key, expect.objectContaining({ name: "shot.png" }));
    expect(onSend.mock.calls[0][0]).toBe("看看这个报错\n\n![shot.png](/api/cli-agents/images/12345678-0000-4000-8000-000000000000)");
  });

  it("echoes the caption and attachment before upload completes and sends only once", async () => {
    let finish!: (value: { path: string }) => void;
    uploadAttachment.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const preview = vi.fn(), onSend = vi.fn(async () => ({}));
    await act(async () => { root.render(createElement(Composer, { session: session({ nativeId: "upload-delay" }), onSend, onUploadPreview: preview, onInterrupt: async () => ({}) })); });
    await paste(png()); await type("查一下"); await submit();
    expect(preview).toHaveBeenCalledWith("查一下\n图片：shot.png");
    expect(onSend).not.toHaveBeenCalled();
    await type("下一条");
    expect(sendButton().disabled).toBe(true);
    await act(async () => finish({ path: "/api/cli-agents/images/12345678-0000-4000-8000-000000000000" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(area().value).toBe("下一条");
    expect(preview).toHaveBeenLastCalledWith(null);
  });

  it("sends an image even when the execution device cannot upload files", async () => {
    const onSend = vi.fn(async (_text: string) => ({ turn: 1 }));
    await act(async () => { root.render(createElement(Composer, { session: session({ nativeId: "s2" }), onSend, onInterrupt: async () => ({}), features: [] })); });
    await paste(png());
    expect(container.querySelector(".na-file-chip")).toBeTruthy();
    await submit();
    expect(onSend.mock.calls[0][0]).toBe("![shot.png](/api/cli-agents/images/12345678-0000-4000-8000-000000000000)");
  });

  it("attaches screenshots pasted via Electron desktop onClipboardImage and skips when focus is in another input or terminal", async () => {
    let listener: ((image: { name: string; type: string; bytes: Uint8Array }) => void) | undefined;
    const unsubscribe = vi.fn();
    (window as unknown as { nex?: { onClipboardImage?: (cb: (image: { name: string; type: string; bytes: Uint8Array }) => void) => () => void } }).nex = {
      onClipboardImage: (cb) => { listener = cb; return unsubscribe; },
    };
    try {
      const onSend = vi.fn(async (_text: string) => ({ turn: 1 }));
      await act(async () => { root.render(createElement(Composer, { session: session({ nativeId: "s-ipc" }), onSend, onInterrupt: async () => ({}), features: ["attach"] })); });
      expect(listener).toBeTypeOf("function");

      // Focus inside another textarea or terminal must NOT attach to this composer.
      const other = document.createElement("textarea");
      document.body.append(other);
      other.focus();
      await act(async () => { listener!({ name: "skip.png", type: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }); });
      expect(container.querySelector(".na-file-chip")).toBeNull();
      other.remove();

      // Focus inside the composer attaches the screenshot cleanly.
      area().focus();
      await act(async () => { listener!({ name: "clip.png", type: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }); });
      expect(container.querySelector(".na-file-chip[data-image]")).toBeTruthy();
      await submit();
      expect(onSend.mock.calls[0][0]).toBe("![clip.png](/api/cli-agents/images/12345678-0000-4000-8000-000000000000)");
    } finally {
      delete (window as unknown as { nex?: unknown }).nex;
    }
  });
});

describe("the toolbar under the message", () => {
  const actionLabels = () => [...container.querySelectorAll(".cli-composer-actions button")].map((entry) => entry.getAttribute("aria-label"));
  const press = async (target: Element) => { await act(async () => { target.dispatchEvent(new Event("pointerdown", { bubbles: true })); }); };
  const click = async (label: string) => { await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(); }); };
  const menu = () => document.querySelector(".na-model-menu");

  it("shows the model on one button just left of the context ring", async () => {
    await show(session({ model: "claude-opus-5" }));
    const labels = actionLabels();
    expect(labels.indexOf("模型设置")).toBe(labels.indexOf("上下文用量") - 1);
    expect(container.querySelector('button[aria-label="模型设置"] span')?.textContent).toBe("claude-opus-5");
  });

  it("on a phone shows only the model name there, and no model entry under +", async () => {
    layout.compact = true;
    await show(session({ model: "claude-opus-5" }));
    const trigger = container.querySelector('button[aria-label="模型设置"]')!;
    expect(trigger.classList.contains("na-model-chip")).toBe(true);
    await click("添加");
    expect([...container.querySelectorAll(".na-add-menu button")].map((entry) => entry.textContent)).not.toContain("模型");
    await click("模型设置");
    expect(menu()).toBeTruthy();
  });

  it("closes the context details on a press anywhere but the details, the message field included", async () => {
    await show(session());
    await click("上下文用量");
    expect(container.querySelector(".na-context-detail")).toBeTruthy();
    await press(container.querySelector(".na-context-detail")!);
    expect(container.querySelector(".na-context-detail")).toBeTruthy();
    await press(area());
    expect(container.querySelector(".na-context-detail")).toBeNull();
    await click("上下文用量");
    await press(document.body);
    expect(container.querySelector(".na-context-detail")).toBeNull();
  });

  it("closes the + menu on a press in the message field, and its button still toggles it", async () => {
    await show(session());
    await click("添加");
    expect(container.querySelector(".na-add-menu")).toBeTruthy();
    await press(container.querySelector('button[aria-label="添加"]')!);
    await click("添加");
    expect(container.querySelector(".na-add-menu")).toBeNull();
    await click("添加");
    await press(area());
    expect(container.querySelector(".na-add-menu")).toBeNull();
  });

  it("closes the model menu on a press outside it, and swaps it for the context details in one tap", async () => {
    await show(session());
    await click("模型设置");
    expect(menu()).toBeTruthy();
    await press(menu()!);
    expect(menu()).toBeTruthy();
    await press(area());
    expect(menu()).toBeNull();
    await click("模型设置");
    await press(container.querySelector('button[aria-label="上下文用量"]')!);
    await click("上下文用量");
    expect(menu()).toBeNull();
    expect(container.querySelector(".na-context-detail")).toBeTruthy();
  });
});
