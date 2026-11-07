import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, ChevronLeft } from "lucide-react";
import { api, busyJob, jobStageLabels, str, type JobDetail, type RecordRow } from "../api";

type Entry = { key: string; at: number; role: "user" | "assistant" | "steps"; content: string; question?: string; count?: number; pending?: boolean };
const clock = (value: unknown) => value ? new Date(Number(value)).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";

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
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "加载失败");
      } finally {
        if (!controller.signal.aborted && poll) timer = setTimeout(() => void load(), 2000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, refresh]);

  const job = detail?.job;
  const messages = detail?.messages ?? [];
  const brief = messages.find((message) => message.role === "user");
  const replies = new Set(messages.filter((message) => message.role === "assistant").map((message) => str(message.content).trim()));
  const entries: Entry[] = [
    ...messages.filter((message) => message !== brief && (message.role === "user" || message.role === "assistant") && str(message.content))
      .map((message: RecordRow) => ({ key: `m:${str(message.id)}`, at: Number(message.created_at), role: message.role as "user" | "assistant", content: str(message.content) })),
    // A report repeating the sub-agent's own reply (Core files the final answer as one) is shown once.
    ...(detail?.reports ?? []).filter((report) => str(report.question) || (str(report.summary) && !replies.has(str(report.summary).trim())))
      .map((report) => ({ key: `r:${str(report.id)}`, at: Number(report.created_at), role: "assistant" as const, content: str(report.summary), question: str(report.question) || undefined })),
  ];
  // Tool calls between two messages read as one "N 项操作" line.
  for (const step of detail?.steps ?? []) {
    const at = Number(step.created_at), before = entries.filter((entry) => entry.at <= at && entry.role !== "steps").at(-1)?.key ?? "start";
    const group = entries.find((entry) => entry.role === "steps" && entry.key === `s:${before}`);
    if (group) group.count = (group.count ?? 0) + 1; else entries.push({ key: `s:${before}`, at, role: "steps", content: "", count: 1 });
  }
  const shown = new Set(messages.filter((message) => message.role === "user").map((message) => str(message.content)));
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
      setError(failure instanceof Error ? failure.message : "发送失败");
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
          ? <div className="job-chat-steps" key={entry.key}>{entry.count} 项操作</div>
          : <article className={`message ${entry.role} group-end`} key={entry.key}>
              {entry.role === "assistant" ? avatar : null}
              <div className="message-body">
                <div className="bubble">{renderContent(entry.content)}{entry.question ? <p className="job-question">{entry.question}</p> : null}</div>
                <div className="message-meta"><time>{entry.pending ? "发送中…" : clock(entry.at)}</time></div>
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
