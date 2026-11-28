// Floating terminal overlays: FindBar, TerminalOptionsPopover, ContextMenu,
// and multiline PasteConfirmDialog (inspired by Persona web terminal overlays).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, Search, X, Zap } from "lucide-react";
import {
  CURSOR_STYLES,
  findLabel,
  FONT_SIZES,
  lineCount,
  TERMINAL_THEME_IDS,
  TERMINAL_THEMES,
  terminalMenu,
  type CursorStyle,
  type FindState,
  type TerminalMenuKey,
  type TerminalPrefs,
  type TerminalThemeId,
} from "./terminal-logic";

export function TerminalFindBar({
  state,
  result,
  onQuery,
  onToggleCase,
  onStep,
  onClose,
}: {
  state: FindState;
  result: { index: number; count: number } | null;
  onQuery(query: string): void;
  onToggleCase(): void;
  onStep(dir: 1 | -1): void;
  onClose(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const label = findLabel(state.query, result);
  const none = Boolean(state.query) && (result?.count ?? 0) === 0;

  return (
    <div role="search" aria-label="在终端中查找" className="cli-term-find">
      <Search size={13} className="cli-term-find-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        value={state.query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="查找终端输出"
        aria-label="查找终端输出"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
      />
      <span aria-live="polite" className="cli-term-find-count" data-empty={none ? "1" : undefined}>
        {label}
      </span>
      <button type="button" aria-label="上一处" title="上一处 (Shift+Enter)" disabled={!state.query} onClick={() => onStep(-1)}>
        <ArrowUp size={13} />
      </button>
      <button type="button" aria-label="下一处" title="下一处 (Enter)" disabled={!state.query} onClick={() => onStep(1)}>
        <ArrowDown size={13} />
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={state.caseSensitive}
        aria-label="区分大小写"
        title="区分大小写"
        data-active={state.caseSensitive ? "1" : undefined}
        className="cli-term-find-case"
        onClick={onToggleCase}
      >
        Aa
      </button>
      <button type="button" aria-label="关闭查找" title="关闭 (Esc)" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}

export function TerminalOptionsPopover({
  anchor,
  prefs,
  pageDark,
  onChange,
  onEditShortcuts,
  onClose,
}: {
  anchor: HTMLElement;
  prefs: TerminalPrefs;
  pageDark: boolean;
  onChange(patch: Partial<TerminalPrefs>): void;
  onEditShortcuts(): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(286, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 360));
    setPos({ top, left, width });
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
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
  }, [anchor, onClose]);

  const swatches = (id: TerminalThemeId) => {
    const meta = TERMINAL_THEMES[id];
    const p = meta.alwaysDark || pageDark ? meta.dark : meta.light;
    return [p.background, p.foreground, p.green, p.blue];
  };

  return createPortal(
    <div ref={ref} role="dialog" aria-label="终端设置" className="cli-term-options" style={pos}>
      <div className="cli-term-opt-section">
        <div className="cli-term-opt-heading">配色主题</div>
        <div className="cli-term-theme-grid" role="radiogroup" aria-label="配色主题">
          {TERMINAL_THEME_IDS.map((id) => {
            const active = prefs.theme === id;
            const meta = TERMINAL_THEMES[id];
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                className="cli-term-theme-btn"
                data-active={active ? "1" : undefined}
                onClick={() => onChange({ theme: id })}
              >
                <span className="cli-term-theme-swatches" aria-hidden="true">
                  {swatches(id).map((color, idx) => (
                    <i key={idx} style={{ background: color }} />
                  ))}
                </span>
                <span>{meta.label}</span>
                {active ? <Check size={12} className="cli-term-theme-check" /> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="cli-term-opt-row">
        <span>字号</span>
        <div className="cli-term-stepper">
          <button
            type="button"
            aria-label="减小字号"
            disabled={prefs.fontSize <= FONT_SIZES.min}
            onClick={() => onChange({ fontSize: prefs.fontSize - 1 })}
          >
            −
          </button>
          <button
            type="button"
            className="cli-term-stepper-val"
            title="恢复默认字号"
            onClick={() => onChange({ fontSize: FONT_SIZES.default })}
          >
            {prefs.fontSize}
          </button>
          <button
            type="button"
            aria-label="增大字号"
            disabled={prefs.fontSize >= FONT_SIZES.max}
            onClick={() => onChange({ fontSize: prefs.fontSize + 1 })}
          >
            +
          </button>
        </div>
      </div>

      <div className="cli-term-opt-row">
        <span>光标形状</span>
        <div className="cli-term-seg" role="radiogroup" aria-label="光标形状">
          {CURSOR_STYLES.map((item) => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={prefs.cursorStyle === item.value}
              data-active={prefs.cursorStyle === item.value ? "1" : undefined}
              onClick={() => onChange({ cursorStyle: item.value as CursorStyle })}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="cli-term-opt-row">
        <span>光标闪烁</span>
        <button
          type="button"
          role="switch"
          aria-label="光标闪烁"
          aria-checked={prefs.cursorBlink}
          className="cli-switch"
          onClick={() => onChange({ cursorBlink: !prefs.cursorBlink })}
        />
      </div>

      <div className="cli-term-opt-row">
        <span>快捷键栏</span>
        <button
          type="button"
          role="switch"
          aria-label="快捷键栏"
          aria-checked={prefs.keyBar}
          className="cli-switch"
          onClick={() => onChange({ keyBar: !prefs.keyBar })}
        />
      </div>

      <div className="cli-term-opt-divider" />

      <button
        type="button"
        className="cli-term-opt-action"
        onClick={() => {
          onClose();
          onEditShortcuts();
        }}
      >
        <Zap size={14} />
        <span>编辑快捷命令…</span>
      </button>
    </div>,
    document.body,
  );
}

export function TerminalContextMenu({
  x,
  y,
  selection,
  driving,
  onSelect,
  onClose,
}: {
  x: number;
  y: number;
  selection: boolean;
  driving: boolean;
  onSelect(key: TerminalMenuKey): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
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

  const items = terminalMenu({ selection, driving });

  return createPortal(
    <div ref={ref} role="menu" aria-label="终端菜单" className="na-menu cli-term-menu" style={pos}>
      {items.map((item) => (
        <div key={item.key}>
          {item.divider ? <div className="cli-term-menu-divider" /> : null}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              onSelect(item.key);
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function PasteConfirmDialog({
  text,
  onConfirm,
  onCancel,
}: {
  text: string | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (text === null) return;
    cancelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (!dialogRef.current?.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter") cancelRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [text, onCancel]);

  if (text === null) return null;
  const lines = lineCount(text);

  return (
    <div
      className="modal-backdrop cli-term-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={dialogRef} className="modal na-dialog cli-term-paste-dialog" role="alertdialog" aria-modal="true" aria-label="确认粘贴多行文本">
        <h3>粘贴 {lines} 行内容？</h3>
        <pre className="cli-term-paste-preview">{text.slice(0, 600)}{text.length > 600 ? "\n…" : ""}</pre>
        <footer>
          <button ref={cancelRef} type="button" onClick={onCancel}>取消</button>
          <button type="button" className="primary" onClick={onConfirm}>粘贴</button>
        </footer>
      </div>
    </div>
  );
}
