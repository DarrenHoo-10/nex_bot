// One open session: header, transcript, and composer. The composer talks to
// the workbench contracts: sends carry idempotency ids, a running session
// queues or steers, stopping pauses the outbox in Core, and edit-and-resend
// records the revised message.
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, List, LoaderCircle, MessageSquare, Share2, SquareTerminal } from "lucide-react";
import type { CliItem, CliAnswerDecision, CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { continueSession, editQueued, interruptSession, resumeQueue, sendMessage, steerQueued, stopSession, withdrawQueued } from "./api";
import { useReview } from "./WorkbenchReview";
import { useNotes } from "./use-notes";
import {transferGoal} from "./composer-additions";
import { Composer } from "./Composer";
import { cardState, type RequestRecord } from "./requests";
import { RequestCard } from "./RequestCard";
import { askedSession, canAttach, sessionStatusLabel, sessionTitle, sessionTone } from "./session-model";
import type { CliStream } from "./stream";
import { SessionInfoCard } from "./SessionInfoCard";
import { TranscriptView } from "./TranscriptView";
import { useCliQueue } from "./use-queue";

export interface SessionPaneProps {
  session: CliSessionView;
  stream: CliStream;
  /** a continued session gets a new key */
  onKeyChange(key: CliSessionKey): void;
  onBack(): void;
  /** this session's request cards */
  requests?: readonly RequestRecord[];
  now?: number;
  onAnswer?(id: string, decision: CliAnswerDecision, answers?: Record<string, string>): Promise<unknown>;
  /** hand the session to an assistant; absent when there is no assistant to take it */
  onFork?(): void;
  onSideOpen?(quote?:string,message?:string):Promise<void>;
  onTerminalOpen?():void;
  /** side chats of this session that are not showing: a button brings the panel back */
  sideCount?:number;
  compact?:boolean;
  /** the display name Core keeps for the session (renames, "（fork）"), over the CLI's own title */
  title?:string;
}

const NO_REQUESTS: readonly RequestRecord[] = [];

export function SessionPane({ session, stream, onKeyChange, onBack, requests = NO_REQUESTS, now = Date.now(), onAnswer, onFork, onSideOpen, onTerminalOpen, sideCount = 0, compact, title }: SessionPaneProps) {
  const review=useReview();
  const details=review?.records[session.key];
  const heading=details?.title||title?.trim()||sessionTitle(session);
  const [workspaceOpen,setWorkspaceOpen]=useState(false);
  const workspaceId=useId();
  const workspaceToggle=useRef<HTMLButtonElement>(null);
  // Core keeps the notes; the isolated review fixture keeps them in the tab
  const {notes,update:updateNotes,error:noteError,dismissError:dismissNoteError}=useNotes(session.key,!review);
  const [items,setItems]=useState<CliItem[]>([]);
  const cards = [...requests].sort((a, b) => Number(a.closed) - Number(b.closed));
  const pending = requests.filter((record) => cardState(record, now) === "pending").length;
  const shown = askedSession(session, pending);
  const resumedKey = useRef<CliSessionKey|null>(null);
  const queue = useCliQueue(stream, session.key);
  const [revision, setRevision] = useState<{ messageId: string; text: string } | null>(null);
  // From a send until the session answers: a resumed CLI can take a while to
  // print anything, and without this the page looks like nothing happened.
  const [awaiting, setAwaiting] = useState<{ known: ReadonlySet<string>; resuming: boolean; unconfirmed?: boolean } | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!awaiting) return;
    if (session.state === "waiting" || !session.online) { setAwaiting(null); return; }
    // the device clock may differ from this one: a reply is an item that was not there at send time
    if (items.some((item) => item.kind !== "user" && item.kind !== "turn" && !awaiting.known.has(item.id))) setAwaiting(null);
  }, [awaiting, items, session.state, session.online]);
  useEffect(() => {
    setSlow(false);
    if (!awaiting) return;
    const timer = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(timer);
  }, [awaiting]);
  const progress = awaiting ? (awaiting.resuming ? "正在恢复会话…" : awaiting.unconfirmed ? "已发送，等待会话接收…" : "已送达，等待回复…")
    : session.online && session.state === "running" ? "正在处理…" : "";

  async function send(text:string, delivery?:"send"|"queue"|"steer") {
    const known = new Set(items.map((item) => item.id));
    if(session.state==="stopped" && !resumedKey.current){
      setAwaiting({ known, resuming: true });
      try { resumedKey.current=(await continueSession(session.key)).key; }
      catch (cause) { setAwaiting(null); throw cause; }
    }
    const key=resumedKey.current??session.key;
    let result: unknown;
    if(review&&details?.quote&&!details.quoteSent){
      result=await review.run("quoted-send",key,{text});
    } else {
      // the workbench contract: ids make a double click one message, a revision
      // keeps the link to the original, and the delivery follows the selector
      try {
        result=await sendMessage(key, text, {
          delivery: delivery ?? "send",
          clientMessageId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          ...(revision ? { revisesMessageId: revision.messageId } : {}),
        });
      } catch (cause) { setAwaiting(null); throw cause; }
      // a queued entry is not delivered yet: the queue strip shows it instead
      const outcome = result as { queued?: boolean; status?: string; delivery?: string };
      if (outcome.queued && outcome.status !== "uncertain") setAwaiting(null);
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
        <TranscriptView onItems={compact?undefined:setItems} onSide={onSideOpen} onEdit={compact?undefined:(messageId, text) => setRevision({ messageId, text })} engine={session.engine} stream={stream} sessionKey={session.key} notes={notes} onNotes={updateNotes} />
        {!compact && <div id={workspaceId} className="na-workspace-layer" data-open={workspaceOpen} inert={!workspaceOpen} aria-hidden={!workspaceOpen}
          onKeyDown={event=>{if(event.key==="Escape" && !(event.target as Element).closest("dialog")){setWorkspaceOpen(false);workspaceToggle.current?.focus()}}}>
          <SessionInfoCard session={session} items={items} open={workspaceOpen} onTerminalOpen={onTerminalOpen && (()=>{setWorkspaceOpen(false);onTerminalOpen()})}/>
        </div>}
      </div>
      {progress && !compact ? <div className="na-progress" role="status">
        <LoaderCircle className="na-busy-icon" size={14}/><span>{progress}</span>
        {slow && onTerminalOpen && canAttach(session) ? <button type="button" className="text-button" onClick={onTerminalOpen}><SquareTerminal size={13}/>打开远程终端</button> : null}
      </div> : null}
      <Composer
        session={session} notes={notes} onNotes={updateNotes}
        onSend={send}
        onInterrupt={() => review ? interruptSession(session.key) : stop()}
        queue={queue}
        revision={revision}
        onCancelRevision={() => setRevision(null)}
        onQueueWithdraw={async (entryId, version) => { await withdrawQueued(entryId, version); }}
        onQueueEdit={async (entryId, version, text) => { await editQueued(entryId, version, text); }}
        onQueueSteer={async (entryId) => { await steerQueued(entryId); }}
        onQueueResume={async () => { await resume(); }}
      />
    </section>
  );
}
