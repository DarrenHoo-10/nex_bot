import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { str, type RecordRow } from "../api";
import { useAnchoredPopover } from "./anchored-popover";
import { AgentAvatar } from "./AgentAvatar";
import "./assistant-switcher.css";

const rowHeight = 44;
const copies = 9;
const panelClearance = 28; // Viewport margin, anchor gap and panel border/padding.
const wrap = (index: number, count: number) => (index % count + count) % count;

export function AssistantSwitcher({ assistants, activeId, onSelect, children }: {
  assistants: RecordRow[];
  activeId: string;
  onSelect(id: string): void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [center, setCenter] = useState(0);
  const [availableRows, setAvailableRows] = useState(1);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const count = assistants.length;
  const loop = count > 1;
  const visibleRows = Math.min(count, availableRows);
  const leadingRows = Math.floor((visibleRows - 1) / 2);
  const middle = loop ? Math.floor(copies / 2) * count : 0;
  const rows = Array.from({ length: loop ? copies * count : count }, (_, index) => assistants[index % count]);
  const activeIndex = Math.max(0, assistants.findIndex((item) => item.id === activeId));
  const firstRow = middle + activeIndex;

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useAnchoredPopover(open, panel, () => trigger.current, () => [trigger.current], () => close(), "content");
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const space = Math.max(anchor.top, window.innerHeight - anchor.bottom);
      setAvailableRows(Math.max(1, Math.floor((space - panelClearance) / rowHeight)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !list.current) return;
    list.current.scrollTop = firstRow * rowHeight;
    setCenter(firstRow);
    list.current.focus({ preventScroll: true });
    return () => clearTimeout(settleTimer.current);
  }, [open, firstRow]);

  const choose = (index: number) => {
    const assistant = rows[index];
    if (!assistant) return;
    close(true);
    if (assistant.id !== activeId) onSelect(str(assistant.id));
  };
  const onScroll = () => {
    const wheel = list.current;
    if (!wheel || !loop) return;
    const index = Math.round(wheel.scrollTop / rowHeight);
    setCenter(index);
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      if (index >= count && index < rows.length - count) return;
      const equivalent = middle + wrap(index, count);
      wheel.scrollTop = equivalent * rowHeight;
      setCenter(equivalent);
    }, 180);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.stopPropagation(); close(true); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(center); return; }
    if (!loop || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const candidate = center + (event.key === "ArrowUp" ? -1 : 1);
    const next = candidate < 0 || candidate >= rows.length ? middle + wrap(candidate, count) : candidate;
    if (list.current) list.current.scrollTop = next * rowHeight;
    setCenter(next);
  };

  return <>
    <button type="button" ref={trigger} className="contact-heading who glass assistant-switch-trigger"
      aria-label={`${str(assistants[activeIndex]?.name)}，切换助手`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : setOpen(true)}>
      {children}
    </button>
    {open && <div className="assistant-switch-panel" popover="manual" ref={panel}>
      <div id={id} ref={list} className="assistant-switch-list" data-loop={loop} role="listbox" aria-label="切换助手" tabIndex={0}
        aria-activedescendant={`${id}-${center}`} onScroll={onScroll} onKeyDown={onKeyDown}
        style={{
          "--assistant-row": `${rowHeight}px`,
          "--assistant-visible-rows": visibleRows,
          "--assistant-leading-rows": leadingRows,
          "--assistant-trailing-rows": visibleRows - leadingRows - 1,
        } as CSSProperties}>
        {rows.map((assistant, index) => {
          const distance = index - center;
          const accessible = distance >= -Math.floor((count - 1) / 2) && distance <= Math.floor(count / 2);
          return <div key={index} id={`${id}-${index}`} className="assistant-switch-option" role="option"
            data-centered={index === center || undefined} aria-hidden={!accessible || undefined} aria-selected={assistant.id === activeId}
            onClick={() => choose(index)}>
            <AgentAvatar bot={assistant} allBots={assistants} size={30}/>
            <span className="assistant-switch-name">{assistant.name}</span>
          </div>;
        })}
      </div>
    </div>}
  </>;
}
