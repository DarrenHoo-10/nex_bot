import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Box, Check, Eye, EyeOff, MoreHorizontal, Pencil, Plus, Search, Star } from "lucide-react";
import { api, listConnectionModels, modelName, reasoningLabels, reasoningOrder, type Connection, type ReasoningLevel, type State } from "./api";
import { useModelSelection } from "./useModelSelection";
import "./components/model-picker.css";
import "./provider-settings.css";

const formats = [{ value: "openai", label: "OpenAI 兼容 (/chat/completions)" }, { value: "anthropic", label: "Anthropic Messages (/v1/messages)" }];
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败";

/**
 * 设置 → 模型: providers ("供应商") on the left, the chosen one on the right with its address, key, default model and
 * models. Each model has 启用, image input, context limits and the reasoning levels the chat menu offers for it.
 */
export function ProviderSettings({ state, refresh, active }: { state: State; refresh: () => Promise<void>; active: boolean }) {
  const connections = state.connections ?? [];
  const [selected, setSelected] = useState<string>(connections[0]?.id ?? "new");
  const connection = connections.find((item) => item.id === selected);
  useEffect(() => { if (selected !== "new" && !connection) setSelected(connections[0]?.id ?? "new"); }, [selected, connection, connections]);
  return <section className="preferences-section provider-settings" data-provider-settings>
    <div className="provider-layout">
      <nav className="provider-list" aria-label="供应商">
        {connections.map((item) => <button type="button" key={item.id} aria-current={item.id === selected ? "true" : undefined} onClick={() => setSelected(item.id)}>
          <Box size={16} aria-hidden="true"/><span className="provider-list-name">{item.name}</span>{item.isDefault ? <small>默认</small> : null}
          <span className={`provider-dot ${item.enabled && item.configured ? "on" : "off"}`} aria-label={item.enabled ? item.configured ? "已启用" : "未配置 Key" : "已停用"}/>
        </button>)}
        <button type="button" className="provider-add" aria-current={selected === "new" ? "true" : undefined} onClick={() => setSelected("new")}><Plus size={16}/>添加供应商</button>
      </nav>
      <div className="provider-detail">
        {connection ? <ProviderDetail key={connection.id} connection={connection} refresh={refresh} active={active}/>
          : <ProviderForm key="new" refresh={refresh} onCreated={(id) => setSelected(id)}/>}
      </div>
    </div>
  </section>;
}

/** Name, API format, base URL and key; for a saved provider also 启用 and its menu (设为默认, 删除). */
function ProviderForm({ connection, refresh, onCreated }: { connection?: Connection; refresh: () => Promise<void>; onCreated?: (id: string) => void }) {
  const [name, setName] = useState(connection?.name ?? ""), [provider, setProvider] = useState(connection?.provider ?? "openai");
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? ""), [apiKey, setApiKey] = useState(""), [showKey, setShowKey] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false), [menu, setMenu] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  const changed = !connection || name !== connection.name || provider !== connection.provider || endpoint.replace(/\/+$/, "") !== connection.endpoint || !!apiKey.trim();
  const act = async (fn: () => Promise<unknown>) => {
    setPending(true); setError(""); setSaved(false);
    try { await fn(); await refresh(); return true; } catch (failure) { setError(errorText(failure)); return false; } finally { setPending(false); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const result = await api<{ id: string }>("connections/save", { ...(connection ? { id: connection.id, version: connection.version, enabled: connection.enabled } : {}), name, provider, endpoint, ...(apiKey.trim() ? { apiKey } : {}) });
      setApiKey(""); setShowKey(false); setSaved(true);
      if (!connection) onCreated?.(result.id);
    });
  };
  const toggle = (enabled: boolean) => connection && void act(() => api("connections/save", { id: connection.id, version: connection.version, name: connection.name, provider: connection.provider, endpoint: connection.endpoint, enabled }));
  return <form className="provider-form" onSubmit={save}>
    <div className="provider-heading">
      <Box size={20} aria-hidden="true"/>
      <h3>{connection ? connection.name : "添加供应商"}</h3>
      {connection ? <>
        <label className="provider-switch" title={connection.isDefault ? "默认供应商不能停用" : undefined}><input type="checkbox" role="switch" aria-label="启用供应商" checked={connection.enabled} disabled={pending || connection.isDefault} onChange={(event) => toggle(event.target.checked)}/><span aria-hidden="true"/></label>
        <div className="provider-menu" ref={menuRoot}>
          <button type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={18}/></button>
          {menu ? <div role="menu" className="provider-menu-list">
            <button type="button" role="menuitem" disabled={pending || connection.isDefault} onClick={() => { setMenu(false); void act(() => api("connections/default", { id: connection.id })); }}>{connection.isDefault ? "已是默认供应商" : "设为默认供应商"}</button>
            <button type="button" role="menuitem" className="danger-link" disabled={pending || connection.isDefault} onClick={() => { setMenu(false); if (window.confirm(`删除供应商「${connection.name}」？它的 API Key 会被清除，正在用它的助手会改用默认供应商。`)) void act(() => api("connections/remove", { id: connection.id, version: connection.version })); }}>删除供应商</button>
          </div> : null}
        </div>
      </> : null}
    </div>
    <fieldset disabled={pending}>
      <label className="field">名称<input required maxLength={60} value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} placeholder="例如：公司 API"/></label>
      <label className="field">Base URL<input required type="url" spellCheck={false} value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setSaved(false); }} placeholder="https://api.example.com/v1"/></label>
      <label className="field">API 格式<select value={provider} onChange={(event) => { setProvider(event.target.value); setSaved(false); }}>{formats.map((format) => <option key={format.value} value={format.value}>{format.label}</option>)}</select></label>
      <div className="field"><label htmlFor={`key-${connection?.id ?? "new"}`}>API Key</label><div className="preferences-secret-input">
        <input id={`key-${connection?.id ?? "new"}`} type={showKey ? "text" : "password"} autoComplete="off" spellCheck={false} required={!connection?.configured} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setSaved(false); }} placeholder={connection?.configured ? "留空保留已保存的 Key" : "输入 API Key"}/>
        <button type="button" aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16}/> : <Eye size={16}/>}</button>
      </div></div>
      <div className="preferences-actions"><button className="primary" type="submit" disabled={!changed}>{pending ? "保存中…" : connection ? "保存" : "添加"}</button>{saved ? <span className="preferences-saved" role="status"><Check size={15}/>已保存</span> : null}</div>
      {error ? <p role="alert" className="model-error">{error}</p> : null}
    </fieldset>
  </form>;
}

function ProviderDetail({ connection, refresh, active }: { connection: Connection; refresh: () => Promise<void>; active: boolean }) {
  return <>
    <ProviderForm connection={connection} refresh={refresh}/>
    {connection.configured ? <ProviderModels connection={connection} refresh={refresh} active={active}/> : null}
  </>;
}

/** The provider's models: 启用 toggles (全选 / 全不选), the default model, and per-model settings. */
function ProviderModels({ connection, refresh, active }: { connection: Connection; refresh: () => Promise<void>; active: boolean }) {
  const [fetchedNames, setFetchedNames] = useState<Record<string, string>>({});
  const [fetched, setFetched] = useState<string[]>([]), [loading, setLoading] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [custom, setCustom] = useState(""), [adding, setAdding] = useState(false), [editing, setEditing] = useState(""), [defaultError, setDefaultError] = useState("");
  const loaded = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const autosave = useModelSelection("models/visibility", { connectionId: connection.id }, { models: connection.models, version: connection.modelsVersion }, refresh);
  const load = async () => {
    setLoading(true); setError("");
    try { const result = await listConnectionModels(connection.id); if (alive.current) { setFetched(result.models); setFetchedNames(result.names ?? {}); setNotice(result.hasMore ? "服务仍有未返回的模型，可手动添加。" : ""); } }
    catch (failure) { if (alive.current) setError(errorText(failure)); }
    finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => { if (active && !loaded.current) { loaded.current = true; void load(); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const selection = autosave.selection;
  const all = useMemo(() => [...new Set([...fetched, ...(selection ?? []), ...(connection.defaultModel ? [connection.defaultModel] : []), ...Object.keys(connection.options)])].sort(), [fetched, selection, connection.defaultModel, connection.options]);
  const enabled = useMemo(() => new Set(selection ?? all), [selection, all]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // A freshly fetched list's names win over the stored ones until the state catches up.
  const nameOf = (model: string) => fetchedNames[model] || modelName(connection, model);
  const rows = all.filter((model) => terms.every((term) => model.toLowerCase().includes(term) || nameOf(model).toLowerCase().includes(term)));
  const bulk = (checked: boolean) => {
    const next = new Set(enabled);
    for (const model of rows) if (checked) next.add(model); else next.delete(model);
    autosave.replace(checked && !terms.length ? null : [...next].sort());
  };
  const setDefault = async (model: string) => {
    setDefaultError("");
    try { await api("connections/save", { id: connection.id, version: connection.version, name: connection.name, provider: connection.provider, endpoint: connection.endpoint, enabled: connection.enabled, defaultModel: model }); await refresh(); }
    catch (failure) { setDefaultError(errorText(failure)); }
  };
  const addCustom = (event: FormEvent) => {
    event.preventDefault();
    const model = custom.trim(); if (!model || model.length > 200) return;
    if (!enabled.has(model)) autosave.replace([...new Set([...(selection ?? all), model])].sort());
    setCustom(""); setAdding(false);
  };
  return <div className="provider-models">
    <div className="provider-models-heading">
      <h4>模型列表</h4>
      <div className="provider-models-actions">
        <button type="button" disabled={loading} onClick={() => void load()}>{loading ? "获取中…" : "获取模型"}</button>
        <button type="button" onClick={() => setAdding(!adding)}><Plus size={14}/>添加模型</button>
      </div>
    </div>
    {adding ? <form className="provider-model-add" onSubmit={addCustom}><input autoFocus aria-label="模型 ID" placeholder="输入模型 ID" maxLength={200} value={custom} onChange={(event) => setCustom(event.target.value)}/><button type="submit" disabled={!custom.trim()}>添加</button></form> : null}
    {error ? <p role="alert" className="model-error">{error} <button type="button" onClick={() => void load()}>重试获取</button></p> : null}
    {notice ? <p className="preferences-status">{notice}</p> : null}
    {autosave.error || defaultError ? <p role="alert" className="model-error">{autosave.error || defaultError}</p> : null}
    <div className="provider-models-bar">
      <span>{all.length} 个模型 · 已启用 {enabled.size}{autosave.busy ? " · 保存中…" : ""}</span>
      {all.length > 12 || query ? <label className="provider-models-search"><Search size={13}/><input aria-label="搜索模型" placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)}/></label> : null}
      <span className="model-list-bulk">
        <button type="button" disabled={!rows.length || rows.every((model) => enabled.has(model))} onClick={() => bulk(true)}>全选</button>
        <button type="button" disabled={!rows.some((model) => enabled.has(model))} onClick={() => bulk(false)}>全不选</button>
      </span>
    </div>
    <ul className="provider-model-rows" aria-label="模型">
      {rows.map((model) => {
        const options = connection.options[model], on = enabled.has(model), isDefault = model === connection.defaultModel;
        const levels = options?.reasoning ?? [];
        return <li key={model} className={on ? "" : "off"}>
          <div className="provider-model-row">
            <span className="provider-model-label"><span className="provider-model-name" title={model}>{nameOf(model)}</span>{nameOf(model) !== model ? <small className="provider-model-id" title={model}>{model}</small> : null}</span>
            {isDefault ? <span className="provider-tag accent">默认</span> : null}
            {options?.imageInput ? <span className="provider-tag">视觉</span> : null}
            {levels.length ? <span className="provider-tag" title={levels.map((level) => reasoningLabels[level]).join("、")}>推理 {reasoningLabels[levels[0]]}{levels.length > 1 ? `–${reasoningLabels[levels[levels.length - 1]]}` : ""}</span> : null}
            <span className="provider-model-tools">
              {!isDefault ? <button type="button" aria-label={`设为默认模型：${model}`} title="设为默认模型" onClick={() => void setDefault(model)}><Star size={15}/></button> : null}
              <button type="button" aria-label={`编辑 ${model}`} aria-expanded={editing === model} title="编辑" onClick={() => setEditing(editing === model ? "" : model)}><Pencil size={15}/></button>
              <label className="provider-switch small"><input type="checkbox" role="switch" aria-label={`启用 ${model}`} checked={on} onChange={() => autosave.toggle(model, all)}/><span aria-hidden="true"/></label>
            </span>
          </div>
          {editing === model ? <ModelEditor connection={connection} model={model} refresh={refresh} close={() => setEditing("")}/> : null}
        </li>;
      })}
      {!rows.length ? <li className="provider-model-empty">{loading ? "正在获取模型…" : "没有模型，可点「获取模型」或手动添加"}</li> : null}
    </ul>
  </div>;
}

/** One model's settings: context window, output ceiling, image input and the reasoning levels it offers. */
function ModelEditor({ connection, model, refresh, close }: { connection: Connection; model: string; refresh: () => Promise<void>; close: () => void }) {
  const stored = connection.options[model];
  const [limits, setLimits] = useState<{ contextWindow: number; maxOutputTokens: number; manual: { contextWindow: number | null; maxOutputTokens: number | null }; automatic: { contextWindow: number; maxOutputTokens: number }; capabilities: { reasoning: boolean; imageInput: boolean } | null }>();
  const [contextWindow, setContextWindow] = useState(""), [maxOutput, setMaxOutput] = useState("");
  const [imageInput, setImageInput] = useState<boolean>(stored?.imageInput ?? false);
  const [levels, setLevels] = useState<ReasoningLevel[]>(stored?.reasoning ?? []);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    api<NonNullable<typeof limits>>("models/limits", { provider: connection.provider, endpoint: connection.endpoint, model }).then((result) => {
      if (!current) return;
      setLimits(result);
      setContextWindow(result.manual.contextWindow == null ? "" : String(result.manual.contextWindow));
      setMaxOutput(result.manual.maxOutputTokens == null ? "" : String(result.manual.maxOutputTokens));
      // A model never configured starts from what the catalog says it can do.
      if (!stored && result.capabilities) { setImageInput(result.capabilities.imageInput); if (result.capabilities.reasoning) setLevels(["low", "medium", "high"]); }
    }).catch((failure: unknown) => { if (current) setError(errorText(failure)); });
    return () => { current = false; };
  }, [connection.provider, connection.endpoint, model]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (event: FormEvent) => {
    event.preventDefault(); setPending(true); setError("");
    try {
      await api("connections/model", { connectionId: connection.id, model, version: stored?.version ?? 0, imageInput, reasoning: levels, contextWindow: contextWindow.trim() || null, maxOutputTokens: maxOutput.trim() || null });
      await refresh(); close();
    } catch (failure) { setError(errorText(failure)); } finally { setPending(false); }
  };
  return <form className="provider-model-editor" onSubmit={(event) => void save(event)}>
    <fieldset disabled={pending}>
      <div className="provider-model-limits">
        <label>上下文窗口<input inputMode="numeric" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder={limits ? `自动 · ${limits.automatic.contextWindow.toLocaleString()}` : "自动"}/></label>
        <label>最大输出<input inputMode="numeric" value={maxOutput} onChange={(event) => setMaxOutput(event.target.value)} placeholder={limits ? `自动 · ${limits.automatic.maxOutputTokens.toLocaleString()}` : "自动"}/></label>
      </div>
      <div className="provider-model-checks">
        <label><input type="checkbox" checked={imageInput} onChange={(event) => setImageInput(event.target.checked)}/>支持图片输入</label>
        <span className="provider-model-checks-label">推理档位</span>
        {reasoningOrder.map((level) => <label key={level}><input type="checkbox" checked={levels.includes(level)} onChange={(event) => setLevels(event.target.checked ? reasoningOrder.filter((item) => item === level || levels.includes(item)) : levels.filter((item) => item !== level))}/>{reasoningLabels[level]}</label>)}
      </div>
      {error ? <p role="alert" className="model-error">{error}</p> : null}
      <div className="provider-model-editor-actions"><button type="button" onClick={close}>取消</button><button type="submit" className="primary">{pending ? "保存中…" : "保存"}</button></div>
    </fieldset>
  </form>;
}
