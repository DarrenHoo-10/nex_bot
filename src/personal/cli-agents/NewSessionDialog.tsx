// Start a Claude or Codex session in a folder on one of the user's computers. The
// dialog only collects the choice: the workspace shows the session at once and
// starts it in the background (use-launches.ts).
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Check, ChevronDown, Folder, FolderOpen, History, SquareTerminal, X } from "lucide-react";
import { isAbsoluteCwd, MAX_SEND_TEXT, utf8ByteLength, type CliDeviceView, type CliEngine, type CliSessionView } from "../../../shared/cli-agents";
import {HarnessMark} from "./tokendance/HarnessMark";
import { LaunchDevicePicker } from "./LaunchDevicePicker";
import "./new-session-dialog.css";
import { useReview } from "./WorkbenchReview";
import { CliModelMenu, type LaunchChoice } from "./CliModelMenu";
import { deviceBlocker, AGENT_LABEL, folderLabel, recentCwds } from "./session-model";
import { randomBranch, type LaunchRequest } from "./use-launches";

/** What `git worktree add -b` and the device accept as a new branch name. */
export const BRANCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
export function branchProblem(branch: string): string | null {
  const name = branch.trim();
  if (!name) return "需要分支名称";
  if (name.length > 120 || !BRANCH_RE.test(name) || name.includes("..") || name.includes("//") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return "分支名称不合法";
  return null;
}

export interface NewSessionDialogProps {
  devices: readonly CliDeviceView[];
  sessions: readonly CliSessionView[];
  /** the computer the user was looking at */
  initialDeviceId?: string;
  initialCwd?: string;
  onClose(): void;
  /** the session to start; the dialog closes right after */
  onLaunch(request: LaunchRequest): void;
}

export function NewSessionDialog({ devices, sessions, initialDeviceId, initialCwd, onClose, onLaunch }: NewSessionDialogProps) {
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
  const [message,setMessage]=useState("");
  const [choice,setChoice]=useState<LaunchChoice>({model:"",effort:""});
  const imeEndedAt=useRef(0);
  const pathHintId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
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
  // another computer or tool has other models
  useEffect(() => { setChoice({model:"",effort:""}); }, [engine, deviceId]);

  const path = cwd.trim();
  const pathInvalid = path !== "" && !isAbsoluteCwd(path);
  const checkout=review?.checkouts?.[path];
  const worktrees=Object.values(review?.checkouts ?? {}).filter(tree=>checkout && tree.project===checkout.project);
  // the fixture lists existing trees; production builds a new one on the device
  const treeAvailable=review ? !!checkout && engine==="claude" : !!device && !blocker;
  const branchError = newTree ? branchProblem(branch) : null;
  const tooLong = utf8ByteLength(message.trim()) > MAX_SEND_TEXT;
  const features = device?.cliAgents?.features ?? [];
  const canChoose = !review && engine !== "zcode" && !!device && !blocker;
  const choiceOff = !features.includes("launchOptions");
  const canStart = (!newTree || (treeAvailable && !branchError)) && !blocker && !!device && engines.includes(engine) && !!path && !pathInvalid && !tooLong;

  function toggleTree(on: boolean) {
    setNewTree(on);
    setError("");
    if (on && !branch.trim()) setBranch(randomBranch());
  }

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canStart) {
      if (!path) setError("需要工作目录");
      return;
    }
    onLaunch({ deviceId, engine, cwd: path, ...(newTree ? { branch: branch.trim() } : {}), message: message.trim(), choice: canChoose && !choiceOff ? choice : { model: "", effort: "" } });
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
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)");
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <form ref={dialogRef} className="modal cli-dialog na-launch" role="dialog" aria-modal="true" aria-label="新建 Agent 会话" onSubmit={submit}>
        <header className="na-launch-head">
          <span className="na-launch-mark" aria-hidden="true"><SquareTerminal size={21}/></span>
          <h2>新建会话</h2>
          <button type="button" className="na-launch-close" aria-label="关闭" onClick={onClose}><X size={17}/></button>
        </header>
        <div className="na-launch-body">
          <LaunchDevicePicker devices={devices} value={deviceId} disabled={false} onChange={id => {
            setDeviceId(id);
            chooseDirectory("");
          }}/>
          {blocker ? <p className="cli-field-hint" role="status">{blocker}</p> : null}
          <div className="na-launch-directory">
            <label className="cli-field">
              <span>工作目录</span>
              <span className="na-launch-control na-launch-path" data-invalid={pathInvalid || undefined}><FolderOpen size={16}/>
                <input aria-label="工作目录" ref={cwdRef} value={cwd} placeholder="输入绝对路径" spellCheck={false} autoComplete="off"
                  aria-invalid={pathInvalid} aria-describedby={pathInvalid ? pathHintId : undefined} onChange={(event) => chooseDirectory(event.target.value)}/>
              </span>
            </label>
            {pathInvalid ? <p className="cli-field-hint" id={pathHintId} role="alert">需要绝对路径</p> : null}
            {recents.length ? <div className="cli-recents na-launch-recents" role="group" aria-label="最近目录">
              <span className="na-launch-caption"><History size={13}/>最近目录</span>
              <div>{recents.map(entry => {
                const name = folderLabel(entry);
                const duplicate = recents.some(other => other !== entry && folderLabel(other) === name);
                return <button key={entry} type="button" title={entry} aria-pressed={entry===path} onClick={()=>chooseDirectory(entry)}>
                  {entry===path?<Check size={13}/>:<Folder size={13}/>}<span>{duplicate?entry:name}</span>
                </button>;
              })}</div>
            </div> : null}
          </div>
            <div className="cli-field" role="group" aria-label="运行工具">
              <span>运行工具</span>
              {engines.length > 1 ?
                <div className="cli-segment na-launch-engines">{engines.map(entry => <button key={entry} type="button" disabled={!!blocker} aria-pressed={engine===entry} onClick={()=>setEngine(entry)}><HarnessMark agentId={entry} size="sm"/>{AGENT_LABEL[entry]}</button>)}</div>
                : <div className="na-launch-control na-launch-tool">{engines[0] && <HarnessMark agentId={engines[0]} size="sm"/>}{engines[0]?AGENT_LABEL[engines[0]]:"暂无可用工具"}</div>}
            </div>
          {(review?.checkouts || !blocker) && <div className="na-worktree-options">
            {worktrees.length>1 && !newTree && <label className="cli-field"><span>工作树</span>
              <span className="na-launch-control na-launch-device"><Folder size={16}/><select aria-label="工作树" value={path} onChange={e=>chooseDirectory(e.target.value)}>
                {worktrees.map(tree=><option key={tree.worktree} value={tree.worktree}>{tree.project===tree.worktree?"主工作树":folderLabel(tree.worktree)}</option>)}
              </select><ChevronDown size={14}/></span></label>}
            <label className="na-worktree-switch"><input type="checkbox" checked={newTree} disabled={!treeAvailable && !newTree} onChange={e=>toggleTree(e.target.checked)}/>新建独立工作树（worktree）</label>
            {newTree && <label className="cli-field"><span>分支名称</span><span className="na-launch-control na-launch-path" data-invalid={branchError ? true : undefined}><input aria-label="分支名称" aria-invalid={!!branchError} spellCheck={false} autoComplete="off" value={branch} onChange={e=>{setBranch(e.target.value);setError("")}}/></span></label>}
            {newTree && branchError ? <p className="cli-field-hint" role="alert">{branchError}</p> : null}
            {!newTree && checkout && <small>当前分支 · {checkout.branch}</small>}
            {!treeAvailable && <small>选择支持工作树的 Git 目录后可用</small>}
          </div>}
          <div className="cli-field na-launch-message">
            <span>第一条消息</span>
            <div className="na-launch-control na-launch-prompt">
              <textarea aria-label="第一条消息" rows={3} placeholder="要做什么？" value={message} disabled={!!blocker}
                onChange={e=>{setMessage(e.target.value);setError("")}}
                onCompositionEnd={()=>{imeEndedAt.current=Date.now()}}
                onKeyDown={e=>{
                  if(e.nativeEvent.isComposing || Date.now()-imeEndedAt.current<150)return;
                  if(e.key==="Enter" && !e.shiftKey){e.preventDefault();submit()}
                }}/>
              {canChoose ? <div className="na-launch-model"><CliModelMenu deviceId={deviceId} engine={engine} live={features.includes("models")} choice={choice} onChange={setChoice}
                disabled={choiceOff} note={choiceOff ? "电脑端版本过旧，升级后可用" : undefined}/></div> : null}
            </div>
            {tooLong ? <p className="cli-field-hint" role="alert">内容太长</p> : null}
          </div>
          {error ? <p className="cli-field-hint" role="alert">{error}</p> : null}
        </div>
        <footer className="cli-dialog-actions na-launch-foot">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={!canStart}>开始会话<ArrowUpRight size={15}/></button>
        </footer>
      </form>
    </div>
  );
}
