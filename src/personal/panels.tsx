import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AccountControls, useAccount } from "./auth";
import { Check, Cpu, Eye, EyeOff, KeyRound, Laptop, Plug, Sparkles, UserRound, X } from "lucide-react";
import { api, desktop, listModels, str, type State, type LocalDeviceState } from "./api";
import { ConnectorsPage } from "./ConnectorsPage";
import { ModelLimitsFields } from "./ModelLimitsFields";
interface Field { name: string; label: string; value?: string; required?: boolean; multiline?: boolean; hint?: string; choices?: Array<{ value: string; label: string }> }
export function Editor({ title, fields, onClose, onSubmit }: { title: string; fields: Field[]; onClose: () => void; onSubmit: (data: Record<string, string>) => Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  return <><div className="modal-heading"><h2>{title}</h2><button onClick={onClose} aria-label="关闭"><X size={18}/></button></div><form onSubmit={(e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; setPending(true); void onSubmit(data).finally(() => setPending(false)); }}>{fields.map((field, index) => <label className="field" key={field.name}>{field.label}{field.choices ? <select name={field.name} defaultValue={field.value}>{field.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : field.multiline ? <textarea name={field.name} required={field.required} defaultValue={field.value} rows={6}/> : <input autoFocus={index === 0} name={field.name} required={field.required} defaultValue={field.value}/>} {field.hint ? <small>{field.hint}</small> : null}</label>)}<div className="actions"><button className="primary" disabled={pending}>保存</button><button type="button" onClick={onClose}>取消</button></div></form></>;
}
export function Confirm({ title, detail, onClose, onConfirm }: { title: string; detail: string; onClose: () => void; onConfirm: () => Promise<unknown> }) {
  return <><h2>{title}</h2><p>{detail}</p><div className="actions"><button className="danger" onClick={() => void onConfirm()}>确认</button><button autoFocus onClick={onClose}>取消</button></div></>;
}
export type SettingsCategory = "account" | "model" | "memory" | "connectors" | "devices";
export function SettingsPage({ state, run, category, onCategory, refresh, setDialog, closeDialog }: { state: State; run: (fn: () => Promise<unknown>) => Promise<void>; category: SettingsCategory; onCategory: (category: SettingsCategory) => void; refresh: () => Promise<void>; setDialog: (node: ReactNode) => void; closeDialog: () => void }) {
  const sectionId = useId();
  const categories: Array<{ id: SettingsCategory; label: string; icon: typeof UserRound }> = [
    { id: "account", label: "账号与登录设备", icon: UserRound },
    { id: "model", label: "模型", icon: KeyRound },
    { id: "memory", label: "记忆服务", icon: Sparkles },
    { id: "connectors", label: "连接器", icon: Plug },
    { id: "devices", label: "设备", icon: Cpu },
  ];
  return <div className="preferences-page">
    <div className="preferences-heading"><h1>设置</h1></div>
    <div className="preferences-layout">
      <nav className="preferences-nav" aria-label="设置分类">{categories.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={category === id ? "page" : undefined} aria-controls={`${sectionId}-${id}`} onClick={() => onCategory(id)}><Icon size={17}/><span>{label}</span></button>)}</nav>
      <div className="preferences-content">
        <section id={`${sectionId}-account`} hidden={category !== "account"} aria-label="账号与登录设备" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>账号与登录设备</h2></div>
          <AccountControls/>
          <ClientSessions cursor={state.sync.cursor} run={run}/>
        </section>
        <section id={`${sectionId}-model`} hidden={category !== "model"} aria-label="模型" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>模型</h2></div>
          <ModelSettings state={state} run={run} active={category === "model"}/>
        </section>
        <section id={`${sectionId}-memory`} hidden={category !== "memory"} aria-label="记忆服务" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>记忆服务</h2></div>
          <MemoryPluginSettings state={state} run={run}/>
        </section>
        <section id={`${sectionId}-connectors`} hidden={category !== "connectors"} aria-label="连接器" className="preferences-panel">
          <ConnectorsPage state={state} refresh={refresh}/>
        </section>
        <section id={`${sectionId}-devices`} hidden={category !== "devices"} aria-label="设备" className="preferences-panel">
          <Devices state={state} run={run} setDialog={setDialog} closeDialog={closeDialog}/>
        </section>
      </div>
    </div>
  </div>;
}
function ModelSettings({ state, run, active }: { state: State; run: (fn: () => Promise<unknown>) => Promise<void>; active: boolean }) {
  const [provider, setProvider] = useState(str(state.config?.provider_id) || "openai");
  const [endpoint, setEndpoint] = useState(str(state.config?.endpoint) || "https://api.openai.com/v1");
  const [saved, setSaved] = useState(false), [pending, setPending] = useState(false);
  const [model, setModel] = useState(str(state.config?.default_model));
  const [models, setModels] = useState<string[]>([]), [loadingModels, setLoadingModels] = useState(false);
  const [modelNotice, setModelNotice] = useState(""), [modelError, setModelError] = useState("");
  const [manual, setManual] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [limitsReady, setLimitsReady] = useState("");
  const limitScope = JSON.stringify([provider, endpoint, model]);
  const modelId = useId(), keyId = useId(), modelForm = useRef<HTMLFormElement>(null);
  useEffect(() => { if (!active) setShowKey(false); }, [active]);
  const clearEnteredKey = () => { const key = modelForm.current?.elements.namedItem("apiKey") as HTMLInputElement | null; if (key) key.value = ""; setShowKey(false); };
  const resetModels = () => { setModels([]); setModelNotice(""); setModelError(""); setSaved(false); };
  const loadModels = async () => {
    const apiKey = (modelForm.current?.elements.namedItem("apiKey") as HTMLInputElement)?.value ?? "";
    setLoadingModels(true); setModelError(""); setModelNotice("");
    try {
      const result = await listModels({ provider, endpoint, apiKey });
      setModels(result.models); setManual(false);
      if (!model && result.models.length) setModel(result.models[0]);
      setModelNotice(result.models.length ? `已获取 ${result.models.length} 个模型${result.hasMore ? "（服务仅返回部分结果，可手动填写其他模型）" : ""}` : "服务未返回可用模型，可手动填写模型 ID");
    } catch (error) { setModelError((error instanceof Error ? error.message : "获取模型列表失败").replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { setLoadingModels(false); }
  };
  return <section className="preferences-section" data-model-settings>
    <div className="preferences-section-heading"><h3>模型连接</h3><span className="preferences-status">{state.config ? "已配置" : "待配置"}</span></div>
    <form ref={modelForm} onSubmit={(event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); setPending(true); setSaved(false); setShowKey(false); setModelError(""); void run(async () => { await api("config", data); setSaved(true); }).finally(() => setPending(false)); }}>
      <fieldset disabled={pending || loadingModels}>
          <label className="field">API 协议<select name="provider" value={provider} onChange={(event) => { const next = event.target.value; if (["https://api.openai.com/v1", "https://api.anthropic.com"].includes(endpoint)) setEndpoint(next === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com"); setProvider(next); clearEnteredKey(); resetModels(); }}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label>
        <label className="field">API 基础地址<input name="endpoint" type="url" required value={endpoint} spellCheck={false} onChange={(event) => { setEndpoint(event.target.value); clearEnteredKey(); resetModels(); }}/></label>
        <div className="field"><label htmlFor={keyId}>API Key</label><div className="preferences-secret-input"><input id={keyId} name="apiKey" type={showKey ? "text" : "password"} autoComplete="off" spellCheck={false} required={!state.config} placeholder={state.config ? "留空保留已保存的 Key" : "输入 API Key"} onChange={resetModels}/><button type="button" aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></div>
        <div className="field"><label htmlFor={modelId}>模型</label><div className="preferences-model-controls">
          {models.length && !manual ? <select id={modelId} name="model" required value={model} onChange={(event) => { setModel(event.target.value); setSaved(false); }}>{model && !models.includes(model) && <option value={model}>{model}（当前配置）</option>}{models.map((id) => <option key={id} value={id}>{id}</option>)}</select> : <input id={modelId} name="model" required value={model} placeholder="选择或填写模型 ID" onChange={(event) => { setModel(event.target.value); setSaved(false); }}/>}
          <button type="button" disabled={!endpoint} onClick={() => void loadModels()}>{loadingModels ? "获取中…" : "获取模型列表"}</button>
        </div>{models.length > 0 && <button className="text-button model-entry-toggle" type="button" onClick={() => setManual(value => !value)}>{manual ? "从列表选择" : "手动填写"}</button>}
        {modelNotice && <small role="status">{modelNotice}</small>}{modelError && <small className="model-error" role="alert">{modelError}</small>}</div>
        <ModelLimitsFields key={limitScope} scopeKey={limitScope} provider={provider} endpoint={endpoint} model={model} active={active} onReady={setLimitsReady} onEdit={() => setSaved(false)}/>
        <div className="preferences-actions"><button className="primary" type="submit" disabled={limitsReady !== limitScope}>{pending ? "保存中…" : "保存配置"}</button>{saved && <span className="preferences-saved" role="status"><Check size={15}/>已保存</span>}</div>
      </fieldset>
    </form>
  </section>;
}
function MemoryPluginSettings({ state, run }: { state: State; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const plugin = state.memoryPlugin;
  const [enabled, setEnabled] = useState(plugin?.enabled ?? false), [endpoint, setEndpoint] = useState(plugin?.endpoint ?? ""), [token, setToken] = useState("");
  const [feedback, setFeedback] = useState(""), [pending, setPending] = useState(false);
  const labels: Record<string, string> = { disabled: "未启用", connecting: "连接中", ready: "已连接", unavailable: "连接异常" };
  const data = { provider: "hindsight", enabled, endpoint, token };
  const perform = (action: () => Promise<void>) => { setPending(true); setFeedback(""); void run(action).finally(() => setPending(false)); };
  if (!plugin) return <p className="preferences-description">当前后端未提供记忆服务配置。</p>;
  return <section className="preferences-section" data-memory-plugin>
    <div className="preferences-section-heading"><h3>Hindsight</h3><span role="status" className={`preferences-status ${plugin.status === "unavailable" ? "is-warning" : ""}`}>{labels[plugin.status] ?? "状态未知"}</span></div>
    {plugin.status === "unavailable" && <p className="preferences-notice">暂时无法连接记忆服务。聊天仍可使用，请检查服务地址或查看诊断详情。</p>}
    <form onSubmit={(event) => { event.preventDefault(); perform(async () => { await api("plugins/memory", data); setToken(""); setFeedback("配置已加密保存，重启后端服务后生效。"); }); }}>
      <fieldset disabled={pending}>
        <label className="preferences-toggle"><span><strong>启用长期记忆</strong></span><input name="memoryEnabled" type="checkbox" role="switch" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setFeedback(""); }} aria-label="启用长期记忆"/></label>
        <label className="field">服务地址<input name="memoryEndpoint" type="url" required={enabled} value={endpoint} spellCheck={false} placeholder="https://memory.example.com" onChange={(event) => { setEndpoint(event.target.value); setFeedback(""); }}/></label>
        <label className="field">访问令牌<input name="memoryToken" type="password" autoComplete="off" value={token} required={enabled && !(plugin.hasToken && endpoint.replace(/\/$/, "") === plugin.endpoint)} placeholder={plugin.hasToken ? "地址不变时，留空保留已有令牌" : "输入服务访问令牌"} onChange={(event) => { setToken(event.target.value); setFeedback(""); }}/></label>

        <details className="preferences-advanced"><summary>诊断详情</summary><dl className="preferences-facts"><div><dt>服务协议</dt><dd>{plugin.providers.find((provider) => provider.id === "hindsight")?.protocol ?? "Hindsight HTTP API"}</dd></div><div><dt>连接状态</dt><dd>{labels[plugin.status] ?? "状态未知"}</dd></div>{plugin.error && <div><dt>错误详情</dt><dd><code>{plugin.error}</code></dd></div>}</dl><p>模型与认证在外部 Hindsight 服务配置；修改本页配置后需重启后端服务。</p></details>
        <div className="preferences-actions"><button className="primary" type="submit">{pending ? "处理中…" : "保存插件配置"}</button><button type="button" disabled={!endpoint} onClick={() => perform(async () => { await api("plugins/memory/test", data); setFeedback("连接测试通过，尚未更改配置。"); })}>测试连接</button></div>
      </fieldset>
      <p role="status" className="preferences-feedback">{feedback || (plugin.restartRequired ? "配置已变更，重启后端服务后生效。" : "")}</p>
    </form>
  </section>;
}
function ClientSessions({ cursor, run }: { cursor: number; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { status } = useAccount();
  const [sessions, setSessions] = useState<Array<{ session_id: string; name: string; last_seen_at?: number; expires_at: number; revoked_at: number | null }>>([]);
  const [currentId, setCurrentId] = useState<string>();
  const [loadError, setLoadError] = useState(false), [loaded, setLoaded] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  useEffect(() => {
    let current = true;
    void api<{ sessions: typeof sessions; currentSessionId?: string }>("clients").then((result) => {
      if (current) {
        setSessions(result.sessions.filter((s) => !s.revoked_at && s.expires_at > Date.now()));
        setCurrentId(result.currentSessionId ?? status?.sessionId);
        setLoaded(true); setLoadError(false);
      }
    }).catch(() => { if (current) { setLoaded(true); setLoadError(true); } });
    return () => { current = false; };
  }, [cursor, status?.sessionId]);
  return <section className="preferences-section">
    <div className="preferences-section-heading"><h3>登录设备</h3>{loaded && !loadError && <span className="preferences-status">{sessions.length} 个有效登录</span>}</div>

    {!loaded && <p className="preferences-description" role="status">正在加载登录设备…</p>}
    {loadError && <p className="preferences-notice" role="alert">登录设备暂时无法加载，请稍后重新打开设置。</p>}
    {loaded && !loadError && !sessions.length && <p className="preferences-description">暂无其他有效登录。</p>}
    <div className="ds-session-list">
      {sessions.map((session) => {
        const isCurrent = session.session_id === (currentId ?? status?.sessionId);
        return <div className={`ds-session-item ${isCurrent ? "is-current" : ""}`} key={session.session_id}>
          <Laptop size={16}/>
          <div className="ds-session-meta">
            <strong>
              <span>{session.name}</span>
              {isCurrent ? <i className="ds-current-pill">当前设备</i> : null}
            </strong>
            <small className="muted">到期时间：{new Date(session.expires_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
          </div>
          {!session.revoked_at ? <button disabled={!!pendingId} onClick={() => { setPendingId(session.session_id); void run(() => api("clients/revoke", { sessionId: session.session_id })).finally(() => setPendingId(undefined)); }}>撤销登录</button> : null}
        </div>;
      })}
    </div>
  </section>;
}
interface DeviceSession { session_id: string; name: string; last_seen_at?: number; expires_at: number; revoked_at: number | null }
export function Devices({ state, run, setDialog, closeDialog }: { state: State; run: (fn: () => Promise<unknown>) => Promise<void>; setDialog: (node: ReactNode) => void; closeDialog: () => void }) {
  const { status } = useAccount();
  const [local, setLocal] = useState<LocalDeviceState>();
  const [sessions, setSessions] = useState<DeviceSession[]>([]), [currentId, setCurrentId] = useState<string>();
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const results = await Promise.allSettled([
        api<{ sessions: DeviceSession[]; currentSessionId?: string }>("clients"),
        desktop?.deviceState?.() ?? Promise.resolve(undefined),
      ]);
      if (!active) return;
      const [clients, device] = results;
      setClock(Date.now()); setLoaded(true);
      if (clients.status === "fulfilled") { setSessions(clients.value.sessions); setCurrentId(clients.value.currentSessionId ?? status?.sessionId); setError(""); }
      else setError("设备列表加载失败");
      if (device.status === "fulfilled") setLocal(device.value);
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [status?.sessionId]);
  const update = async (work: () => Promise<LocalDeviceState>) => {
    setPending(true); setError("");
    try { setLocal(await work()); } catch (e) { setError((e instanceof Error ? e.message : "操作失败").replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { setPending(false); }
  };
  const visible = sessions.filter(session => !session.revoked_at && session.expires_at > clock).sort((a, b) => Number(b.session_id === currentId) - Number(a.session_id === currentId));
  return <div className="content-page ds-settings-page">
    <div className="preferences-panel-heading"><h2>设备</h2></div>
    <div className="signed-in-devices">
      {visible.map(session => {
        const isCurrent = session.session_id === currentId;
        const online = clock - (session.last_seen_at ?? 0) < 90_000;
        return <section className={`signed-in-device ${isCurrent ? "local-device" : ""}`} key={session.session_id}>
          <Laptop size={22} aria-hidden="true"/>
          <div className="signed-in-device-name"><strong>{session.name}</strong>{isCurrent && <span className="ds-current-pill">本设备</span>}</div>
          <span className="device-presence"><i data-online={online}/>{online ? "在线" : "离线"}{isCurrent && local?.paused ? " · 已暂停" : ""}</span>
          {isCurrent && local?.available && <button disabled={pending || !local.authorized} onClick={() => void update(() => desktop!.setDevicePaused!(!local.paused))}>{pending ? "处理中…" : local.paused ? "恢复控制" : "暂停控制"}</button>}
        </section>;
      })}
    </div>
    {!loaded && <p role="status">正在加载…</p>}
    {loaded && !error && !visible.length && <p>暂无设备</p>}
    {error && <p role="alert" className="model-error">{error}</p>}
    {local?.unknownCalls?.map(call => <section className="local-device-unresolved" key={str(call.call_id)}><strong>需要核实执行结果</strong><button disabled={pending} onClick={() => void update(() => desktop!.reconcileDevice!(str(call.call_id), Number(call.version)))}>核实并解除暂停</button></section>)}
    {state.node.unknownCalls.map((call) => <section className="approval" key={str(call.call_id)}><h2>需要核对设备执行结果</h2><pre>{str(call.arguments_json)}</pre><button onClick={() => setDialog(<Confirm title="确认该调用已停止？" detail="请先检查设备实际执行结果。确认后不会重试原操作。" onClose={closeDialog} onConfirm={() => run(async () => { await api("node/reconcile", { callId: call.call_id, version: call.version }); closeDialog(); })}/>)}>已核实停止</button></section>)}
  </div>;
}
