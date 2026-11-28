import { useEffect, useId, useState, type ReactNode } from "react";
import { userErrorText } from "../lib/http-errors";
import { AccountControls, useAccount } from "./auth";
import { ChevronRight, Cpu, Globe, Info, KeyRound, Laptop, Plug, Smartphone, Sparkles, UserRound, X } from "lucide-react";
import { AboutSettings } from "./AboutSettings";
import { api, desktop, str, type State, type LocalDeviceState } from "./api";
import { ConnectorsPage } from "./ConnectorsPage";
import { ProviderSettings } from "./ProviderSettings";
import { MemoryDashboard } from './MemoryDashboard';
import { ImageModelSettings } from './ImageModelSettings';
import { TranslationSettings } from './TranslationSettings';
import { RetrievalSettings } from './RetrievalSettings';
interface Field { name: string; label: string; value?: string; required?: boolean; multiline?: boolean; hint?: string; choices?: Array<{ value: string; label: string }> }
export function Editor({ title, fields, onClose, onSubmit }: { title: string; fields: Field[]; onClose: () => void; onSubmit: (data: Record<string, string>) => Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  return <><div className="modal-heading"><h2>{title}</h2><button onClick={onClose} aria-label="关闭"><X size={18}/></button></div><form onSubmit={(e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; setPending(true); void onSubmit(data).finally(() => setPending(false)); }}>{fields.map((field, index) => <label className="field" key={field.name}>{field.label}{field.choices ? <select name={field.name} defaultValue={field.value}>{field.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : field.multiline ? <textarea name={field.name} required={field.required} defaultValue={field.value} rows={6}/> : <input autoFocus={index === 0} name={field.name} required={field.required} defaultValue={field.value}/>} {field.hint ? <small>{field.hint}</small> : null}</label>)}<div className="actions"><button className="primary" disabled={pending}>保存</button><button type="button" onClick={onClose}>取消</button></div></form></>;
}
export function Confirm({ title, detail, onClose, onConfirm }: { title: string; detail: string; onClose: () => void; onConfirm: () => Promise<unknown> }) {
  return <><h2>{title}</h2><p>{detail}</p><div className="actions"><button className="danger" onClick={() => void onConfirm()}>确认</button><button autoFocus onClick={onClose}>取消</button></div></>;
}
function deviceIcon(name: string) {
  const lower = name.toLowerCase();
  if (/\b(?:android|iphone|ipad|ios|mobile|phone|pixel|huawei|xiaomi|redmi|honor|oppo|vivo|oneplus|samsung)\b|手机/.test(lower)) {
    return Smartphone;
  }
  if (/\b(?:browser|chrome|safari|firefox|edge|web)\b|浏览器/.test(lower)) {
    return Globe;
  }
  return Laptop;
}

export type SettingsCategory = "account" | "model" | "memory" | "connectors" | "devices" | "about";
export const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = {
  account: "账号与登录设备",
  model: "模型",
  memory: "长期记忆",
  connectors: "连接器",
  devices: "设备",
  about: "关于",
};
export function SettingsPage({ state, run, category, onCategory, mobileDetail = true, refresh, setDialog, closeDialog }: { state: State; run: (fn: () => Promise<unknown>) => Promise<void>; category: SettingsCategory; onCategory: (category: SettingsCategory) => void; mobileDetail?: boolean; refresh: () => Promise<void>; setDialog: (node: ReactNode) => void; closeDialog: () => void }) {
  const sectionId = useId();
  const categories: Array<{ id: SettingsCategory; label: string; icon: typeof UserRound }> = [
    { id: "account", label: SETTINGS_CATEGORY_LABELS.account, icon: UserRound },
    { id: "model", label: SETTINGS_CATEGORY_LABELS.model, icon: KeyRound },
    { id: "memory", label: SETTINGS_CATEGORY_LABELS.memory, icon: Sparkles },
    { id: "connectors", label: SETTINGS_CATEGORY_LABELS.connectors, icon: Plug },
    { id: "devices", label: SETTINGS_CATEGORY_LABELS.devices, icon: Cpu },
    { id: "about", label: SETTINGS_CATEGORY_LABELS.about, icon: Info },
  ];
  return <div className="preferences-page" data-mobile-view={mobileDetail ? "detail" : "index"}>
    <h1 className="sr-only">设置</h1>
    <div className="preferences-layout">
      <nav className="preferences-nav" aria-label="设置分类">
        <div className="preferences-nav-title" aria-hidden="true">设置</div>
        {categories.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={category === id ? "page" : undefined} aria-controls={`${sectionId}-${id}`} onClick={() => onCategory(id)}>
          <span className="preferences-nav-icon" aria-hidden="true"><Icon size={17}/></span>
          <span className="preferences-nav-label">{label}</span>
          <ChevronRight size={16} className="preferences-nav-chevron" aria-hidden="true"/>
        </button>)}
      </nav>
      <div className="preferences-content">
        <section id={`${sectionId}-account`} hidden={category !== "account"} aria-label="账号与登录设备" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>账号与登录设备</h2></div>
          <AccountControls/>
          <ClientSessions cursor={state.sync.cursor} run={run} setDialog={setDialog} closeDialog={closeDialog}/>
        </section>
        <section id={`${sectionId}-model`} hidden={category !== "model"} aria-label="模型" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>模型</h2></div>
          <ProviderSettings state={state} refresh={refresh} active={category === "model"}/>
          <ImageModelSettings state={state} refresh={refresh} active={category === "model"}/>
          {category === "model" && <TranslationSettings connections={state.connections ?? []}/>}
          <RetrievalSettings active={category === "model"}/>
        </section>
        <section id={`${sectionId}-memory`} hidden={category !== "memory"} aria-label="长期记忆" className="preferences-panel">
          <div className="preferences-panel-heading"><h2>长期记忆</h2></div>
          <MemoryDashboard state={state} active={category==='memory'}/>
        </section>
        <section id={`${sectionId}-connectors`} hidden={category !== "connectors"} aria-label="连接器" className="preferences-panel">
          <ConnectorsPage state={state} refresh={refresh}/>
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
function ClientSessions({ cursor, run, setDialog, closeDialog }: { cursor: number; run: (fn: () => Promise<unknown>) => Promise<void>; setDialog: (node: ReactNode) => void; closeDialog: () => void }) {
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
  const activeCurrentId = currentId ?? status?.sessionId;
  const ordered = [...sessions].sort((a, b) =>
    Number(b.session_id === activeCurrentId) - Number(a.session_id === activeCurrentId)
    || (b.last_seen_at ?? b.expires_at) - (a.last_seen_at ?? a.expires_at));
  return <section className="preferences-section">
    <div className="preferences-section-heading"><h3>登录设备</h3>{loaded && !loadError && <span className="preferences-status">{ordered.length} 个有效登录</span>}</div>

    {!loaded && <p className="preferences-description" role="status">正在加载登录设备…</p>}
    {loadError && <p className="preferences-notice" role="alert">登录设备暂时无法加载，请稍后重新打开设置。</p>}
    {loaded && !loadError && !ordered.length && <p className="preferences-description">暂无其他有效登录。</p>}
    <div className="ds-session-list">
      {ordered.map((session) => {
        const isCurrent = session.session_id === activeCurrentId;
        const DeviceIcon = deviceIcon(session.name);
        const label = session.name || "未命名设备";
        return <div className={`ds-session-item ${isCurrent ? "is-current" : ""}`} key={session.session_id}>
          <DeviceIcon size={18} aria-hidden="true"/>
          <div className="ds-session-meta">
            <strong>
              <span>{label}</span>
              {isCurrent ? <i className="ds-current-pill">当前设备</i> : null}
            </strong>
            <small className="muted">到期时间：{new Date(session.expires_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
          </div>
          {!isCurrent ? <button type="button" className="ds-session-revoke" disabled={!!pendingId} onClick={() => setDialog(
            <Confirm title="撤销该设备的登录？" detail={`撤销后「${label}」需要重新登录。`} onClose={closeDialog} onConfirm={async () => {
              closeDialog();
              setPendingId(session.session_id);
              await run(() => api("clients/revoke", { sessionId: session.session_id })).finally(() => setPendingId(undefined));
            }}/>
          )}>{pendingId === session.session_id ? "撤销中…" : "撤销登录"}</button> : null}
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
    try { setLocal(await work()); } catch (e) { setError((userErrorText(e, "操作失败")).replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { setPending(false); }
  };
  const visible = sessions.filter(session => !session.revoked_at && session.expires_at > clock).sort((a, b) => Number(b.session_id === currentId) - Number(a.session_id === currentId));
  return <div className="content-page ds-settings-page">
    <div className="preferences-panel-heading"><h2>设备</h2></div>
    <div className="signed-in-devices">
      {visible.map(session => {
        const isCurrent = session.session_id === currentId;
        const online = clock - (session.last_seen_at ?? 0) < 90_000;
        const DeviceIcon = deviceIcon(session.name);
        return <section className={`signed-in-device ${isCurrent ? "local-device" : ""}`} key={session.session_id}>
          <DeviceIcon size={20} aria-hidden="true"/>
          <div className="signed-in-device-name"><strong>{session.name}</strong>{isCurrent && <span className="ds-current-pill">当前设备</span>}</div>
          <span className="device-presence"><i data-online={online}/>{online ? "在线" : "离线"}{isCurrent && local?.paused ? " · 已暂停" : ""}</span>
          {isCurrent && desktop?.mode === "client" && local?.cliAgents?.available && <label className="device-switch"><input type="checkbox" role="switch" checked={local.cliAgents.enabled} disabled={pending || !local.authorized} onChange={event => void update(() => desktop!.setCliAgentsEnabled!(event.target.checked))}/>Agent 会话{local.cliAgents.enabled && local.cliAgents.hc === "error" ? " · 终端不可用" : ""}</label>}
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
