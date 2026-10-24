import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, MoreHorizontal, Plug, Plus, RefreshCw, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { api, str, type ConnectorView, type State } from "./api";
import { GmailConnect } from "./GmailConnect";
import gmailIcon from "./assets/gmail.png";
import "./connectors.css";

const gmailTools = [
  { name: "gmail.search", label: "搜索邮件", description: "按关键词、发件人和时间查找邮件。" },
  { name: "gmail.read", label: "读取邮件", description: "查看邮件正文与附件信息。" },
  { name: "gmail.thread", label: "读取邮件会话", description: "查看同一会话中的往来邮件。" },
];
const toolLabel = (name: string) => gmailTools.find((tool) => tool.name === name)?.label ?? name;
const ready = (item: ConnectorView) => item.enabled && !!item.checkedAt && !item.error && (item.provider !== "gmail" || item.hasToken);
const connectionStatus = (item: ConnectorView) => !item.enabled ? "已停用" : item.provider === "gmail" && !item.hasToken ? "需要重新授权" : item.error ? "连接异常" : item.checkedAt ? item.provider === "gmail" ? "已连接" : "连接测试通过" : "等待测试";
const ConnectorIcon = ({ gmail = false }: { gmail?: boolean }) => <span className={`connector-icon ${gmail ? "is-gmail" : ""}`} aria-hidden="true">{gmail ? <img src={gmailIcon} alt="" width="48" height="48"/> : <Plug size={24}/>}</span>;

export function ConnectorsPage({ state, refresh }: { state: State; refresh(): Promise<void> }) {
  const [view, setView] = useState<"catalog" | "gmail" | "mcp">("catalog");
  const [editing, setEditing] = useState<ConnectorView | "new" | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [managedAccount, setManagedAccount] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [grantBot, setGrantBot] = useState("");
  const [grantTools, setGrantTools] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState("");
  const modal = useRef<HTMLElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const returnTo = useRef("gmail");
  const previousView = useRef(view);
  useEffect(() => {
    const back = (event: Event) => {
      if (!editing && !confirmRemove && !grantBot && !managedAccount && view === "catalog") return;
      event.stopImmediatePropagation();
      if (busy) return;
      if (editing) setEditing(null);
      else if (confirmRemove) setConfirmRemove("");
      else if (grantBot) setGrantBot("");
      else if (managedAccount) setManagedAccount("");
      else { setView("catalog"); setError(""); setNotice(""); }
    };
    window.addEventListener("nex-android-back", back, true);
    return () => window.removeEventListener("nex-android-back", back, true);
  }, [editing, confirmRemove, grantBot, managedAccount, view, busy]);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const target = view === "catalog"
      ? [...(page.current?.querySelectorAll<HTMLElement>("[data-connector]") ?? [])].find((item) => item.dataset.connector === returnTo.current)
      : page.current?.querySelector<HTMLElement>(".connector-profile-title");
    target?.focus({ preventScroll: true });
    page.current?.scrollIntoView({ block: "start" });
  }, [view]);
  useEffect(() => {
    if (!editing) return;
    const previous = document.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
  }, [editing]);
  const connections = state.connectors ?? [];
  const selected = connections.find((item) => item.id === selectedId);
  const accounts = connections.filter((item) => item.provider === "gmail");
  const gmailAvailable = state.connectorCatalog?.find((item) => item.id === "gmail")?.available === true;
  const query = search.trim().toLowerCase();
  const showGmail = `gmail google 邮箱 邮件 ${accounts.map((item) => item.account).join(" ")}`.toLowerCase().includes(query);
  const otherConnections = connections.filter((item) => item.provider !== "gmail" && `${item.name} ${item.url}`.toLowerCase().includes(query));
  const tools = accounts[0]?.tools ?? gmailTools;
  const usableTools = new Set(gmailAvailable ? accounts.filter(ready).flatMap((item) => item.tools.map((tool) => tool.name)) : []);
  const openDetail = (provider: "gmail" | "mcp", id = "") => {
    returnTo.current = provider === "gmail" ? "gmail" : id;
    setView(provider); setSelectedId(id); setGrantBot(""); setManagedAccount(""); setConfirmRemove(""); setError(""); setNotice("");
  };
  const connected = async (id: string) => { setSelectedId(id); setGrantBot(""); setConfirmRemove(""); await refresh(); setNotice("Gmail 已连接"); };
  const action = async (key: string, operation: () => Promise<unknown>, success?: string) => {
    setBusy(key); setError(""); setNotice("");
    try { const result = await operation() as { warning?: string } | undefined; await refresh(); if (result?.warning || success) setNotice(result?.warning ?? success ?? ""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败，请重试"); await refresh().catch(() => {}); }
    finally { setBusy(""); }
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
    const previous = editing && editing !== "new" ? editing : undefined;
    void action("save", async () => {
      const result = await api<{ id: string }>("connectors/save", { ...values, id: previous?.id, version: previous?.version, enabled: previous?.enabled ?? true, clearToken: values.clearToken === "on" });
      form.reset(); setEditing(null); openDetail("mcp", result.id);
    }, "已保存");
  };
  const beginGrant = (item: ConnectorView, botId: string) => { setSelectedId(item.id); setGrantBot(botId); setGrantTools(item.grants.find((grant) => grant.botId === botId)?.tools ?? []); };
  const grantEditor = (item: ConnectorView) => selectedId === item.id && grantBot && <form className="grant-editor" onSubmit={(event) => {
    event.preventDefault(); void action("grant", async () => { await api("connectors/grant", { id: item.id, version: item.version, botId: grantBot, tools: grantTools }); setGrantBot(""); }, "工具授权已更新");
  }}><strong>为 {state.bots.find((bot) => bot.id === grantBot)?.name} 选择工具</strong>{item.tools.map((tool) => <label key={tool.name}><input type="checkbox" checked={grantTools.includes(tool.name)} onChange={(event) => setGrantTools((current) => event.target.checked ? [...current, tool.name] : current.filter((name) => name !== tool.name))}/>{toolLabel(tool.name)}</label>)}<div className="actions"><button className="primary" disabled={!!busy}>保存授权</button><button type="button" onClick={() => setGrantBot("")}>取消</button></div></form>;
  const grants = (item: ConnectorView) => <>
    {state.bots.map((bot) => <div className="connector-agent" key={str(bot.id)}><span><strong>{bot.name}</strong><small>{item.grants.find((grant) => grant.botId === bot.id)?.tools.length ?? 0} 项工具已授权</small></span><button disabled={!!busy || !item.checkedAt || (item.provider === "gmail" && !item.hasToken)} onClick={() => beginGrant(item, str(bot.id))}>管理授权</button></div>)}
    {!state.bots.length && <p className="empty-small">创建助手后可管理授权。</p>}
    {grantEditor(item)}
  </>;
  const remove = (item: ConnectorView) => <div className="connector-remove">{confirmRemove === item.id ? <><span>{item.provider === "gmail" ? "断开此邮箱并移除助手授权？" : "移除连接器及全部工具授权？"}</span><div className="actions"><button className="danger-link" disabled={!!busy} onClick={() => void action("delete", async () => {
    const result = await api<{ warning?: string }>("connectors/delete", { id: item.id, version: item.version }); setConfirmRemove(""); setGrantBot(""); setManagedAccount(""); if (item.provider !== "gmail") setView("catalog"); return result;
  })}>{item.provider === "gmail" ? "确认断开" : "确认移除"}</button><button disabled={!!busy} onClick={() => setConfirmRemove("")}>取消</button></div></> : <button className="text-button danger-link" disabled={!!busy} onClick={() => setConfirmRemove(item.id)}><Trash2 size={14}/>{item.provider === "gmail" ? "断开连接" : "移除连接器"}</button>}</div>;
  const controls = (item: ConnectorView) => <>
    <div className="actions connector-account-actions"><button disabled={!!busy || (item.provider === "gmail" && !item.hasToken)} onClick={() => void action("test", () => api("connectors/test", { id: item.id, version: item.version }), "连接成功")}>{busy === "test" ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>}测试连接</button><button disabled={!!busy} onClick={() => void action("toggle", () => api("connectors/toggle", { id: item.id, version: item.version, enabled: !item.enabled }))}>{item.enabled ? "停用" : "启用"}</button>{item.provider === "gmail" && <GmailConnect connector={{ id: item.id, version: item.version }} available={gmailAvailable && !busy} label="重新授权" variant="subtle" connected={connected}/>}</div>
    {remove(item)}
  </>;
  return <div className="connectors-page" ref={page}>
    {view === "catalog" ? <div className="connector-catalog-heading"><h1>连接器</h1><button onClick={() => { setEditing("new"); setError(""); }}><Plus size={16}/>添加连接器</button></div> : <div className="connector-navigation"><button className="connector-back" onClick={() => { setView("catalog"); setGrantBot(""); setError(""); setNotice(""); }}><ChevronLeft size={20}/>连接器</button></div>}
    {error && <div className="connector-feedback is-error" role="alert">{error}</div>}{notice && <div className="connector-feedback" role="status"><Check size={16}/>{notice}</div>}
    {view === "catalog" && <section className="connector-catalog" aria-label="连接器列表">
      <label className="connector-search"><Search size={16}/><input aria-label="搜索连接器" placeholder="搜索连接器" value={search} onChange={(event) => setSearch(event.target.value)}/></label>
      <div className="connector-catalog-rows">
        {showGmail && <div className="connector-catalog-item"><button className="connector-catalog-row" data-connector="gmail" onClick={() => openDetail("gmail")}><ConnectorIcon gmail/><span className="connector-catalog-copy"><strong>Gmail</strong><span>搜索、读取邮件与会话。</span></span>{(accounts.length > 0 || !gmailAvailable) && <span className={`connector-catalog-state ${accounts.length ? "is-added" : ""}`}>{accounts.length ? <><Check size={17}/>已添加</> : "暂不可用"}</span>}</button>{!accounts.length && gmailAvailable && <GmailConnect available={!busy} label="连接" variant="subtle" connected={connected}/>}</div>}
        {otherConnections.map((item) => <button className="connector-catalog-row" data-connector={item.id} key={item.id} onClick={() => openDetail("mcp", item.id)}><ConnectorIcon/><span className="connector-catalog-copy"><strong>{item.name}</strong><span>MCP 连接器</span></span><span className={`connector-catalog-state ${ready(item) ? "is-added" : ""}`}>{ready(item) && <Check size={17}/>}<span>{connectionStatus(item)}</span></span></button>)}
        {!showGmail && !otherConnections.length && <p className="connector-no-results">没有匹配的连接器</p>}
      </div>
    </section>}
    {view === "gmail" && <section className="connector-detail connector-profile" aria-label="Gmail 连接器详情">
      <div className="connector-profile-heading"><ConnectorIcon gmail/><div><h2 className="connector-profile-title" tabIndex={-1}>Gmail</h2><span>Google</span></div></div>
      <p className="connector-profile-description">搜索、读取邮件与会话。</p>
      <section className="connector-profile-section" aria-labelledby="gmail-accounts-title"><h3 id="gmail-accounts-title">账户</h3><div className="connector-surface connector-accounts">
        {accounts.map((item) => <div className="connector-account" data-account={item.id} key={item.id}>
          <div className="connector-account-heading"><strong>{item.account}</strong><span className={`connection-status ${gmailAvailable && ready(item) ? "is-ready" : ""}`}>{gmailAvailable ? connectionStatus(item) : "暂不可用"}</span><button className="connector-account-menu" aria-label={`管理 ${item.account} 账户`} aria-expanded={managedAccount === item.id} aria-controls={`account-controls-${item.id}`} onClick={() => { setManagedAccount(managedAccount === item.id ? "" : item.id); setConfirmRemove(""); }}><MoreHorizontal size={20}/></button></div>
          {item.error && <p className="connector-account-error" role="alert">{item.error}</p>}
          <div className="connector-account-grants">{grants(item)}</div>
          <div className="connector-account-management" id={`account-controls-${item.id}`} hidden={managedAccount !== item.id}>{managedAccount === item.id && controls(item)}</div>
          {!item.hasToken && managedAccount !== item.id && <GmailConnect connector={{ id: item.id, version: item.version }} available={gmailAvailable && !busy} label="重新授权" variant="subtle" connected={connected}/>}
        </div>)}
        <div className={`connector-account-add ${accounts.length ? "" : "is-empty"}`}><GmailConnect available={gmailAvailable && !busy} label={accounts.length ? "添加其他账户" : "连接 Gmail"} variant={accounts.length ? "text" : "primary"} addAccount={accounts.length > 0} connected={connected}/>{!gmailAvailable && <span className="connector-unavailable">暂时无法连接</span>}</div>
      </div></section>
      <section className="connector-profile-section" aria-labelledby="gmail-tools-title"><h3 id="gmail-tools-title">工具</h3><details className="connector-surface connector-tool-disclosure"><summary><span>{accounts.length ? `可用 ${usableTools.size}/${tools.length} 个` : `${tools.length} 个工具`}</span><ChevronDown size={18}/></summary><div className="connector-capabilities">{tools.map((tool) => <div key={tool.name}><span><strong>{toolLabel(tool.name)}</strong><small>{gmailTools.find((entry) => entry.name === tool.name)?.description ?? tool.description}</small></span>{usableTools.has(tool.name) && <Check size={17} aria-label="可用"/>}</div>)}</div></details></section>
      <section className="connector-profile-section" aria-labelledby="gmail-app-title"><h3 id="gmail-app-title">应用 <span>1</span></h3><div className="connector-surface connector-app-row"><Plug size={22}/><div><strong>Gmail</strong><span>连接器</span></div></div></section>
      <section className="connector-profile-section" aria-labelledby="gmail-info-title"><h3 id="gmail-info-title">信息</h3><dl className="connector-surface connector-information"><div><dt>服务提供方</dt><dd>Google</dd></div><div><dt>访问权限</dt><dd>只读</dd></div><div><dt>类别</dt><dd>邮件</dd></div></dl></section>
    </section>}
    {view === "mcp" && selected && <section className="connector-detail connector-profile connector-mcp-detail" aria-label="连接器详情"><div className="connector-profile-heading"><ConnectorIcon/><div><h2 className="connector-profile-title" tabIndex={-1}>{selected.name}</h2><span className={`connection-status ${ready(selected) ? "is-ready" : ""}`}>{connectionStatus(selected)}</span></div><button className="text-button" disabled={!!busy} onClick={() => setEditing(selected)}>编辑</button></div>
      <dl className="connection-meta"><div><dt>服务地址</dt><dd>{selected.url}</dd></div><div><dt>认证</dt><dd>{selected.hasToken ? "Bearer Token · 已加密保存" : "无需令牌"}</dd></div><div><dt>传输方式</dt><dd>{selected.transport === "sse" ? "SSE" : "Streamable HTTP"}</dd></div></dl>
      <div className="connector-mcp-controls">{controls(selected)}</div>
      {selected.error && <p className="connector-feedback is-error">{selected.error}</p>}
      <div className="detail-section-title"><h3>工具目录</h3><span>{selected.tools.length}</span></div><div className="connector-tools">{selected.tools.map((tool) => <details key={tool.name}><summary><span><strong>{tool.name}</strong><small>{tool.description || "服务未提供工具说明"}</small></span><ChevronRight size={15}/></summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}{!selected.tools.length && <p className="empty-small">测试连接后，工具会显示在这里。</p>}</div>
      <div className="detail-section-title"><h3>助手授权</h3><ShieldCheck size={16}/></div>{grants(selected)}
    </section>}
    {editing && <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape" && !busy) setEditing(null); }}><section ref={modal} className="modal connector-modal" role="dialog" aria-modal="true" aria-labelledby="connector-title"><div className="modal-heading"><h2 id="connector-title">{editing === "new" ? "添加连接器" : "编辑连接器"}</h2><button className="icon-button" disabled={!!busy} aria-label="关闭连接器编辑" onClick={() => setEditing(null)}><X size={18}/></button></div>{error && <p role="alert" className="connector-feedback is-error">{error}</p>}<form onSubmit={save}><label className="field">名称<input name="name" autoFocus required maxLength={80} defaultValue={editing === "new" ? "" : editing.name} placeholder="例如：团队知识库"/></label><label className="field">MCP 服务地址<input name="url" type="url" required defaultValue={editing === "new" ? "" : editing.url} placeholder="https://example.com/mcp"/></label><label className="field">传输方式<select name="transport" defaultValue={editing === "new" ? "http" : editing.transport}><option value="http">Streamable HTTP</option><option value="sse">SSE</option></select></label><label className="field">Bearer Token（选填）<input name="token" type="password" autoComplete="new-password" placeholder={editing !== "new" && editing.hasToken ? "留空保留原令牌；更换地址时需重新填写" : "服务无需认证时留空"}/></label>{editing !== "new" && editing.hasToken && <label className="check-field"><input name="clearToken" type="checkbox"/>清除已保存的令牌</label>}<p className="muted">地址由后端 Core 访问。本机地址指后端所在的电脑。</p><div className="actions"><button className="primary" disabled={!!busy}>{busy === "save" ? "保存中…" : "保存连接器"}</button><button type="button" disabled={!!busy} onClick={() => setEditing(null)}>取消</button></div></form></section></div>}
  </div>;
}
