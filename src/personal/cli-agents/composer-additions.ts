import {MAX_SEND_TEXT} from "../../../shared/cli-agents";

export interface PickedFile {id:string; file:File}
export interface ComposerExtras {files:PickedFile[];goal:string|null}
const extras=new Map<string,ComposerExtras>();
const deliveredFiles=new WeakMap<File,string>();
const goalKey=(key:string)=>"nexagent.goal."+key;
export function getExtras(key:string):ComposerExtras {
  const saved=extras.get(key);
  if(saved)return saved;
  let goal=null;
  try{goal=sessionStorage.getItem(goalKey(key))}catch{/* optional storage */}
  return {files:[],goal};
}
export function saveExtras(key:string,value:ComposerExtras){
  if(!value.files.length && value.goal===null)extras.delete(key);else extras.set(key,value);
  try{if(value.goal===null)sessionStorage.removeItem(goalKey(key));else sessionStorage.setItem(goalKey(key),value.goal)}catch{/* memory still works */}
}
export function transferGoal(from:string,to:string){
  const goal=getExtras(from).goal;
  if(goal!==null && from!==to)saveExtras(to,{...getExtras(to),goal});
}
export async function fileReference(entry:PickedFile,key:string,upload:boolean):Promise<string>{
  const {file}=entry;
  const cached=deliveredFiles.get(file);
  if(cached)return cached;
  if(!upload){
    if(file.size<=MAX_SEND_TEXT){
      try{const text=new TextDecoder("utf-8",{fatal:true}).decode(await file.arrayBuffer());
        // the class deliberately rejects control characters: that is the binary check
        // oxlint-disable-next-line no-control-regex
        if(!/[\x00-\x08\x0e-\x1f]/.test(text))return "文件："+file.name+"\n"+text;
      }catch{/* binary file */}
    }
    throw Error("此预览只支持小型文本文件，请在新版预览中添加其他文件");
  }
  const params=new URLSearchParams({key,name:file.name,id:entry.id});
  const response=await fetch("/__review/file?"+params,{method:"POST",body:file});
  const result=await response.json();
  if(!response.ok || typeof result.path!=="string")throw Error(result.error||"附件未能送达");
  const reference="附件："+file.name+"\n"+result.path;
  deliveredFiles.set(file,reference);return reference;
}
