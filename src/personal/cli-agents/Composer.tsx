// Message box under a session. What it offers follows composerMode(): send
// (and interrupt while running), continue a stopped session, or a plain hint
// when the session cannot be driven from here.
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Play, Square } from "lucide-react";
import { MAX_SEND_TEXT, utf8ByteLength, type CliSessionView } from "../../../shared/cli-agents";
import { cliErrorText, type SendResult } from "./api";
import { composerMode } from "./session-model";

// Drafts live as long as the page, one per session.
const drafts = new Map<string, string>();

export const OUTSIDE_NOTE = "发送到电脑上的会话";
export const UNCONFIRMED_NOTE = "已发送，未确认";
export const WAITING_NOTE = "将在电脑上回答问题后读取";

/** What a send to a session outside nex_bot's terminals adds to the status line; a confirmed one says nothing more. */
export function deliveryNote(result: unknown): string {
  const sent = (result && typeof result === "object" ? result : {}) as Partial<SendResult>;
  return [sent.delivery === "unconfirmed" ? UNCONFIRMED_NOTE : "", sent.waiting ? WAITING_NOTE : ""].filter(Boolean).join("，");
}

export interface ComposerProps {
  session: CliSessionView;
  onSend(text: string): Promise<unknown>;
  onInterrupt(): Promise<unknown>;
  onContinue(): Promise<unknown>;
}

export function Composer({ session, onSend, onInterrupt, onContinue }: ComposerProps) {
  const mode = composerMode(session);
  const [text, setText] = useState(() => drafts.get(session.key) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const imeEndedAt = useRef(0);
  const mounted = useRef(true);
  const key = session.key;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // another session: its own draft, no stale error
  useEffect(() => {
    setText(drafts.get(key) ?? "");
    setError("");
    setNote("");
  }, [key]);

  const change = (value: string) => {
    setText(value);
    if (value) drafts.set(key, value);
    else drafts.delete(key);
    if (error) setError("");
    if (note) setNote("");
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      return { result: await action() };
    } catch (cause) {
      if (mounted.current) setError(cliErrorText(cause));
      return null;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const tooLarge = utf8ByteLength(text) > MAX_SEND_TEXT;
  const submit = async () => {
    const value = text.trim();
    if (!value || busy || tooLarge) return;
    const sent = await run(() => onSend(value));
    if (!sent || !mounted.current) return;
    change("");
    setNote(deliveryNote(sent.result));
  };

  if (mode.kind === "blocked") {
    return <div className="cli-composer is-blocked" data-testid="cli-composer" role="status"><span>{mode.hint}</span></div>;
  }
  if (mode.kind === "stopped") {
    return (
      <div className="cli-composer is-stopped" data-testid="cli-composer">
        <span>{mode.hint ?? "会话已停止"}</span>
        <button type="button" className="primary" disabled={busy || !!mode.hint} onClick={() => void run(onContinue)}><Play size={14} />继续</button>
        {error ? <small role="alert" className="cli-composer-error">{error}</small> : null}
      </div>
    );
  }
  return (
    <form className="cli-composer" data-testid="cli-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea
        aria-label="发送给 Agent 的消息"
        placeholder="发消息"
        rows={Math.min(5, Math.max(1, text.split("\n").length))}
        value={text}
        onChange={(event) => change(event.target.value)}
        onCompositionEnd={() => { imeEndedAt.current = Date.now(); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || Date.now() - imeEndedAt.current < 150) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="cli-composer-actions">
        {mode.running ? <button type="button" aria-label="中断" title="中断" disabled={busy} onClick={() => void run(onInterrupt)}><Square size={14} />中断</button> : null}
        <button type="submit" className="primary" aria-label="发送" disabled={busy || !text.trim() || tooLarge}><ArrowUp size={16} /></button>
      </div>
      {tooLarge ? <small role="alert" className="cli-composer-error">内容太长</small> : error ? <small role="alert" className="cli-composer-error">{error}</small> : null}
      {mode.outside ? <small className="cli-composer-note" role="status" data-testid="cli-composer-note">{note || OUTSIDE_NOTE}</small> : null}
    </form>
  );
}
