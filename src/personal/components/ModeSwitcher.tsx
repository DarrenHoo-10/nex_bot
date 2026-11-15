// The brand in the top-left corner doubles as the switch between the assistants (NexBot)
// and the coding agents running on the user's computers (NexAgent).
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, House } from "lucide-react";
import { BrandMark } from "./BrandMark";

export type WorkspaceMode = "bot" | "agent";

interface Props {
  mode: WorkspaceMode;
  /** Agent sessions waiting for the user */
  waiting: number;
  /** web only: the brand used to link to the homepage */
  home?: boolean;
  onMode(mode: WorkspaceMode): void;
}

export const MODE_LABEL: Record<WorkspaceMode, string> = { bot: "NexBot", agent: "NexAgent" };

export function ModeSwitcher({ mode, waiting, home, onMode }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  const choose = (next: WorkspaceMode) => { close(); if (next !== mode) onMode(next); };
  const badge = mode === "bot" && waiting > 0;
  return <div className="mode-switcher" ref={root}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (!open || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    <button ref={button} type="button" className="mode-switcher-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-label={`${MODE_LABEL[mode]}，切换模式${badge ? `，NexAgent 有 ${waiting} 个等你处理` : ""}`}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setOpen(true); } }}>
      <BrandMark size={30} agent={mode === "agent"}/>
      <strong>{MODE_LABEL[mode]}</strong>
      {badge ? <span className="contact-unread mode-switcher-badge" data-testid="cli-waiting">{waiting > 99 ? "99+" : waiting}</span> : null}
      <ChevronDown size={15} className="mode-switcher-chevron"/>
    </button>
    {open ? <div className="account-menu mode-menu" id={menuId} role="menu" aria-label="切换模式">
      <button type="button" role="menuitemradio" aria-checked={mode === "bot"} className={mode === "bot" ? "is-selected" : ""} onClick={() => choose("bot")}>
        <BrandMark size={22}/><span>NexBot</span>{mode === "bot" ? <Check size={16}/> : null}
      </button>
      <button type="button" role="menuitemradio" aria-checked={mode === "agent"} className={mode === "agent" ? "is-selected" : ""} onClick={() => choose("agent")}>
        <BrandMark size={22} agent/><span>NexAgent</span>{waiting > 0 ? <b className="contact-unread" aria-label={`${waiting} 个等你处理`}>{waiting > 99 ? "99+" : waiting}</b> : null}{mode === "agent" ? <Check size={16}/> : null}
      </button>
      {home ? <>
        <div className="account-menu-divider" role="separator"/>
        <button type="button" role="menuitem" onClick={() => { setOpen(false); window.location.hash = "#home"; }}><House size={18}/><span>首页</span></button>
      </> : null}
    </div> : null}
  </div>;
}
