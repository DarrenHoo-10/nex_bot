import {useEffect,useMemo,useState} from "react";
import {Activity,CheckCircle2,ChevronDown,Circle,FileDiff,GitBranch,Layers,ListChecks,Network,RefreshCw,SquareTerminal} from "lucide-react";
import type {CliItem,CliSessionView} from "../../../shared/cli-agents";
import {AGENT_LABEL,canAttach,folderLabel} from "./session-model";
import {sessionActivity,type ActivityEntry} from "./session-activity";
import {useReview} from "./WorkbenchReview";
import "./session-info.css";

interface GitInfo {branch:string;head:string;files:string[];added:number;removed:number}
function ActivityGroup({title,entries,icon:Icon}:{title:string;entries:ActivityEntry[];icon:typeof Activity}) {
  if (!entries.length) return null;
  return <details className="na-activity-group" open={title==="待办" || undefined}>
    <summary><Icon size={15}/><b>{title}</b><small>{title==="待办" && entries.length?entries.filter(x=>x.state==="已完成").length+"/":""}{entries.length}</small><ChevronDown size={13}/></summary>
    <ul>{entries.map((entry,index)=><li key={index} data-state={entry.state}>
      {entry.state==="已完成"?<CheckCircle2 size={13}/>:<Circle size={12}/>}<span>{entry.title}</span><small>{entry.state}</small></li>)}</ul>
  </details>;
}
export function SessionInfoCard({session,items,open,onTerminalOpen}:{session:CliSessionView;items:CliItem[];open:boolean;onTerminalOpen?:()=>void}){
  const review=useReview(), checkout=review?.checkouts?.[session.cwd];
  const [git,setGit]=useState<GitInfo|null>(null),[error,setError]=useState(""),[refresh,setRefresh]=useState(0);
  const [reading,setReading]=useState(false);
  const activity=useMemo(()=>sessionActivity(items,session.state,session.online),[items,session.state,session.online]);
  useEffect(()=>{
    if(!open || !review?.gitInspector || !checkout)return;
    const controller=new AbortController();
    setError("");setReading(true);
    (async()=>{
      try{
        const response=await fetch("/__review/git?key="+encodeURIComponent(session.key),{signal:controller.signal});
        if(!response.ok)throw Error("Git 状态读取失败");
        const result:GitInfo=await response.json();if(!controller.signal.aborted)setGit(result);
      }catch{if(!controller.signal.aborted){setGit(null);setError("Git 状态读取失败")}}
      finally{if(!controller.signal.aborted)setReading(false)}
    })();
    return ()=>controller.abort();
  },[open,refresh,review?.gitInspector,session.key,checkout?.worktree]);
  const branch=git?.branch || checkout?.branch || session.gitBranch;
  return <aside className="na-info" aria-label="工作区信息">
    <section className="na-info-card" aria-label="会话概览">
      <header><GitBranch size={15}/><strong>Git 工作区</strong><small>{AGENT_LABEL[session.engine]}</small>
        {open && review?.gitInspector && checkout && <button disabled={reading} aria-busy={reading} aria-label="刷新 Git 状态" title={reading?"正在读取…":"刷新 Git 状态"} onClick={()=>setRefresh(v=>v+1)}><RefreshCw className={reading?"na-busy-icon":undefined} size={14}/></button>}</header>
      <div className="na-info-row"><GitBranch size={15}/><span>分支</span><b>{branch || "未上报"}</b>{git && <code>{git.head}</code>}</div>
      <div className="na-info-row"><Layers size={15}/><span>工作树</span><b>{checkout?(checkout.worktree===checkout.project?"主工作树":folderLabel(checkout.worktree)):"未上报"}</b></div>
      {git ? <details className="na-diff"><summary><FileDiff size={15}/><span>更改</span><b>{git.files.length} 个文件</b><em>+{git.added}</em><em>−{git.removed}</em></summary>
        {git.files.length?<ul>{git.files.map(file=><li key={file}>{file}</li>)}</ul>:<p>工作树干净</p>}</details> :
        <div className="na-info-row"><FileDiff size={15}/><span>更改</span><small>{error || (review?.gitInspector&&checkout?"正在读取…":"未上报")}</small></div>}
      {(activity.todos.length + activity.agents.length + activity.jobs.length > 0) && <div className="na-info-activity"><ActivityGroup title="待办" entries={activity.todos} icon={ListChecks}/>
        <ActivityGroup title="子代理" entries={activity.agents} icon={Network}/><ActivityGroup title="后台任务" entries={activity.jobs} icon={Activity}/></div>}
      {onTerminalOpen && <footer><button disabled={!canAttach(session)} title={canAttach(session)?"连接当前会话的终端":"当前会话没有可连接的终端"} onClick={onTerminalOpen}><SquareTerminal size={15}/>打开远程终端</button></footer>}
    </section>
  </aside>;
}
