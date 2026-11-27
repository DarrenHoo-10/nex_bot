import { userErrorText } from "../../lib/http-errors";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, ChevronLeft } from "lucide-react";
import { MoreContent } from "./MoreContent";
import { api, busyJob, jobStageLabels, statuses, str, toolLabels, type JobDetail, type RecordRow, type ToolStep } from "../api";

type Entry = {
  key: string;
  at: number;
  role: "user" | "assistant" | "steps" | "notice";
  content: string;
  progress?: string;
  question?: string;
  count?: number;
  steps?: ToolStep[];
  pending?: boolean;
};
const clock = (value: unknown) => value ? new Date(Number(value)).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
const INTERNAL_JOB_TOOLS = new Set(["job.report", "job.progress"]);

/**
 * Strips internal main-chat relay framing (`用户在主对话中说（message:uuid）：...` and trailing `主对话备注：...`)
 * so relayed user messages read cleanly as user speech, and system wake/note-only messages render as subtle notices.
 */
export function parseJobUserMessage(raw: string): { kind: "user" | "notice"; content: string } {
  const relayed = /^用户在主对话中说（[^）]*）：(?:\n([\s\S]*))?$/.exec(raw);
  if (relayed) {
    const body = relayed[1] ?? "";
    const noteMatch = /(?:^|\n)主对话备注：([\s\S]*)$/.exec(body);
    const clean = (noteMatch ? body.slice(0, noteMatch.index) : body).trim();
    if (clean) return { kind: "user", content: clean };
    return { kind: "notice", content: (noteMatch?.[1] ?? "").trim() };
  }
  if (raw.startsWith("主对话备注：")) return { kind: "notice", content: raw.slice("主对话备注：".length).trim() };
  if (/^.+已空闲，可以继续。$/.test(raw.trim())) return { kind: "notice", content: raw.trim() };
  return { kind: "user", content: raw };
}

/** The conversation with one background job's sub-agent, in place of the main chat. Messages go to the job as input. */
export function JobChat({ id, botName, avatar, back, renderContent }: { id: string; botName: string; avatar: ReactNode; back: () => void; renderContent: (content: string, pending?: boolean) => ReactNode }) {
  const [detail, setDetail] = useState<JobDetail>();
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [outgoing, setOutgoing] = useState<Array<{ id: string; text: string; at: number }>>([]);
  const [refresh, setRefresh] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let poll = true;
      try {
        const next = await api<JobDetail>(`jobs/detail?id=${encodeURIComponent(id)}`, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(next); setError("");
        poll = next.job.endedAt === null && next.job.stage !== "stopped";
      } catch (failure) {
        if (!controller.signal.aborted) setError(userErrorText(failure, "加载失败"));
      } finally {
        if (!controller.signal.aborted && poll) timer = setTimeout(() => void load(), 2000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, refresh]);

  const job = detail?.job;
  const messages = detail?.messages ?? [];
  const reports = detail?.reports ?? [];
  const brief = messages.find((message) => message.role === "user");
  const timeline = messages.filter(message => message !== brief && (message.content || message.stream_progress) &&
    (message.role === "user" || message.role === "assistant" || (message.role === "system" && !!message.stream_progress)));

  // Match each round's structured report against its final assistant transcript row by task_id so a round never shows both.
  const isArtifact = (message: RecordRow) => {
    const source = str(message.source_key);
    return source.startsWith("image:") || source.startsWith("html:");
  };
  const reportByTask = new Map<string, RecordRow>();
  for (const report of reports) {
    const taskId = str(report.task_id);
    if (taskId) reportByTask.set(taskId, report);
  }
  const finalAnswerByTask = new Map<string, RecordRow>();
  for (const message of timeline) {
    const taskId = str(message.task_id);
    if (taskId && message.role === "assistant" && !isArtifact(message)) finalAnswerByTask.set(taskId, message);
  }
  const suppressedMessages = new Set<string>();
  const suppressedReports = new Set<string>();
  const reportProgress = new Map<string, string>();
  for (const [taskId, report] of reportByTask) {
    const finalAnswer = finalAnswerByTask.get(taskId);
    if (!finalAnswer) continue;
    const isAuto = Number(report.automatic) === 1;
    if (isAuto) {
      // Core auto-clipped the assistant's final answer into a report: keep the full transcript reply once.
      suppressedReports.add(str(report.id));
    } else if (str(report.summary) || str(report.question)) {
      // Explicit job.report is the round's structured reply; suppress the redundant post-report wrap-up text.
      suppressedMessages.add(str(finalAnswer.id));
      const progress = str(finalAnswer.stream_progress);
      if (progress) reportProgress.set(str(report.id), progress);
    }
  }

  const keptTimeline = timeline.filter((message) => !suppressedMessages.has(str(message.id)));
  const replies = new Set(keptTimeline.filter(message => message.role !== "user").map(message => str(message.content).trim()));
  const messageEntries: Entry[] = [];
  for (const message of keptTimeline) {
    if (message.role === "user") {
      const parsed = parseJobUserMessage(str(message.content));
      if (!parsed.content) continue;
      messageEntries.push({ key: `m:${str(message.id)}`, at: Number(message.created_at), role: parsed.kind, content: parsed.content });
    } else {
      messageEntries.push({ key: `m:${str(message.id)}`, at: Number(message.created_at), role: "assistant", content: str(message.content), progress: str(message.stream_progress) });
    }
  }
  const reportEntries: Entry[] = reports
    .filter((report) => {
      if (suppressedReports.has(str(report.id))) return false;
      const taskId = str(report.task_id);
      if (taskId) return !!(str(report.summary) || str(report.question));
      // Fallback for synthetic/legacy rows without task_id.
      return !!(str(report.question) || (str(report.summary) && !replies.has(str(report.summary).trim())));
    })
    .map((report) => ({
      key: `r:${str(report.id)}`,
      at: Number(report.created_at),
      role: "assistant" as const,
      content: str(report.summary),
      progress: reportProgress.get(str(report.id)),
      question: str(report.question) || undefined,
    }));

  const entries: Entry[] = [...messageEntries, ...reportEntries];
  // Real work tool calls between two messages collapse into one expandable "N 项操作" line.
  const visibleSteps = (detail?.steps ?? []).filter((step) => !INTERNAL_JOB_TOOLS.has(step.tool_name));
  for (const step of visibleSteps) {
    const at = Number(step.created_at), before = entries.filter((entry) => entry.at <= at && entry.role !== "steps").at(-1)?.key ?? "start";
    const group = entries.find((entry) => entry.role === "steps" && entry.key === `s:${before}`);
    if (group) {
      group.count = (group.count ?? 0) + 1;
      group.steps = [...(group.steps ?? []), step];
    } else {
      entries.push({ key: `s:${before}`, at, role: "steps", content: "", count: 1, steps: [step] });
    }
  }
  const shown = new Set(messageEntries.filter((entry) => entry.role === "user").map((entry) => entry.content));
  for (const item of outgoing) if (!shown.has(item.text)) entries.push({ key: `o:${item.id}`, at: item.at, role: "user", content: item.text, pending: true });
  entries.sort((a, b) => a.at - b.at);
  const working = !!job && busyJob(job), streaming = detail?.streaming ?? "";

  useEffect(() => { const el = scroll.current; if (el) el.scrollTop = el.scrollHeight; }, [entries.length, streaming, working]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending || !job || job.stage === "stopped") return;
    const clientId = crypto.randomUUID();
    setSending(true); setDraft(""); setOutgoing((items) => [...items, { id: clientId, text, at: Date.now() }]);
    try { await api("jobs/input", { jobId: job.id, text, clientId }); setRefresh((value) => value + 1); }
    catch (failure) {
      setOutgoing((items) => items.filter((item) => item.id !== clientId)); setDraft((current) => current || text);
      setError(userErrorText(failure, "发送失败"));
    } finally { setSending(false); }
  };

  return <>
    <div className="job-chat-bar">
      <button type="button" className="job-chat-back" aria-label={`返回 ${botName}`} onClick={back}><ChevronLeft size={16}/>{botName}</button>
      <strong>{job?.title ?? ""}</strong>
      {job ? <span className={`job-stage ${job.stage}`}>{jobStageLabels[job.stage] ?? job.stage}</span> : null}
    </div>
    {error ? <div role="alert" className="error-banner">{error}</div> : null}
    <div className="transcript job-chat" ref={scroll}>
      <div className="transcript-inner">
        {brief ? <details className="job-chat-brief"><summary>任务书</summary><p>{str(brief.content)}</p></details> : null}
        {entries.map((entry) => entry.role === "steps"
          ? <details className="job-chat-steps-wrap" key={entry.key}>
              <summary className="job-chat-steps">{entry.count} 项操作</summary>
              <ul className="job-chat-step-list">
                {(entry.steps ?? []).map((step) => (
                  <li key={step.id}>
                    <span>{toolLabels[step.tool_name] ?? step.tool_name}</span>
                    <span className={`job-chat-step-status ${step.status}`}>{statuses[step.status] ?? step.status}</span>
                  </li>
                ))}
              </ul>
            </details>
          : entry.role === "notice"
            ? <div className="job-chat-notice" key={entry.key}>{entry.content}</div>
            : <article className={`message ${entry.role} group-end`} key={entry.key}>
                {entry.role === "assistant" ? avatar : null}
                <div className="message-body">
                  {entry.progress && <MoreContent>{renderContent(entry.progress)}</MoreContent>}
                  <div className="bubble">{renderContent(entry.content)}{entry.question ? <p className="job-question">{entry.question}</p> : null}</div>
                  {entry.pending || entry.role !== "user" ? <div className="message-meta">{entry.pending ? "发送中…" : <time>{clock(entry.at)}</time>}</div> : null}
                </div>
              </article>)}
        {working ? <article className="message assistant">
          {avatar}
          <div className="message-body">
            {streaming ? <div className="bubble">{renderContent(streaming, true)}</div>
              : <div className="bubble processing-dots" role="status" aria-label="子代理正在工作"><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/></div>}
            {!streaming && job?.progress ? <span className="muted processing-caption">{job.progress}</span> : null}
          </div>
        </article> : null}
      </div>
    </div>
    <div className="composer-dock">
      <div className="composer-area">
        <form className="composer conversation-input glass" onSubmit={(event) => void send(event)}>
          <textarea aria-label="发送给子代理的消息" placeholder={job ? `给「${job.title}」发消息…` : ""} value={draft} disabled={!job || job.stage === "stopped"} rows={Math.min(5, Math.max(1, draft.split("\n").length))}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>
          <button className="send" aria-label="发送消息" disabled={sending || !draft.trim() || !job || job.stage === "stopped"}><ArrowUp size={19}/></button>
        </form>
      </div>
    </div>
  </>;
}
