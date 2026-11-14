// One open session: header, terminal or conversation, and the composer.
import { useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { cliErrorText, continueSession, interruptSession, openLocal, sendMessage } from "./api";
import { Composer } from "./Composer";
import { canAttach, ENGINE_LABEL, folderLabel, sessionStatusLabel, sessionTitle, sessionTone } from "./session-model";
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
}

export function SessionPane({ session, stream, connected, onKeyChange, onBack }: SessionPaneProps) {
  const attachable = canAttach(session);
  const [wanted, setWanted] = useState<Tab>(attachable ? "terminal" : "chat");
  const [error, setError] = useState("");
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
        <span className="cli-chip" data-tone={sessionTone(session)}>{sessionStatusLabel(session)}</span>
        {session.online ? <button type="button" className="cli-open-local" onClick={() => void openOnComputer()}><ExternalLink size={14} />在电脑上打开</button> : null}
      </header>
      {attachable ? (
        <div className="cli-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "terminal"} onClick={() => setWanted("terminal")}>终端</button>
          <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setWanted("chat")}>对话</button>
        </div>
      ) : null}
      {error ? <div className="cli-notice" data-level="error" role="alert">{error}</div> : null}
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
