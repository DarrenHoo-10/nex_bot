import {useRef,useState} from "react";
import type {CliSessionKey,CliSessionView} from "../../../shared/cli-agents";
import {useReview} from "./WorkbenchReview";
import {CliApiError,branchSession,deleteWorkbenchSession,sendMessage,startSession} from "./api";
import {transferGoal} from "./composer-additions";
import {discardComposerDraft} from "./Composer";

interface Draft {
  id:string; parent:CliSessionKey; source:CliSessionView; quote:string; message:string;
  model:string; effort:string; target?:CliSessionKey; sent?:boolean; busy?:boolean;
}

/** What a production side chat reads from Core's workbench rows. */
export interface SideChatHost {
  /** Core's rows by native key: kind, parent session and display title */
  meta:ReadonlyMap<CliSessionKey,{title:string;parent?:CliSessionKey|null;kind?:"fork"|"side"|"worker"}>;
  /** a row or a session was created: read the tree and the session list again */
  refresh():void;
}

/** What a draft has already done in Core. A retry of a failed first send picks
 * up here instead of creating a second row or session. */
interface Attempt {
  branchRequestId:string; clientMessageId:string; requestId:string; body:string;
  row?:{id:string;version:number}; key?:CliSessionKey;
}

export const quotedText=(quote:string,text:string)=>"引用「"+quote+"」\n\n"+text;
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export function useSideChats(parent:CliSessionKey|null,sessions:CliSessionView[],host?:SideChatHost) {
  const review=useReview();
  const [drafts,setDrafts]=useState<Draft[]>([]);
  const [active,setActive]=useState<string|null>(null);
  const [closed,setClosed]=useState<string[]>([]);
  const [terminals,setTerminals]=useState<CliSessionKey[]>([]);
  const terminalId="terminal:"+parent;
  const sending=useRef(new Set<string>());
  const attempts=useRef(new Map<string,Attempt>());
  const local=drafts.filter(d=>d.parent===parent);
  const byKey=new Map(sessions.map(s=>[s.key,s]));
  // a side chat NexAgent started (a workbench row), or one the desktop app recorded (a /btw question, Core's `sideOf`)
  const nativeSide=(key:CliSessionKey):CliSessionKey|undefined=>{const s=byKey.get(key);return s?.sideOf?`${s.deviceId}:${s.engine}:${s.sideOf}` as CliSessionKey:undefined};
  const sideOf=(key:CliSessionKey)=>review ? (review.records[key]?.kind==="side" && !review.records[key].deleted ? review.records[key].parent : undefined)
    : (host?.meta.get(key)?.kind==="side" ? host.meta.get(key)?.parent ?? undefined : nativeSide(key));
  const remote=sessions.filter(s=>parent!==null && sideOf(s.key)===parent);
  const remoteTitle=(key:CliSessionKey)=>(review?.records[key]?.title ?? host?.meta.get(key)?.title) || byKey.get(key)?.title || "侧边聊天";
  const tabs=[
    ...remote.filter(s=>!closed.includes(s.key) && !local.some(d=>d.target===s.key)).map(s=>({id:s.key,title:remoteTitle(s.key)})),
    ...local.map(d=>({id:d.id,title:d.quote.slice(0,24)||"侧边聊天"})),
    ...(parent && terminals.includes(parent)?[{id:terminalId,title:"远程终端"}]:[])
  ];
  const selected=tabs.find(t=>t.id===active);
  const draft=local.find(d=>d.id===active);
  const session=draft ? (draft.sent ? sessions.find(s=>s.key===draft.target) : undefined) : remote.find(s=>s.key===active);
  function patch(id:string,delta:Partial<Draft>) {
    setDrafts(current=>current.map(d=>d.id===id?{...d,...delta}:d));
  }
  async function open(source:CliSessionView,quote="",message="",fresh=false) {
    if(!review && !host)return;
    const record=review?.records[source.key];
    const side=review ? record?.kind==="side" ? record.parent : undefined : sideOf(source.key);
    const owner=side ?? source.key;
    if(!fresh && !quote && owner===parent) {
      if(selected && selected.id!==terminalId)return;
      const existing=tabs.filter(t=>t.id!==terminalId).at(-1)?.id ?? remote[0]?.key;
      if(existing){setClosed(c=>c.filter(k=>k!==existing));setActive(existing);return}
    }
    const id=crypto.randomUUID();
    setDrafts(current=>[...current,{id,parent:owner,source,quote,message,// the review fixture names its own models; the CLI default stays unless the user picks one
      model:review?record?.model||review.models[source.engine]?.[0]||source.model?.trim()||"":"",effort:review?record?.effort||"标准":""}]);
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
    if(item){
      setDrafts(current=>current.filter(d=>d.id!==id));discardComposerDraft(id);
      // a row made for a first send that never got a session would stay behind unseen
      const attempt=attempts.current.get(id);
      if(attempt?.row && !attempt.key)void deleteWorkbenchSession({id:attempt.row.id,expectedVersion:attempt.row.version}).catch(()=>undefined);
      attempts.current.delete(id);
    }
    const remoteKey=item?.target ?? id;
    setClosed(current=>[...current,remoteKey]);
    if(id===active)setActive(tabs.filter(t=>t.id!==id).at(-1)?.id??null);
  }
  /** Production first send: the row, then the device session bound to it, then the quoted message. */
  async function sendThroughCore(d:Draft,text:string):Promise<CliSessionKey> {
    const body=d.quote?quotedText(d.quote,text):text;
    let attempt=attempts.current.get(d.id);
    if(!attempt){
      attempt={branchRequestId:crypto.randomUUID(),clientMessageId:crypto.randomUUID(),requestId:crypto.randomUUID(),body};
      attempts.current.set(d.id,attempt);
    }
    // other words are another message: the old ids would be refused as a changed request
    if(attempt.body!==body)Object.assign(attempt,{body,clientMessageId:crypto.randomUUID(),requestId:crypto.randomUUID()});
    if(!attempt.key){
      if(!attempt.row){
        const created=await branchSession(d.parent,d.quote.slice(0,24)||"侧边聊天",attempt.branchRequestId,"side");
        attempt.row={id:created.id,version:created.version};
      }
      const started=await startSession(d.source.deviceId,d.source.engine,d.source.cwd,{parentId:attempt.row.id,...(d.model?{model:d.model}:{}),...(d.effort?{effort:d.effort}:{})});
      attempt.key=started.key;
      patch(d.id,{target:started.key});
      host?.refresh();
    }
    for(let tries=0;;tries++) {
      try {
        await sendMessage(attempt.key,body,{delivery:"send",clientMessageId:attempt.clientMessageId,requestId:attempt.requestId});
        break;
      } catch(cause) {
        // the device may not have listed the new session yet
        if(tries<4 && cause instanceof CliApiError && cause.code==="not_found"){await wait(300);continue}
        throw cause;
      }
    }
    host?.refresh();
    return attempt.key;
  }
  async function send(d:Draft,text:string) {
    if((!review && !host) || sending.current.has(d.id))throw Error("消息正在发送");
    sending.current.add(d.id);patch(d.id,{busy:true});
    try {
      let key:CliSessionKey;
      if(!review)key=await sendThroughCore(d,text);
      else {
        let target=d.target;
        if(!target){
          target=await review.run("side",d.source.key,{title:d.quote.slice(0,24)||"侧边聊天",quote:d.quote,message:d.message});
          if(!target)throw Error("未能创建侧边会话");
          patch(d.id,{target});
        }
        const current=review.records[target];
        const model=current?.model || review.records[d.source.key]?.model || review.models[d.source.engine]?.[0]||"";
        if(d.model!==model || d.effort!==(current?.effort||"标准"))await review.run("settings",target,{model:d.model,effort:d.effort});
        if(d.quote)await review.run("quoted-send",target,{text});
        else await sendMessage(target,text);
        key=target;
      }
      transferGoal(d.id,key);
      patch(d.id,{sent:true});
    }finally{sending.current.delete(d.id);patch(d.id,{busy:false})}
  }
  function changeSession(key:CliSessionKey) {
    if(draft)patch(draft.id,{target:key});else setActive(key);
  }
  return {selected,tabs,draft,session,open,openTerminal,terminalId,close,send,patch,select:setActive,changeSession};
}
