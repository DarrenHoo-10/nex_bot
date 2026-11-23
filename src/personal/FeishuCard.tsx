import { userErrorText } from "../lib/http-errors";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { MoreHorizontal, Plus } from "lucide-react";
import { FeishuDeliverySettings } from "./FeishuDeliverySettings";
import { api, type FeishuAppView, type FeishuState, type State } from "./api";

export const feishuStatusText: Record<string, string> = { idle: "未连接", preparing: "正在生成二维码", qr: "等待扫码", connected: "已连接", busy: "已在其他位置连接", disabled: "已停用", error: "连接异常" };

export function FeishuAvatar({ app, large = false }: { app: FeishuAppView; large?: boolean }) {
  const name = app.name || app.botName || "飞";
  return <span className={`feishu-avatar ${large ? "is-large" : ""}`} aria-hidden="true">{[...name][0]}</span>;
}

export function FeishuStatus({ status }: { status: string }) {
  return <span className={`feishu-status is-${status}`}><i/>{feishuStatusText[status] ?? status}</span>;
}

/** One app row: opens the app's group settings; lifecycle actions live in the row's menu. */
function AppRow({ app, busy, open, act, userAuth }: { app: FeishuAppView; busy: boolean; open(): void; act(key: string, operation: () => Promise<unknown>): Promise<void>; userAuth?: FeishuState["userAuth"] }) {
  const [menu, setMenu] = useState(false), [confirm, setConfirm] = useState(false), [code, setCode] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) { setMenu(false); setConfirm(false); } };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const run = (key: string, operation: () => Promise<unknown>) => { setMenu(false); setConfirm(false); void act(key, operation); };
  const authorizing = userAuth?.id === app.id ? userAuth : undefined;
  return <div className="feishu-app" ref={ref}>
    <div className="feishu-app-row">
      <button type="button" className="feishu-app-open" onClick={open}>
        <FeishuAvatar app={app}/>
        <span className="feishu-app-copy"><strong>{app.name || app.botName || app.appId}{app.brand === "lark" && <span className="feishu-tag">Lark</span>}</strong>
          <small>{app.appId} · 接收助手 {app.botName} · {app.groupCount ?? 0} 个群</small>
          {app.status === "error" && app.error && <small className="is-error">{app.error}</small>}</span>
        <FeishuStatus status={app.status}/>
      </button>
      <button type="button" className="feishu-more" aria-label="更多操作" aria-expanded={menu} disabled={busy} onClick={() => { setMenu(!menu); setConfirm(false); }}><MoreHorizontal size={18}/></button>
      {menu && <div className="feishu-menu" role="menu">{confirm ? <>
        <p>移除「{app.name || app.appId}」？</p>
        <button type="button" role="menuitem" className="danger-link" onClick={() => run("delete", () => api("feishu/delete", { id: app.id, version: app.version }))}>确认移除</button>
        <button type="button" role="menuitem" onClick={() => { setConfirm(false); setMenu(false); }}>取消</button>
      </> : <>
        {!app.ownerBound && <button type="button" role="menuitem" onClick={() => run("bind", async () => { const result = await api<{ code: string }>("feishu/bind/start", { id: app.id }); setCode(String(result.code ?? "")); })}>绑定主人</button>}
        <button type="button" role="menuitem" onClick={() => run("userauth", () => api("feishu/user-auth/start", { id: app.id }))}>{app.userAuthorized ? "重新授权文档" : "授权文档访问"}</button>
        <button type="button" role="menuitem" onClick={() => run("toggle", () => api("feishu/toggle", { id: app.id, version: app.version, enabled: !app.enabled }))}>{app.enabled ? "停用" : "启用"}</button>
        <button type="button" role="menuitem" className="danger-link" onClick={() => setConfirm(true)}>移除</button>
      </>}</div>}
    </div>
    {code && !app.ownerBound && <p className="feishu-app-note">在飞书私聊机器人发送 <code>{code}</code>，10 分钟内有效</p>}
    {authorizing?.stage === "polling" && authorizing.url && <div className="feishu-app-note feishu-qr">
      <QRCodeSVG value={authorizing.url} size={180} marginSize={4} level="M" bgColor="#ffffff" fgColor="#111111"/>
      <span>用飞书扫码完成文档授权</span><button type="button" disabled={busy} onClick={() => void act("usercancel", () => api("feishu/user-auth/cancel", {}))}>取消</button>
    </div>}
    {authorizing?.stage === "error" && <p className="feishu-app-note is-error">{authorizing.error}</p>}
  </div>;
}

/** 飞书：应用列表、添加应用（扫码新建或已有应用）、共享应用与投递。 */
export function FeishuCard({ state, financeBotId, refresh, onOpenApp }: { state: Pick<State, "bots" | "feishu">; financeBotId?: string; refresh(): Promise<void>; onOpenApp?(id: string): void }) {
  const feishu = state.feishu ?? { apps: [] };
  const apps = feishu.apps;
  const job = feishu.job;
  const webScan = job?.scanPath && typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)
    ? window.location.origin + job.scanPath : job?.url;
  const [sharedAvailable, setSharedAvailable] = useState(false);
  const [selectedBotId, setBotId] = useState("");
  const botId = String((state.bots.find(bot => bot.id === selectedBotId)
    ?? state.bots.find(bot => bot.id === financeBotId)
    ?? state.bots[0])?.id ?? "");
  const [adding, setAdding] = useState(false);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const scanning = job?.stage === "qr" || job?.stage === "preparing";
  const showAdd = !apps.length || adding || scanning || job?.stage === "error";
  const previousCount = useRef(apps.length);
  useEffect(() => { if (apps.length > previousCount.current) { setAdding(false); setManual(false); } previousCount.current = apps.length; }, [apps.length]);
  const action = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key); setError("");
    try { await operation(); await refresh(); }
    catch (e) { setError(userErrorText(e, "操作失败")); await refresh().catch(() => {}); }
    finally { setBusy(""); }
  };
  const saveManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    void action("save", () => api("feishu/save", { ...values, botId }));
  };
  const addForm = job?.stage === "qr" && job.url && webScan ? <div className="actions feishu-qr">
    <QRCodeSVG value={webScan} title="飞书连接二维码" size={246} marginSize={4} level="M" bgColor="#ffffff" fgColor="#111111" style={{ maxWidth: "100%", height: "auto", flexShrink: 0 }} />
    <span>用飞书「扫一扫」扫码并确认。</span><a href={job.url} target="_blank" rel="noreferrer">打开飞书授权页</a><button disabled={!!busy} onClick={() => void action("cancel", () => api("feishu/register/cancel", {}))}>取消</button>
  </div> : job?.stage === "preparing" ? <p className="muted">正在生成二维码…</p> : <>
    {job?.stage === "error" && <p className="connector-feedback is-error">{job.error}</p>}
    <label className="field">接收助手<select value={botId} onChange={(event) => setBotId(event.target.value)}>{state.bots.map((bot) => <option key={String(bot.id)} value={String(bot.id)}>{String(bot.name)}</option>)}</select></label>
    {manual ? <form onSubmit={saveManual}><label className="field">App ID<input name="appId" required placeholder="cli_xxx"/></label><label className="field">App Secret<input name="appSecret" type="password" required autoComplete="new-password"/></label><label className="field">品牌<select name="brand" defaultValue="feishu"><option value="feishu">飞书</option><option value="lark">Lark</option></select></label><div className="actions"><button className="primary" disabled={!!busy || !botId}>保存并连接</button><button type="button" onClick={() => setManual(false)}>返回扫码</button></div></form>
      : <div className="actions"><button className="primary" disabled={!!busy || !botId} onClick={() => void action("register", () => api("feishu/register/start", { botId }))}>扫码连接飞书</button><button disabled={!!busy} onClick={() => setManual(true)}>使用已有应用</button>{apps.length > 0 && !scanning && <button type="button" onClick={() => { setAdding(false); setManual(false); }}>取消</button>}</div>}
  </>;
  return <section className="connector-detail connector-profile feishu-page" aria-label="飞书">
    <div className="connector-profile-heading"><span className="connector-icon feishu-icon" aria-hidden="true">飞</span><div><h2 className="connector-profile-title" tabIndex={-1}>飞书</h2><span>{apps.length ? `${apps.length} 个应用` : "未连接"}</span></div>
      {apps.length > 0 && !showAdd && <button type="button" className="feishu-add" onClick={() => setAdding(true)}><Plus size={16}/>添加飞书应用</button>}</div>
    {error && <p className="connector-feedback is-error" role="alert">{error}</p>}
    {showAdd && !(sharedAvailable && !apps.length && !adding) && <div className="connector-surface feishu-add-form">{addForm}</div>}
    {!apps.length && sharedAvailable && !adding && !scanning && <div className="actions"><button type="button" onClick={() => setAdding(true)}><Plus size={16}/>添加飞书应用</button></div>}
    {apps.length > 0 && <div className="connector-profile-section"><h3>我的应用</h3><div className="connector-surface feishu-apps">
      {apps.map((app) => <AppRow key={app.id} app={app} busy={!!busy} open={() => onOpenApp?.(app.id)} act={action} userAuth={feishu.userAuth}/>)}
    </div></div>}
    <FeishuDeliverySettings revision={state.feishu} onSharedAvailable={setSharedAvailable}/>
  </section>;
}
