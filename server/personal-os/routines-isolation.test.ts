import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreStore } from "./store.ts";
import { AgentModule } from "./agents.ts";
import { RoutineModule } from "./routines.ts";
import type { TaskRuntime } from "./runtime.ts";

const fixtures: Array<{ store: CoreStore; runtime: TaskRuntime; dir: string }> = [];
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-routine-isolation-"));
  const store = new CoreStore(dir, Buffer.alloc(32, 7), "synthetic-token");
  const runtime = { closing: false, changed() {}, startRecovered() {}, workers: new Map(), memory: { ledger: { message() {} } }, taskRoot(taskId: string) { return taskId; } } as unknown as TaskRuntime;
  const agents = new AgentModule(store, runtime), routines = new RoutineModule(store, agents);
  store.saveConfig({ provider: "openai", endpoint: "http://127.0.0.1:1/v1", model: "fake", apiKey: "synthetic" });
  const bot = store.createBot("Synthetic A"), other = store.createBot("Synthetic B");
  agents.ensure(bot); agents.ensure(other);
  fixtures.push({ store, runtime, dir });
  return { store, runtime, agents, routines, bot, other };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { f.runtime.closing = true; f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

describe("routine scheduling with isolated child execution", () => {
  it("upgrades old one-minute schedules and receipts without replaying finished work", () => {
    const f = fixture(), at = Date.now();
    f.store.db.exec(`DROP TABLE routine_occurrences;
      CREATE TABLE routine_occurrences(id TEXT PRIMARY KEY,routine_id TEXT NOT NULL REFERENCES agent_routines(id),routine_version INTEGER NOT NULL,scheduled_at INTEGER NOT NULL,status TEXT NOT NULL,task_id TEXT UNIQUE REFERENCES tasks(id),created_at INTEGER NOT NULL,UNIQUE(routine_id,scheduled_at)) STRICT;
      CREATE INDEX routine_pending ON routine_occurrences(status,scheduled_at);
      ALTER TABLE agent_routines DROP COLUMN task_kind;
      ALTER TABLE agent_routines DROP COLUMN run_at;
      ALTER TABLE agent_routines DROP COLUMN deleted_at;
      DELETE FROM schema_migrations WHERE version>=36;`);
    f.store.insert("agent_routines", { id: "legacy", bot_id: f.bot, name: "legacy", prompt: "saved work", schedule_kind: "interval", interval_ms: 60000, time_zone: "UTC", enabled: 1, next_due_at: at + 60000, created_at: at });
    f.store.run("INSERT INTO routine_occurrences VALUES('legacy-run','legacy',1,?,'succeeded',NULL,?)", at, at);
    f.store.run("INSERT INTO routine_occurrences VALUES('old-pending','legacy',1,?,'pending',NULL,?)", at + 1, at + 1);
    f.store.run("INSERT INTO routine_occurrences VALUES('new-pending','legacy',1,?,'pending',NULL,?)", at + 2, at + 2);
    f.store.close();
    const upgraded = new CoreStore(f.store.dir, Buffer.alloc(32, 7), "synthetic-token");
    fixtures.at(-1)!.store = upgraded;
    expect(upgraded.get("SELECT interval_ms,task_kind FROM agent_routines WHERE id='legacy'")).toEqual({ interval_ms: 300000, task_kind: "monitor" });
    expect(upgraded.get("SELECT status,name,prompt,trigger_source FROM routine_occurrences WHERE id='legacy-run'")).toEqual({ status: "succeeded", name: "legacy", prompt: "saved work", trigger_source: "schedule" });
    expect(upgraded.get("SELECT COUNT(*) n FROM routine_occurrences WHERE status='pending'")?.n).toBe(1);
    expect(upgraded.get("SELECT status FROM routine_occurrences WHERE id='old-pending'")?.status).toBe("skipped");
  });

  it("upgrades schema 36 independently and preserves deleted plans across reopening", () => {
    const f = fixture();
    const { id } = f.routines.save({ botId: f.bot, name: "existing", prompt: "work", scheduleKind: "interval", intervalMinutes: 5 });
    const migration = f.store.get("SELECT * FROM schema_migrations WHERE version=36");
    f.store.db.exec("ALTER TABLE agent_routines DROP COLUMN deleted_at; DELETE FROM schema_migrations WHERE version=37;");
    f.store.close();
    const upgraded = new CoreStore(f.store.dir, Buffer.alloc(32, 7), "synthetic-token");
    fixtures.at(-1)!.store = upgraded;
    expect(upgraded.get("SELECT * FROM schema_migrations WHERE version=36")).toEqual(migration);
    expect(upgraded.get("SELECT deleted_at,version FROM agent_routines WHERE id=?", id)).toEqual({ deleted_at: null, version: 1 });
    expect(upgraded.get("SELECT MAX(version) version FROM schema_migrations")?.version).toBe(37);
    new RoutineModule(upgraded, f.agents).remove(id, 1);
    const deleted = upgraded.get("SELECT * FROM agent_routines WHERE id=?", id);
    upgraded.close();
    const reopened = new CoreStore(f.store.dir, Buffer.alloc(32, 7), "synthetic-token");
    fixtures.at(-1)!.store = reopened;
    expect(reopened.get("SELECT * FROM agent_routines WHERE id=?", id)).toEqual(deleted);
    expect(new RoutineModule(reopened, f.agents).list()).toEqual([]);
  });

  it("soft deletes with version checks, cancels scheduled and manual pending work, and keeps dispatched history", () => {
    const f = fixture();
    const draft = { botId: f.bot, name: "delete me", prompt: "captured work", scheduleKind: "interval", intervalMinutes: 5 };
    const { id } = f.routines.save(draft);
    const other = f.routines.save({ ...draft, botId: f.other });
    const due = Number(f.store.get("SELECT next_due_at FROM agent_routines WHERE id=?", id)!.next_due_at);
    f.routines.runNow(id, "history");
    const history = f.store.get("SELECT * FROM routine_occurrences WHERE routine_id=?", id)!;
    f.store.run("UPDATE tasks SET status='succeeded',result_summary='retained result',ended_at=? WHERE id=?", Date.now(), history.task_id);
    f.routines.tick();
    f.routines.runNow(id, "active");
    const active = f.store.get("SELECT * FROM routine_occurrences WHERE routine_id=? AND status='running'", id)!;
    const activeTask = f.store.get("SELECT * FROM tasks WHERE id=?", active.task_id);
    f.routines.runNow(id, "pending-manual");
    f.routines.tick(due);
    const pending = f.store.all("SELECT * FROM routine_occurrences WHERE routine_id=? AND status='pending'", id);
    expect(pending.map(row => row.trigger_source).sort()).toEqual(["manual", "schedule"]);
    const before = f.store.get("SELECT * FROM agent_routines WHERE id=?", id);
    expect(() => f.routines.remove(id, 0)).toThrow("已修改");
    expect(f.store.get("SELECT * FROM agent_routines WHERE id=?", id)).toEqual(before);
    expect(f.store.all("SELECT * FROM routine_occurrences WHERE routine_id=? AND status='pending'", id)).toEqual(pending);
    f.routines.remove(id, 1);
    const deleted = f.store.get("SELECT * FROM agent_routines WHERE id=?", id)!;
    expect(deleted).toMatchObject({ enabled: 0, version: 2, deleted_at: expect.any(Number) });
    for (const row of pending) expect(f.store.get("SELECT status,reason,finished_at FROM routine_occurrences WHERE id=?", row.id)).toEqual({ status: "cancelled", reason: "计划已删除", finished_at: deleted.deleted_at });
    expect(f.store.get("SELECT * FROM tasks WHERE id=?", active.task_id)).toEqual(activeTask);
    expect(f.store.get("SELECT * FROM routine_occurrences WHERE id=?", active.id)).toEqual(active);
    expect(f.routines.occurrence(String(history.id))).toMatchObject({ occurrence: { status: "succeeded" }, task: { result_summary: "retained result" }, messages: expect.any(Array) });
    expect(f.routines.occurrences().filter(row => row.routine_id === id)).toHaveLength(4);
    expect(f.routines.list().map(row => row.id)).toEqual([other.id]);
    expect(() => f.routines.remove(id, 1)).toThrow("已修改");
    expect(() => f.routines.remove(id, 2)).toThrow("已删除");
    expect(() => f.routines.save({ ...draft, id, version: 2 })).toThrow("已删除");
    expect(() => f.routines.toggle(id, 2, true)).toThrow("已删除");
    expect(() => f.routines.toggle(id, 2, false)).toThrow("已删除");
    expect(() => f.routines.runNow(id, "active")).toThrow("已删除");
    expect(() => f.routines.runNow(id, "new-request")).toThrow("已删除");
    expect(() => f.routines.tool({ id: "cross-bot", tool_name: "routine.save", bot_id: f.other }, { ...draft, routineId: id, expectedVersion: 2 })).toThrow("已修改");
    expect(() => f.routines.tool({ id: "cross-bot-run", tool_name: "routine.run", bot_id: f.other }, { routineId: id })).toThrow("不属于");
    expect(f.store.get("SELECT * FROM agent_routines WHERE id=?", id)).toEqual(deleted);
    f.routines.tick(due + 300_000);
    expect(f.store.all("SELECT * FROM routine_occurrences WHERE routine_id=?", id)).toHaveLength(4);
  });

  it("filters deleted rows in both scheduler creation and pending dispatch", () => {
    const f = fixture();
    const { id } = f.routines.save({ botId: f.bot, name: "deleted", prompt: "work", scheduleKind: "interval", intervalMinutes: 5 });
    const due = Number(f.store.get("SELECT next_due_at FROM agent_routines WHERE id=?", id)!.next_due_at);
    f.runtime.closing = true;
    f.routines.runNow(id, "stranded");
    f.routines.remove(id, 1);
    // Inconsistent persisted flags must not defeat either deletion filter.
    f.store.run("UPDATE agent_routines SET enabled=1 WHERE id=?", id);
    f.store.run("UPDATE routine_occurrences SET status='pending' WHERE routine_id=?", id);
    f.runtime.closing = false;
    f.routines.tick(due);
    expect(f.store.all("SELECT * FROM routine_occurrences WHERE routine_id=?", id)).toHaveLength(1);
    expect(f.store.get("SELECT status,task_id FROM routine_occurrences WHERE routine_id=?", id)).toEqual({ status: "pending", task_id: null });
    expect(f.store.all("SELECT * FROM tasks")).toEqual([]);
  });

  it("preserves paused state and interval phase for content edits, with immutable pending snapshots", () => {
    const f = fixture();
    const draft = { botId: f.bot, name: "original", prompt: "original work", scheduleKind: "interval", intervalMinutes: 5 };
    const { id } = f.routines.save(draft);
    const first = f.store.get("SELECT * FROM agent_routines WHERE id=?", id)!;
    f.agents.startRoutine(f.bot, "block", "block", "block");
    f.routines.tick(Number(first.next_due_at));
    const occurrence = f.store.get("SELECT * FROM routine_occurrences WHERE routine_id=?", id)!;
    f.routines.save({ ...draft, id, version: 1, name: "new name", prompt: "new work" });
    expect(f.store.get("SELECT name,prompt,status FROM routine_occurrences WHERE id=?", occurrence.id)).toEqual({ name: "original", prompt: "original work", status: "pending" });
    f.routines.toggle(id, 2, false);
    const paused = f.store.get("SELECT * FROM agent_routines WHERE id=?", id)!;
    f.routines.save({ ...draft, id, version: 3, name: "renamed paused" });
    expect(f.store.get("SELECT enabled,next_due_at FROM agent_routines WHERE id=?", id)).toEqual({ enabled: 0, next_due_at: paused.next_due_at });
    expect(() => f.routines.save({ ...draft, id, version: 3 })).toThrow("已修改");
  });

  it("retains a completed once plan's original date and never rearms it on rename", () => {
    const f = fixture(), due = Date.now() + 60_000;
    const draft = { botId: f.bot, name: "once", prompt: "work", scheduleKind: "once", runAt: due };
    const { id } = f.routines.save(draft);
    f.routines.tick(due);
    f.routines.save({ ...draft, id, version: 1, name: "renamed" });
    expect(f.store.get("SELECT enabled,next_due_at,run_at FROM agent_routines WHERE id=?", id)).toEqual({ enabled: 0, next_due_at: null, run_at: due });
  });

  it("enforces five minute cadence but permits short one-shot reminders", () => {
    const f = fixture();
    expect(() => f.routines.save({ botId: f.bot, name: "too fast", prompt: "work", scheduleKind: "interval", intervalMinutes: 4 })).toThrow("5 分钟");
    expect(f.routines.save({ botId: f.bot, name: "reminder", prompt: "work", scheduleKind: "once", runAt: Date.now() + 60_000 }).id).toBeTruthy();
  });

  it("keeps one pending scheduled occurrence per plan and dispatches an idle assistant independently", () => {
    const f = fixture();
    f.agents.startRoutine(f.bot, "blocked child", "block", "blocked-child");
    const { id } = f.routines.save({ botId: f.bot, name: "monitor", prompt: "check", scheduleKind: "interval", intervalMinutes: 5 });
    const due = Number(f.store.get("SELECT next_due_at FROM agent_routines WHERE id=?", id)!.next_due_at);
    for (let i = 0; i < 26; i++) f.routines.tick(due + i * 300_000);
    const idle = f.routines.save({ botId: f.other, name: "idle", prompt: "work", scheduleKind: "once", runAt: due + 26 * 300_000 });
    f.routines.tick(due + 26 * 300_000);
    expect(f.store.get("SELECT COUNT(*) n FROM routine_occurrences WHERE routine_id=? AND status='pending'", id)?.n).toBe(1);
    expect(f.store.get("SELECT COUNT(*) n FROM routine_occurrences WHERE routine_id=? AND status='skipped'", id)?.n).toBe(26);
    expect(f.store.get("SELECT status FROM routine_occurrences WHERE routine_id=?", idle.id)?.status).toBe("running");
    expect(f.agents.active(f.other)).toBeUndefined();
  });

  it.each([["reminder", 300_000], ["monitor", 900_000], ["report", 43_200_000], ["action", 1_800_000]])("expires %s after its grace window", (taskKind, grace) => {
    const f = fixture(), due = Date.now() + 60_000;
    const { id } = f.routines.save({ botId: f.bot, name: "late", prompt: "work", scheduleKind: "once", runAt: due, taskKind });
    f.routines.tick(due + Number(grace) + 1);
    expect(f.store.get("SELECT status,task_id,reason FROM routine_occurrences WHERE routine_id=?", id)).toEqual({ status: "skipped", task_id: null, reason: "已超过允许迟到时间" });
    const detail = f.routines.occurrence(String(f.store.get("SELECT id FROM routine_occurrences WHERE routine_id=?", id)!.id));
    expect(detail.task).toBeNull(); expect(detail.messages).toEqual([]);
  });

  it("collapses downtime to the latest interval and honors the grace boundary", () => {
    const f = fixture();
    const { id } = f.routines.save({ botId: f.bot, name: "check", prompt: "work", scheduleKind: "interval", intervalMinutes: 5 });
    const due = Number(f.store.get("SELECT next_due_at FROM agent_routines WHERE id=?", id)!.next_due_at);
    f.routines.tick(due + 7 * 86_400_000 + 1000);
    expect(f.store.all("SELECT * FROM routine_occurrences WHERE routine_id=?", id)).toHaveLength(1);
    expect(f.store.get("SELECT scheduled_at,status FROM routine_occurrences WHERE routine_id=?", id)).toEqual({ scheduled_at: due + 7 * 86_400_000, status: "running" });
  });

  it("keeps manual runs idempotent while paused and reads their captured work", () => {
    const f = fixture();
    const draft = { botId: f.bot, name: "original", prompt: "captured work", scheduleKind: "daily", localTime: "09:00", timeZone: "UTC" };
    const { id } = f.routines.save(draft); f.routines.toggle(id, 1, false);
    f.routines.runNow(id, "same-request"); f.routines.runNow(id, "same-request");
    f.routines.save({ ...draft, id, version: 2, name: "new name" });
    const rows = f.store.all("SELECT * FROM routine_occurrences WHERE routine_id=?", id);
    expect(rows).toHaveLength(1);
    const detail = f.routines.occurrence(String(rows[0].id));
    expect(detail.occurrence.name).toBe("original");
    expect(detail.task?.objective).toContain("captured work");
    expect(detail.messages).toHaveLength(1);
    expect(f.store.get("SELECT enabled FROM agent_routines WHERE id=?", id)?.enabled).toBe(0);
  });

  it("isolates dispatch errors so another assistant is still dispatched", () => {
    const f = fixture(), due = Date.now() + 60_000;
    const broken = f.routines.save({ botId: f.bot, name: "bad", prompt: "work", scheduleKind: "once", runAt: due });
    const healthy = f.routines.save({ botId: f.other, name: "good", prompt: "work", scheduleKind: "once", runAt: due });
    const start = f.agents.startRoutine.bind(f.agents);
    vi.spyOn(f.agents, "startRoutine").mockImplementation((bot, ...rest) => { if (bot === f.bot) throw new Error("synthetic failure"); return start(bot, ...rest); });
    f.routines.tick(due);
    expect(f.store.get("SELECT status FROM routine_occurrences WHERE routine_id=?", broken.id)?.status).toBe("failed");
    expect(f.store.get("SELECT status FROM routine_occurrences WHERE routine_id=?", healthy.id)?.status).toBe("running");
  });
});
