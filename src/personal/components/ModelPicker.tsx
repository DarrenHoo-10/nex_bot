import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Square } from 'lucide-react';
import './model-picker.css';

type Catalog = { models: string[]; hasMore: boolean };
export function ModelList({ models, value, selected, onSelect, emptyLabel, allowCustom = false, autoFocus = false }: {
  models: string[]; value?: string; selected?: Set<string>; onSelect: (id: string) => void;
  emptyLabel?: string; allowCustom?: boolean; autoFocus?: boolean;
}) {
  const [query, setQuery] = useState(''), [active, setActive] = useState(0), [top, setTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null), id = useId();
  const rows = useMemo(() => {
    const all = [...new Set([...(emptyLabel ? [''] : []), ...models])];
    const terms = query.trim().toLowerCase().split(/\s+/);
    return all.filter(model => terms.every(term => (model || emptyLabel || '').toLowerCase().includes(term)));
  }, [models, query, emptyLabel]);
  const custom = allowCustom && query.trim().length > 0 && query.trim().length <= 200 && !rows.includes(query.trim());
  const count = rows.length + Number(custom), height = Math.min(264, Math.max(44, count * 44));
  const start = Math.max(0, Math.floor(top / 44) - 3), end = Math.min(count, start + Math.ceil(height / 44) + 7);
  const move = (next: number) => {
    next = Math.max(0, Math.min(count - 1, next)); setActive(next);
    const el = viewport.current;
    if (el && next * 44 < el.scrollTop) el.scrollTop = next * 44;
    else if (el && (next + 1) * 44 > el.scrollTop + height) el.scrollTop = (next + 1) * 44 - height;
  };
  useEffect(() => { setActive(0); setTop(0); if (viewport.current) viewport.current.scrollTop = 0; }, [query]);
  useEffect(() => { setActive(index => Math.min(index, Math.max(0, count - 1))); }, [count]);
  return <div className="model-list">
    <label className="model-search"><Search size={16}/><input autoFocus={autoFocus} role="combobox" aria-label="搜索模型" aria-expanded="true" aria-autocomplete="list" aria-controls={id} aria-activedescendant={count && active >= start && active < end ? `${id}-${active}` : undefined} placeholder="搜索模型名称…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => {
      if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Enter' && count) onSelect(rows[active] ?? query.trim());
        else if (e.key !== 'Enter') move(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); move(count - 1); }
      else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); move(0); }
    }}/></label>
    <div className="model-list-count">{rows.length} 个模型{selected && ` · 已选 ${selected.size}`}</div>
    <div ref={viewport} className="model-list-viewport" style={{ height }} onScroll={e => setTop(e.currentTarget.scrollTop)} role="listbox" id={id} aria-label="可用模型" aria-multiselectable={selected ? true : undefined}>
      <div style={{ height: count * 44, position: 'relative' }}>
        {Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
          const index = start + offset, model = rows[index] ?? query.trim(), isCustom = index >= rows.length;
          const checked = selected ? selected.has(model) : model === value;
          return <div key={model} id={`${id}-${index}`} role="option" aria-selected={checked} aria-posinset={index + 1} aria-setsize={count} className="model-option" data-active={index === active} style={{ position: 'absolute', top: index * 44, height: 44 }} title={model || emptyLabel} onMouseDown={e => e.preventDefault()} onClick={() => onSelect(model)}>
            {selected && (checked ? <Check size={17}/> : <Square size={17}/>)}<span>{isCustom ? `使用「${model}」` : model || emptyLabel}</span>{!selected && checked && <Check size={16}/>}
          </div>;
        })}
      </div>
      {!count && <div className="model-list-empty">没有匹配的模型</div>}
    </div>
  </div>;
}

export function ModelPicker({ value, onChange, models, loadModels, label = '选择模型', emptyLabel, name, disabled, open: controlledOpen, onOpenChange }: {
  value: string; onChange: (model: string) => void; models?: string[] | null; loadModels?: () => Promise<Catalog>;
  label?: string; emptyLabel?: string; name?: string; disabled?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false), [catalog, setCatalog] = useState<Catalog>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const open = controlledOpen ?? localOpen, setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value); };
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), loader = useRef(loadModels), generation = useRef(0);
  loader.current = loadModels;
  useEffect(() => () => { generation.current++; }, []);
  const load = async () => {
    if (!loader.current || loading) return;
    const request = ++generation.current; setLoading(true); setError('');
    try { const result = await loader.current(); if (request === generation.current) setCatalog(result); }
    catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : '获取模型失败'); }
    finally { if (request === generation.current) setLoading(false); }
  };
  useEffect(() => { if (open && models == null && !catalog && !loading && !error) void load(); }, [open, models, catalog, loading, error]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = panel.current; if (!open || !el) return;
    el.showPopover();
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect(); if (!anchor) return;
      el.style.width = `${Math.min(Math.max(anchor.width, 340), innerWidth - 24)}px`;
      const below = innerHeight - anchor.bottom - 12, above = anchor.top - 12;
      const down = below >= Math.min(el.scrollHeight, 390) || below >= above;
      el.style.maxHeight = `${Math.max(80, down ? below : above)}px`;
      el.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - el.offsetWidth - 12))}px`;
      el.style.top = `${down ? anchor.bottom + 6 : Math.max(8, anchor.top - el.offsetHeight - 6)}px`;
    };
    const scroll = (e: Event) => { if (!el.contains(e.target as Node)) position(); };
    position(); const observer = new ResizeObserver(position); observer.observe(el);
    window.addEventListener('resize', position); document.addEventListener('scroll', scroll, true);
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    el.querySelector('input')?.focus();
    return () => { observer.disconnect(); window.removeEventListener('resize', position); document.removeEventListener('scroll', scroll, true); document.removeEventListener('pointerdown', outside); if (el.isConnected) el.hidePopover(); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const options = useMemo(() => [...new Set([...(value ? [value] : []), ...(models ?? catalog?.models ?? [])])], [value, models, catalog]);
  return <div className="model-picker" ref={root}>
    {name && <input type="hidden" name={name} value={value}/>}
    <button ref={trigger} type="button" className="model-picker-trigger" title={value || emptyLabel} aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}><span>{value || emptyLabel || label}</span><ChevronDown size={15}/></button>
    {open && <div ref={panel} popover="manual" className="model-picker-popover" role="dialog" aria-label={label} onKeyDown={e => { if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <ModelList models={options} value={value} emptyLabel={emptyLabel} allowCustom onSelect={model => { if (disabled) return; onChange(model); setOpen(false); trigger.current?.focus(); }}/>
      {loading && <div className="model-picker-status" role="status">正在获取模型…</div>}
      {error && <div className="model-picker-status" role="alert">{error}</div>}
      {models == null && catalog?.hasMore && <div className="model-picker-status">服务仍有未返回的模型，可输入完整 ID。</div>}
      {loadModels && models == null && <button className="model-refresh" type="button" disabled={loading} onClick={() => void load()}>{error ? '重试' : '刷新列表'}</button>}
    </div>}
  </div>;
}
