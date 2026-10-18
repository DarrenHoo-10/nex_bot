import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronUp, Download, Paperclip, Plus, Search, Settings2, ShieldAlert, ShieldCheck } from "lucide-react";

type Props = {
  mode: string; disabled: boolean; uploading: boolean; canExport: boolean;
  onMode: (mode: string) => void; onFile: () => void; onModel: (model: string) => Promise<unknown>;
  model: string; defaultModel: string; loadModels: () => Promise<{ models: string[]; hasMore: boolean }>;
  onExport: () => void; children: ReactNode;
};

export function ComposerControls({ mode, disabled, uploading, canExport, onMode, onFile, onModel, onExport, children, model, defaultModel, loadModels }: Props) {
  const [menu, setMenu] = useState<"add" | "permissions" | "models" | null>(null);
  const [models, setModels] = useState<string[]>([]), [query, setQuery] = useState(""), [loading, setLoading] = useState(false), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const loader = useRef(loadModels); loader.current = loadModels;
  useEffect(() => {
    if (menu !== "models") return;
    let active = true;
    setLoading(true); setError(""); setModels([]); setQuery("");
    void loader.current().then((result) => { if (active) setModels(result.models); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "获取模型失败"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [menu, attempt]);
  const root = useRef<HTMLDivElement>(null), add = useRef<HTMLButtonElement>(null), permission = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null), id = useId();
  const full = mode === "full", ModeIcon = full ? ShieldAlert : ShieldCheck;
  const close = () => { (menu === "permissions" ? permission : add).current?.focus(); setMenu(null); };
  useLayoutEffect(() => {
    const panel = menuRef.current;
    if (!menu || !panel) return;
    panel.showPopover();
    const position = () => {
      const anchor = (menu === "permissions" ? permission.current : root.current?.closest("form"))?.getBoundingClientRect();
      if (!anchor) return;
      panel.style.width = `${Math.min(menu === "add" ? anchor.width : menu === "models" ? 360 : 216, window.innerWidth - 24)}px`;
      panel.style.maxHeight = `${Math.max(80, Math.min(360, anchor.top - 20))}px`;
      panel.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - panel.offsetWidth - 12))}px`;
      panel.style.top = `${Math.max(10, anchor.top - panel.offsetHeight - 10)}px`;
    };
    position(); window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); if (panel.isConnected) panel.hidePopover(); };
  }, [menu, models, loading, error, query]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener("pointerdown", outside);
    const frame = requestAnimationFrame(() => (menuRef.current?.querySelector<HTMLInputElement>("input") ?? menuRef.current?.querySelector<HTMLButtonElement>("[aria-checked=true]") ?? menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus());
    return () => { document.removeEventListener("pointerdown", outside); cancelAnimationFrame(frame); };
  }, [menu]);
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.target instanceof HTMLInputElement && event.key !== "ArrowDown") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return <div className="composer-toolbar" ref={root}>
    <div className="composer-actions">
      <button ref={add} type="button" className="composer-add" aria-label="添加文件或指令" aria-haspopup="menu" aria-expanded={menu === "add"} aria-controls={menu === "add" ? `${id}-add` : undefined} disabled={disabled || uploading} onClick={() => setMenu(menu === "add" ? null : "add")}><Plus size={20}/></button>
      <div className="composer-permission-control">
        <button ref={permission} type="button" className="permission-trigger" aria-label="操作权限" data-mode={mode} aria-haspopup="menu" aria-expanded={menu === "permissions"} aria-controls={menu === "permissions" ? `${id}-permissions` : undefined} disabled={disabled} onClick={() => setMenu(menu === "permissions" ? null : "permissions")}><ModeIcon size={16}/><span>{full ? "完全权限" : "标准权限"}</span><ChevronUp size={14} className="permission-chevron"/></button>
        {menu === "permissions" && <div ref={menuRef} id={`${id}-permissions`} className="composer-popover permission-popover" popover="manual" role="menu" aria-label="选择操作权限" onKeyDown={navigate}>
          {[{ value: "standard", label: "标准权限", Icon: ShieldCheck }, { value: "full", label: "完全权限", Icon: ShieldAlert }].map(({ value, label, Icon }) => <button type="button" key={value} role="menuitemradio" aria-checked={mode === value} disabled={disabled} onClick={() => { close(); if (mode !== value) onMode(value); }}><Icon size={18}/><span>{label}</span>{mode === value && <Check size={17} className="menu-check"/>}</button>)}
        </div>}
      </div>
    </div>
    {menu === "add" && <div ref={menuRef} id={`${id}-add`} className="composer-popover composer-command-menu" popover="manual" role="menu" aria-label="添加与指令" onKeyDown={navigate}>
      <div className="composer-menu-heading" role="presentation">添加</div>
      <button type="button" role="menuitem" disabled={disabled || uploading} onClick={() => { close(); onFile(); }}><Paperclip size={18}/><span>文件</span><small>file</small></button>
      <div className="composer-menu-heading" role="presentation">指令</div>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => setMenu("permissions")}><ModeIcon size={18}/><span>权限</span><small>permission</small><span className="menu-value">{full ? "完全权限" : "标准权限"}</span></button>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => setMenu("models")}><Settings2 size={18}/><span>模型</span><small>model</small><span className="menu-value">{model || defaultModel}</span></button>
      <button type="button" role="menuitem" disabled={disabled || !canExport} onClick={() => { close(); onExport(); }}><Download size={18}/><span>导出对话</span><small>export</small><span className="menu-value">Markdown</span></button>
    </div>}
    {menu === "models" && <div ref={menuRef} className="composer-popover composer-model-menu" popover="manual" role="dialog" aria-label="选择模型" onKeyDown={navigate}>
      <label className="composer-model-search"><Search size={16}/><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)}/></label>
      <div role="menu" aria-label="可用模型">
        {!query && defaultModel && <button type="button" role="menuitemradio" aria-checked={!model} disabled={disabled} onClick={() => { close(); void onModel(""); }}><span>默认模型<small>{defaultModel}</small></span>{!model && <Check size={17}/>}</button>}
        {[...new Set([model, ...models].filter(Boolean))].filter((value) => value.toLowerCase().includes(query.toLowerCase())).map((value) => <button type="button" key={value} role="menuitemradio" aria-checked={model === value} disabled={disabled} onClick={() => { close(); if (model !== value) void onModel(value); }}><span>{value}</span>{model === value && <Check size={17}/>}</button>)}
      </div>
      {loading && <div className="composer-model-status" role="status">正在获取模型…</div>}
      {error && <div className="composer-model-status" role="alert">{error}<button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>}
      {!loading && !error && !models.some((value) => value.toLowerCase().includes(query.toLowerCase())) && <div className="composer-model-status">{query ? "没有匹配的模型" : "暂无可用模型"}</div>}
    </div>}
    {children}
  </div>;
}
