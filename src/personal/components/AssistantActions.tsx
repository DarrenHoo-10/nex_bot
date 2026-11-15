import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";
import { api } from "../api";

type Action = "reset_memory" | "delete";
interface Preview { previewId:string; name:string; counts:{conversations:number; messages:number; routines:number; todos:number}; blocked:boolean }
interface Operation { operationId:string; status:string }

export function AssistantActions({ botId, name, start }: {botId:string;name:string;start:(botId:string,action:Action)=>void}) {
  const button=useRef<HTMLButtonElement>(null), menu=useRef<HTMLDivElement>(null);
  const [position,setPosition]=useState<{right:number;top:number}|null>(null);
  useEffect(()=>{
    if(!position)return;
    menu.current?.querySelector("button")?.focus();
    function outside(e:Event){if(!menu.current?.contains(e.target as Node)&&!button.current?.contains(e.target as Node))setPosition(null);}
    document.addEventListener("pointerdown",outside);
    const close=()=>setPosition(null);
    window.addEventListener("resize",close);window.addEventListener("scroll",close,true);
    return ()=>{document.removeEventListener("pointerdown",outside);window.removeEventListener("resize",close);window.removeEventListener("scroll",close,true);};
  },[position]);
  function choose(action:Action){setPosition(null);button.current?.focus();start(botId,action);}
  return <><button type="button" className="assistant-more" aria-label={name+"的操作"} aria-expanded={!!position} aria-haspopup="menu" ref={button} onClick={()=>{
    const r=button.current!.getBoundingClientRect();setPosition(position?null:{right:Math.max(4,innerWidth-r.right),top:r.bottom+96<innerHeight?r.bottom:Math.max(4,r.top-90)});
  }}><Ellipsis size={17}/></button>{position&&createPortal(<div ref={menu} role="menu" aria-label={name+"的操作"} className="assistant-actions-menu" style={position} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setPosition(null);}} onKeyDown={e=>{
    if(e.key==="Escape"){setPosition(null);button.current?.focus();}
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();const items=e.currentTarget.querySelectorAll("button");items[document.activeElement===items[0]?1:0]?.focus();}
  }}><button role="menuitem" onClick={()=>choose("reset_memory")}>重置记忆</button><button role="menuitem" className="danger-link" onClick={()=>choose("delete")}>删除助手</button></div>,document.body)}</>;
}
export function AssistantActionDialog({botId,action,close,updated}:{botId:string;action:Action;close:()=>void;updated:()=>Promise<void>}) {
  const locked=useRef(false), request=useRef(crypto.randomUUID());
  const [preview,setPreview]=useState<Preview>(),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{const controller=new AbortController();
    api<Preview>("bots/lifecycle/preview",{botId,action},controller.signal).then(setPreview).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();
  },[botId,action]);
  const reset=action==="reset_memory",label=reset?"重置记忆":"删除助手";
  async function submit(){
    if(!preview||preview.blocked||locked.current)return;
    locked.current=true;setBusy(true);setError("");
    try{await api<Operation>("bots/lifecycle/execute",{previewId:preview.previewId,requestId:request.current});
      await updated();close();
    }catch(e){setError(e instanceof Error?e.message:"操作失败");}finally{locked.current=false;setBusy(false);}
  }
  return <>
    <h2>{preview?(reset?"重置「"+preview.name+"」的记忆？":"永久删除「"+preview.name+"」？"):label}</h2>
    {preview&&<p>{preview.blocked?"请先停止并核对该助手的未结束工作，再重新打开菜单。":reset?
      `将清空 ${preview.counts.messages} 条聊天消息和全部私有记忆。旧聊天无法再查看，共享记忆保留。`:
      `将删除该助手、${preview.counts.conversations} 个会话及 ${preview.counts.routines} 条定时规则，解除 ${preview.counts.todos} 项待办指派。此操作无法撤销。`}</p>}
    {error&&<p role="alert">{error}</p>}<div className="actions"><button autoFocus disabled={busy} onClick={close}>{preview?"取消":"关闭"}</button>{preview&&!preview.blocked&&<button className="danger" disabled={busy} onClick={()=>void submit()}>{label}</button>}</div>
  </>;
}
