import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Clock3, Layers2 } from "lucide-react";

const choices = [
  { value: "time", label: "最近活动", Icon: Clock3 },
  { value: "engine", label: "按 Harness", Icon: Layers2 },
] as const;

export type SessionSort = typeof choices[number]["value"];

export function SessionSortMenu({ value, onChange }: { value: SessionSort; onChange(value: SessionSort): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = choices.find(choice => choice.value === value)!;

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  return <div ref={root} className="na-sort" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" ref={button} className="na-sort-trigger" aria-label={`同层排序，${current.label}`}
      aria-expanded={open} aria-haspopup="menu" aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}>
      {current.label}<ChevronDown size={12}/>
    </button>
    {open && <div role="menu" id={menuId} aria-label="同层排序" className="na-sort-menu" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      const options = Array.from(event.currentTarget.querySelectorAll("button"));
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = { ArrowDown: (index + 1) % options.length, ArrowUp: (index + options.length - 1) % options.length,
        Home: 0, End: options.length - 1 }[event.key];
      if (next !== undefined) { event.preventDefault(); options[next].focus(); }
    }}>
      {choices.map(({ value: option, label, Icon }) =>
        <button key={option} type="button" tabIndex={-1} role="menuitemradio" aria-checked={option === value}
          onClick={() => { onChange(option); close(); }}>
          <Icon size={14}/><span>{label}</span>{option === value && <Check size={14}/>}
        </button>)}
    </div>}
  </div>;
}
