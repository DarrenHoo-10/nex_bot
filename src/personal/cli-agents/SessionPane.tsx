// One open session: header, transcript, and composer. The composer talks to
// the workbench contracts: sends carry idempotency ids, a running session
// queues or steers, stopping pauses the outbox in Core, and edit-and-resend
// records the revised message.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, List, MessageSquare, Share2 } from "lucide-react";
import { cliQuestionToSteer, modelFailureReason, type CliItem, type CliAnswerDecision, type CliSessionKey, type CliSessionView } from "../../../shared/cli-agents";
import { ModelFailureDialog } from "./ModelFailureDialog";
import { continueSession, editQueued, interruptSession, resumeQueue, sendMessage, steerQueued, stopSession, withdrawQueued } from "./api";
import { useReview } from "./WorkbenchReview";
import { useNotes } from "./use-notes";
import {getLaunch,saveLaunch,transferGoal} from "./composer-additions";
import { Composer, type LaunchChoice } from "./Composer";
import { cardState, type RequestRecord } from "./requests";
import { RequestCard } from "./RequestCard";
import { askedSession, sessionStatusLabel, sessionTitle, sessionTone } from "./session-model";
import type { CliStream } from "./stream";
import { SessionInfoCard } from "./SessionInfoCard";
import { TranscriptView } from "./TranscriptView";
import { isVisibleQueueEntry, useCliQueue } from "./use-queue";

export interface SessionPaneProps {
  session: CliSessionView;
  stream: CliStream;
  /** a continued session gets a new key */
  onKeyChange(key: CliSessionKey): void;
  onBack(): void;
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
  echo?: { text: string; at: number };
}

const NO_REQUESTS: readonly RequestRecord[] = [];

/** A message sent from this page that the session's records do not hold yet. */
export interface PendingSend { id: string; text: string; at: number; known: ReadonlySet<string>; queueId?: string }

const plain = (text: string) => text.replace(/\s+/g, " ").trim();
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

export function SessionPane({ session, stream, onKeyChange, onBack, requests = NO_REQUESTS, now = Date.now(), onAnswer, onFork, onBranchReply, onSideOpen, onTerminalOpen, sideCount = 0, compact, title, features, echo }: SessionPaneProps) {
  const review=useReview();
  const details=review?.records[session.key];
  const heading=details?.title||title?.trim()||sessionTitle(session);
  const [workspaceOpen,setWorkspaceOpen]=useState(false);
  const workspaceId=useId();
  const workspaceToggle=useRef<HTMLButtonElement>(null);
  const workspaceLayer=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!workspaceOpen)return;
    const closeOutside=(event:MouseEvent)=>{
      const clicked=event.composedPath();
      if(!clicked.some(target=>target===workspaceLayer.current||target===workspaceToggle.current))setWorkspaceOpen(false);
    };
    document.addEventListener("click",closeOutside,true);
    return ()=>document.removeEventListener("click",closeOutside,true);
  },[workspaceOpen]);
  // Core keeps the notes; the isolated review fixture keeps them in the tab
  const {notes,update:updateNotes,error:noteError,dismissError:dismissNoteError}=useNotes(session.key,!review);
  const [items,setItems]=useState<CliItem[]>([]);
  const cards = [...requests].sort((a, b) => Number(a.closed) - Number(b.closed));
  const pendingRequests = requests.filter((record) => cardState(record, now) === "pending");
  const shown = askedSession(session, pendingRequests.length);
  const managedClaude = session.engine === "claude" && session.liveIn === "nexbot" && !!session.terminal;
  const steerQuestionId = managedClaude && (session.state === "running" || session.state === "waiting")
    ? cliQuestionToSteer(pendingRequests.map((record) => record.view)) : undefined;
  const interruptWaiting = managedClaude && session.state === "waiting" && pendingRequests.length === 0;
  const waitingSteer = { questionId: steerQuestionId, ...(interruptWaiting ? { interruptWaiting: true } : {}) };
  const resumedKey = useRef<CliSessionKey|null>(null);
  const { queue, refreshQueue } = useCliQueue(stream, session.key);
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
  /** what this page last told the running CLI, so a send only switches when the choice changed */
  const applied = useRef<string>(JSON.stringify({ model: "", effort: "" }));
  const chooseLaunch = (next: LaunchChoice) => { setLaunch(next); saveLaunch(session.key, next); };
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
  const progress = awaiting ? (awaiting.fresh ? "执行中" : awaiting.resuming ? "正在恢复会话" : "等待回复")
    : session.online && session.state === "running" ? "执行中" : "";
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
    if(session.state==="stopped" && !resumedKey.current){
      // the chosen model and effort start the CLI (an older executor only takes a plain continue)
      const launchOptions = !review && features?.includes("launchOptions") && Object.keys(options).length ? options : undefined;
      resumedKey.current=(await continueSession(session.key, launchOptions)).key;
      applied.current = JSON.stringify(launch);
    }
    const key=resumedKey.current??session.key;
    // a Claude in a NexBot terminal takes the change at once, typed as its own commands
    if(delivery!=="steer" && !review && session.engine==="claude" && session.liveIn==="nexbot" && !!session.terminal && session.state!=="stopped" && applied.current!==JSON.stringify(launch)){
      const before = JSON.parse(applied.current) as LaunchChoice;
      for (const command of [launch.model && launch.model!==before.model ? "/model "+launch.model : "", launch.effort && launch.effort!==before.effort ? "/effort "+launch.effort : ""].filter(Boolean)) {
        await sendMessage(key, command, { delivery: delivery ?? "send", clientMessageId: crypto.randomUUID(), requestId: crypto.randomUUID() });
      }
      applied.current = JSON.stringify(launch);
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
      const outcome = result as { queued?: boolean; status?: string; delivery?: string };
      if (outcome.queued) {
        const messageId = (result as { messageId?: string }).messageId;
        if (messageId) setEchoes((list) => list.map((echo) => echo.id === echoId ? { ...echo, queueId: messageId } : echo));
        void refreshQueue();
        setAwaiting(null);
      }
      else setAwaiting({ known, resuming: false, unconfirmed: outcome.delivery === "unconfirmed" });
    }
    if(revision)setRevision(null);
    if(key!==session.key){transferGoal(session.key,key);onKeyChange(key)}
    return result;
  }

  /** Stopping pauses this session's queue in Core before the interrupt leaves. */
  const stop = () => stopSession(session.key, crypto.randomUUID());
  const resume = () => resumeQueue(session.key);

  return (
    <section className="cli-pane" aria-label={heading}>
      <header className="cli-pane-head">
        <button type="button" className="icon-button cli-back" aria-label="返回会话列表" onClick={onBack}><ArrowLeft size={18} /></button>
        <div className="cli-pane-title">
          <strong title={heading}>{heading}</strong>

        </div>
        {(!shown.online||shown.state==="waiting"||shown.state==="running")?<span className="cli-chip" data-tone={sessionTone(shown)}>{sessionStatusLabel(shown)}</span>:null}
        {sideCount>0 && onSideOpen && !compact ? <button type="button" className="cli-open-local na-side-count" title="侧边会话" aria-label={"侧边会话 "+sideCount} onClick={()=>void onSideOpen()}><MessageSquare size={14}/>{sideCount}</button> : null}
        {onFork ? <button type="button" className="cli-open-local na-square" title="交给助手" aria-label="交给助手" onClick={onFork}><Share2 size={15} /></button> : null}
        {!compact && <button type="button" ref={workspaceToggle} className="na-workspace-toggle"
          aria-label="Git 工作区" aria-controls={workspaceId} aria-expanded={workspaceOpen}
          title={workspaceOpen?"收起 Git 工作区":"展开 Git 工作区"} onClick={()=>setWorkspaceOpen(open=>!open)}>
          <List size={18}/>
        </button>}
      </header>
      {cards.length && onAnswer ? (
        <div className="cli-requests" role="region" aria-label="等你处理的请求">
          {cards.map((record) => <RequestCard key={record.view.id} record={record} now={now} onAnswer={onAnswer} />)}
        </div>
      ) : null}
      {noteError?<div role="alert" className="cli-banner">{noteError}<button type="button" className="text-button" onClick={dismissNoteError}>关闭</button></div>:null}
      {compact && details?.quote?<blockquote className="na-side-quote" aria-label="引用的原文">{details.quote}</blockquote>:null}
      <div className={"cli-pane-body"+(compact?"":" na-conversation-body")}>
        <TranscriptView key={session.key} active={session.state === "running" || session.state === "waiting"} echo={echo} pending={visibleEchoes} working={working} onItems={compact?undefined:setItems} onSide={onSideOpen} onBranch={onBranchReply} onEdit={compact?undefined:edit} hidden={hidden} engine={session.engine} stream={stream} sessionKey={session.key} notes={notes} onNotes={updateNotes} />
        {!compact && <div ref={workspaceLayer} id={workspaceId} className="na-workspace-layer" data-open={workspaceOpen} inert={!workspaceOpen} aria-hidden={!workspaceOpen}
          onKeyDown={event=>{if(event.key==="Escape" && !(event.target as Element).closest("dialog")){setWorkspaceOpen(false);workspaceToggle.current?.focus()}}}>
          <SessionInfoCard session={session} items={items} open={workspaceOpen} onTerminalOpen={onTerminalOpen && (()=>{setWorkspaceOpen(false);onTerminalOpen()})}/>
        </div>}
      </div>
      <Composer
        session={shown} notes={notes} onNotes={updateNotes}
        features={features} launch={launch} onLaunch={chooseLaunch}
        onSend={send}
        onInterrupt={() => review ? interruptSession(session.key) : stop()}
        queue={queue}
        revision={revision}
        onCancelRevision={cancelEdit}
        onQueueWithdraw={async (entryId, version) => { await withdrawQueued(entryId, version); }}
        onQueueEdit={async (entryId, version, text) => { await editQueued(entryId, version, text); }}
        steerQuestionId={steerQuestionId} interruptWaiting={interruptWaiting}
        onQueueSteer={async (entryId, version) => {
          const { entry } = await steerQueued(entryId, version, waitingSteer);
          if (entry.status === "pending") throw new Error("引导失败，消息仍在队列中");
          if (entry.status === "uncertain") throw new Error("引导结果待确认");
        }}
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
