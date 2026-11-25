// Which CLI a new session runs. Every CLI NexAgent can start is listed; one the chosen computer does not have is shown but cannot be picked.
import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { CliEngine } from "../../../shared/cli-agents";
import { useAnchoredPopover } from "../components/anchored-popover";
import { HarnessMark } from "./tokendance/HarnessMark";
import { AGENT_LABEL } from "./session-model";

/** The CLIs a new session can start in. */
export const STARTABLE: readonly CliEngine[] = ["claude", "codex", "agy"];

export function HarnessPicker({ engines, value, onChange, disabled, agyNeedsUpdate }: { engines: readonly CliEngine[]; value: CliEngine; onChange(next: CliEngine): void; disabled?: boolean; agyNeedsUpdate?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(open, panel, () => trigger.current, () => [root.current], () => setOpen(false), 260);
  return <div className="model-menu-root" ref={root}>
    <button ref={trigger} type="button" className="na-pick-chip" aria-label="运行工具" aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
      onClick={() => setOpen(!open)}><HarnessMark agentId={value} size="sm"/><span>{AGENT_LABEL[value]}</span><ChevronDown size={13}/></button>
    {open && <div ref={panel} popover="manual" className="model-menu na-model-menu" role="dialog" aria-label="运行工具"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <div className="na-model-head"><span>运行工具</span></div>
      <div className="model-menu-list" role="listbox" aria-label="运行工具">
        {STARTABLE.map((engine) => {
          const installed = engines.includes(engine);
          return <button key={engine} type="button" role="option" aria-selected={engine === value} className="model-menu-row na-model-row" disabled={!installed}
            onClick={() => { onChange(engine); setOpen(false); trigger.current?.focus(); }}>
            <HarnessMark agentId={engine} size="sm"/>
            <span className="na-model-text"><span className="model-menu-name">{AGENT_LABEL[engine]}</span>{installed ? null : <small>{engine === "agy" && agyNeedsUpdate ? "需要更新" : "不可用"}</small>}</span>
            {engine === value ? <Check size={15} className="model-menu-check"/> : null}
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
