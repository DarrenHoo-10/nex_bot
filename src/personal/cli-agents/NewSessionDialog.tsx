// Start a Claude or Codex session in a folder on one of the user's computers.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { isAbsoluteCwd, type CliDeviceView, type CliEngine, type CliSessionKey, type CliSessionView } from "../../../shared/cli-agents";
import { cliErrorText, startSession } from "./api";
import { deviceBlocker, ENGINE_LABEL, folderLabel, recentCwds } from "./session-model";

export interface NewSessionDialogProps {
  devices: readonly CliDeviceView[];
  sessions: readonly CliSessionView[];
  /** the computer the user was looking at */
  initialDeviceId?: string;
  onClose(): void;
  onStarted(key: CliSessionKey): void;
}

export function NewSessionDialog({ devices, sessions, initialDeviceId, onClose, onStarted }: NewSessionDialogProps) {
  const firstReady = devices.find((device) => !deviceBlocker(device));
  const [deviceId, setDeviceId] = useState(() => (initialDeviceId && devices.some((device) => device.id === initialDeviceId) ? initialDeviceId : firstReady?.id ?? devices[0]?.id ?? ""));
  const device = devices.find((entry) => entry.id === deviceId);
  const blocker = deviceBlocker(device);
  const engines = device?.cliAgents?.engines ?? [];
  const [engine, setEngine] = useState<CliEngine>("claude");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cwdRef = useRef<HTMLInputElement>(null);
  const recents = useMemo(() => recentCwds(sessions, deviceId), [sessions, deviceId]);

  useEffect(() => { cwdRef.current?.focus(); }, []);
  // the computer changed: keep an engine it can run
  useEffect(() => {
    if (engines.length && !engines.includes(engine)) setEngine(engines[0]);
  }, [engines, engine]);

  const path = cwd.trim();
  const pathInvalid = path !== "" && !isAbsoluteCwd(path);
  const canStart = !blocker && !!device && !!path && !pathInvalid && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    setBusy(true);
    setError("");
    try {
      const { key } = await startSession(deviceId, engine, path);
      onStarted(key);
    } catch (cause) {
      setError(cliErrorText(cause, "没能启动"));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <form className="modal cli-dialog" role="dialog" aria-modal="true" aria-label="新建 Agent 会话" onSubmit={(event) => void submit(event)}>
        <div className="modal-heading">
          <h2>新建会话</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
        </div>
        <label className="cli-field">
          <span>电脑</span>
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            {devices.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.online ? "" : "（离线）"}</option>)}
          </select>
        </label>
        {blocker ? <p className="cli-field-hint" role="status">{blocker}</p> : null}
        <div className="cli-field" role="group" aria-label="引擎">
          <span>引擎</span>
          <div className="cli-segment">
            {(engines.length ? engines : (["claude", "codex"] as const)).map((entry) => (
              <button key={entry} type="button" aria-pressed={engine === entry} disabled={!!blocker} onClick={() => setEngine(entry)}>{ENGINE_LABEL[entry]}</button>
            ))}
          </div>
        </div>
        <label className="cli-field">
          <span>工作目录</span>
          <input ref={cwdRef} value={cwd} placeholder="绝对路径" aria-invalid={pathInvalid} onChange={(event) => { setCwd(event.target.value); setError(""); }} />
        </label>
        {pathInvalid ? <p className="cli-field-hint" role="alert">需要绝对路径</p> : null}
        {recents.length ? (
          <div className="cli-recents" aria-label="最近目录">
            {recents.map((entry) => <button key={entry} type="button" title={entry} aria-pressed={entry === path} onClick={() => setCwd(entry)}>{folderLabel(entry)}</button>)}
          </div>
        ) : null}
        {error ? <p className="cli-field-hint" role="alert">{error}</p> : null}
        <div className="cli-dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={!canStart}>{busy ? "正在启动…" : "开始"}</button>
        </div>
      </form>
    </div>
  );
}
