// A new session, started from the same message box every session has (attachments, goal mode, skills, model):
// the folder, CLI and worktree sit in a row above it, and sending starts the session with that message.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, GitBranch } from "lucide-react";
import type { CliDeviceView, CliEngine, CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { useAnchoredPopover } from "../components/anchored-popover";
import type { LaunchChoice } from "./CliModelMenu";
import { Composer } from "./Composer";
import { DirectoryPicker, type DirectoryChoice } from "./DirectoryPicker";
import { HarnessPicker } from "./HarnessPicker";
import type { DirectorySource } from "./directory-source";
import { deviceBlocker } from "./session-model";
import { branchProblem, randomBranch, type LaunchRequest } from "./use-launches";
import "./new-session-composer.css";

export type NewSessionRequest = LaunchRequest;

export interface NewSessionComposerProps {
  devices: readonly CliDeviceView[];
  initialDeviceId?: string;
  initialCwd?: string;
  /** recent folders per computer, newest first */
  recents(deviceId: string): readonly string[];
  source(deviceId: string): DirectorySource;
  onLaunch(request: NewSessionRequest): void;
  /** narrow screens: back to the session list */
  onBack?(): void;
}

export function NewSessionComposer({ devices, initialDeviceId, initialCwd, recents, source, onLaunch, onBack }: NewSessionComposerProps) {
  const firstReady = devices.find((device) => !deviceBlocker(device));
  const [deviceId, setDeviceId] = useState(() => (initialDeviceId && devices.some((device) => device.id === initialDeviceId) ? initialDeviceId : firstReady?.id ?? devices[0]?.id ?? ""));
  const device = devices.find((entry) => entry.id === deviceId);
  const blocker = deviceBlocker(device);
  const engines = device?.cliAgents?.engines ?? [];
  const [engine, setEngine] = useState<CliEngine>(engines[0] ?? "claude");
  const recent = useMemo(() => recents(deviceId), [recents, deviceId]);
  const [dir, setDir] = useState<DirectoryChoice | null>(() => (initialCwd ? { path: initialCwd, create: false } : recent[0] ? { path: recent[0], create: false } : null));
  const [git, setGit] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [choice, setChoice] = useState<LaunchChoice>({ model: "", effort: "" });

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
  const branchError = branch !== null ? branchProblem(branch) : null;
  const ready = !blocker && !!device && engines.includes(engine) && !!dir && !branchError;
  // the box below is the session's own message box: it only needs the computer, CLI and folder
  const draft: CliSessionView = useMemo(() => ({
    key: `${deviceId || "none"}:${engine}:new-session` as CliSessionKey, deviceId, engine, nativeId: "new-session", configDir: "", cwd: dir?.path ?? "",
    title: "", state: "idle", lastActivityAt: 0, hidden: false, online: !!device?.online,
  }), [deviceId, engine, dir?.path, device?.online]);

  const start = (message: string, files: File[]) => {
    if (!dir || !ready) return;
    onLaunch({
      deviceId, engine, cwd: dir.path, message, files, attach: features.includes("attach"),
      ...(dir.create ? { createDir: true } : {}), ...(branch !== null ? { branch: branch.trim() } : {}),
      choice: features.includes("launchOptions") ? choice : { model: "", effort: "" },
    });
  };

  const status = blocker ?? branchError ?? (dir ? null : "先选择工作目录");
  return (
    <section className="cli-pane na-new" aria-label="新建会话" data-testid="cli-new-session">
      <header className="cli-pane-head">
        {onBack ? <button type="button" className="icon-button cli-back" aria-label="返回会话列表" onClick={onBack}><ArrowLeft size={18}/></button> : null}
        <div className="cli-pane-title"><strong>新建会话</strong></div>
      </header>
      <div className="na-new-body">
        <div className="na-new-stack">
          <div className="na-new-options" role="group" aria-label="会话设置">
            <DirectoryPicker devices={devices.map((entry) => ({ id: entry.id, name: entry.name, online: entry.online && !deviceBlocker(entry) }))}
              deviceId={deviceId} onDevice={(id) => { setDeviceId(id); setDir(null); }} value={dir} onChange={setDir}
              source={source} recents={recent}/>
            <HarnessPicker engines={engines} value={engine} onChange={setEngine} disabled={!!blocker}/>
            {git ? <BranchChip branch={branch} onChange={setBranch} problem={branchError}/> : null}
            {/* only what needs attention; the folder's full path is on its chip */}
            {status ? <span className="na-new-path" role="alert">{status}</span> : null}
          </div>
          <Composer key={draft.key} session={draft} features={features} launch={choice} onLaunch={setChoice}
            starter={{ ready, onStart: start }} onSend={async () => undefined} onInterrupt={async () => undefined}/>
        </div>
      </div>
    </section>
  );
}

/** A new worktree for the session: a "Worktree" checkbox, off by default. Checked, the session starts in a new
 * worktree on `nexagent/<random>`; the branch shows beside it and opens to be renamed. */
function BranchChip({ branch, onChange, problem }: { branch: string | null; onChange(next: string | null): void; problem: string | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(open, panel, () => trigger.current, () => [root.current], () => setOpen(false), 300);
  const on = branch !== null;
  return <div className="model-menu-root" ref={root}>
    <span className="na-pick-chip na-branch-chip" data-on={on || undefined} data-invalid={problem ? true : undefined}>
      <label className="na-worktree-check" title="在新的工作树里运行">
        <input type="checkbox" checked={on} onChange={(event) => { if (event.target.checked) onChange(randomBranch()); else { onChange(null); setOpen(false); } }}/>
        <span>Worktree</span>
      </label>
      {on ? <button ref={trigger} type="button" aria-label="分支名称" aria-expanded={open} onClick={() => setOpen(!open)}><GitBranch size={13}/><span>{branch || "分支"}</span></button> : null}
    </span>
    {open && on && <div ref={panel} popover="manual" className="model-menu na-model-menu na-branch-menu" role="dialog" aria-label="新工作树"
      onKeyDown={(event) => { if (event.key === "Escape" || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <div className="na-model-head"><span>新工作树的分支</span></div>
      <label className="model-menu-search"><GitBranch size={14}/><input autoFocus aria-label="新分支名称" value={branch} spellCheck={false} autoComplete="off" onChange={(event) => onChange(event.target.value)}/></label>
      {problem ? <div className="model-menu-status" role="alert">{problem}</div> : null}
    </div>}
  </div>;
}
