import { CoreStore, id, now, text, type Row } from "./store.ts";
import { AgentModule } from "./agents.ts";

export function nextDaily(time: string, zone: string, after: number): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("每日时间须为 HH:mm");
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = (at: number) => Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  const previous = parts(after);
  const previousDate = `${previous.year}-${previous.month}-${previous.day}`;
  // UTC-minute traversal handles skipped DST minutes without inventing a wall
  // time; a repeated minute is not scheduled twice on the same local date.
  for (let at = (Math.floor(after / 60_000) + 1) * 60_000; at <= after + 49 * 3_600_000; at += 60_000) {
    const p = parts(at);
    if (`${p.hour}:${p.minute}` === time && (`${p.year}-${p.month}-${p.day}` !== previousDate || `${previous.hour}:${previous.minute}` < time)) return at;
  }
  throw new Error("无法计算下一次每日执行时间");
}

export class RoutineModule {
  private timer?: NodeJS.Timeout;
  constructor(readonly store: CoreStore, readonly agents: AgentModule) {}
  start() { this.timer = setInterval(() => this.tick(), 5000); this.timer.unref(); this.tick(); }
  close() { clearInterval(this.timer); }
  list() { return this.store.all("SELECT * FROM agent_routines WHERE deleted_at IS NULL ORDER BY created_at DESC"); }
  occurrences() {
    return this.store.all("SELECT o.*,r.bot_id,t.status task_status FROM routine_occurrences o JOIN agent_routines r ON r.id=o.routine_id LEFT JOIN tasks t ON t.id=o.task_id ORDER BY o.created_at DESC,o.rowid DESC LIMIT 100");
  }
  occurrence(occurrenceId: string) {
    const occurrence = this.store.get("SELECT o.*,r.bot_id,t.status task_status FROM routine_occurrences o JOIN agent_routines r ON r.id=o.routine_id LEFT JOIN tasks t ON t.id=o.task_id WHERE o.id=?", occurrenceId);
    if (!occurrence || (occurrence.task_id && this.store.get("SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?", occurrence.task_id))) throw new Error("执行记录不存在或已遗忘");
    const task = occurrence.task_id ? this.store.get("SELECT id,conversation_id,bot_id,objective,status,result_summary,created_at,ended_at FROM tasks WHERE id=?", occurrence.task_id) ?? null : null;
    const messages = task ? this.store.all("SELECT id,role,content,created_at FROM transcript WHERE task_id=? ORDER BY created_at,rowid", task.id) : [];
    const steps = task ? this.store.all("SELECT id,tool_name,status,created_at FROM tool_calls WHERE task_id=? ORDER BY created_at,rowid", task.id).map((call) => ({ ...call, summary: String(call.tool_name), preview: "" })) : [];
    const streaming = task ? this.agents.runtime.workers.get(String(task.id))?.streaming ?? "" : "";
    return { occurrence, task, messages, steps, streaming };
  }
  tool(call: Row, args: Record<string, unknown>) {
    const botId = String(call.bot_id);
    const result = this.store.transaction(() => {
      const receipt = this.store.get("SELECT * FROM routine_tool_receipts WHERE call_id=?", call.id);
      if (receipt) {
        if (receipt.argument_hash !== call.argument_hash) throw new Error("例行任务调用身份冲突");
        if (call.tool_name === "routine.list") return { routines: this.list().filter((r) => r.bot_id === botId) };
        const saved = JSON.parse(String(receipt.result_json));
        if (saved.routine && this.store.get("SELECT id FROM agent_routines WHERE id=? AND deleted_at IS NOT NULL", saved.routine.id)) throw new Error("例行任务已删除");
        return saved;
      }
      let value: unknown;
      if (call.tool_name === "routine.list") value = { routines: this.list().filter((r) => r.bot_id === botId) };
      else if (call.tool_name === "routine.save") {
        let runAt = args.runAt;
        if (args.delaySeconds !== undefined) {
          if (!Number.isSafeInteger(args.delaySeconds) || Number(args.delaySeconds) < 1 || Number(args.delaySeconds) > 365 * 86400 || args.runAt !== undefined) throw new Error("延迟须为 1 秒至 365 天，并且不能同时指定绝对时间");
          runAt = now() + Number(args.delaySeconds) * 1000;
        }
        const configured = this.save({ ...args, botId, id: args.routineId ?? `tool:${call.id}`, version: args.expectedVersion, runAt });
        value = { routine: this.store.get("SELECT * FROM agent_routines WHERE id=?", configured.id), scheduled: true };
      } else {
        const routineId = text(args.routineId, 100);
        if (!this.store.get("SELECT id FROM agent_routines WHERE id=? AND bot_id=?", routineId, botId)) throw new Error("例行任务不属于当前 Agent");
        if (call.tool_name === "routine.toggle") {
          if (typeof args.enabled !== "boolean") throw new Error("启用状态无效");
          this.toggle(routineId, Number(args.expectedVersion), args.enabled);
        } else if (call.tool_name === "routine.run") this.runNow(routineId, String(call.id));
        else throw new Error("未知的例行任务能力");
        value = { routine: this.store.get("SELECT * FROM agent_routines WHERE id=?", routineId) };
      }
      const receiptValue = value as { routine?: Row };
      this.store.insert("routine_tool_receipts", { call_id: call.id, argument_hash: call.argument_hash, result_json: JSON.stringify(value), created_at: now() });
      if (call.tool_name === "routine.save" && receiptValue.routine) this.store.run("INSERT OR IGNORE INTO routine_origins(routine_id,task_id) VALUES(?,?)", receiptValue.routine.id, call.task_id);
      return value;
    });
    this.agents.runtime.changed(); return result;
  }
  save(data: Record<string, unknown>) {
    const botId = text(data.botId, 100), name = text(data.name, 100), prompt = text(data.prompt, 16_000);
    this.agents.ensure(botId);
    const routineId = typeof data.id === "string" ? text(data.id, 100) : id();
    const old = this.store.get("SELECT * FROM agent_routines WHERE id=?", routineId);
    if (old && (old.bot_id !== botId || old.version !== Number(data.version))) throw new Error("例行任务已修改，请刷新");
    if (old && old.deleted_at !== null) throw new Error("例行任务已删除");
    const kind = text(data.scheduleKind, 20), zone = text(data.timeZone ?? old?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, 100);
    const taskKind = text(data.taskKind ?? old?.task_kind ?? (kind === "once" ? "reminder" : kind === "interval" ? "monitor" : "report"), 20);
    if (!["reminder", "monitor", "report", "action"].includes(taskKind)) throw new Error("任务类型无效");
    new Intl.DateTimeFormat("en", { timeZone: zone });
    const interval = kind === "interval" ? Number(data.intervalMinutes) * 60_000 : null;
    if (interval !== null && (!Number.isSafeInteger(interval) || interval < 300_000 || interval > 365 * 86_400_000)) throw new Error("间隔须为 5 分钟至 365 天");
    const localTime = kind === "daily" ? text(data.localTime, 5) : null;
    const runAt = kind === "once" ? Number(data.runAt ?? old?.run_at ?? old?.next_due_at) : null;
    const timingChanged = !old || old.schedule_kind !== kind || old.interval_ms !== interval || old.local_time !== localTime || old.time_zone !== zone || (kind === "once" && old.run_at !== runAt);
    let due: number | null = old?.next_due_at as number | null ?? null;
    if (kind === "daily") { const next = nextDaily(localTime!, zone, now()); if (timingChanged) due = next; }
    else if (kind === "interval") { if (timingChanged) due = now() + interval!; }
    else if (kind === "once") { if (timingChanged) { if (!Number.isSafeInteger(runAt) || runAt! <= now()) throw new Error("执行时间须在未来"); due = runAt; } }
    else throw new Error("不支持的执行计划");
    this.store.transaction(() => {
      if (old) {
        this.store.run("UPDATE agent_routines SET name=?,prompt=?,schedule_kind=?,interval_ms=?,local_time=?,time_zone=?,next_due_at=?,task_kind=?,run_at=?,version=version+1 WHERE id=?", name, prompt, kind, interval, localTime, zone, due, taskKind, runAt, routineId);
        if (timingChanged) this.store.run("UPDATE routine_occurrences SET status='cancelled',reason='计划时间已修改',finished_at=? WHERE routine_id=? AND status='pending' AND trigger_source='schedule'", now(), routineId);
      } else this.store.insert("agent_routines", { id: routineId, bot_id: botId, name, prompt, schedule_kind: kind, interval_ms: interval, local_time: localTime, time_zone: zone, enabled: 1, next_due_at: due, task_kind: taskKind, run_at: runAt, created_at: now() });
      this.store.audit("routine.configure", "routine", routineId, { botId, scheduleKind: kind });
    });
    this.agents.runtime.changed(); return { id: routineId };
  }
  toggle(routineId: string, version: number, enabled: boolean) {
    this.store.transaction(() => {
      const row = this.store.get("SELECT * FROM agent_routines WHERE id=? AND version=?", routineId, version);
      if (!row) throw new Error("例行任务已修改，请刷新");
      if (row.deleted_at !== null) throw new Error("例行任务已删除");
      let due = row.next_due_at;
      if (enabled && (due === null || Number(due) <= now())) {
        if (row.schedule_kind === "once") throw new Error("一次性任务已到期，请重新设置执行时间");
        due = row.schedule_kind === "daily" ? nextDaily(String(row.local_time), String(row.time_zone), now()) : now() + Number(row.interval_ms);
      }
      this.store.run("UPDATE agent_routines SET enabled=?,next_due_at=?,version=version+1 WHERE id=?", enabled ? 1 : 0, due, routineId);
      if (!enabled) this.store.run("UPDATE routine_occurrences SET status='cancelled',reason='计划已暂停',finished_at=? WHERE routine_id=? AND status='pending' AND trigger_source='schedule'", now(), routineId);
      this.store.audit("routine.toggle", "routine", routineId, { enabled });
    }); this.agents.runtime.changed();
  }
  remove(routineId: string, version: number) {
    this.store.transaction(() => {
      const row = this.store.get("SELECT * FROM agent_routines WHERE id=? AND version=?", routineId, version);
      if (!row) throw new Error("例行任务已修改，请刷新");
      if (row.deleted_at !== null) throw new Error("例行任务已删除");
      const at = now();
      this.store.run("UPDATE agent_routines SET enabled=0,version=version+1,deleted_at=? WHERE id=?", at, routineId);
      this.store.run("UPDATE routine_occurrences SET status='cancelled',reason='计划已删除',finished_at=? WHERE routine_id=? AND status='pending'", at, routineId);
      this.store.audit("routine.delete", "routine", routineId, { botId: row.bot_id });
    });
    this.agents.runtime.changed();
  }
  runNow(routineId: string, clientId: string) {
    const row = this.store.get("SELECT * FROM agent_routines WHERE id=?", routineId);
    if (!row) throw new Error("例行任务不存在");
    if (row.deleted_at !== null) throw new Error("例行任务已删除");
    if (!this.store.get("SELECT id FROM bots WHERE id=? AND status='active'", row.bot_id)) throw new Error("助手已归档");
    this.store.transaction(() => {
      const occurrenceId = `manual:${routineId}:${text(clientId, 100)}`;
      if (this.store.get("SELECT id FROM routine_occurrences WHERE id=?", occurrenceId)) return;
      let scheduled = now();
      while (this.store.get("SELECT id FROM routine_occurrences WHERE routine_id=? AND scheduled_at=?", routineId, scheduled)) scheduled++;
      this.enqueue(row, scheduled, now(), "manual", occurrenceId);
    });
    // HTTP retries reuse the occurrence; manual runs also work on paused plans.
    this.tick();
  }
  private enqueue(routine: Row, scheduled: number, at: number, trigger: "manual" | "schedule", occurrenceId: string = id()) {
    const grace = routine.task_kind === "reminder" ? 300_000 : routine.task_kind === "monitor" ? Math.min(Number(routine.interval_ms ?? 900_000), 900_000) : routine.task_kind === "report" ? 43_200_000 : 1_800_000;
    this.store.run("INSERT OR IGNORE INTO routine_occurrences(id,routine_id,routine_version,scheduled_at,status,created_at,name,prompt,task_kind,trigger_source,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", occurrenceId, routine.id, routine.version, scheduled, "pending", at, routine.name, routine.prompt, routine.task_kind, trigger, trigger === "manual" ? null : scheduled + grace);
  }
  tick(at = now()) {
    if (this.agents.runtime.closing) return;
    this.store.transaction(() => {
      for (const routine of this.store.all("SELECT * FROM agent_routines WHERE deleted_at IS NULL AND enabled=1 AND next_due_at<=?", at)) {
        let due = Number(routine.next_due_at);
        // Collapse downtime to the latest occurrence, never replay every missed period.
        if (routine.schedule_kind === "interval") due += Math.floor((at - due) / Number(routine.interval_ms)) * Number(routine.interval_ms);
        else if (routine.schedule_kind === "daily") {
          let candidate = nextDaily(String(routine.local_time), String(routine.time_zone), Math.max(due - 1, at - 49 * 3_600_000));
          while (candidate <= at) { due = candidate; candidate = nextDaily(String(routine.local_time), String(routine.time_zone), candidate); }
        }
        this.store.run("UPDATE routine_occurrences SET status='skipped',reason='已合并到最新一次执行',finished_at=? WHERE routine_id=? AND status='pending' AND trigger_source='schedule'", at, routine.id);
        this.enqueue(routine, due, at, "schedule");
        const next = routine.schedule_kind === "once" ? null : routine.schedule_kind === "daily" ? nextDaily(String(routine.local_time), String(routine.time_zone), at) : due + Number(routine.interval_ms);
        this.store.run("UPDATE agent_routines SET next_due_at=?,enabled=? WHERE id=?", next, next === null ? 0 : 1, routine.id);
      }
      this.store.run("UPDATE routine_occurrences SET status='skipped',reason='已超过允许迟到时间',finished_at=? WHERE status='pending' AND expires_at<?", at, at);
      for (const expired of this.store.all("SELECT o.id,o.task_id FROM routine_occurrences o JOIN tasks t ON t.id=o.task_id WHERE o.status='running' AND o.expires_at<? AND t.ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.task_id=t.id)", at)) {
        this.store.run("UPDATE routine_occurrences SET status='skipped',reason='已超过允许迟到时间',finished_at=? WHERE id=?", at, expired.id);
        this.agents.runtime.cancel(String(expired.task_id), "已超过允许迟到时间，本次定时任务未执行");
      }
      for (const occurrence of this.store.all("SELECT o.id,t.status,t.ended_at FROM routine_occurrences o JOIN tasks t ON t.id=o.task_id WHERE o.status='running' AND t.ended_at IS NOT NULL")) this.store.run("UPDATE routine_occurrences SET status=?,finished_at=? WHERE id=?", occurrence.status === "succeeded" ? "succeeded" : occurrence.status === "cancelled" ? "cancelled" : "failed", occurrence.ended_at, occurrence.id);
      if (!this.store.config()?.configured) return;
      // One background child per assistant; a blocked assistant never occupies another's slot.
      for (const occurrence of this.store.all("SELECT o.*,r.bot_id FROM routine_occurrences o JOIN agent_routines r ON r.id=o.routine_id JOIN bots b ON b.id=r.bot_id WHERE o.status='pending' AND r.deleted_at IS NULL AND b.status='active' ORDER BY o.scheduled_at,o.rowid")) {
        if (this.store.get("SELECT t.id FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE l.bot_id=? AND l.origin='routine' AND t.ended_at IS NULL", occurrence.bot_id)) continue;
        this.store.db.exec("SAVEPOINT routine_dispatch");
        try {
          const task = this.agents.startRoutine(String(occurrence.bot_id), String(occurrence.prompt), String(occurrence.name), `routine:${occurrence.id}`);
          if (task) this.store.run("UPDATE routine_occurrences SET status='running',task_id=? WHERE id=?", task, occurrence.id);
          this.store.db.exec("RELEASE routine_dispatch");
        } catch (error) {
          this.store.db.exec("ROLLBACK TO routine_dispatch; RELEASE routine_dispatch");
          this.store.run("UPDATE routine_occurrences SET status='failed',reason=?,finished_at=? WHERE id=?", error instanceof Error ? error.message : "无法派发任务", at, occurrence.id);
        }
      }
    });
    for (const task of this.store.all("SELECT t.id FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE l.origin='routine' AND t.ended_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM routine_occurrences o WHERE o.task_id=t.id AND o.status='skipped') AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=t.id) AND NOT EXISTS(SELECT 1 FROM agent_messages m WHERE m.task_id=t.id AND (m.source_key='routine-report:'||t.id OR m.source_key LIKE 'answer:%' OR m.source_key LIKE 'error:%'))")) this.agents.reportRoutine(String(task.id));
    this.agents.runtime.startRecovered(); this.agents.runtime.changed();
  }
}
