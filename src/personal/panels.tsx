import { useEffect, useId, useState, type ReactNode } from "react";
import { AccountControls, useAccount } from "./auth";
import { Cpu, Info, KeyRound, Laptop, Plug, Sparkles, UserRound, X } from "lucide-react";
import { AboutSettings } from "./AboutSettings";
import { api, desktop, str, type State, type LocalDeviceState } from "./api";
import { ConnectorsPage } from "./ConnectorsPage";
import { ProviderSettings } from "./ProviderSettings";
import { MemoryDashboard } from './MemoryDashboard';
import { ImageModelSettings } from './ImageModelSettings';
import { RetrievalSettings } from './RetrievalSettings';
interface Field { name: string; label: string; value?: string; required?: boolean; multiline?: boolean; hint?: string; choices?: Array<{ value: string; label: string }> }
export function Editor({ title, fields, onClose, onSubmit }: { title: string; fields: Field[]; onClose: () => void; onSubmit: (data: Record<string, string>) => Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  return <><div className="modal-heading"><h2>{title}</h2><button onClick={onClose} aria-label="关闭"><X size={18}/></button></div><form onSubmit={(e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; setPending(true); void onSubmit(data).finally(() => setPending(false)); }}>{fields.map((field, index) => <label className="field" key={field.name}>{field.label}{field.choices ? <select name={field.name} defaultValue={field.value}>{field.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : field.multiline ? <textarea name={field.name} required={field.required} defaultValue={field.value} rows={6}/> : <input autoFocus={index === 0} name={field.name} required={field.required} defaultValue={field.value}/>} {field.hint ? <small>{field.hint}</small> : null}</label>)}<div className="actions"><button className="primary" disabled={pending}>保存</button><button type="button" onClick={onClose}>取消</button></div></form></>;
}
export function Confirm({ title, detail, onClose, onConfirm }: { title: string; detail: string; onClose: () => void; onConfirm: () => Promise<unknown> }) {
  return <><h2>{title}</h2><p>{detail}</p><div className="actions"><button className="danger" onClick={() => void onConfirm()}>确认</button><button autoFocus onClick={onClose}>取消</button></div></>;
}
export type SettingsCategory = "account" | "model" | "memory" | "connectors" | "devices" | "about";
export function SettingsPage({ state, financeBotId, run, category, onCategory, refresh, setDialog, closeDialog }: { state: State; financeBotId?: string; run: (fn: () => Promise<unknown>) => Promise<void>; category: SettingsCategory; onCategory: (category: SettingsCategory) => void; refresh: () => Promise<void>; setDialog: (node: ReactNode) => void; closeDialog: () => void }) {
  const sectionId = useId();
  const categories: Array<{ id: SettingsCategory; label: string; icon: typeof UserRound }> = [
    { id: "account", label: "账号与登录设备", icon: UserRound },
    { id: "model", label: "模型", icon: KeyRound },
    { id: "memory", label: "长期记忆", icon: Sparkles },
    { id: "connectors", label: "连接器", icon: Plug },
    { id: "devices", label: "设备", icon: Cpu },
    { id: "about", label: "关于", icon: Info },
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
          <ProviderSettings state={state} refresh={refresh} active={category === "model"}/>
          <ImageModelSettings state={state} refresh={refresh} active={category === "model"}/>
          <RetrievalSettings active={category === "model"}/>
        </section>
        <section id={`${sectionId}-memory`} hidden={category !== "memory"} aria-label="长期记忆" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>长期记忆</h2></div>
          <MemoryDashboard state={state} active={category==='memory'}/>
        </section>
        <section id={`${sectionId}-connectors`} hidden={category !== "connectors"} aria-label="连接器" className="preferences-panel">
          <ConnectorsPage state={state} financeBotId={financeBotId} refresh={refresh}/>
        </section>
        <section id={`${sectionId}-devices`} hidden={category !== "devices"} aria-label="设备" className="preferences-panel">
          <Devices state={state} run={run} setDialog={setDialog} closeDialog={closeDialog}/>
        </section>
        <section id={`${sectionId}-about`} hidden={category !== "about"} aria-label="关于" className="preferences-panel">
          <AboutSettings/>
        </section>
      </div>
    </div>
  </div>;
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
