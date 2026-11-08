import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { listConnectionModels, modelName, reasoningLabels, resolveReasoning, type Connection, type ReasoningChoice } from "../api";
import "./model-menu.css";

/** What an assistant uses: a provider, a model there ("" = the provider's default model) and its reasoning effort. */
export interface ModelChoice { connectionId: string; model: string; reasoning: ReasoningChoice | null }
const formatLabel = (connection: Connection) => connection.provider === "anthropic" ? "Anthropic" : "API";

/**
 * The chat model menu: the provider on top (switch it in a sub-list), that provider's enabled models, and the
 * 思考强度 slider when the chosen model offers reasoning levels. Every choice saves at once through `onChange`.
 */
export function ModelMenu({ connections, choice, onChange, disabled, label = "选择模型", open: controlledOpen, onOpenChange, anchorRef, triggerClassName, displayValue }: {
  connections: Connection[]; choice: ModelChoice; onChange: (choice: ModelChoice) => void; disabled?: boolean; label?: string;
  open?: boolean; onOpenChange?: (open: boolean) => void; anchorRef?: RefObject<HTMLElement | null>; triggerClassName?: string; displayValue?: string;
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
      .catch((error: unknown) => setCatalogs((all) => ({ ...all, [provider.id]: { error: error instanceof Error ? error.message : "获取模型失败" } })));
  }, [open, provider, catalogs]);

  useLayoutEffect(() => {
    const el = panel.current; if (!open || !el) return;
    el.showPopover();
    const position = () => {
      const anchor = (anchorRef?.current ?? trigger.current)?.getBoundingClientRect(); if (!anchor) return;
      el.style.width = `${Math.min(320, innerWidth - 24)}px`;
      const below = innerHeight - anchor.bottom - 12, above = anchor.top - 12, down = below >= Math.min(el.scrollHeight, 420) || below >= above;
      el.style.maxHeight = `${Math.max(120, down ? below : above)}px`;
      el.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - el.offsetWidth - 12))}px`;
      el.style.top = `${down ? anchor.bottom + 6 : Math.max(8, anchor.top - el.offsetHeight - 6)}px`;
    };
    position(); const observer = new ResizeObserver(position); observer.observe(el);
    window.addEventListener("resize", position);
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !el.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); document.removeEventListener("pointerdown", outside); if (el.isConnected) el.hidePopover(); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const effective = provider && provider.id === current?.id ? choice.model || provider.defaultModel : "";
  const models = useMemo(() => {
    if (!provider) return [];
    const listed = provider.models ?? catalogs[provider.id]?.models ?? [];
    const all = [...new Set([...listed, ...(provider.defaultModel ? [provider.defaultModel] : []), ...(effective ? [effective] : [])])];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((model) => terms.every((term) => model.toLowerCase().includes(term) || modelName(provider, model).toLowerCase().includes(term)));
  }, [provider, catalogs, effective, query]);

  // The slider follows the chosen model on the chosen provider.
  const chosenModel = current ? choice.model || current.defaultModel : "";
  const offered = current?.options[chosenModel]?.reasoning ?? [];
  const stops: ReasoningChoice[] = ["off", ...offered];
  const resolved = resolveReasoning(choice.reasoning, offered);
  const [level, setLevel] = useState(stops.indexOf(resolved));
  useEffect(() => { setLevel(stops.indexOf(resolved)); }, [resolved, offered.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const commitLevel = () => { const next = stops[level]; if (next && next !== resolved && current) onChange({ connectionId: current.id, model: choice.model, reasoning: next }); };

  const pick = (model: string) => {
    if (disabled || !provider) return;
    // Switching provider starts from that provider's own reasoning default; the same provider keeps the choice.
    onChange({ connectionId: provider.id, model, reasoning: provider.id === current?.id ? choice.reasoning : null });
    setOpen(false); (anchorRef?.current ?? trigger.current)?.focus();
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
        <button type="button" className="model-menu-provider" aria-label={`切换供应商，当前：${provider?.name}`} disabled={usable.length < 2} onClick={() => setPicking(true)}><span>{provider?.name}</span><span className="model-menu-tag">{provider ? formatLabel(provider) : ""}</span>{usable.length > 1 ? <ChevronRight size={15}/> : null}</button>
        <div className="model-menu-heading">模型</div>
        {models.length > 8 || query ? <label className="model-menu-search"><Search size={14}/><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus/></label> : null}
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
        {offered.length && provider?.id === current?.id ? <div className="model-menu-effort">
          <div className="model-menu-effort-label"><span>思考强度</span><strong>{reasoningLabels[stops[level] ?? "off"]}</strong></div>
          <input type="range" aria-label="思考强度" min={0} max={stops.length - 1} step={1} value={level} disabled={disabled}
            aria-valuetext={reasoningLabels[stops[level] ?? "off"]} style={{ ["--fill" as string]: `${stops.length > 1 ? (level / (stops.length - 1)) * 100 : 0}%` }}
            onChange={(event) => setLevel(Number(event.target.value))} onPointerUp={commitLevel} onKeyUp={commitLevel} onBlur={commitLevel}/>
          <div className="model-menu-stops" aria-hidden="true">{stops.map((stop) => <span key={stop}>{reasoningLabels[stop]}</span>)}</div>
        </div> : null}
      </>}
    </div>}
  </div>;
}
