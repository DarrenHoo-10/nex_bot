import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { api, statuses, str, toolLabels, type PreviewItem, type RecordRow, type RoutineOccurrenceDetail as Detail, type ToolStep } from "../api";

export const routineStatusLabel = (status: string) => ({ pending: "等待开始", queued: "等待开始", running: "正在处理", succeeded: "已完成", failed: "未完成", rejected: "未获同意", skipped: "已跳过", cancelled: "已取消", paused: "已暂停", awaiting_approval: "等待你的确认", needs_reconciliation: "需要确认结果", cancelling: "正在停止" }[status] ?? statuses[status] ?? status);

const active = new Set(["pending", "queued", "running", "awaiting_approval", "paused", "needs_reconciliation", "cancelling"]);
export const occurrenceStatus = (row: RecordRow) => row.status === "skipped" ? "skipped" : str(row.task_status || row.status);
const time = (value: RecordRow[string] | undefined) => value ? new Date(Number(value)).toLocaleString("zh-CN") : "";
const reasons: Record<string, string> = { expired: "已过期", coalesced: "已合并到后续执行" };

export function RoutineOccurrenceDetail({ id, close, renderContent }: { id: string; close: () => void; renderContent: (content: string, pending?: boolean) => ReactNode }) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<ToolStep>();
  const [preview, setPreview] = useState<PreviewItem>();
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setLoading(true);
      let poll = true;
      try {
        const next = await api<Detail>(`routines/occurrence?id=${encodeURIComponent(id)}`, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(next); setError("");
        poll = active.has(occurrenceStatus(next.occurrence));
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
  useEffect(() => {
    setPreview(undefined); setPreviewError("");
    if (!step) return;
    const controller = new AbortController();
    void api<PreviewItem>(`preview?callId=${encodeURIComponent(step.id)}`, undefined, controller.signal).then((item) => {
      if (!controller.signal.aborted) setPreview(item);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setPreviewError(failure instanceof Error ? failure.message : "加载失败"); });
    return () => controller.abort();
  }, [step]);
  const occurrence = detail?.occurrence;
  const status = occurrence ? occurrenceStatus(occurrence) : "";
  const output = detail?.messages.filter((message) => message.role !== "user" && !!message.content) ?? [];
  const result = str(detail?.task?.result_summary);
  const latest = output.filter((message) => message.role === "assistant").at(-1);
  const hasResult = !!result || !!latest || !!detail?.streaming;
  return <div className="routine-detail">
    <div className="modal-heading"><h2>{occurrence?.name || "执行详情"}</h2><button type="button" aria-label="关闭执行详情" onClick={close}><X size={18}/></button></div>
    <div className="routine-detail-toolbar"><span role="status" className={`routine-status ${status}`}>{routineStatusLabel(status)}</span><span className="routine-detail-date">{time(occurrence?.scheduled_at)}</span><button type="button" aria-label="刷新结果" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? "加载中…" : "刷新"}</button></div>
    {error ? <p role="alert">{error}</p> : null}
    {occurrence ? <>
      <section className="routine-result" aria-label="本次结果">
        <h3>{status === "running" ? "最新进展" : "本次结果"}</h3>
        {result ? renderContent(result) : detail?.streaming ? renderContent(detail.streaming, true) : latest ? renderContent(str(latest.content)) : null}
        {occurrence.reason ? <p className="routine-detail-reason">{reasons[str(occurrence.reason)] ?? occurrence.reason}</p> : null}
        {!hasResult && !occurrence.reason ? <p className="muted">{status === "skipped" || status === "cancelled" ? "本次未执行" : active.has(status) ? "有新进展会显示在这里" : "暂无结果"}</p> : null}
      </section>
      <details className="routine-disclosure routine-process"><summary>查看过程{detail?.steps.length ? <span>{detail.steps.length} 个步骤</span> : null}</summary>
        {output.map((message) => <div key={str(message.id)} className="routine-detail-message">{renderContent(str(message.content))}</div>)}
        {detail?.steps.length ? <div className="step-list">{detail.steps.map((item) => <button type="button" className="step-row" key={item.id} onClick={() => setStep(item)}><span className={`step-dot ${item.status}`}/><strong>{toolLabels[item.tool_name] ?? item.tool_name}</strong><small>{routineStatusLabel(item.status)}</small></button>)}</div> : null}
        {!output.length && !detail?.steps.length ? <p className="muted">还没有处理记录</p> : null}
      </details>
      <details className="routine-disclosure"><summary>任务安排</summary>
        <p className="routine-detail-prompt">{occurrence.prompt}</p>
        <dl className="routine-detail-meta">{[["原定时间", occurrence.scheduled_at], ["开始时间", occurrence.started_at], ["完成时间", occurrence.finished_at]].map(([label, value]) => value ? <div key={String(label)}><dt>{label}</dt><dd>{time(value)}</dd></div> : null)}</dl>
      </details>
    </> : null}
    {step ? <section className="preview-card" aria-label="工具详情"><div className="preview-header"><strong>{toolLabels[step.tool_name] ?? step.tool_name}</strong><button type="button" aria-label="关闭工具详情" onClick={() => setStep(undefined)}><X size={14}/></button></div>{previewError ? <p role="alert">{previewError}</p> : null}{preview?.arguments ? <details><summary>技术信息</summary><pre>{preview.arguments}</pre></details> : null}<pre>{preview ? preview.content || "暂无输出" : previewError ? step.preview || "暂无输出" : "加载中…"}</pre></section> : null}
  </div>;
}
