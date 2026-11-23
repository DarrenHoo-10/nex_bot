import { userErrorText } from "../../lib/http-errors";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { listConnectionModels, modelName, reasoningLabels, reasoningOrder, resolveReasoning, type Connection, type ReasoningChoice, type ReasoningLevel } from "../api";
import { useAnchoredPopover } from "./anchored-popover";
import "./model-menu.css";

/** What an assistant uses: a provider, a model there ("" = the provider's default model) and its reasoning effort. */
export interface ModelChoice { connectionId: string; model: string; reasoning: ReasoningChoice | null }
const formatLabel = (connection: Connection) => connection.provider === "anthropic" ? "Anthropic" : "API";

/**
 * The chat model menu: the provider on top (switch it in a sub-list), that provider's enabled models, and the
 * 思考强度 slider when the chosen model offers reasoning levels. Every choice saves at once through `onChange`.
 */
export function ModelMenu({ connections, choice, onChange, disabled, label = "选择模型", open: controlledOpen, onOpenChange, anchorRef, triggerClassName, displayValue, composer = false, selectionOnly = false }: {
  connections: Connection[]; choice: ModelChoice; onChange: (choice: ModelChoice) => void; disabled?: boolean; label?: string;
  open?: boolean; onOpenChange?: (open: boolean) => void; anchorRef?: RefObject<HTMLElement | null>; triggerClassName?: string; displayValue?: string; composer?: boolean; selectionOnly?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen, setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value); };
  const usable = connections.filter((connection) => connection.enabled && connection.configured);
  const current = usable.find((connection) => connection.id === choice.connectionId) ?? usable.find((connection) => connection.isDefault) ?? usable[0];
  const [viewed, setViewed] = useState(current?.id ?? "");
  const [picking, setPicking] = useState(false), [query, setQuery] = useState("");
  const [catalogs, setCatalogs] = useState<Record<string, { models?: string[]; error?: string; loading?: boolean }>>({});
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const provider = usable.find((connection) => connection.id === viewed) ?? current;
  useEffect(() => { if (open) { setViewed(current?.id ?? ""); setPicking(false); setQuery(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // A provider showing every model lists them from the service once per menu.
  useEffect(() => {
    if (!open || !provider || provider.models !== null || catalogs[provider.id]) return;
    setCatalogs((all) => ({ ...all, [provider.id]: { loading: true } }));
    listConnectionModels(provider.id)
      .then((result) => setCatalogs((all) => ({ ...all, [provider.id]: { models: result.models } })))
      .catch((error: unknown) => setCatalogs((all) => ({ ...all, [provider.id]: { error: userErrorText(error, "获取模型失败") } })));
  }, [open, provider, catalogs]);

  useAnchoredPopover(open, panel, () => anchorRef?.current ?? trigger.current, () => [root.current], () => setOpen(false), 320, composer ? "end" : "start");

  const effective = provider && provider.id === current?.id ? choice.model || (selectionOnly ? "" : provider.defaultModel) : "";
  const models = useMemo(() => {
    if (!provider) return [];
    const listed = provider.models ?? catalogs[provider.id]?.models ?? [];
    const all = [...new Set([...listed, ...(provider.defaultModel && (!selectionOnly || provider.models === null) ? [provider.defaultModel] : []), ...(effective && (!selectionOnly || provider.models === null || listed.includes(effective)) ? [effective] : [])])];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((model) => terms.every((term) => model.toLowerCase().includes(term) || modelName(provider, model).toLowerCase().includes(term)));
  }, [provider, catalogs, effective, query, selectionOnly]);

  // The slider follows the chosen model on the chosen provider.
  const chosenModel = current ? choice.model || current.defaultModel : "";
  const offered = current?.options[chosenModel]?.reasoning ?? [];
  const stops: ReasoningChoice[] = composer ? reasoningOrder : ["off", ...offered];
  const resolved = resolveReasoning(choice.reasoning, offered);
  const supported = (stop: ReasoningChoice) => stop !== "off" && offered.includes(stop as ReasoningLevel);
  const [level, setLevel] = useState(stops.indexOf(resolved));
  const levelIndex = Math.max(0, Math.min(level, stops.length - 1));
  useEffect(() => { setLevel(stops.indexOf(resolved)); }, [resolved, offered.join(), disabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const commitLevel = (index: number) => {
    if (disabled || !current || !stops[index]) return;
    const next = composer ? resolveReasoning(stops[index], offered) : stops[index];
    setLevel(stops.indexOf(next));
    if (next !== resolved) onChange({ connectionId: current.id, model: choice.model, reasoning: next });
  };

  const pick = (model: string) => {
    if (disabled || !provider) return;
    // Switching provider starts from that provider's own reasoning default; the same provider keeps the choice.
    onChange({ connectionId: provider.id, model, reasoning: provider.id === current?.id ? choice.reasoning : null });
    if (!composer) { setOpen(false); (anchorRef?.current ?? trigger.current)?.focus(); }
  };

  return <div className="model-menu-root" ref={root}>
    {!anchorRef && <button ref={trigger} type="button" className={triggerClassName ?? "model-picker-trigger"} aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)} title={displayValue}><span>{displayValue || chosenModel || label}</span><ChevronDown size={15}/></button>}
    {open && <div ref={panel} popover="manual" className="model-menu" role="dialog" aria-label={label} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); (anchorRef?.current ?? trigger.current)?.focus(); } }}>
      {!usable.length ? <p className="model-menu-empty">还没有可用的供应商，请在设置 → 模型中添加。</p> : picking ? <>
        <button type="button" className="model-menu-provider" onClick={() => setPicking(false)}><ChevronLeft size={15}/><span>供应商</span></button>
        <div className="model-menu-list" role="listbox" aria-label="供应商">
          {usable.map((connection) => <button type="button" role="option" aria-selected={connection.id === provider?.id} key={connection.id} className="model-menu-row" onClick={() => { setViewed(connection.id); setPicking(false); setQuery(""); }}>
            <span className="model-menu-name">{connection.name}</span><span className="model-menu-tag">{formatLabel(connection)}</span>{connection.id === current?.id ? <Check size={15} className="model-menu-check"/> : null}
          </button>)}
        </div>
      </> : <>
        {composer ? <div className="model-menu-compose-heading">
          <strong>模型</strong>
          {usable.length > 1 && <button type="button" aria-label={`切换供应商，当前：${provider?.name}`} onClick={() => setPicking(true)}>
            <span>{provider?.name}</span><ChevronRight size={14}/>
          </button>}
        </div> : <>
          <button type="button" className="model-menu-provider" aria-label={`切换供应商，当前：${provider?.name}`} disabled={usable.length < 2} onClick={() => setPicking(true)}><span>{provider?.name}</span><span className="model-menu-tag">{provider ? formatLabel(provider) : ""}</span>{usable.length > 1 ? <ChevronRight size={15}/> : null}</button>
          <div className="model-menu-heading">模型</div>
        </>}
        {composer || models.length > 8 || query ? <label className="model-menu-search"><Search size={14}/><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus={!composer}/></label> : null}
        <div className="model-menu-list" role="listbox" aria-label="可用模型">
          {models.map((model) => {
            const options = provider?.options[model];
            return <button type="button" role="option" aria-selected={model === effective} key={model} className="model-menu-row" disabled={disabled} onClick={() => pick(model)} title={model}>
              <span className="model-menu-name">{modelName(provider, model)}</span>{options?.imageInput ? <span className="model-menu-tag">视觉</span> : null}{model === effective ? <Check size={15} className="model-menu-check"/> : null}
            </button>;
          })}
          {provider && catalogs[provider.id]?.loading ? <div className="model-menu-status" role="status">正在获取模型…</div> : null}
          {provider && catalogs[provider.id]?.error ? <div className="model-menu-status" role="alert">{catalogs[provider.id]?.error}</div> : null}
          {!models.length && !(provider && catalogs[provider.id]?.loading) ? <div className="model-menu-status">没有可用的模型</div> : null}
        </div>
        {!selectionOnly && offered.length && provider?.id === current?.id ? <div className="model-menu-effort">
          <div className="model-menu-effort-label"><span>推理强度</span><strong>{level < 0 ? "—" : reasoningLabels[stops[levelIndex]]}</strong></div>
          <div className="model-menu-slider" style={{ "--fill": `${(levelIndex / (stops.length - 1)) * 100}%` } as CSSProperties}>
            <input type="range" aria-label={composer ? "推理强度" : "思考强度"} min={0} max={stops.length - 1} step={1} value={levelIndex} disabled={disabled}
              aria-valuetext={level < 0 ? "—" : reasoningLabels[stops[levelIndex]]} onChange={event => setLevel(Number(event.target.value))}
              onPointerUp={event => commitLevel(Number(event.currentTarget.value))}
              onKeyDown={event => {
                if (!composer) return;
                const forward = ["ArrowRight", "ArrowUp", "PageUp"].includes(event.key);
                const backward = ["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key);
                if (!forward && !backward && event.key !== "Home" && event.key !== "End") return;
                event.preventDefault();
                const available = stops.map((stop, index) => supported(stop) ? index : -1).filter(index => index >= 0);
                const next = event.key === "Home" ? available[0] : event.key === "End" ? available.at(-1)
                  : forward ? available.find(index => index > level) : available.filter(index => index < level).at(-1);
                if (next !== undefined) commitLevel(next);
              }}
              onKeyUp={event => { if (!composer && ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commitLevel(Number(event.currentTarget.value)); }}/>
            <div className="model-menu-slider-lane" aria-hidden="true"><i/><b/></div>
          </div>
          <div className="model-menu-stops">{stops.map((stop, index) => <button type="button" key={stop} disabled={disabled || (composer && !supported(stop))} aria-pressed={index === level}
            onClick={() => commitLevel(index)}><span>{reasoningLabels[stop]}</span></button>)}</div>
        </div> : null}
      </>}
    </div>}
  </div>;
}
