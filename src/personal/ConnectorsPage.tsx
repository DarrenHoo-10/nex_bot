import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronRight, LoaderCircle, Plug, Plus, RefreshCw, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { api, str, type ConnectorView, type State } from "./api";

export function ConnectorsPage({ state, refresh }: { state: State; refresh(): Promise<void> }) {
  const [editing, setEditing] = useState<ConnectorView | "new" | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [grantBot, setGrantBot] = useState("");
  const [grantTools, setGrantTools] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const modal = useRef<HTMLElement>(null);
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
  const selected = connections.find((item) => item.id === selectedId) ?? connections[0];
  const action = async (key: string, operation: () => Promise<unknown>, success?: string) => {
    setBusy(key); setError(""); setNotice("");
    try { await operation(); await refresh(); if (success) setNotice(success); }
    catch (error) { setError(error instanceof Error ? error.message : "操作失败，请重试"); await refresh().catch(() => {}); }
    finally { setBusy(""); }
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
    const previous = editing && editing !== "new" ? editing : undefined;
    void action("save", async () => { const result = await api<{ id: string }>("connectors/save", { ...values, id: previous?.id, version: previous?.version, enabled: previous?.enabled ?? true, clearToken: values.clearToken === "on" }); form.reset(); setEditing(null); setSelectedId(result.id); setGrantBot(""); }, "已保存。点击“测试连接”获取工具目录。");
  };
  const beginGrant = (botId: string) => { setGrantBot(botId); setGrantTools(selected?.grants.find((grant) => grant.botId === botId)?.tools ?? []); };
  return <div className="connectors-page">
    <div className="page-intro"><div><span className="eyebrow">扩展 Agent 的能力</span><h1>连接器</h1><p>接入 MCP 服务，让 Agent 在对话中使用获准的工具。</p></div><button className="primary" onClick={() => { setEditing("new"); setError(""); }}><Plus size={16}/>添加连接器</button></div>
    {error && <div className="connector-feedback is-error" role="alert">{error}</div>}{notice && <div className="connector-feedback" role="status"><Check size={16}/>{notice}</div>}
    {!connections.length ? <div className="connector-empty"><span className="empty-icon"><Plug size={28}/></span><h2>把常用工具带进对话</h2><p>添加 MCP 服务地址，测试连接后，为需要的 Agent 选择工具。</p><button onClick={() => setEditing("new")}><Plus size={15}/>添加第一个连接器</button><small>支持 Streamable HTTP 与 SSE，可使用 Bearer Token 认证。</small></div> : <div className="connector-layout">
      <section className="connector-list" aria-label="连接器列表"><label className="sidebar-search"><Search size={15}/><input aria-label="搜索连接器" placeholder="搜索连接器" value={search} onChange={(event) => setSearch(event.target.value)}/></label>{connections.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())).map((item) => <button className={`connector-list-item ${selected?.id === item.id ? "is-selected" : ""}`} key={item.id} onClick={() => { setSelectedId(item.id); setGrantBot(""); setConfirmRemove(false); }}><span className="connector-icon"><Plug size={19}/></span><span><strong>{item.name}</strong><small>{!item.enabled ? "已停用" : item.error ? "需要检查" : item.checkedAt ? `${item.tools.length} 个工具` : "尚未测试"}</small></span><ChevronRight size={15}/></button>)}</section>
      {selected && <section className="connector-detail" aria-label="连接器详情"><div className="connector-detail-heading"><span className="connector-icon"><Plug size={22}/></span><div><h2>{selected.name}</h2><span className={`connection-status ${selected.enabled && selected.checkedAt && !selected.error ? "is-ready" : ""}`}>{!selected.enabled ? "已停用" : selected.error ? "连接异常" : selected.checkedAt ? "连接测试通过" : "等待测试"}</span></div><button className="text-button" disabled={!!busy} onClick={() => setEditing(selected)}>编辑</button></div>
        <dl className="connection-meta"><div><dt>服务地址</dt><dd>{selected.url}</dd></div><div><dt>认证</dt><dd>{selected.hasToken ? "Bearer Token · 已加密保存" : "无需令牌"}</dd></div><div><dt>传输方式</dt><dd>{selected.transport === "sse" ? "SSE" : "Streamable HTTP"}</dd></div></dl>
        <div className="actions"><button disabled={!!busy} onClick={() => void action("test", () => api("connectors/test", { id: selected.id, version: selected.version }), "连接成功，工具目录已更新。")}>{busy === "test" ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>}测试连接</button><button disabled={!!busy} onClick={() => void action("toggle", () => api("connectors/toggle", { id: selected.id, version: selected.version, enabled: !selected.enabled }))}>{selected.enabled ? "停用" : "启用"}</button></div>
        {selected.error && <p className="connector-feedback is-error">{selected.error}</p>}
        <div className="detail-section-title"><h3>工具目录</h3><span>{selected.tools.length}</span></div>
        <div className="connector-tools">{selected.tools.map((tool) => <details key={tool.name}><summary><span><strong>{tool.name}</strong><small>{tool.description || "服务未提供工具说明"}</small></span><ChevronRight size={15}/></summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}{!selected.tools.length && <p className="empty-small">测试连接后，工具会显示在这里。</p>}</div>
        <div className="detail-section-title"><h3>Agent 授权</h3><ShieldCheck size={16}/></div><p className="muted">只开放选中的工具。实际调用会在该 Agent 的对话中请求批准。</p>
        {state.bots.map((bot) => <div className="connector-agent" key={str(bot.id)}><span><strong>{bot.name}</strong><small>{selected.grants.find((grant) => grant.botId === bot.id)?.tools.length ?? 0} 项工具已授权</small></span><button disabled={!!busy || !selected.checkedAt} onClick={() => beginGrant(str(bot.id))}>管理授权</button></div>)}
        {!state.bots.length && <p className="empty-small">创建 Agent 后，可以在这里授权。</p>}
        {grantBot && <form className="grant-editor" onSubmit={(event) => { event.preventDefault(); void action("grant", async () => { await api("connectors/grant", { id: selected.id, version: selected.version, botId: grantBot, tools: grantTools }); setGrantBot(""); }, "工具授权已更新。"); }}><strong>为 {state.bots.find((bot) => bot.id === grantBot)?.name} 选择工具</strong>{selected.tools.map((tool) => <label key={tool.name}><input type="checkbox" checked={grantTools.includes(tool.name)} onChange={(event) => setGrantTools((current) => event.target.checked ? [...current, tool.name] : current.filter((name) => name !== tool.name))}/>{tool.name}</label>)}<div className="actions"><button className="primary" disabled={!!busy}>保存授权</button><button type="button" onClick={() => setGrantBot("")}>取消</button></div></form>}
        <div className="connector-remove">{confirmRemove ? <><span>移除连接器及全部工具授权？</span><button className="danger-link" disabled={!!busy} onClick={() => void action("delete", async () => { await api("connectors/delete", { id: selected.id, version: selected.version }); setConfirmRemove(false); setGrantBot(""); })}>确认移除</button><button onClick={() => setConfirmRemove(false)}>取消</button></> : <button className="text-button danger-link" onClick={() => setConfirmRemove(true)}><Trash2 size={14}/>移除连接器</button>}</div>
      </section>}
    </div>}
    {editing && <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape" && !busy) setEditing(null); }}><section ref={modal} className="modal connector-modal" role="dialog" aria-modal="true" aria-labelledby="connector-title"><div className="modal-heading"><h2 id="connector-title">{editing === "new" ? "添加连接器" : "编辑连接器"}</h2><button className="icon-button" disabled={!!busy} aria-label="关闭连接器编辑" onClick={() => setEditing(null)}><X size={18}/></button></div>{error && <p role="alert" className="connector-feedback is-error">{error}</p>}<form onSubmit={save}><label className="field">名称<input name="name" autoFocus required maxLength={80} defaultValue={editing === "new" ? "" : editing.name} placeholder="例如：团队知识库"/></label><label className="field">MCP 服务地址<input name="url" type="url" required defaultValue={editing === "new" ? "" : editing.url} placeholder="https://example.com/mcp"/></label><label className="field">传输方式<select name="transport" defaultValue={editing === "new" ? "http" : editing.transport}><option value="http">Streamable HTTP</option><option value="sse">SSE</option></select></label><label className="field">Bearer Token（选填）<input name="token" type="password" autoComplete="new-password" placeholder={editing !== "new" && editing.hasToken ? "留空保留原令牌；更换地址时需重新填写" : "服务无需认证时留空"}/></label>{editing !== "new" && editing.hasToken && <label className="check-field"><input name="clearToken" type="checkbox"/>清除已保存的令牌</label>}<p className="muted">地址由后端 Core 访问。本机地址指后端所在的电脑。</p><div className="actions"><button className="primary" disabled={!!busy}>{busy === "save" ? "保存中…" : "保存连接器"}</button><button type="button" disabled={!!busy} onClick={() => setEditing(null)}>取消</button></div></form></section></div>}
  </div>;
}
