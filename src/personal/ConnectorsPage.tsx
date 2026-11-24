import { userErrorText } from "../lib/http-errors";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, MoreHorizontal, Plug, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { api, type ConnectorView, type State } from "./api";
import type { ConnectorMonitorView, MonitorCiMode } from "../../shared/personal-connectors";
import { FeishuCard, FeishuLogo, FeishuStatus } from "./FeishuCard";
import { FeishuAppDetail, type FeishuGroupCache } from "./FeishuAppDetail";
import { GmailConnect } from "./GmailConnect";
import { GithubConnect } from "./GithubConnect";
import gmailIcon from "./assets/gmail.png";
import githubMark from "./assets/github-mark.svg";
import "./connectors.css";

const gmailTools = [
  { name: "gmail.search", label: "搜索邮件", description: "按关键词、发件人和时间查找邮件。" },
  { name: "gmail.read", label: "读取邮件", description: "查看邮件正文与附件信息。" },
  { name: "gmail.thread", label: "读取邮件会话", description: "查看同一会话中的往来邮件。" },
];
const githubTools = [
  { name: "github.repos", label: "列出仓库", description: "查看你有权访问的仓库。" },
  { name: "github.pr.list", label: "列出 PR", description: "查看仓库的 Pull Request。" },
  { name: "github.pr", label: "读取 PR", description: "查看 PR 详情与评审状态。" },
  { name: "github.pr.checks", label: "查看 CI", description: "读取 PR 的检查结果与失败日志。" },
  { name: "github.issues.list", label: "列出 issue", description: "查看仓库的 issue。" },
  { name: "github.issue", label: "读取 issue", description: "查看 issue 详情。" },
  { name: "github.notifications", label: "读取通知", description: "查看未读的 GitHub 通知。" },
  { name: "github.actions.runs", label: "查看 Actions", description: "列出 workflow 运行记录。" },
  { name: "github.actions.log", label: "查看日志", description: "读取 workflow job 的日志尾部。" },
  { name: "github.search", label: "搜索", description: "全站搜索 issue 与 PR。" },
  { name: "github.comment", label: "评论", description: "在 issue 或 PR 下评论。" },
  { name: "github.review", label: "评审", description: "提交 approve 或 request changes。" },
  { name: "github.merge", label: "合并", description: "合并一个 PR。" },
  { name: "github.issue.create", label: "新建 issue", description: "在仓库新建 issue。" },
];
const toolLabel = (name: string) => [...gmailTools, ...githubTools].find((tool) => tool.name === name)?.label ?? name;
const ready = (item: ConnectorView) => item.enabled && !!item.checkedAt && !item.error && (item.provider === "mcp" || item.hasToken);
const connectionStatus = (item: ConnectorView) => !item.enabled ? "已停用" : item.provider === "gmail" && !item.hasToken ? "需要重新授权" : item.provider === "github" && !item.hasToken ? "需要重新授权" : item.error ? "连接异常" : item.checkedAt ? item.provider === "mcp" ? "连接测试通过" : "已连接" : "等待测试";
const ConnectorIcon = ({ gmail = false, github = false }: { gmail?: boolean; github?: boolean }) => <span className={`connector-icon ${gmail ? "is-gmail" : github ? "is-github" : ""}`} aria-hidden="true">{gmail ? <img src={gmailIcon} alt="" width="48" height="48"/> : github ? <img src={githubMark} alt="" width="48" height="48"/> : <Plug size={24}/>}</span>;

export function ConnectorsPage({ state, refresh }: { state: State; refresh(): Promise<void> }) {
  const groupsCache = useMemo<FeishuGroupCache>(() => new Map(), [state.sync.coreId, state.sync.bootId, state.sync.privacyEpoch]);
  const [view, setView] = useState<"catalog" | "gmail" | "github" | "mcp" | "feishu">(() => typeof location !== "undefined" && new URLSearchParams(location.search).get("settings") === "feishu" ? "feishu" : "catalog");
  const [feishuAppId, setFeishuAppId] = useState("");
  const [editing, setEditing] = useState<ConnectorView | "new" | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [managedAccount, setManagedAccount] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  const [monitorEditor, setMonitorEditor] = useState<{ connectorId: string; existing?: ConnectorMonitorView } | null>(null);
  const [webhookNote, setWebhookNote] = useState("");
  const modal = useRef<HTMLElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const returnTo = useRef("gmail");
  const previousView = useRef(view);
  useEffect(() => {
    const back = (event: Event) => {
      if (!editing && !confirmRemove && !managedAccount && view === "catalog") return;
      event.stopImmediatePropagation();
      if (busy) return;
      if (editing) setEditing(null);
      else if (confirmRemove) setConfirmRemove("");
      else if (managedAccount) setManagedAccount("");
      else if (feishuAppId) setFeishuAppId("");
      else { setView("catalog"); setError(""); setNotice(""); }
    };
    window.addEventListener("nex-android-back", back, true);
    return () => window.removeEventListener("nex-android-back", back, true);
  }, [editing, confirmRemove, managedAccount, feishuAppId, view, busy]);
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
  // Gmail 与 GitHub 各自成组；其余全部是通用 MCP 连接器。
  const accounts = (state.connectors ?? []).filter((item) => item.provider === "gmail");
  const githubAccounts = (state.connectors ?? []).filter((item) => item.provider === "github");
  const feishuApps = state.feishu?.apps ?? [];
  const connections = (state.connectors ?? []).filter((item) => item.provider === "mcp" && item.kind !== "feishu" && !feishuApps.some((app) => app.id === item.id));
  const feishuApp = feishuApps.find((app) => app.id === feishuAppId);
  const feishuIssues = feishuApps.filter((app) => app.status === "error" || app.status === "busy").length;
  const showFeishu = `飞书 feishu lark ${feishuApps.map((app) => `${app.name ?? ""} ${app.appId}`).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase());
  const selected = connections.find((item) => item.id === selectedId);
  const gmailAvailable = state.connectorCatalog?.find((item) => item.id === "gmail")?.available === true;
  const githubAvailable = state.connectorCatalog?.find((item) => item.id === "github")?.available === true;
  const query = search.trim().toLowerCase();
  const showGmail = `gmail google 邮箱 邮件 ${accounts.map((item) => item.account).join(" ")}`.toLowerCase().includes(query);
  const showGithub = `github 仓库 pr ci issue ${githubAccounts.map((item) => item.account).join(" ")}`.toLowerCase().includes(query);
  const otherConnections = connections.filter((item) => `${item.name} ${item.url}`.toLowerCase().includes(query));
  const tools = accounts[0]?.tools ?? gmailTools;
  const githubToolList = githubAccounts[0]?.tools ?? githubTools;
  const githubConnectorIds = new Set(githubAccounts.map((item) => item.id));
  const usableTools = new Set(gmailAvailable ? accounts.filter(ready).flatMap((item) => item.tools.map((tool) => tool.name)) : []);
  const usableGithubTools = new Set(githubAccounts.filter(ready).flatMap((item) => item.tools.map((tool) => tool.name)));
  const openDetail = (provider: "gmail" | "github" | "mcp" | "feishu", id = "") => {
    returnTo.current = provider === "mcp" ? id : provider;
    setView(provider); setSelectedId(id); setFeishuAppId(""); setManagedAccount(""); setConfirmRemove(""); setError(""); setNotice("");
  };
  const connected = async (id: string) => { setSelectedId(id); setConfirmRemove(""); await refresh(); setNotice("Gmail 已连接"); };
  const githubConnected = async (id: string) => { setSelectedId(id); setConfirmRemove(""); await refresh(); setNotice("GitHub 已连接"); };
  const action = async (key: string, operation: () => Promise<unknown>, success?: string) => {
    setBusy(key); setError(""); setNotice("");
    try { const result = await operation() as { warning?: string } | undefined; await refresh(); if (result?.warning || success) setNotice(result?.warning ?? success ?? ""); }
    catch (failure) { setError(userErrorText(failure, "操作失败，请重试")); await refresh().catch(() => {}); }
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
  const ciModeLabel: Record<MonitorCiMode, string> = { default_branch: "仅默认分支", mine: "我的 PR", all: "全部 PR", off: "关闭" };
  const botName = (id: string) => String((state.bots ?? []).find((bot) => bot.id === id)?.name ?? id);
  const monitorSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const existing = monitorEditor?.existing;
    void action("monitor-save", async () => {
      const saved = await api<ConnectorMonitorView & { webhookSecret?: string; webhookPath?: string }>("connector-monitors/save", {
        id: existing?.id, version: existing?.version, connectorId: monitorEditor?.connectorId, name: values.name, botId: values.botId,
        repos: (values.repos ?? "").split(/[\s,]+/).filter(Boolean),
        ciMode: values.ciMode, delivery: values.delivery, intervalSeconds: Number(values.intervalSeconds),
        mutedRepos: (values.mutedRepos ?? "").split(/[\s,]+/).filter(Boolean), ignoreBranches: (values.ignoreBranches ?? "").split(/[\s,]+/).filter(Boolean),
        enableWebhook: values.webhook === "on", regenerateWebhookSecret: values.regenerate === "on",
      });
      form.reset(); setMonitorEditor(null);
      if (saved.webhookSecret) setWebhookNote(`Webhook 地址：${window.location.origin}${saved.webhookPath}
密钥（仅显示一次）：${saved.webhookSecret}`);
      else setWebhookNote("");
    }, "监视已保存");
  };
  const savePat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form)) as { token?: string };
    if (!values.token) return;
    void action("pat", async () => {
      const saved = await api<{ id: string; version: number }>("connectors/save", { provider: "github", token: values.token });
      await api("connectors/test", { id: saved.id, version: saved.version });
      form.reset();
    }, "GitHub 已连接");
  };
  const remove = (item: ConnectorView) => <div className="connector-remove">{confirmRemove === item.id ? <><span>{item.provider === "gmail" ? "断开此邮箱？" : item.provider === "github" ? "断开此连接？" : "移除连接器？"}</span><div className="actions"><button className="danger-link" disabled={!!busy} onClick={() => void action("delete", async () => {
    const result = await api<{ warning?: string }>("connectors/delete", { id: item.id, version: item.version }); setConfirmRemove(""); setManagedAccount(""); if (item.provider === "mcp") setView("catalog"); return result;
  })}>{item.provider === "mcp" ? "确认移除" : "确认断开"}</button><button disabled={!!busy} onClick={() => setConfirmRemove("")}>取消</button></div></> : <button className="text-button danger-link" disabled={!!busy} onClick={() => setConfirmRemove(item.id)}><Trash2 size={14}/>{item.provider === "mcp" ? "移除连接器" : "断开连接"}</button>}</div>;
  const controls = (item: ConnectorView) => <>
    <div className="actions connector-account-actions"><button disabled={!!busy || (item.provider !== "mcp" && !item.hasToken)} onClick={() => void action("test", () => api("connectors/test", { id: item.id, version: item.version }), "连接成功")}>{busy === "test" ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>}测试连接</button><button disabled={!!busy} onClick={() => void action("toggle", () => api("connectors/toggle", { id: item.id, version: item.version, enabled: !item.enabled }))}>{item.enabled ? "停用" : "启用"}</button>{item.provider === "gmail" && <GmailConnect connector={{ id: item.id, version: item.version }} available={gmailAvailable && !busy} label="重新授权" variant="subtle" connected={connected}/>}{item.provider === "github" && <GithubConnect connector={{ id: item.id, version: item.version }} available={githubAvailable && !busy} label="重新授权" variant="subtle" connected={githubConnected}/>}</div>
    {remove(item)}
  </>;
  return <div className="connectors-page" ref={page}>
    {view === "catalog" ? <div className="connector-catalog-heading"><h1>连接器</h1><button onClick={() => { setEditing("new"); setError(""); }}><Plus size={16}/>添加连接器</button></div> : <div className="connector-navigation">{view === "feishu" && feishuApp ? <button className="connector-back" onClick={() => setFeishuAppId("")}><ChevronLeft size={20}/>飞书</button> : <button className="connector-back" onClick={() => { setView("catalog"); setFeishuAppId(""); setError(""); setNotice(""); }}><ChevronLeft size={20}/>连接器</button>}</div>}
    {error && <div className="connector-feedback is-error" role="alert">{error}</div>}{notice && <div className="connector-feedback" role="status"><Check size={16}/>{notice}</div>}
    {view === "feishu" && (feishuApp ? <FeishuAppDetail key={feishuApp.id} app={feishuApp} bots={state.bots} cache={groupsCache} refresh={refresh}/> : <FeishuCard state={state} refresh={refresh} onOpenApp={setFeishuAppId}/>)}
    {view === "catalog" && <section className="connector-catalog" aria-label="连接器列表">
      <label className="connector-search"><Search size={16}/><input aria-label="搜索连接器" placeholder="搜索连接器" value={search} onChange={(event) => setSearch(event.target.value)}/></label>
      <div className="connector-catalog-rows">
        {showGmail && <div className="connector-catalog-item"><button className="connector-catalog-row" data-connector="gmail" onClick={() => openDetail("gmail")}><ConnectorIcon gmail/><span className="connector-catalog-copy"><strong>Gmail</strong><span>搜索、读取邮件与会话。</span></span>{(accounts.length > 0 || !gmailAvailable) && <span className={`connector-catalog-state ${accounts.length ? "is-added" : ""}`}>{accounts.length ? <><Check size={17}/>已添加</> : "暂不可用"}</span>}</button>{!accounts.length && gmailAvailable && <GmailConnect available={!busy} label="连接" variant="subtle" connected={connected}/>}</div>}
        {showGithub && <div className="connector-catalog-item"><button className="connector-catalog-row" data-connector="github" onClick={() => openDetail("github")}><ConnectorIcon github/><span className="connector-catalog-copy"><strong>GitHub</strong><span>仓库、PR、CI 与 issue。</span></span>{githubAccounts.length > 0 && <span className="connector-catalog-state is-added"><Check size={17}/>已添加</span>}</button>{!githubAccounts.length && <GithubConnect available={githubAvailable && !busy} label="连接" variant="subtle" connected={githubConnected}/>}</div>}
        {showFeishu && <button className="connector-catalog-row" data-connector="feishu" onClick={() => openDetail("feishu")}><FeishuLogo/><span className="connector-catalog-copy"><strong>飞书</strong><span>{feishuApps.length ? `${feishuApps.length} 个应用 · ${[...new Set(feishuApps.map((app) => app.botName))].join("、")}` : "接收和回复飞书消息"}</span></span>{feishuApps.length > 0 && (feishuIssues ? <span className="connector-catalog-state is-error">{feishuIssues} 个异常</span> : feishuApps.some((app) => app.status === "connected") ? <span className="connector-catalog-state is-added"><Check size={17}/>已连接</span> : <span className="connector-catalog-state"><FeishuStatus status={feishuApps[0].status}/></span>)}</button>}
        {otherConnections.map((item) => <button className="connector-catalog-row" data-connector={item.id} key={item.id} onClick={() => openDetail("mcp", item.id)}><ConnectorIcon/><span className="connector-catalog-copy"><strong>{item.name}</strong><span>MCP 连接器</span></span><span className={`connector-catalog-state ${ready(item) ? "is-added" : ""}`}>{ready(item) && <Check size={17}/>}<span>{connectionStatus(item)}</span></span></button>)}
        {!showGmail && !showGithub && !showFeishu && !otherConnections.length && <p className="connector-no-results">没有匹配的连接器</p>}
      </div>
    </section>}
    {view === "gmail" && <section className="connector-detail connector-profile" aria-label="Gmail 连接器详情">
      <div className="connector-profile-heading"><ConnectorIcon gmail/><div><h2 className="connector-profile-title" tabIndex={-1}>Gmail</h2><span>Google</span></div></div>
      <p className="connector-profile-description">搜索、读取邮件与会话。</p>
      <section className="connector-profile-section" aria-labelledby="gmail-accounts-title"><h3 id="gmail-accounts-title">账户</h3><div className="connector-surface connector-accounts">
        {accounts.map((item) => <div className="connector-account" data-account={item.id} key={item.id}>
          <div className="connector-account-heading"><strong>{item.account}</strong><span className={`connection-status ${gmailAvailable && ready(item) ? "is-ready" : ""}`}>{gmailAvailable ? connectionStatus(item) : "暂不可用"}</span><button className="connector-account-menu" aria-label={`管理 ${item.account} 账户`} aria-expanded={managedAccount === item.id} aria-controls={`account-controls-${item.id}`} onClick={() => { setManagedAccount(managedAccount === item.id ? "" : item.id); setConfirmRemove(""); }}><MoreHorizontal size={20}/></button></div>
          {item.error && <p className="connector-account-error" role="alert">{item.error}</p>}
          <div className="connector-account-management" id={`account-controls-${item.id}`} hidden={managedAccount !== item.id}>{managedAccount === item.id && controls(item)}</div>
          {!item.hasToken && managedAccount !== item.id && <GmailConnect connector={{ id: item.id, version: item.version }} available={gmailAvailable && !busy} label="重新授权" variant="subtle" connected={connected}/>}
        </div>)}
        <div className={`connector-account-add ${accounts.length ? "" : "is-empty"}`}><GmailConnect available={gmailAvailable && !busy} label={accounts.length ? "添加其他账户" : "连接 Gmail"} variant={accounts.length ? "text" : "primary"} addAccount={accounts.length > 0} connected={connected}/>{!gmailAvailable && <span className="connector-unavailable">暂时无法连接</span>}</div>
      </div></section>
      <section className="connector-profile-section" aria-labelledby="gmail-tools-title"><h3 id="gmail-tools-title">工具</h3><details className="connector-surface connector-tool-disclosure"><summary><span>{accounts.length ? `可用 ${usableTools.size}/${tools.length} 个` : `${tools.length} 个工具`}</span><ChevronDown size={18}/></summary><div className="connector-capabilities">{tools.map((tool) => <div key={tool.name}><span><strong>{toolLabel(tool.name)}</strong><small>{gmailTools.find((entry) => entry.name === tool.name)?.description ?? tool.description}</small></span>{usableTools.has(tool.name) && <Check size={17} aria-label="可用"/>}</div>)}</div></details></section>
      <section className="connector-profile-section" aria-labelledby="gmail-app-title"><h3 id="gmail-app-title">应用 <span>1</span></h3><div className="connector-surface connector-app-row"><Plug size={22}/><div><strong>Gmail</strong><span>连接器</span></div></div></section>
      <section className="connector-profile-section" aria-labelledby="gmail-info-title"><h3 id="gmail-info-title">信息</h3><dl className="connector-surface connector-information"><div><dt>服务提供方</dt><dd>Google</dd></div><div><dt>访问权限</dt><dd>只读</dd></div><div><dt>类别</dt><dd>邮件</dd></div></dl></section>
    </section>}
    {view === "github" && <section className="connector-detail connector-profile" aria-label="GitHub 连接器详情">
      <div className="connector-profile-heading"><ConnectorIcon github/><div><h2 className="connector-profile-title" tabIndex={-1}>GitHub</h2><span>github.com</span></div></div>
      <p className="connector-profile-description">仓库、PR、CI 与 issue。</p>
      <section className="connector-profile-section" aria-labelledby="github-accounts-title"><h3 id="github-accounts-title">账户</h3><div className="connector-surface connector-accounts">
        {githubAccounts.map((item) => <div className="connector-account" data-account={item.id} key={item.id}>
          <div className="connector-account-heading"><strong>{item.account ?? "令牌连接"}</strong><span className={`connection-status ${ready(item) ? "is-ready" : ""}`}>{connectionStatus(item)}</span><button className="connector-account-menu" aria-label={`管理 ${item.account ?? "令牌"} 账户`} aria-expanded={managedAccount === item.id} aria-controls={`account-controls-${item.id}`} onClick={() => { setManagedAccount(managedAccount === item.id ? "" : item.id); setConfirmRemove(""); }}><MoreHorizontal size={20}/></button></div>
          {item.error && <p className="connector-account-error" role="alert">{item.error}</p>}
          <div className="connector-account-management" id={`account-controls-${item.id}`} hidden={managedAccount !== item.id}>{managedAccount === item.id && controls(item)}</div>
          {!item.hasToken && managedAccount !== item.id && <GithubConnect connector={{ id: item.id, version: item.version }} available={githubAvailable && !busy} label="重新授权" variant="subtle" connected={githubConnected}/>}
        </div>)}
        <div className={`connector-account-add ${githubAccounts.length ? "" : "is-empty"}`}>
          <GithubConnect available={githubAvailable && !busy} label={githubAccounts.length ? "添加其他账户" : "连接 GitHub"} variant={githubAccounts.length ? "text" : "primary"} addAccount={githubAccounts.length > 0} connected={githubConnected}/>
          <form className="connector-pat" onSubmit={savePat}><input name="token" type="password" autoComplete="new-password" placeholder="或粘贴个人令牌（PAT）" required/><button disabled={!!busy}>{busy === "pat" ? "连接中…" : "用令牌连接"}</button></form>
        </div>
      </div></section>
      <section className="connector-profile-section" aria-labelledby="github-tools-title"><h3 id="github-tools-title">工具</h3><details className="connector-surface connector-tool-disclosure"><summary><span>{githubAccounts.length ? `可用 ${usableGithubTools.size}/${githubToolList.length} 个` : `${githubToolList.length} 个工具`}</span><ChevronDown size={18}/></summary><div className="connector-capabilities">{githubToolList.map((tool) => <div key={tool.name}><span><strong>{toolLabel(tool.name)}</strong><small>{githubTools.find((entry) => entry.name === tool.name)?.description ?? tool.description}</small></span>{usableGithubTools.has(tool.name) && <Check size={17} aria-label="可用"/>}</div>)}</div></details></section>
      <section className="connector-profile-section" aria-labelledby="github-monitors-title"><h3 id="github-monitors-title">监视</h3><div className="connector-surface connector-monitors">
        {(state.connectorMonitors ?? []).filter((monitor) => githubConnectorIds.has(monitor.connectorId)).map((monitor) => <div className="connector-account" data-monitor={monitor.id} key={monitor.id}>
          <div className="connector-account-heading"><strong>{monitor.name}</strong><span className={`connection-status ${monitor.enabled && !monitor.lastError ? "is-ready" : ""}`}>{monitor.enabled ? "已启用" : "已停用"}</span><button className="connector-account-menu" aria-label={`管理监视 ${monitor.name}`} aria-expanded={managedAccount === monitor.id} aria-controls={`monitor-controls-${monitor.id}`} onClick={() => { setManagedAccount(managedAccount === monitor.id ? "" : monitor.id); setConfirmRemove(""); }}><MoreHorizontal size={20}/></button></div>
          <p className="connector-monitor-copy">{monitor.repos.join("、")}</p>
          <p className="connector-monitor-copy">{ciModeLabel[monitor.ciMode]} · {monitor.delivery === "task" ? `任务 → ${botName(monitor.botId)}` : `通知 → ${botName(monitor.botId)}`} · 每 {Math.round(monitor.intervalSeconds / 60)} 分钟{monitor.webhookConfigured ? " · Webhook 已配置" : ""}</p>
          {monitor.lastError && <p className="connector-account-error" role="alert">{monitor.lastError}</p>}
          <div className="connector-account-management" id={`monitor-controls-${monitor.id}`} hidden={managedAccount !== monitor.id}>{managedAccount === monitor.id && <div className="actions connector-account-actions"><button disabled={!!busy} onClick={() => void action("monitor-toggle", () => api("connector-monitors/toggle", { id: monitor.id, version: monitor.version, enabled: !monitor.enabled }))}>{monitor.enabled ? "停用" : "启用"}</button><button disabled={!!busy} onClick={() => setMonitorEditor({ connectorId: monitor.connectorId, existing: monitor })}>编辑</button>{confirmRemove === monitor.id ? <><span>删除此监视？</span><button className="danger-link" disabled={!!busy} onClick={() => void action("monitor-delete", () => api("connector-monitors/delete", { id: monitor.id, version: monitor.version }))}>{busy === "monitor-delete" ? "删除中…" : "确认删除"}</button><button disabled={!!busy} onClick={() => setConfirmRemove("")}>取消</button></> : <button className="text-button danger-link" disabled={!!busy} onClick={() => setConfirmRemove(monitor.id)}><Trash2 size={14}/>删除监视</button>}</div>}</div>
        </div>)}
        {!githubAccounts.length && <p className="empty-small">先连接 GitHub 账户，再添加监视。</p>}
        {githubAccounts.length > 0 && <div className={`connector-account-add ${(state.connectorMonitors ?? []).length ? "" : "is-empty"}`}><button className="text-button" disabled={!!busy} onClick={() => setMonitorEditor({ connectorId: githubAccounts[0].id })}><Plus size={15}/>添加监视</button></div>}
      </div></section>
    </section>}
    {view === "mcp" && selected && <section className="connector-detail connector-profile connector-mcp-detail" aria-label="连接器详情"><div className="connector-profile-heading"><ConnectorIcon/><div><h2 className="connector-profile-title" tabIndex={-1}>{selected.name}</h2><span className={`connection-status ${ready(selected) ? "is-ready" : ""}`}>{connectionStatus(selected)}</span></div><button className="text-button" disabled={!!busy} onClick={() => setEditing(selected)}>编辑</button></div>
      <dl className="connection-meta"><div><dt>服务地址</dt><dd>{selected.url}</dd></div><div><dt>认证</dt><dd>{selected.hasToken ? "Bearer Token · 已加密保存" : "无需令牌"}</dd></div><div><dt>传输方式</dt><dd>{selected.transport === "sse" ? "SSE" : "Streamable HTTP"}</dd></div></dl>
      <div className="connector-mcp-controls">{controls(selected)}</div>
      {selected.error && <p className="connector-feedback is-error">{selected.error}</p>}
      <div className="detail-section-title"><h3>工具目录</h3><span>{selected.tools.length}</span></div><div className="connector-tools">{selected.tools.map((tool) => <details key={tool.name}><summary><span><strong>{tool.name}</strong><small>{tool.description || "服务未提供工具说明"}</small></span><ChevronRight size={15}/></summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}{!selected.tools.length && <p className="empty-small">测试连接后，工具会显示在这里。</p>}</div>
    </section>}
    {webhookNote && <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape") setWebhookNote(""); }}><section className="modal connector-modal" role="dialog" aria-modal="true" aria-labelledby="webhook-title"><div className="modal-heading"><h2 id="webhook-title">把 Webhook 配置到 GitHub</h2><button className="icon-button" aria-label="关闭" onClick={() => setWebhookNote("")}><X size={18}/></button></div><p className="muted">在仓库（或组织）Settings → Webhooks 中添加，Content type 选 application/json，事件按需勾选。</p><pre className="connector-webhook-note">{webhookNote}</pre><div className="actions"><button className="primary" onClick={() => setWebhookNote("")}>知道了</button></div></section></div>}
    {monitorEditor && <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape" && !busy) setMonitorEditor(null); }}><section ref={modal} className="modal connector-modal" role="dialog" aria-modal="true" aria-labelledby="monitor-title"><div className="modal-heading"><h2 id="monitor-title">{monitorEditor.existing ? "编辑监视" : "添加监视"}</h2><button className="icon-button" disabled={!!busy} aria-label="关闭监视编辑" onClick={() => setMonitorEditor(null)}><X size={18}/></button></div>{error && <p role="alert" className="connector-feedback is-error">{error}</p>}<form onSubmit={monitorSave}>
      <label className="field">名称<input name="name" autoFocus required maxLength={80} defaultValue={monitorEditor.existing?.name ?? "GitHub 监视"}/></label>
      <label className="field">仓库（每行一个 owner/name）<textarea name="repos" required rows={3} defaultValue={(monitorEditor.existing?.repos ?? []).join("\n")} placeholder={"owner/repo"}/></label>
      <label className="field">CI 提醒范围<select name="ciMode" defaultValue={monitorEditor.existing?.ciMode ?? "mine"}><option value="mine">我的 PR</option><option value="default_branch">仅默认分支</option><option value="all">全部 PR</option><option value="off">关闭</option></select></label>
      <label className="field">投递方式<select name="delivery" defaultValue={monitorEditor.existing?.delivery ?? "notify"}><option value="notify">通知（直达话题）</option><option value="task">任务（助手处理）</option></select></label>
      <label className="field">投递目标助手<select name="botId" required defaultValue={monitorEditor.existing?.botId ?? ""}>{(state.bots ?? []).map((bot) => <option key={String(bot.id)} value={String(bot.id)}>{String(bot.name)}</option>)}</select></label>
      <label className="field">轮询间隔<select name="intervalSeconds" defaultValue={String(monitorEditor.existing?.intervalSeconds ?? 300)}><option value="60">1 分钟</option><option value="300">5 分钟</option><option value="900">15 分钟</option><option value="1800">30 分钟</option><option value="3600">1 小时</option></select></label>
      <label className="field">忽略分支（可选，逗号分隔，支持 *）<input name="ignoreBranches" defaultValue={(monitorEditor.existing?.ignoreBranches ?? []).join(", ")} placeholder="train/*, gh-readonly-queue/*"/></label>
      <label className="field">静音仓库（可选，逗号分隔）<input name="mutedRepos" defaultValue={(monitorEditor.existing?.mutedRepos ?? []).join(", ")} placeholder="owner/repo"/></label>
      {!monitorEditor.existing && <label className="check-field"><input name="webhook" type="checkbox"/>同时生成 Webhook（实时推送，在仓库 Settings 里配置）</label>}
      {monitorEditor.existing?.webhookConfigured && <label className="check-field"><input name="regenerate" type="checkbox"/>重新生成 Webhook 密钥</label>}
      <div className="actions"><button className="primary" disabled={!!busy}>{busy === "monitor-save" ? "保存中…" : "保存监视"}</button><button type="button" disabled={!!busy} onClick={() => setMonitorEditor(null)}>取消</button></div></form></section></div>}
    {editing && <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape" && !busy) setEditing(null); }}><section ref={modal} className="modal connector-modal" role="dialog" aria-modal="true" aria-labelledby="connector-title"><div className="modal-heading"><h2 id="connector-title">{editing === "new" ? "添加连接器" : "编辑连接器"}</h2><button className="icon-button" disabled={!!busy} aria-label="关闭连接器编辑" onClick={() => setEditing(null)}><X size={18}/></button></div>{error && <p role="alert" className="connector-feedback is-error">{error}</p>}<form onSubmit={save}><label className="field">名称<input name="name" autoFocus required maxLength={80} defaultValue={editing === "new" ? "" : editing.name} placeholder="例如：团队知识库"/></label><label className="field">MCP 服务地址<input name="url" type="url" required defaultValue={editing === "new" ? "" : editing.url} placeholder="https://example.com/mcp"/></label><label className="field">传输方式<select name="transport" defaultValue={editing === "new" ? "http" : editing.transport}><option value="http">Streamable HTTP</option><option value="sse">SSE</option></select></label><label className="field">Bearer Token（选填）<input name="token" type="password" autoComplete="new-password" placeholder={editing !== "new" && editing.hasToken ? "留空保留原令牌；更换地址时需重新填写" : "服务无需认证时留空"}/></label>{editing !== "new" && editing.hasToken && <label className="check-field"><input name="clearToken" type="checkbox"/>清除已保存的令牌</label>}<p className="muted">地址由后端 Core 访问。本机地址指后端所在的电脑。</p><div className="actions"><button className="primary" disabled={!!busy}>{busy === "save" ? "保存中…" : "保存连接器"}</button><button type="button" disabled={!!busy} onClick={() => setEditing(null)}>取消</button></div></form></section></div>}
  </div>;
}
