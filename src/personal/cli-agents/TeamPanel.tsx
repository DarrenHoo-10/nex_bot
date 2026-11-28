// Floating collaboration ("协作") panel anchored to the lead session header.
import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Pause, Play, Square, XCircle } from "lucide-react";
import { cliPermissionLabel, type CliSessionKey } from "../../../shared/cli-agents";
import { userErrorText } from "../../lib/http-errors";
import { HarnessMark } from "./tokendance/HarnessMark";
import {
  isRunLive,
  isWorkerLive,
  TEAM_RUN_STATUS_LABEL,
  TEAM_WORKER_STATUS_LABEL,
  type CliTeamRunView,
  type CliTeamWorkerView,
} from "./team";

export interface TeamPanelProps {
  runs: readonly CliTeamRunView[];
  selectedKey: CliSessionKey;
  onOpenSession(key: CliSessionKey): void;
  onPause(runId: string): Promise<void>;
  onResume(runId: string): Promise<void>;
  onCancel(runId: string): Promise<void>;
  onStopWorker(runId: string, workerName: string): Promise<void>;
}

function workerTone(status: CliTeamWorkerView["status"]): string {
  switch (status) {
    case "starting":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "reported":
      return "reported";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

function contextPercent(worker: CliTeamWorkerView): string | null {
  if (!worker.context?.window) return null;
  const pct = Math.min(100, Math.round((worker.context.used / worker.context.window) * 100));
  return `${pct}%`;
}

function WorkerRow({
  worker,
  runId,
  selectedKey,
  allowStop,
  busyKey,
  onOpen,
  onStop,
}: {
  worker: CliTeamWorkerView;
  runId: string;
  selectedKey: CliSessionKey;
  allowStop: boolean;
  busyKey: string | null;
  onOpen(key: CliSessionKey): void;
  onStop(runId: string, name: string): void;
}) {
  const tone = workerTone(worker.status);
  const ctx = contextPercent(worker);
  const canStop = allowStop && isWorkerLive(worker.status);
  const stopping = busyKey === `stop:${runId}:${worker.name}`;
  const permLabel = cliPermissionLabel(worker.engine, worker.permissions);
  return (
    <div className="na-team-worker-item" data-active={worker.sessionKey === selectedKey ? "1" : undefined}>
      <button
        type="button"
        className="na-team-worker-open"
        disabled={!worker.sessionKey}
        onClick={() => { if (worker.sessionKey) onOpen(worker.sessionKey); }}
      >
        <span className="na-team-worker-avatar">
          <span className={`na-engine ${worker.engine}`} data-tone={tone}>
            <HarnessMark agentId={worker.engine} size="sm" />
          </span>
        </span>
        <span className="na-team-worker-body">
          <span className="na-team-worker-top">
            <strong title={worker.title}>{worker.title}</strong>
            <span className="na-team-status" data-tone={tone}>{TEAM_WORKER_STATUS_LABEL[worker.status]}</span>
          </span>
          <span className="na-team-worker-meta">
            {worker.role ? <><span>{worker.role}</span><span className="na-team-meta-sep" aria-hidden="true">·</span></> : null}
            <span className={worker.permissions === "readonly" ? "na-team-perm-readonly" : undefined}>{permLabel}</span>
            <span className="na-team-meta-sep" aria-hidden="true">·</span>
            <code>{worker.name}</code>
            {worker.findingsCount ? <><span className="na-team-meta-sep" aria-hidden="true">·</span><span>{worker.findingsCount} 个问题</span></> : null}
            {ctx ? <><span className="na-team-meta-sep" aria-hidden="true">·</span><span>{ctx}</span></> : null}
          </span>
        </span>
      </button>
      <div className="na-team-worker-slot">
        {canStop ? (
          <button
            type="button"
            className="na-team-worker-stop"
            disabled={!!busyKey}
            aria-label={`停止 ${worker.title}`}
            title={stopping ? "停止中…" : "停止工人"}
            onClick={() => onStop(runId, worker.name)}
          >
            <Square size={11} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <ChevronRight size={14} className="na-team-worker-chevron" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

export function TeamPanel({
  runs,
  selectedKey,
  onOpenSession,
  onPause,
  onResume,
  onCancel,
  onStopWorker,
}: TeamPanelProps) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState("");

  const activeRun = runs.find((run) => isRunLive(run.status));
  const historyRuns = runs.filter((run) => run.id !== activeRun?.id);

  async function runAction(key: string, fn: () => Promise<void>) {
    setBusyKey(key);
    setError("");
    try {
      await fn();
      setConfirmCancel(false);
    } catch (cause) {
      setError(userErrorText(cause, "操作失败"));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <aside className="na-info" aria-label="协作概览">
      <section className="na-team-panel">
        {activeRun ? (
          <>
            <header className="na-team-panel-head">
              <div className="na-team-panel-title">
                <strong title={activeRun.title}>{activeRun.title}</strong>
                <small>工人 {activeRun.workers.length}/{activeRun.limit}</small>
              </div>
              <span className="na-team-status" data-tone={activeRun.status === "paused" ? "paused" : "running"}>
                {TEAM_RUN_STATUS_LABEL[activeRun.status]}
              </span>
            </header>

            {activeRun.limitHit ? (
              <div className="na-team-panel-alert" role="status">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{activeRun.limitHit}</span>
              </div>
            ) : null}

            {activeRun.heldCount ? (
              <div className="na-team-panel-alert" role="status">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{activeRun.heldCount} 条协作消息待投递</span>
              </div>
            ) : null}

            {error ? <div className="na-team-panel-error" role="alert">{error}</div> : null}

            <div className="na-team-worker-list">
              {activeRun.workers.map((worker) => (
                <WorkerRow
                  key={worker.id}
                  worker={worker}
                  runId={activeRun.id}
                  selectedKey={selectedKey}
                  allowStop
                  busyKey={busyKey}
                  onOpen={onOpenSession}
                  onStop={(runId, name) => void runAction(`stop:${runId}:${name}`, () => onStopWorker(runId, name))}
                />
              ))}
            </div>

            <footer className="na-team-panel-actions" data-confirm={confirmCancel ? "1" : undefined}>
              {confirmCancel ? (
                <>
                  <span className="na-team-confirm-copy">结束当前协作？</span>
                  <button type="button" disabled={!!busyKey} onClick={() => setConfirmCancel(false)}>取消</button>
                  <button
                    type="button"
                    className="is-danger-confirm"
                    disabled={!!busyKey}
                    onClick={() => void runAction(`cancel:${activeRun.id}`, () => onCancel(activeRun.id))}
                  >
                    {busyKey === `cancel:${activeRun.id}` ? "结束中…" : "确认结束"}
                  </button>
                </>
              ) : (
                <>
                  {activeRun.status === "paused" ? (
                    <button
                      type="button"
                      disabled={!!busyKey}
                      onClick={() => void runAction(`resume:${activeRun.id}`, () => onResume(activeRun.id))}
                    >
                      <Play size={13} />
                      {busyKey === `resume:${activeRun.id}` ? "恢复中…" : "恢复协作"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!!busyKey}
                      onClick={() => void runAction(`pause:${activeRun.id}`, () => onPause(activeRun.id))}
                    >
                      <Pause size={13} />
                      {busyKey === `pause:${activeRun.id}` ? "暂停中…" : "暂停协作"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="is-danger"
                    disabled={!!busyKey}
                    onClick={() => setConfirmCancel(true)}
                  >
                    <XCircle size={13} />
                    结束协作
                  </button>
                </>
              )}
            </footer>
          </>
        ) : (
          <header className="na-team-panel-head">
            <div className="na-team-panel-title">
              <strong>历史协作</strong>
              <small>共 {historyRuns.length} 次</small>
            </div>
          </header>
        )}

        {historyRuns.length ? (
          activeRun ? (
            <details className="na-team-history-block">
              <summary>
                <span>历史协作</span>
                <small>{historyRuns.length} 次</small>
                <ChevronDown size={13} />
              </summary>
              <div className="na-team-history-runs">
                {historyRuns.map((run) => (
                  <div key={run.id} className="na-team-history-run">
                    <div className="na-team-history-run-head">
                      <strong title={run.title}>{run.title}</strong>
                      <span className="na-team-status" data-tone={run.status === "finished" ? "reported" : "stopped"}>
                        {TEAM_RUN_STATUS_LABEL[run.status]}
                      </span>
                    </div>
                    {run.summary ? <p className="na-team-history-summary">{run.summary}</p> : null}
                    <div className="na-team-worker-list">
                      {run.workers.map((worker) => (
                        <WorkerRow
                          key={worker.id}
                          worker={worker}
                          runId={run.id}
                          selectedKey={selectedKey}
                          allowStop={false}
                          busyKey={busyKey}
                          onOpen={onOpenSession}
                          onStop={() => undefined}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ) : (
            <div className="na-team-history-runs">
              {historyRuns.map((run) => (
                <div key={run.id} className="na-team-history-run">
                  <div className="na-team-history-run-head">
                    <strong title={run.title}>{run.title}</strong>
                    <span className="na-team-status" data-tone={run.status === "finished" ? "reported" : "stopped"}>
                      {TEAM_RUN_STATUS_LABEL[run.status]}
                    </span>
                  </div>
                  {run.summary ? <p className="na-team-history-summary">{run.summary}</p> : null}
                  <div className="na-team-worker-list">
                    {run.workers.map((worker) => (
                      <WorkerRow
                        key={worker.id}
                        worker={worker}
                        runId={run.id}
                        selectedKey={selectedKey}
                        allowStop={false}
                        busyKey={busyKey}
                        onOpen={onOpenSession}
                        onStop={() => undefined}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : null}
      </section>
    </aside>
  );
}
