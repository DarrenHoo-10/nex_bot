import {useRef,useState} from "react";
import type {CliSessionKey,CliSessionView} from "../../../shared/cli-agents";
import {useReview} from "./WorkbenchReview";
import {sendMessage} from "./api";
import {transferGoal} from "./composer-additions";
import {discardComposerDraft} from "./Composer";

interface Draft {
  id:string; parent:CliSessionKey; source:CliSessionView; quote:string; message:string;
  model:string; effort:string; target?:CliSessionKey; sent?:boolean; busy?:boolean;
}

export function useSideChats(parent:CliSessionKey|null,sessions:CliSessionView[]) {
  const review=useReview();
  const [drafts,setDrafts]=useState<Draft[]>([]);
  const [active,setActive]=useState<string|null>(null);
  const [closed,setClosed]=useState<string[]>([]);
  const [terminals,setTerminals]=useState<CliSessionKey[]>([]);
  const terminalId="terminal:"+parent;
  const sending=useRef(new Set<string>());
  const local=drafts.filter(d=>d.parent===parent);
  const remote=sessions.filter(s=>review?.records[s.key]?.kind==="side" && review.records[s.key].parent===parent && !review.records[s.key].deleted);
  const remoteTitle=(key:CliSessionKey)=>review?.records[key]?.title || "侧边聊天";
  const tabs=[
    ...remote.filter(s=>!closed.includes(s.key) && !local.some(d=>d.target===s.key)).map(s=>({id:s.key,title:remoteTitle(s.key)})),
    ...local.map(d=>({id:d.id,title:d.quote.slice(0,24)||"侧边聊天"})),
    ...(parent && terminals.includes(parent)?[{id:terminalId,title:"远程终端"}]:[])
  ];
  const selected=tabs.find(t=>t.id===active);
  const draft=local.find(d=>d.id===active);
  const session=remote.find(s=>s.key===(draft?.sent?draft.target:active));
  function patch(id:string,delta:Partial<Draft>) {
    setDrafts(current=>current.map(d=>d.id===id?{...d,...delta}:d));
  }
  async function open(source:CliSessionView,quote="",message="",fresh=false) {
    if(!review)return;
    const record=review.records[source.key];
    const owner=record?.kind==="side" && record.parent ? record.parent : source.key;
    if(!fresh && !quote && owner===parent) {
      if(selected && selected.id!==terminalId)return;
      const existing=tabs.filter(t=>t.id!==terminalId).at(-1)?.id ?? remote[0]?.key;
      if(existing){setClosed(c=>c.filter(k=>k!==existing));setActive(existing);return}
    }
    const id=crypto.randomUUID();
    setDrafts(current=>[...current,{id,parent:owner,source,quote,message,model:record?.model||review.models[source.engine][0],effort:record?.effort||"标准"}]);
    setActive(id);
  }
  function openTerminal() {
    if(!parent)return;
    setTerminals(current=>current.includes(parent)?current:[...current,parent]);
    setActive(terminalId);
  }
  function close(id:string) {
    if(id===terminalId) {
      setTerminals(current=>current.filter(key=>key!==parent));
      if(active===id)setActive(tabs.filter(tab=>tab.id!==id).at(-1)?.id??null);
      return;
    }
    if(sending.current.has(id))return;
    const item=local.find(d=>d.id===id);
    if(item){setDrafts(current=>current.filter(d=>d.id!==id));discardComposerDraft(id)}
    const remoteKey=item?.target ?? id;
    setClosed(current=>[...current,remoteKey]);
    if(id===active)setActive(tabs.filter(t=>t.id!==id).at(-1)?.id??null);
  }
  async function send(d:Draft,text:string) {
    if(!review || sending.current.has(d.id))throw Error("消息正在发送");
    sending.current.add(d.id);patch(d.id,{busy:true});
    try {
      let key=d.target;
      if(!key){
        key=await review.run("side",d.source.key,{title:d.quote.slice(0,24)||"侧边聊天",quote:d.quote,message:d.message});
        if(!key)throw Error("未能创建侧边会话");
        patch(d.id,{target:key});
      }
      const current=review.records[key];
      const model=current?.model || review.records[d.source.key]?.model || review.models[d.source.engine][0];
      if(d.model!==model || d.effort!==(current?.effort||"标准"))await review.run("settings",key,{model:d.model,effort:d.effort});
      if(d.quote)await review.run("quoted-send",key,{text});
      else await sendMessage(key,text);
      transferGoal(d.id,key);
      patch(d.id,{sent:true});
    }finally{sending.current.delete(d.id);patch(d.id,{busy:false})}
  }
  function changeSession(key:CliSessionKey) {
    if(draft)patch(draft.id,{target:key});else setActive(key);
  }
  return {selected,tabs,draft,session,open,openTerminal,terminalId,close,send,patch,select:setActive,changeSession};
}
