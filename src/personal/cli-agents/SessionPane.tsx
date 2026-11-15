// One open session: header, transcript, and composer. The composer talks to
// the workbench contracts: sends carry idempotency ids, a running session
// queues or steers, stopping pauses the outbox in Core, and edit-and-resend
// records the revised message.
import { useId, useRef, useState } from "react";
import { ArrowLeft, List, Share2 } from "lucide-react";
import type { CliItem, CliAnswerDecision, CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { continueSession, editQueued, interruptSession, resumeQueue, sendMessage, steerQueued, stopSession, withdrawQueued } from "./api";
import { readNotes, storeNotes, useReview, type Note } from "./WorkbenchReview";
import {transferGoal} from "./composer-additions";
import { Composer } from "./Composer";
import { cardState, type RequestRecord } from "./requests";
import { RequestCard } from "./RequestCard";
import { askedSession, sessionStatusLabel, sessionTitle, sessionTone } from "./session-model";
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
  compact?:boolean;
}

const NO_REQUESTS: readonly RequestRecord[] = [];

export function SessionPane({ session, stream, onKeyChange, onBack, requests = NO_REQUESTS, now = Date.now(), onAnswer, onFork, onSideOpen, onTerminalOpen, compact }: SessionPaneProps) {
  const review=useReview();
  const details=review?.records[session.key];
  const [workspaceOpen,setWorkspaceOpen]=useState(false);
  const workspaceId=useId();
  const workspaceToggle=useRef<HTMLButtonElement>(null);
  const [notes,setNotes]=useState<Note[]>(()=>readNotes(session.key));
  const updateNotes=(next:Note[])=>{setNotes(next);storeNotes(session.key,next)};
  const [items,setItems]=useState<CliItem[]>([]);
  const cards = [...requests].sort((a, b) => Number(a.closed) - Number(b.closed));
  const pending = requests.filter((record) => cardState(record, now) === "pending").length;
  const shown = askedSession(session, pending);
  const resumedKey = useRef<CliSessionKey|null>(null);
  const queue = useCliQueue(stream, session.key);
  const [revision, setRevision] = useState<{ messageId: string; text: string } | null>(null);

  async function send(text:string, delivery?:"send"|"queue"|"steer") {
    if(session.state==="stopped" && !resumedKey.current)resumedKey.current=(await continueSession(session.key)).key;
    const key=resumedKey.current??session.key;
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
        ...(revision ? { revisesMessageId: revision.messageId } : {}),
      });
    }
    if(revision)setRevision(null);
    if(key!==session.key){transferGoal(session.key,key);onKeyChange(key)}
    return result;
  }

  /** Stopping pauses this session's queue in Core before the interrupt leaves. */
  const stop = () => stopSession(session.key, crypto.randomUUID());
  const resume = () => resumeQueue(session.key);

  return (
    <section className="cli-pane" aria-label={details?.title||sessionTitle(session)}>
      <header className="cli-pane-head">
        <button type="button" className="icon-button cli-back" aria-label="返回会话列表" onClick={onBack}><ArrowLeft size={18} /></button>
        <div className="cli-pane-title">
          <strong title={details?.title||sessionTitle(session)}>{details?.title||sessionTitle(session)}</strong>

        </div>
        {(!shown.online||shown.state==="waiting"||shown.state==="running")?<span className="cli-chip" data-tone={sessionTone(shown)}>{sessionStatusLabel(shown)}</span>:null}
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
      {compact && details?.quote?<blockquote className="na-side-quote" aria-label="引用的原文">{details.quote}</blockquote>:null}
      <div className={"cli-pane-body"+(compact?"":" na-conversation-body")}>
        <TranscriptView onItems={compact?undefined:setItems} onSide={onSideOpen} onEdit={compact?undefined:(messageId, text) => setRevision({ messageId, text })} engine={session.engine} stream={stream} sessionKey={session.key} notes={notes} onNotes={updateNotes} />
        {!compact && <div id={workspaceId} className="na-workspace-layer" data-open={workspaceOpen} inert={!workspaceOpen} aria-hidden={!workspaceOpen}
          onKeyDown={event=>{if(event.key==="Escape" && !(event.target as Element).closest("dialog")){setWorkspaceOpen(false);workspaceToggle.current?.focus()}}}>
          <SessionInfoCard session={session} items={items} open={workspaceOpen} onTerminalOpen={onTerminalOpen && (()=>{setWorkspaceOpen(false);onTerminalOpen()})}/>
        </div>}
      </div>
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
