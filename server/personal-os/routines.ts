import { CoreStore, id, now, text } from "./store.ts";
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
  list() { return this.store.all("SELECT * FROM agent_routines ORDER BY created_at DESC"); }
  occurrences() { return this.store.all("SELECT o.*,r.bot_id,r.name FROM routine_occurrences o JOIN agent_routines r ON r.id=o.routine_id ORDER BY o.created_at DESC LIMIT 100"); }
  save(data: Record<string, unknown>) {
    const botId = text(data.botId, 100), name = text(data.name, 100), prompt = text(data.prompt, 16_000);
    this.agents.ensure(botId);
    const kind = text(data.scheduleKind, 20), zone = text(data.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, 100);
    new Intl.DateTimeFormat("en", { timeZone: zone });
    const interval = kind === "interval" ? Number(data.intervalMinutes) * 60_000 : null;
    if (interval !== null && (!Number.isSafeInteger(interval) || interval < 60_000 || interval > 365 * 86_400_000)) throw new Error("间隔须为 1 分钟至 365 天");
    const localTime = kind === "daily" ? text(data.localTime, 5) : null;
    let due: number;
    if (kind === "daily") due = nextDaily(localTime!, zone, now());
    else if (kind === "interval") due = now() + interval!;
    else if (kind === "once") { due = Number(data.runAt); if (!Number.isSafeInteger(due) || due <= now()) throw new Error("执行时间须在未来"); }
    else throw new Error("不支持的执行计划");
    const routineId = typeof data.id === "string" ? text(data.id, 100) : id();
    this.store.transaction(() => {
      const old = this.store.get("SELECT * FROM agent_routines WHERE id=?", routineId);
      if (old && (old.bot_id !== botId || old.version !== Number(data.version))) throw new Error("例行任务已修改，请刷新");
      if (old) {
        this.store.run("UPDATE agent_routines SET name=?,prompt=?,schedule_kind=?,interval_ms=?,local_time=?,time_zone=?,enabled=1,next_due_at=?,version=version+1 WHERE id=?", name, prompt, kind, interval, localTime, zone, due, routineId);
        this.store.run("UPDATE routine_occurrences SET status='cancelled' WHERE routine_id=? AND status='pending'", routineId);
      } else this.store.insert("agent_routines", { id: routineId, bot_id: botId, name, prompt, schedule_kind: kind, interval_ms: interval, local_time: localTime, time_zone: zone, enabled: 1, next_due_at: due, created_at: now() });
      this.store.audit("routine.configure", "routine", routineId, { botId, scheduleKind: kind });
    });
    this.agents.runtime.changed(); return { id: routineId };
  }
  toggle(routineId: string, version: number, enabled: boolean) {
    this.store.transaction(() => {
      const row = this.store.get("SELECT * FROM agent_routines WHERE id=? AND version=?", routineId, version);
      if (!row) throw new Error("例行任务已修改，请刷新");
      let due = row.next_due_at;
      if (enabled && (due === null || Number(due) <= now())) {
        if (row.schedule_kind === "once") throw new Error("一次性任务已到期，请重新设置执行时间");
        due = row.schedule_kind === "daily" ? nextDaily(String(row.local_time), String(row.time_zone), now()) : now() + Number(row.interval_ms);
      }
      this.store.run("UPDATE agent_routines SET enabled=?,next_due_at=?,version=version+1 WHERE id=?", enabled ? 1 : 0, due, routineId);
      this.store.run("UPDATE routine_occurrences SET status='cancelled' WHERE routine_id=? AND status='pending'", routineId);
      this.store.audit("routine.toggle", "routine", routineId, { enabled });
    }); this.agents.runtime.changed();
  }
  runNow(routineId: string, clientId: string) {
    const row = this.store.get("SELECT * FROM agent_routines WHERE id=?", routineId);
    if (!row) throw new Error("例行任务不存在");
    this.store.transaction(() => {
      const occurrenceId = `manual:${routineId}:${text(clientId, 100)}`;
      if (this.store.get("SELECT id FROM routine_occurrences WHERE id=?", occurrenceId)) return;
      let scheduled = now();
      while (this.store.get("SELECT id FROM routine_occurrences WHERE routine_id=? AND scheduled_at=?", routineId, scheduled)) scheduled++;
      this.store.run("INSERT INTO routine_occurrences VALUES(?,?,?,?,?,?,?)", occurrenceId, routineId, row.version, scheduled, "pending", null, now());
    });
    // Use the same persistent occurrence ID for an HTTP retry. Manual runs are
    // allowed even when the future plan is paused; version checks still apply.
    this.tick();
  }
  tick(at = now()) {
    if (this.agents.runtime.closing) return;
    this.store.transaction(() => {
      for (const routine of this.store.all("SELECT * FROM agent_routines WHERE enabled=1 AND next_due_at<=?", at)) {
        const due = Number(routine.next_due_at);
        this.store.run("INSERT OR IGNORE INTO routine_occurrences(id,routine_id,routine_version,scheduled_at,status,created_at) VALUES(?,?,?,?,?,?)", id(), routine.id, routine.version, due, "pending", at);
        const next = routine.schedule_kind === "once" ? null : routine.schedule_kind === "daily" ? nextDaily(String(routine.local_time), String(routine.time_zone), at) : due + (Math.floor((at - due) / Number(routine.interval_ms)) + 1) * Number(routine.interval_ms);
        this.store.run("UPDATE agent_routines SET next_due_at=?,enabled=? WHERE id=?", next, next === null ? 0 : 1, routine.id);
      }
      for (const occurrence of this.store.all("SELECT o.id,t.status FROM routine_occurrences o JOIN tasks t ON t.id=o.task_id WHERE o.status='running' AND t.ended_at IS NOT NULL")) this.store.run("UPDATE routine_occurrences SET status=? WHERE id=?", occurrence.status === "succeeded" ? "succeeded" : occurrence.status === "cancelled" ? "cancelled" : "failed", occurrence.id);
      if (!this.store.config()?.configured) return;
      for (const occurrence of this.store.all("SELECT o.*,r.bot_id,r.prompt,r.name,r.version FROM routine_occurrences o JOIN agent_routines r ON r.id=o.routine_id WHERE o.status='pending' ORDER BY o.scheduled_at LIMIT 20")) {
        if (occurrence.routine_version !== occurrence.version) { this.store.run("UPDATE routine_occurrences SET status='cancelled' WHERE id=?", occurrence.id); continue; }
        const task = this.agents.startRoutine(String(occurrence.bot_id), String(occurrence.prompt), String(occurrence.name), `routine:${occurrence.id}`);
        if (task) this.store.run("UPDATE routine_occurrences SET status='running',task_id=? WHERE id=?", task, occurrence.id);
      }
    });
    this.agents.runtime.startRecovered(); this.agents.runtime.changed();
  }
}
