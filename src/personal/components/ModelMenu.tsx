import { userErrorText } from "../../lib/http-errors";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { defaultReasoningLevels, listConnectionModels, modelName, reasoningLabels, resolveReasoning, type Connection, type ReasoningChoice } from "../api";
import { useAnchoredPopover } from "./anchored-popover";
import { EffortChoices } from "./EffortChoices";
import { useCompactComposer } from "./use-compact-composer";

/** What an assistant uses: a provider, a model there ("" = the provider's default model) and its reasoning effort. */
export interface ModelChoice { connectionId: string; model: string; reasoning: ReasoningChoice | null }
const formatLabel = (connection: Connection) => connection.provider === "anthropic" ? "Anthropic" : "API";

/**
 * The chat model menu: the provider on top (switch it in a sub-list), that provider's enabled models, and the
 * reasoning choices for the selected model.
 */
export function ModelMenu({ connections, choice, onChange, disabled, label = "选择模型", open: controlledOpen, onOpenChange, anchorRef, triggerClassName, displayValue, composer = false, selectionOnly = false }: {
  connections: Connection[]; choice: ModelChoice; onChange: (choice: ModelChoice) => void; disabled?: boolean; label?: string;
  open?: boolean; onOpenChange?: (open: boolean) => void; anchorRef?: RefObject<HTMLElement | null>; triggerClassName?: string; displayValue?: string; composer?: boolean; selectionOnly?: boolean;
}) {
  const compact = useCompactComposer();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen, setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value); };
  const usable = connections.filter((connection) => connection.enabled && connection.configured);
  const current = usable.find((connection) => connection.id === choice.connectionId) ?? usable.find((connection) => connection.isDefault) ?? usable[0];
  const [viewed, setViewed] = useState("");
  const [picking, setPicking] = useState(false), [query, setQuery] = useState("");
  const [catalogs, setCatalogs] = useState<Record<string, { models?: string[]; error?: string; loading?: boolean }>>({});
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const provider = usable.find((connection) => connection.id === viewed) ?? current;
  useEffect(() => { if (!open) { setViewed(""); setPicking(false); setQuery(""); } }, [open]);

  // A provider showing every model lists them from the service once per menu.
  useEffect(() => {
    if (!open || !provider || provider.models !== null || catalogs[provider.id]) return;
    setCatalogs((all) => ({ ...all, [provider.id]: { loading: true } }));
    listConnectionModels(provider.id)
      .then((result) => setCatalogs((all) => ({ ...all, [provider.id]: { models: result.models } })))
      .catch((error: unknown) => setCatalogs((all) => ({ ...all, [provider.id]: { error: userErrorText(error, "获取模型失败") } })));
  }, [open, provider, catalogs]);

  useAnchoredPopover(open, panel, () => anchorRef?.current ?? trigger.current, () => [root.current, anchorRef?.current], () => setOpen(false), 320, composer && !anchorRef ? "end" : "start", compact);

  const effective = provider && provider.id === current?.id ? choice.model || (selectionOnly ? "" : provider.defaultModel) : "";
  const models = useMemo(() => {
    if (!open || picking || !provider) return [];
    const listed = provider.models ?? catalogs[provider.id]?.models ?? [];
    const all = [...new Set([...listed, ...(provider.defaultModel && (!selectionOnly || provider.models === null) ? [provider.defaultModel] : []), ...(effective && (!selectionOnly || provider.models === null || listed.includes(effective)) ? [effective] : [])])];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return all;
    return all.filter((model) => {
      const id = model.toLowerCase(), name = modelName(provider, model).toLowerCase();
      return terms.every((term) => id.includes(term) || name.includes(term));
    });
  }, [open, picking, provider, catalogs, effective, query, selectionOnly]);

  const chosenModel = current ? choice.model || current.defaultModel : "";
  const offered = chosenModel ? defaultReasoningLevels : [];
  const resolved = resolveReasoning(choice.reasoning === "off" ? null : choice.reasoning, offered);
  const commitLevel = (next: ReasoningChoice) => {
    if (disabled || !current) return;
    if (next !== resolved) onChange({ connectionId: current.id, model: choice.model, reasoning: next });
  };

  const pick = (model: string) => {
    if (disabled || !provider) return;
    if (provider.id !== choice.connectionId || model !== choice.model) {
      onChange({ connectionId: provider.id, model, reasoning: provider.id === current?.id ? choice.reasoning : null });
    }
    if (!composer) { setOpen(false); (anchorRef?.current ?? trigger.current)?.focus(); }
  };

  return <div className="model-menu-root" ref={root}>
    {!anchorRef && <button ref={trigger} type="button" className={triggerClassName ?? "model-picker-trigger"} aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)} title={displayValue}><span>{displayValue || chosenModel || label}</span>{composer && offered.length > 0 && <small className="model-trigger-effort">{reasoningLabels[resolved]}</small>}<ChevronDown size={15}/></button>}
    {open && <div ref={panel} popover="manual" className="model-menu" role="dialog" aria-label={label} tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); (anchorRef?.current ?? trigger.current)?.focus(); } }}>
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
        {!selectionOnly && offered.length > 0 && provider?.id === current?.id &&
          <EffortChoices levels={offered} value={resolved === "off" ? undefined : resolved} label={(level) => reasoningLabels[level]} onChange={commitLevel} disabled={disabled}/>}
        {composer || models.length > 8 || query ? <label className="model-menu-search"><Search size={14}/><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus={!compact && !composer}/></label> : null}
        <div className="model-menu-list" role="listbox" aria-label="可用模型">
          {models.map((model) => {
            const options = provider?.options[model];
            return <button type="button" role="option" aria-selected={model === effective} key={model} className="model-menu-row" disabled={disabled} onClick={() => pick(model)} title={model}>
              <span className="model-menu-name">{modelName(provider, model)}</span>{options?.imageInput === true ? <span className="model-menu-tag">视觉</span> : null}{model === effective ? <Check size={15} className="model-menu-check"/> : null}
            </button>;
          })}
          {provider && catalogs[provider.id]?.loading ? <div className="model-menu-status" role="status">正在获取模型…</div> : null}
          {provider && catalogs[provider.id]?.error ? <div className="model-menu-status" role="alert">{catalogs[provider.id]?.error}</div> : null}
          {!models.length && !(provider && catalogs[provider.id]?.loading) ? <div className="model-menu-status">没有可用的模型</div> : null}
        </div>
      </>}
    </div>}
  </div>;
}
