// One open session: header, transcript, and composer. The composer talks to
// the workbench contracts: sends carry idempotency ids, a running session
// queues or steers, stopping pauses the outbox in Core, and edit-and-resend
// records the revised message.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, List, MessageSquare, Network, Share2 } from "lucide-react";
import { cliPermissionLabel, cliPermissionModes, cliQuestionToSteer, modelFailureReason, unwrapPastedContent, type CliItem, type CliAnswerDecision, type CliPermissionMode, type CliSessionKey, type CliSessionView } from "../../../shared/cli-agents";
import { privateCliImageLinks } from "../../../shared/cli-images";
import { ModelFailureDialog } from "./ModelFailureDialog";
import { CliApiError, continueSession, editQueued, interruptSession, resumeQueue, sendMessage, steerQueued, stopSession, withdrawQueued } from "./api";
import { useReview } from "./WorkbenchReview";
import { useNotes } from "./use-notes";
import {getApplied,getLaunch,getPermission,saveApplied,saveLaunch,savePermission,transferGoal,type PermissionChoice} from "./composer-additions";
import { Composer, NATIVE_QUEUED_NOTE, type LaunchChoice } from "./Composer";
import type { LaunchEcho } from "./use-launches";
import { cardState, shownCards, type RequestRecord } from "./requests";
import { RequestCard } from "./RequestCard";
import { askedSession, sessionStatusLabel, sessionTitle, sessionTone } from "./session-model";
import type { CliStream } from "./stream";
import { SessionInfoCard } from "./SessionInfoCard";
import type { GuideMessage } from "./transcript";
import { TranscriptView } from "./TranscriptView";
import { isVisibleQueueEntry, useCliQueue } from "./use-queue";
import { TeamPanel } from "./TeamPanel";
import { isRunLive, isWorkerWorking, TEAM_WORKER_STATUS_LABEL, visibleTeamWorkers, type CliTeamRunView, type TeamWorkerBinding } from "./team";
import type { BackStep } from "../android-back";

export interface SessionPaneProps {
  session: CliSessionView;
  stream: CliStream;
  /** a continued session gets a new key */
  onKeyChange(key: CliSessionKey): void;
  onBack(): void;
  /** Android's back gesture: the workspace panel closes first, then a message being edited */
  back?: BackStep;
  /** this session's request cards */
  requests?: readonly RequestRecord[];
  now?: number;
  onAnswer?(id: string, decision: CliAnswerDecision, answers?: Record<string, string>, always?: boolean): Promise<unknown>;
  /** hand the session to an assistant; absent when there is no assistant to take it */
  onFork?(): void;
  onBranchReply?(itemId: string): void;
  onSideOpen?(quote?:string,message?:string):Promise<void>;
  onTerminalOpen?():void;
  /** side chats of this session that are not showing: a button brings the panel back */
  sideCount?:number;
  compact?:boolean;
  /** the display name Core keeps for the session (renames, "（fork）"), over the CLI's own title */
  title?:string;
  /** what the session's computer supports */
  features?: readonly string[];
  /** the first message of a session just started from NexAgent, until its records hold it */
  echo?: LaunchEcho;
  /** collaboration runs led by this session (active first, then historical) */
  teamRuns?: readonly CliTeamRunView[];
  /** present when this session is a worker spawned by a lead session */
  workerBinding?: TeamWorkerBinding;
  /** display title of the lead session, for the worker's back-to-lead header bar */
  leadTitle?: string;
  onSelectSession?(key: CliSessionKey): void;
  onTeamPause?(runId: string): Promise<void>;
  onTeamResume?(runId: string): Promise<void>;
  onTeamCancel?(runId: string): Promise<void>;
  onTeamStopWorker?(runId: string, workerName: string): Promise<void>;
}

const NO_REQUESTS: readonly RequestRecord[] = [];

/** A message sent from this page that the session's records do not hold yet. */
export interface PendingSend { id: string; text: string; at: number; known: ReadonlySet<string>; queueId?: string; nativeQueued?: boolean }

const plain = (text: string) => privateCliImageLinks(unwrapPastedContent(text)).replace(/\s+/g, " ").trim();
const isNewAgentItem = (item: CliItem, known: ReadonlySet<string>) =>
  item.kind !== "user" && item.kind !== "turn" && (item.kind !== "notice" || !!item.text) && !known.has(item.id);

/** Drops each pending message once the records hold it: a user item that was not there at its
 * send with the same text, or (once the agent has answered after it) the earliest such item.
 * The same list when nothing settled. */
export function settlePending(list: readonly PendingSend[], items: readonly CliItem[]): PendingSend[] {
  if (!list.length) return list as PendingSend[];
  const claimed = new Set<string>();
  const next = list.filter((entry) => {
    const fresh = items.filter((item): item is Extract<CliItem, { kind: "user" }> => item.kind === "user" && !entry.known.has(item.id) && !claimed.has(item.id));
    const text = plain(entry.text);
    const answered = items.some((item) => isNewAgentItem(item, entry.known));
    const hit = fresh.find((item) => plain(item.text) === text) ?? (answered ? fresh[0] : undefined);
    if (!hit) return true;
    claimed.add(hit.id);
    return false;
  });
  return next.length === list.length ? list as PendingSend[] : next;
}

export function SessionPane({ session, stream, onKeyChange, onBack, back, requests = NO_REQUESTS, now = Date.now(), onAnswer, onFork, onBranchReply, onSideOpen, onTerminalOpen, sideCount = 0, compact, title, features, echo, teamRuns, workerBinding, leadTitle, onSelectSession, onTeamPause, onTeamResume, onTeamCancel, onTeamStopWorker }: SessionPaneProps) {
  const review=useReview();
  const details=review?.records[session.key];
  const heading=unwrapPastedContent(details?.title||title?.trim()||"")||sessionTitle(session);
  const [workspaceOpen,setWorkspaceOpen]=useState(false);
  const [teamOpen,setTeamOpen]=useState(false);
  const workspaceId=useId();
  const teamPanelId=useId();
  const workspaceToggle=useRef<HTMLButtonElement>(null);
  const workspaceLayer=useRef<HTMLDivElement>(null);
  const teamToggle=useRef<HTMLButtonElement>(null);
  const teamLayer=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!workspaceOpen)return;
    const closeOutside=(event:MouseEvent)=>{
      const clicked=event.composedPath();
      if(!clicked.some(target=>target===workspaceLayer.current||target===workspaceToggle.current))setWorkspaceOpen(false);
    };
    document.addEventListener("click",closeOutside,true);
    return ()=>document.removeEventListener("click",closeOutside,true);
  },[workspaceOpen]);
  useEffect(()=>{
    if(!teamOpen)return;
    const closeOutside=(event:MouseEvent)=>{
      const clicked=event.composedPath();
      if(!clicked.some(target=>target===teamLayer.current||target===teamToggle.current))setTeamOpen(false);
    };
    document.addEventListener("click",closeOutside,true);
    return ()=>document.removeEventListener("click",closeOutside,true);
  },[teamOpen]);
  // Core keeps the notes; the isolated review fixture keeps them in the tab
  const {notes,update:updateNotes,error:noteError,dismissError:dismissNoteError}=useNotes(session.key,!review);
  const [items,setItems]=useState<CliItem[]>([]);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  // handled cards show their outcome for a moment, then leave the space above the box
  const cards = shownCards(requests, now);
  const pendingRequests = requests.filter((record) => cardState(record, now) === "pending");
  const shown = askedSession(session, pendingRequests.length);
  const managedClaude = session.engine === "claude" && session.liveIn === "nexbot" && !!session.terminal;
  const steerQuestionId = managedClaude && (session.state === "running" || session.state === "waiting")
    ? cliQuestionToSteer(pendingRequests.map((record) => record.view)) : undefined;
  const interruptWaiting = managedClaude && session.state === "waiting" && pendingRequests.length === 0;
  const waitingSteer = { questionId: steerQuestionId, ...(interruptWaiting ? { interruptWaiting: true } : {}) };
  const resumedKey = useRef<CliSessionKey|null>(null);
  const { queue, refreshQueue } = useCliQueue(stream, session.key);
  const [guides, setGuides] = useState<GuideMessage[]>([]);
  async function guideEntry(id: string) {
    const entry = queue?.entries.find(row => row.id === id);
    if (!entry) return;
    const tail = items.filter(item => item.kind === "assistant").at(-1);
    const guide = { id, text: entry.text, at: Date.now(), after: items.at(-1)?.id, known: new Set(items.map(item => item.id)),
      ...(tail?.kind === "assistant" ? { tail } : {}) };
    setGuides(previous => [...previous.filter(row => row.id !== id), guide]);
    try {
      const result = await steerQueued(id, entry.version, waitingSteer);
      // not taken into the turn (the session was waiting on the user): it stays the next message in the queue, which
      // sends it as soon as the session takes input, so this is no error
      if (result.entry.status === "pending" && (waitingSteer.questionId || waitingSteer.interruptWaiting)) { setGuides(list => list.filter(row => row.id !== id)); return; }
      if (result.entry.status === "uncertain") setGuides(list => list.map(row => row.id === id ? { ...row, uncertain: true } : row));
    } catch (error) {
      const uncertain = error instanceof CliApiError && (!error.status || error.code === "unknown" || error.status >= 500);
      setGuides(previous => uncertain ? previous.map(row => row.id === id ? { ...row, uncertain: true } : row) : previous.filter(row => row.id !== id));
      throw error;
    }
  }
  const [revision, setRevision] = useState<{ messageId: string; text: string } | null>(null);
  // A message being edited leaves the conversation; its resend takes its place.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => readHidden(session.key));
  const hide = useCallback((id: string, on: boolean) => setHidden((current) => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    saveHidden(session.key, next);
    return next;
  }), [session.key]);
  const edit = useCallback((messageId: string, text: string) => { if (revision && revision.messageId !== messageId) hide(revision.messageId, false); hide(messageId, true); setRevision({ messageId, text }); }, [hide, revision]);
  const cancelEdit = () => { if (revision) hide(revision.messageId, false); setRevision(null); };
  useEffect(() => {
    if (!back) return;
    back.current = () => {
      if (teamOpen) { setTeamOpen(false); return true; }
      if (workspaceOpen) { setWorkspaceOpen(false); return true; }
      if (revision) { cancelEdit(); return true; }
      return false;
    };
    return () => { back.current = null; };
  });
  // A model call that failed for good, as it arrives: a dialog, and the turn stays where it stopped.
  const [failure, setFailure] = useState<string | null>(null);
  const failuresSeen = useRef<Set<string> | null>(null);
  const openedAt = useRef(Date.now());
  useEffect(() => {
    const failures = items.flatMap((item) => {
      if (item.kind !== "notice" || item.level !== "error") return [];
      const reason = modelFailureReason(item.text);
      return reason ? [{ id: item.id, ts: item.ts, reason }] : [];
    });
    if (failuresSeen.current === null) {
      if (!items.length) return;
      // what the records already held when the page opened is history, not news
      failuresSeen.current = new Set(failures.filter((entry) => entry.ts < openedAt.current - 5_000).map((entry) => entry.id));
    }
    const seen = failuresSeen.current;
    const fresh = failures.filter((entry) => !seen.has(entry.id));
    for (const entry of fresh) seen.add(entry.id);
    if (fresh.length) setFailure(fresh[fresh.length - 1].reason);
  }, [items]);
  const [launch, setLaunch] = useState<LaunchChoice>(() => getLaunch(session.key));
  /** what the running CLI was started with or last told, so a send only switches when the choice changed.
   * Unknown (a session from before this was kept): the saved choice, which it was started with. */
  const applied = useRef<string>(JSON.stringify(getApplied(session.key) ?? launch));
  const markApplied = (key: string, value: LaunchChoice) => { applied.current = JSON.stringify(value); saveApplied(key, value); };
  // The permission mode picked in the + menu. A stopped session and an idle Antigravity session take it with the next
  // message; a CLI running in a terminal has no way in, so it takes it the next time it starts.
  const [permission, setPermission] = useState<PermissionChoice | null>(() => getPermission(session.key));
  const permissionModes = review || compact ? [] : cliPermissionModes(session.engine, features ?? []);
  const managedProtocol = session.sendVia === "acp" || (session.sendVia === "host" && session.liveIn === "background");
  const takesNow = session.state === "stopped" || managedProtocol;
  const choosePermission = (mode: CliPermissionMode) => { const next = { mode, pending: true }; setPermission(next); savePermission(session.key, next); };
  const tookPermission = (key: CliSessionKey, mode: CliPermissionMode) => { const next = { mode, pending: false }; setPermission(next); savePermission(key, next); };
  const chooseLaunch = (next: LaunchChoice) => {
    // a change not sent yet stays a change after the page reopens
    if (!getApplied(session.key)) saveApplied(session.key, JSON.parse(applied.current) as LaunchChoice);
    setLaunch(next); saveLaunch(session.key, next);
  };
  // From a send until the session answers: a resumed CLI can take a while to
  // print anything, and without this the page looks like nothing happened.
  const [awaiting, setAwaiting] = useState<{ known: ReadonlySet<string>; resuming: boolean; unconfirmed?: boolean; fresh?: boolean } | null>(() => echo ? { known: new Set(), resuming: false, fresh: true } : null);
  useEffect(() => {
    if (!awaiting) return;
    if (session.state === "waiting" || !session.online) { setAwaiting(null); return; }
    // the device clock may differ from this one: a reply is an item that was not there at send time
    if (items.some((item) => isNewAgentItem(item, awaiting.known))) setAwaiting(null);
  }, [awaiting, items, session.state, session.online]);
  // Messages sent from this page show at once, before the session's records hold them.
  const [echoes, setEchoes] = useState<PendingSend[]>([]);
  useEffect(() => { setEchoes((list) => settlePending(list, items)); }, [items]);
  const queuedIds = useMemo(() => new Set(queue?.entries.filter(isVisibleQueueEntry).map((entry) => entry.id)), [queue]);
  const visibleEchoes = echoes.filter((echo) => !echo.queueId || !queuedIds.has(echo.queueId));
  useEffect(() => {
    if (visibleEchoes.length < echoes.length) setEchoes((list) => list.filter((echo) => !echo.queueId || !queuedIds.has(echo.queueId)));
  }, [queuedIds, visibleEchoes.length, echoes.length]);
  const dropPending = (id: string) => setEchoes((list) => list.filter((entry) => entry.id !== id));
  const codexReceiptPending = session.engine === "codex" && session.online && session.state !== "running" && session.state !== "waiting" && !!awaiting &&
    (awaiting.fresh ? !items.some(item => item.kind === "user") : visibleEchoes.length > 0);
  const nativeQueued = awaiting?.fresh ? echo?.nativeQueued : visibleEchoes.at(-1)?.nativeQueued;
  const receiptId = codexReceiptPending && !nativeQueued ? visibleEchoes.at(-1)?.id ?? session.key : null;
  const [lateReceipt, setLateReceipt] = useState<string | null>(null);
  useEffect(() => {
    setLateReceipt(null);
    if (!receiptId) return;
    const timer = setTimeout(() => setLateReceipt(receiptId), 15_000);
    return () => clearTimeout(timer);
  }, [receiptId]);
  const deliveryLabel = uploadPreview ? "正在上传附件" : codexReceiptPending ? (nativeQueued ? NATIVE_QUEUED_NOTE : lateReceipt === receiptId ? "Codex 尚未确认收件，请查看终端" : awaiting?.resuming ? "正在恢复会话" : "等待 Codex 确认收件") : "";
  const progress = deliveryLabel ? "" : session.online && session.state === "running" ? "执行中" : awaiting ? (awaiting.resuming ? "正在恢复会话" : "等待回复") : "";
  const working = useMemo(() => progress && !compact ? { label: progress } : undefined, [progress, compact]);

  async function send(text:string, delivery?:"send"|"queue"|"steer") {
    const known = new Set(items.map((item) => item.id));
    // the message and the dots show before any request leaves
    const echoId = crypto.randomUUID();
    if (!compact) setEchoes((list) => [...list, { id: echoId, text, at: Date.now(), known }]);
    setAwaiting({ known, resuming: session.state === "stopped" && !resumedKey.current });
    try { return await deliver(text, known, delivery, echoId); }
    catch (cause) { dropPending(echoId); setAwaiting(null); throw cause; }
  }

  async function deliver(text:string, known:ReadonlySet<string>, delivery:"send"|"queue"|"steer"|undefined, echoId:string) {
    const options = { ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}) };
    const pendingMode = !review && permission?.pending ? permission.mode : undefined;
    if(session.state==="stopped" && !resumedKey.current){
      // the chosen model, effort and permission mode start the CLI (an older executor only takes a plain continue)
      const launchOptions = { ...(!review && features?.includes("launchOptions") ? options : {}), ...(pendingMode ? { permissions: pendingMode } : {}) };
      resumedKey.current=(await continueSession(session.key, Object.keys(launchOptions).length ? launchOptions : undefined)).key;
      markApplied(resumedKey.current, launch);
      if (pendingMode) tookPermission(resumedKey.current, pendingMode);
    }
    const key=resumedKey.current??session.key;
    if (!review && managedProtocol && session.state === "idle" && delivery !== "steer" && delivery !== "queue" && (applied.current !== JSON.stringify(launch) || (pendingMode && key === session.key))) {
      const next = { ...options, ...(pendingMode ? { permissions: pendingMode } : {}) };
      if (Object.keys(next).length) await continueSession(key, next);
      applied.current = JSON.stringify(launch);
      if (pendingMode) tookPermission(key, pendingMode);
    }
    // a Claude in a NexBot terminal takes the change at once, typed as its own commands
    if(delivery!=="steer" && !review && session.engine==="claude" && session.liveIn==="nexbot" && !!session.terminal && session.state!=="stopped" && applied.current!==JSON.stringify(launch)){
      const before = JSON.parse(applied.current) as LaunchChoice;
      for (const command of [launch.model && launch.model!==before.model ? "/model "+launch.model : "", launch.effort && launch.effort!==before.effort ? "/effort "+launch.effort : ""].filter(Boolean)) {
        await sendMessage(key, command, { delivery: delivery ?? "send", clientMessageId: crypto.randomUUID(), requestId: crypto.randomUUID() });
      }
      markApplied(key, launch);
    }
    // an edited message replaces the one the agent is still on: that turn stops first
    if(revision && !review && session.state==="running"){
      try { await interruptSession(key); } catch { /* the resend still goes */ }
    }
    let result: unknown;
    if(review&&details?.quote&&!details.quoteSent){
      result=await review.run("quoted-send",key,{text});
    } else {
      // the workbench contract: ids make a double click one message, a revision
      // keeps the link to the original, and the delivery follows the selector
      result=await sendMessage(key, text, {
        delivery: delivery ?? "send",
        clientMessageId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        ...(delivery === "steer" ? waitingSteer : {}),
        ...(revision ? { revisesMessageId: revision.messageId } : {}),
      });
      // a queued entry is not delivered yet: the queue strip shows it instead
      const outcome = result as Awaited<ReturnType<typeof sendMessage>>;
      if (outcome.queued) {
        const messageId = (result as { messageId?: string }).messageId;
        if (messageId) setEchoes((list) => list.map((echo) => echo.id === echoId ? { ...echo, queueId: messageId } : echo));
        void refreshQueue();
        setAwaiting(null);
      }
      else {
        if (outcome.nativeQueued) setEchoes(list => list.map(entry => entry.id === echoId ? { ...entry, nativeQueued: true } : entry));
        setAwaiting({ known, resuming: false, unconfirmed: outcome.delivery === "unconfirmed" });
      }
    }
    if(revision)setRevision(null);
    if(key!==session.key){transferGoal(session.key,key);onKeyChange(key)}
    return result;
  }

  /** Stopping pauses this session's queue in Core before the interrupt leaves. */
  const stop = () => stopSession(session.key, crypto.randomUUID());
  const resume = () => resumeQueue(session.key);
  const activeTeamRun = teamRuns?.find((run) => isRunLive(run.status));
  const visibleActiveWorkers = activeTeamRun ? visibleTeamWorkers(activeTeamRun.workers) : [];
  const hasVisibleHistoryRuns = Boolean(teamRuns?.some((run) => run.id !== activeTeamRun?.id && visibleTeamWorkers(run.workers).length > 0));
  const showTeamControl = !compact && Boolean(activeTeamRun || hasVisibleHistoryRuns);
  const teamDotTone = !activeTeamRun ? null
    : activeTeamRun.limitHit || activeTeamRun.heldCount || visibleActiveWorkers.some((worker) => worker.status === "waiting") ? "alert"
      : activeTeamRun.status === "paused" ? "paused"
        : visibleActiveWorkers.some((worker) => isWorkerWorking(worker.status)) ? "running"
          : null;
  const workerStatusTone = !workerBinding ? null
    : pendingRequests.length > 0 || shown.state === "waiting" || workerBinding.worker.status === "waiting" ? "waiting"
      : shown.online && (shown.state === "running" || workerBinding.worker.status === "starting") ? "running"
        : workerBinding.worker.status === "failed" ? "failed"
          : workerBinding.worker.status === "reported" ? "reported"
            : "stopped";

  return (
    <section className="cli-pane" aria-label={heading}>
      <header className="cli-pane-head">
        <button type="button" className="icon-button cli-back" aria-label="返回会话列表" onClick={onBack}><ArrowLeft size={18} /></button>
        <div className="cli-pane-title">
          <strong title={heading}>{heading}</strong>

        </div>
        {(!shown.online||shown.state==="running")?<span className="cli-chip" data-tone={sessionTone(shown)}>{sessionStatusLabel(shown)}</span>:null}
        {showTeamControl ? (
          <button
            type="button"
            ref={teamToggle}
            className="na-team-trigger"
            data-muted={activeTeamRun ? undefined : "1"}
            aria-controls={teamPanelId}
            aria-expanded={teamOpen}
            aria-label={activeTeamRun ? (visibleActiveWorkers.length > 0 ? `协作 ${visibleActiveWorkers.length}` : "协作") : "协作记录"}
            title={activeTeamRun ? "协作详情" : "历史协作"}
            onClick={() => { setWorkspaceOpen(false); setTeamOpen((open) => !open); }}
          >
            <Network size={14} aria-hidden="true" />
            <span>{activeTeamRun ? (visibleActiveWorkers.length > 0 ? `协作 ${visibleActiveWorkers.length}` : "协作") : "协作"}</span>
            {teamDotTone ? <i className="na-team-trigger-dot" data-tone={teamDotTone} aria-hidden="true" /> : null}
          </button>
        ) : null}
        {sideCount>0 && onSideOpen && !compact ? <button type="button" className="cli-open-local na-side-count" title="侧边会话" aria-label={"侧边会话 "+sideCount} onClick={()=>void onSideOpen()}><MessageSquare size={14}/>{sideCount}</button> : null}
        {onFork ? <button type="button" className="cli-open-local na-square" title="交给助手" aria-label="交给助手" onClick={onFork}><Share2 size={15} /></button> : null}
        {!compact && <button type="button" ref={workspaceToggle} className="na-workspace-toggle"
          aria-label="Git 工作区" aria-controls={workspaceId} aria-expanded={workspaceOpen}
          title={workspaceOpen?"收起 Git 工作区":"展开 Git 工作区"} onClick={()=>{setTeamOpen(false);setWorkspaceOpen(open=>!open)}}>
          <List size={18}/>
        </button>}
      </header>
      {!compact && workerBinding ? (
        <div className="na-worker-banner" role="region" aria-label="协作工人信息">
          <button
            type="button"
            className="na-worker-back"
            title="返回主会话"
            onClick={() => onSelectSession?.(workerBinding.run.leadKey)}
          >
            <Network size={13.5} aria-hidden="true" />
            <span>协作 · 来自</span>
            <strong title={leadTitle || workerBinding.run.title}>{leadTitle || workerBinding.run.title}</strong>
          </button>
          <div className="na-worker-banner-meta">
            {workerBinding.worker.role ? <><span>{workerBinding.worker.role}</span><span className="na-team-meta-sep" aria-hidden="true">·</span></> : null}
            <span className={workerBinding.worker.permissions === "readonly" ? "na-team-perm-readonly" : undefined}>
              {cliPermissionLabel(workerBinding.worker.engine, workerBinding.worker.permissions)}
            </span>
            <span className="na-team-meta-sep" aria-hidden="true">·</span>
            <code>{workerBinding.worker.name}</code>
            {workerStatusTone ? (
              <>
                <span className="na-team-meta-sep" aria-hidden="true">·</span>
                <span className="na-team-status" data-tone={workerStatusTone}>
                  {workerStatusTone === "waiting" ? "等你处理" : workerStatusTone === "running" ? "工作中" : TEAM_WORKER_STATUS_LABEL[workerBinding.worker.status]}
                </span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {noteError?<div role="alert" className="cli-banner">{noteError}<button type="button" className="text-button" onClick={dismissNoteError}>关闭</button></div>:null}
      {compact && details?.quote?<blockquote className="na-side-quote" aria-label="引用的原文">{details.quote}</blockquote>:null}
      <div className={"cli-pane-body"+(compact?"":" na-conversation-body")}>
        <TranscriptView key={session.key} active={session.state === "running" || session.state === "waiting"} echo={echo} guides={guides} queueEntries={queue?.entries} pending={[...visibleEchoes.filter(row => !guides.some(guide => guide.id === row.queueId)), ...(uploadPreview ? [{ id: "upload", text: uploadPreview }] : [])]} deliveryLabel={deliveryLabel} working={working} onItems={setItems} onSide={onSideOpen} onBranch={onBranchReply} onEdit={compact?undefined:edit} onSelectSession={onSelectSession} hidden={hidden} engine={session.engine} stream={stream} sessionKey={session.key} notes={notes} onNotes={updateNotes} />
        {showTeamControl && teamRuns ? (
          <div
            ref={teamLayer}
            id={teamPanelId}
            className="na-workspace-layer na-team-layer"
            data-open={teamOpen}
            inert={!teamOpen}
            aria-hidden={!teamOpen}
            onKeyDown={(event) => {
              if (event.key === "Escape") { setTeamOpen(false); teamToggle.current?.focus(); }
            }}
          >
            <TeamPanel
              runs={teamRuns}
              selectedKey={session.key}
              onOpenSession={(key) => { setTeamOpen(false); onSelectSession?.(key); }}
              onPause={onTeamPause ?? (async () => {})}
              onResume={onTeamResume ?? (async () => {})}
              onCancel={onTeamCancel ?? (async () => {})}
              onStopWorker={onTeamStopWorker ?? (async () => {})}
            />
          </div>
        ) : null}
        {!compact && <div ref={workspaceLayer} id={workspaceId} className="na-workspace-layer" data-open={workspaceOpen} inert={!workspaceOpen} aria-hidden={!workspaceOpen}
          onKeyDown={event=>{if(event.key==="Escape" && !(event.target as Element).closest("dialog")){setWorkspaceOpen(false);workspaceToggle.current?.focus()}}}>
          <SessionInfoCard session={session} items={items} open={workspaceOpen} onTerminalOpen={onTerminalOpen && (()=>{setWorkspaceOpen(false);onTerminalOpen()})}/>
        </div>}
      </div>
      {cards.length && onAnswer ? (
        <div className="cli-requests" role="region" aria-label="等你处理的请求">
          {cards.map((record) => <RequestCard key={record.view.id} record={record} now={now} onAnswer={onAnswer} />)}
        </div>
      ) : null}
      <Composer
        session={shown} notes={notes} onNotes={updateNotes}
        features={features} launch={launch} onLaunch={chooseLaunch}
        permissions={permissionModes.length ? { modes: permissionModes, value: permission?.mode, pending: permission?.pending ? (takesNow ? "发送下一条消息时生效" : "会话下次启动时生效") : undefined, onChange: choosePermission } : undefined}
        onSend={send} onUploadPreview={setUploadPreview}
        onInterrupt={() => review ? interruptSession(session.key) : stop()}
        queue={queue}
        revision={revision}
        onCancelRevision={cancelEdit}
        onQueueWithdraw={async (entryId, version) => { await withdrawQueued(entryId, version); }}
        onQueueEdit={async (entryId, version, text) => { await editQueued(entryId, version, text); }}
        steerQuestionId={steerQuestionId} interruptWaiting={interruptWaiting}
        onQueueSteer={guideEntry} guided={new Set(guides.map(guide => guide.id))}
        onQueueResume={async () => { await resume(); }}
      />
      {failure && !compact ? <ModelFailureDialog reason={failure} onClose={() => setFailure(null)}/> : null}
    </section>
  );
}

const hiddenKey = (key: string) => "nexagent.hidden." + key;
function readHidden(key: string): ReadonlySet<string> {
  try { const value = JSON.parse(sessionStorage.getItem(hiddenKey(key)) || "[]"); return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []); }
  catch { return new Set(); }
}
function saveHidden(key: string, ids: ReadonlySet<string>) {
  try { if (ids.size) sessionStorage.setItem(hiddenKey(key), JSON.stringify([...ids].slice(-200))); else sessionStorage.removeItem(hiddenKey(key)); }
  catch { /* lasts for the page */ }
}
