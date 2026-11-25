// "交给助手": pick one of the user's assistants; Core opens a new topic with a
// digest of the session and the page goes there.
import { useRef, useEffect, useState, type FormEvent } from "react";
import { Bot, Check, Folder, GitBranch, LoaderCircle, Share2, X } from "lucide-react";
import type { CliSessionView } from "../../../shared/cli-agents";
import type { RecordRow } from "../api";
import { AgentAvatar } from "../components/AgentAvatar";
import { CliApiError, cliErrorText, forkSession } from "./api";
import { sessionTitle } from "./session-model";
import { HarnessMark } from "./tokendance/HarnessMark";

export interface CliBotChoice {
  id: string;
  name: string;
  bot?: RecordRow;
  allBots?: RecordRow[];
}

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

  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    form.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);
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
    <div
      className="modal-backdrop na-fork-backdrop"
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) onClose(); }}
    >
      <form
        ref={form}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const first = buttons[0], last = buttons.at(-1);
          if (!first || !last) return;
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }}
        className="modal cli-dialog na-fork-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => void submit(event)}
      >
        <div className="na-fork-head">
          <span className="na-fork-badge" aria-hidden="true">
            {itemId ? <GitBranch size={17} /> : <Share2 size={17} />}
          </span>
          <h2>{title}</h2>
          <button type="button" className="na-fork-close" aria-label="关闭" disabled={busy} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="cli-fork-session na-fork-session" title={session.cwd}>
          <span className="na-fork-session-mark" aria-hidden="true">
            <HarnessMark agentId={session.engine} size="sm" />
          </span>
          <div className="na-fork-session-copy">
            <strong>{sessionTitle(session)}</strong>
            {session.cwd ? (
              <span className="na-fork-session-cwd">
                <Folder size={12} aria-hidden="true" />
                <span>{session.cwd}</span>
              </span>
            ) : null}
          </div>
        </div>

        <div className="cli-field na-fork-field" role="group" aria-label="助手">
          <span className="na-fork-label">选择目标助手</span>
          <div className="cli-recents na-fork-bots">
            {bots.map((entry) => {
              const selected = entry.id === botId;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="na-fork-bot"
                  aria-pressed={selected}
                  disabled={busy}
                  onClick={() => { setBotId(entry.id); setError(""); }}
                >
                  <span className="na-fork-bot-avatar" aria-hidden="true">
                    {entry.bot ? <AgentAvatar bot={entry.bot} allBots={entry.allBots ?? [entry.bot]} size={32} /> : <Bot size={16} />}
                  </span>
                  <span className="na-fork-bot-name">{entry.name || "助手"}</span>
                  <span className="na-fork-bot-check" aria-hidden="true">
                    {selected ? <Check size={14} strokeWidth={2.5} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {error ? <p className="cli-field-hint na-fork-error" role="alert">{error}</p> : null}

        <div className="cli-dialog-actions na-fork-actions">
          <button type="button" className="na-fork-cancel" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="primary na-fork-submit" disabled={!botId || busy}>
            {busy ? <LoaderCircle size={15} className="na-busy-icon" aria-hidden="true" /> : null}
            {busy ? "正在创建…" : title}
          </button>
        </div>
      </form>
    </div>
  );
}
