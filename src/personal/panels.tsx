import { useEffect, useId, useState, type ReactNode } from "react";
import { AccountControls, useAccount } from "./auth";
import { Check, Cpu, Globe, KeyRound, Laptop, Plus, ShieldCheck, Sparkles, UserRound, X } from "lucide-react";
import { api, desktop, str, type State } from "./api";
interface Field { name: string; label: string; value?: string; required?: boolean; multiline?: boolean; hint?: string; choices?: Array<{ value: string; label: string }> }
export function Editor({ title, fields, onClose, onSubmit }: { title: string; fields: Field[]; onClose: () => void; onSubmit: (data: Record<string, string>) => Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  return <><div className="modal-heading"><h2>{title}</h2><button onClick={onClose} aria-label="关闭"><X size={18}/></button></div><form onSubmit={(e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; setPending(true); void onSubmit(data).finally(() => setPending(false)); }}>{fields.map((field, index) => <label className="field" key={field.name}>{field.label}{field.choices ? <select name={field.name} defaultValue={field.value}>{field.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : field.multiline ? <textarea name={field.name} required={field.required} defaultValue={field.value} rows={6}/> : <input autoFocus={index === 0} name={field.name} required={field.required} defaultValue={field.value}/>} {field.hint ? <small>{field.hint}</small> : null}</label>)}<div className="actions"><button className="primary" disabled={pending}>保存</button><button type="button" onClick={onClose}>取消</button></div></form></>;
}
export function Confirm({ title, detail, onClose, onConfirm }: { title: string; detail: string; onClose: () => void; onConfirm: () => Promise<unknown> }) {
  return <><h2>{title}</h2><p>{detail}</p><div className="actions"><button className="danger" onClick={() => void onConfirm()}>确认</button><button autoFocus onClick={onClose}>取消</button></div></>;
}
export function SettingsPage({ state, run }: { state: State; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [category, setCategory] = useState("account");
  const sectionId = useId();
  const categories = [
    { id: "account", label: "账号与登录设备", icon: UserRound },
    { id: "model", label: "模型", icon: KeyRound },
    { id: "memory", label: "记忆服务", icon: Sparkles },
    { id: "system", label: "系统信息", icon: Globe },
  ];
  return <div className="preferences-page">
    <div className="preferences-heading"><h1>设置</h1><p>管理你的账号和助手偏好。</p></div>
    <div className="preferences-layout">
      <nav className="preferences-nav" aria-label="设置分类">{categories.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={category === id ? "page" : undefined} aria-controls={`${sectionId}-${id}`} onClick={() => setCategory(id)}><Icon size={17}/><span>{label}</span></button>)}</nav>
      <div className="preferences-content">
        <section id={`${sectionId}-account`} hidden={category !== "account"} aria-label="账号与登录设备" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>账号与登录设备</h2><p>管理个人身份，以及可以访问这个工作区的登录设备。</p></div>
          <AccountControls/>
          <ClientSessions cursor={state.sync.cursor} run={run}/>
        </section>
        <section id={`${sectionId}-model`} hidden={category !== "model"} aria-label="模型" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>模型</h2><p>选择助手使用的模型，并连接你的服务商。</p></div>
          <ModelSettings state={state} run={run}/>
        </section>
        <section id={`${sectionId}-memory`} hidden={category !== "memory"} aria-label="记忆服务" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>记忆服务</h2><p>让助手在后续对话中找回与你有关的信息。</p></div>
          <MemoryPluginSettings state={state} run={run}/>
        </section>
        <section id={`${sectionId}-system`} hidden={category !== "system"} aria-label="系统信息" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>系统信息</h2><p>查看当前连接和数据存储方式。</p></div>
          <section className="preferences-section"><h3>服务连接</h3><dl className="preferences-facts"><div><dt>当前访问地址</dt><dd><code>{location.origin}</code></dd></div><div><dt>客户端类型</dt><dd>{desktop?.mode === "client" ? "桌面客户端" : "浏览器"}</dd></div></dl></section>
          <section className="preferences-section"><h3>数据与隐私</h3><p className="preferences-description">聊天、任务与配置保存在后端。桌面客户端只保存加密的登录资料；启用记忆服务后，记忆来源会同步到该服务。</p></section>
          <details className="preferences-advanced"><summary>技术详情</summary><dl className="preferences-facts"><div><dt>后端监听地址</dt><dd><code>{state.address}</code></dd></div><div><dt>后端数据目录</dt><dd><code>{state.dataDir}</code></dd></div><div><dt>运行环境</dt><dd>Pi 1.0.4 · SQLite</dd></div></dl></details>
        </section>
      </div>
    </div>
  </div>;
}
function ModelSettings({ state, run }: { state: State; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [provider, setProvider] = useState(str(state.config?.provider_id) || "openai");
  const [endpoint, setEndpoint] = useState(str(state.config?.endpoint) || "https://api.openai.com/v1");
  const [saved, setSaved] = useState(false), [pending, setPending] = useState(false);
  let requestAddress = "请输入有效的 API 基础地址";
  try { const url = new URL(endpoint); if (!url.username && !url.password && !url.search && !url.hash) requestAddress = url.origin + url.pathname.replace(/\/$/, "") + (provider === "openai" ? "/chat/completions" : "/v1/messages"); } catch { /* Show the validation result when saving. */ }
  return <section className="preferences-section" data-model-settings>
    <div className="preferences-section-heading"><h3>模型连接</h3><span className="preferences-status">{state.config ? "已配置" : "待配置"}</span></div>
    <form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); setPending(true); setSaved(false); void run(async () => { await api("config", data); const key = form.elements.namedItem("apiKey") as HTMLInputElement; key.value = ""; setSaved(true); }).finally(() => setPending(false)); }}>
      <fieldset disabled={pending}>
        <div className="preferences-form-grid">
          <label className="field">API 协议<select name="provider" value={provider} onChange={(event) => { const next = event.target.value; if (["https://api.openai.com/v1", "https://api.anthropic.com"].includes(endpoint)) setEndpoint(next === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com"); setProvider(next); setSaved(false); }}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label>
          <label className="field">模型 ID<input name="model" required defaultValue={str(state.config?.default_model)} placeholder="服务商提供的模型 ID" onChange={() => setSaved(false)}/></label>
        </div>
        <label className="field">API 基础地址<input name="endpoint" type="url" required value={endpoint} spellCheck={false} onChange={(event) => { setEndpoint(event.target.value); setSaved(false); }}/><small>{provider === "openai" ? "通常以 /v1 结尾，不包含 /chat/completions。" : "填写服务根地址，不包含 /v1/messages。"}</small></label>
        <label className="field">API Key<input name="apiKey" type="password" autoComplete="off" required={!state.config} placeholder={state.config ? "留空保留已保存的 Key" : "输入 API Key"} onChange={() => setSaved(false)}/><small>密钥由后端加密保存。</small></label>
        <details className="preferences-advanced"><summary>高级设置</summary><p>实际请求地址</p><code data-model-request-url>{requestAddress}</code><p>{provider === "openai" ? "使用 Chat Completions 协议。" : "使用 Anthropic Messages 协议。"}</p></details>
        <div className="preferences-actions"><button className="primary" type="submit">{pending ? "保存中…" : "保存配置"}</button>{saved && <span className="preferences-saved" role="status"><Check size={15}/>已保存</span>}</div>
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
        <label className="preferences-toggle"><span><strong>启用长期记忆</strong><small>将记忆来源同步到配置的服务，供后续检索使用。</small></span><input name="memoryEnabled" type="checkbox" role="switch" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setFeedback(""); }} aria-label="启用长期记忆"/></label>
        <label className="field">服务地址<input name="memoryEndpoint" type="url" required={enabled} value={endpoint} spellCheck={false} placeholder="https://memory.example.com" onChange={(event) => { setEndpoint(event.target.value); setFeedback(""); }}/><small>填写后端能够访问的 Hindsight 服务地址。</small></label>
        <label className="field">访问令牌<input name="memoryToken" type="password" autoComplete="off" value={token} required={enabled && !(plugin.hasToken && endpoint.replace(/\/$/, "") === plugin.endpoint)} placeholder={plugin.hasToken ? "地址不变时，留空保留已有令牌" : "输入服务访问令牌"} onChange={(event) => { setToken(event.target.value); setFeedback(""); }}/></label>
        <p className="preferences-description">模型调用与费用由该服务管理。停用不会删除外部数据。</p>
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
    <p className="preferences-description">移除不再使用的登录，即可撤销该设备对工作区的访问。</p>
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
export function Devices({ state, run, setDialog, closeDialog }: { state: State; run: (fn: () => Promise<unknown>) => Promise<void>; setDialog: (node: ReactNode) => void; closeDialog: () => void }) {
  const [root, setRoot] = useState(state.node.root), [pair, setPair] = useState<{ token: string; deviceId: string }>();
  return <div className="content-page ds-settings-page"><div className="page-heading ds-page-hero"><div><span className="ds-page-eyebrow">PERSONAL AI OS · DEVICES</span><h1>设备网络</h1><p className="muted">设备执行节点独立连接后端。客户端只显示和管理后端已注册的设备。</p></div><button className="primary" onClick={() => setDialog(<Editor title="添加设备" onClose={closeDialog} fields={[{ name: "name", label: "设备名称", required: true }]} onSubmit={(data) => run(async () => { setPair(await api("devices", data)); closeDialog(); })}/>)}><Plus size={16}/>生成配对令牌</button></div>
    {pair ? <section className="pair-card"><h2>在设备执行节点完成配对</h2><p>后端地址：<code>{state.address}</code></p><label className="field">设备令牌（仅显示本次）<input readOnly value={pair.token} onFocus={(event) => event.target.select()}/></label><button onClick={() => setPair(undefined)}>已复制，关闭</button></section> : null}
    <div className="device-list">{state.devices.map((device) => <section key={str(device.id)}><Cpu size={25}/><div><strong>{device.name}{device.id === state.hostDeviceId ? " · 后端主机" : ""}</strong><p>{device.status === "revoked" ? "已撤销" : state.onlineDevices.includes(str(device.id)) ? "在线" : "离线"}</p></div>{device.status !== "revoked" && device.id !== state.hostDeviceId ? <button className="danger-text" onClick={() => void run(() => api("devices/revoke", { id: device.id }))}>撤销</button> : null}</section>)}</div>
    {state.node.hosted ? <section className="settings-info ds-settings-card"><h2>你的设备</h2><p className="muted">此工作区只连接你配对的设备。添加设备后，Agent 可以使用该设备授权的能力。</p></section> : <section className="settings-info ds-settings-card"><div className="ds-card-header"><div className="ds-card-icon"><ShieldCheck size={18}/></div><div><h2>后端主机能力</h2><p className="muted">这些能力作用于运行后端服务的主机。客户端不运行本地终端或设备执行节点。</p></div><span className="ds-badge-green">状态：{state.node.status}</span></div><p className="muted">连接状态：{state.node.status} · 终端{state.node.exec ? "可用" : "不可用"} · 窗口控制{state.node.computerSupported ? "可用" : "暂不支持"}</p>
      {state.node.unknownCalls.map((call) => <section className="approval" key={str(call.call_id)}><h2>需要核对设备执行结果</h2><pre>{str(call.arguments_json)}</pre><p>上次执行中断，这个调用不会重放。请检查后端主机上的进程和操作结果，再确认已停止。</p><button onClick={() => setDialog(<Confirm title="确认该调用已停止？" detail="请先检查设备实际执行结果。确认后不会重试原操作。" onClose={closeDialog} onConfirm={() => run(async () => { await api("node/reconcile", { callId: call.call_id, version: call.version }); closeDialog(); })}/>)}>已核实停止</button></section>)}
      <form onSubmit={(event) => { event.preventDefault(); void run(() => api("node", { root })); }}><label className="field">后端允许读取的目录（可留空）<input name="root" value={root} onChange={(event) => setRoot(event.target.value)} placeholder="填写后端主机上的目录路径"/></label><button className="primary">保存后端文件目录</button></form><p className="muted">危险操作会在执行 Agent 的消息中请求批准。</p>
    </section>}<section className="settings-info ds-settings-card"><h2>后端连接</h2><code>{state.address}</code><p className="muted">监听地址、HTTPS 与端口由后端服务的部署配置管理。</p></section>
  </div>;
}
