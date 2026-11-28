// A new session, started from the same message box every session has (attachments, goal mode, skills, model):
// three tabs sit in a row above it (the project, the CLI, and the session's options: worktree, branch and
// permissions), and sending starts the session with that message.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, PanelLeftOpen, Search, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { cliPermissionLabel, cliPermissionModes, type CliDeviceView, type CliEngine, type CliGitBranches, type CliPermissionMode, type CliSessionKey, type CliSessionView } from "../../../shared/cli-agents";
import { useAnchoredPopover } from "../components/anchored-popover";
import { useCompactComposer } from "../components/use-compact-composer";
import { fetchBranches } from "./api";
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
  const [branchInfo, setBranchInfo] = useState<CliGitBranches | null>(null);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [choice, setChoice] = useState<LaunchChoice>({ model: "", effort: "" });
  // each CLI keeps its own choice: full access by default, Antigravity asking (its full access is answered by the executor)
  const [modeOf, setModeOf] = useState<Partial<Record<CliEngine, CliPermissionMode>>>({});

  const features = device?.cliAgents?.features ?? [];
  const canPickBranch = features.includes("gitBranch");

  useEffect(() => {
    if (selectedDeviceId || !deviceId) return;
    setDeviceId(deviceId);
    if (defaultPath) setDir((picked) => picked ?? { path: defaultPath, create: false });
  }, [selectedDeviceId, deviceId, defaultPath]);
  useEffect(() => { if (engines.length && !engines.includes(engine)) setEngine(engines[0]); }, [engines, engine]);
  useEffect(() => { setChoice({ model: "", effort: "" }); }, [engine, deviceId]);
  // a worktree or branch switch needs a Git folder that exists
  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    setBranchInfo(null);
    setSelectedBranch("");
    setBaseBranch("");
    if (!dir || dir.create) { setGit(false); setBranch(null); return () => { live = false; abort.abort(); }; }
    let listingGit: boolean | null = null;
    source(deviceId).list(dir.path).then((listing) => {
      if (!live) return;
      listingGit = !!listing.git;
      if (listing.git) setGit(true);
      else if (!canPickBranch) { setGit(false); setBranch(null); }
    }).catch(() => undefined);
    if (canPickBranch) {
      fetchBranches(deviceId, dir.path, abort.signal).then((info) => {
        if (!live) return;
        setBranchInfo(info);
        if (info.git) {
          setGit(true);
          const initial = info.current && info.branches.includes(info.current) ? info.current : "";
          setSelectedBranch(initial);
          setBaseBranch(initial);
        } else {
          setGit(false);
          setBranch(null);
        }
      }).catch(() => {
        if (!live) return;
        if (listingGit === false) { setGit(false); setBranch(null); }
      });
    }
    return () => { live = false; abort.abort(); };
  }, [dir, deviceId, source, canPickBranch]);

  const permissionModes = cliPermissionModes(engine, features);
  const preferred = modeOf[engine] ?? (engine === "agy" ? "ask" : "full");
  const selectedPermissions = permissionModes.includes(preferred) ? preferred : permissionModes.includes("full") ? "full" : permissionModes[0];
  const canChoosePermissions = permissionModes.length > 0;
  const switchingInPlace = branch === null && !!selectedBranch && selectedBranch !== branchInfo?.current;
  const dirtySwitchError = switchingInPlace && branchInfo?.dirty ? "当前目录有未提交改动，请先提交或改用 Worktree" : null;
  const branchError = branch !== null ? branchProblem(branch) : dirtySwitchError;
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
      ...(dir.create ? { createDir: true } : {}),
      ...(branch !== null
        ? { branch: branch.trim(), ...(baseBranch ? { baseBranch } : {}) }
        : switchingInPlace ? { switchBranch: selectedBranch } : {}),
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
            <SessionOptions git={git} branch={branch}
              onBranch={(next) => {
                setBranch(next);
                if (next !== null) setBaseBranch(selectedBranch || (branchInfo?.current && branchInfo.branches.includes(branchInfo.current) ? branchInfo.current : ""));
              }}
              branches={branchInfo?.branches ?? []} currentBranch={branchInfo?.current} dirty={branchInfo?.dirty}
              selectedBranch={selectedBranch} onSelectedBranch={setSelectedBranch}
              baseBranch={baseBranch} onBaseBranch={setBaseBranch}
              problem={branchError}
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

interface BranchOption {
  value: string;
  label: string;
  isCurrent: boolean;
}

function orderedBranches(branches: readonly string[], currentBranch?: string): BranchOption[] {
  const options: BranchOption[] = [];
  const hasCurrent = !!currentBranch && branches.includes(currentBranch);
  if (!hasCurrent) options.push({ value: "", label: "当前 HEAD", isCurrent: false });
  const seen = new Set<string>();
  const add = (name: string) => {
    if (!name || seen.has(name) || !branches.includes(name)) return;
    seen.add(name);
    options.push({ value: name, label: name, isCurrent: name === currentBranch });
  };
  if (currentBranch) add(currentBranch);
  add("main");
  add("master");
  for (const name of branches) add(name);
  return options;
}

function BranchPickerField({ label, value, branches, currentBranch, onChange, expanded, onExpanded, compact }: {
  label: string; value: string; branches: readonly string[]; currentBranch?: string;
  onChange(next: string): void; expanded: boolean; onExpanded(next: boolean): void; compact: boolean;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => orderedBranches(branches, currentBranch), [branches, currentBranch]);
  const filtered = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    if (!text) return options;
    return options.filter((entry) => entry.label.toLocaleLowerCase().includes(text));
  }, [options, query]);

  useEffect(() => {
    if (!expanded) { setQuery(""); setActiveIndex(-1); return; }
    if (!compact) requestAnimationFrame(() => searchRef.current?.focus());
  }, [expanded, compact]);

  useEffect(() => { setActiveIndex(-1); }, [query]);

  const select = (next: string) => {
    onChange(next);
    onExpanded(false);
    if (!compact) triggerRef.current?.focus();
  };

  const displayLabel = value || "当前 HEAD";
  const displayIsCurrent = !!value && value === currentBranch;

  return <div className="na-branch-picker" data-open={expanded || undefined}>
    <button ref={triggerRef} type="button" className="na-branch-trigger" aria-label={label}
      aria-haspopup="listbox" aria-expanded={expanded} data-value={value}
      onClick={() => onExpanded(!expanded)}>
      <GitBranch size={14} aria-hidden="true"/>
      <span className="na-branch-value" title={displayLabel}>{displayLabel}</span>
      {displayIsCurrent ? <em className="na-branch-tag">当前</em> : null}
      <ChevronDown size={13} className="na-branch-chevron" aria-hidden="true"/>
    </button>
    {expanded ? <div className="na-branch-panel">
      <div className="model-menu-search na-branch-search">
        <Search size={14} aria-hidden="true"/>
        <input ref={searchRef} type="text" value={query} placeholder="搜索分支…" aria-label={`搜索${label}`}
          spellCheck={false} autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault(); event.stopPropagation();
              onExpanded(false);
              triggerRef.current?.focus();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              if (filtered.length) setActiveIndex((current) => (current + 1) % filtered.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              if (filtered.length) setActiveIndex((current) => (current <= 0 ? filtered.length - 1 : current - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const target = filtered[activeIndex >= 0 ? activeIndex : 0];
              if (target) select(target.value);
            }
          }}/>
        {query ? <button type="button" className="na-branch-clear" aria-label="清空分支搜索" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={13}/></button> : null}
      </div>
      <div className="na-branch-list" role="listbox" aria-label={label}>
        {filtered.length ? filtered.map((entry, index) => {
          const selected = entry.value === value;
          return <button key={entry.value || "__head__"} type="button" role="option" aria-selected={selected}
            className="na-branch-option" data-active={index === activeIndex || undefined} data-value={entry.value}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => select(entry.value)}>
            <span className="na-branch-option-name" title={entry.label}>{entry.label}</span>
            {entry.isCurrent ? <em className="na-branch-tag">当前</em> : null}
            {selected ? <Check size={14} className="na-branch-check" aria-hidden="true"/> : null}
          </button>;
        }) : <div className="na-branch-empty">没有匹配的分支</div>}
      </div>
    </div> : null}
  </div>;
}

/** The third tab: how the session runs. It opens a panel with branch selection (in-place switch when clean, or
 * a new worktree off a chosen base branch) and, where the CLI supports it, permissions. */
function SessionOptions({ git, branch, onBranch, branches, currentBranch, dirty, selectedBranch, onSelectedBranch, baseBranch, onBaseBranch, problem, engine, modes, permissions, onPermissions }: {
  git: boolean; branch: string | null; onBranch(next: string | null): void;
  branches: readonly string[]; currentBranch?: string; dirty?: boolean;
  selectedBranch: string; onSelectedBranch(next: string): void;
  baseBranch: string; onBaseBranch(next: string): void;
  problem: string | null;
  engine: CliEngine; modes: readonly CliPermissionMode[]; permissions?: CliPermissionMode; onPermissions(next: CliPermissionMode): void;
}) {
  const compact = useCompactComposer();
  const [open, setOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(open, panel, () => trigger.current, () => [root.current], () => setOpen(false), 336, "start", false, compact);
  const on = branch !== null;
  const switching = !on && !!selectedBranch && selectedBranch !== currentBranch;
  // Compact mobile keeps tab 3 a lightweight settings trigger (Plan A) so project & harness tabs never collide.
  const chipLabel = on ? "Worktree" : compact ? "" : selectedBranch;
  const chipTitle = on ? (baseBranch ? `Worktree（基于 ${baseBranch}）· ${branch || ""}` : branch || "Worktree") : (selectedBranch ? `分支 · ${selectedBranch}` : "分支、Worktree 与权限");
  const close = () => { setOpen(false); setBranchPickerOpen(false); if (!compact) trigger.current?.focus(); };
  useEffect(() => { if (!open) setBranchPickerOpen(false); }, [open]);
  useEffect(() => { setBranchPickerOpen(false); }, [on]);
  return <div className="model-menu-root" ref={root}>
    <button ref={trigger} type="button" className="na-pick-chip na-options-chip" data-on={on || switching || undefined} data-invalid={problem ? true : undefined}
      aria-label="会话选项" aria-haspopup="dialog" aria-expanded={open} title={chipTitle} onClick={() => setOpen(!open)}>
      <GitBranch size={15}/>
      {chipLabel ? <span>{chipLabel}</span> : null}
      {compact && switching ? <i className="na-options-dot" aria-hidden="true"/> : null}
      {permissions && permissions !== "full" ? <ShieldAlert size={13} className="na-options-ask" aria-label={cliPermissionLabel(engine, permissions)}/> : null}
      <ChevronDown size={13}/>
    </button>
    {open && <div ref={panel} popover="manual" className="model-menu na-model-menu na-options-menu" data-sheet={compact || undefined} role="dialog" aria-label="会话选项"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      {compact ? <>
        <div className="na-dir-handle" aria-hidden="true"/>
        <div className="na-options-sheet-head">
          <strong>会话设置</strong>
          <button type="button" className="icon-button" aria-label="关闭会话设置" onClick={close}><X size={17}/></button>
        </div>
      </> : null}
      <div className="na-options-body">
        <label className="na-option-row" data-disabled={!git || undefined}>
          <span className="na-option-text"><b>Worktree</b>{git ? null : <small>不是 Git 仓库</small>}</span>
          <input type="checkbox" role="switch" className="na-switch" checked={on} disabled={!git} onChange={(event) => onBranch(event.target.checked ? randomBranch() : null)}/>
        </label>
        {git && !on && branches.length > 0 ? <div className="na-option-field">
          <span className="na-option-label">
            <span>分支</span>
            {dirty ? <em className="na-option-badge is-warn">有未提交改动</em> : null}
          </span>
          <BranchPickerField label="选择分支" value={selectedBranch} branches={branches} currentBranch={currentBranch}
            onChange={onSelectedBranch} expanded={branchPickerOpen} onExpanded={setBranchPickerOpen} compact={compact}/>
        </div> : null}
        {on && branches.length > 0 ? <div className="na-option-field">
          <span className="na-option-label"><span>基准分支</span></span>
          <BranchPickerField label="基准分支" value={baseBranch} branches={branches} currentBranch={currentBranch}
            onChange={onBaseBranch} expanded={branchPickerOpen} onExpanded={setBranchPickerOpen} compact={compact}/>
        </div> : null}
        {on ? <label className="na-option-field"><span>新分支</span>
          <span className="model-menu-search"><GitBranch size={14}/><input aria-label="新分支名称" value={branch} spellCheck={false} autoComplete="off"
            onChange={(event) => onBranch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); close(); } }}/></span>
        </label> : null}
        {problem ? <div className="na-option-alert" role="alert">
          <span>{problem}</span>
          {dirty && !on && switching ? <button type="button" className="na-option-alert-action" onClick={() => onBranch(randomBranch())}>改用 Worktree</button> : null}
        </div> : null}
        {permissions ? <div className="na-option-field"><span>权限</span>
          <div className="na-option-modes" role="radiogroup" aria-label="权限">
            {modes.map((mode) => <button key={mode} type="button" role="radio" aria-checked={permissions === mode} onClick={() => onPermissions(mode)}>
              {mode === "full" ? <ShieldCheck size={14}/> : <ShieldAlert size={14}/>}<span>{cliPermissionLabel(engine, mode)}</span>{permissions === mode ? <Check size={14}/> : null}
            </button>)}
          </div>
        </div> : null}
      </div>
    </div>}
  </div>;
}
