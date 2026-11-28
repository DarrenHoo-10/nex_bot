// Pure logic for the upgraded NexAgent web terminal: themes, preferences,
// tri-state modifier keys, VT key encoding, keyboard shortcuts, clipboard &
// file-drop path escaping, context menu items, and find-bar state.
// Zero DOM dependencies so every decision is directly unit-testable.
import { CLI_ATTACH_MAX_BYTES } from "../../../shared/cli-agents";

// ---------------------------------------------------------------------------
// Themes & appearance

export type TerminalThemeId = "ink" | "midnight" | "page" | "solarized";
export const TERMINAL_THEME_IDS: readonly TerminalThemeId[] = ["ink", "midnight", "page", "solarized"];

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalThemeMeta {
  id: TerminalThemeId;
  label: string;
  alwaysDark: boolean;
  light: TerminalPalette;
  dark: TerminalPalette;
}

const INK_PALETTE: TerminalPalette = {
  background: "#0c0c0e",
  foreground: "#dcdfe4",
  cursor: "#7aa2f7",
  cursorAccent: "#0c0c0e",
  selectionBackground: "#2f4668",
  selectionInactiveBackground: "#253143",
  black: "#2a2c33",
  red: "#f7768e",
  green: "#73daca",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c0c4ce",
  brightBlack: "#5a5f6e",
  brightRed: "#ff8fa3",
  brightGreen: "#9af0dc",
  brightYellow: "#f2c88a",
  brightBlue: "#9dbbff",
  brightMagenta: "#d0b6ff",
  brightCyan: "#a4e0ff",
  brightWhite: "#f4f5f7",
};

const MIDNIGHT_PALETTE: TerminalPalette = {
  background: "#12161a",
  foreground: "#d7dde3",
  cursor: "#4ea87e",
  cursorAccent: "#12161a",
  selectionBackground: "#335347",
  selectionInactiveBackground: "#253730",
  black: "#2b323a",
  red: "#f0646e",
  green: "#67c593",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#c8d0d8",
  brightBlack: "#5c6773",
  brightRed: "#ff7b85",
  brightGreen: "#8ae0b2",
  brightYellow: "#f2d28e",
  brightBlue: "#82c4ff",
  brightMagenta: "#da9aee",
  brightCyan: "#7fd3dd",
  brightWhite: "#f2f5f7",
};

const PAGE_LIGHT_PALETTE: TerminalPalette = {
  background: "#fbfcf9",
  foreground: "#1e3228",
  cursor: "#176643",
  cursorAccent: "#fbfcf9",
  selectionBackground: "#cde8d8",
  selectionInactiveBackground: "#dfeee5",
  black: "#20362b",
  red: "#cf222e",
  green: "#176643",
  yellow: "#9a6700",
  blue: "#0550ae",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#5e7266",
  brightBlack: "#52685a",
  brightRed: "#a40e26",
  brightGreen: "#1e7e53",
  brightYellow: "#7d4e00",
  brightBlue: "#0969da",
  brightMagenta: "#a475f9",
  brightCyan: "#2b8d94",
  brightWhite: "#83968a",
};

const PAGE_DARK_PALETTE: TerminalPalette = {
  background: "#171c19",
  foreground: "#e8eeea",
  cursor: "#38a36c",
  cursorAccent: "#171c19",
  selectionBackground: "#264334",
  selectionInactiveBackground: "#1f3228",
  black: "#353d38",
  red: "#f0646e",
  green: "#73cf9c",
  yellow: "#e5c07b",
  blue: "#6bb4f2",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#c4cec8",
  brightBlack: "#637069",
  brightRed: "#ff7b85",
  brightGreen: "#95e3b8",
  brightYellow: "#f2d28e",
  brightBlue: "#8cc8ff",
  brightMagenta: "#da9aee",
  brightCyan: "#7fd3dd",
  brightWhite: "#f3f7f5",
};

const SOLARIZED_LIGHT_PALETTE: TerminalPalette = {
  background: "#fdf6e3",
  foreground: "#586e75",
  cursor: "#268bd2",
  cursorAccent: "#fdf6e3",
  selectionBackground: "#eee8d5",
  selectionInactiveBackground: "#f2ecdb",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const SOLARIZED_DARK_PALETTE: TerminalPalette = {
  background: "#002b36",
  foreground: "#93a1a1",
  cursor: "#268bd2",
  cursorAccent: "#002b36",
  selectionBackground: "#073642",
  selectionInactiveBackground: "#06303b",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#657b83",
  brightYellow: "#839496",
  brightBlue: "#268bd2",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

export const TERMINAL_THEMES: Record<TerminalThemeId, TerminalThemeMeta> = {
  ink: { id: "ink", label: "墨黑", alwaysDark: true, light: INK_PALETTE, dark: INK_PALETTE },
  midnight: { id: "midnight", label: "午夜", alwaysDark: true, light: MIDNIGHT_PALETTE, dark: MIDNIGHT_PALETTE },
  page: { id: "page", label: "跟随界面", alwaysDark: false, light: PAGE_LIGHT_PALETTE, dark: PAGE_DARK_PALETTE },
  solarized: { id: "solarized", label: "Solarized", alwaysDark: false, light: SOLARIZED_LIGHT_PALETTE, dark: SOLARIZED_DARK_PALETTE },
};

export function parseTerminalTheme(raw: string | null): TerminalThemeId {
  return raw && raw in TERMINAL_THEMES ? (raw as TerminalThemeId) : "ink";
}

export function resolveTerminalPalette(id: TerminalThemeId, pageDark: boolean): { palette: TerminalPalette; dark: boolean } {
  const theme = TERMINAL_THEMES[id];
  const dark = theme.alwaysDark ? true : pageDark;
  return { palette: dark ? theme.dark : theme.light, dark };
}

export function findDecorationsFor(dark: boolean): {
  matchBorder: string;
  matchOverviewRuler: string;
  activeMatchBackground: string;
  activeMatchBorder: string;
  activeMatchColorOverviewRuler: string;
} {
  return dark
    ? {
        matchBorder: "#e0af68",
        matchOverviewRuler: "#e0af68",
        activeMatchBackground: "#264d3b",
        activeMatchBorder: "#56c98e",
        activeMatchColorOverviewRuler: "#56c98e",
      }
    : {
        matchBorder: "#d9822b",
        matchOverviewRuler: "#d9822b",
        activeMatchBackground: "#cde8d8",
        activeMatchBorder: "#176643",
        activeMatchColorOverviewRuler: "#176643",
      };
}

// ---------------------------------------------------------------------------
// Preferences

export type CursorStyle = "block" | "bar" | "underline";

export const CURSOR_STYLES: readonly { value: CursorStyle; label: string }[] = [
  { value: "block", label: "方块" },
  { value: "bar", label: "竖线" },
  { value: "underline", label: "下划线" },
];

export const FONT_SIZES = { min: 11, max: 22, default: 14 } as const;

export function parseCursorStyle(raw: string | null): CursorStyle {
  return raw === "block" || raw === "bar" || raw === "underline" ? raw : "block";
}

export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return FONT_SIZES.default;
  return Math.max(FONT_SIZES.min, Math.min(FONT_SIZES.max, Math.round(value)));
}

export interface TerminalPrefs {
  theme: TerminalThemeId;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  keyBar: boolean;
}

export const PREF_KEYS = {
  theme: "nexagent.terminal.theme",
  fontSize: "nexagent.terminal.fontSize",
  cursorStyle: "nexagent.terminal.cursorStyle",
  cursorBlink: "nexagent.terminal.cursorBlink",
  keyBar: "nexagent.terminal.keyBar",
  shortcuts: "nexagent.terminal.shortcuts",
} as const;

export function defaultKeyBarVisible(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia?.("(pointer: coarse)").matches ?? false;
  } catch {
    return false;
  }
}

export function readTerminalPrefs(): TerminalPrefs {
  try {
    const rawKeyBar = localStorage.getItem(PREF_KEYS.keyBar);
    const rawBlink = localStorage.getItem(PREF_KEYS.cursorBlink);
    const rawFont = localStorage.getItem(PREF_KEYS.fontSize);
    return {
      theme: parseTerminalTheme(localStorage.getItem(PREF_KEYS.theme)),
      fontSize: rawFont ? clampFontSize(Number(rawFont)) : FONT_SIZES.default,
      cursorStyle: parseCursorStyle(localStorage.getItem(PREF_KEYS.cursorStyle)),
      cursorBlink: rawBlink === null ? true : rawBlink === "1",
      keyBar: rawKeyBar === null ? defaultKeyBarVisible() : rawKeyBar === "1",
    };
  } catch {
    return {
      theme: "ink",
      fontSize: FONT_SIZES.default,
      cursorStyle: "block",
      cursorBlink: true,
      keyBar: defaultKeyBarVisible(),
    };
  }
}

export function saveTerminalPrefs(prefs: TerminalPrefs): void {
  try {
    localStorage.setItem(PREF_KEYS.theme, prefs.theme);
    localStorage.setItem(PREF_KEYS.fontSize, String(clampFontSize(prefs.fontSize)));
    localStorage.setItem(PREF_KEYS.cursorStyle, prefs.cursorStyle);
    localStorage.setItem(PREF_KEYS.cursorBlink, prefs.cursorBlink ? "1" : "0");
    localStorage.setItem(PREF_KEYS.keyBar, prefs.keyBar ? "1" : "0");
  } catch {
    // storage unavailable
  }
}

// ---------------------------------------------------------------------------
// Saved quick commands

export const DEFAULT_SHORTCUTS: readonly string[] = ["git status", "git diff --stat", "ls -la", "/compact", "/status"];

export function decodeShortcuts(json: string | null): string[] {
  if (json === null) return [...DEFAULT_SHORTCUTS];
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string")) return parsed;
  } catch {
    // fall through
  }
  return [...DEFAULT_SHORTCUTS];
}

export function moveShortcut(list: readonly string[], at: number, by: number): string[] {
  const to = at + by;
  if (at < 0 || at >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

// ---------------------------------------------------------------------------
// Tri-state modifier keys & VT key encoding

export type ModifierState = "off" | "once" | "held" | "locked";
export type ModifierKey = "ctrl" | "alt" | "shift";
export const MODIFIER_KEYS: readonly ModifierKey[] = ["ctrl", "alt", "shift"];

export interface Modifiers {
  ctrl: ModifierState;
  alt: ModifierState;
  shift: ModifierState;
  usedWhileHeld?: boolean;
}

export const NO_MODIFIERS: Modifiers = { ctrl: "off", alt: "off", shift: "off" };

export function modifiersActive(m: Modifiers): boolean {
  return MODIFIER_KEYS.some((k) => m[k] !== "off");
}

export function withModifiers(m: Modifiers, key: string): string {
  if (key === "esc") return key;
  return [...MODIFIER_KEYS.filter((k) => m[k] !== "off"), key].join("+");
}

export function modifiersPressed(m: Modifiers): Modifiers {
  const out: Modifiers = { ...m };
  for (const k of MODIFIER_KEYS) {
    if (out[k] === "once") out[k] = "off";
    if (out[k] === "held") out.usedWhileHeld = true;
  }
  return out;
}

export function modifierTapped(m: Modifiers, k: ModifierKey, quick: boolean): Modifiers {
  const next: ModifierState = m[k] === "off" ? "once" : m[k] === "once" ? (quick ? "locked" : "off") : "off";
  return { ...m, [k]: next };
}

export function modifierHeld(m: Modifiers, k: ModifierKey): Modifiers {
  return { ...m, [k]: "held", usedWhileHeld: false };
}

export function modifierReleased(m: Modifiers, k: ModifierKey): Modifiers {
  if (m[k] !== "held") return m;
  return { ...m, [k]: m.usedWhileHeld ? "off" : "once" };
}

export function typedWithModifiers(m: Modifiers, ch: string): { key?: string; text?: string } {
  const ctrlOrAlt = m.ctrl !== "off" || m.alt !== "off";
  if (!ctrlOrAlt) return { text: m.shift !== "off" ? ch.toUpperCase() : ch };
  if (!/^[\x20-\x7e\t]$/.test(ch)) return { text: ch };
  const name = ch === " " ? "space" : ch === "\t" ? "tab" : ch.toLowerCase();
  return { key: withModifiers(m, name) };
}

export function keyNameForBytes(data: string): string | null {
  const names: Record<string, string> = {
    "\r": "enter", "\x7f": "backspace", "\b": "backspace", "\t": "tab", "\x1b": "esc",
    "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
    "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
    "\x1b[H": "home", "\x1b[F": "end", "\x1bOH": "home", "\x1bOF": "end",
    "\x1b[2~": "insert", "\x1b[3~": "delete", "\x1b[5~": "pageup", "\x1b[6~": "pagedown",
  };
  return names[data] ?? null;
}

/** Encodes a key name ("enter", "ctrl+c", "shift+tab", "alt+left") to VT bytes.
 * `appCursor`: DECCKM application cursor mode (`ESC O A` vs `ESC [ A`). */
export function encodeKey(name: string, appCursor = false): string | null {
  let parts = name.toLowerCase().split("+");
  if (parts.length > 2 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
    parts = [...parts.slice(0, -2), "+"];
  }
  const base = parts.pop();
  if (!base) return null;
  const ctrl = parts.includes("ctrl") || parts.includes("control");
  const alt = parts.includes("alt") || parts.includes("meta") || parts.includes("option");
  const shift = parts.includes("shift");
  const esc = "\x1b";
  const csiFinal: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
  const tilde: Record<string, number> = {
    insert: 2, delete: 3, pageup: 5, pagedown: 6,
    f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
  };
  const ss3: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };
  const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  if (csiFinal[base]) return mod === 1 ? `${esc}${appCursor ? "O" : "["}${csiFinal[base]}` : `${esc}[1;${mod}${csiFinal[base]}`;
  if (tilde[base]) return mod === 1 ? `${esc}[${tilde[base]}~` : `${esc}[${tilde[base]};${mod}~`;
  if (ss3[base]) return mod === 1 ? `${esc}O${ss3[base]}` : `${esc}[1;${mod}${ss3[base]}`;
  const prefix = alt ? esc : "";
  switch (base) {
    case "enter":
    case "return":
      return shift || alt ? `${esc}\r` : "\r";
    case "tab":
      return shift ? `${esc}[Z` : `${prefix}\t`;
    case "esc":
    case "escape":
      return esc;
    case "backspace":
      return prefix + (ctrl ? "\x08" : "\x7f");
    case "space":
      return prefix + (ctrl ? "\x00" : " ");
  }
  if ([...base].length !== 1) return null;
  if (ctrl) {
    if (base >= "a" && base <= "z") return prefix + String.fromCharCode(base.charCodeAt(0) - 0x60);
    switch (base) {
      case "@":
      case "2":
        return `${prefix}\x00`;
      case "[":
      case "3":
        return esc;
      case "\\":
      case "4":
        return `${prefix}\x1c`;
      case "]":
      case "5":
        return `${prefix}\x1d`;
      case "^":
      case "6":
        return `${prefix}\x1e`;
      case "_":
      case "-":
      case "7":
      case "/":
        return `${prefix}\x1f`;
      case "?":
      case "8":
        return `${prefix}\x7f`;
      default:
        return prefix + base;
    }
  }
  return prefix + (shift ? base.toUpperCase() : base);
}

// ---------------------------------------------------------------------------
// Keyboard & line-editing decisions

export interface KeyEventLike {
  type: string;
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type KeyDecision = "xterm" | "copy" | "newline" | "swallow";

export function keyDecision(e: KeyEventLike, hasSelection: boolean): KeyDecision {
  if (e.isComposing || e.keyCode === 229) return "xterm";
  if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    return e.type === "keydown" ? "newline" : "swallow";
  }
  if (hasSelection && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "c") {
    return e.type === "keydown" ? "copy" : "swallow";
  }
  return "xterm";
}

/** Mac line-editing chords: ⌘⌫ -> ^U, ⌘← -> ^A, ⌘→ -> ^E. */
export function lineEditBytes(e: KeyEventLike): string | null {
  if (e.type !== "keydown" || e.isComposing || e.keyCode === 229) return null;
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  switch (e.key) {
    case "Backspace":
      return "\x15";
    case "ArrowLeft":
      return "\x01";
    case "ArrowRight":
      return "\x05";
    default:
      return null;
  }
}

/** Windows/Linux bare Ctrl+V (xterm would send ^V and cancel browser paste). */
export function isCtrlV(e: KeyEventLike, mac: boolean): boolean {
  if (mac || e.type !== "keydown" || e.isComposing || e.keyCode === 229) return false;
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "v";
}

/** Opens the find bar: ⌘F on Mac, Ctrl+Shift+F elsewhere, or Ctrl+F when observing. */
export function isFindShortcut(e: KeyEventLike, where: { mac: boolean; driving: boolean }): boolean {
  if (e.type !== "keydown" || e.altKey || e.key.toLowerCase() !== "f") return false;
  if (where.mac) return e.metaKey && !e.ctrlKey && !e.shiftKey;
  if (e.metaKey || !e.ctrlKey) return false;
  return e.shiftKey || !where.driving;
}

// ---------------------------------------------------------------------------
// Clipboard, OSC 52, links & file upload paths

export const OSC52_MAX_CHARS = 1 << 20;

export function osc52Text(text: string): string | null {
  return text.length > 0 && text.length <= OSC52_MAX_CHARS ? text : null;
}

export function webLink(uri: string): string | null {
  if (!/^https?:\/\//i.test(uri)) return null;
  try {
    const u = new URL(uri);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function lineCount(text: string): number {
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\");
}

/** Escapes a local device file path as one shell word (handles both POSIX and Windows paths). */
export function escapePastePath(path: string): string {
  if (isWindowsPath(path)) {
    if (!/[\s"'`$&|;<>()^%!]/.test(path)) return path;
    return `"${path.replace(/"/g, '\\"')}"`;
  }
  return path.replace(/[^\w@%+=:,./\-\u{80}-\u{10FFFF}]/gu, (m) => "\\" + m);
}

export function pastedPaths(paths: readonly string[]): string {
  return paths.map(escapePastePath).join(" ") + " ";
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
};

export function uploadName(file: Pick<File, "name" | "type">): string {
  const name = file.name.trim();
  const ext = MIME_EXT[file.type.toLowerCase()];
  if (!name) return `image${ext ?? ""}`;
  if (ext && !/\.[A-Za-z0-9]{1,8}$/.test(name)) return name + ext;
  return name;
}

export function refuseUpload(file: Pick<File, "name" | "size">, maxBytes: number = CLI_ATTACH_MAX_BYTES): string | null {
  const label = file.name || "文件";
  if (file.size <= 0) return `「${label}」为空文件，无法上传`;
  if (file.size > maxBytes) return `「${label}」超过 ${maxBytes >> 20} MB 上限`;
  return null;
}

export function uploadingText(names: readonly string[]): string {
  if (names.length <= 1) return `正在上传 ${names[0] ?? "文件"}…`;
  return `正在上传 ${names[0]} 等 ${names.length} 个文件…`;
}

export function transferFiles(data: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length) return files;
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

export function dragHasFiles(data: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return Boolean(data && Array.from(data.types ?? []).includes("Files"));
}

export type CopyOutcome = "wrote" | "legacy" | "failed";

export async function copyText(text: string): Promise<CopyOutcome> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return "wrote";
    } catch {
      // fall back to execCommand inside user gesture
    }
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok ? "legacy" : "failed";
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Context menu & find bar state

export type TerminalMenuKey = "copy" | "paste" | "selectAll" | "search" | "clearSelection";

export interface TerminalMenuEntry {
  key: TerminalMenuKey;
  label: string;
  disabled: boolean;
  divider?: boolean;
}

export function wantsOwnMenu(e: { shiftKey: boolean; pointerType?: string }): boolean {
  return !e.shiftKey && e.pointerType !== "touch";
}

export function terminalMenu(state: { selection: boolean; driving: boolean }): TerminalMenuEntry[] {
  return [
    { key: "copy", label: "复制", disabled: !state.selection },
    { key: "paste", label: "粘贴", disabled: !state.driving },
    { key: "selectAll", label: "全选", disabled: false, divider: true },
    { key: "search", label: "查找…", disabled: false },
    { key: "clearSelection", label: "清除选区", disabled: !state.selection },
  ];
}

export const FIND_LIMIT = 999;

export interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
}

export type FindAction =
  | { type: "open"; query?: string }
  | { type: "close" }
  | { type: "query"; query: string }
  | { type: "toggleCase" };

export const FIND_CLOSED: FindState = { open: false, query: "", caseSensitive: false };

export function findReducer(state: FindState, action: FindAction): FindState {
  switch (action.type) {
    case "open":
      return { ...state, open: true, query: action.query ?? state.query };
    case "close":
      return state.open || state.query ? { ...state, open: false, query: "" } : state;
    case "query":
      return action.query === state.query ? state : { ...state, query: action.query };
    case "toggleCase":
      return { ...state, caseSensitive: !state.caseSensitive };
  }
}

export function findLabel(query: string, found: { index: number; count: number } | null): string {
  if (!query) return "";
  if (!found || found.count <= 0) return "无结果";
  const count = found.count > FIND_LIMIT ? `${FIND_LIMIT}+` : String(found.count);
  return found.index < 0 ? count : `${found.index + 1}/${count}`;
}

export function queryFromSelection(selection: string): string | null {
  const trimmed = selection.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  return trimmed.slice(0, 200);
}

/** Inserts a range-limited CJK font family at the front of a monospace font stack. */
export function withFamily(stack: string, family: string): string {
  const parts = stack.split(",").map((s) => s.trim()).filter(Boolean);
  const generic = parts.length && /^monospace$/i.test(parts[parts.length - 1]) ? parts.pop()! : "monospace";
  return [`"${family}"`, ...parts.filter((p) => p !== `"${family}"`), generic].join(", ");
}
