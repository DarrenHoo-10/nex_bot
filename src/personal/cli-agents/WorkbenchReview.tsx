import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { CliEngine, CliItem, CliSessionKey } from "../../../shared/cli-agents";

export interface ReviewRecord {
  title?: string; parent?: CliSessionKey; kind?: "fork"|"side"; archived?: boolean; deleted?: boolean;
  quote?:string; quoteSent?:boolean;
  model?: string; effort?: string; translations?: Record<string,string>; history?: CliItem[];
  queue?: Array<{id:string;text:string}>; error?: string;
}
interface Snapshot {
  renameSessions?:boolean;
  gitInspector?:boolean;
  fileUpload?:boolean;
  checkouts?:Record<string,{project:string;worktree:string;branch:string}>;
  initial: CliSessionKey; records: Record<CliSessionKey, ReviewRecord>;
  skills: string[]; models: Record<CliEngine, string[]>;
}
// Translated source lines shipped with the local interactive preview, including fork history.
const previewTranslations: Record<string, string> = {
  "The race is in the setup step.": "竞态条件出现在测试的初始化阶段。",
  "The session tree now groups work by device and project. Forks keep their parent when you change the sort order.": "会话树现在按设备和项目组织。切换排序时，分支仍跟随父会话。",
};
interface Review extends Snapshot {
  translations: Record<string, string>;
  rename(key:CliSessionKey,title:string):Promise<void>;
  run(action:string, key:CliSessionKey, values?:Record<string,string>):Promise<CliSessionKey|undefined>;
}
const Context = createContext<Review|null>(null);
export const useReview = () => useContext(Context);
export function WorkbenchProvider({children}:{children:ReactNode}) {
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const snapshotGeneration=useRef(0);
  const enabled=new URLSearchParams(location.search).get("workspace")==="nexagent-review" && ["localhost","127.0.0.1"].includes(location.hostname);
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController();
    let reading=false;
    async function refresh(){
      if(reading)return;
      reading=true;
      const generation=snapshotGeneration.current;
      try{const response=await fetch("/__review/state",{signal:controller.signal});
        if(response.ok){const s:Snapshot=await response.json();if(!controller.signal.aborted && generation===snapshotGeneration.current)setSnapshot(s)}
      }catch{/* next refresh retries */}finally{reading=false}
    }
    void refresh();const timer=setInterval(refresh,1600);
    return ()=>{controller.abort();clearInterval(timer)};
  },[enabled]);
  const run=useCallback(async(action:string,key:CliSessionKey,values:Record<string,string>={})=>{
    const response=await fetch("/__review/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,key,...values})});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||"操作失败");
    snapshotGeneration.current++;
    setSnapshot(result.state);return result.key as CliSessionKey|undefined;
  },[]);
  // Preview servers started before the rename action keep their labels in this browser.
  const [savedTitles,setSavedTitles] = useState<Record<string,string>>(() => {
    try { return JSON.parse(localStorage.getItem("nexagent.review.titles") || "{}") || {}; } catch { return {}; }
  });
  async function rename(key:CliSessionKey,title:string) {
    if (snapshot?.renameSessions) { await run("rename",key,{title}); return; }
    const titles={...savedTitles,[key]:title};
    localStorage.setItem("nexagent.review.titles",JSON.stringify(titles));
    setSavedTitles(titles);
  }
  let records=snapshot?.records;
  if (records && !snapshot?.renameSessions && Object.keys(savedTitles).length) {
    records={...records};
    for(const [key,title] of Object.entries(savedTitles)) {
      const sessionKey=key as CliSessionKey;
      records[sessionKey]={...records[sessionKey],title};
    }
  }
  return <Context.Provider value={snapshot && records ? {...snapshot,records,translations:previewTranslations,run,rename}:null}>{children}</Context.Provider>;
}
export interface Note { id:string; message:string; start:number; end:number; quote:string; body:string; num:number }
export function readNotes(key:string):Note[]{
  try{return JSON.parse(sessionStorage.getItem("nexagent.notes."+key)||"[]")}catch{return []}
}
export function storeNotes(key:string,notes:Note[]){
  try{sessionStorage.setItem("nexagent.notes."+key,JSON.stringify(notes))}catch{/* session storage unavailable */}
}
