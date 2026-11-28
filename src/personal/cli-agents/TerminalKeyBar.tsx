// Bottom terminal key bar & saved quick commands (inspired by Persona KeyBar/Shortcuts).
// Keeps focus in xterm via onMouseDown preventDefault so soft keyboards stay up.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Clipboard,
  Copy,
  CornerDownLeft,
  Paperclip,
  Trash2,
  Zap,
} from "lucide-react";
import {
  decodeShortcuts,
  moveShortcut,
  PREF_KEYS,
  type ModifierKey,
  type Modifiers,
  type ModifierState,
} from "./terminal-logic";

const HOLD_MS = 350;
const DOUBLE_TAP_MS = 350;

const listeners = new Set<() => void>();
let cachedShortcuts: { raw: string | null; list: string[] } | null = null;

function readShortcuts(): string[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREF_KEYS.shortcuts);
  } catch {
    raw = null;
  }
  if (!cachedShortcuts || cachedShortcuts.raw !== raw) {
    cachedShortcuts = { raw, list: decodeShortcuts(raw) };
  }
  return cachedShortcuts.list;
}

function saveShortcuts(list: string[]): void {
  try {
    localStorage.setItem(PREF_KEYS.shortcuts, JSON.stringify(list));
  } catch {
    // storage unavailable
  }
  cachedShortcuts = null;
  listeners.forEach((listener) => listener());
}

function useShortcuts(): string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readShortcuts,
    readShortcuts,
  );
}

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function ModifierCap({
  k,
  label,
  name,
  state,
  disabled,
  onTap,
  onHold,
  onRelease,
}: {
  k: ModifierKey;
  label: string;
  name: string;
  state: ModifierState;
  disabled: boolean;
  onTap(k: ModifierKey, quick: boolean): void;
  onHold(k: ModifierKey): void;
  onRelease(k: ModifierKey): void;
}) {
  const downAt = useRef<number | null>(null);
  const timer = useRef<number>(0);
  const lastTap = useRef<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const at = performance.now();
    downAt.current = at;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (downAt.current === at) onHold(k);
    }, HOLD_MS);
  };

  const onPointerUp = () => {
    if (downAt.current === null) return;
    downAt.current = null;
    window.clearTimeout(timer.current);
    if (stateRef.current === "held") {
      onRelease(k);
      return;
    }
    const now = performance.now();
    const quick = now - lastTap.current < DOUBLE_TAP_MS;
    lastTap.current = now;
    onTap(k, quick);
  };

  const onPointerCancel = () => {
    downAt.current = null;
    window.clearTimeout(timer.current);
    onRelease(k);
  };

  return (
    <button
      type="button"
      className="cli-term-cap"
      data-mod={state}
      title={`${name}（轻点一次生效，双击锁定，长按保持）`}
      aria-label={name}
      aria-pressed={state !== "off"}
      disabled={disabled}
      onMouseDown={keepFocus}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={(e) => {
        if (e.detail === 0) onTap(k, false);
      }}
    >
      {label}
      {state === "locked" ? <span className="cli-term-cap-lock" aria-hidden="true" /> : null}
    </button>
  );
}

export function ShortcutsPopover({
  onPick,
  onEdit,
  onClose,
}: {
  onPick(text: string, run: boolean): void;
  onEdit(): void;
  onClose(): void;
}) {
  const list = useShortcuts();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (ref.current?.contains(target)) return;
      if (target?.closest?.('[data-term-shortcuts-trigger="1"]')) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="快捷命令"
      className="cli-term-shortcuts"
      onMouseDown={keepFocus}
    >
      <header className="cli-term-shortcuts-head">
        <span>快捷命令</span>
        <button type="button" onClick={onEdit}>编辑</button>
      </header>
      {list.length === 0 ? (
        <p className="cli-term-shortcuts-empty">暂无快捷命令</p>
      ) : (
        <div className="cli-term-shortcuts-list">
          {list.map((cmd, index) => (
            <div key={`${index}:${cmd}`} className="cli-term-shortcut-row">
              <button
                type="button"
                className="cli-term-shortcut-cmd"
                title={`填入：${cmd}`}
                onClick={() => onPick(cmd, false)}
              >
                {cmd}
              </button>
              <button
                type="button"
                className="cli-term-shortcut-run"
                aria-label={`执行 ${cmd}`}
                title={`立即执行：${cmd}`}
                onClick={() => onPick(cmd, true)}
              >
                <CornerDownLeft size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ShortcutsEditor({ open, onClose }: { open: boolean; onClose(): void }) {
  const list = useShortcuts();
  const [draft, setDraft] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (!dialogRef.current?.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    saveShortcuts([...list, trimmed]);
    setDraft("");
  };

  return (
    <div
      className="modal-backdrop cli-term-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="modal na-dialog cli-term-editor" role="dialog" aria-modal="true" aria-label="快捷命令">
        <h3>快捷命令</h3>
        <div className="cli-term-editor-list">
          {list.length === 0 ? (
            <p className="cli-term-editor-empty">暂无快捷命令</p>
          ) : (
            list.map((cmd, index) => (
              <div key={`${index}:${cmd}`} className="cli-term-editor-row">
                <code title={cmd}>{cmd}</code>
                <button
                  type="button"
                  aria-label="上移"
                  disabled={index === 0}
                  onClick={() => saveShortcuts(moveShortcut(list, index, -1))}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label="下移"
                  disabled={index === list.length - 1}
                  onClick={() => saveShortcuts(moveShortcut(list, index, 1))}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  type="button"
                  aria-label="删除"
                  className="is-danger"
                  onClick={() => saveShortcuts(list.filter((_, i) => i !== index))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
        <form
          className="cli-term-editor-form"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="输入常用命令，例如 git status"
            aria-label="新增快捷命令"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" disabled={!draft.trim()}>添加</button>
        </form>
        <footer>
          <button type="button" className="primary" onClick={onClose}>完成</button>
        </footer>
      </div>
    </div>
  );
}

export interface TerminalKeyBarProps {
  disabled: boolean;
  mods: Modifiers;
  hasSelection: boolean;
  onPressKey(name: string): void;
  onPressBare(name: string): void;
  onTapModifier(k: ModifierKey, quick: boolean): void;
  onHoldModifier(k: ModifierKey): void;
  onReleaseModifier(k: ModifierKey): void;
  onTypeText(text: string, run: boolean): void;
  onCopy(): void;
  onPaste(): void;
  onPickFiles(): void;
  onEditShortcuts(): void;
}

export function TerminalKeyBar({
  disabled,
  mods,
  hasSelection,
  onPressKey,
  onPressBare,
  onTapModifier,
  onHoldModifier,
  onReleaseModifier,
  onTypeText,
  onCopy,
  onPaste,
  onPickFiles,
  onEditShortcuts,
}: TerminalKeyBarProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    if (disabled) setShortcutsOpen(false);
  }, [disabled]);

  return (
    <div className="cli-term-keybar" title={disabled ? "请先切换到控制模式" : undefined}>
      {shortcutsOpen ? (
        <ShortcutsPopover
          onPick={(text, run) => {
            onTypeText(text, run);
            if (run) setShortcutsOpen(false);
          }}
          onEdit={() => {
            setShortcutsOpen(false);
            onEditShortcuts();
          }}
          onClose={() => setShortcutsOpen(false)}
        />
      ) : null}
      <div role="toolbar" aria-label="终端快捷键栏" className="cli-term-keybar-row">
        <div className="cli-term-keybar-scroll">
          <ModifierCap k="ctrl" label="Ctrl" name="Control" state={mods.ctrl} disabled={disabled} onTap={onTapModifier} onHold={onHoldModifier} onRelease={onReleaseModifier} />
          <button type="button" className="cli-term-cap" disabled={disabled} title="Esc" aria-label="Esc" onMouseDown={keepFocus} onClick={() => onPressKey("esc")}>Esc</button>
          <button type="button" className="cli-term-cap" disabled={disabled} title="Tab" aria-label="Tab" onMouseDown={keepFocus} onClick={() => onPressKey("tab")}>Tab</button>
          <button type="button" className="cli-term-cap" disabled={disabled} title="发送 Ctrl+C" aria-label="发送 Ctrl+C" onMouseDown={keepFocus} onClick={() => onPressBare("ctrl+c")}>⌃C</button>
          <button
            type="button"
            className="cli-term-cap"
            data-mod={shortcutsOpen ? "once" : "off"}
            data-term-shortcuts-trigger="1"
            disabled={disabled}
            title="快捷命令"
            aria-label="快捷命令"
            aria-pressed={shortcutsOpen}
            onMouseDown={keepFocus}
            onClick={() => setShortcutsOpen((open) => !open)}
          >
            <Zap size={14} />
          </button>
          <button type="button" className="cli-term-cap" disabled={!hasSelection} title="复制选中文本" aria-label="复制选中文本" onMouseDown={keepFocus} onClick={onCopy}>
            <Copy size={14} />
          </button>
          <button type="button" className="cli-term-cap" disabled={disabled} title="粘贴" aria-label="粘贴" onMouseDown={keepFocus} onClick={onPaste}>
            <Clipboard size={14} />
          </button>
          <button type="button" className="cli-term-cap" disabled={disabled} title="上传文件并填入路径" aria-label="上传文件并填入路径" onMouseDown={keepFocus} onClick={onPickFiles}>
            <Paperclip size={14} />
          </button>
          <ModifierCap k="alt" label="Alt" name="Option / Alt" state={mods.alt} disabled={disabled} onTap={onTapModifier} onHold={onHoldModifier} onRelease={onReleaseModifier} />
          <ModifierCap k="shift" label="⇧" name="Shift" state={mods.shift} disabled={disabled} onTap={onTapModifier} onHold={onHoldModifier} onRelease={onReleaseModifier} />
        </div>
        <div className="cli-term-keybar-arrows">
          <button type="button" className="cli-term-cap is-icon" disabled={disabled} title="←" aria-label="左方向键" onMouseDown={keepFocus} onClick={() => onPressKey("left")}><ArrowLeft size={14} /></button>
          <button type="button" className="cli-term-cap is-icon" disabled={disabled} title="↑" aria-label="上方向键" onMouseDown={keepFocus} onClick={() => onPressKey("up")}><ArrowUp size={14} /></button>
          <button type="button" className="cli-term-cap is-icon" disabled={disabled} title="↓" aria-label="下方向键" onMouseDown={keepFocus} onClick={() => onPressKey("down")}><ArrowDown size={14} /></button>
          <button type="button" className="cli-term-cap is-icon" disabled={disabled} title="→" aria-label="右方向键" onMouseDown={keepFocus} onClick={() => onPressKey("right")}><ArrowRight size={14} /></button>
          <button type="button" className="cli-term-cap is-icon" disabled={disabled} title="回车" aria-label="回车" onMouseDown={keepFocus} onClick={() => onPressKey("enter")}><CornerDownLeft size={14} /></button>
        </div>
      </div>
    </div>
  );
}
