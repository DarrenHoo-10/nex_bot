// One permission or question request of a session rendered as a Floating Glass Island.
// Pending islands can be answered (including custom "其他" text for questions);
// closed islands collapse into a compact centered status pill.
import { useState } from "react";
import { ConversationActionButton } from "../components/ConversationActionButton";
import type { CliAnswerDecision } from "../../../shared/cli-agents";
import { cliErrorText, CliApiError } from "./api";
import {
  answersComplete,
  answersFor,
  CARD_STATE_TEXT,
  cardState,
  OTHER_CHOICE,
  toggleChoice,
  type OtherAnswers,
  type RequestRecord,
  type Selection,
} from "./requests";

export interface RequestCardProps {
  record: RequestRecord;
  now: number;
  /** Rejects with the error to show. `always` allows such calls for the rest of the session. */
  onAnswer(id: string, decision: CliAnswerDecision, answers?: Record<string, string>, always?: boolean): Promise<unknown>;
}

const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function answerErrorText(cause: unknown): string {
  // Core answers a request it no longer holds with not_found
  if (cause instanceof CliApiError && cause.code === "not_found") return "请求已处理或已过期";
  return cliErrorText(cause);
}

function toolVerb(tool: string): string {
  const name = tool.trim().toLowerCase();
  if (/^(bash|shell|exec|terminal|command|run_command|device\.exec)/.test(name)) return "请求执行";
  if (/^(edit|write|multiedit|patch|replace|create|edit_file|write_file)/.test(name)) return "修改文件";
  if (/^(read|view|cat|ls|list|glob|file_read|read_file)/.test(name)) return "读取文件";
  return "请求操作";
}

export function RequestCard({ record, now, onAnswer }: RequestCardProps) {
  const { view } = record;
  const state = cardState(record, now);
  const pending = state === "pending";
  const question = view.kind === "question";
  const [selection, setSelection] = useState<Selection>({});
  const [other, setOther] = useState<OtherAnswers>({});
  const [busy, setBusy] = useState<CliAnswerDecision | "always" | null>(null);
  const [error, setError] = useState("");
  const canAlways = !question && view.always === true;

  const run = async (decision: CliAnswerDecision, always = false) => {
    if (busy) return;
    setBusy(always ? "always" : decision);
    setError("");
    try {
      await onAnswer(
        view.id,
        decision,
        question && decision === "allow" && view.questions ? answersFor(view.questions, selection, other) : undefined,
        always || undefined,
      );
    } catch (cause) {
      setError(answerErrorText(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!pending) {
    const tone = state === "denied" ? "deny" : state === "allowed" || state === "always" || state === "answered" ? "ok" : "idle";
    const resolvedLabel = question ? (view.questions?.map((entry) => entry.question).join(" / ") || view.summary || "提问") : view.tool;
    return (
      <article
        className="cli-request na-island is-resolved"
        data-kind={view.kind}
        data-state={state}
        data-tone={tone}
        aria-label={question ? "Agent 的提问" : `${view.tool} 的权限请求`}
      >
        <span className="na-island-dot" aria-hidden="true" />
        <strong className="na-island-resolved-name">{resolvedLabel}</strong>
        <span className="na-island-resolved-state">· {CARD_STATE_TEXT[state]}</span>
      </article>
    );
  }

  const questions = view.questions ?? [];
  const multiQ = question && questions.length > 1;
  const complete = !question || answersComplete(questions, selection, other);

  if (!question) {
    return (
      <article className="cli-request na-island is-permission" data-kind={view.kind} data-state={state} aria-label={`${view.tool} 的权限请求`}>
        <div className="na-island-perm-row">
          <div className="na-island-copy">
            <div className="na-island-meta">
              <strong>{view.tool}</strong>
              <span>· {toolVerb(view.tool)}</span>
            </div>
            {view.summary ? <code className="na-island-summary" title={view.summary}>{view.summary}</code> : null}
          </div>
          <div className="cli-request-actions na-island-pill">
            <ConversationActionButton tone="dark" disabled={!!busy} onClick={() => void run("deny")}>
              {busy === "deny" ? "拒绝中…" : "拒绝"}
            </ConversationActionButton>
            {canAlways ? (
              <ConversationActionButton
                disabled={!!busy}
                aria-label="本会话总是允许"
                title="本会话总是允许"
                onClick={() => void run("allow", true)}
              >
                {busy === "always" ? "处理中…" : "总是"}
              </ConversationActionButton>
            ) : null}
            <ConversationActionButton disabled={!!busy} onClick={() => void run("allow")}>
              {busy === "allow" ? "允许中…" : "允许"}
            </ConversationActionButton>
          </div>
        </div>
        {error ? <small role="alert" className="cli-composer-error na-island-error">{error}</small> : null}
      </article>
    );
  }

  return (
    <article
      className="cli-request na-island is-question"
      data-kind={view.kind}
      data-state={state}
      data-multi-q={multiQ ? "1" : undefined}
      aria-label="Agent 的提问"
    >
      <div className="na-island-questions">
        {questions.length ? questions.map((entry, index) => {
          const multi = entry.multiSelect === true;
          const chosen = selection[index] ?? [];
          const otherChecked = chosen.includes(OTHER_CHOICE);
          return (
            <fieldset key={index} className="cli-ask na-island-q" disabled={!!busy}>
              <legend className="na-island-q-head">
                <span className="na-island-q-title">
                  {multiQ ? <span className="na-island-q-step">{index + 1} / {questions.length}</span> : null}
                  {!multiQ && entry.header ? <span className="na-island-q-tag">{entry.header}</span> : null}
                  <span className="na-island-q-text">{entry.question}</span>
                </span>
                {multi ? <small className="na-island-q-hint">可多选</small> : null}
              </legend>

              <div className={multiQ ? "na-island-chips" : multi ? "na-island-grid" : "na-island-stack"}>
                {entry.options.map((option, optIndex) => {
                  const checked = chosen.includes(option.label);
                  const letter = OPTION_LETTERS[optIndex] ?? String(optIndex + 1);
                  return (
                    <label key={option.label} className="cli-choice na-island-opt" data-checked={checked ? "1" : "0"} data-multi={multi ? "1" : "0"}>
                      <input
                        type={multi ? "checkbox" : "radio"}
                        className="na-sr"
                        name={`${view.id}:${index}`}
                        checked={checked}
                        onChange={() => setSelection((current) => toggleChoice(current, index, option.label, multi))}
                      />
                      <span className="na-island-mark" aria-hidden="true">
                        {checked ? "✓" : multi ? (multiQ ? "+" : "") : letter}
                      </span>
                      <span className="na-island-opt-copy">
                        <span className="na-island-opt-label">{option.label}</span>
                        {!multiQ && option.description ? <small>{option.description}</small> : null}
                      </span>
                    </label>
                  );
                })}

                {multiQ ? (
                  <button
                    type="button"
                    className="na-island-opt na-island-other-chip"
                    data-checked={otherChecked ? "1" : "0"}
                    aria-pressed={otherChecked}
                    disabled={!!busy}
                    onClick={() => setSelection((current) => toggleChoice(current, index, OTHER_CHOICE, multi))}
                  >
                    <span className="na-island-mark" aria-hidden="true">{otherChecked ? "✓" : "…"}</span>
                    <span className="na-island-opt-label">其他…</span>
                  </button>
                ) : null}
              </div>

              {!multiQ ? (
                <div className="na-island-other-box" data-checked={otherChecked ? "1" : "0"}>
                  <button
                    type="button"
                    className="na-island-other-trigger"
                    aria-pressed={otherChecked}
                    disabled={!!busy}
                    onClick={() => setSelection((current) => toggleChoice(current, index, OTHER_CHOICE, multi))}
                  >
                    <span className="na-island-mark" data-multi={multi ? "1" : "0"} aria-hidden="true">{otherChecked ? "✓" : multi ? "" : "…"}</span>
                    <span className="na-island-opt-label">{multi ? "其他补充" : "其他（自定义输入）"}</span>
                  </button>
                  {otherChecked ? (
                    <div className="na-island-other-field">
                      <input
                        type="text"
                        autoFocus
                        className="na-island-other-input"
                        aria-label={`${entry.question} 其他内容`}
                        placeholder={multi ? "输入补充内容…" : "输入自定义回复…"}
                        value={other[index] ?? ""}
                        onChange={(event) => setOther((current) => ({ ...current, [index]: event.target.value }))}
                      />
                    </div>
                  ) : null}
                </div>
              ) : otherChecked ? (
                <input
                  type="text"
                  autoFocus
                  className="na-island-other-input"
                  aria-label={`${entry.question} 其他内容`}
                  placeholder="输入自定义内容…"
                  value={other[index] ?? ""}
                  onChange={(event) => setOther((current) => ({ ...current, [index]: event.target.value }))}
                />
              ) : null}
            </fieldset>
          );
        }) : view.summary ? <pre className="cli-request-summary">{view.summary}</pre> : null}
      </div>

      {error ? <small role="alert" className="cli-composer-error na-island-error">{error}</small> : null}

      <div className="na-island-q-foot">
        <div className="cli-request-actions na-island-pill">
          <ConversationActionButton tone="dark" disabled={!!busy} onClick={() => void run("deny")}>
            {busy === "deny" ? "拒绝中…" : "拒绝"}
          </ConversationActionButton>
          <ConversationActionButton disabled={!!busy || !complete} onClick={() => void run("allow")}>
            {busy === "allow" ? "提交中…" : "提交"}
          </ConversationActionButton>
        </div>
      </div>
    </article>
  );
}
