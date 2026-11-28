import { describe, expect, it } from "vitest";
import {
  clampFontSize,
  decodeShortcuts,
  DEFAULT_SHORTCUTS,
  encodeKey,
  escapePastePath,
  FIND_CLOSED,
  FIND_LIMIT,
  findDecorationsFor,
  findLabel,
  findReducer,
  FONT_SIZES,
  isCtrlV,
  isFindShortcut,
  isWindowsPath,
  keyDecision,
  keyNameForBytes,
  lineCount,
  lineEditBytes,
  modifierHeld,
  modifierReleased,
  modifiersActive,
  modifiersPressed,
  modifierTapped,
  moveShortcut,
  NO_MODIFIERS,
  OSC52_MAX_CHARS,
  osc52Text,
  parseCursorStyle,
  parseTerminalTheme,
  pastedPaths,
  queryFromSelection,
  refuseUpload,
  resolveTerminalPalette,
  TERMINAL_THEME_IDS,
  terminalMenu,
  typedWithModifiers,
  uploadingText,
  uploadName,
  wantsOwnMenu,
  webLink,
  withFamily,
  withModifiers,
  type KeyEventLike,
} from "./terminal-logic";

const keyEvent = (overrides: Partial<KeyEventLike> = {}): KeyEventLike => ({
  type: "keydown",
  key: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe("themes & prefs", () => {
  it("resolves built-in themes and adapts page/solarized to pageDark", () => {
    expect(TERMINAL_THEME_IDS).toEqual(["ink", "midnight", "page", "solarized"]);
    expect(parseTerminalTheme("midnight")).toBe("midnight");
    expect(parseTerminalTheme("unknown")).toBe("ink");
    expect(parseTerminalTheme(null)).toBe("ink");

    expect(resolveTerminalPalette("ink", false).dark).toBe(true);
    expect(resolveTerminalPalette("midnight", false).dark).toBe(true);
    expect(resolveTerminalPalette("page", false).dark).toBe(false);
    expect(resolveTerminalPalette("page", true).dark).toBe(true);
    expect(resolveTerminalPalette("solarized", false).palette.background).toBe("#fdf6e3");
    expect(resolveTerminalPalette("solarized", true).palette.background).toBe("#002b36");
    expect(findDecorationsFor(true).activeMatchBorder).not.toBe(findDecorationsFor(false).activeMatchBorder);
  });

  it("validates cursor style, font size and saved quick commands", () => {
    expect(parseCursorStyle("bar")).toBe("bar");
    expect(parseCursorStyle("underline")).toBe("underline");
    expect(parseCursorStyle("other")).toBe("block");

    expect(clampFontSize(4)).toBe(FONT_SIZES.min);
    expect(clampFontSize(99)).toBe(FONT_SIZES.max);
    expect(clampFontSize(15.6)).toBe(16);
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZES.default);

    expect(decodeShortcuts(null)).toEqual([...DEFAULT_SHORTCUTS]);
    expect(decodeShortcuts("not-json")).toEqual([...DEFAULT_SHORTCUTS]);
    expect(decodeShortcuts('["git status","pnpm lint"]')).toEqual(["git status", "pnpm lint"]);
    expect(decodeShortcuts("[]")).toEqual([]);
    expect(moveShortcut(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveShortcut(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
  });
});

describe("tri-state modifiers & VT key encoding", () => {
  it("transitions off -> once -> locked -> off and hold/release", () => {
    let m = NO_MODIFIERS;
    expect(modifiersActive(m)).toBe(false);

    m = modifierTapped(m, "ctrl", false);
    expect(m.ctrl).toBe("once");
    expect(modifiersActive(m)).toBe(true);
    expect(withModifiers(m, "c")).toBe("ctrl+c");
    expect(withModifiers(m, "esc")).toBe("esc");

    // double tap locks
    m = modifierTapped(m, "ctrl", true);
    expect(m.ctrl).toBe("locked");
    expect(modifiersPressed(m).ctrl).toBe("locked");

    // tapping locked clears
    m = modifierTapped(m, "ctrl", false);
    expect(m.ctrl).toBe("off");

    // single tap once clears after a press
    m = modifierTapped(NO_MODIFIERS, "alt", false);
    expect(modifiersPressed(m).alt).toBe("off");

    // hold + unused release falls back to once; hold + used release clears
    m = modifierHeld(NO_MODIFIERS, "ctrl");
    expect(modifierReleased(m, "ctrl").ctrl).toBe("once");
    m = modifiersPressed(m);
    expect(modifierReleased(m, "ctrl").ctrl).toBe("off");
  });

  it("maps typed characters and VT sequences", () => {
    expect(typedWithModifiers({ ...NO_MODIFIERS, ctrl: "once" }, "c")).toEqual({ key: "ctrl+c" });
    expect(typedWithModifiers({ ...NO_MODIFIERS, shift: "once" }, "a")).toEqual({ text: "A" });
    expect(typedWithModifiers({ ...NO_MODIFIERS, ctrl: "once" }, " ")).toEqual({ key: "ctrl+space" });
    expect(typedWithModifiers({ ...NO_MODIFIERS, ctrl: "once" }, "中")).toEqual({ text: "中" });

    expect(keyNameForBytes("\r")).toBe("enter");
    expect(keyNameForBytes("\x1b[A")).toBe("up");
    expect(keyNameForBytes("\x1bOA")).toBe("up");
    expect(keyNameForBytes("x")).toBeNull();

    expect(encodeKey("enter")).toBe("\r");
    expect(encodeKey("shift+enter")).toBe("\x1b\r");
    expect(encodeKey("tab")).toBe("\t");
    expect(encodeKey("shift+tab")).toBe("\x1b[Z");
    expect(encodeKey("ctrl+c")).toBe("\x03");
    expect(encodeKey("ctrl+space")).toBe("\x00");
    expect(encodeKey("alt+b")).toBe("\x1bb");
    expect(encodeKey("up", false)).toBe("\x1b[A");
    expect(encodeKey("up", true)).toBe("\x1bOA");
    expect(encodeKey("ctrl+right", true)).toBe("\x1b[1;5C");
    expect(encodeKey("f1")).toBe("\x1bOP");
    expect(encodeKey("pageup")).toBe("\x1b[5~");
    expect(encodeKey("ctrl++")).toBe("+");
    expect(encodeKey("unknownkey")).toBeNull();
  });
});

describe("keyboard shortcuts", () => {
  it("handles Shift+Enter, Ctrl/Cmd+C selection copy, Mac line editing, Ctrl+V and Find", () => {
    expect(keyDecision(keyEvent({ key: "Enter", shiftKey: true }), false)).toBe("newline");
    expect(keyDecision(keyEvent({ type: "keyup", key: "Enter", shiftKey: true }), false)).toBe("swallow");
    expect(keyDecision(keyEvent({ key: "Enter", shiftKey: true, isComposing: true }), false)).toBe("xterm");
    expect(keyDecision(keyEvent({ key: "c", ctrlKey: true }), true)).toBe("copy");
    expect(keyDecision(keyEvent({ key: "c", ctrlKey: true }), false)).toBe("xterm");

    expect(lineEditBytes(keyEvent({ key: "Backspace", metaKey: true }))).toBe("\x15");
    expect(lineEditBytes(keyEvent({ key: "ArrowLeft", metaKey: true }))).toBe("\x01");
    expect(lineEditBytes(keyEvent({ key: "ArrowRight", metaKey: true }))).toBe("\x05");
    expect(lineEditBytes(keyEvent({ key: "Backspace", ctrlKey: true }))).toBeNull();

    expect(isCtrlV(keyEvent({ key: "v", ctrlKey: true }), false)).toBe(true);
    expect(isCtrlV(keyEvent({ key: "v", ctrlKey: true }), true)).toBe(false);

    expect(isFindShortcut(keyEvent({ key: "f", metaKey: true }), { mac: true, driving: true })).toBe(true);
    expect(isFindShortcut(keyEvent({ key: "f", ctrlKey: true }), { mac: false, driving: true })).toBe(false);
    expect(isFindShortcut(keyEvent({ key: "f", ctrlKey: true, shiftKey: true }), { mac: false, driving: true })).toBe(true);
    expect(isFindShortcut(keyEvent({ key: "f", ctrlKey: true }), { mac: false, driving: false })).toBe(true);
  });
});

describe("clipboard, links, path escaping and uploads", () => {
  it("guards OSC 52 and clickable web links", () => {
    expect(osc52Text("")).toBeNull();
    expect(osc52Text("hello")).toBe("hello");
    expect(osc52Text("x".repeat(OSC52_MAX_CHARS + 1))).toBeNull();

    expect(webLink("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(webLink("http://localhost:8080")).toBe("http://localhost:8080/");
    expect(webLink("javascript:alert(1)")).toBeNull();
    expect(webLink("file:///etc/passwd")).toBeNull();
  });

  it("escapes POSIX and Windows paths and validates uploads", () => {
    expect(isWindowsPath("C:\\Users\\demo\\a.png")).toBe(true);
    expect(isWindowsPath("\\\\server\\share\\a.png")).toBe(true);
    expect(isWindowsPath("/tmp/a.png")).toBe(false);

    expect(escapePastePath("/tmp/hello world (1).png")).toBe("/tmp/hello\\ world\\ \\(1\\).png");
    expect(escapePastePath("/tmp/截图.png")).toBe("/tmp/截图.png");
    expect(escapePastePath("C:\\Users\\demo\\file.png")).toBe("C:\\Users\\demo\\file.png");
    expect(escapePastePath("C:\\Users\\my docs\\a.png")).toBe('"C:\\Users\\my docs\\a.png"');
    expect(pastedPaths(["/tmp/a b.png", "/tmp/c.txt"])).toBe("/tmp/a\\ b.png /tmp/c.txt ");

    expect(lineCount("single\n")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\r\nb\r\nc\r\n")).toBe(3);

    expect(uploadName({ name: "", type: "image/png" })).toBe("image.png");
    expect(uploadName({ name: "clip", type: "image/webp" })).toBe("clip.webp");
    expect(uploadName({ name: "notes.txt", type: "text/plain" })).toBe("notes.txt");

    expect(refuseUpload({ name: "empty.txt", size: 0 })).toContain("空文件");
    expect(refuseUpload({ name: "big.bin", size: 9 * 1024 * 1024 }, 8 * 1024 * 1024)).toContain("8 MB");
    expect(refuseUpload({ name: "ok.png", size: 1024 }, 8 * 1024 * 1024)).toBeNull();
    expect(uploadingText(["a.png"])).toBe("正在上传 a.png…");
    expect(uploadingText(["a.png", "b.png"])).toBe("正在上传 a.png 等 2 个文件…");
  });
});

describe("context menu, find bar & CJK font stack", () => {
  it("computes context menu items, find reducer/labels and font stack", () => {
    expect(wantsOwnMenu({ shiftKey: false, pointerType: "mouse" })).toBe(true);
    expect(wantsOwnMenu({ shiftKey: true, pointerType: "mouse" })).toBe(false);
    expect(wantsOwnMenu({ shiftKey: false, pointerType: "touch" })).toBe(false);

    const menu = terminalMenu({ selection: false, driving: true });
    expect(menu.find((e) => e.key === "copy")?.disabled).toBe(true);
    expect(menu.find((e) => e.key === "paste")?.disabled).toBe(false);

    let find = findReducer(FIND_CLOSED, { type: "open", query: "err" });
    expect(find).toEqual({ open: true, query: "err", caseSensitive: false });
    find = findReducer(find, { type: "toggleCase" });
    expect(find.caseSensitive).toBe(true);
    find = findReducer(find, { type: "close" });
    expect(find).toEqual({ open: false, query: "", caseSensitive: true });

    expect(findLabel("", null)).toBe("");
    expect(findLabel("err", { index: -1, count: 0 })).toBe("无结果");
    expect(findLabel("err", { index: 1, count: 4 })).toBe("2/4");
    expect(findLabel("err", { index: 0, count: FIND_LIMIT + 5 })).toBe(`1/${FIND_LIMIT}+`);

    expect(queryFromSelection("  hello  ")).toBe("hello");
    expect(queryFromSelection("line1\nline2")).toBeNull();

    expect(withFamily('"JetBrains Mono", Menlo, monospace', "NexTerm CJK"))
      .toBe('"NexTerm CJK", "JetBrains Mono", Menlo, monospace');
  });
});
