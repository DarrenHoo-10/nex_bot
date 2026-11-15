import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Archive, GitFork, LoaderCircle, Trash2, Fingerprint, ChevronDown, ChevronRight, Ellipsis, Folder, Monitor, Plus, Search } from "lucide-react";
import type { CliSessionKey, CliSessionView } from "../../../shared/cli-agents";
import { AGENT_LABEL, askedSession, sessionStatusLabel, sessionTone, folderLabel, sessionTitle, type DeviceGroup } from "./session-model";
import { SessionSortMenu, type SessionSort } from "./SessionSortMenu";
import {HarnessMark} from "./tokendance/HarnessMark";
import { useReview } from "./WorkbenchReview";

export interface SessionListProps {
  groups: readonly DeviceGroup[];
  selectedKey: CliSessionKey | null;
  /** pending requests per session */
  pending?: ReadonlyMap<string, number>;
  hiddenTotal: number;
  showHidden: boolean;
  onSelect(key: CliSessionKey): void;
  onNew(deviceId: string): void;
  reloadSessions(): Promise<void>;
  onHide(session: CliSessionView, hidden: boolean): void;
  onToggleHidden(): void;
}


const HARNESS_SAMPLES = {
  "claude-code":"Claude Code",codex:"Codex",cursor:"Cursor","grok-build":"Grok Build",
  "deepseek-harness":"DeepSeek Harness",opencode:"OpenCode",pi:"Pi",workbuddy:"WorkBuddy",
  "doubao-work":"Doubao Work",droid:"Droid",qoder:"Qoder",zcode:"Zcode"
};
type Selection = {row:CliSessionView;x:number;y:number};
const actionIcons={id:Fingerprint,fork:GitFork,archive:Archive,delete:Trash2};
interface PendingFork {
  parent: CliSessionView;
  title: string;
  known: Set<CliSessionKey>;
  key?: CliSessionKey;
}
type Action = "id"|"fork"|"archive"|"delete";
export function SessionList({groups,selectedKey,pending,hiddenTotal,showHidden,onSelect,onNew,reloadSessions,onHide,onToggleHidden}:SessionListProps) {
  const review=useReview();
  const [closed,setClosed]=useState<Set<string>>(()=>new Set());
  const [filter,setFilter]=useState(""),[sort,setSort]=useState<SessionSort>("time"),[archived,setArchived]=useState(false);
  const [menu,setMenu]=useState<Selection|null>(null),[dialog,setDialog]=useState<{row:CliSessionView;action:Exclude<Action,"fork">}|null>(null);
  const [editing,setEditing]=useState<{key:CliSessionKey; title:string}|null>(null);
  const [forking,setForking]=useState<PendingFork|null>(null);
  const forkPending=useRef(false);
  const saving=useRef(false);
  const [error,setError]=useState(""),[busy,setBusy]=useState(false);
  const menuRef=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLElement|null>(null);
  function dismissDialog(){setDialog(null);trigger.current?.focus()}
  useEffect(()=>{if(menu)menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()},[menu]);
  useEffect(()=>{
    const outside=(e:PointerEvent)=>{if(!menuRef.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node))setMenu(null)};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape" && !busy && (menu || dialog)){setMenu(null);dismissDialog()}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return ()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape)};
  },[menu,dialog,busy]);
  const meta=(key:CliSessionKey)=>review?.records[key];
  const label=(s:CliSessionView)=>meta(s.key)?.title||sessionTitle(s);
  function toggle(id:string){setClosed(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next})}
  function twist(id:string,name:string){const open=!!filter||!closed.has(id);return <button className="na-twist" disabled={!!filter} title={filter?"搜索时自动展开":undefined} aria-expanded={open} aria-label={(open?"收起":"展开")+name} onClick={()=>toggle(id)}>{open?<ChevronDown size={13}/>:<ChevronRight size={13}/>}</button>}
  const forkKey=forking?.key;
  const forkReady=!!forkKey && review?.records[forkKey]?.parent===forking.parent.key &&
    groups.some(group=>group.agents.some(agent=>agent.sessions.some(session=>session.key===forkKey)));
  useEffect(()=>{
    if(!forkReady || !forkKey || !forking)return;
    forkPending.current=false;
    setForking(null);
    if(selectedKey===forking.parent.key)onSelect(forkKey);
  },[forkReady,forkKey,forking,selectedKey,onSelect]);

  async function choose(row:CliSessionView,action:Action) {
    setMenu(null);
    setError("");
    if(action!=="fork"){setDialog({row,action});return}
    if(!review || forkPending.current)return;
    forkPending.current=true;
    const title=label(row)+"（fork）";
    const known=new Set(groups.flatMap(group=>group.agents.flatMap(agent=>agent.sessions.map(session=>session.key))));
    setForking({parent:row,title,known});
    setClosed(current=>{const next=new Set(current);next.delete(row.key);return next});
    onSelect(row.key);
    try {
      const key=await review.run("fork",row.key,{title});
      if(!key)throw Error("没有收到新分支会话");
      setForking({parent:row,title,known,key});
      void reloadSessions();
    } catch(cause){
      setError((cause as Error).message);
      forkPending.current=false;
      setForking(null);
    }
  }
  function edit(row:CliSessionView) {
    if(!review || saving.current)return;
    setEditing({key:row.key,title:label(row)});
    setError("");
  }
  async function saveName(row:CliSessionView) {
    if(!editing || !review || saving.current)return;
    const title=editing.title.trim();
    if(!title){setError("请输入会话名称");return}
    saving.current=true;
    try {
      if(title!==label(row))await review.rename(row.key,title);
      setEditing(null);
      setError("");
    } catch(cause){setError((cause as Error).message)}
    finally{saving.current=false}
  }
  async function submit(){
    if(!dialog||!review||busy)return;
    const {row,action}=dialog;setBusy(true);setError("");
    try {
      await review.run(action,row.key);
      dismissDialog();
    } catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  function sessions(rows:CliSessionView[],parent:CliSessionKey|null,depth:number,ancestors:Set<string>):ReactNode {
    const keys=new Set(rows.map(s=>s.key));
    const actualParent=(s:CliSessionView)=>{const p=meta(s.key)?.parent;return p&&keys.has(p)?p:null};
    const siblings=rows.filter(s=>actualParent(s)===parent&&!ancestors.has(s.key));
    siblings.sort((a,b)=>(sort==="engine"?a.engine.localeCompare(b.engine):0)||b.lastActivityAt-a.lastActivityAt);
    return siblings.map(s=>{
      const creatingChild=forking?.parent.key===s.key && !forkReady;
      const has=creatingChild || rows.some(c=>actualParent(c)===s.key);const asked=pending?.get(s.key)||0;
      const shown=askedSession(s,asked), tone=sessionTone(shown);
      return <div key={s.key} className="na-node">
        <div className={"cli-row "+(s.key===selectedKey?"is-selected":"")} onContextMenu={e=>{e.preventDefault();trigger.current=e.currentTarget.querySelector(".na-more");setMenu({row:s,x:e.clientX,y:e.clientY})}}>
          {has?twist(s.key,label(s)):<span className="na-twist"/>}
          {editing?.key===s.key ? <div className="cli-row-main na-editing-name">
            <HarnessMark agentId={s.engine} size="sm"/>
            <input autoFocus aria-label="会话名称" maxLength={200} value={editing.title}
              onFocus={e=>e.target.select()} onChange={e=>{setEditing({key:s.key,title:e.target.value});setError("")}}
              onBlur={()=>{if(!saving.current){setEditing(null);setError("")}}}
              onKeyDown={e=>{
                if(e.nativeEvent.isComposing || e.keyCode===229)return;
                if(e.key==="Enter"){e.preventDefault();void saveName(s)}
                if(e.key==="Escape" && !saving.current){setEditing(null);setError("")}
              }}/>
          </div> : <button type="button" className="cli-row-main" title={label(s)}
            onDoubleClick={()=>edit(s)} onKeyDown={e=>{if(e.key==="F2"){e.preventDefault();edit(s)}}} aria-current={selectedKey===s.key?"true":undefined} onClick={()=>onSelect(s.key)}>
            <span className={"na-engine "+s.engine} title={AGENT_LABEL[s.engine]}><HarnessMark agentId={s.engine} size="sm"/></span>
            <span className="cli-row-title">{label(s)}</span>{["waiting","running","offline"].includes(tone)?<span className="cli-chip" data-tone={tone}>{sessionStatusLabel(shown)}</span>:null}{asked>0?<b className="cli-count">{asked}</b>:null}
          </button>}
          <button type="button" className="icon-button na-more" title="会话操作" aria-haspopup="menu" aria-expanded={menu?.row.key===s.key} aria-label={label(s)+"的操作"} onClick={e=>{if(menu?.row.key===s.key){setMenu(null);return}trigger.current=e.currentTarget;const b=e.currentTarget.getBoundingClientRect();setMenu({row:s,x:b.right,y:b.bottom})}}><Ellipsis size={15}/></button>
        </div>
        {has&&(filter||!closed.has(s.key))&&depth<24?<div className="na-branch">
          {creatingChild && <div className="na-node"><div className="cli-row" role="status" aria-label="正在创建分支"><span className="na-twist"/>
            <div className="cli-row-main"><LoaderCircle className="na-busy-icon" size={14}/><span className="cli-row-title">{forking.title}</span></div>
          </div></div>}
          {sessions(rows,s.key,depth+1,new Set([...ancestors,s.key]))}
        </div>:null}
      </div>
    });
  }
  const checkout = (s:CliSessionView) => review?.checkouts?.[s.cwd] ?? {
    project:s.cwd, worktree:s.cwd, branch:s.gitBranch?.trim() || "未记录分支"
  };
  function grouped(rows:CliSessionView[], by:(row:CliSessionView)=>string) {
    const groups = new Map<string,CliSessionView[]>();
    for (const row of rows) {
      const name = by(row);
      if (!groups.has(name)) groups.set(name,[]);
      groups.get(name)!.push(row);
    }
    const latest = (items:CliSessionView[]) => Math.max(...items.map(row=>row.lastActivityAt));
    return [...groups].sort(([a,left],[b,right]) => (latest(right)-latest(left)) || a.localeCompare(b));
  }
  const actions:Record<Action,string>={fork:"创建分支",archive:"归档会话",delete:"删除会话",id:"查看会话 ID"};
  return <nav className="cli-list" aria-label="Agent 会话">
    <label className="na-search"><Search size={15}/><input aria-label="搜索项目或会话" value={filter} placeholder="搜索项目或会话" onChange={e=>setFilter(e.target.value)}/></label>
    <div className="na-nav-tools"><strong>{archived?"已归档":"会话目录"}</strong><SessionSortMenu value={sort} onChange={setSort}/></div>
    {groups.map(({device,agents})=>{
      // The device may publish an unlabelled new session before the fork response identifies it.
      const visibleDuringFork=(s:CliSessionView)=>!forking || forking.known.has(s.key) ||
        s.deviceId!==forking.parent.deviceId || s.engine!==forking.parent.engine || s.cwd!==forking.parent.cwd ||
        (forking.key ? s.key!==forking.key || forkReady : !!meta(s.key)?.parent && meta(s.key)?.parent!==forking.parent.key);
      const all=agents.flatMap(a=>a.sessions).filter(visibleDuringFork).filter(s=>!meta(s.key)?.deleted && meta(s.key)?.kind!=="side" && Boolean(meta(s.key)?.archived)===archived);
      const folders=grouped(all,s=>checkout(s).project);
      return <section className="cli-device" key={device.id}><header>{twist(device.id,device.name)}<Monitor size={15}/><strong>{device.name}</strong><small className={device.online?"na-online":undefined}>{device.online?"在线":"离线"}</small><button className="icon-button" aria-label={"在 "+device.name+" 上新建会话"} onClick={()=>onNew(device.id)}><Plus size={15}/></button></header>
      {(filter||!closed.has(device.id))&&folders.map(([cwd,entries])=>{
        const id=JSON.stringify([device.id,cwd]); const query=filter.trim().toLocaleLowerCase();
        const matched=new Set(entries.filter(s=>([label(s),cwd,AGENT_LABEL[s.engine],checkout(s).worktree,checkout(s).branch].join(" ")).toLocaleLowerCase().includes(query)).map(s=>s.key));
        for(const key of [...matched]){let p=meta(key)?.parent;while(p&&!matched.has(p)){matched.add(p);p=meta(p)?.parent}}
        const visible=entries.filter(s=>matched.has(s.key));if(!visible.length)return null;
        return <div className="na-project" key={id}><div className="na-folder">{twist(id,folderLabel(cwd))}<Folder size={15}/><strong title={cwd}>{folderLabel(cwd)}</strong><small>{visible.length}</small></div>{filter||!closed.has(id)?<div className="na-branch">{sessions(visible,null,0,new Set())}</div>:null}</div>
      })}</section>
    })}
    {review && !archived && !filter && <details className="na-harness-samples" open>
      <summary><ChevronRight size={13}/>Harness 图标示例<small>{Object.keys(HARNESS_SAMPLES).length}</small></summary>
      <ul>{Object.entries(HARNESS_SAMPLES).map(([id,label])=><li key={id}><HarnessMark agentId={id} size="sm"/><span>{label}</span></li>)}</ul>
    </details>}
    {review?<button className="text-button na-archive-toggle" onClick={()=>setArchived(!archived)}><Archive size={14}/>{archived?"返回会话目录":"已归档"}</button>:null}
    {hiddenTotal>0?<button className="text-button" onClick={onToggleHidden}>{showHidden?"收起已隐藏":"已隐藏 "+hiddenTotal}</button>:null}
    {menu&&createPortal(<div className="na-menu" ref={menuRef} role="menu" aria-label="会话操作" onKeyDown={e=>{
      const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      if(!buttons.length || !["ArrowDown","ArrowUp","Home","End"].includes(e.key))return;
      e.preventDefault();const next=e.key==="Home"?0:e.key==="End"?buttons.length-1:(index+(e.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length;buttons[next].focus();
    }} onBlur={e=>{if(e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))setMenu(null)}} style={{left:Math.max(5,Math.min(menu.x-140,innerWidth-198)),top:Math.max(5,Math.min(menu.y,innerHeight-265))}}>
      <small>{AGENT_LABEL[menu.row.engine]}</small>
      {review&&archived?<button onClick={()=>{void review.run("restore",menu.row.key).then(()=>setArchived(false)).catch(e=>setError(e.message));setMenu(null)}}>恢复会话</button>:null}
      {(["id",...(review&&!archived?["fork","archive","delete"]:[])] as Action[]).map(action=>{
        const p=meta(menu.row.key)?.parent,limit=action==="fork"&&p&&meta(p)?.parent;
        const unavailable=action==="fork" && menu.row.engine!=="claude";
        const Icon=actionIcons[action];
        return <button key={action} role="menuitem" className={action==="delete"?"na-danger":""} disabled={!!limit||unavailable||(action==="fork" && !!forking)} title={unavailable?"测试设备未安装该 Harness":undefined} onClick={()=>choose(menu.row,action)}><Icon size={14}/>{limit?"已达两级分支上限":actions[action]}</button>
      })}
      {!review?<button onClick={()=>{onHide(menu.row,!menu.row.hidden);setMenu(null)}}>{menu.row.hidden?"取消隐藏":"隐藏"}</button>:null}
    </div>,document.body)}
    {dialog&&createPortal(<div className="modal-backdrop"><form className="modal na-dialog" role="dialog" aria-modal="true" onKeyDown={e=>{
      if(e.key!=="Tab")return;
      const controls=Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled)"));
      const first=controls[0],last=controls.at(-1);if(!first||!last)return;
      if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus()}
    }} aria-label={actions[dialog.action]} onSubmit={e=>{e.preventDefault();void submit()}}>
      <h3>{actions[dialog.action]}</h3><p>{AGENT_LABEL[dialog.row.engine]} · {label(dialog.row)}</p>
      {dialog.action==="id"?<code>{dialog.row.nativeId}</code>:null}
      {dialog.action==="delete"||dialog.action==="archive"?<small>本次操作作用于隔离评审会话。子会话单独保留。</small>:null}
      {error?<p role="alert">{error}</p>:null}
      <footer><button type="button" autoFocus disabled={busy} onClick={dismissDialog}>关闭</button>{dialog.action==="id"?<button type="button" onClick={()=>void navigator.clipboard.writeText(dialog.row.nativeId).then(dismissDialog).catch(()=>setError("请选中 ID 复制"))}>复制 ID</button>:<button className={dialog.action==="delete"?"na-confirm-delete":"primary"} disabled={busy}>{busy?"处理中…":actions[dialog.action]}</button>}</footer>
    </form></div>,document.body)}
    {!dialog&&error?<small role="alert">{error}</small>:null}
  </nav>;
}
