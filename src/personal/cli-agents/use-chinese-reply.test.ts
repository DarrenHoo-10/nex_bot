// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEnglishReply, resetReplyTranslations, splitReply, STABLE_MS } from "./use-chinese-reply";

vi.mock("../AgentDesktop", () => ({ RichText: ({ value }: { value: string }) => createElement("p", { "data-testid": "rich" }, value) }));

import { type CliSessionKey } from "../../../shared/cli-agents";
import { ReplyText } from "./TranscriptView";

const ENGLISH = "Please restart the server and check the logs again.";
const zh = (text: string) => `[中]${text}`;

let container: HTMLDivElement;
let root: Root;
const translate = vi.fn(async (text: string) => zh(text));
const availability = vi.fn(async (): Promise<string> => "available");
const create = vi.fn(async () => ({ translate }));

function install(state: string) {
  availability.mockResolvedValue(state);
  vi.stubGlobal("Translator", { availability, create });
  (window as unknown as { Translator: unknown }).Translator = { availability, create };
}
async function render(source: string, supplied?: string) {
  await act(async () => { root.render(createElement(ReplyText, { source, supplied })); });
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const shown = () => container.querySelector("[data-testid=rich]")?.textContent;
const button = () => container.querySelector("button")?.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  translate.mockClear();
  availability.mockReset();
  create.mockClear();
  resetReplyTranslations();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as unknown as { Translator?: unknown }).Translator;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("splitReply", () => {
  it("rebuilds the input and never marks code, links, URLs or paths for translation", () => {
    const text = [
      "Run `npm run build` first, then open https://example.com/docs?a=1 in the browser.",
      "",
      "```bash",
      "echo hello world from the shell",
      "```",
      "",
      "- Edit src/app/main.ts and see [the guide](https://example.com/guide) for details.",
      "    indented code stays as it is here",
      "| name | note |",
      "| --- | --- |",
      "| alpha | This is a note about alpha |",
    ].join("\n");
    const segments = splitReply(text);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    const sent = segments.filter((s) => s.translate).map((s) => s.text);
    expect(sent.join("\n")).not.toMatch(/npm run build|example\.com|echo hello|src\/app\/main\.ts|indented code/);
    expect(sent).toContain("first, then open");
    expect(sent).toContain("This is a note about alpha");
    expect(sent.some((s) => s.startsWith("-"))).toBe(false);
  });

  it("keeps an unclosed fence verbatim", () => {
    const segments = splitReply("Intro sentence here.\n```ts\nconst answer = 42; // do the thing now");
    expect(segments.filter((s) => s.translate).map((s) => s.text)).toEqual(["Intro sentence here."]);
  });
});

describe("isEnglishReply", () => {
  it("accepts English prose and rejects Chinese, mixed-Chinese, code-only and tiny replies", () => {
    expect(isEnglishReply(ENGLISH)).toBe(true);
    expect(isEnglishReply("请重启服务器，然后再检查一次日志。")).toBe(false);
    expect(isEnglishReply("请运行 npm install 然后重启服务")).toBe(false);
    expect(isEnglishReply("```ts\nconst longVariableName = anotherLongName;\n```")).toBe(false);
    expect(isEnglishReply("OK")).toBe(false);
  });
});

describe("Core reply translation", () => {
  it("shows original before completion and while waiting, then toggles the Core translation", async () => {
    const fetchTranslation = vi.fn<typeof fetch>();
    let finish!: (response: Response) => void;
    fetchTranslation.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchTranslation);
    const core = { key: "fixture:claude:session" as CliSessionKey, id: "reply" };
    await act(async () => { root.render(createElement(ReplyText, { source: ENGLISH, local: false })); });
    expect(shown()).toBe(ENGLISH);
    expect(fetchTranslation).not.toHaveBeenCalled();
    await act(async () => { root.render(createElement(ReplyText, { source: ENGLISH, local: false, core })); });
    expect(shown()).toBe(ENGLISH);
    expect(fetchTranslation.mock.calls[0]?.[0]).toBe("/api/cli-agents/translate");
    await act(async () => finish(Response.json({ translation: "请重启服务器，然后再检查一次日志。" })));
    expect(shown()).toBe("请重启服务器，然后再检查一次日志。");
    await act(async () => { container.querySelector("button")!.click(); });
    expect(shown()).toBe(ENGLISH);
  });
});

describe("ReplyText Chinese reading", () => {
  it("translates automatically once the text is stable and offers the original", async () => {
    install("available");
    await render(ENGLISH);
    expect(shown()).toBe(ENGLISH);
    expect(translate).not.toHaveBeenCalled();
    await advance(STABLE_MS + 10);
    expect(shown()).toBe(zh(ENGLISH));
    expect(button()).toContain("查看原文");
    await act(async () => { container.querySelector("button")!.click(); });
    expect(shown()).toBe(ENGLISH);
    expect(button()).toContain("查看中文");
    await act(async () => { container.querySelector("button")!.click(); });
    expect(shown()).toBe(zh(ENGLISH));
  });

  it("also auto-translates when the older API reports readily", async () => {
    install("readily");
    await render(ENGLISH);
    await advance(STABLE_MS + 10);
    expect(shown()).toBe(zh(ENGLISH));
  });

  it("waits for the user when a language pack must be downloaded", async () => {
    install("downloadable");
    await render(ENGLISH);
    await advance(STABLE_MS + 10);
    expect(shown()).toBe(ENGLISH);
    expect(create).not.toHaveBeenCalled();
    expect(button()).toContain("翻译成中文");
    await act(async () => { container.querySelector("button")!.click(); });
    await advance(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(shown()).toBe(zh(ENGLISH));
  });

  it("leaves the original alone, with no control, when translation is unavailable or absent", async () => {
    install("unavailable");
    await render(ENGLISH);
    await advance(STABLE_MS + 10);
    expect(shown()).toBe(ENGLISH);
    expect(container.querySelector("button")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    delete (window as unknown as { Translator?: unknown }).Translator;
    await render(`${ENGLISH} Again.`);
    await advance(STABLE_MS + 10);
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers a retry when translating fails and recovers on retry", async () => {
    install("available");
    translate.mockRejectedValueOnce(new Error("boom"));
    await render(ENGLISH);
    await advance(STABLE_MS + 10);
    expect(shown()).toBe(ENGLISH);
    expect(button()).toContain("重试翻译");
    await act(async () => { container.querySelector("button")!.click(); });
    await advance(0);
    expect(shown()).toBe(zh(ENGLISH));
  });

  it("sends only prose to the translator and keeps code, commands and links byte-identical", async () => {
    install("available");
    const source = [
      "Run `npm run build` first, then open https://example.com/docs in the browser.",
      "",
      "```bash",
      "echo hello world from the shell",
      "```",
      "",
      "- Edit src/app/main.ts and read [the guide](https://example.com/guide) carefully.",
    ].join("\n");
    await render(source);
    await advance(STABLE_MS + 10);
    const sent = translate.mock.calls.map((call) => call[0]);
    expect(sent.join("\n")).not.toMatch(/npm run build|example\.com|echo hello|main\.ts/);
    const text = shown()!;
    for (const kept of ["`npm run build`", "https://example.com/docs", "```bash\necho hello world from the shell\n```", "src/app/main.ts", "](https://example.com/guide)", "- "]) expect(text).toContain(kept);
    expect(text).toContain(zh("first, then open"));
  });

  it("does not translate Chinese replies", async () => {
    install("available");
    await render("请重启服务器，然后再检查一次日志。");
    await advance(STABLE_MS + 10);
    expect(availability).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
  });

  it("uses supplied review translations without calling the translator", async () => {
    install("available");
    await render(ENGLISH, "已提供的译文");
    await advance(STABLE_MS + 10);
    expect(shown()).toBe("已提供的译文");
    expect(translate).not.toHaveBeenCalled();
    expect(availability).not.toHaveBeenCalled();
  });

  it("does not translate streaming text until it stops changing", async () => {
    install("available");
    await render("Please restart the server");
    await advance(STABLE_MS - 300);
    await render("Please restart the server and check");
    await advance(STABLE_MS - 300);
    await render(ENGLISH);
    await advance(STABLE_MS - 300);
    expect(translate).not.toHaveBeenCalled();
    expect(shown()).toBe(ENGLISH);
    await advance(400);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][0]).toBe(ENGLISH);
    expect(shown()).toBe(zh(ENGLISH));
  });

  it("serves a cached translation without translating again, including after the in-memory copy is gone", async () => {
    install("available");
    await render(ENGLISH);
    await advance(STABLE_MS + 10);
    expect(translate).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(ENGLISH);
    expect(shown()).toBe(zh(ENGLISH));
    await advance(STABLE_MS + 10);
    expect(translate).toHaveBeenCalledTimes(1);

    // a page reload keeps sessionStorage but loses module memory
    const keyName = Object.keys(window.sessionStorage).find((key) => key.startsWith("nexbot.cli-reply-zh."))!;
    const saved = window.sessionStorage.getItem(keyName)!;
    expect(saved).toContain("[中]");
    await act(async () => root.unmount());
    root = createRoot(container);
    resetReplyTranslations();
    window.sessionStorage.setItem(keyName, saved);
    await render(ENGLISH);
    expect(shown()).toBe(zh(ENGLISH));
    expect(translate).toHaveBeenCalledTimes(1);
  });
});
