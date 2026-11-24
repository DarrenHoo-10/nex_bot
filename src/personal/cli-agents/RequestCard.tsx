// One permission or question request of a session. Pending cards can be
// answered; the others only say how they ended.
import { useState } from "react";
import { Check, CheckCheck, X } from "lucide-react";
import { ConversationActionButton } from "../components/ConversationActionButton";
import type { CliAnswerDecision } from "../../../shared/cli-agents";
import { cliErrorText, CliApiError } from "./api";
import { answersComplete, answersFor, CARD_STATE_TEXT, cardState, toggleChoice, type RequestRecord, type Selection } from "./requests";

export interface RequestCardProps {
  record: RequestRecord;
  now: number;
  /** Rejects with the error to show. `always` allows such calls for the rest of the session. */
  onAnswer(id: string, decision: CliAnswerDecision, answers?: Record<string, string>, always?: boolean): Promise<unknown>;
}

function answerErrorText(cause: unknown): string {
  // Core answers a request it no longer holds with not_found
  if (cause instanceof CliApiError && cause.code === "not_found") return "请求已处理或已过期";
  return cliErrorText(cause);
}

export function RequestCard({ record, now, onAnswer }: RequestCardProps) {
  const { view } = record;
  const state = cardState(record, now);
  const pending = state === "pending";
  const question = view.kind === "question";
  const [selection, setSelection] = useState<Selection>({});
  const [busy, setBusy] = useState<CliAnswerDecision | "always" | null>(null);
  const [error, setError] = useState("");
  const canAlways = !question && view.always === true;

  const run = async (decision: CliAnswerDecision, always = false) => {
    if (busy) return;
    setBusy(always ? "always" : decision);
    setError("");
    try {
      await onAnswer(view.id, decision, question && decision === "allow" && view.questions ? answersFor(view.questions, selection) : undefined, always || undefined);
    } catch (cause) {
      setError(answerErrorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const complete = !question || answersComplete(view.questions, selection);
  return (
    <article className="cli-request" data-kind={view.kind} data-state={state} aria-label={question ? "Agent 的提问" : `${view.tool} 的权限请求`}>
      <header>
        <strong>{question ? "提问" : view.tool}</strong>
        <span className="cli-chip" data-tone={pending ? "waiting" : "idle"}>{pending ? (question ? "等你回答" : "等你批准") : CARD_STATE_TEXT[state]}</span>
      </header>
      {question && !pending ? <p className="cli-request-text">{view.questions?.map((entry) => entry.question).join(" / ") || view.summary}</p> : question && view.questions?.length ? view.questions.map((entry, index) => (
        <fieldset key={index} className="cli-ask" disabled={!pending || !!busy}>
          <legend>{entry.header ? <small>{entry.header}</small> : null}{entry.question}</legend>
          {entry.options.map((option) => {
            const checked = selection[index]?.includes(option.label) ?? false;
            return (
              <label key={option.label} className="cli-choice" data-checked={checked ? "1" : "0"}>
                <input
                  type={entry.multiSelect ? "checkbox" : "radio"}
                  name={`${view.id}:${index}`}
                  checked={checked}
                  onChange={() => setSelection((current) => toggleChoice(current, index, option.label, entry.multiSelect === true))}
                />
                <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>
              </label>
            );
          })}
        </fieldset>
      )) : view.summary ? <pre className="cli-request-summary">{view.summary}</pre> : null}
      {!question && view.detail ? (
        <details className="cli-request-detail">
          <summary>参数</summary>
          <pre>{view.detail}</pre>
        </details>
      ) : null}
      {pending ? (
        <div className="cli-request-actions">
          <ConversationActionButton tone="dark" disabled={!!busy} onClick={() => void run("deny")}><X size={14} aria-hidden="true"/>{busy === "deny" ? "正在拒绝…" : "拒绝"}</ConversationActionButton>
          {canAlways ? (
            <ConversationActionButton disabled={!!busy} onClick={() => void run("allow", true)}>
              <CheckCheck size={14} aria-hidden="true"/>{busy === "always" ? "正在允许…" : "本会话总是允许"}
            </ConversationActionButton>
          ) : null}
          <ConversationActionButton disabled={!!busy || !complete} onClick={() => void run("allow")}>
            <Check size={14} aria-hidden="true"/>{busy === "allow" ? (question ? "正在提交…" : "正在允许…") : question ? "提交" : "允许"}
          </ConversationActionButton>
        </div>
      ) : null}
      {error ? <small role="alert" className="cli-composer-error">{error}</small> : null}
    </article>
  );
}
