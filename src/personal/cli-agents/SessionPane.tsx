// One open session: header, terminal or conversation, and the composer.
import { useState } from "react";
import { ArrowLeft, ExternalLink, Share2 } from "lucide-react";
import type { CliAnswerDecision, CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { cliErrorText, continueSession, interruptSession, openLocal, sendMessage } from "./api";
import { Composer } from "./Composer";
import { cardState, type RequestRecord } from "./requests";
import { RequestCard } from "./RequestCard";
import { askedSession, canAttach, ENGINE_LABEL, folderLabel, sessionStatusLabel, sessionTitle, sessionTone } from "./session-model";
import type { CliStream } from "./stream";
import { TerminalView } from "./TerminalView";
import { TranscriptView } from "./TranscriptView";

type Tab = "terminal" | "chat";

export interface SessionPaneProps {
  session: CliSessionView;
  stream: CliStream;
  /** the stream's socket is open */
  connected: boolean;
  /** a continued session gets a new key */
  onKeyChange(key: CliSessionKey): void;
  onBack(): void;
  /** this session's request cards */
  requests?: readonly RequestRecord[];
  now?: number;
  onAnswer?(id: string, decision: CliAnswerDecision, answers?: Record<string, string>): Promise<unknown>;
  /** hand the session to an assistant; absent when there is no assistant to take it */
  onFork?(): void;
}

const NO_REQUESTS: readonly RequestRecord[] = [];

export function SessionPane({ session, stream, connected, onKeyChange, onBack, requests = NO_REQUESTS, now = Date.now(), onAnswer, onFork }: SessionPaneProps) {
  const attachable = canAttach(session);
  const [wanted, setWanted] = useState<Tab>(attachable ? "terminal" : "chat");
  const [error, setError] = useState("");
  const cards = [...requests].sort((a, b) => Number(a.closed) - Number(b.closed));
  const pending = requests.filter((record) => cardState(record, now) === "pending").length;
  const shown = askedSession(session, pending);
  const tab: Tab = wanted === "terminal" && attachable ? "terminal" : "chat";

  const openOnComputer = async () => {
    setError("");
    try { await openLocal(session.key); } catch (cause) { setError(cliErrorText(cause)); }
  };

  return (
    <section className="cli-pane" aria-label={sessionTitle(session)}>
      <header className="cli-pane-head">
        <button type="button" className="icon-button cli-back" aria-label="返回会话列表" onClick={onBack}><ArrowLeft size={18} /></button>
        <div className="cli-pane-title">
          <strong title={sessionTitle(session)}>{sessionTitle(session)}</strong>
          <small title={session.cwd}>{ENGINE_LABEL[session.engine]} · {folderLabel(session.cwd)}{session.gitBranch ? ` · ${session.gitBranch}` : ""}</small>
        </div>
        <span className="cli-chip" data-tone={sessionTone(shown)}>{sessionStatusLabel(shown)}</span>
        {onFork ? <button type="button" className="cli-open-local" onClick={onFork}><Share2 size={14} />交给助手</button> : null}
        {session.online ? <button type="button" className="cli-open-local" onClick={() => void openOnComputer()}><ExternalLink size={14} />在电脑上打开</button> : null}
      </header>
      {attachable ? (
        <div className="cli-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "terminal"} onClick={() => setWanted("terminal")}>终端</button>
          <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setWanted("chat")}>对话</button>
        </div>
      ) : null}
      {error ? <div className="cli-notice" data-level="error" role="alert">{error}</div> : null}
      {cards.length && onAnswer ? (
        <div className="cli-requests" role="region" aria-label="等你处理的请求">
          {cards.map((record) => <RequestCard key={record.view.id} record={record} now={now} onAnswer={onAnswer} />)}
        </div>
      ) : null}
      <div className="cli-pane-body">
        {tab === "terminal"
          ? <TerminalView stream={stream} sessionKey={session.key} connected={connected} />
          : <TranscriptView stream={stream} sessionKey={session.key} />}
      </div>
      <Composer
        session={session}
        onSend={(text) => sendMessage(session.key, text)}
        onInterrupt={() => interruptSession(session.key)}
        onContinue={async () => { const { key } = await continueSession(session.key); onKeyChange(key); }}
      />
    </section>
  );
}
