import { useEffect, useState, type ReactNode } from "react";
import { AccountControls, useAccount } from "./auth";
import { Check, Cpu, Globe, KeyRound, Laptop, Plus, ShieldCheck, Sparkles, X } from "lucide-react";
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
  const [provider, setProvider] = useState(str(state.config?.provider_id) || "openai");
  const [endpoint, setEndpoint] = useState(str(state.config?.endpoint) || "https://api.openai.com/v1");
  const [saved, setSaved] = useState(false);
  let requestAddress = "请输入有效的 API 基础地址";
  try { const url = new URL(endpoint); if (!url.username && !url.password && !url.search && !url.hash) requestAddress = url.origin + url.pathname.replace(/\/$/, "") + (provider === "openai" ? "/chat/completions" : "/v1/messages"); } catch { /* The form reports invalid addresses on save. */ }
  return <div className="content-page settings-page ds-settings-page">
    <div className="ds-page-hero">
      <div>
        <span className="ds-page-eyebrow">PERSONAL AI OS · SETTINGS</span>
        <h1>账号、模型与系统设置</h1>
        <p className="muted">统一管理你的个人 NexorAI 账号、登录设备、大模型接口与 Hindsight 长期记忆服务。</p>
      </div>
    </div>
    <AccountControls/>
    <ClientSessions cursor={state.sync.cursor} run={run}/>
    <section className="settings-info ds-settings-card">
      <div className="ds-card-header">
        <div className="ds-card-icon"><KeyRound size={18}/></div>
        <div>
          <h2>连接你的模型</h2>
          <p className="muted">运行时已经内置。配置 API Key、模型和服务地址后即可使用。</p>
        </div>
        {state.config ? <span className="ds-badge-green">{str(state.config.default_model)}</span> : null}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)); void run(async () => { await api("config", data); setSaved(true); }); }}>
        <div className="ds-form-grid">
          <label className="field">API 协议<select name="provider" value={provider} onChange={(e) => { const next = e.target.value; if (["https://api.openai.com/v1", "https://api.anthropic.com"].includes(endpoint)) setEndpoint(next === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com"); setProvider(next); setSaved(false); }}><option value="openai">OpenAI 兼容 API（Chat Completions）</option><option value="anthropic">Anthropic API</option></select></label>
          <label className="field">模型 ID<input name="model" required defaultValue={str(state.config?.default_model)} placeholder={provider === "openai" ? "你的服务商提供的模型 ID" : "你的 Anthropic 模型 ID"} onChange={() => setSaved(false)}/></label>
        </div>
        <label className="field">API 基础地址<input name="endpoint" required value={endpoint} onChange={(e) => { setEndpoint(e.target.value); setSaved(false); }}/><small className="muted">{provider === "openai" ? "填写服务商提供的完整 API 基础地址，通常以 /v1 结尾；不要填写 /chat/completions 接口全路径。" : "填写 Anthropic 服务根地址，不要填写 /v1/messages 接口全路径。"}</small></label>
        <p className="muted ds-url-preview">实际请求地址：<code data-model-request-url>{requestAddress}</code></p>
        <label className="field">API Key<input name="apiKey" type="password" autoComplete="off" required={!state.config} placeholder={state.config ? "已加密保存；留空保留原 Key" : "输入 API Key"} onChange={() => setSaved(false)}/></label>
        <div className="actions"><button className="primary">保存配置</button>{saved ? <span className="saved"><Check size={15}/>已保存</span> : null}</div>
      </form>
    </section>
    <MemoryPluginSettings state={state} run={run}/>
    <section className="settings-info ds-settings-card">
      <div className="ds-card-header">
        <div className="ds-card-icon"><Globe size={18}/></div>
        <div>
          <h2>后端服务数据</h2>
          <p className="muted">消息、任务、记忆来源、审批和模型配置统一由后端管理。客户端只保存加密登录凭据；语义记忆由外部插件服务提供。</p>
        </div>
      </div>
      <div className="ds-meta-chips">
        <code>{state.address}</code>
        <code>{state.dataDir}</code>
      </div>
      <p className="muted">固定运行时 Pi 1.0.4 · 数据库 SQLite · 工具由 Core Broker 授权</p>
    </section>
    {desktop?.mode === "client" ? <section className="settings-info ds-settings-card"><div className="ds-account-row"><div className="ds-account-meta"><h2>当前客户端</h2><p className="muted">退出连接会撤销当前客户端登录。后端例行任务需要有效的账号登录。</p></div><div className="ds-account-actions"><button onClick={() => void desktop?.disconnect?.()}>退出连接</button></div></div></section> : null}
  </div>;
}
function MemoryPluginSettings({ state, run }: { state: State; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const plugin = state.memoryPlugin;
  const [enabled, setEnabled] = useState(plugin?.enabled ?? false), [endpoint, setEndpoint] = useState(plugin?.endpoint ?? ""), [token, setToken] = useState("");
  const [feedback, setFeedback] = useState(""), [pending, setPending] = useState(false);
  const labels: Record<string, string> = { disabled: "未启用", connecting: "正在连接", ready: "已连接", unavailable: "暂不可用" };
  const data = { provider: "hindsight", enabled, endpoint, token };
  const perform = (action: () => Promise<void>) => { setPending(true); setFeedback(""); void run(action).finally(() => setPending(false)); };
  if (!plugin) return null;
  return <section className="settings-info ds-settings-card" data-memory-plugin>
    <div className="ds-card-header">
      <div className="ds-card-icon"><Sparkles size={18}/></div>
      <div>
        <h2>记忆插件</h2>
        <p className="muted">后端通过外部服务提供长期记忆检索与综合。未连接时仍可聊天并查阅原始记录。</p>
      </div>
      <span role="status" className={plugin.status === "ready" ? "ds-badge-green" : "ds-badge-muted"}>Hindsight · {labels[plugin.status] ?? plugin.status}{plugin.error ? ` · ${plugin.error}` : ""}</span>
    </div>
    <form onSubmit={(event) => { event.preventDefault(); perform(async () => { await api("plugins/memory", data); setToken(""); setFeedback("配置已加密保存，重启后端服务后生效。"); }); }}>
      <div className="ds-form-grid">
        <label className="field">插件<select name="memoryProvider" defaultValue="hindsight">{plugin.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.protocol}</option>)}</select></label>
        <label className="field">服务地址<input name="memoryEndpoint" type="url" required={enabled} value={endpoint} placeholder="http://127.0.0.1:8888 或 https://memory.example.com" onChange={(event) => setEndpoint(event.target.value)}/></label>
      </div>
      <label className="check-field"><input name="memoryEnabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/>启用外部记忆服务</label>
      <label className="field">访问令牌<input name="memoryToken" type="password" autoComplete="off" value={token} required={enabled && !(plugin.hasToken && endpoint.replace(/\/$/, "") === plugin.endpoint)} placeholder={plugin.hasToken ? "已加密保存；同一地址留空保留原令牌" : "输入服务访问令牌"} onChange={(event) => setToken(event.target.value)}/><small className="muted">由后端连接本机、私有网络或 HTTPS 服务。请在外部 Hindsight 中配置模型与访问认证。</small></label>
      <p className="muted">启用后，记忆来源会同步到配置的服务。服务产生的模型调用与费用由该服务管理；停用不会删除外部数据。</p>
      <div className="actions"><button type="button" disabled={pending || !endpoint} onClick={() => perform(async () => { await api("plugins/memory/test", data); setFeedback("连接测试通过，尚未更改配置。"); })}>测试连接</button><button className="primary" disabled={pending}>保存插件配置</button></div><p role="status" className="muted">{feedback || (plugin.restartRequired ? "配置已变更，重启后端服务后生效。" : "")}</p>
    </form>
  </section>;
}
function ClientSessions({ cursor, run }: { cursor: number; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { status } = useAccount();
  const [sessions, setSessions] = useState<Array<{ session_id: string; name: string; last_seen_at?: number; expires_at: number; revoked_at: number | null }>>([]);
  const [currentId, setCurrentId] = useState<string>();
  useEffect(() => {
    let current = true;
    void api<{ sessions: typeof sessions; currentSessionId?: string }>("clients").then((result) => {
      if (current) {
        setSessions(result.sessions.filter((s) => !s.revoked_at && s.expires_at > Date.now()));
        setCurrentId(result.currentSessionId ?? status?.sessionId);
      }
    });
    return () => { current = false; };
  }, [cursor, status?.sessionId]);
  return <section className="settings-info ds-settings-card">
    <div className="ds-card-header">
      <div className="ds-card-icon"><Laptop size={18}/></div>
      <div>
        <h2>登录设备</h2>
        <p className="muted">其他电脑使用同一 NexorAI 账号连接这个 Core。每台设备的登录最长八小时，到期后重新登录。</p>
      </div>
      <span className="ds-badge-muted">{sessions.length} 台在线</span>
    </div>
    <div className="ds-session-list">
      {sessions.map((session) => {
        const isCurrent = session.session_id === (currentId ?? status?.sessionId);
        return <div className={`ds-session-item ${isCurrent ? "is-current" : ""}`} key={session.session_id}>
          <Laptop size={16}/>
          <div className="ds-session-meta">
            <strong>
              <span>{session.name} · 已登录</span>
              {isCurrent ? <i className="ds-current-pill">当前设备</i> : null}
            </strong>
            <small className="muted">到期时间：{new Date(session.expires_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
          </div>
          {!session.revoked_at ? <button onClick={() => void run(() => api("clients/revoke", { sessionId: session.session_id }))}>撤销登录</button> : null}
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
