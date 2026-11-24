// "交给助手": pick one of the user's assistants; Core opens a new topic with a
// digest of the session and the page goes there.
import { useRef, useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { CliSessionView } from "../../../shared/cli-agents";
import { CliApiError, cliErrorText, forkSession } from "./api";
import { sessionTitle } from "./session-model";

export interface CliBotChoice { id: string; name: string }

export interface ForkDialogProps {
  session: CliSessionView;
  itemId?: string;
  bots: readonly CliBotChoice[];
  /** the assistant the user was last talking to */
  initialBotId?: string;
  onClose(): void;
  onForked(botId: string, conversationId: string): void;
}

export function ForkDialog({ session, itemId, bots, initialBotId, onClose, onForked }: ForkDialogProps) {
  const [botId, setBotId] = useState(() => (initialBotId && bots.some((bot) => bot.id === initialBotId) ? initialBotId : bots[0]?.id ?? ""));
  const title = itemId ? "分支到新聊天" : "交给助手";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const form=useRef<HTMLFormElement>(null);
  useEffect(()=>{
    const trigger=document.activeElement as HTMLElement|null;
    form.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
    return ()=>{if(trigger?.isConnected)trigger.focus()};
  },[]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!botId || busy) return;
    setBusy(true);
    setError("");
    try {
      const forked = itemId ? await forkSession(session.key, botId, itemId) : await forkSession(session.key, botId);
      onForked(forked.botId || botId, forked.conversationId);
    } catch (cause) {
      setError(cause instanceof CliApiError && cause.code === "not_found" ? (itemId ? "找不到这条回复" : "没有可交接的记录") : cliErrorText(cause, itemId ? "没能创建分支" : "没能交接"));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onClose(); }}>
      <form ref={form} onKeyDown={e=>{
        if(e.key!=="Tab")return;
        const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const first=buttons[0], last=buttons.at(-1);if(!first||!last)return;
        if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus()}
      }} className="modal cli-dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={(event) => void submit(event)}>
        <div className="modal-heading">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="cli-fork-session" title={session.cwd}>{sessionTitle(session)}</div>
        <div className="cli-field" role="group" aria-label="助手">
          <div className="cli-recents">
            {bots.map((bot) => <button key={bot.id} type="button" aria-pressed={bot.id === botId} disabled={busy} onClick={() => { setBotId(bot.id); setError(""); }}>{bot.name || "助手"}</button>)}
          </div>
        </div>
        {error ? <p className="cli-field-hint" role="alert">{error}</p> : null}
        <div className="cli-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={!botId || busy}>{busy ? "正在创建…" : title}</button>
        </div>
      </form>
    </div>
  );
}
