// Start a Claude or Codex session in a folder on one of the user's computers.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Check, ChevronDown, Folder, FolderOpen, History, SquareTerminal, X } from "lucide-react";
import { isAbsoluteCwd, type CliDeviceView, type CliEngine, type CliSessionKey, type CliSessionView } from "../../../shared/cli-agents";
import {HarnessMark} from "./tokendance/HarnessMark";
import { LaunchDevicePicker } from "./LaunchDevicePicker";
import "./new-session-dialog.css";
import { useReview } from "./WorkbenchReview";
import { cliErrorText, startSession } from "./api";
import { deviceBlocker, AGENT_LABEL, folderLabel, recentCwds } from "./session-model";

export interface NewSessionDialogProps {
  devices: readonly CliDeviceView[];
  sessions: readonly CliSessionView[];
  /** the computer the user was looking at */
  initialDeviceId?: string;
  initialCwd?: string;
  onClose(): void;
  onStarted(key: CliSessionKey): void;
}

export function NewSessionDialog({ devices, sessions, initialDeviceId, initialCwd, onClose, onStarted }: NewSessionDialogProps) {
  const firstReady = devices.find((device) => !deviceBlocker(device));
  const [deviceId, setDeviceId] = useState(() => (initialDeviceId && devices.some((device) => device.id === initialDeviceId) ? initialDeviceId : firstReady?.id ?? devices[0]?.id ?? ""));
  const device = devices.find((entry) => entry.id === deviceId);
  const blocker = deviceBlocker(device);
  const engines = device?.cliAgents?.engines ?? [];
  const [engine, setEngine] = useState<CliEngine>("claude");
  const [cwd, setCwd] = useState(() => deviceId === initialDeviceId && isAbsoluteCwd(initialCwd) ? initialCwd : "");
  const review=useReview();
  const [newTree,setNewTree]=useState(false);
  const [branch,setBranch]=useState("");
  const attempt=useRef<{choice:string;id:string}|null>(null);
  const pathHintId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cwdRef = useRef<HTMLInputElement>(null);
  const recents = useMemo(() => recentCwds(sessions, deviceId), [sessions, deviceId]);

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cwdRef.current?.focus();
    const input = cwdRef.current;
    if (input?.value) input.setSelectionRange(input.value.length, input.value.length);
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);
  // the computer changed: keep an engine it can run
  useEffect(() => {
    if (engines.length && !engines.includes(engine)) setEngine(engines[0]);
  }, [engines, engine]);

  const path = cwd.trim();
  const pathInvalid = path !== "" && !isAbsoluteCwd(path);
  const checkout=review?.checkouts?.[path];
  const worktrees=Object.values(review?.checkouts ?? {}).filter(tree=>checkout && tree.project===checkout.project);
  // the fixture lists existing trees; production builds a new one on the device
  const treeAvailable=review ? !!checkout && engine==="claude" : !!device && !blocker;
  const canStart = (!newTree || (treeAvailable && !!branch.trim())) && !blocker && !!device && engines.includes(engine) && !!path && !pathInvalid && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    setBusy(true);
    setError("");
    try {
      if(newTree && review) {
        const choice=JSON.stringify([deviceId,engine,path,branch.trim()]);
        if(attempt.current?.choice!==choice)attempt.current={choice,id:crypto.randomUUID()};
        const key=await review.run("worktree-start",review.initial,{deviceId,engine,cwd:path,branch:branch.trim(),requestId:attempt.current.id});
        if(!key)throw Error("未取得新会话");
        onStarted(key);
      } else if(newTree) {
        // production: Core asks the device to build the worktree, then the CLI
        // runs inside it; a retry with the same requestId reuses the tree
        const choice=JSON.stringify([deviceId,engine,path,branch.trim()]);
        if(attempt.current?.choice!==choice)attempt.current={choice,id:crypto.randomUUID()};
        const {key}=await startSession(deviceId,engine,path,{worktreeBranch:branch.trim(),requestId:attempt.current.id});
        onStarted(key);
      } else {
        const {key}=await startSession(deviceId,engine,path);
        onStarted(key);
      }
    } catch (cause) {
      setError(cliErrorText(cause, "没能启动"));
      setBusy(false);
    }
  };

  useEffect(() => {
    const input = cwdRef.current;
    if (input && cwd && input !== document.activeElement) input.scrollLeft = input.scrollWidth;
  }, [cwd]);

  function chooseDirectory(value: string) {
    setCwd(value);
    setError("");
  }

  return (
    <div className="modal-backdrop na-launch-backdrop" onKeyDown={(event) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)");
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <form ref={dialogRef} className="modal cli-dialog na-launch" role="dialog" aria-modal="true" aria-label="新建 Agent 会话" aria-busy={busy} onSubmit={(event) => void submit(event)}>
        <header className="na-launch-head">
          <span className="na-launch-mark" aria-hidden="true"><SquareTerminal size={21}/></span>
          <h2>新建会话</h2>
          <button type="button" className="na-launch-close" aria-label="关闭" disabled={busy} onClick={onClose}><X size={17}/></button>
        </header>
        <div className="na-launch-body">
          <LaunchDevicePicker devices={devices} value={deviceId} disabled={busy} onChange={id => {
            setDeviceId(id);
            chooseDirectory("");
          }}/>
          {blocker ? <p className="cli-field-hint" role="status">{blocker}</p> : null}
          <div className="na-launch-directory">
            <label className="cli-field">
              <span>工作目录</span>
              <span className="na-launch-control na-launch-path" data-invalid={pathInvalid || undefined}><FolderOpen size={16}/>
                <input aria-label="工作目录" ref={cwdRef} value={cwd} placeholder="输入绝对路径" spellCheck={false} autoComplete="off" disabled={busy}
                  aria-invalid={pathInvalid} aria-describedby={pathInvalid ? pathHintId : undefined} onChange={(event) => chooseDirectory(event.target.value)}/>
              </span>
            </label>
            {pathInvalid ? <p className="cli-field-hint" id={pathHintId} role="alert">需要绝对路径</p> : null}
            {recents.length ? <div className="cli-recents na-launch-recents" role="group" aria-label="最近目录">
              <span className="na-launch-caption"><History size={13}/>最近目录</span>
              <div>{recents.map(entry => {
                const name = folderLabel(entry);
                const duplicate = recents.some(other => other !== entry && folderLabel(other) === name);
                return <button key={entry} type="button" title={entry} aria-pressed={entry===path} disabled={busy} onClick={()=>chooseDirectory(entry)}>
                  {entry===path?<Check size={13}/>:<Folder size={13}/>}<span>{duplicate?entry:name}</span>
                </button>;
              })}</div>
            </div> : null}
          </div>
            <div className="cli-field" role="group" aria-label="运行工具">
              <span>运行工具</span>
              {engines.length > 1 ?
                <div className="cli-segment na-launch-engines">{engines.map(entry => <button key={entry} type="button" disabled={busy || !!blocker} aria-pressed={engine===entry} onClick={()=>setEngine(entry)}><HarnessMark agentId={entry} size="sm"/>{AGENT_LABEL[entry]}</button>)}</div>
                : <div className="na-launch-control na-launch-tool">{engines[0] && <HarnessMark agentId={engines[0]} size="sm"/>}{engines[0]?AGENT_LABEL[engines[0]]:"暂无可用工具"}</div>}
            </div>
          {(review?.checkouts || !blocker) && <div className="na-worktree-options">
            {worktrees.length>1 && !newTree && <label className="cli-field"><span>工作树</span>
              <span className="na-launch-control na-launch-device"><Folder size={16}/><select aria-label="工作树" value={path} disabled={busy} onChange={e=>chooseDirectory(e.target.value)}>
                {worktrees.map(tree=><option key={tree.worktree} value={tree.worktree}>{tree.project===tree.worktree?"主工作树":folderLabel(tree.worktree)}</option>)}
              </select><ChevronDown size={14}/></span></label>}
            <label className="na-worktree-switch"><input type="checkbox" checked={newTree} disabled={busy || (!treeAvailable && !newTree)} onChange={e=>{setNewTree(e.target.checked);setError("")}}/>新建独立工作树（worktree）</label>
            {newTree && <label className="cli-field"><span>新分支名称</span><span className="na-launch-control na-launch-path"><input aria-label="新分支名称" placeholder="例如 feature/chat" spellCheck={false} value={branch} disabled={busy} onChange={e=>{setBranch(e.target.value);setError("")}}/></span></label>}
            {!newTree && checkout && <small>当前分支 · {checkout.branch}</small>}
            {!treeAvailable && <small>选择支持工作树的 Git 目录后可用</small>}
            {!review && !newTree && <small>勾选后将在设备上为这个 Git 目录新建独立工作树</small>}
          </div>}
          {error ? <p className="cli-field-hint" role="alert">{error}</p> : null}
        </div>
        <footer className="cli-dialog-actions na-launch-foot">
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={!canStart}>{busy ? "正在启动…" : "开始会话"}<ArrowUpRight size={15}/></button>
        </footer>
      </form>
    </div>
  );
}
