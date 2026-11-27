// The model and effort menu of an Agent session: the same menu as NexBot's chat
// composer, listing the rows the CLI's own `/model` picker shows on that computer.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { CLI_MODELS, CLI_REASONING_LEVELS, cliReasoningChoice, resolveCliEffort, type CliEngine, type CliModelCatalog } from "../../../shared/cli-agents";
import { EffortChoices } from "../components/EffortChoices";
import { useAnchoredPopover } from "../components/anchored-popover";
import { useCompactComposer } from "../components/use-compact-composer";
import { cliErrorText, fetchModels } from "./api";

/** The model and reasoning effort a session runs with; empty strings leave the CLI's own default. */
export interface LaunchChoice { model: string; effort: string }

export const EFFORT_LABEL: Record<string, string> = { "": "默认", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "超高" };
const effortLabel = (level: string) => EFFORT_LABEL[level] ?? level;

/** The built-in suggestions, for a computer whose executor cannot list its CLI's models. */
export function fallbackCatalog(engine: CliEngine): CliModelCatalog {
  return { models: CLI_MODELS[engine].map((row) => ({ ...row })) };
}

/** The catalog for a computer and CLI: read from the computer when it can list it, else the built-in one. */
export function useModelCatalog(deviceId: string, engine: CliEngine, live: boolean, active = true): { catalog: CliModelCatalog; loading: boolean; error: string } {
  const [state, setState] = useState<{ id: string; catalog?: CliModelCatalog; error?: string }>({ id: "" });
  const id = `${deviceId}\n${engine}`;
  useEffect(() => {
    if (!live || !active || !deviceId) return;
    let current = true;
    fetchModels(deviceId, engine)
      .then((catalog) => { if (current) setState({ id, catalog }); })
      .catch((cause: unknown) => { if (current) setState({ id, error: cliErrorText(cause, "获取模型失败") }); });
    return () => { current = false; };
  }, [deviceId, engine, live, active, id]);
  const mine = state.id === id ? state : { id };
  const fallback = useMemo(() => fallbackCatalog(engine), [engine]);
  return {
    catalog: live && mine.catalog ? mine.catalog : fallback,
    loading: live && active && !mine.catalog && !mine.error,
    error: live ? mine.error ?? "" : "",
  };
}

export interface CliModelMenuProps {
  deviceId: string;
  engine: CliEngine;
  /** the computer lists its CLI's models (`models` feature); otherwise the built-in suggestions show */
  live: boolean;
  choice: LaunchChoice;
  onChange(next: LaunchChoice): void;
  /** the model the session runs with now, for the default row */
  running?: string;
  disabled?: boolean;
  /** a line under the list: when the choice takes effect, or why it cannot be made */
  note?: string;
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchorRef?: RefObject<HTMLElement | null>;
}

export function CliModelMenu({ deviceId, engine, live, choice, onChange, running, disabled, note, triggerClassName = "na-model-button", open: controlledOpen, onOpenChange, anchorRef }: CliModelMenuProps) {
  const compact = useCompactComposer();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value); };
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  // the trigger names the chosen model, so the list is read before the menu opens
  const { catalog, loading, error } = useModelCatalog(deviceId, engine, live);
  const models = catalog.models;
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  const anchor = () => anchorRef?.current ?? trigger.current;
  useAnchoredPopover(open, panel, anchor, () => [root.current, anchorRef?.current], () => setOpen(false), 320, "start", compact);

  const label = (id: string) => models.find((row) => row.id === id)?.label ?? id;
  const fallback = running?.trim() || catalog.current || "";
  const shown = useMemo(() => {
    if (!open) return [];
    const listed = choice.model && !models.some((row) => row.id === choice.model) ? [...models, { id: choice.model, label: choice.model }] : models;
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return listed;
    return listed.filter((row) => {
      const search = `${row.id} ${row.label} ${row.description ?? ""}`.toLowerCase();
      return terms.every((term) => search.includes(term));
    });
  }, [open, models, choice.model, query]);
  const dynamicCatalog = engine === "agy" || engine === "zcode";
  const levelsFor = (model: string) => models.find((row) => row.id === (model || fallback))?.efforts ?? [];
  const levels = dynamicCatalog ? levelsFor(choice.model) : CLI_REASONING_LEVELS;
  const selectedEffort = dynamicCatalog ? resolveCliEffort(engine, levels, choice.effort || catalog.currentEffort) ?? "" : cliReasoningChoice(choice.effort);
  const commitLevel = (next: string) => {
    if (!disabled && next !== choice.effort) onChange({ ...choice, effort: next });
  };

  const pick = (model: string) => {
    if (disabled || model === choice.model) return;
    onChange({ model, effort: dynamicCatalog ? resolveCliEffort(engine, levelsFor(model), selectedEffort) ?? "" : selectedEffort });
  };

  const title = choice.model ? label(choice.model) : fallback ? label(fallback) : "默认模型";
  return <div className="model-menu-root" ref={root}>
    {!anchorRef && <button ref={trigger} type="button" className={triggerClassName} aria-label="模型设置" aria-haspopup="dialog" aria-expanded={open} title={choice.model || fallback || undefined} onClick={() => setOpen(!open)}>
      <span>{title}</span>{(!dynamicCatalog || levels.length > 0) && <span className="na-effort">{effortLabel(selectedEffort)}</span>}<ChevronDown size={13}/>
    </button>}
    {open && <div ref={panel} popover="manual" className="model-menu na-model-menu" role="dialog" aria-label="模型设置" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); anchor()?.focus(); } }}>
      <div className="na-model-head"><span>模型</span></div>
      {levels.length > 0 && <EffortChoices levels={levels} value={selectedEffort} label={effortLabel} onChange={commitLevel} disabled={disabled}/>}
      {models.length > 8 || query ? <label className="model-menu-search"><Search size={14}/><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)}/></label> : null}
      <div className="model-menu-list" role="listbox" aria-label="可用模型">
        {!query ? <>
          {!(dynamicCatalog && running) && <button type="button" role="option" aria-selected={!choice.model} className="model-menu-row na-model-row" disabled={disabled} onClick={() => pick("")} title={fallback || undefined}>
            <span className="na-model-text"><span className="model-menu-name">默认</span>{fallback ? <small>{label(fallback)}</small> : null}</span>
            {!choice.model ? <Check size={15} className="model-menu-check"/> : null}
          </button>}
          {shown.length ? <div className="na-model-divider" role="presentation"/> : null}
        </> : null}
        {shown.map((row) => <button type="button" role="option" aria-selected={row.id === choice.model} key={row.id} className="model-menu-row na-model-row" disabled={disabled} onClick={() => pick(row.id)} title={row.id}>
          <span className="na-model-text"><span className="model-menu-name">{row.label}</span>{"description" in row && row.description ? <small>{row.description}</small> : null}</span>
          {row.id === choice.model ? <Check size={15} className="model-menu-check"/> : null}
        </button>)}
        {loading ? <div className="model-menu-status" role="status">正在获取模型…</div> : null}
        {error ? <div className="model-menu-status" role="alert">{error}</div> : null}
        {!shown.length && query ? <div className="model-menu-status">没有匹配的模型</div> : null}
      </div>
      {note ? <div className="na-model-note" role="status">{note}</div> : null}
    </div>}
  </div>;
}
