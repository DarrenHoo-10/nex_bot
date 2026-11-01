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
  /** All or nothing: either every resource is now held by the task, or none was taken. */
  acquire(taskId: string, deviceId: string, resources: string[]): { ok: true } | { ok: false; holder: { taskId: string; label: string }; resource: string } {
    return this.store.transaction(() => {
      for (const resource of resources) {
        const held = this.store.get("SELECT l.task_id,t.ended_at FROM device_resource_leases l LEFT JOIN tasks t ON t.id=l.task_id WHERE l.device_id=? AND l.resource=?", deviceId, resource);
        // A lease left by a task that has ended (a crash between the end and the release) is taken over.
        if (held && held.task_id !== taskId && held.ended_at === null) return { ok: false as const, holder: { taskId: String(held.task_id), label: this.label(String(held.task_id)) }, resource };
      }
      for (const resource of resources) this.store.run("INSERT INTO device_resource_leases(device_id,resource,task_id,acquired_at) VALUES(?,?,?,?) ON CONFLICT(device_id,resource) DO UPDATE SET task_id=excluded.task_id,acquired_at=excluded.acquired_at WHERE task_id<>excluded.task_id", deviceId, resource, taskId, now());
      return { ok: true as const };
    });
  }
  releaseTask(taskId: string): Array<{ deviceId: string; resource: string }> {
    return this.store.transaction(() => {
      const held = this.store.all("SELECT device_id,resource FROM device_resource_leases WHERE task_id=?", taskId).map((row) => ({ deviceId: String(row.device_id), resource: String(row.resource) }));
      if (held.length) this.store.run("DELETE FROM device_resource_leases WHERE task_id=?", taskId);
      return held;
    });
  }
}
