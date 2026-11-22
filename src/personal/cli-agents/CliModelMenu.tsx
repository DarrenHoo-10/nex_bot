// The model and effort menu of an Agent session: the same menu as NexBot's chat
// composer, listing the rows the CLI's own `/model` picker shows on that computer.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { CLI_EFFORTS, CLI_MODELS, type CliEngine, type CliModelCatalog, type CliModelOption } from "../../../shared/cli-agents";
import { useAnchoredPopover } from "../components/anchored-popover";
import "../components/model-menu.css";
import { cliErrorText, fetchModels } from "./api";

/** The model and reasoning effort a session runs with; empty strings leave the CLI's own default. */
export interface LaunchChoice { model: string; effort: string }

export const EFFORT_LABEL: Record<string, string> = { "": "默认", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "超高" };
const effortLabel = (level: string) => EFFORT_LABEL[level] ?? level;

/** The built-in suggestions, for a computer whose executor cannot list its CLI's models. */
export function fallbackCatalog(engine: CliEngine): CliModelCatalog {
  return { models: CLI_MODELS[engine].map((row) => ({ ...row })) };
}

/** Effort levels `model` takes: what the CLI says for it, else every level of the engine. */
export function effortsFor(engine: CliEngine, models: readonly CliModelOption[], model: string): readonly string[] {
  return models.find((row) => row.id === model)?.efforts ?? CLI_EFFORTS[engine] ?? [];
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
  return {
    catalog: live && mine.catalog ? mine.catalog : fallbackCatalog(engine),
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
}

export function CliModelMenu({ deviceId, engine, live, choice, onChange, running, disabled, note, triggerClassName = "na-model-button" }: CliModelMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  // the trigger names the chosen model, so the list is read before the menu opens
  const { catalog, loading, error } = useModelCatalog(deviceId, engine, live);
  const models = catalog.models;
  useEffect(() => { if (open) setQuery(""); }, [open]);
  useAnchoredPopover(open, panel, () => trigger.current, () => [root.current], () => setOpen(false));

  const label = (id: string) => models.find((row) => row.id === id)?.label ?? id;
  const fallback = running?.trim() || catalog.current || "";
  const shown = useMemo(() => {
    const listed = choice.model && !models.some((row) => row.id === choice.model) ? [...models, { id: choice.model, label: choice.model }] : models;
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return listed.filter((row) => terms.every((term) => `${row.id} ${row.label} ${row.description ?? ""}`.toLowerCase().includes(term)));
  }, [models, choice.model, query]);
  const offered = effortsFor(engine, models, choice.model || fallback);
  const stops = ["", ...offered];
  const resolved = stops.includes(choice.effort) ? choice.effort : "";
  const [level, setLevel] = useState(stops.indexOf(resolved));
  useEffect(() => { setLevel(stops.indexOf(resolved)); }, [resolved, offered.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const commitLevel = () => { const next = stops[level]; if (next !== undefined && next !== choice.effort) onChange({ ...choice, effort: next }); };

  const pick = (model: string) => {
    if (disabled) return;
    // an effort the new model does not take falls back to the CLI's default
    const efforts = effortsFor(engine, models, model || fallback);
    onChange({ model, effort: choice.effort && !efforts.includes(choice.effort) ? "" : choice.effort });
    setOpen(false); trigger.current?.focus();
  };

  const title = choice.model ? label(choice.model) : fallback ? label(fallback) : "默认模型";
  return <div className="model-menu-root" ref={root}>
    <button ref={trigger} type="button" className={triggerClassName} aria-label="模型设置" aria-haspopup="dialog" aria-expanded={open} title={choice.model || fallback || undefined} onClick={() => setOpen(!open)}>
      <span>{title}</span>{choice.effort ? <span className="na-effort">{effortLabel(choice.effort)}</span> : null}<ChevronDown size={13}/>
    </button>
    {open && <div ref={panel} popover="manual" className="model-menu na-model-menu" role="dialog" aria-label="模型设置" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <div className="model-menu-heading">模型</div>
      {models.length > 8 || query ? <label className="model-menu-search"><Search size={14}/><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus/></label> : null}
      <div className="model-menu-list" role="listbox" aria-label="可用模型">
        {!query ? <button type="button" role="option" aria-selected={!choice.model} className="model-menu-row" disabled={disabled} onClick={() => pick("")}>
          <span className="model-menu-name">默认</span>{fallback ? <span className="model-menu-tag" title={fallback}>{label(fallback)}</span> : null}{!choice.model ? <Check size={15} className="model-menu-check"/> : null}
        </button> : null}
        {shown.map((row) => <button type="button" role="option" aria-selected={row.id === choice.model} key={row.id} className="model-menu-row na-model-row" disabled={disabled} onClick={() => pick(row.id)} title={row.id}>
          <span className="na-model-text"><span className="model-menu-name">{row.label}</span>{"description" in row && row.description ? <small>{row.description}</small> : null}</span>
          {row.id === choice.model ? <Check size={15} className="model-menu-check"/> : null}
        </button>)}
        {loading ? <div className="model-menu-status" role="status">正在获取模型…</div> : null}
        {error ? <div className="model-menu-status" role="alert">{error}</div> : null}
        {!shown.length && query ? <div className="model-menu-status">没有匹配的模型</div> : null}
      </div>
      {offered.length ? <div className="model-menu-effort">
        <div className="model-menu-effort-label"><span>推理强度</span><strong>{effortLabel(stops[level] ?? "")}</strong></div>
        <input type="range" aria-label="推理强度" min={0} max={stops.length - 1} step={1} value={Math.max(0, level)} disabled={disabled}
          aria-valuetext={effortLabel(stops[level] ?? "")} style={{ ["--fill" as string]: `${stops.length > 1 ? (Math.max(0, level) / (stops.length - 1)) * 100 : 0}%` }}
          onChange={(event) => setLevel(Number(event.target.value))} onPointerUp={commitLevel} onKeyUp={commitLevel} onBlur={commitLevel}/>
        <div className="model-menu-stops" aria-hidden="true">{stops.map((stop) => <span key={stop || "default"}>{effortLabel(stop)}</span>)}</div>
      </div> : null}
      {note ? <div className="model-menu-status" role="status">{note}</div> : null}
    </div>}
  </div>;
}
