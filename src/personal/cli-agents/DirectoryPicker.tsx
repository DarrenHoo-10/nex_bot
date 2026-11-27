// Where a new session runs: browse a computer's folders (up, down, breadcrumbs), search the current folder and
// recent ones, or type a path. A path that does not exist yet is created when the session starts.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, Folder, FolderGit2, FolderPlus, HardDrive, History, Monitor, Search, X } from "lucide-react";
import { useAnchoredPopover } from "../components/anchored-popover";
import { useCompactComposer } from "../components/use-compact-composer";
import { baseName, joinPath, parentPath, pathSep, readQuery, validFolderName, type DirectorySource, type DirListing } from "./directory-source";

/** The folder a session starts in; `create` asks the computer to make it first. */
export interface DirectoryChoice { path: string; create: boolean }

export interface PickerDevice { id: string; name: string; online: boolean }

type Row =
  | { kind: "folder"; key: string; path: string; name: string; git?: boolean; hint?: string; recent?: boolean; root?: boolean }
  | { kind: "go"; key: string; path: string }
  | { kind: "create"; key: string; path: string; label: string };

export interface DirectoryPickerProps {
  devices: readonly PickerDevice[];
  deviceId: string;
  onDevice(id: string): void;
  value: DirectoryChoice | null;
  onChange(next: DirectoryChoice): void;
  source(deviceId: string): DirectorySource;
  recents: readonly string[];
  disabled?: boolean;
}

/** Keeps the root prefix and trailing segments so long parent paths remain readable. */
function shortenPath(path: string, max = 32): string {
  if (path.length <= max) return path;
  const sep = pathSep(path);
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  const prefix = path.startsWith("\\\\") ? "\\\\" + parts[0] : path.startsWith("/") ? "" : parts[0];
  const rest = path.startsWith("/") ? parts : parts.slice(1);
  const tail: string[] = [];
  for (let index = rest.length - 1; index >= 0; index--) {
    const candidate = `${prefix}${sep}…${sep}${[rest[index], ...tail].join(sep)}`;
    if (tail.length && candidate.length > max) break;
    tail.unshift(rest[index]);
  }
  return `${prefix}${sep}…${sep}${tail.join(sep)}`;
}

export function DirectoryPicker({ devices, deviceId, onDevice, value, onChange, source, recents, disabled }: DirectoryPickerProps) {
  const compact = useCompactComposer();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [known, setKnown] = useState<Record<string, boolean>>({});
  const [crumbFade, setCrumbFade] = useState({ left: false, right: false });
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), crumbBar = useRef<HTMLElement>(null);
  useAnchoredPopover(open, panel, () => trigger.current, () => [root.current], () => setOpen(false), 440, "start", false, compact);
  const dirs = useMemo(() => source(deviceId), [source, deviceId]);

  // opening starts where the choice is (or at the top with recent folders); touch devices wait for a tap on search
  useEffect(() => {
    if (!open) return;
    setQuery(""); setActive(-1);
    setCurrent(value && !value.create ? value.path : value?.create ? parentPath(value.path) ?? "" : "");
    if (!compact) requestAnimationFrame(() => input.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    dirs.list(current).then((next) => { if (live) { setListing(next); setLoading(false); } }).catch(() => { if (live) { setListing({ path: current, parent: parentPath(current), exists: false, entries: [] }); setLoading(false); } });
    return () => { live = false; };
  }, [open, current, dirs]);

  // a typed path is looked up so the row can say "go" or "create"
  const parsed = readQuery(query, current);
  useEffect(() => {
    if (!open || parsed.kind !== "path" || parsed.path in known) return;
    let live = true;
    dirs.list(parsed.path).then((found) => { if (live) setKnown((all) => ({ ...all, [parsed.path]: found.exists })); }).catch(() => undefined);
    return () => { live = false; };
  }, [open, parsed.kind === "path" ? parsed.path : "", dirs]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo<Row[]>(() => {
    if (parsed.kind === "path") {
      const exists = known[parsed.path];
      return [exists === false ? { kind: "create", key: "create:" + parsed.path, path: parsed.path, label: parsed.path } : { kind: "go", key: "go:" + parsed.path, path: parsed.path }];
    }
    const text = parsed.text.toLocaleLowerCase();
    // names only: every child shares the folder's own path, so matching paths would match everything
    const matches = (name: string) => !text || name.toLocaleLowerCase().includes(text);
    const out: Row[] = [];
    const recent = recents.filter((path) => matches(baseName(path))).slice(0, current ? 3 : 6);
    // the top view leads with recent folders; inside a folder they only show while searching
    if (!current || text) for (const path of recent) {
      const hint = parentPath(path);
      out.push({ kind: "folder", key: "recent:" + path, path, name: baseName(path), ...(hint ? { hint: shortenPath(hint, 36) } : {}), recent: true });
    }
    for (const entry of listing?.path === current ? listing.entries : []) {
      // dot-folders stay out of the listing unless the user explicitly searches for a leading dot
      if (entry.name.startsWith(".") && !text.startsWith(".")) continue;
      if (!matches(entry.name)) continue;
      out.push({ kind: "folder", key: "dir:" + entry.path, path: entry.path, name: entry.name, git: entry.git, root: !current });
    }
    if (current && parsed.text && validFolderName(parsed.text) && !listing?.entries.some((entry) => entry.name.toLocaleLowerCase() === text)) {
      const path = joinPath(current, parsed.text);
      out.push({ kind: "create", key: "create:" + path, path, label: parsed.text });
    }
    return out;
  }, [parsed.kind, parsed.kind === "path" ? parsed.path : parsed.text, known, recents, current, listing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setActive(-1); }, [query, current]);

  const close = () => { setOpen(false); if (!compact) trigger.current?.focus(); };
  const go = (path: string) => { setCurrent(path); setQuery(""); setActive(-1); if (!compact) input.current?.focus(); };
  const choose = (next: DirectoryChoice) => { onChange(next); close(); };
  const act = (row: Row) => {
    if (row.kind === "folder" || row.kind === "go") go(row.path);
    else choose({ path: row.path, create: true });
  };
  const up = () => { if (current) go(parentPath(current) ?? ""); };

  const crumbs = useMemo(() => {
    const list: { label: string; path: string }[] = [];
    for (let path: string | null = current || null; path; path = parentPath(path)) list.unshift({ label: baseName(path), path });
    return list;
  }, [current]);
  const syncCrumbFade = () => {
    const bar = crumbBar.current;
    if (!bar) return;
    const left = bar.scrollLeft > 2;
    const right = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2;
    setCrumbFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };
  // a deep folder keeps its own name in view
  useEffect(() => {
    const bar = crumbBar.current;
    if (!bar) return;
    bar.scrollLeft = bar.scrollWidth;
    syncCrumbFade();
  }, [crumbs, open]);
  const device = devices.find((entry) => entry.id === deviceId);
  const missing = !!current && listing?.path === current && !listing.exists;
  const currentParent = current ? parentPath(current) : null;

  const chip = value ? baseName(value.path) : "选择目录";
  return <div className="model-menu-root" ref={root}>
    <button ref={trigger} type="button" className="na-pick-chip" data-empty={!value || undefined} aria-label="工作目录" aria-haspopup="dialog" aria-expanded={open}
      title={value ? (value.create ? "将新建 " : "") + value.path : undefined} disabled={disabled} onClick={() => setOpen(!open)}>
      <Folder size={14}/><span>{chip}</span>{value?.create ? <em>新建</em> : null}<ChevronDown size={13}/>
    </button>
    {open && <div ref={panel} popover="manual" className="model-menu na-model-menu na-dir-menu" data-sheet={compact ? "true" : undefined} role="dialog" aria-label="选择工作目录"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      {compact ? <div className="na-dir-handle" aria-hidden="true"/> : null}

      {compact ? <header className="na-dir-head">
        <div className="na-dir-title">
          <strong>选择目录</strong>
          {devices.length === 1 && device ? <span className="na-dir-device-badge"><Monitor size={12}/><span>{device.name}</span></span> : null}
        </div>
        <button type="button" className="na-dir-close" aria-label="关闭" onClick={close}><X size={16}/></button>
      </header> : null}

      {devices.length > 1 ? <div className="na-dir-devices" role="radiogroup" aria-label="电脑">
        {devices.map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={entry.id === deviceId} disabled={!entry.online}
          onClick={() => { onDevice(entry.id); go(""); }}><Monitor size={13}/><span>{entry.name}</span>{entry.online ? null : <small>离线</small>}</button>)}
      </div> : !compact && device ? <div className="na-dir-device"><Monitor size={13}/><span>{device.name}</span></div> : null}

      <div className="model-menu-search na-dir-search">
        <Search size={15} aria-hidden="true"/>
        <input ref={input} aria-label="搜索或输入路径" placeholder={current ? "搜索、新建文件夹或输入路径" : "搜索最近目录或输入路径"} value={query} spellCheck={false} autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive((at) => (rows.length ? Math.min(rows.length - 1, at + 1) : -1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((at) => (rows.length ? Math.max(0, at - 1) : -1)); }
            else if (event.key === "Backspace" && !query && current) { event.preventDefault(); up(); }
            else if (event.key === "Enter") {
              event.preventDefault();
              if (event.ctrlKey || event.metaKey) { if (current) choose({ path: current, create: missing }); return; }
              const row = rows[active >= 0 ? active : 0]; if (row) act(row); else if (current) choose({ path: current, create: missing });
            }
          }}/>
        {query ? <button type="button" className="na-dir-clear" aria-label="清空搜索" onClick={() => { setQuery(""); if (!compact) input.current?.focus(); }}><X size={13}/></button> : null}
      </div>

      <div className="na-dir-path">
        <button type="button" className="na-dir-up" aria-label="上一级" title="上一级" disabled={!current} onClick={up}><ArrowUp size={15}/></button>
        <nav ref={crumbBar} className="na-dir-crumbs" aria-label="当前位置" onScroll={syncCrumbFade}
          data-fade-left={crumbFade.left ? "1" : undefined} data-fade-right={crumbFade.right ? "1" : undefined}>
          <button type="button" onClick={() => go("")} aria-current={!current || undefined}>全部</button>
          {crumbs.map((crumb, index) => <span key={crumb.path}><ChevronRight size={12} aria-hidden="true"/>
            <button type="button" onClick={() => go(crumb.path)} aria-current={index === crumbs.length - 1 || undefined} title={crumb.path}>{crumb.label.replace(/[\\/]$/, "")}</button></span>)}
        </nav>
      </div>

      <div className="model-menu-list na-dir-list" role="listbox" aria-label="文件夹">
        {loading && !rows.length ? <div className="model-menu-status" role="status">正在读取…</div> : null}
        {missing && !query ? <div className="model-menu-status">这个文件夹还不存在，开始会话时会新建</div> : null}
        {rows.map((row, index) => {
          const first = row.kind === "folder" && row.recent && (index === 0 || !(rows[index - 1].kind === "folder" && (rows[index - 1] as { recent?: boolean }).recent));
          const firstDir = row.kind === "folder" && !row.recent && index > 0 && rows[index - 1].kind === "folder" && (rows[index - 1] as { recent?: boolean }).recent;
          const isSelected = active >= 0 && index === active;
          const accentIcon = row.kind === "create" || (row.kind === "folder" && !!row.git);
          return <div key={row.key} role="presentation">
            {first ? <div className="na-dir-section"><History size={12}/>最近</div> : null}
            {firstDir ? <div className="na-dir-section">{current ? baseName(current) : "位置"}</div> : null}
            <div className="na-dir-row" role="option" aria-selected={isSelected} data-active={isSelected ? "true" : undefined} data-kind={row.kind}>
              <button type="button" className="na-dir-main" onClick={() => act(row)} title={row.kind === "folder" ? row.path : undefined}>
                <span className="na-dir-icon" data-tone={accentIcon ? "accent" : undefined} aria-hidden="true">
                  {row.kind === "create" ? <FolderPlus size={15}/> : row.kind === "go" ? <ChevronRight size={15}/> : row.root ? <HardDrive size={15}/> : row.recent ? <History size={14}/> : row.git ? <FolderGit2 size={15}/> : <Folder size={15}/>}
                </span>
                <span className="na-dir-name">
                  <span className="na-dir-label">
                    {row.kind === "create" ? <>新建文件夹 <b>{row.label}</b></> : row.kind === "go" ? <>前往 <b>{row.path}</b></> : row.name}
                  </span>
                  {row.kind === "folder" && row.hint ? <small>{row.hint}</small> : null}
                </span>
                {row.kind === "folder" && row.git ? <i className="na-dir-tag">Git</i> : null}
                {row.kind === "folder" ? <ChevronRight size={15} className="na-dir-enter" aria-hidden="true"/> : null}
              </button>
            </div>
          </div>;
        })}
        {!loading && !rows.length && current && !missing ? <div className="model-menu-status">{query ? "没有匹配的文件夹" : "没有子文件夹"}</div> : null}
      </div>

      <footer className="na-dir-foot">
        <div className="na-dir-current" title={current || undefined}>
          {current ? <>
            <strong className="na-dir-current-name">{baseName(current)}</strong>
            {currentParent ? <span className="na-dir-current-parent">{shortenPath(currentParent, compact ? 30 : 40)}</span> : null}
          </> : <span className="na-dir-current-empty">选择一个文件夹</span>}
        </div>
        <button type="button" className="na-dir-confirm" disabled={!current} onClick={() => choose({ path: current, create: missing })}>
          {missing ? "新建并使用" : "使用此目录"}
        </button>
      </footer>
    </div>}
  </div>;
}

