// "Agent 会话": the coding-agent sessions of the user's computers, with a live
// terminal and a conversation view. Full page like the todo workspace; the
// sidebar and overlay come from AgentDesktop.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanelLeftOpen, MessageSquare, SquareTerminal, Plus, X } from "lucide-react";
import { WorkbenchProvider, useReview } from "./WorkbenchReview";
import "./workbench.css";
import type { CliAnswerDecision, CliDeviceView, CliRequestView, CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { desktop } from "../api";
import { answerRequest, cliErrorText, fetchSnapshot, hideSession } from "./api";
import { ForkDialog, type CliBotChoice } from "./ForkDialog";
import { NewSessionDialog } from "./NewSessionDialog";
import { LaunchPane } from "./LaunchPane";
import { isLaunchKey, launchRow, useLaunches } from "./use-launches";
import { newRequests, newlyWaiting, notifyRequest, notifyWaiting, sessionStates } from "./notifications";
import { pendingCounts, pendingViews } from "./requests";
import { groupSessions, waitingCount } from "./session-model";
import { useWorkbenchTree } from "./use-workbench";
import type { WorkbenchMeta } from "./SessionList";
import { archiveWorkbenchSession, branchSession, deleteWorkbenchSession, renameWorkbenchSession, startSession, type WorkbenchRef } from "./api";
import { useCliRequests } from "./use-requests";
import { SessionList } from "./SessionList";
import { Composer } from "./Composer";
import { useSideChats } from "./use-side-chats";
import { TerminalView } from "./TerminalView";
import { SessionPane } from "./SessionPane";
import { CLOSE_UNAUTHORIZED, CliStream, type StreamStatus } from "./stream";
import "./cli-agents.css";
import "./button-feedback.css";

const SELECTED_KEY = "nexbot.cliSelected";

function readSelected(): CliSessionKey | null {
  try { return (localStorage.getItem(SELECTED_KEY) as CliSessionKey | null) || null; } catch { return null; }
}

function writeSelected(key: CliSessionKey | null): void {
  try {
    if (key) localStorage.setItem(SELECTED_KEY, key);
    else localStorage.removeItem(SELECTED_KEY);
  } catch { /* storage unavailable */ }
}

/** The assistant the user last talked to, to start the pick from. */
function readLastBot(): string | undefined {
  try { return localStorage.getItem("nexbot.selectedAgent") || undefined; } catch { return undefined; }
}

/** The list over HTTP once, then kept current by the stream. */
function useCliList(stream: CliStream, onRequests: (views: readonly CliRequestView[]) => void) {
  const [devices, setDevices] = useState<CliDeviceView[]>([]);
  const [sessions, setSessions] = useState<CliSessionView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StreamStatus>(stream.status);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setError("");
    try {
      const snapshot = await fetchSnapshot();
      if (generation.current !== mine) return;
      setDevices(snapshot.devices);
      setSessions(snapshot.sessions);
      onRequests(snapshot.requests ?? []);
      setLoaded(true);
    } catch (cause) {
      if (generation.current !== mine) return;
      setError(cliErrorText(cause, "读取失败"));
      setLoaded(true);
    }
  }, [onRequests]);

  useEffect(() => {
    void reload();
    const release = stream.subscribeList();
    const off = stream.on((event) => {
      if (event.type === "status") {
        setStatus(event.status);
        if (event.status === "closed" && event.code === CLOSE_UNAUTHORIZED) window.dispatchEvent(new Event("nex-session-expired"));
        return;
      }
      if (event.type !== "message") return;
      const message = event.message;
      if (message.type === "list") {
        // a push is newer than any HTTP answer still in flight
        generation.current++;
        setDevices(message.devices);
        setSessions(message.sessions);
        setLoaded(true);
        setError("");
      } else if (message.type === "list.delta") {
        const removed = new Set<string>(message.removes);
        setSessions((current) => {
          const next = new Map(current.filter((session) => !removed.has(session.key)).map((session) => [session.key, session]));
          for (const session of message.upserts) next.set(session.key, session);
          return [...next.values()];
        });
        if (message.devices) setDevices(message.devices);
      }
    });
    return () => {
      generation.current++;
      off();
      release();
    };
  }, [stream, reload]);

  return { devices, sessions, setSessions, loaded, error, setError, status, reload };
}

/** What the NexAgent sidebar shows in place of the contacts. */
export interface CliSidebarSlot { list: ReactNode; onCreate(): void; }

export interface CliAgentsWorkspaceProps {
  /** a renderer puts the session list into the app sidebar; a plain node keeps the list in its own column */
  sidebar: ReactNode | ((slot: CliSidebarSlot) => ReactNode);
  /** false on narrow screens: the list keeps its own full-width view and the sidebar drawer leaves it out */
  sidebarList?: boolean;
  overlay?: ReactNode;
  dark: boolean;
  collapsed: boolean;
  onNavigation(): void;
  /** the user's assistants, for "交给助手" */
  bots?: readonly CliBotChoice[];
  /** after a fork: open the assistant's new topic */
  onOpenTopic?(botId: string, conversationId: string): void;
  /** tests pass their own stream */
  stream?: CliStream;
}

export function CliAgentsWorkspace(props:CliAgentsWorkspaceProps) {
  return <WorkbenchProvider><Workspace {...props}/></WorkbenchProvider>;
}
function Workspace({ sidebar, sidebarList = true, overlay, dark, collapsed, onNavigation, bots, onOpenTopic, stream: provided }: CliAgentsWorkspaceProps) {
  const review=useReview();
  const [railWidth,setRailWidth]=useState(()=>{try{return Number(localStorage.getItem("nexagent.railWidth"))||272}catch{return 272}});
  const didSelect=useRef(false);
  const stream = useMemo(() => provided ?? new CliStream(), [provided]);
  useEffect(() => {
    stream.start();
    const online = () => stream.reconnectNow();
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("online", online);
      stream.stop();
    };
  }, [stream]);

  const requests = useCliRequests(stream);
  const { devices, sessions, setSessions, loaded, error, setError, status, reload } = useCliList(stream, requests.merge);
  const [reloadToken, setReloadToken] = useState(0);
  const tree = useWorkbenchTree(stream, loaded, reloadToken);
  /** What SessionList reads: display title, tree parent and the mutation handles. */
  const listMeta = useMemo(() => {
    const byId = new Map(tree.map((row) => [row.id, row]));
    const map = new Map<CliSessionKey, WorkbenchMeta>();
    for (const row of tree) {
      if (!row.sessionKey) continue;
      const parent = row.parentId ? byId.get(row.parentId) : undefined;
      map.set(row.sessionKey, {
        title: row.title,
        parent: parent?.sessionKey ?? null,
        kind: row.kind === "side" ? "side" : row.kind === "fork" ? "fork" : undefined,
        archived: row.archived,
        id: row.id,
        version: row.version,
      });
    }
    return map;
  }, [tree]);
  const runWorkbenchAction = useCallback(async (action: "fork" | "rename" | "archive" | "restore" | "delete", session: Pick<CliSessionView, "key" | "deviceId" | "engine" | "cwd">, value?: { title?: string; row?: { id?: string; version?: number } }): Promise<{ key?: CliSessionKey }> => {
    if (isLaunchKey(session.key)) throw new Error("会话还在启动");
    if (action === "fork") {
      // the branch row exists first; the device session binds to it on start
      const created = await branchSession(session.key, value?.title ?? "", crypto.randomUUID());
      // forkFrom: the child carries the parent's conversation instead of starting blank
      let started: { key: CliSessionKey };
      try {
        started = await startSession(session.deviceId, session.engine, session.cwd, { parentId: created.id, forkFrom: session.key });
      } catch (cause) {
        // a row that never got its session would sit in Core unseen: settle it,
        // and let the list show why (an old executor or a harness without fork)
        await deleteWorkbenchSession({ id: created.id, expectedVersion: created.version }).catch(() => undefined);
        setReloadToken(token => token + 1);
        throw new Error(cliErrorText(cause, "分支会话启动失败"));
      }
      setReloadToken(token => token + 1);
      void reload();
      return { key: started.key };
    }
    // a session the workbench never touched has no logical row: its key is
    // enough, Core creates the row with this first change
    const id = value?.row?.id, version = value?.row?.version;
    const ref: WorkbenchRef = id && version !== undefined ? { id, expectedVersion: version } : { key: session.key };
    if (action === "rename") await renameWorkbenchSession(ref, value?.title ?? "");
    else if (action === "archive") await archiveWorkbenchSession(ref, true);
    else if (action === "restore") await archiveWorkbenchSession(ref, false);
    else if (action === "delete") await deleteWorkbenchSession(ref);
    setReloadToken(token => token + 1);
    return {};
  }, [reload]);
  const [selectedKey, setSelectedKey] = useState<CliSessionKey | null>(readSelected);
  const launcher = useLaunches(sessions, () => { setReloadToken(token => token + 1); void reload(); });
  const [mobileView, setMobileView] = useState<"list" | "pane">("list");
  const [creating, setCreating] = useState<{ deviceId?: string; cwd?: string } | null>(null);
  const [forking, setForking] = useState<CliSessionView | null>(null);

  const select = useCallback((key: CliSessionKey | null) => {
    didSelect.current=true;
    setSelectedKey(key);
    // a session still starting has no key that outlives the page
    if (!isLaunchKey(key)) writeSelected(key);
    if (key) setMobileView("pane");
  }, []);

  // archived (and the older "hidden") sessions stay in the groups: the list shows them in its archive view
  // sessions still starting show first; a started one keeps its placeholder until its first message is out
  const listed = useMemo(() => {
    const starting = new Set(launcher.launches.map((launch) => launch.target).filter(Boolean));
    return [...launcher.launches.map(launchRow), ...sessions.filter((session) => !starting.has(session.key))];
  }, [launcher.launches, sessions]);
  const groups = useMemo(() => groupSessions(devices, listed, true), [devices, listed]);
  const launching = launcher.launches.find((launch) => launch.key === selectedKey) ?? null;
  // the real row took over: the pane follows it
  useEffect(() => {
    const moved = launcher.done.find((launch) => launch.key === selectedKey);
    if (moved?.target) select(moved.target);
  }, [launcher.done, selectedKey, select]);
  const selected = sessions.find(s => s.key===selectedKey && !review?.records[s.key]?.deleted && !review?.records[s.key]?.archived && review?.records[s.key]?.kind!=="side" && (review || (listMeta.get(s.key)?.kind!=="side" && !s.sideOf))) ?? null;
  const sideHost = useMemo(() => review ? undefined : { meta: listMeta, refresh: () => { setReloadToken(token => token + 1); void reload(); } }, [review, listMeta, reload]);
  const sideChats=useSideChats(selectedKey,sessions,sideHost);
  /** Side chats start a new session on the session's computer, so it must run there (the preview fixture only has Claude). */
  const canSide = (entry: CliSessionView) => review ? entry.engine==="claude"
    : (entry.engine==="claude" || entry.engine==="codex") && entry.online && !!devices.find(d => d.id===entry.deviceId)?.cliAgents?.engines.includes(entry.engine);
  const {draft:sideDraft,session:side}=sideChats;
  const terminalActive=sideChats.selected?.id===sideChats.terminalId;
  useEffect(()=>{
    if (!review||!loaded||didSelect.current)return;
    const target=selected || sessions.find(s=>s.key===review.initial);
    if(target){didSelect.current=true;select(target.key)}
  },[review,loaded,selected,sessions,select]);
  function resize(value:number){
    const width=Math.round(Math.max(220,Math.min(value,Math.min(520,innerWidth*.47))));
    setRailWidth(width);try{localStorage.setItem("nexagent.railWidth",String(width))}catch{}
  }

  const pending = useMemo(() => pendingCounts(requests.store, requests.now), [requests.store, requests.now]);
  const asked = useMemo(() => new Set(pending.keys()), [pending]);
  const waiting = waitingCount(sessions, asked);

  // one notification per new request, and per session that starts waiting, while the page is hidden
  const previous = useRef<Map<string, CliSessionView["state"]> | null>(null);
  const previousRequests = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const open = pendingViews(requests.store, requests.now);
    const told = new Set<string>();
    for (const request of newRequests(previousRequests.current, open)) {
      if (notifyRequest(request, sessions.find((session) => session.key === request.key), select)) told.add(request.key);
    }
    for (const session of newlyWaiting(previous.current, sessions)) if (!told.has(session.key)) notifyWaiting(session, select);
    previous.current = sessionStates(sessions);
    previousRequests.current = new Set(open.map((request) => request.id));
  }, [loaded, sessions, requests.store, requests.now, select]);

  const answer = useCallback(async (key: CliSessionKey, id: string, decision: CliAnswerDecision, answers?: Record<string, string>) => {
    await answerRequest(id, decision, answers);
    requests.answered(key, id, decision);
  }, [requests.answered]);

  const hide = async (session: CliSessionView, hidden: boolean) => {
    setSessions((current) => current.map((entry) => (entry.key === session.key ? { ...entry, hidden } : entry)));
    try {
      await hideSession(session.key, hidden);
    } catch (cause) {
      setSessions((current) => current.map((entry) => (entry.key === session.key ? { ...entry, hidden: session.hidden } : entry)));
      setError(cliErrorText(cause));
    }
  };

  const list = (
    <>
      {!loaded ? <div className="cli-empty" role="status">正在读取…</div> : null}
      {loaded && !groups.length ? <div className="cli-empty">还没有电脑接入</div> : null}
      <SessionList
        groups={groups}
        selectedKey={selectedKey}
        pending={pending}
        workbench={review ? undefined : listMeta}
        onWorkbenchAction={review ? undefined : {
          fork: (session, title) => runWorkbenchAction("fork", session, { title }),
          rename: async (session, row, title) => { await runWorkbenchAction("rename", session, { title, row: { id: row?.id, version: row?.version } }); },
          archive: async (session, row, archived) => {
            // "hidden" was the old archive: restoring clears it too
            if (!archived && session.hidden) await hide(session, false);
            if (archived || row?.archived) await runWorkbenchAction(archived ? "archive" : "restore", session, { row: { id: row?.id, version: row?.version } });
          },
          remove: async (session, row) => { await runWorkbenchAction("delete", session, { row: { id: row?.id, version: row?.version } }); },
        }}
        onSelect={select}
        reloadSessions={reload}
        onNew={(deviceId, cwd) => setCreating({ deviceId, cwd })}
      />
    </>
  );
  // the list is rendered in exactly one place: the app sidebar on wide screens, its own column otherwise
  const slotted = typeof sidebar === "function" && sidebarList;
  const sidebarNode = typeof sidebar === "function" ? sidebar({ list: slotted ? list : null, onCreate: () => setCreating({ deviceId: selected?.deviceId }) }) : sidebar;
  const linkText = status === "connecting" ? "正在连接" : status === "reconnecting" ? "正在重新连接" : status === "closed" ? "连接已断开" : "";
  return (
    <div className="workspace-stage na-stage" data-shell={desktop?.mode === "client" ? "1" : "0"} data-dark={dark ? "1" : "0"}>
      <div className="app rk-workspace cli-app" data-dark={dark ? "1" : "0"} data-theme="studio" data-left={collapsed ? "closed" : "open"} data-right="closed" data-page="cli" data-mobile={mobileView} style={{"--na-width":railWidth+"px"} as import("react").CSSProperties} data-list={slotted ? "sidebar" : undefined}>
        {sidebarNode}
        {!collapsed&&slotted?<div className="na-resize" role="separator" aria-label="调整会话栏宽度" aria-orientation="vertical" aria-valuenow={railWidth} tabIndex={0} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault()}} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))resize(e.clientX)}} onKeyDown={e=>{if(e.key==="ArrowRight"||e.key==="ArrowLeft"){e.preventDefault();resize(railWidth+(e.key==="ArrowRight"?12:-12))}}}/>:null}
        <main className="cli-main">
          {(!sidebarList || linkText || waiting > 0) && <header className="na-workspace-status">
            {!sidebarList && <button type="button" className="bt-round mobile-menu" aria-label="打开导航" onClick={onNavigation}><PanelLeftOpen size={19}/></button>}
            {linkText && <span className="cli-link-state" role="status">{linkText}</span>}
            {waiting > 0 && <span className="cli-chip" data-tone="waiting" data-testid="cli-waiting">等你处理 {waiting}</span>}
          </header>}
          {error ? (
            <div role="alert" className="cli-banner">
              {error}
              <button type="button" className="text-button" onClick={() => { setError(""); void reload(); }}>重新加载</button>
            </div>
          ) : null}
          <div className="cli-body" data-side={sideChats.selected?"open":undefined}>
            {slotted ? null : <aside className="cli-side glass" aria-busy={!loaded}>{list}</aside>}
            <div className="cli-content glass">
              {launching ? (
                <LaunchPane key={launching.id} launch={launching} onBack={() => setMobileView("list")}
                  onRetry={() => launcher.retry(launching.id)}
                  onDismiss={() => { launcher.dismiss(launching.id); if (launching.target) select(launching.target); else select(null); }}/>
              ) : selected ? (
                <SessionPane
                  key={selected.key}
                  session={selected}
                  title={listMeta.get(selected.key)?.title}
                  onTerminalOpen={sideChats.openTerminal}
                  onSideOpen={canSide(selected)?(q,m)=>sideChats.open(selected,q,m):undefined}
                  sideCount={sideChats.selected?0:sideChats.tabs.filter(t=>t.id!==sideChats.terminalId).length}
                  stream={stream}
                  onKeyChange={select}
                  onBack={() => setMobileView("list")}
                  requests={requests.store.get(selected.key)}
                  now={requests.now}
                  onAnswer={(id, decision, answers) => answer(selected.key, id, decision, answers)}
                  onFork={bots?.length && onOpenTopic ? () => setForking(selected) : undefined}
                  features={devices.find(d => d.id===selected.deviceId)?.cliAgents?.features}
                  echo={launcher.echo(selected.key)}
                />
              ) : (
                <div className="cli-placeholder">选择一个会话</div>
              )}
            </div>
            {sideChats.selected && selected && <aside className="na-side" aria-label="右侧工作区">
              <header className="na-side-tabs"><div className="na-tab-strip" role="tablist" aria-label="右侧工作区" onKeyDown={e=>{
                if(!(e.target instanceof HTMLButtonElement) || e.target.getAttribute("role")!=="tab")return;
                if(!["ArrowLeft","ArrowRight","Home","End"].includes(e.key))return;
                const tabs=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                const index=tabs.indexOf(e.target);
                const next=e.key==="Home"?0:e.key==="End"?tabs.length-1:(index+(e.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
                e.preventDefault();tabs[next].click();tabs[next].focus();
              }}>
                {sideChats.tabs.map(t=><div key={t.id} className="na-chat-tab" data-active={t.id===sideChats.selected?.id}>
                  <button role="tab" tabIndex={t.id===sideChats.selected?.id?0:-1} aria-selected={t.id===sideChats.selected?.id} onClick={()=>sideChats.select(t.id)} title={t.title}>{t.id===sideChats.terminalId?<SquareTerminal size={14}/>:<MessageSquare size={13}/>}<span>{t.title}</span></button>
                  <button aria-label={t.id===sideChats.terminalId?"关闭远程终端":"关闭标签："+t.title} disabled={t.id===sideDraft?.id && sideDraft.busy} onClick={()=>sideChats.close(t.id)}><X size={12}/></button>
                </div>)}
              </div>{canSide(selected) && <button aria-label="新建侧边聊天" title="新建侧边聊天" onClick={()=>void sideChats.open(selected,"","",true)}><Plus size={15}/></button>}
              <button className="na-side-hide" aria-label={terminalActive?"收起侧边栏":"关闭侧边会话"} title="收起侧边栏" onClick={()=>sideChats.select(null)}><PanelLeftOpen size={15}/></button></header>
              {terminalActive ? <TerminalView key={selected.key} sessionKey={selected.key} stream={stream} connected={status==="open"}/> : side ? <SessionPane key={side.key} session={side} stream={stream} compact features={devices.find(d => d.id===side.deviceId)?.cliAgents?.features} onSideOpen={canSide(side)?(q,m)=>sideChats.open(side,q,m):undefined} onBack={()=>sideChats.select(null)} onKeyChange={sideChats.changeSession} requests={requests.store.get(side.key)} now={requests.now} onAnswer={(id,d,a)=>answer(side.key,id,d,a)}/>
                : sideDraft && <section className="na-side-blank"><Composer key={sideDraft.id} session={sideDraft.source} features={devices.find(d => d.id===sideDraft.source.deviceId)?.cliAgents?.features}
                  draft={{...sideDraft,busy:sideDraft.busy||sideDraft.sent,configure:(model,effort)=>sideChats.patch(sideDraft.id,{model,effort})}}
                  onSend={text=>sideChats.send(sideDraft,text)} onInterrupt={async()=>{}}/></section>}
            </aside>}
          </div>
        </main>
      </div>
      {creating ? (
        <NewSessionDialog
          devices={devices}
          sessions={sessions}
          initialDeviceId={creating.deviceId}
          initialCwd={creating.cwd ?? (selected?.deviceId === creating.deviceId ? selected?.cwd : undefined)}
          onClose={() => setCreating(null)}
          onLaunch={(request) => { setCreating(null); select(launcher.launch(request).key); }}
        />
      ) : null}
      {forking && bots && onOpenTopic ? (
        <ForkDialog
          session={forking}
          bots={bots}
          initialBotId={readLastBot()}
          onClose={() => setForking(null)}
          onForked={(botId, conversationId) => { setForking(null); onOpenTopic(botId, conversationId); }}
        />
      ) : null}
      {overlay}
    </div>
  );
}
