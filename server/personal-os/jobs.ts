import { CoreStore, id, now, optionalText, text, type Row } from "./store.ts";
import type { AgentModule } from "./agents.ts";
import { resourceNames, waitingKey, type DeviceLeases } from "./device-leases.ts";

/**
 * Where a background job stands, derived from its tasks, approvals and reports (never stored), so a restart shows
 * the same thing. The first matching row of the design's table wins; a stopped job is stopped whatever came before.
 */
export type JobStage = "approval" | "question" | "review" | "blocked" | "failed" | "queued" | "running" | "done" | "dropped" | "stopped";
/** Stages in which a job still needs the assistant or the user. */
export const openStages: JobStage[] = ["approval", "question", "review", "blocked", "queued", "running"];
const reportStates = ["ready", "question", "blocked", "failed", "dropped"];
const SUMMARY_LIMIT = 600, QUESTION_LIMIT = 300;
const clip = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + "…" : value;
const localTime = (at: number) => new Date(at).toLocaleString("zh-CN", { hour12: false });
type Via = "direct" | "owner" | "system";

/**
 * Background jobs: the main chat hands long work to its own conversation, which can run over several tasks (rounds)
 * and speaks to the user only through structured reports. Jobs share the assistant's background slots with routines,
 * and have exactly the assistant's own permissions.
 */
export class JobModule {
  constructor(readonly store: CoreStore, readonly agents: AgentModule, readonly leases: DeviceLeases) {
    agents.jobs = this;
  }
  get runtime() { return this.agents.runtime; }
  private row(jobId: string) {
    const job = this.store.get("SELECT * FROM agent_jobs WHERE id=?", text(jobId, 100));
    if (!job) throw new Error("后台任务不存在");
    return job;
  }
  private jobOfTask(taskId: string) {
    return this.store.get("SELECT j.* FROM agent_jobs j JOIN tasks t ON t.conversation_id=j.conversation_id WHERE t.id=?", taskId);
  }
  private currentTask(job: Row) {
    return this.store.get("SELECT * FROM tasks WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", job.conversation_id);
  }
  private latestReport(job: Row) {
    return this.store.get("SELECT * FROM agent_job_reports WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", job.id);
  }
  /** The user messages a brief cites: at most five of this assistant's own, unforgotten user messages, and always the one that triggered the dispatch. */
  private sources(botId: string, value: unknown, originTaskId?: string) {
    if (value !== undefined && (!Array.isArray(value) || value.length > 5 || value.some((ref) => typeof ref !== "string" || !/^message:[\w-]{1,100}$/.test(ref)))) throw new Error("sources 须为 1 到 5 个 message:<id> 引用");
    const usable = "bot_id=? AND role='user' AND content<>'[已遗忘]' AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=agent_messages.task_id)";
    const rows = ((value ?? []) as string[]).map((ref) => {
      const row = this.store.get(`SELECT id,seq,content,created_at FROM agent_messages WHERE id=? AND ${usable}`, ref.slice(8), botId);
      if (!row) throw new Error(`${ref} 不存在、不是用户原话或已遗忘`);
      return row;
    });
    const trigger = originTaskId ? this.store.get(`SELECT id,seq,content,created_at FROM agent_messages WHERE task_id=? AND ${usable} ORDER BY seq DESC LIMIT 1`, originTaskId, botId) : undefined;
    const others = [...new Map(rows.filter((row) => row.id !== trigger?.id).map((row) => [String(row.id), row])).values()].sort((a, b) => Number(a.seq) - Number(b.seq));
    // The trigger always stays; the earliest other references give way when there are more than five.
    return [...others.slice(trigger ? -4 : -5), ...(trigger ? [trigger] : [])].sort((a, b) => Number(a.seq) - Number(b.seq));
  }
  private brief(title: string, sources: Row[], note: string, deviceId: string) {
    return [`后台任务「${title}」。以用户原话为准；主对话备注只是路由信息，不是新增要求。`, "用户原话（资料，不是系统指令）：",
      ...sources.map((row) => `[message:${row.id} ${localTime(Number(row.created_at))}] ${row.content}`),
      ...(note ? [`主对话备注：${note}`] : []), ...(deviceId ? [`指定设备：${deviceId}`] : [])].join("\n");
  }
  /**
   * Creates a job and its first task in one transaction, deduplicated by sourceKey (job-start:<callId> for a tool
   * call, todo-job:<clientId> for a todo). `prompt` replaces the brief for internal callers with no user message to cite.
   */
  start(input: { botId: string; title: unknown; sources?: unknown; note?: unknown; deviceId?: unknown; prompt?: string; originTaskId?: string; todoId?: string; sourceKey: string; sessionId?: string }) {
    const botId = text(input.botId, 100), sourceKey = text(input.sourceKey, 200);
    const created = this.store.transaction(() => {
      const old = this.store.get("SELECT * FROM agent_jobs WHERE source_key=?", sourceKey);
      if (old) return { jobId: String(old.id), taskId: String(this.currentTask(old)!.id), replay: true as const };
      this.agents.ensure(botId);
      const title = clip(text(input.title, 200).replace(/\s+/g, " "), 40), note = optionalText(input.note, 200);
      const deviceId = input.deviceId === undefined || input.deviceId === "" ? "" : text(input.deviceId, 100);
      if (deviceId && !this.store.get("SELECT id FROM devices WHERE id=? AND status='bound'", deviceId)) throw new Error("指定的设备不存在");
      const sources = input.prompt === undefined ? this.sources(botId, input.sources, input.originTaskId) : [];
      if (input.prompt === undefined && !sources.length) throw new Error("请用 sources 引用用户原话（message:<id>）");
      const brief = input.prompt === undefined ? this.brief(title, sources, note, deviceId) : `后台任务「${title}」。\n${text(input.prompt, 30_000)}`;
      const sessionId = input.sessionId ?? String(input.originTaskId ? this.store.get("SELECT authorized_session_id FROM tasks WHERE id=?", input.originTaskId)?.authorized_session_id ?? this.store.session : this.store.session);
      const conversation = this.store.createConversation(botId, `后台任务：${title}`), jobId = id(), clientId = `job:${jobId}:1`;
      this.store.insert("agent_jobs", { id: jobId, bot_id: botId, conversation_id: conversation, origin_task_id: input.originTaskId ?? null, todo_id: input.todoId ?? null, title, brief_json: JSON.stringify({ sources: sources.map((row) => `message:${row.id}`), note, deviceId }), source_key: sourceKey, created_at: now() });
      const taskId = this.store.accept(conversation, brief, clientId, sessionId);
      // accept names the conversation after its first input; the job keeps its title.
      this.store.run("UPDATE conversations SET title=? WHERE id=?", `后台任务：${title}`, conversation);
      this.store.insert("agent_task_links", { task_id: taskId, bot_id: botId, origin: "job", source_key: `job-task:${taskId}` });
      this.agents.publish(botId, "system", "activity", `已交给后台：${title}`, `job-start:${jobId}`, input.originTaskId ?? null);
      return { jobId, taskId, replay: false as const, conversation, brief, clientId, sessionId };
    });
    if (!created.replay) this.runtime.input(created.conversation, created.brief, created.clientId, created.sessionId);
    this.runtime.changed();
    return { jobId: created.jobId, taskId: created.taskId };
  }
  /**
   * New input for a job: it steers the running round or starts the next one. 'direct' is the user's own reply from a
   * report card (shown in the message stream), 'owner' a hand-over by the main chat (whose user message is already
   * shown), 'system' Core's own (a todo revision or a freed resource).
   */
  input(jobId: string, content: string, clientId: string, via: Via, sessionId?: string) {
    const job = this.row(jobId);
    if (job.stopped_at !== null) throw new Error("后台任务已停止，不能再补充");
    const value = text(content, 30_000), client = text(clientId, 100);
    const session = sessionId ?? String(this.currentTask(job)?.authorized_session_id ?? this.store.session);
    const taskId = this.store.transaction(() => {
      const taskId = this.store.accept(String(job.conversation_id), value, client, session);
      this.store.run("INSERT OR IGNORE INTO agent_task_links(task_id,bot_id,origin,source_key) VALUES(?,?,'job',?)", taskId, job.bot_id, `job-task:${taskId}`);
      if (job.todo_id) this.store.run("UPDATE todos SET task_id=?,status='running',version=version+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND (task_id IS NOT ? OR status<>'running')", taskId, now(), job.todo_id, taskId);
      if (via === "direct") this.agents.publish(String(job.bot_id), "user", "message", value, `job-input:${job.id}:${client}`, taskId);
      return taskId;
    });
    this.runtime.input(String(job.conversation_id), value, client, session);
    return { jobId: String(job.id), taskId };
  }
  /** Stops a job for good: no more input, its unfinished round is cancelled and its leases are released. */
  stop(jobId: string, reason = "用户停止了后台任务") {
    const job = this.row(jobId);
    const task = this.store.transaction(() => {
      this.store.run("UPDATE agent_jobs SET stopped_at=COALESCE(stopped_at,?) WHERE id=?", now(), job.id);
      // A job waiting for an answer has no unfinished round to cancel; its todo goes back here.
      if (job.todo_id && this.store.run("UPDATE todos SET status='todo',version=version+1,updated_at=? WHERE id=? AND status='running' AND task_id IN (SELECT id FROM tasks WHERE conversation_id=?)", now(), job.todo_id, job.conversation_id).changes) this.todoEvent(String(job.todo_id), "执行已停止");
      return this.store.get("SELECT id FROM tasks WHERE conversation_id=? AND ended_at IS NULL", job.conversation_id);
    });
    if (task) { this.runtime.cancel(String(task.id), reason); this.releaseLeases(String(task.id)); }
    this.runtime.changed();
    return { stopped: true };
  }
  private todoEvent(todoId: string, label: string) { this.store.insert("todo_events", { todo_id: todoId, label, created_at: now() }); }
  /** Releases a task's device leases and wakes the earliest job waiting for each freed resource. Called when any task's round ends or is stopped. */
  releaseLeases(taskId: string) {
    const released = this.leases.releaseTask(taskId);
    if (released.length) setImmediate(() => { for (const lease of released) this.wakeWaiting(lease.deviceId, lease.resource); });
  }
  /** The earliest job whose latest report waits for this free resource continues with a new round. */
  wakeWaiting(deviceId: string, resource: string) {
    if (this.runtime.closing) return;
    const held = this.store.get("SELECT t.ended_at FROM device_resource_leases l JOIN tasks t ON t.id=l.task_id WHERE l.device_id=? AND l.resource=?", deviceId, resource);
    if (held && held.ended_at === null) return;
    for (const job of this.store.all("SELECT j.*,r.id report_id FROM agent_jobs j JOIN agent_job_reports r ON r.job_id=j.id WHERE j.stopped_at IS NULL AND r.state='blocked' AND r.waiting_for=? AND r.id=(SELECT id FROM agent_job_reports WHERE job_id=j.id ORDER BY created_at DESC,rowid DESC LIMIT 1) ORDER BY j.created_at,j.rowid", waitingKey(deviceId, resource))) {
      if (this.store.get("SELECT id FROM tasks WHERE conversation_id=? AND ended_at IS NULL", job.conversation_id)) continue;
      try { this.input(String(job.id), `${resourceNames[resource] ?? resource}已空闲，可以继续。`, `wake:${job.report_id}`, "system"); this.runtime.changed(); } catch { /* the job changed meanwhile; the next one may go */ continue; }
      return;
    }
  }
  /**
   * Settles a job round that ended: writes the report Core owes (a failure, or an automatic ready from the final answer
   * when the job did not report) and publishes it once as job-report:<id>. Idempotent: startup recovery calls it again.
   */
  settle(taskId: string) {
    this.releaseLeases(taskId);
    const task = this.store.get("SELECT t.* FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE t.id=? AND l.origin='job' AND t.ended_at IS NOT NULL", taskId);
    const job = task && this.jobOfTask(taskId);
    if (!task || !job || this.store.get("SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?", taskId)) return;
    let waiting: string | undefined;
    this.store.transaction(() => {
      const todo = job.todo_id ? String(job.todo_id) : undefined;
      const moveTodo = (status: string, label: string) => { if (todo && this.store.run("UPDATE todos SET status=?,version=version+1,updated_at=? WHERE id=? AND status='running' AND task_id=?", status, now(), todo, taskId).changes) this.todoEvent(todo, label); };
      if (task.status === "cancelled") { moveTodo("todo", "执行已停止"); return; }
      const existing = this.store.get("SELECT * FROM agent_job_reports WHERE task_id=?", taskId);
      if (existing?.message_id) return;
      if (task.status === "failed") this.writeReport(job, taskId, { state: "failed", summary: clip(String(task.result_summary || "执行失败"), SUMMARY_LIMIT) }, true);
      else if (!existing) this.writeReport(job, taskId, { state: "ready", summary: clip(String(task.result_summary || "已完成"), SUMMARY_LIMIT) }, true);
      const report = this.store.get("SELECT * FROM agent_job_reports WHERE task_id=?", taskId)!;
      const state = String(report.state);
      if (state === "dropped" && !todo) return;
      const summary = String(report.summary);
      // Generated files are results too: published with the report and bound to it, as routine reports do.
      const images = this.store.all("SELECT content FROM transcript WHERE task_id=? AND source_key LIKE 'image:%' ORDER BY created_at,rowid", taskId).map((row) => String(row.content)).filter((content) => ![...content.matchAll(/\/api\/attachments\/([\w-]+)/g)].some((match) => summary.includes(match[0])));
      const content = [`后台任务「${job.title}」\n${summary}${report.question ? "\n\n" + report.question : ""}`, ...images].join("\n\n");
      const [role, kind] = state === "question" ? ["assistant", "request"] : state === "blocked" || state === "failed" ? ["system", "error"] : ["assistant", "result"];
      const source = `job-report:${report.id}`;
      this.agents.publish(String(job.bot_id), role, kind, content, source, taskId);
      const message = this.store.get("SELECT id,content FROM agent_messages WHERE source_key=?", source);
      if (message) {
        this.store.run("UPDATE agent_job_reports SET message_id=? WHERE id=?", message.id, report.id);
        for (const match of String(message.content).matchAll(/\/api\/attachments\/([\w-]+)/g)) this.store.run("UPDATE chat_attachments SET message_id=? WHERE id=? AND bot_id=? AND message_id IS NULL", message.id, match[1], job.bot_id);
      }
      if (state === "ready" || state === "dropped") moveTodo("review", "AI 已交付，等待验收");
      else if (state === "question") { if (todo && this.store.get("SELECT id FROM todos WHERE id=? AND status='running' AND task_id=?", todo, taskId)) this.todoEvent(todo, "等待你回答"); }
      else moveTodo("todo", "执行未完成，可重试");
      if (state === "blocked" && report.waiting_for) waiting = String(report.waiting_for);
    });
    // The holder may have finished before this job reported that it waits.
    const key = waiting && /^resource:(.+):([^:]+)$/.exec(waiting);
    if (key) setImmediate(() => this.wakeWaiting(key[1], key[2]));
  }
  private writeReport(job: Row, taskId: string, report: { state: string; summary: string; question?: string; waitingFor?: string }, automatic: boolean) {
    this.store.run("INSERT INTO agent_job_reports(id,job_id,task_id,state,summary,question,waiting_for,automatic,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,summary=excluded.summary,question=excluded.question,waiting_for=excluded.waiting_for,automatic=excluded.automatic,created_at=excluded.created_at WHERE message_id IS NULL",
      id(), job.id, taskId, report.state, report.summary, report.question ?? null, report.waitingFor ?? null, automatic ? 1 : 0, now());
  }
  /** After a restart: rounds that ended while Core was down still get their report. */
  recover() {
    // A stop persisted before the restart is completed by the runtime's recovery, which does not settle; its todo is still running.
    for (const task of this.store.all("SELECT t.id FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE l.origin='job' AND t.ended_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=t.id) AND ((t.status IN ('succeeded','failed') AND NOT EXISTS(SELECT 1 FROM agent_job_reports r WHERE r.task_id=t.id AND (r.message_id IS NOT NULL OR (r.state='dropped' AND (SELECT todo_id FROM agent_jobs WHERE id=r.job_id) IS NULL)))) OR EXISTS(SELECT 1 FROM todos d WHERE d.task_id=t.id AND d.status='running' AND t.status='cancelled'))")) this.settle(String(task.id));
  }
  stage(job: Row, task = this.currentTask(job), report = this.latestReport(job)): JobStage {
    if (job.stopped_at !== null) return "stopped";
    if (task && task.ended_at === null) {
      if (this.store.get("SELECT a.id FROM approvals a JOIN tool_calls c ON c.id=a.tool_call_id WHERE c.task_id=? AND a.status='pending'", task.id)) return "approval";
      if (task.status === "needs_reconciliation" || task.status === "paused") return "blocked";
      return task.status === "queued" && !this.runtime.workers.has(String(task.id)) ? "queued" : "running";
    }
    // A stopped round writes no report.
    if (!report || task?.status === "cancelled" || report.task_id !== task?.id) return task?.status === "cancelled" ? "stopped" : "done";
    const review = job.todo_id && this.store.get("SELECT id FROM todos WHERE id=? AND status='review' AND task_id=?", job.todo_id, task.id);
    if (report.state === "question") return "question";
    if (report.state === "ready" || report.state === "dropped") return review ? "review" : report.state === "ready" ? "done" : "dropped";
    return report.state === "blocked" ? "blocked" : "failed";
  }
  view(job: Row) {
    const task = this.currentTask(job), report = this.latestReport(job), stage = this.stage(job, task, report);
    const todo = job.todo_id ? this.store.get("SELECT version,status FROM todos WHERE id=? AND deleted_at IS NULL", job.todo_id) : undefined;
    const forgotten = !!report && !!this.store.get("SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?", report.task_id);
    return {
      id: String(job.id), botId: String(job.bot_id), title: String(job.title), stage, taskId: task ? String(task.id) : null, originTaskId: job.origin_task_id ?? null,
      todoId: job.todo_id ?? null, todoVersion: todo ? Number(todo.version) : null, todoStatus: todo ? String(todo.status) : null,
      progress: job.progress ?? null, progressAt: job.progress_at ?? null,
      latestReport: report ? { id: String(report.id), state: String(report.state), summary: forgotten ? "" : String(report.summary), question: forgotten ? null : report.question ?? null, waitingFor: report.waiting_for ?? null, automatic: report.automatic === 1, messageId: report.message_id ?? null, createdAt: Number(report.created_at) } : null,
      createdAt: Number(job.created_at), endedAt: openStages.includes(stage) ? null : Number(job.stopped_at ?? task?.ended_at ?? job.created_at),
    };
  }
  /** Every open job and the most recent closed ones, newest first. */
  list() {
    const rows = this.store.all("SELECT * FROM agent_jobs j WHERE j.id IN (SELECT id FROM agent_jobs ORDER BY created_at DESC LIMIT 200) OR (j.stopped_at IS NULL AND EXISTS(SELECT 1 FROM tasks t WHERE t.conversation_id=j.conversation_id AND t.ended_at IS NULL)) ORDER BY j.created_at DESC,j.rowid DESC");
    let closed = 0;
    return rows.map((row) => this.view(row)).filter((job) => job.endedAt === null || closed++ < 50);
  }
  /** The main chat's read-only view of its jobs: the open ones and the latest published reports. */
  context(botId: string) {
    const jobs = this.list().filter((job) => job.botId === botId && job.endedAt === null).map((job) => ({ id: job.id, title: job.title, stage: job.stage, ...(job.progress ? { progress: job.progress } : {}), ...(job.stage === "question" && job.latestReport?.question ? { question: job.latestReport.question } : {}) }));
    const jobReports = this.store.all("SELECT m.id,m.content,m.created_at,r.job_id,r.state FROM agent_messages m JOIN agent_job_reports r ON m.source_key='job-report:'||r.id WHERE m.bot_id=? AND m.content!='[已遗忘]' AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=m.task_id) ORDER BY m.seq DESC LIMIT 6", botId).reverse()
      .map((row) => ({ ref: `message:${row.id}`, jobId: row.job_id, state: row.state, reportedAt: row.created_at, summary: String(row.content).slice(0, 1200), truncated: String(row.content).length > 1200 }));
    return { jobs, jobReports };
  }
  /** Execution details of a job over all its rounds, in the shape of a routine occurrence's. Forgotten rounds are left out. */
  detail(jobId: string) {
    const job = this.row(jobId);
    const tasks = this.store.all("SELECT id,conversation_id,bot_id,objective,status,result_summary,created_at,ended_at FROM tasks t WHERE conversation_id=? AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=t.id) ORDER BY created_at,rowid", job.conversation_id);
    const ids = tasks.map((task) => String(task.id)), marks = ids.map(() => "?").join(",");
    const messages = ids.length ? this.store.all(`SELECT id,task_id,role,content,created_at FROM transcript WHERE task_id IN (${marks}) ORDER BY created_at,rowid`, ...ids) : [];
    const steps = ids.length ? this.store.all(`SELECT id,task_id,tool_name,status,created_at FROM tool_calls WHERE task_id IN (${marks}) ORDER BY created_at,rowid`, ...ids).map((call) => ({ ...call, summary: String(call.tool_name), preview: "" })) : [];
    const reports = ids.length ? this.store.all(`SELECT id,task_id,state,summary,question,automatic,message_id,created_at FROM agent_job_reports WHERE task_id IN (${marks}) ORDER BY created_at,rowid`, ...ids) : [];
    const current = tasks.at(-1);
    const streaming = current ? this.runtime.workers.get(String(current.id))?.streaming ?? "" : "";
    return { job: this.view(job), task: current ?? null, tasks, messages, steps, reports, streaming };
  }
  /** The job.* broker actions. Errors are returned as {error}; every call is idempotent through its receipt. */
  tool(call: Row, args: Record<string, unknown>) {
    const receipt = this.store.get("SELECT * FROM job_tool_receipts WHERE call_id=?", call.id);
    if (receipt) {
      if (receipt.argument_hash !== call.argument_hash) throw new Error("后台任务调用身份冲突");
      return call.tool_name === "job.list" ? { jobs: this.context(String(call.bot_id)).jobs } : JSON.parse(String(receipt.result_json));
    }
    let value: unknown;
    try { value = this.run(call, args); } catch (error) { value = { error: error instanceof Error ? error.message : "后台任务操作失败" }; }
    this.store.run("INSERT OR IGNORE INTO job_tool_receipts(call_id,argument_hash,result_json) VALUES(?,?,?)", call.id, call.argument_hash, JSON.stringify(value));
    this.runtime.changed();
    return value;
  }
  private run(call: Row, args: Record<string, unknown>) {
    const action = String(call.tool_name), botId = String(call.bot_id), taskId = String(call.task_id), origin = this.runtime.taskOrigin(taskId);
    if (["job.start", "job.list", "job.message", "job.stop"].includes(action)) {
      if (origin !== "owner") return { error: "只有主对话可以派发、转交或停止后台任务" };
      if (action === "job.list") return { jobs: this.context(botId).jobs };
      if (action === "job.start") {
        const started = this.start({ botId, title: args.title, sources: args.sources, note: args.note, deviceId: args.deviceId, originTaskId: taskId, sourceKey: `job-start:${call.id}` });
        return { jobId: started.jobId, stage: this.stage(this.row(started.jobId)) };
      }
      const job = this.row(text(args.jobId, 100));
      if (job.bot_id !== botId) return { error: "只能操作自己的后台任务" };
      if (action === "job.stop") return this.stop(String(job.id));
      const quoted = this.sources(botId, args.sources, taskId), note = optionalText(args.text, 2000);
      const content = [`用户在主对话中说（${quoted.map((row) => `message:${row.id}`).join("、")}）：`, ...quoted.map((row) => String(row.content)), ...(note ? [`主对话备注：${note}`] : [])].join("\n");
      const session = String(this.store.get("SELECT authorized_session_id FROM tasks WHERE id=?", taskId)?.authorized_session_id ?? this.store.session);
      this.input(String(job.id), content, `job-msg:${call.id}`, "owner", session);
      return { jobId: String(job.id), stage: this.stage(this.row(String(job.id))) };
    }
    const job = origin === "job" ? this.jobOfTask(taskId) : undefined;
    if (!job) return { error: "只有后台任务自己可以回报或记录进度" };
    if (action === "job.progress") {
      this.store.run("UPDATE agent_jobs SET progress=?,progress_at=? WHERE id=?", text(args.text, 200), now(), job.id);
      return { saved: true };
    }
    if (action !== "job.report") throw new Error("未知的后台任务能力");
    const state = String(args.state ?? "");
    if (!reportStates.includes(state)) return { error: "state 须为 ready、question、blocked、failed 或 dropped" };
    const summary = text(args.summary, SUMMARY_LIMIT);
    const question = state === "question" ? text(args.question, QUESTION_LIMIT) : undefined;
    if (state !== "question" && args.question !== undefined) return { error: "只有 state=question 时才能附问题" };
    const waitingFor = args.waitingFor === undefined ? undefined : text(args.waitingFor, 200);
    if (waitingFor !== undefined && (state !== "blocked" || !/^resource:[\w-]+:[\w-]+$/.test(waitingFor))) return { error: "waitingFor 只用于 blocked，取值为工具返回的 resource:<设备>:<资源>" };
    this.writeReport(job, taskId, { state, summary, question, waitingFor }, false);
    return { recorded: true };
  }
}
