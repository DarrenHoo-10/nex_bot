import {CLI_PERMISSION_MODES, MAX_SEND_TEXT, type CliPermissionMode, type CliSessionKey} from "../../../shared/cli-agents";
import {cliImageId, cliImageReference} from "../../../shared/cli-images";
import {uploadAttachment} from "./api";
import {localCacheScope, queueLocalCache} from "../local-content-cache";

export interface PickedFile {id:string; file:File}
export interface ComposerExtras {files:PickedFile[];goal:string|null}
const extras=new Map<string,ComposerExtras>();
const deliveredFiles=new WeakMap<File,{key:string;reference:string}>();
export const isPickedImage = (file: File) => file.type.startsWith("image/") || /\.(?:png|jpe?g|webp)$/i.test(file.name);
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
/** The model and effort chosen for a session, kept in this browser. */
const launchKey=(key:string)=>"nexagent.launch."+key;
export function getLaunch(key:string):{model:string;effort:string}{
  try{const value=JSON.parse(localStorage.getItem(launchKey(key))||"{}") as {model?:unknown;effort?:unknown};
    return {model:typeof value.model==="string"?value.model:"",effort:typeof value.effort==="string"?value.effort:""};
  }catch{return {model:"",effort:""}}
}
export function saveLaunch(key:string,value:{model:string;effort:string}){
  try{if(!value.model&&!value.effort)localStorage.removeItem(launchKey(key));else localStorage.setItem(launchKey(key),JSON.stringify(value))}catch{/* lasts for the page */}
}
/** The model and effort the session's CLI already runs with, as far as this browser knows: it was started with them
 * or was told them (/model, /effort). A send types only what differs, so reopening the page repeats nothing. */
const appliedKey=(key:string)=>"nexagent.applied."+key;
export function getApplied(key:string):{model:string;effort:string}|null{
  try{const raw=localStorage.getItem(appliedKey(key));if(raw===null)return null;
    const value=JSON.parse(raw) as {model?:unknown;effort?:unknown};
    return {model:typeof value.model==="string"?value.model:"",effort:typeof value.effort==="string"?value.effort:""};
  }catch{return null}
}
export function saveApplied(key:string,value:{model:string;effort:string}){
  try{localStorage.setItem(appliedKey(key),JSON.stringify({model:value.model,effort:value.effort}))}catch{/* lasts for the page */}
}
/** The permission mode chosen for a session in this browser, and whether its CLI still has to take it: a CLI running in
 * a terminal takes it the next time it starts, an idle Antigravity session at the next message. */
export interface PermissionChoice {mode:CliPermissionMode;pending:boolean}
const permissionKey=(key:string)=>"nexagent.permission."+key;
export function getPermission(key:string):PermissionChoice|null{
  try{const value=JSON.parse(localStorage.getItem(permissionKey(key))||"null") as {mode?:unknown;pending?:unknown}|null;
    const mode=CLI_PERMISSION_MODES.find(entry=>entry===value?.mode);
    return mode?{mode,pending:value?.pending===true}:null;
  }catch{return null}
}
export function savePermission(key:string,value:PermissionChoice|null){
  try{if(value)localStorage.setItem(permissionKey(key),JSON.stringify(value));else localStorage.removeItem(permissionKey(key))}catch{/* lasts for the page */}
}
export function transferGoal(from:string,to:string){
  const goal=getExtras(from).goal;
  if(goal!==null && from!==to)saveExtras(to,{...getExtras(to),goal});
  if(from!==to && !getLaunch(to).model && !getLaunch(to).effort)saveLaunch(to,getLaunch(from));
  const permission=getPermission(from);
  if(from!==to && permission && !getPermission(to))savePermission(to,permission);
}
/** What a message says about an attached file. `upload` is true for the review fixture's endpoint, a
 * function that puts the file on the session's computer, or false where only small text files go inline. */
export async function fileReference(entry:PickedFile,key:CliSessionKey,upload:boolean|((file:File)=>Promise<{path:string}>)):Promise<string>{
  const {file}=entry;
  const cached=deliveredFiles.get(file);
  if(cached?.key===key)return cached.reference;
  if(typeof upload==="function" || (upload===false && isPickedImage(file))){
    const scope = localCacheScope();
    const {path}=await (typeof upload==="function" ? upload(file) : uploadAttachment(key,file));
    const image = cliImageId(path);
    if (image && file.size < 2 * 1024 * 1024) queueLocalCache(scope, "image:" + path, file);
    const reference=image ? cliImageReference(file.name,path) : "附件："+file.name+"\n"+path;
    deliveredFiles.set(file,{key,reference});return reference;
  }
  if(!upload){
    if(file.size<=MAX_SEND_TEXT){
      try{const text=new TextDecoder("utf-8",{fatal:true}).decode(await file.arrayBuffer());
        // the class deliberately rejects control characters: that is the binary check
        // oxlint-disable-next-line no-control-regex
        if(!/[\x00-\x08\x0e-\x1f]/.test(text))return "文件："+file.name+"\n"+text;
      }catch{/* binary file */}
    }
    throw Error("目前只能附加小型文本文件");
  }
  const params=new URLSearchParams({key,name:file.name,id:entry.id});
  const response=await fetch("/__review/file?"+params,{method:"POST",body:file});
  const result=await response.json();
  if(!response.ok || typeof result.path!=="string")throw Error(result.error||"附件未能送达");
  const reference="附件："+file.name+"\n"+result.path;
  deliveredFiles.set(file,{key,reference});return reference;
}

/** Files of messages sent from this page, so edit-and-resend puts them back in the box. */
const sentFiles: { key: string; body: string; files: PickedFile[] }[] = [];
const plain = (text: string) => text.replace(/\s+/g, " ").trim();
export function rememberSent(key: string, body: string, files: PickedFile[]) {
  if (!files.length) return;
  sentFiles.push({ key, body, files });
  if (sentFiles.length > 40) sentFiles.shift();
}
/** The typed words and files of a message this page sent, found by its recorded text. */
export function recallSent(key: string, text: string): { body: string; files: PickedFile[] } | null {
  const recorded = plain(text);
  for (let i = sentFiles.length - 1; i >= 0; i--) {
    const entry = sentFiles[i];
    if (entry.key !== key || !entry.files.every((picked) => recorded.includes(picked.file.name))) continue;
    if (!entry.body || recorded.startsWith(plain(entry.body))) return { body: entry.body, files: entry.files };
  }
  return null;
}
