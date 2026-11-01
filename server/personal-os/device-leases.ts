import { computerReads } from "./computer.ts";
import { now, type CoreStore } from "./store.ts";

/** Display names of the exclusive device resources. */
export const resourceNames: Record<string, string> = { screen: "屏幕" };

/**
 * The exclusive resources a device call needs; empty when it needs none. Keyboard, mouse and the foreground window
 * exist once per device, so writing GUI operations take its screen; reading the screen does not wait. Other device
 * calls keep the per-device queue. A new exclusive resource is one more mapping here, not a schema change.
 */
export function leaseResources(action: string, args: Record<string, unknown>): string[] {
  if (action === "device.computer" && !computerReads.includes(String(args.operation))) return ["screen"];
  return [];
}

export const waitingKey = (deviceId: string, resource: string) => `resource:${deviceId}:${resource}`;

/**
 * Leases keyed by (device, resource), held by a task for one round of work. Different devices, and different
 * resources of one device, never wait for each other. A lease is released when its task's round ends or is stopped,
 * so a job that reports blocked holds nothing and two jobs cannot wait for each other.
 *
 * Who still holds a lease:
 * - a task with a call on that device whose outcome is not settled (delivered, running, or unknown after a stop or
 *   crash): the device may still be acting, so the lease outlives the task's round until the device reports;
 * - an unfinished task that is working (queued, running, cancelling) or needs reconciliation (its device state is
 *   unknown; the conflict says so, so the user knows what to check).
 * A task that waits for an approval (up to a day) or was paused by a worker crash does not hold the screen against
 * others: its lease may be taken over, and when it resumes its next write waits like any other job's. An ended
 * task with nothing pending on the device holds nothing.
 */
export class DeviceLeases {
  constructor(readonly store: CoreStore) {}
  /** What a lease holder is called to the user: its job title, routine name or the conversation title. */
  label(taskId: string): string {
    const job = this.store.get("SELECT j.title FROM agent_jobs j JOIN tasks t ON t.conversation_id=j.conversation_id WHERE t.id=?", taskId);
    if (job) return String(job.title);
    const title = String(this.store.get("SELECT c.title FROM conversations c JOIN tasks t ON t.conversation_id=c.id WHERE t.id=?", taskId)?.title ?? "其他任务");
    return title.replace(/^例行任务：/, "").split("\n")[0];
  }
  /** The holder's unsettled call on the device, if any. */
  private unsettled(taskId: string, deviceId: string) {
    return this.store.get("SELECT d.status FROM device_calls d JOIN tool_calls c ON c.id=d.id WHERE c.task_id=? AND d.device_id=? AND d.result_json IS NULL AND d.status IN ('delivered','running','unknown') LIMIT 1", taskId, deviceId);
  }
  /** Whether the holder still keeps the resource, and what to tell a caller that has to wait. */
  holding(holder: string, deviceId: string): { held: false } | { held: true; reason: string } {
    const call = this.unsettled(holder, deviceId);
    if (call) return { held: true, reason: call.status === "unknown" ? "，需先在设备上核对它的执行结果" : "" };
    const task = this.store.get("SELECT status,ended_at FROM tasks WHERE id=?", holder);
    if (!task || task.ended_at !== null || task.status === "awaiting_approval" || task.status === "paused") return { held: false };
    return { held: true, reason: task.status === "needs_reconciliation" ? "，需先核对它的执行结果" : "" };
  }
  /** All or nothing: either every resource is now held by the task, or none was taken. */
  acquire(taskId: string, deviceId: string, resources: string[]): { ok: true } | { ok: false; holder: { taskId: string; label: string }; resource: string; reason: string } {
    return this.store.transaction(() => {
      for (const resource of resources) {
        const held = this.store.get("SELECT task_id FROM device_resource_leases WHERE device_id=? AND resource=?", deviceId, resource);
        if (!held || held.task_id === taskId) continue;
        const state = this.holding(String(held.task_id), deviceId);
        if (state.held) return { ok: false as const, holder: { taskId: String(held.task_id), label: this.label(String(held.task_id)) }, resource, reason: state.reason };
      }
      for (const resource of resources) this.store.run("INSERT INTO device_resource_leases(device_id,resource,task_id,acquired_at) VALUES(?,?,?,?) ON CONFLICT(device_id,resource) DO UPDATE SET task_id=excluded.task_id,acquired_at=excluded.acquired_at WHERE task_id<>excluded.task_id", deviceId, resource, taskId, now());
      return { ok: true as const };
    });
  }
  /** Whether a (device, resource) is free for the next waiter. */
  free(deviceId: string, resource: string) {
    const held = this.store.get("SELECT task_id FROM device_resource_leases WHERE device_id=? AND resource=?", deviceId, resource);
    return !held || !this.holding(String(held.task_id), deviceId).held;
  }
  /** Releases the task's leases, except on a device where one of its calls is not settled yet (released when the device reports). */
  releaseTask(taskId: string): Array<{ deviceId: string; resource: string }> {
    return this.store.transaction(() => {
      const released = this.store.all("SELECT device_id,resource FROM device_resource_leases WHERE task_id=?", taskId).map((row) => ({ deviceId: String(row.device_id), resource: String(row.resource) }))
        .filter((lease) => !this.unsettled(taskId, lease.deviceId));
      for (const lease of released) this.store.run("DELETE FROM device_resource_leases WHERE device_id=? AND resource=? AND task_id=?", lease.deviceId, lease.resource, taskId);
      return released;
    });
  }
}
