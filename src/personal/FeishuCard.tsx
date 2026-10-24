import { useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, type State } from "./api";

const statusText: Record<string, string> = { idle: "未连接", preparing: "正在生成二维码", qr: "等待扫码", connected: "已连接", busy: "已在其他位置连接", disabled: "已停用", error: "连接异常" };

/** 飞书连接卡片：扫码建应用、已有应用兜底、绑定码、启停与移除。 */
export function FeishuCard({ state, refresh }: { state: State; refresh(): Promise<void> }) {
  const feishu = state.feishu ?? { apps: [] };
  const app = feishu.apps[0];
  const job = feishu.job;
  const [botId, setBotId] = useState("");
  const [manual, setManual] = useState(false);
  const [bindCode, setBindCode] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const action = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key); setError("");
    try { await operation(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); await refresh().catch(() => {}); }
    finally { setBusy(""); }
  };
  const saveManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    void action("save", () => api("feishu/save", { ...values, botId }));
  };
  return <section className="connector-detail" aria-label="飞书" style={{ marginBottom: 16 }}>
    <div className="connector-detail-heading"><div><h2>飞书</h2><span className={`connection-status ${app?.status === "connected" ? "is-ready" : ""}`}>{app ? (statusText[app.status] ?? app.status) : job ? (statusText[job.stage] ?? job.stage) : "未连接"}</span></div></div>
    {error && <p className="connector-feedback is-error" role="alert">{error}</p>}
    {app ? <>
      <dl className="connection-meta"><div><dt>App ID</dt><dd>{app.appId}</dd></div><div><dt>接收助手</dt><dd>{app.botName}</dd></div><div><dt>品牌</dt><dd>{app.brand === "lark" ? "Lark" : "飞书"}</dd></div></dl>
      {app.error && <p className="connector-feedback is-error">{app.error}</p>}
      {!app.ownerBound && (bindCode ? <p className="connector-feedback">绑定码 {bindCode}：在飞书私聊机器人发送这串数字，10 分钟内有效。</p> : <div className="actions"><button disabled={!!busy} onClick={() => void action("bind", async () => { const result = await api<{ code: string }>("feishu/bind/start", { id: app.id }); setBindCode(String(result.code ?? "")); })}>生成绑定码</button></div>)}
      <div className="actions">
        <button disabled={!!busy} onClick={() => void action("toggle", () => api("feishu/toggle", { id: app.id, version: app.version, enabled: !app.enabled }))}>{app.enabled ? "停用" : "启用"}</button>
        {confirmRemove ? <><span>移除飞书连接？</span><button className="danger-link" disabled={!!busy} onClick={() => { setConfirmRemove(false); setBindCode(""); void action("delete", () => api("feishu/delete", { id: app.id, version: app.version })); }}>确认移除</button><button onClick={() => setConfirmRemove(false)}>取消</button></> : <button className="text-button danger-link" disabled={!!busy} onClick={() => setConfirmRemove(true)}>移除</button>}
      </div>
    </> : job?.stage === "qr" && job.url ? <div className="actions" style={{ alignItems: "center" }}>
      <QRCodeSVG value={job.url} size={148} level="M" bgColor="#ffffff" fgColor="#111111" />
      <span>用飞书扫码并确认，完成后自动连接。</span><button disabled={!!busy} onClick={() => void action("cancel", () => api("feishu/register/cancel", {}))}>取消</button>
    </div> : job?.stage === "preparing" ? <p className="muted">正在生成二维码…</p> : <>
      {job?.stage === "error" && <p className="connector-feedback is-error">{job.error}</p>}
      <label className="field">接收助手<select value={botId} onChange={(event) => setBotId(event.target.value)}>{state.bots.map((bot) => <option key={String(bot.id)} value={String(bot.id)}>{String(bot.name)}</option>)}</select></label>
      {manual ? <form onSubmit={saveManual}><label className="field">App ID<input name="appId" required placeholder="cli_xxx"/></label><label className="field">App Secret<input name="appSecret" type="password" required autoComplete="new-password"/></label><label className="field">品牌<select name="brand" defaultValue="feishu"><option value="feishu">飞书</option><option value="lark">Lark</option></select></label><div className="actions"><button className="primary" disabled={!!busy || !botId}>保存并连接</button><button type="button" onClick={() => setManual(false)}>返回扫码</button></div></form>
        : <div className="actions"><button className="primary" disabled={!!busy || !botId} onClick={() => void action("register", () => api("feishu/register/start", { botId }))}>扫码连接飞书</button><button disabled={!!busy} onClick={() => setManual(true)}>使用已有应用</button></div>}
    </>}
  </section>;
}
