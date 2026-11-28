// The right-hand terminal tab attaches a stream and provides Persona-inspired
// terminal ergonomics: control/observe toggle, floating status banners, find bar,
// tri-state KeyBar + saved quick commands, theme/font/cursor settings, OSC 52
// write-only clipboard, clickable web links, and drag/paste file path upload.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Keyboard, RefreshCw, Search, Settings2 } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import { CLI_ERROR_TEXT, TERM_DEFAULT, TERM_HISTORY, clampTermSize, type CliSessionKey } from "../../../shared/cli-agents";
import { desktop } from "../api";
import { attachTerminalFile, cliErrorText } from "./api";
import type { CliStream } from "./stream";
import { BASE_TERMINAL_FONT_STACK, cjkFontStack, terminalFontReady } from "./terminal-cjk";
import {
  copyText,
  dragHasFiles,
  encodeKey,
  FIND_CLOSED,
  findDecorationsFor,
  findReducer,
  isCtrlV,
  isFindShortcut,
  keyDecision,
  keyNameForBytes,
  lineCount,
  lineEditBytes,
  modifierHeld,
  modifierReleased,
  modifiersActive,
  modifiersPressed,
  modifierTapped,
  NO_MODIFIERS,
  osc52Text,
  pastedPaths,
  queryFromSelection,
  readTerminalPrefs,
  refuseUpload,
  resolveTerminalPalette,
  saveTerminalPrefs,
  transferFiles,
  typedWithModifiers,
  uploadingText,
  uploadName,
  wantsOwnMenu,
  webLink,
  withModifiers,
  type Modifiers,
  type TerminalMenuKey,
  type TerminalPrefs,
} from "./terminal-logic";
import {
  closeReasonText,
  createCreditMeter,
  fitScale,
  initialTermState,
  TERM_STATUS_TEXT,
  termReducer,
  termStatus,
  type TermMode,
} from "./terminal-session";
import { ShortcutsEditor, TerminalKeyBar } from "./TerminalKeyBar";
import { PasteConfirmDialog, TerminalContextMenu, TerminalFindBar, TerminalOptionsPopover } from "./TerminalOverlays";
import "./cli-terminal.css";

const RESIZE_DEBOUNCE_MS = 100;
const TOAST_MS = 2600;

async function loadXterm() {
  const [xterm, fit, graphemes, search, links, clipboard] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-unicode-graphemes"),
    import("@xterm/addon-search"),
    import("@xterm/addon-web-links"),
    import("@xterm/addon-clipboard"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  return {
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon,
    UnicodeGraphemesAddon: graphemes.UnicodeGraphemesAddon,
    SearchAddon: search.SearchAddon,
    WebLinksAddon: links.WebLinksAddon,
    ClipboardAddon: clipboard.ClipboardAddon,
  };
}

let requestCounter = 0;
const newRequestId = () => `${Math.random().toString(36).slice(2, 8)}-${(++requestCounter).toString(36)}`;

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
}

export interface TerminalViewProps {
  stream: CliStream;
  sessionKey: CliSessionKey;
  /** the stream's socket is open */
  connected: boolean;
  /** page dark mode, used by themes that follow the page appearance */
  dark?: boolean;
  /** keeps the stream alive while another side tab is in front */
  hidden?: boolean;
}

export function TerminalView({ stream, sessionKey, connected, dark = false, hidden = false }: TerminalViewProps) {
  const [state, dispatch] = useReducer(termReducer, "control" as TermMode, initialTermState);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [prefs, setPrefs] = useState<TerminalPrefs>(readTerminalPrefs);
  const [mods, setMods] = useState<Modifiers>(NO_MODIFIERS);
  const [hasSelection, setHasSelection] = useState(false);
  const [find, dispatchFind] = useReducer(findReducer, FIND_CLOSED);
  const [findResult, setFindResult] = useState<{ index: number; count: number } | null>(null);
  const [optionsAnchor, setOptionsAnchor] = useState<HTMLElement | null>(null);
  const [editingShortcuts, setEditingShortcuts] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selection: boolean } | null>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [controlDeclined, setControlDeclined] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const requestedObserveRef = useRef(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sidRef = useRef<number | null>(null);
  const reqRef = useRef<string | null>(null);
  const modeRef = useRef<TermMode | null>(null);
  const meterRef = useRef<ReturnType<typeof createCreditMeter> | null>(null);
  const streamRef = useRef(stream);
  streamRef.current = stream;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const modsRef = useRef(mods);
  modsRef.current = mods;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = pendingPaste !== null || editingShortcuts;
  const dragDepthRef = useRef(0);
  const uploadsRef = useRef<string[]>([]);
  const disposedRef = useRef(false);
  const toastTimerRef = useRef<number>(0);
  const encoderRef = useRef(new TextEncoder());

  const { palette, dark: termDark } = resolveTerminalPalette(prefs.theme, dark);
  const termDarkRef = useRef(termDark);
  termDarkRef.current = termDark;

  const showToast = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    window.clearTimeout(toastTimerRef.current);
    setToast({ text, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!hidden) return;
    setOptionsAnchor(null);
    setContextMenu(null);
    setPendingPaste(null);
  }, [hidden]);

  const updatePrefs = useCallback((patch: Partial<TerminalPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      saveTerminalPrefs(next);
      return next;
    });
  }, []);

  const sendRaw = useCallback((text: string) => {
    const sid = sidRef.current;
    if (sid !== null && modeRef.current === "control" && text.length > 0) {
      streamRef.current.sendInput(sid, encoderRef.current.encode(text));
    }
  }, []);

  const release = useCallback(() => {
    const sid = sidRef.current;
    const req = reqRef.current;
    if (sid !== null) streamRef.current.closeTerm(sid);
    else if (req) streamRef.current.abandonReq(req);
    sidRef.current = null;
    reqRef.current = null;
    modeRef.current = null;
    meterRef.current = null;
  }, []);

  const appCursorActive = useCallback(() => {
    return Boolean((termRef.current?.modes as { applicationCursorKeysMode?: boolean } | undefined)?.applicationCursorKeysMode);
  }, []);

  const copySelection = useCallback(async () => {
    const term = termRef.current;
    const selected = term?.getSelection() ?? "";
    if (!selected) return;
    const outcome = await copyText(selected);
    if (outcome === "failed") {
      showToast("无法写入剪贴板", "error");
    } else {
      term?.clearSelection();
      showToast("已复制到剪贴板");
    }
  }, [showToast]);

  const pasteIntoTerminal = useCallback((text: string, confirmMultiline: boolean) => {
    if (!text) return;
    if (modeRef.current !== "control") {
      showToast("请先切换到控制模式", "error");
      return;
    }
    if (confirmMultiline && lineCount(text) > 1) {
      (document.activeElement as HTMLElement | null)?.blur();
      setPendingPaste(text);
      return;
    }
    const term = termRef.current;
    if (term?.paste) term.paste(text);
    else sendRaw(text);
    term?.focus();
  }, [sendRaw, showToast]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    if (modeRef.current !== "control") {
      showToast("请先切换到控制模式再粘贴文件", "error");
      return;
    }
    const accepted = files.filter((file) => {
      const reason = refuseUpload(file);
      if (reason) showToast(reason, "error");
      return !reason;
    });
    if (!accepted.length) return;

    const targetKey = sessionKeyRef.current;
    const names = accepted.map(uploadName);
    uploadsRef.current.push(...names);
    setUploading(uploadingText(uploadsRef.current));

    const results = await Promise.allSettled(
      accepted.map((file, index) => {
        const named = file.name === names[index] ? file : new File([file], names[index], { type: file.type });
        return attachTerminalFile(targetKey, named);
      }),
    );

    for (const name of names) {
      const idx = uploadsRef.current.indexOf(name);
      if (idx >= 0) uploadsRef.current.splice(idx, 1);
    }
    setUploading(uploadsRef.current.length ? uploadingText(uploadsRef.current) : null);

    const paths: string[] = [];
    results.forEach((entry, index) => {
      if (entry.status === "fulfilled") paths.push(entry.value.path);
      else if (!disposedRef.current) showToast(`${names[index]} 上传失败：${cliErrorText(entry.reason)}`, "error");
    });

    if (!paths.length) return;
    if (disposedRef.current || sessionKeyRef.current !== targetKey) {
      showToast("终端已切换，文件未填入", "error");
      return;
    }
    if (modeRef.current !== "control") {
      showToast("终端控制已结束，文件未填入", "error");
      return;
    }
    const text = pastedPaths(paths);
    const term = termRef.current;
    if (term?.paste) term.paste(text);
    else sendRaw(text);
    term?.focus();
  }, [sendRaw, showToast]);

  const uploadFilesRef = useRef(uploadFiles);
  uploadFilesRef.current = uploadFiles;

  // Windows Electron client intercepts screenshot Ctrl+V via main-process IPC.
  useEffect(() => {
    const bridge = (window as unknown as { nex?: typeof desktop }).nex ?? desktop;
    return bridge?.onClipboardImage?.((image) => {
      if (hiddenRef.current || modalOpenRef.current) return;
      if (!rootRef.current?.contains(document.activeElement)) return;
      const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array();
      if (!bytes.byteLength || !image.type.startsWith("image/")) return;
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      const file = new File([buf], image.name.trim() || "截图.png", { type: image.type });
      void uploadFilesRef.current([file]);
    });
  }, []);

  const readClipboardImages = useCallback(async (): Promise<File[]> => {
    if (!navigator.clipboard?.read) return [];
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        files.push(new File([blob], uploadName({ name: "", type: imageType }), { type: imageType }));
      }
      return files;
    } catch {
      return [];
    }
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    if (modeRef.current !== "control") {
      showToast("请先切换到控制模式", "error");
      return;
    }
    const images = await readClipboardImages();
    if (images.length) {
      await uploadFilesRef.current(images);
      return;
    }
    if (!navigator.clipboard?.readText) {
      showToast("当前浏览器不支持直接读取剪贴板，请使用快捷键粘贴", "error");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) pasteIntoTerminal(text, true);
    } catch {
      showToast("无法读取剪贴板，请使用快捷键粘贴", "error");
    }
  }, [pasteIntoTerminal, readClipboardImages, showToast]);

  const applyObserveScale = useCallback(() => {
    const host = hostRef.current;
    const scaleEl = scaleRef.current;
    if (!host || !scaleEl) return;
    if (modeRef.current !== "observe") {
      scaleEl.style.transform = "";
      return;
    }
    const screen = scaleEl.querySelector<HTMLElement>(".xterm-screen");
    const natural = screen?.offsetWidth ?? 0;
    const available = Math.max(0, host.clientWidth - 16);
    const ratio = fitScale(available, natural);
    scaleEl.style.transform = ratio < 0.999 ? `scale(${ratio})` : "";
  }, []);

  // Create xterm once the lazy chunk and fonts are ready
  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;

    Promise.all([loadXterm(), cjkFontStack(BASE_TERMINAL_FONT_STACK)])
      .then(async ([modsLoaded, cjkStack]) => {
        const fontFamily = cjkStack ?? BASE_TERMINAL_FONT_STACK;
        await terminalFontReady(prefsRef.current.fontSize, fontFamily);
        const target = scaleRef.current;
        if (disposed || !target) return;

        const initial = resolveTerminalPalette(prefsRef.current.theme, darkRef.current);
        term = new modsLoaded.Terminal({
          allowProposedApi: true,
          cursorBlink: prefsRef.current.cursorBlink,
          cursorStyle: prefsRef.current.cursorStyle,
          disableStdin: true,
          fontFamily,
          fontSize: prefsRef.current.fontSize,
          lineHeight: 1.15,
          rightClickSelectsWord: false,
          scrollback: TERM_HISTORY,
          theme: initial.palette,
        });

        const fit = new modsLoaded.FitAddon();
        const search = new modsLoaded.SearchAddon();
        const clipboard = new modsLoaded.ClipboardAddon(undefined, {
          readText: async () => "",
          writeText: async (_selection, text) => {
            const safe = osc52Text(text);
            if (!safe) return;
            const outcome = await copyText(safe);
            if (outcome !== "failed") showToast("已复制到剪贴板");
          },
        });
        const links = new modsLoaded.WebLinksAddon((event, uri) => {
          const safe = webLink(uri);
          if (!safe) return;
          if (modeRef.current === "control" && !event.metaKey && !event.ctrlKey) return;
          const bridge = (window as unknown as { nex?: typeof desktop }).nex ?? desktop;
          if (bridge?.openExternal) void bridge.openExternal(safe);
          else window.open(safe, "_blank", "noopener,noreferrer");
        });

        term.loadAddon(fit);
        term.loadAddon(new modsLoaded.UnicodeGraphemesAddon());
        term.loadAddon(search);
        term.loadAddon(links);
        term.loadAddon(clipboard);
        term.open(target);

        const mac = isMacPlatform();
        term.attachCustomKeyEventHandler?.((event) => {
          if (modalOpenRef.current) return false;
          const selection = term?.hasSelection?.() ?? false;
          const decision = keyDecision(event, selection);
          if (decision === "copy") {
            event.preventDefault();
            event.stopPropagation();
            void copySelection();
            return false;
          }
          if (decision === "newline") {
            event.preventDefault();
            event.stopPropagation();
            sendRaw("\x1b\r");
            return false;
          }
          if (decision === "swallow") {
            event.preventDefault();
            event.stopPropagation();
            return false;
          }

          if (modeRef.current === "control") {
            const macBytes = lineEditBytes(event);
            if (macBytes) {
              event.preventDefault();
              event.stopPropagation();
              sendRaw(macBytes);
              return false;
            }
            if (isCtrlV(event, mac)) {
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat) {
                void readClipboardImages().then((files) => {
                  if (files.length) void uploadFilesRef.current(files);
                  else sendRaw("\x16");
                });
              }
              return false;
            }
          }
          return true;
        });

        term.onSelectionChange?.(() => {
          setHasSelection(term?.hasSelection?.() ?? false);
        });

        search.onDidChangeResults?.((res) => {
          setFindResult(res ? { index: res.resultIndex, count: res.resultCount } : null);
        });

        term.onData((data) => {
          const sid = sidRef.current;
          if (sid === null || modeRef.current !== "control" || modalOpenRef.current) return;
          const activeMods = modsRef.current;
          if (modifiersActive(activeMods)) {
            const keyName = keyNameForBytes(data);
            if (keyName) {
              const bytes = encodeKey(withModifiers(activeMods, keyName), appCursorActive());
              setMods((current) => modifiersPressed(current));
              if (bytes) {
                streamRef.current.sendInput(sid, encoderRef.current.encode(bytes));
                return;
              }
            } else if ([...data].length === 1) {
              const mapped = typedWithModifiers(activeMods, data);
              setMods((current) => modifiersPressed(current));
              const out = mapped.key ? encodeKey(mapped.key, appCursorActive()) : mapped.text;
              if (out) {
                streamRef.current.sendInput(sid, encoderRef.current.encode(out));
                return;
              }
            }
          }
          streamRef.current.sendInput(sid, encoderRef.current.encode(data));
        });

        term.onBinary((data) => {
          const sid = sidRef.current;
          if (sid !== null && modeRef.current === "control") {
            streamRef.current.sendInput(sid, Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff));
          }
        });

        termRef.current = term;
        fitRef.current = fit;
        searchRef.current = search;
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setLoadFailed(true);
      });

    return () => {
      disposed = true;
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      setReady(false);
      term?.dispose();
    };
  }, [appCursorActive, copySelection, readClipboardImages, sendRaw, showToast]);

  // Apply appearance, font size and cursor options dynamically without recreating xterm
  useEffect(() => {
    const term = termRef.current;
    if (!term || !ready) return;
    const prevSize = term.options.fontSize;
    term.options.theme = palette;
    term.options.fontSize = prefs.fontSize;
    term.options.cursorStyle = prefs.cursorStyle;
    term.options.cursorBlink = prefs.cursorBlink;
    if (prevSize !== prefs.fontSize) {
      if (modeRef.current === "control" && !hiddenRef.current) {
        try {
          fitRef.current?.fit();
          const sid = sidRef.current;
          if (sid !== null) {
            const size = clampTermSize(term.cols, term.rows);
            streamRef.current.resizeTerm(sid, size.cols, size.rows);
          }
        } catch {
          // ignore fit failure when container is collapsed
        }
      } else {
        applyObserveScale();
      }
    }
  }, [ready, palette, prefs.fontSize, prefs.cursorStyle, prefs.cursorBlink, applyObserveScale]);

  // One terminal stream per session: reset on session change, release on unmount
  useEffect(() => {
    setControlDeclined(false);
    dispatch({ type: "start", want: "control" });
    setMods(NO_MODIFIERS);
    dispatchFind({ type: "close" });
    return release;
  }, [sessionKey, stream, release]);

  // Stream events from Core
  useEffect(() => stream.on((event) => {
    if (event.type === "status") {
      if (event.status !== "open") {
        sidRef.current = null;
        reqRef.current = null;
        modeRef.current = null;
        meterRef.current = null;
        setControlDeclined(false);
        dispatch({ type: "disconnected" });
      }
      return;
    }
    if (event.type === "output") {
      if (event.sid !== sidRef.current) return;
      const meter = meterRef.current;
      const bytes = event.data.length;
      termRef.current?.write(event.data, () => meter?.wrote(bytes));
      return;
    }
    const message = event.message;
    switch (message.type) {
      case "term.opened": {
        if (message.req !== reqRef.current) return;
        const term = termRef.current;
        const sid = message.sid;
        reqRef.current = null;
        sidRef.current = sid;
        modeRef.current = message.observe ? "observe" : "control";
        setControlDeclined(message.observe && !requestedObserveRef.current);
        meterRef.current = createCreditMeter((bytes) => { stream.credit(sid, bytes); });
        if (term) {
          term.options.disableStdin = message.observe;
          term.reset();
          term.resize(message.cols, message.rows);
        }
        requestAnimationFrame(applyObserveScale);
        dispatch({ type: "opened", req: message.req, sid, cols: message.cols, rows: message.rows, observe: message.observe });
        return;
      }
      case "term.size":
        if (message.sid !== sidRef.current) return;
        if (termRef.current && (termRef.current.cols !== message.cols || termRef.current.rows !== message.rows)) {
          termRef.current.resize(message.cols, message.rows);
          requestAnimationFrame(applyObserveScale);
        }
        dispatch({ type: "size", sid: message.sid, cols: message.cols, rows: message.rows });
        return;
      case "term.closed":
        if (message.sid !== sidRef.current) return;
        sidRef.current = null;
        modeRef.current = null;
        meterRef.current = null;
        setControlDeclined(false);
        dispatch({ type: "closed", sid: message.sid, reason: message.reason });
        return;
      case "error":
        if (message.req === undefined || message.req !== reqRef.current) return;
        reqRef.current = null;
        setControlDeclined(false);
        dispatch({ type: "error", code: message.code, req: message.req });
        return;
    }
  }), [stream, applyObserveScale]);

  // Open stream when state machine asks and the terminal tab is actually visible
  useEffect(() => {
    if (!state.needsOpen || !connected || !ready || hidden) return;
    const observe = state.want === "observe";
    let proposed: { cols: number; rows: number } | undefined;
    if (!observe) {
      try { proposed = fitRef.current?.proposeDimensions(); } catch { proposed = undefined; }
    }
    const size = clampTermSize(proposed?.cols || TERM_DEFAULT.cols, proposed?.rows || TERM_DEFAULT.rows);
    const req = newRequestId();
    requestedObserveRef.current = observe;
    if (!stream.openTerm(req, sessionKey, size.cols, size.rows, observe)) return;
    reqRef.current = req;
    dispatch({ type: "requested", req });
  }, [state.needsOpen, state.want, connected, ready, hidden, stream, sessionKey]);

  // Focus & fit when becoming visible or entering control mode
  useEffect(() => {
    if (hidden || !ready) return;
    const term = termRef.current;
    if (!term) return;
    if (state.mode === "control") {
      try {
        const before = { cols: term.cols, rows: term.rows };
        fitRef.current?.fit();
        const sid = sidRef.current;
        if (sid !== null && (term.cols !== before.cols || term.rows !== before.rows)) {
          const size = clampTermSize(term.cols, term.rows);
          streamRef.current.resizeTerm(sid, size.cols, size.rows);
        }
      } catch {
        // ignore
      }
      term.focus();
    } else if (state.mode === "observe") {
      applyObserveScale();
    }
  }, [hidden, ready, state.mode, applyObserveScale]);

  // Keep pane & PTY synchronized on resize
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (hiddenRef.current) return;
      if (modeRef.current === "observe") {
        applyObserveScale();
        return;
      }
      if (modeRef.current !== "control") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const term = termRef.current;
        const sid = sidRef.current;
        if (!term || sid === null || hiddenRef.current || host.clientWidth === 0 || host.clientHeight === 0) return;
        const before = { cols: term.cols, rows: term.rows };
        try { fitRef.current?.fit(); } catch { return; }
        if (term.cols === before.cols && term.rows === before.rows) return;
        const size = clampTermSize(term.cols, term.rows);
        streamRef.current.resizeTerm(sid, size.cols, size.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ready, state.mode, applyObserveScale]);

  // Search sync with @xterm/addon-search
  const runSearch = useCallback((query: string, caseSensitive: boolean, dir: 0 | 1 | -1) => {
    const search = searchRef.current;
    if (!search) return;
    if (!query) {
      search.clearDecorations?.();
      setFindResult(null);
      return;
    }
    const opts = { caseSensitive, decorations: findDecorationsFor(termDarkRef.current) };
    if (dir === 0) {
      // Work around addon-search caching options before comparing (Persona terminal.md §20)
      search.clearDecorations?.();
      search.findPrevious(query, { ...opts, incremental: true });
    } else if (dir === 1) {
      search.findNext(query, opts);
    } else {
      search.findPrevious(query, opts);
    }
  }, []);

  useEffect(() => {
    if (!find.open) {
      searchRef.current?.clearDecorations?.();
      setFindResult(null);
      return;
    }
    runSearch(find.query, find.caseSensitive, 0);
  }, [find.open, find.query, find.caseSensitive, runSearch, termDark]);

  // Capture paste & drag/drop for images and files on the viewport
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = transferFiles(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        e.stopPropagation();
        void uploadFilesRef.current(files);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text && lineCount(text) > 1 && modeRef.current === "control") {
        e.preventDefault();
        e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur();
        setPendingPaste(text);
      }
    };
    const onDragEnter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      dragDepthRef.current += 1;
      if (modeRef.current === "control") setDropping(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDropping(false);
    };
    const onDrop = (e: DragEvent) => {
      const files = transferFiles(e.dataTransfer);
      dragDepthRef.current = 0;
      setDropping(false);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      void uploadFilesRef.current(files);
    };
    host.addEventListener("paste", onPaste, true);
    host.addEventListener("dragenter", onDragEnter);
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("dragleave", onDragLeave);
    host.addEventListener("drop", onDrop);
    return () => {
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("dragenter", onDragEnter);
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("dragleave", onDragLeave);
      host.removeEventListener("drop", onDrop);
    };
  }, []);

  const switchMode = useCallback((want: TermMode) => {
    if (want === state.want && state.sid !== null) return;
    setControlDeclined(false);
    release();
    dispatch({ type: "mode", want });
  }, [state.want, state.sid, release]);

  const reconnect = useCallback((want?: TermMode) => {
    setControlDeclined(false);
    release();
    dispatch({ type: "start", want: want ?? state.want });
  }, [release, state.want]);

  const openFind = useCallback(() => {
    const selected = termRef.current?.getSelection() ?? "";
    dispatchFind({ type: "open", query: queryFromSelection(selected) ?? undefined });
  }, []);

  const closeFind = useCallback(() => {
    dispatchFind({ type: "close" });
    searchRef.current?.clearDecorations?.();
    setFindResult(null);
    if (modeRef.current === "control") termRef.current?.focus();
  }, []);

  const pressKey = useCallback((name: string) => {
    const combined = withModifiers(modsRef.current, name);
    const bytes = encodeKey(combined, appCursorActive());
    setMods((current) => modifiersPressed(current));
    if (bytes) sendRaw(bytes);
    termRef.current?.focus();
  }, [appCursorActive, sendRaw]);

  const pressBare = useCallback((name: string) => {
    const bytes = encodeKey(name, appCursorActive());
    if (bytes) sendRaw(bytes);
    termRef.current?.focus();
  }, [appCursorActive, sendRaw]);

  const typeQuickCommand = useCallback((text: string, run: boolean) => {
    sendRaw(run ? text + "\r" : text);
    termRef.current?.focus();
  }, [sendRaw]);

  const handleContextAction = useCallback((key: TerminalMenuKey) => {
    switch (key) {
      case "copy":
        void copySelection();
        break;
      case "paste":
        void pasteFromClipboard();
        break;
      case "selectAll":
        termRef.current?.selectAll();
        break;
      case "search":
        openFind();
        break;
      case "clearSelection":
        termRef.current?.clearSelection();
        break;
    }
  }, [copySelection, openFind, pasteFromClipboard]);

  const status = termStatus(state, connected);
  const driving = status === "controlling";
  const stale = status === "reconnecting" || status === "closed";
  const closedText = state.error ? CLI_ERROR_TEXT[state.error] : closeReasonText(state.reason);
  const dimsText = state.cols > 0 && state.rows > 0 ? `${state.cols}×${state.rows}` : "";
  const termVars = {
    "--term-bg": palette.background,
    "--term-fg": palette.foreground,
    "--term-surface": termDark ? "#1e2329" : "#ffffff",
  } as React.CSSProperties;

  return (
    <div
      ref={rootRef}
      className="cli-term"
      data-status={status}
      data-hidden={hidden ? "1" : undefined}
      style={termVars}
      tabIndex={-1}
      onKeyDownCapture={(e) => {
        if (!isFindShortcut(e.nativeEvent, { mac: isMacPlatform(), driving })) return;
        e.preventDefault();
        e.stopPropagation();
        openFind();
      }}
    >
      <div className="cli-term-bar">
        <div className="cli-term-mode" role="radiogroup" aria-label="终端模式">
          <button
            type="button"
            role="radio"
            aria-checked={state.want === "control"}
            title={dimsText ? `控制模式（可输入 · ${dimsText}）` : "控制模式（可输入）"}
            onClick={() => switchMode("control")}
          >
            控制
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={state.want === "observe"}
            title={dimsText ? `只看模式（同步电脑尺寸 · ${dimsText}）` : "只看模式（同步电脑尺寸）"}
            onClick={() => switchMode("observe")}
          >
            只看
          </button>
        </div>

        <span className="cli-term-meta" role="status">
          <span className="cli-term-dot" data-status={status} aria-hidden="true" />
          <span>{TERM_STATUS_TEXT[status]}</span>
          {dimsText ? <span className="cli-term-dims">{dimsText}</span> : null}
        </span>

        <div className="cli-term-actions">
          <button
            type="button"
            className="cli-term-icon-btn"
            data-active={find.open ? "1" : undefined}
            aria-label="查找"
            title={isMacPlatform() ? "查找 (⌘F)" : "查找 (Ctrl+Shift+F)"}
            onClick={() => (find.open ? closeFind() : openFind())}
          >
            <Search size={14} />
          </button>
          <button
            type="button"
            className="cli-term-icon-btn"
            data-active={prefs.keyBar ? "1" : undefined}
            aria-label="快捷键栏"
            aria-pressed={prefs.keyBar}
            title={prefs.keyBar ? "隐藏快捷键栏" : "显示快捷键栏"}
            onClick={() => updatePrefs({ keyBar: !prefs.keyBar })}
          >
            <Keyboard size={14} />
          </button>
          <button
            type="button"
            className="cli-term-icon-btn"
            data-active={optionsAnchor ? "1" : undefined}
            aria-label="终端设置"
            aria-expanded={Boolean(optionsAnchor)}
            title="终端设置"
            onClick={(e) => {
              const target = e.currentTarget;
              setOptionsAnchor((prev) => (prev ? null : target));
            }}
          >
            <Settings2 size={14} />
          </button>
          <button
            type="button"
            className="cli-term-icon-btn"
            aria-label="重新连接"
            title="重新连接"
            onClick={() => reconnect()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div
        className="cli-term-host"
        ref={hostRef}
        data-mode={state.mode ?? "none"}
        data-stale={stale ? "1" : undefined}
        data-dropping={dropping ? "1" : undefined}
        onContextMenu={(e) => {
          const pointerType = (e.nativeEvent as PointerEvent).pointerType;
          if (!wantsOwnMenu({ shiftKey: e.shiftKey, pointerType })) return;
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
          setContextMenu({ x: e.clientX, y: e.clientY, selection: termRef.current?.hasSelection?.() ?? false });
        }}
      >
        <div className="cli-term-scale" ref={scaleRef} />

        {loadFailed ? <div className="cli-term-overlay" role="alert">终端组件加载失败</div> : null}

        {!loadFailed ? (
          <div className="cli-term-banners">
            {status === "reconnecting" ? (
              <div className="cli-term-banner" data-tone="warn" role="status">
                <span>正在重新连接…</span>
                <button type="button" onClick={() => reconnect()}>立即重试</button>
              </div>
            ) : null}
            {status === "closed" ? (
              <div className="cli-term-banner" data-tone="error" role="status">
                <span>{closedText || TERM_STATUS_TEXT.closed}</span>
                <button type="button" onClick={() => reconnect()}>重新连接</button>
              </div>
            ) : null}
            {status === "observing" && controlDeclined ? (
              <div className="cli-term-banner" data-tone="warn" role="status">
                <span>暂未取得终端控制权</span>
                <button type="button" onClick={() => reconnect("control")}>重新接管</button>
              </div>
            ) : null}
            {uploading ? (
              <div className="cli-term-banner" role="status">
                <span>{uploading}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {find.open ? (
          <TerminalFindBar
            state={find}
            result={findResult}
            onQuery={(query) => dispatchFind({ type: "query", query })}
            onToggleCase={() => dispatchFind({ type: "toggleCase" })}
            onStep={(dir) => runSearch(find.query, find.caseSensitive, dir)}
            onClose={closeFind}
          />
        ) : null}

        {toast ? (
          <div className="cli-term-toast" data-tone={toast.tone} role="status">
            {toast.text}
          </div>
        ) : null}
      </div>

      {prefs.keyBar ? (
        <TerminalKeyBar
          disabled={!driving}
          mods={mods}
          hasSelection={hasSelection}
          onPressKey={pressKey}
          onPressBare={pressBare}
          onTapModifier={(k, quick) => setMods((current) => modifierTapped(current, k, quick))}
          onHoldModifier={(k) => setMods((current) => modifierHeld(current, k))}
          onReleaseModifier={(k) => setMods((current) => modifierReleased(current, k))}
          onTypeText={typeQuickCommand}
          onCopy={() => void copySelection()}
          onPaste={() => void pasteFromClipboard()}
          onPickFiles={() => fileInputRef.current?.click()}
          onEditShortcuts={() => setEditingShortcuts(true)}
        />
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        aria-label="上传文件到终端"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length) void uploadFiles(picked);
        }}
      />

      {optionsAnchor ? (
        <TerminalOptionsPopover
          anchor={optionsAnchor}
          prefs={prefs}
          pageDark={dark}
          onChange={updatePrefs}
          onEditShortcuts={() => setEditingShortcuts(true)}
          onClose={() => setOptionsAnchor(null)}
        />
      ) : null}

      {contextMenu ? (
        <TerminalContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selection={contextMenu.selection}
          driving={driving}
          onSelect={handleContextAction}
          onClose={() => {
            setContextMenu(null);
            if (modeRef.current === "control") setTimeout(() => termRef.current?.focus(), 0);
          }}
        />
      ) : null}

      <ShortcutsEditor
        open={editingShortcuts}
        onClose={() => {
          setEditingShortcuts(false);
          if (modeRef.current === "control") termRef.current?.focus();
        }}
      />

      <PasteConfirmDialog
        text={pendingPaste}
        onCancel={() => {
          setPendingPaste(null);
          if (modeRef.current === "control") termRef.current?.focus();
        }}
        onConfirm={() => {
          const text = pendingPaste;
          setPendingPaste(null);
          if (text) pasteIntoTerminal(text, false);
        }}
      />
    </div>
  );
}
