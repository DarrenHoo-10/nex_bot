import type { ReactNode } from "react";
import { jobStageLabels, str, type Job, type RecordRow } from "../api";
import { parseMessageMedia, type MessageImage } from "../message-media";
import { MessageImages } from "./MessageImages";

export interface JobCardActions {
  open(jobId: string): void;
  reply(job: Job): void;
  stop(job: Job): void;
  accept(job: Job): void;
  revise(job: Job): void;
}
/** Stages in which a job can still be stopped from its card. */
const stoppable = new Set(["running", "queued", "approval", "question", "blocked", "failed"]);

/**
 * A background job's report in the message stream: title, its current stage (from state, not the message), the
 * conclusion and its files, and the actions that stage allows. Actions appear only on the job's latest report.
 */
export function JobReportCard({ message, job, busy, renderContent, actions, onDeleteImage }: { message: RecordRow; job?: Job; busy: boolean; renderContent: (content: string) => ReactNode; actions: JobCardActions; onDeleteImage?: (image: MessageImage) => Promise<void> }) {
  const title = job?.title ?? str(message.job_title);
  // The first line repeats the title; the card shows it in its heading.
  const body = str(message.content).replace(/^后台任务「[^\n]*」\n?/, "");
  const { text, images } = parseMessageMedia(body);
  const latest = !!job && job.latestReport?.messageId === message.id;
  const stage = job?.stage;
  return <article className={`job-card ${str(message.job_state)}`} data-job-id={str(message.job_id)} data-message-id={str(message.id)}>
    <header><button type="button" className="job-card-title" onClick={() => actions.open(str(message.job_id))}>{title}</button>{stage ? <span className={`job-stage ${stage}`}>{jobStageLabels[stage] ?? stage}</span> : null}</header>
    <MessageImages images={images} onDelete={onDeleteImage}/>
    {text ? <div className="job-card-body">{renderContent(text)}</div> : null}
    {latest && job ? <div className="actions">
      {stage === "question" ? <button type="button" className="primary" disabled={busy} onClick={() => actions.reply(job)}>回复</button> : null}
      {stage === "review" && job.todoId ? <><button type="button" className="primary" disabled={busy} onClick={() => actions.accept(job)}>验收</button><button type="button" disabled={busy} onClick={() => actions.revise(job)}>修改</button></> : null}
      {stage && stoppable.has(stage) ? <button type="button" disabled={busy} onClick={() => actions.stop(job)}>停止</button> : null}
    </div> : null}
  </article>;
}
