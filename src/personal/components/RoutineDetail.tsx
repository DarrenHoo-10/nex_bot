import { useState } from "react";
import { X } from "lucide-react";
import { str, type RecordRow } from "../api";
const formatTime = (value: RecordRow[string]) => value ? new Date(Number(value)).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

export function routineSchedule(row: RecordRow) {
  const minutes = Number(row.interval_ms) / 60_000;
  if (row.schedule_kind === "interval") return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  if (row.schedule_kind === "once") return row.run_at || row.next_due_at ? `${formatTime(row.run_at ?? row.next_due_at)} · 仅一次` : "仅一次";
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `每天 ${row.local_time}${row.time_zone && row.time_zone !== localZone ? ` · ${row.time_zone}` : ""}`;
}
export const routineEnded = (row: RecordRow) => row.schedule_kind === "once" && !row.next_due_at && !row.enabled;

export function RoutineDetail({ routine, latest, close, showResult, disable, remove }: {
  routine: RecordRow; latest?: RecordRow; close: () => void; showResult: (id: string) => void;
  disable: () => Promise<void>; remove: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<"disable" | "remove">();
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const ended = routineEnded(routine);
  return <div className="routine-detail routine-plan-detail">
    <div className="modal-heading"><h2>{routine.name}</h2><button type="button" aria-label="关闭详情" disabled={pending} onClick={close}><X size={18}/></button></div>
    <div className="routine-detail-toolbar"><span className="routine-status">{ended ? "已结束" : routine.enabled ? "已安排" : "已关闭"}</span><span>{routineSchedule(routine)}</span></div>
    <section className="routine-result"><h3>要做什么</h3><p className="routine-detail-prompt">{routine.prompt}</p></section>
    {routine.enabled && routine.next_due_at ? <p className="routine-next">下次 {formatTime(routine.next_due_at)}</p> : null}
    <div className="routine-detail-toolbar">{latest ? <button type="button" onClick={() => showResult(str(latest.id))}>查看最近结果</button> : <span className="muted">还没有结果</span>}</div>
    {confirm ? <section className="routine-confirm" role="group" aria-label={confirm === "remove" ? "确认删除任务" : "确认关闭任务"}>
      <h3>{confirm === "remove" ? "删除这个任务？" : "关闭这个任务？"}</h3>
      <p>{confirm === "remove" ? "移除任务并停止后续安排，保留已有结果。正在处理的这一次会继续完成。" : "停止后续安排。正在处理的这一次会继续完成。"}</p>
      <div className="routine-row-actions"><button type="button" disabled={pending} onClick={() => { setConfirm(undefined); setError(""); }}>取消</button><button type="button" className={confirm === "remove" ? "routine-danger" : ""} disabled={pending} onClick={async () => {
        setPending(true); setError("");
        try { await (confirm === "remove" ? remove() : disable()); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "操作未完成，请重试"); }
        finally { setPending(false); }
      }}>{pending ? "处理中…" : confirm === "remove" ? "确认删除" : "确认关闭"}</button></div>
    </section> : <div className="routine-plan-actions routine-row-actions">
      {routine.enabled ? <button type="button" onClick={() => setConfirm("disable")}>关闭任务</button> : null}
      <button type="button" className="routine-danger" onClick={() => setConfirm("remove")}>删除任务</button>
    </div>}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
