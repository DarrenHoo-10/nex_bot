import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, AtSign, Check, ChevronDown, Clock, Copy, CornerUpLeft, Cpu, FileText, Folder, Info, Palette, Pin, Play, Plus, PanelLeft, Plug, Share2, Shield, Sparkles, Square, Trash2, X, Zap } from "lucide-react";
import { api, desktop, statuses, str, taskPhrase, toolLabels, type PreviewItem, type RecordRow, type State, type ToolStep } from "./api";
import { useAccount } from "./auth";
import { BotMark, lookOf } from "./characters";
import { Confirm, Devices, Editor, SettingsPage } from "./panels";
import { AvatarPicker } from "./components/AvatarPicker";
import { AgentAvatar as Avatar } from "./components/AgentAvatar";
import { ContactSidebar } from "./components/ContactSidebar";
import { ConnectorsPage } from "./ConnectorsPage";
import { ToolActivityDisclosure } from "./vendor/rakazo/ToolActivityDisclosure";
import { MemoryWorkbench } from "./MemoryWorkbench";

const terminal = ["succeeded", "failed", "cancelled", "rejected"];
const formatTime = (value: RecordRow[string]) => value ? new Date(Number(value)).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const formatShortTime = (value: RecordRow[string]) => {
  if (!value) return "";
  const date = new Date(Number(value)), now = new Date();
  return date.toDateString() === now.toDateString() ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
};
const formatDay = (value: RecordRow[string]) => {
  if (!value) return "";
  const date = new Date(Number(value)), now = new Date();
  if (date.toDateString() === now.toDateString()) return "今天";
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
};

function AgentPolicyEditor({ bot, close, save }: { bot: RecordRow; close: () => void; save: (tools: string[]) => Promise<unknown> }) {
  const [tools, setTools] = useState<string[]>(JSON.parse(str(bot.policy_json) || "{}").tools ?? []);
  const labels: Record<string, string> = { "memory.search": "检索自身与共享记忆", "memory.reflect": "综合记忆并引用来源", "memory.read": "读取自身与共享记忆", "memory.write": "维护自身私有记忆", "memory.delete": "撤回自身私有记忆（需批准）", "memory.forget": "彻底遗忘相关原文与副本（需批准）", "routine.list": "查看自己的计划", "routine.save": "安排或修改自己的计划", "routine.toggle": "暂停或恢复自己的计划", "routine.run": "立即运行自己的计划", "agent.directory": "读取 Agent 公开目录", "agent.delegate": "联系同伴", "agent.create": "按指示招募新同伴", "agent.update": "按指示更新同伴资料", "device.list": "查看已授权设备目录", "device.read": "读取已授权设备文件", "device.exec": "执行设备终端命令", "device.inventory": "识别设备与在线状态", "device.info": "读取设备系统信息", "device.computer": "使用获准的电脑窗口", "connector.list": "查看已授权连接器", "connector.tools": "查看连接器工具", "connector.call": "调用连接器工具（需批准）", "skill.list": "查看通用技能目录", "skill.read": "阅读通用技能说明" };
  return <><div className="modal-heading"><h2>{bot.name} 的工具权限</h2><button aria-label="关闭" onClick={close}><X size={18}/></button></div><form onSubmit={(event) => { event.preventDefault(); void save(tools); }}><div className="policy-grid">{Object.entries(labels).map(([action, label]) => <label className="check-field" key={action}><input type="checkbox" checked={tools.includes(action)} onChange={(event) => setTools((current) => event.target.checked ? [...current, action] : current.filter((tool) => tool !== action))}/>{label}</label>)}</div><p className="muted">设备还须在本机授权。终端命令由这个 Agent 逐次申请批准；联系同伴和普通记忆操作自动执行。</p><div className="actions"><button className="primary">保存</button><button type="button" onClick={close}>取消</button></div></form></>;
}

const filePathPattern = /^(?:[\w.-]+[\\/])*[\w.-]+\.(?:md|txt|json|csv|yaml|yml|ts|tsx|js|jsx|mjs|py|sql|log|html|css|sh|ps1|toml|xml)$/i;
function RichText({ value, onPreviewFile }: { value: string; onPreviewFile?: (path: string) => void }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt ?? "图片"}</span>, a: ({ href, children }) => <a href={href} onClick={(e) => { e.preventDefault(); if (href && /^https?:\/\//.test(href)) void desktop?.openExternal(href); }}>{children}</a>, code: ({ className, children }) => { const raw = String(children ?? "").trim(); if (!className && onPreviewFile && filePathPattern.test(raw)) return <button type="button" className="file-chip" onClick={() => onPreviewFile(raw)} title={`在右侧面板预览 ${raw}`}><FileText size={11}/><span>{raw}</span></button>; return <code className={className}>{children}</code>; } }}>{value}</Markdown></div>;
}

export function AgentDesktop() {
  const { status: accountStatus, logout } = useAccount();
  const [state, setState] = useState<State>(), [page, setPage] = useState("agent");
  const [botId, setBotId] = useState(localStorage.getItem("nexbot.selectedAgent") ?? "");
  const [pinned, setPinned] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("nexbot.pinnedAgents") || "[]") as string[]; } catch { return []; } });
  const [dark, setDark] = useState(() => localStorage.getItem("nexbot.dark") === "1");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [composerMenu, setComposerMenu] = useState(false);
  const [lookRevision, setLookRevision] = useState(0);
  const [messages, setMessages] = useState<RecordRow[]>([]), [streaming, setStreaming] = useState<Array<{ taskId: string; text: string }>>([]);
  const [draft, setDraft] = useState(""), [search, setSearch] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [sendingBotId, setSendingBotId] = useState<string>();
  const [connected, setConnected] = useState(true), [detail, setDetail] = useState(() => window.innerWidth > 1040), [tab, setTab] = useState("profile"), [dialog, setDialog] = useState<ReactNode>(null);
  const [quote, setQuote] = useState<{ author: string; text: string }>(), [copiedId, setCopiedId] = useState(""), [exported, setExported] = useState(false);
  const [showScrollPill, setShowScrollPill] = useState(false), [expandBio, setExpandBio] = useState(false), [memoryFilter, setMemoryFilter] = useState<"all" | "bot" | "workspace">("all");
  const [memoryNotice, setMemoryNotice] = useState(""), [atIndex, setAtIndex] = useState(0), [atDismissed, setAtDismissed] = useState(false), [preview, setPreview] = useState<PreviewItem>();
  const [historyLoading, setHistoryLoading] = useState(true);
  const selected = useRef(botId), pageRef = useRef(page), scroll = useRef<HTMLDivElement>(null), composerRef = useRef<HTMLTextAreaElement>(null), serial = useRef(0);
  const stickToBottom = useRef(true), memoryVersions = useRef(new Map<string, string>());
  const loaded = useRef<{ botId: string; messages: RecordRow[]; sync: State["sync"] } | undefined>(undefined);
  const offline = useCallback(() => { ++serial.current; loaded.current = undefined; setConnected(false); setMessages([]); setStreaming([]); setSendingBotId(undefined); setState(undefined); setDialog(null); setError("Core 连接中断，正在重新同步…"); }, []);
  const drafts = useRef(new Map<string, string>()), readPositions = useRef(new Map<string, number>()), retry = useRef<{ botId: string; text: string; id: string } | undefined>(undefined);
  selected.current = botId; pageRef.current = page;

  useEffect(() => {
    document.documentElement.dataset.dark = dark ? "1" : "0";
    localStorage.setItem("nexbot.dark", dark ? "1" : "0");
  }, [dark]);

  const reload = useCallback(async () => {
    const request = ++serial.current, current = selected.current;
    type Feed = { messages: RecordRow[]; streaming: Array<{ taskId: string; text: string }>; sync: State["sync"]; hasMore: boolean };
    const base = `agents/messages?bot=${encodeURIComponent(current)}`;
    // Over a slow link every round trip is visible, so the first page of messages is requested together with the state
    // and checked against the state's sync identity afterwards.
    const guess = loaded.current?.botId === current ? loaded.current : undefined;
    const early = current ? api<Feed>(guess?.messages.length ? `${base}&after=${guess.messages.at(-1)!.seq}` : base) : undefined;
    early?.catch(() => undefined);
    const next = await api<State>("state");
    if (request !== serial.current) return;
    if (memoryVersions.current.size > 0) {
      const updated = next.memories.find((m) => (m.scope === "workspace" || m.bot_id === current) && memoryVersions.current.get(str(m.id)) !== `${m.version}:${m.updated_at}`);
      if (updated) setMemoryNotice(str(updated.title));
    }
    memoryVersions.current = new Map(next.memories.map((m) => [str(m.id), `${m.version}:${m.updated_at}`]));
    if (current && !next.bots.some((bot) => bot.id === current)) { setState(next); setBotId(str(next.bots[0]?.id)); setMessages([]); setStreaming([]); return; }
    if (current) {
      setState(next); setConnected(true);
      const cached = guess;
      const same = cached?.botId === current && cached.sync.privacyEpoch === next.sync.privacyEpoch && cached.sync.coreId === next.sync.coreId && cached.sync.bootId === next.sync.bootId;
      let history = same ? cached.messages : [];
      let feed = await (same || !guess?.messages.length ? early! : api<Feed>(base));
      while (true) {
        if (request !== serial.current || selected.current !== current) return;
        if (feed.sync.privacyEpoch !== next.sync.privacyEpoch || feed.sync.bootId !== next.sync.bootId) { loaded.current = undefined; setMessages([]); setStreaming([]); setState(undefined); setTimeout(() => void reload().catch(offline), 0); return; }
        history = [...history, ...feed.messages];
        if (!feed.hasMore) break;
        feed = await api<Feed>(`${base}&after=${history.at(-1)!.seq}`);
      }
      if (request !== serial.current || selected.current !== current) return;
      loaded.current = { botId: current, messages: history, sync: feed.sync };
      setMessages(history);
      setStreaming(feed.streaming.filter((s) => s.text));
      setHistoryLoading(false);
      const through = Number(history.at(-1)?.seq ?? 0);
      if (pageRef.current === "agent" && document.hasFocus() && through > (readPositions.current.get(current) ?? 0)) {
        readPositions.current.set(current, through);
        void api("agents/read", { botId: current, seq: through }).catch(() => { if (readPositions.current.get(current) === through) readPositions.current.delete(current); });
      }
    }
    if (request === serial.current) { setState(next); setConnected(true); setError(""); setHistoryLoading(false); }
  }, [offline]);
  useEffect(() => {
    // A remembered Agent is loaded by the selection effect below; reloading here too would only be superseded.
    if (!selected.current) void reload().catch((e: Error) => setError(e.message));
    const events = new EventSource("/api/events"); let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void reload().catch(offline); }, 150); };
    const change = (event: MessageEvent) => { const value = JSON.parse(event.data) as State["sync"] & { reset?: boolean }; if (value.reset || (loaded.current && (loaded.current.sync.privacyEpoch !== value.privacyEpoch || loaded.current.sync.bootId !== value.bootId))) { loaded.current = undefined; setMessages([]); setStreaming([]); setState(undefined); setDialog(null); } refresh(); };
    const expired = () => { offline(); events.close(); setError("此设备的登录已过期或被撤销，请重新连接。"); };
    events.addEventListener("change", change as EventListener); events.addEventListener("revoked", () => window.dispatchEvent(new Event("nex-session-expired"))); events.onerror = offline;
    window.addEventListener("nex-session-expired", expired);
    window.addEventListener("focus", refresh);
    const interval = setInterval(refresh, 10_000);
    return () => { clearTimeout(timer); clearInterval(interval); events.close(); window.removeEventListener("focus", refresh); window.removeEventListener("nex-session-expired", expired); };
  }, [reload, offline]);
  useEffect(() => { if (state && !state.bots.some((b) => b.id === botId)) setBotId(str(state.bots[0]?.id)); }, [state, botId]);
  useEffect(() => { stickToBottom.current = true; setShowScrollPill(false); setQuote(undefined); setExpandBio(false); setMemoryNotice(""); setPreview(undefined); setMessages([]); setStreaming([]); setDraft(drafts.current.get(botId) ?? ""); if (botId) { setHistoryLoading(true); localStorage.setItem("nexbot.selectedAgent", botId); void reload().catch((e: Error) => { setError(e.message); setHistoryLoading(false); }); } }, [botId, reload]);
  const openFilePreview = (targetPath: string) => { void api<PreviewItem>(`preview?path=${encodeURIComponent(targetPath)}`).then((item) => { setPreview(item); setDetail(true); }).catch((e: Error) => setError(e.message)); };
  const openStepPreview = (step: ToolStep) => { if (step.tool_name === "device.read" && step.summary) { openFilePreview(step.summary); return; } void api<PreviewItem>(`preview?callId=${encodeURIComponent(step.id)}`).then((item) => { setPreview(item); setDetail(true); }).catch(() => { setPreview({ kind: "tool", id: step.id, title: toolLabels[step.tool_name] ?? step.tool_name, status: step.status, content: step.preview || "暂无输出内容", createdAt: step.created_at }); setDetail(true); }); };
  const run = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } };
  const changeDraft = (value: string) => { setDraft(value); drafts.current.set(botId, value); setAtDismissed(false); setAtIndex(0); };
  const togglePin = (id: string) => setPinned((current) => { const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]; localStorage.setItem("nexbot.pinnedAgents", JSON.stringify(next)); return next; });
  const copyText = (id: string, value: string) => { void navigator.clipboard?.writeText(value); setCopiedId(id); setTimeout(() => setCopiedId((current) => current === id ? "" : current), 1800); };
  const send = (event: FormEvent) => {
    event.preventDefault(); const raw = draft.trim(), target = botId; if (!raw || busy || !state?.bots.some((agent) => agent.id === target)) return;
    const prefix = quote ? `> ${quote.author}：${quote.text.replace(/\s+/g, " ").slice(0, 140)}\n\n` : "";
    const content = prefix + raw;
    if (!retry.current || retry.current.botId !== target || retry.current.text !== content) retry.current = { botId: target, text: content, id: crypto.randomUUID() };
    const clientId = retry.current.id;
    stickToBottom.current = true; setShowScrollPill(false); setSendingBotId(target);
    void run(async () => { await api("agents/input", { botId: target, text: content, clientId }); drafts.current.delete(target); if (selected.current === target) { setDraft(""); setQuote(undefined); } retry.current = undefined; }).finally(() => setSendingBotId(undefined));
  };
  const bot = state?.bots.find((b) => b.id === botId), tasks = state?.tasks.filter((t) => t.bot_id === botId && !terminal.includes(str(t.status))) ?? [];
  const processing = connected && !streaming.length && (sendingBotId === botId || tasks.some((task) => ["queued", "running", "cancelling"].includes(str(task.status))));
  useEffect(() => { if (stickToBottom.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [botId, messages.at(-1)?.id, streaming.map((s) => s.text).join(""), processing]);
  const descendantTasks = new Set(tasks.map((task) => task.id));
  for (let depth = 0; depth < 3; depth++) for (const link of state?.delegations ?? []) if (descendantTasks.has(link.parent_task_id)) descendantTasks.add(link.child_task_id);
  const waitingPeers = state?.approvals.filter((approval) => approval.bot_id !== botId && descendantTasks.has(approval.task_id)) ?? [];
  const peers = state?.bots.filter((b) => b.id !== botId) ?? [];
  const atMatch = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  const matchingPeers = atMatch && !atDismissed ? peers.filter((p) => str(p.name).toLowerCase().includes(atMatch[1].toLowerCase())) : [];
  const applyMention = (name: string) => {
    const next = draft.replace(/@([^\s@]*)$/, `@${name} `);
    changeDraft(next); setAtDismissed(true); composerRef.current?.focus();
  };
  const closeDialog = () => setDialog(null), select = (target: string) => { setBotId(target); setMemoryFilter("all"); setPage("agent"); setSidebarOpen(false); setError(""); };
  const editAvatar = () => setDialog(<AvatarPicker botId={botId} name={str(state?.bots.find((item) => item.id === botId)?.name)} onChange={() => setLookRevision((value) => value + 1)} close={closeDialog}/>);
  const editBot = (existing?: RecordRow) => setDialog(<Editor title={existing ? "Agent 身份" : "添加 Agent"} onClose={closeDialog} fields={[{ name: "name", label: "名字", value: str(existing?.name), required: true }, { name: "instructions", label: "补充身份、职责与沟通方式（选填）", value: str(existing?.instructions), multiline: true, hint: "名字也是身份的一部分，留空也可以。修改后，其他 Agent 会自动获取最新资料。" }]} onSubmit={(data) => run(async () => { const result = await api<{ id: string }>(existing ? "bots/update" : "bots", { ...data, id: existing?.id, version: existing?.version }); if (!existing) select(result.id); closeDialog(); })}/>);
  const editMemory = (existing?: RecordRow) => setDialog(<Editor title={existing ? "编辑记忆" : "添加记忆"} onClose={closeDialog} fields={[{ name: "title", label: "标题", value: str(existing?.title), required: true }, { name: "content", label: "记忆内容", value: str(existing?.content), multiline: true, required: true }, { name: "scope", label: "可见范围", value: str(existing?.scope) || "bot", choices: [{ value: "bot", label: `仅 ${bot?.name}` }, { value: "workspace", label: "与所有 Agent 共享" }] }]} onSubmit={(data) => run(async () => { await api("memory", { ...data, botId: existing?.bot_id ?? botId, documentId: existing?.id, expectedVersion: existing?.version ?? 0 }); closeDialog(); })}/>);
  const editRoutine = (existing?: RecordRow) => setDialog(<RoutineEditor botId={botId} existing={existing} close={closeDialog} save={(data) => run(async () => { await api("routines", data); closeDialog(); })}/>);
  const loadOlder = async () => {
    const snapshot = loaded.current;
    if (!snapshot?.messages.length) return;
    const result = await api<{ messages: RecordRow[]; sync: State["sync"] }>(`agents/messages?bot=${encodeURIComponent(snapshot.botId)}&before=${snapshot.messages[0].seq}`);
    const current = loaded.current;
    if (!current || current.botId !== snapshot.botId || current.sync.privacyEpoch !== result.sync.privacyEpoch || current.sync.bootId !== result.sync.bootId) return;
    const merged = [...result.messages, ...current.messages.filter((m) => !result.messages.some((old) => old.id === m.id))];
    loaded.current = { ...current, messages: merged }; setMessages(merged);
  };
  if (!state) return <div className="boot"><BotMark size={44}/><h1>NexBot</h1><p>{error || "正在连接你的 Agent…"}</p>{desktop?.mode === "client" ? <button onClick={() => void desktop?.disconnect?.()}>返回连接页</button> : null}</div>;
  const botMemories = state.memories.filter((m) => m.scope === "workspace" || m.bot_id === botId);
  // The scope pills only exist for more than one memory, so a stale filter must not hide the list when they are gone.
  const activeMemoryFilter = botMemories.length > 1 ? memoryFilter : "all";
  const filteredMemories = botMemories.filter((m) => activeMemoryFilter === "all" || m.scope === activeMemoryFilter);
  const botUsage = state.usage?.find((u) => u.bot_id === botId);
  const exportTranscript = () => {
    const text = messages.map((m) => `[${formatTime(m.created_at)}] ${senderLabel(m, bot, state.bots)}: ${str(m.content)}`).join("\n\n");
    void navigator.clipboard?.writeText(text);
    setExported(true); setTimeout(() => setExported(false), 1800);
  };
  const signOut = () => { if (window.confirm("退出当前账号？此设备的登录将被撤销。")) void logout().catch(() => setError("退出登录未完成，请重试")); };
  const botLook = lookOf(bot, state.bots);
  const enabledTools: string[] = (() => { try { return JSON.parse(str(bot?.policy_json) || "{}").tools ?? []; } catch { return []; } })();
  const modelLabel = str(state.config?.default_model) || "未连接模型";
  const userDisplayName = accountStatus?.account?.displayName || "个人账号";
  void lookRevision;

  return <div className={`app rk-workspace ${page === "agent" && detail && bot ? "with-detail" : ""}`} data-theme="studio" data-dark={dark ? "1" : "0"}>
    <ContactSidebar state={state} selectedId={botId} page={page} search={search} pinned={pinned} dark={dark} connected={connected} userName={userDisplayName} open={sidebarOpen} onSearch={setSearch} onSelect={select} onPage={(next) => { setPage(next); setSidebarOpen(false); }} onCreate={() => editBot()} onTheme={() => setDark((value) => !value)} onLogout={signOut} onClose={() => setSidebarOpen(false)}/>

    <main>
      <header>
        <button className="icon-button mobile-menu" aria-label="展开联系人列表" onClick={() => setSidebarOpen(true)}><PanelLeft size={19}/></button>
        <div className={`contact-heading ${page === "agent" && bot ? "clickable" : ""}`} onClick={() => { if (page === "agent" && bot) setDetail((current) => !current); }} title={page === "agent" && bot ? "点击展开或收起 Agent 资料" : undefined}>
          {page === "agent" && bot ? <>
            <Avatar bot={bot} allBots={state.bots} size={36} working={tasks.length > 0}/>
            <div>
              <div className="contact-title-row">
                <strong>{bot.name}</strong>
                <span className="ds-model-pill"><Zap size={10}/>{modelLabel}</span>
              </div>
              <span className={tasks.length ? "active-phrase" : ""}>{tasks.length ? `${taskPhrase(tasks[0])}${tasks.length > 1 ? ` · ${tasks.length} 项工作正在进行` : ""}` : str(bot.instructions) ? str(bot.instructions).slice(0, 56) : "消息、记忆与定时任务持续保留"}</span>
            </div>
          </> : <strong>{page === "devices" ? "设备网络" : page === "settings" ? "设置" : page === "connectors" ? "连接器" : "你的 Agent"}</strong>}
        </div>
        <div className="header-actions">
          {page === "agent" && bot && memoryNotice ? <button type="button" className="memory-pill" onClick={() => { setDetail(true); setTab("memory"); setMemoryNotice(""); }}><Sparkles size={13}/>已更新记忆：{memoryNotice}</button> : null}
          {page === "agent" && bot && messages.length > 0 ? <button type="button" className="bt-round" title="复制对话记录" onClick={() => exportTranscript()}>{exported ? <Check size={16}/> : <Share2 size={16}/>}</button> : null}
          {page === "agent" && bot ? <button aria-label="Agent 资料" title="Agent 资料" className={`bt-round ${detail ? "selected" : ""}`} onClick={() => setDetail(!detail)}><Info size={17}/></button> : null}
        </div>
      </header>

      {error ? <div role="alert" className="error-banner">{error}<button onClick={() => setError("")} aria-label="关闭错误"><X size={16}/></button></div> : null}
      {!state.config && page !== "settings" ? <div className="notice">连接模型后，Agent 就能开始工作。<button onClick={() => setPage("settings")}>配置 API Key</button></div> : null}

      {page === "agent" && !bot ? <div className="welcome">
        <BotMark size={64}/>
        <h1>创建你的第一个 Agent</h1>
        <p>给它一个名字，身份与职责可以之后补充。消息、记忆和工作会持续保留。</p>
        <button className="primary" onClick={() => editBot()}><Plus size={16}/>创建 Agent</button>
      </div> : page === "agent" ? <>
        <div className="transcript" ref={scroll} onScroll={(e) => { const el = e.currentTarget; const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90; stickToBottom.current = nearBottom; setShowScrollPill(!nearBottom && messages.length > 3); }}>
          {Number(messages[0]?.seq) > 1 ? <button className="older" onClick={() => void run(loadOlder)}>加载更早的消息</button> : null}
          {!messages.length && !processing && historyLoading ? <div className="history-loading" role="status"><span className="spin"/>正在载入历史会话…</div> : !messages.length && !processing ? <div className="welcome ds-welcome">
            <Avatar bot={bot} allBots={state.bots} large size={76} interactive/>
            <div className="ds-welcome-badge" style={{ color: botLook.ink.solid, background: botLook.ink.soft }}>长期陪伴，随时开始</div>
            <h1>{bot?.name}</h1>
            <p>{str(bot?.instructions) || "我是你的专属智能同伴。你可以直接向我提问、安排定时任务，或输入 @ 让我与团队其他成员协作。"}</p>
            <small>直接发消息，或为我安排一项例行任务。</small>
            <div className="welcome-chips">
              <button type="button" onClick={() => editRoutine()}><Clock size={13}/>安排例行任务</button>
              <button type="button" onClick={() => editMemory()}><Sparkles size={13}/>添加长期记忆</button>
              {peers.length ? <button type="button" onClick={() => { changeDraft(`@${peers[0].name} `); composerRef.current?.focus(); }}><AtSign size={13}/>让 {peers[0].name} 协作</button> : null}
            </div>
          </div> : messages.map((m, idx) => {
            const prevDay = idx > 0 ? formatDay(messages[idx - 1].created_at) : "";
            const curDay = formatDay(m.created_at);
            return <div key={str(m.id)}>
              {curDay && curDay !== prevDay ? <div className="day-divider"><span>{curDay}</span></div> : null}
              <AgentMessage message={m} bot={bot} bots={state.bots} select={select} copiedId={copiedId} onCopy={copyText} onPreviewFile={openFilePreview} onPreviewStep={openStepPreview} onQuote={(msg) => { const author = senderLabel(msg, bot, state.bots); setQuote({ author, text: str(msg.content) }); composerRef.current?.focus(); }}/>
            </div>;
          })}
          {streaming.map((s) => {
            const link = state.delegations.find((d) => d.child_task_id === s.taskId), peer = state.bots.find((b) => b.id === link?.sender_bot_id);
            return <article className={`message assistant ${link ? "a2a-reply" : ""}`} key={s.taskId}>
              <Avatar bot={bot} allBots={state.bots} size={34} working/>
              <div className="message-body">
                {link ? <><div className="message-author"><strong>{bot?.name}</strong></div><FoldedReply content={s.text} recipient={str(peer?.name) || "Agent"} pending/></> : <><div className="ds-bot-author" style={{ color: botLook.ink.solid }}>{bot?.name}</div><div className="bubble"><RichText value={s.text}/></div><span className="muted">正在回复…</span></>}
              </div>
            </article>;
          })}
          {processing ? <article className="message assistant processing-message">
            <Avatar bot={bot} allBots={state.bots} size={34} working/>
            <div className="message-body">
              <div className="ds-bot-author" style={{ color: botLook.ink.solid }}>{bot?.name}</div>
              <div className="bubble processing-dots" role="status" aria-label={`${bot?.name ?? "Agent"} 正在处理消息`}><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/></div>
              {tasks[0] ? <span className="muted processing-caption">{taskPhrase(tasks[0])}</span> : null}
            </div>
          </article> : null}
        </div>

        <div className="composer-area">
          {showScrollPill ? <button type="button" className="scroll-pill" onClick={() => { stickToBottom.current = true; setShowScrollPill(false); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }}><ChevronDown size={14}/>回到底部</button> : null}
          {state.approvals.filter((a) => a.bot_id === botId).map((a) => <section className="approval" key={str(a.id)}><strong>{bot?.name} 需要你的批准</strong><small>{({ "agent.delegate": "联系其他 Agent", "agent.create": "创建新的 Agent", "agent.update": "修改 Agent 的名字和身份说明", "memory.write": "写入长期记忆", "memory.forget": "彻底遗忘原文与相关副本（相关工作会停止）", "device.read": "读取设备文件", "device.list": "查看设备目录", "device.exec": "执行终端命令", "device.computer": "操作电脑窗口", "connector.call": "调用连接器工具" } as Record<string, string>)[str(a.tool_name)] ?? a.tool_name}</small><details><summary>查看具体操作</summary><pre>{JSON.stringify({ ...JSON.parse(str(a.arguments_json)), ...(a.tool_name === "memory.forget" ? { 清理范围: JSON.parse(str(a.authorization_snapshot_json)).forgetCounts } : {}) }, null, 2)}</pre></details><div className="actions"><button className="primary" disabled={busy} onClick={() => void run(() => api("approvals", { id: a.id, hash: a.argument_hash, allow: true }))}>批准</button><button disabled={busy} onClick={() => void run(() => api("approvals", { id: a.id, hash: a.argument_hash, allow: false }))}>拒绝</button></div></section>)}
          {waitingPeers.map((approval) => <div className="task-status" key={str(approval.id)}><span>{state.bots.find((peer) => peer.id === approval.bot_id)?.name ?? "同伴"} 等待你的批准</span><button onClick={() => select(str(approval.bot_id))}>前往处理</button></div>)}
          {tasks.length > 0 && <div className="task-status"><span className="task-status-dot"/><span>{tasks.some((task) => task.status === "cancelling") ? "正在停止…" : `Agent 正在工作 · ${taskPhrase(tasks[0])}`}</span><button type="button" aria-label="停止任务" disabled={busy || !connected || tasks.every((task) => task.status === "cancelling")} onClick={() => void run(async () => { for (const task of tasks) await api("cancel", { taskId: task.id }); })}><Square size={12}/>停止任务</button></div>}
          {quote ? <div className="quote-bar"><div><strong>引用 {quote.author}</strong><span>{quote.text}</span></div><button type="button" aria-label="取消引用" onClick={() => setQuote(undefined)}><X size={14}/></button></div> : null}
          {matchingPeers.length > 0 ? <div className="at-menu" role="listbox" aria-label="提及同伴 Agent">{matchingPeers.map((peer, index) => <button type="button" key={str(peer.id)} className={index === atIndex ? "selected" : ""} onMouseDown={(e) => { e.preventDefault(); applyMention(str(peer.name)); }}><Avatar bot={peer} allBots={state.bots} size={28}/><div><strong>@{peer.name}</strong><span>{str(peer.instructions) || "同伴 Agent"}</span></div></button>)}</div> : null}
          {composerMenu && <><button className="composer-menu-dismiss" aria-label="关闭快捷操作" onClick={() => setComposerMenu(false)}/><div className="composer-menu" role="group" aria-label="快捷操作">
              <button type="button" onClick={() => { changeDraft(draft + " @"); setComposerMenu(false); composerRef.current?.focus(); }}><AtSign size={16}/>提及同伴</button>
              <button type="button" onClick={() => { editRoutine(); setComposerMenu(false); }}><Clock size={16}/>安排例行任务</button>
              <button type="button" onClick={() => { setPage("connectors"); setComposerMenu(false); }}><Plug size={16}/>管理连接器</button>
            </div></>}
          <form className="composer conversation-input" onSubmit={send}>
            <button type="button" className="composer-add" aria-label="打开快捷操作" aria-expanded={composerMenu} onClick={() => setComposerMenu((open) => !open)}><Plus size={18}/></button>
            <textarea ref={composerRef} aria-label="发送给 Agent 的消息" placeholder={`给 ${bot?.name ?? "Agent"} 发消息…`} value={draft} onChange={(e) => changeDraft(e.target.value)} onKeyDown={(e) => { if (matchingPeers.length > 0) { if (e.key === "ArrowDown") { e.preventDefault(); setAtIndex((i) => (i + 1) % matchingPeers.length); return; } if (e.key === "ArrowUp") { e.preventDefault(); setAtIndex((i) => (i - 1 + matchingPeers.length) % matchingPeers.length); return; } if (e.key === "Tab") { e.preventDefault(); applyMention(str(matchingPeers[atIndex]?.name ?? matchingPeers[0].name)); return; } if (e.key === "Escape") { e.preventDefault(); setAtDismissed(true); return; } } if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} rows={Math.min(5, Math.max(1, draft.split("\n").length))}/>
            <button className="send" aria-label="发送消息" disabled={busy || !draft.trim() || !state.config || !bot}><ArrowUp size={19}/></button>
          </form>
        </div>
      </> : page === "connectors" ? <ConnectorsPage state={state} refresh={reload}/> : page === "devices" ? <Devices state={state} run={run} setDialog={setDialog} closeDialog={closeDialog}/> : <><SettingsPage state={state} run={run}/></>}
    </main>

    {page === "agent" && detail && bot ? <aside className="inspector ds-drawer"><div className="inspector-heading"><span>工作空间</span><button aria-label="收起资料" className="icon-button" onClick={() => setDetail(false)}><X size={17}/></button></div>
      <div className="profile-top">
        <div className="ds-drawer-top-actions">
          <button type="button" className="bt-round" title="更换头像" onClick={editAvatar}><Palette size={15}/></button>
          <button type="button" className={`bt-round ${pinned.includes(str(bot.id)) ? "selected" : ""}`} title={pinned.includes(str(bot.id)) ? "取消置顶" : "置顶联系人"} onClick={() => togglePin(str(bot.id))}><Pin size={15}/></button>

        </div>
        <Avatar bot={bot} allBots={state.bots} size={36} working={tasks.length > 0}/>
        <strong>{bot.name}</strong>
        <div className="ds-drawer-badges">
          <span className="ds-role-badge" style={{ color: botLook.ink.solid, background: botLook.ink.soft }}>个人 Agent</span>
        </div>
        <div className="ds-drawer-quick-links">
          <button className="text-button" onClick={() => editBot(bot)}>编辑身份</button>
          <span>·</span>
          <button type="button" className="text-button" onClick={editAvatar}>更换头像</button>
        </div>

      </div>

      <div className="inspector-tabs">
        {[{ id: "profile", name: "概览" }, { id: "memory", name: "记忆" }, { id: "work", name: "工作" }].map((item) => <button key={item.id} className={tab === item.id ? "selected" : ""} onClick={() => setTab(item.id)}>{item.name}</button>)}
      </div>

      <div className="inspector-content">
        {preview ? <section className="preview-card" aria-label="内容预览"><div className="preview-header"><div><strong>{preview.kind === "file" ? preview.title : toolLabels[preview.title] ?? preview.title}</strong><small>{preview.kind === "file" ? `${preview.path ?? preview.title}${preview.size !== undefined ? ` · ${preview.size} B` : ""}` : `${statuses[preview.status ?? ""] ?? preview.status ?? ""}${preview.createdAt ? ` · ${formatTime(preview.createdAt)}` : ""}`}</small></div><div className="preview-actions"><button type="button" onClick={() => copyText("preview", preview.content)}>{copiedId === "preview" ? "已复制" : "复制"}</button><button type="button" aria-label="关闭预览" onClick={() => setPreview(undefined)}><X size={14}/></button></div></div>{preview.arguments ? <details><summary>调用参数</summary><pre>{preview.arguments}</pre></details> : null}<pre>{preview.content || "暂无内容"}</pre></section> : null}

        {tab === "profile" ? <>
          <section className="workspace-activity"><span className={`activity-indicator ${tasks.length ? "is-active" : ""}`}/><div><strong>{tasks.length ? taskPhrase(tasks[0]) : "准备就绪"}</strong><p>{tasks.length ? str(tasks[0].objective).slice(0, 90) : "发一条消息，开始新的工作。"}</p></div>{tasks.length > 0 && <button className="text-button" onClick={() => setTab("work")}>查看</button>}</section>
          <h2>连接器<button aria-label="管理连接器" onClick={() => setPage("connectors")}><Plus size={16}/></button></h2>
          <div className="ds-field-card">{(state.connectors ?? []).filter((item) => item.enabled && item.grants.some((grant) => grant.botId === botId && grant.tools.length)).map((item) => <button className="inspector-connector" key={item.id} onClick={() => setPage("connectors")}><Plug size={16}/><span>{item.name}</span><small>{item.grants.find((grant) => grant.botId === botId)?.tools.length} 项工具</small></button>)}<button className="text-button" onClick={() => setPage("connectors")}>连接工具与管理授权 →</button></div>
          <h2>可用设备</h2>
          <div className="ds-field-card">
            {state.devices.filter((d) => d.status === "bound").map((d) => <p className="resource" key={str(d.id)}><Cpu size={14}/>{d.name}<span className={state.onlineDevices.includes(str(d.id)) ? "status-on" : "status-off"}>{state.onlineDevices.includes(str(d.id)) ? "在线" : "离线"}</span></p>)}
            <button className="text-button" onClick={() => setPage("devices")}>管理设备网络 →</button>
          </div>

          <h2>例行任务<button aria-label="添加例行任务" onClick={() => editRoutine()}><Plus size={16}/></button></h2>
          {state.routines.filter((r) => r.bot_id === botId).map((r) => <section className="routine ds-field-card" key={str(r.id)}><div><strong>{r.name}</strong><button aria-label={`${r.enabled ? "暂停" : "启用"}${r.name}`} className={`switch ${r.enabled ? "on" : ""}`} onClick={() => void run(() => api("routines/toggle", { id: r.id, version: r.version, enabled: !r.enabled }))}><span/></button></div><small>{routineLabel(r)}</small><div className="routine-actions"><button onClick={() => editRoutine(r)}>编辑</button><button onClick={() => void run(() => api("routines/run", { id: r.id, clientId: crypto.randomUUID() }))}><Play size={12}/>现在执行</button></div>{r.enabled && r.next_due_at ? <small>下次 {formatTime(r.next_due_at)}</small> : null}</section>)}
          {!state.routines.some((r) => r.bot_id === botId) ? <div className="empty-small ds-field-card"><Clock size={18}/><p>安排一项例行任务，Agent 会按计划工作并给你汇报。</p><button onClick={() => editRoutine()}>添加例行任务</button></div> : null}

          <details className="agent-configuration"><summary>Agent 设置 <ChevronDown size={14}/></summary><div>          <div className="ds-field-group">
            <div className="ds-field-label">关于</div>
            <div className="ds-field-card">
              <p className={!expandBio && str(bot.instructions).length > 140 ? "bio-clamped" : ""}>{str(bot.instructions) || "尚未补充职责说明，点击上方“编辑身份”即可设置。"}</p>
              {str(bot.instructions).length > 140 ? <button type="button" className="text-button" onClick={() => setExpandBio((v) => !v)}>{expandBio ? "收起说明" : "展开全部"}</button> : null}
            </div>
          </div>

          <div className="ds-field-group">
            <div className="ds-field-label">能力</div>
            <div className="ds-field-card ds-kv-list">
              <div className="ds-kv-row">
                <span><Zap size={13}/>驱动模型</span>
                <button type="button" className="ds-pill-btn" onClick={() => setPage("settings")}>{modelLabel}</button>
              </div>
              <div className="ds-kv-row">
                <span><Shield size={13}/>工具权限</span>
                <button type="button" className="ds-pill-btn" onClick={() => setDialog(<AgentPolicyEditor bot={bot} close={closeDialog} save={(tools) => run(async () => { await api("bots/policy", { id: bot.id, version: bot.policy_version, tools }); closeDialog(); })}/>)}>已授权 {enabledTools.length} 项 · 配置</button>
              </div>
              <div className="ds-kv-row">
                <span><Folder size={13}/>工作目录</span>
                <code className="ds-folder-code" title={state.node.root || "默认沙箱目录"}>{state.node.root || "未限定主机目录"}</code>
              </div>
            </div>
          </div>

          <div className="ds-field-group">
            <div className="ds-field-label">用量</div>
            <div className="ds-field-card usage-card">
              <div className="ds-usage-grid">
                <div><small>累计调用</small><strong>{Number(botUsage?.calls ?? 0)} 次</strong></div>
                <div><small>输入 Token</small><strong>{Number(botUsage?.input_tokens ?? 0).toLocaleString()}</strong></div>
                <div><small>输出 Token</small><strong>{Number(botUsage?.output_tokens ?? 0).toLocaleString()}</strong></div>
              </div>
            </div>
          </div>

</div></details>
          <div className="profile-actions">
            {messages.length > 0 ? <button className="text-button" onClick={() => exportTranscript()}>{exported ? "已复制记录" : "导出记录"}</button> : null}
            <button className="text-button danger-link" onClick={() => setDialog(<Confirm title="归档这个 Agent？" detail="保留消息与记忆，停用例行任务。" onClose={closeDialog} onConfirm={() => run(async () => { await api("bots/archive", { id: bot.id, version: bot.version }); closeDialog(); })}/>)}>归档 Agent</button>
          </div>
        </> : null}

        {tab === "memory" ? <>
          <h2>长期记忆<button aria-label="添加记忆" onClick={() => editMemory()}><Plus size={16}/></button></h2>
          {botMemories.length > 1 ? <div className="scope-pills">{([["all", `全部 (${botMemories.length})`], ["bot", "仅当前 Agent"], ["workspace", "共享"]] as const).map(([key, label]) => <button type="button" key={key} className={activeMemoryFilter === key ? "selected" : ""} onClick={() => setMemoryFilter(key)}>{label}</button>)}</div> : null}
          {filteredMemories.map((m) => <section className="memory ds-field-card" key={str(m.id)}><strong>{m.title}</strong><small>{m.scope === "workspace" ? "所有 Agent 共享" : "仅当前 Agent"}{m.updated_at ? ` · ${formatShortTime(m.updated_at)}` : ""}</small><p>{m.content}</p><div className="actions"><button onClick={() => editMemory(m)}>编辑</button><button aria-label={`撤回${m.title}`} onClick={() => setDialog(<Confirm title="撤回这条记忆？" detail="撤回后不再用于长期记忆检索，原始消息和工作记录保留。如需一起清理，请使用下方的彻底遗忘。" onClose={closeDialog} onConfirm={() => run(async () => { await api("memory/delete", { id: m.id, version: m.version }); closeDialog(); })}/>)}><Trash2 size={13}/></button></div></section>)}
          <p className="muted">消息与工作记录自动保存。长期记忆可在这里维护，也可以让 Agent 帮你记住。</p>
          <h2>已有工作记录</h2>
          {state.journal.filter((j) => j.bot_id === botId).slice(0, 8).map((j) => <details className="journal ds-field-card" key={str(j.task_id)}><summary>{str(j.objective).slice(0, 100)}</summary><p>{j.result}</p><small>{formatTime(j.created_at)}</small></details>)}
        </> : null}

        {tab === "work" ? <>
          <h2>正在处理</h2>
          {tasks.map((t) => <section className="task ds-field-card" key={str(t.id)}><span className="tag">{taskPhrase(t)}</span><p>{t.objective || "Agent 工作"}</p><div className="actions">{t.status === "paused" ? <button onClick={() => void run(() => api("resume", { taskId: t.id }))}><Play size={12}/>继续</button> : null}<button onClick={() => void run(() => api("cancel", { taskId: t.id }))}><Square size={12}/>停止</button></div></section>)}
          {!tasks.length ? <p className="empty-small ds-field-card">当前没有进行中的工作。</p> : null}
          <h2>最近执行</h2>
          {state.occurrences.filter((o) => o.bot_id === botId).slice(0, 10).map((o) => <section className="task ds-field-card" key={str(o.id)}><strong>{o.name}</strong><small>{statuses[str(o.status)]} · {formatTime(o.scheduled_at)}</small></section>)}
        </> : null}

        {tab === "memory" && state.memoryEngine ? <><MemoryWorkbench key={botId + state.memoryEngine.revision + state.sync.bootId + state.sync.privacyEpoch} botId={botId} bots={state.bots}/><p className="muted" role="status">{state.memoryEngine.service === "starting" ? "正在启动语义记忆服务。" : state.memoryEngine.status === "connected" ? "Hindsight 语义记忆已连接。" : state.memoryEngine.status === "not_installed" ? "未启用记忆插件，可在主设备设置中连接外部服务；目前使用原始记录检索。" : "语义记忆暂不可用，目前使用原始记录检索。"} {state.memoryEngine.pending ? `${state.memoryEngine.pending} 项待同步。` : ""}{state.memoryEngine.quarantined ? " 部分记忆正在清理或更新，旧的派生结果已暂停读取。" : ""}</p></> : null}
      </div>
    </aside> : null}

    {dialog ? <div className="modal-backdrop" onKeyDown={(e) => { if (e.key === "Escape") closeDialog(); }}><div className="modal" role="dialog" aria-modal="true">{dialog}</div></div> : null}
  </div>;
}

function A2AMarker({ direction, peer, bots, timestamp, select }: { direction: string; peer?: RecordRow; bots: RecordRow[]; timestamp: RecordRow[string]; select: (id: string) => void }) {
  return <div className="a2a-marker" data-a2a-direction={direction}><span>{direction === "sent" ? "已发消息给" : "消息来自"}</span><button className="a2a-contact" aria-label={`打开 ${peer?.name ?? "Agent"} 的消息`} disabled={!peer} onClick={() => { if (peer) select(str(peer.id)); }}><Avatar bot={peer} allBots={bots} size={20}/><span>{peer?.name ?? "Agent"}</span></button><time title={timestamp ? new Date(Number(timestamp)).toLocaleString("zh-CN") : undefined}>{formatTime(timestamp)}</time></div>;
}
function FoldedReply({ content, recipient, pending = false }: { content: string; recipient: string; pending?: boolean }) {
  return <details className="bubble folded-content folded-reply"><summary><span className="reply-recipient">{pending ? "正在回复给" : "已回复给"}{recipient}</span><span aria-hidden="true">·</span><span className="expand-label">展开</span><span className="collapse-label">收起</span><ChevronDown size={13}/></summary><div className="folded-body" data-reply-content><RichText value={content}/></div></details>;
}
function senderLabel(m: RecordRow, bot: RecordRow | undefined, bots: RecordRow[]) {
  if (m.role === "user") return "我";
  if (m.role === "system") return "系统";
  if (m.role === "peer") return str(bots.find((b) => b.id === (m.a2a_peer_id ?? m.sender_bot_id))?.name) || "同伴 Agent";
  return str(bot?.name) || "Agent";
}
function AgentMessage({ message: m, bot, bots, select, copiedId, onCopy, onQuote, onPreviewFile, onPreviewStep }: { message: RecordRow & { tool_steps?: ToolStep[] }; bot?: RecordRow; bots: RecordRow[]; select: (id: string) => void; copiedId: string; onCopy: (id: string, text: string) => void; onQuote: (msg: RecordRow) => void; onPreviewFile: (path: string) => void; onPreviewStep: (step: ToolStep) => void }) {
  const direction = str(m.a2a_direction), peer = bots.find((b) => b.id === (m.a2a_peer_id ?? m.sender_bot_id));
  if (direction === "sent" || direction === "returned") return <A2AMarker direction={direction} peer={peer} bots={bots} timestamp={m.created_at} select={select}/>;
  if (direction === "received") return <A2AMarker direction={direction} peer={peer} bots={bots} timestamp={m.created_at} select={select}/>;
  if (direction === "replied" && m.role === "assistant") return <article className="message assistant a2a-reply"><Avatar bot={bot} allBots={bots} size={34}/><div className="message-body"><div className="message-author"><strong>{bot?.name ?? "Agent"}</strong></div><FoldedReply content={str(m.content)} recipient={peer?.name ? str(peer.name) : "Agent"}/><time>{formatTime(m.created_at)}</time></div></article>;
  const canAct = m.role === "user" || m.role === "assistant" || m.role === "peer";
  const steps = Array.isArray(m.tool_steps) ? m.tool_steps : [];
  return <article className={`message ${m.role} ${m.kind}`}>
    <div className="message-body">
      {m.role === "peer" ? <div className="message-author"><Avatar bot={peer} allBots={bots} size={22}/>{peer?.name ?? "Agent"} · {m.kind === "request" ? "发来任务" : "返回结果"}</div> : null}
      {steps.length > 0 ? <ToolActivityDisclosure live={false} stepCount={steps.length}><div className="step-list">{steps.map((step) => <button type="button" key={step.id} className="step-row" onClick={() => onPreviewStep(step)} title="点击在右侧面板查看详情"><span className={`step-dot ${step.status}`}/><strong>{toolLabels[step.tool_name] ?? step.tool_name}</strong>{step.summary ? <code>{step.summary}</code> : null}<small>{statuses[step.status] ?? step.status}</small></button>)}</div></ToolActivityDisclosure> : null}
      <div className="bubble"><RichText value={str(m.content)} onPreviewFile={onPreviewFile}/></div>
      <div className="message-meta"><time title={formatTime(m.created_at)}>{formatShortTime(m.created_at)}</time>{canAct ? <span className="message-tools"><button type="button" className="tool-link" onClick={() => onQuote(m)} title="引用回复"><CornerUpLeft size={11}/>引用</button><button type="button" className="tool-link" onClick={() => onCopy(str(m.id), str(m.content))} title="复制内容">{copiedId === str(m.id) ? <><Check size={11}/>已复制</> : <><Copy size={11}/>复制</>}</button></span> : null}</div>
    </div>
  </article>;
}
function routineLabel(row: RecordRow) { return row.schedule_kind === "daily" ? `每天 ${row.local_time} · ${row.time_zone}` : row.schedule_kind === "interval" ? `每 ${Number(row.interval_ms) / 60_000} 分钟` : "一次性任务"; }
function RoutineEditor({ botId, existing, close, save }: { botId: string; existing?: RecordRow; close: () => void; save: (data: Record<string, unknown>) => Promise<void> }) {
  const [kind, setKind] = useState(str(existing?.schedule_kind) || "daily"), [pending, setPending] = useState(false);
  return <><div className="modal-heading"><h2>{existing ? "编辑例行任务" : "添加例行任务"}</h2><button aria-label="关闭" onClick={close}><X size={18}/></button></div><form onSubmit={(e) => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)); setPending(true); void save({ ...data, botId, id: existing?.id, version: existing?.version, runAt: data.runAt ? new Date(String(data.runAt)).getTime() : undefined }).finally(() => setPending(false)); }}><label className="field">名称<input autoFocus name="name" required defaultValue={str(existing?.name)} placeholder="例如：每日工作计划"/></label><label className="field">让 Agent 做什么<textarea name="prompt" required rows={4} defaultValue={str(existing?.prompt)} placeholder="描述目标、需要参考的资料和汇报方式"/></label><label className="field">执行计划<select name="scheduleKind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="daily">每天</option><option value="interval">固定间隔</option><option value="once">指定时间执行一次</option></select></label>{kind === "daily" ? <label className="field">每天的时间<input name="localTime" type="time" required defaultValue={str(existing?.local_time) || "09:00"}/></label> : kind === "interval" ? <label className="field">间隔（分钟）<input name="intervalMinutes" type="number" min="1" max="525600" required defaultValue={existing?.interval_ms ? Number(existing.interval_ms) / 60_000 : 60}/></label> : <label className="field">执行时间（本机时间）<input name="runAt" type="datetime-local" required/></label>}<label className="field">时区<input name="timeZone" required defaultValue={str(existing?.time_zone) || Intl.DateTimeFormat().resolvedOptions().timeZone}/></label><p className="muted">按计划唤醒 Agent 会调用你配置的模型。需要批准的工具操作仍会等待你处理。</p><div className="actions"><button className="primary" disabled={pending}>保存</button><button type="button" onClick={close}>取消</button></div></form></>;
}
