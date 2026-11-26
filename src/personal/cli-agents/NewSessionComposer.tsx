// A new session, started from the same message box every session has (attachments, goal mode, skills, model):
// three tabs sit in a row above it (the project, the CLI, and the session's options: worktree, branch and
// permissions), and sending starts the session with that message.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, PanelLeftOpen, ShieldAlert, ShieldCheck } from "lucide-react";
import { cliPermissionLabel, cliPermissionModes, type CliDeviceView, type CliEngine, type CliPermissionMode, type CliSessionKey, type CliSessionView } from "../../../shared/cli-agents";
import { useAnchoredPopover } from "../components/anchored-popover";
import type { LaunchChoice } from "./CliModelMenu";
import { Composer } from "./Composer";
import { DirectoryPicker, type DirectoryChoice } from "./DirectoryPicker";
import { HarnessPicker, STARTABLE } from "./HarnessPicker";
import type { DirectorySource } from "./directory-source";
import { deviceBlocker } from "./session-model";
import { branchProblem, randomBranch, type LaunchRequest } from "./use-launches";
import { BrandMark } from "../components/BrandMark";

export type NewSessionRequest = LaunchRequest;

export interface NewSessionComposerProps {
  devices: readonly CliDeviceView[];
  initialDeviceId?: string;
  initialCwd?: string;
  /** recent folders per computer, newest first */
  recents(deviceId: string): readonly string[];
  source(deviceId: string): DirectorySource;
  onLaunch(request: NewSessionRequest): void;
  /** Narrow screens show the full-width session directory. */
  onShowDirectory(): void;
}

export function NewSessionComposer({ devices, initialDeviceId, initialCwd, recents, source, onLaunch, onShowDirectory }: NewSessionComposerProps) {
  const defaultDevice = devices.find((entry) => entry.id === initialDeviceId)
    ?? devices.find((entry) => !deviceBlocker(entry))
    ?? devices.find((entry) => entry.online)
    ?? devices[0];
  const [selectedDeviceId, setDeviceId] = useState(() => defaultDevice?.id ?? "");
  const deviceId = selectedDeviceId || defaultDevice?.id || "";
  const device = devices.find((entry) => entry.id === deviceId);
  const engines = useMemo(() => STARTABLE.filter((engine) => device?.cliAgents?.engines.includes(engine) && !deviceBlocker(device, engine)), [device]);
  const [engine, setEngine] = useState<CliEngine>(engines[0] ?? "claude");
  // The draft belongs to this form while the device list and tool capabilities load.
  const [draftKey] = useState(() => `${deviceId || "none"}:${engine}:new-session` as CliSessionKey);
  const blocker = deviceBlocker(device, engine);
  const recent = useMemo(() => recents(deviceId), [recents, deviceId]);
  const defaultPath = (initialDeviceId && initialDeviceId !== deviceId ? undefined : initialCwd) ?? recent[0];
  const [dir, setDir] = useState<DirectoryChoice | null>(() => deviceId && defaultPath ? { path: defaultPath, create: false } : null);
  const [git, setGit] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [choice, setChoice] = useState<LaunchChoice>({ model: "", effort: "" });
  // each CLI keeps its own choice: full access by default, Antigravity asking (its full access is answered by the executor)
  const [modeOf, setModeOf] = useState<Partial<Record<CliEngine, CliPermissionMode>>>({});

  useEffect(() => {
    if (selectedDeviceId || !deviceId) return;
    setDeviceId(deviceId);
    if (defaultPath) setDir((picked) => picked ?? { path: defaultPath, create: false });
  }, [selectedDeviceId, deviceId, defaultPath]);
  useEffect(() => { if (engines.length && !engines.includes(engine)) setEngine(engines[0]); }, [engines, engine]);
  useEffect(() => { setChoice({ model: "", effort: "" }); }, [engine, deviceId]);
  // a worktree needs a Git folder that exists
  useEffect(() => {
    let live = true;
    if (!dir || dir.create) { setGit(false); setBranch(null); return; }
    source(deviceId).list(dir.path).then((listing) => { if (live) { setGit(!!listing.git); if (!listing.git) setBranch(null); } }).catch(() => undefined);
    return () => { live = false; };
  }, [dir, deviceId, source]);

  const features = device?.cliAgents?.features ?? [];
  const permissionModes = cliPermissionModes(engine, features);
  const preferred = modeOf[engine] ?? (engine === "agy" ? "ask" : "full");
  const selectedPermissions = permissionModes.includes(preferred) ? preferred : permissionModes.includes("full") ? "full" : permissionModes[0];
  const canChoosePermissions = permissionModes.length > 0;
  const branchError = branch !== null ? branchProblem(branch) : null;
  const ready = !blocker && !!device && engines.includes(engine) && !!dir && !branchError;
  // the box below is the session's own message box: it only needs the computer, CLI and folder
  const draft: CliSessionView = useMemo(() => ({
    key: draftKey, deviceId, engine, nativeId: "new-session", configDir: "", cwd: dir?.path ?? "",
    title: "", state: "idle", lastActivityAt: 0, hidden: false, online: !!device?.online,
  }), [draftKey, deviceId, engine, dir?.path, device?.online]);

  const start = (message: string, files: File[]) => {
    if (!dir || !ready) return;
    onLaunch({
      deviceId, engine, cwd: dir.path, message, files, attach: features.includes("attach"),
      ...(dir.create ? { createDir: true } : {}), ...(branch !== null ? { branch: branch.trim() } : {}),
      choice: features.includes("launchOptions") ? choice : { model: "", effort: "" },
      ...(canChoosePermissions ? { permissions: selectedPermissions } : {}),
    });
  };

  const status = deviceId ? blocker ?? branchError ?? (dir ? null : "先选择工作目录") : "等待电脑连接";
  // A phone's keyboard shrinks the page while the box is in use: the box stays in view at the bottom, and the
  // brand and chips go up with it under the header
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (element.contains(document.activeElement)) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <section className="cli-pane na-new" aria-label="新建会话" data-testid="cli-new-session">
      <header className="cli-pane-head">
        <button type="button" className="icon-button cli-back" aria-label="打开会话目录" onClick={onShowDirectory}><PanelLeftOpen size={19}/></button>
        <div className="cli-pane-title"><strong>新建会话</strong></div>
      </header>
      <div className="na-new-body" ref={body}>
        <div className="na-new-stack">
          <div className="na-new-hero">
            <BrandMark agent size={38}/>
            <h2>NexAgent</h2>
          </div>
          <div className="na-new-options" role="group" aria-label="会话设置">
            <DirectoryPicker devices={devices} disabled={!deviceId}
              deviceId={deviceId} onDevice={(id) => { setDeviceId(id); setDir(null); }} value={dir} onChange={setDir}
              source={source} recents={recent}/>
            <HarnessPicker engines={engines} value={engine} onChange={setEngine} disabled={!device?.online || !device.cliAgents} agyNeedsUpdate={device?.cliAgents?.agyNeedsUpdate}/>
            <SessionOptions git={git} branch={branch} onBranch={setBranch} problem={branchError}
              engine={engine} modes={permissionModes} permissions={canChoosePermissions ? selectedPermissions : undefined}
              onPermissions={(mode) => setModeOf((current) => ({ ...current, [engine]: mode }))}/>
          </div>
          {/* only what needs attention; the folder's full path is on its chip */}
          {status ? <span className="na-new-path" role="alert">{status}</span> : null}
          <Composer key={draft.key} session={draft} features={features} launch={choice} onLaunch={setChoice}
            starter={{ ready, onStart: start }} onSend={async () => undefined} onInterrupt={async () => undefined}/>
        </div>
      </div>
    </section>
  );
}

/** The third tab: how the session runs. It opens a panel with the worktree switch (a Git folder only; on, the
 * session starts in a new worktree on `nexagent/<random>`, renamable below it) and, where the CLI supports it,
 * permissions: the CLI's own modes, full access by default; any other mode asks for some actions, as request cards. */
function SessionOptions({ git, branch, onBranch, problem, engine, modes, permissions, onPermissions }: {
  git: boolean; branch: string | null; onBranch(next: string | null): void; problem: string | null;
  engine: CliEngine; modes: readonly CliPermissionMode[]; permissions?: CliPermissionMode; onPermissions(next: CliPermissionMode): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(open, panel, () => trigger.current, () => [root.current], () => setOpen(false), 280);
  const on = branch !== null;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div className="model-menu-root" ref={root}>
    <button ref={trigger} type="button" className="na-pick-chip na-options-chip" data-on={on || undefined} data-invalid={problem ? true : undefined}
      aria-label="会话选项" aria-haspopup="dialog" aria-expanded={open} title={on ? branch || "Worktree" : "Worktree 与权限"} onClick={() => setOpen(!open)}>
      {/* a branch icon while the session runs in the folder itself; "Worktree" once it gets its own */}
      <GitBranch size={15}/>{on ? <span>Worktree</span> : null}
      {permissions && permissions !== "full" ? <ShieldAlert size={13} className="na-options-ask" aria-label={cliPermissionLabel(engine, permissions)}/> : null}<ChevronDown size={13}/>
    </button>
    {open && <div ref={panel} popover="manual" className="model-menu na-model-menu na-options-menu" role="dialog" aria-label="会话选项"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <label className="na-option-row" data-disabled={!git || undefined}>
        <span className="na-option-text"><b>Worktree</b>{git ? null : <small>不是 Git 仓库</small>}</span>
        <input type="checkbox" role="switch" className="na-switch" checked={on} disabled={!git} onChange={(event) => onBranch(event.target.checked ? randomBranch() : null)}/>
      </label>
      {on ? <label className="na-option-field"><span>分支</span>
        <span className="model-menu-search"><GitBranch size={14}/><input aria-label="新分支名称" value={branch} spellCheck={false} autoComplete="off"
          onChange={(event) => onBranch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); close(); } }}/></span>
      </label> : null}
      {problem ? <div className="model-menu-status" role="alert">{problem}</div> : null}
      {permissions ? <div className="na-option-field"><span>权限</span>
        <div className="na-option-modes" role="radiogroup" aria-label="权限">
          {modes.map((mode) => <button key={mode} type="button" role="radio" aria-checked={permissions === mode} onClick={() => onPermissions(mode)}>
            {mode === "full" ? <ShieldCheck size={14}/> : <ShieldAlert size={14}/>}<span>{cliPermissionLabel(engine, mode)}</span>{permissions === mode ? <Check size={14}/> : null}
          </button>)}
        </div>
      </div> : null}
    </div>}
  </div>;
}
