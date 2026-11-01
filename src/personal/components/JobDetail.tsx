import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { api, jobStageLabels, str, type JobDetail as Detail } from "../api";
import { RunTranscript } from "./RoutineOccurrenceDetail";

const time = (value: string | number | null | undefined) => value ? new Date(Number(value)).toLocaleString("zh-CN") : "";
const reportLabels: Record<string, string> = { ready: "结果", question: "问题", blocked: "受阻", failed: "失败", dropped: "无需处理" };

/** Execution details of a background job over all its rounds; polled while the job is not finished. */
export function JobDetail({ id, close, renderContent }: { id: string; close: () => void; renderContent: (content: string, pending?: boolean) => ReactNode }) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setLoading(true);
      let poll = true;
      try {
        const next = await api<Detail>(`jobs/detail?id=${encodeURIComponent(id)}`, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(next); setError("");
        poll = next.job.endedAt === null && next.job.stage !== "stopped";
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "加载失败");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (poll) timer = setTimeout(() => void load(), 3000);
        }
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, refresh]);
  const job = detail?.job;
  const output = detail?.messages.filter((message) => message.role !== "user" && !!message.content) ?? [];
  const brief = detail?.messages.find((message) => message.role === "user");
  return <div className="routine-detail job-detail">
    <div className="modal-heading"><h2>{job?.title || "后台任务"}</h2><button type="button" aria-label="关闭执行详情" onClick={close}><X size={18}/></button></div>
    <div className="routine-detail-toolbar"><span role="status" className={`routine-status ${job?.stage ?? ""}`}>{job ? jobStageLabels[job.stage] ?? job.stage : ""}</span><span className="routine-detail-date">{time(job?.createdAt)}</span><button type="button" aria-label="刷新结果" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? "加载中…" : "刷新"}</button></div>
    {error ? <p role="alert">{error}</p> : null}
    {job ? <>
      <section className="routine-result" aria-label="最新回报">
        <h3>{job.latestReport ? reportLabels[job.latestReport.state] ?? "结果" : "最新进展"}</h3>
        {job.latestReport ? <>{renderContent(job.latestReport.summary)}{job.latestReport.question ? <p className="job-question">{job.latestReport.question}</p> : null}</> : detail?.streaming ? renderContent(detail.streaming, true) : job.progress ? <p>{job.progress}</p> : <p className="muted">有新进展会显示在这里</p>}
      </section>
      {(detail?.reports.length ?? 0) > 1 ? <details className="routine-disclosure"><summary>各轮回报<span>{detail!.reports.length}</span></summary>
        {detail!.reports.map((report) => <div key={str(report.id)} className="routine-detail-message"><strong>{reportLabels[str(report.state)] ?? str(report.state)}</strong> <time>{time(report.created_at)}</time>{renderContent(str(report.summary))}</div>)}
      </details> : null}
      <RunTranscript messages={output} steps={detail?.steps ?? []} renderContent={renderContent}/>
      {brief ? <details className="routine-disclosure"><summary>任务书</summary><p className="routine-detail-prompt">{str(brief.content)}</p></details> : null}
    </> : null}
  </div>;
}
