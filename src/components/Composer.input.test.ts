import { Children, createElement, isValidElement, type ReactElement, type ReactNode, type KeyboardEvent, type ClipboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { Attachment } from "@/lib/composer-attachments";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  text: "你好",
  attachments: [] as Attachment[],
  intake: vi.fn().mockResolvedValue({ attachments: [] }),
  upload: vi.fn(),
}));
vi.mock("@/state/store", async (original) => {
  const store = await original<typeof import("@/state/store")>();
  return { ...store, useStore: () => ({ state: store.initialState, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/drafts", async (original) => ({
  ...await original<typeof import("@/lib/drafts")>(),
  useComposerDraft: () => [fixture.text, vi.fn(), fixture.attachments, vi.fn()],
}));
vi.mock("@/lib/composer-attachments", async (original) => ({
  ...await original<typeof import("@/lib/composer-attachments")>(),
  intakeFiles: fixture.intake,
  imageAttachmentFromFile: fixture.upload,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { Composer } from "./Composer";
import { MentionTextarea } from "./MentionTextarea";
import { ComposerAttachments } from "./ComposerAttachments";
import { forgetFailedComposerSend, getDraftAttachments, rememberFailedComposerSend, restoreComposerDraft } from "@/lib/drafts";

const bot: Bot = {
  id: "input-fixture", threadId: "input-thread", name: "Fixture", title: "", description: "",
  color: "green", notifications: true, unread: false, messages: [],
  modelSelection: { instanceId: "no-image-capabilities", model: "text" },
};

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(tree).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...nodes(child.props.children as ReactNode)] : []);
}

function render() {
  let tree: ReactNode;
  function Capture() { tree = Composer({ bot }); return tree; }
  renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const input = all.find((node) => node.type === MentionTextarea)! as unknown as ReactElement<Parameters<typeof MentionTextarea>[0]>;
  return { all, input: input.props };
}

function enter(isComposing = false, shiftKey = false) {
  return { key: "Enter", shiftKey, nativeEvent: { isComposing }, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  fixture.dispatch.mockClear();
  fixture.intake.mockClear();
  fixture.upload.mockReset().mockImplementation(async (_file, optimistic) => ({ ...optimistic, path: "/tmp/pasted.png", uploading: false }));
  fixture.text = "你好";
  fixture.attachments = [];
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("composer input", () => {
  it("keeps IME Enter and the first 149ms after composition out of sending; sends at 150ms", () => {
    const { input } = render();
    input.onKeyDown!(enter(true));
    input.onCompositionEnd!({} as never);
    vi.mocked(Date.now).mockReturnValue(1_149);
    input.onKeyDown!(enter());
    expect(fixture.dispatch).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(1_150);
    input.onKeyDown!(enter());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "你好" }));
  });

  it("leaves Shift+Enter to native newline handling, including with a slash picker", () => {
    fixture.text = "/";
    const { input } = render();
    const event = enter(false, true);
    input.onKeyDown!(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("sends an image with no advertised model image capability", () => {
    fixture.attachments = [{ kind: "image", id: "image", path: "/tmp/fixture.png", name: "fixture.png", size: 12, mime: "image/png" }];
    const { all, input } = render();
    expect(all.find((node) => node.type === ComposerAttachments)!.props.allowImages).toBe(true);
    input.onKeyDown!(enter());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: expect.stringContaining("<attached-image ") }));
  });

  it("allows image file selection and retains the actual clipboard-read error", async () => {
    const { all, input } = render();
    const picker = all.find((node) => node.type === "input" && node.props.type === "file")!;
    await (picker.props.onChange as (event: unknown) => Promise<void>)({ target: { files: [{ name: "fixture.png" }], value: "" } });
    expect(fixture.intake).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ allowImages: true }));
    const event = { preventDefault: vi.fn(), clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => null }], files: [] } };
    input.onPaste!(event as unknown as ClipboardEvent<HTMLTextAreaElement>);
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringMatching(/clipboard/i) }));
  });

  it("uploads pasted image pixels even when the current model advertises no image capability", async () => {
    const draftId = `bot:${bot.id}:${bot.threadId}`;
    const { input } = render();
    const file = new File(["synthetic pixels"], "pasted.png", { type: "image/png" });
    const event = { preventDefault: vi.fn(), clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }], files: [file],
    } };
    try {
      input.onPaste!(event as unknown as ClipboardEvent<HTMLTextAreaElement>);
      await vi.waitFor(() => expect(getDraftAttachments(localStorage, draftId)).toEqual([
        expect.objectContaining({ kind: "image", path: "/tmp/pasted.png", uploading: false }),
      ]));
      expect(event.preventDefault).toHaveBeenCalled();
      expect(fixture.upload).toHaveBeenCalledWith(file, expect.objectContaining({ kind: "image" }));
      expect(fixture.dispatch).not.toHaveBeenCalled();
    } finally {
      restoreComposerDraft(draftId, { text: "", attachments: [] });
    }
  });

  it("retries a failed image send without consulting model capabilities", () => {
    const draftId = `bot:${bot.id}:${bot.threadId}`;
    const failed = rememberFailedComposerSend(draftId, {
      sendId: "retry-image", text: "image", requestText: '<attached-image path="/tmp/fixture.png" />', threadId: bot.threadId,
    });
    try {
      const { all } = render();
      const retry = all.find((node) => node.type === "button" && node.props.children === "Retry")!;
      (retry.props.onClick as () => void)();
      expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", sendId: "retry-image" }));
    } finally {
      forgetFailedComposerSend(draftId, failed.id);
    }
  });
});
