import { userErrorText } from "../../lib/http-errors";
import {useEffect,useId,useRef,useState,type ReactNode} from "react";
import {createPortal} from "react-dom";
import type {Note} from "./WorkbenchReview";

export function AnnotatedMessage({id,notes,onNotes,onSide,children}:{onSide?(quote:string,message:string):Promise<void>;id:string;notes:Note[];onNotes(next:Note[]):void;children:ReactNode}){
  const content=useRef<HTMLDivElement>(null);
  const [edit,setEdit]=useState<{note:Note;x:number;y:number;writing:boolean}|null>(null);
  const [body,setBody]=useState("");
  const [pending,setPending]=useState(false),[error,setError]=useState("");
  const own=notes.filter(n=>n.message===id);
  const highlightKey="na"+useId().replace(/[^a-zA-Z0-9]/g,"");
  useEffect(()=>{
    const el=content.current;
    if(!el||!globalThis.CSS?.highlights||typeof Highlight==="undefined")return;
    function repaint(){
      if(!el)return;
      const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
      const nodes:Array<{text:Node;offset:number}>=[];
      let at=0;
      for(let text=walker.nextNode();text;text=walker.nextNode()){nodes.push({text,offset:at});at+=text.textContent?.length||0}
      const ranges:Range[]=[];
      for(const note of notes.filter(n=>n.message===id)){
        const start=nodes.find(n=>n.offset+(n.text.textContent?.length||0)>note.start);
        const end=nodes.find(n=>n.offset+(n.text.textContent?.length||0)>=note.end);
        if(!start||!end)continue;
        const r=document.createRange();r.setStart(start.text,note.start-start.offset);r.setEnd(end.text,note.end-end.offset);
        if(r.toString()===note.quote)ranges.push(r);
      }
      CSS.highlights.set(highlightKey,new Highlight(...ranges));
    }
    repaint();const observer=new MutationObserver(repaint);observer.observe(el,{childList:true,characterData:true,subtree:true});
    return()=>{observer.disconnect();CSS.highlights.delete(highlightKey)};
  },[highlightKey,id,notes]);
  function select(){
    const s=getSelection(),el=content.current;
    if(!el||!s?.rangeCount||s.isCollapsed)return;
    const range=s.getRangeAt(0);
    if(!el.contains(range.startContainer)||!el.contains(range.endContainer))return;
    const quote=range.toString();if(!quote.trim())return;
    const before=range.cloneRange();before.selectNodeContents(el);before.setEnd(range.startContainer,range.startOffset);
    const start=before.toString().length,box=range.getBoundingClientRect();
    const found=own.find(n=>n.start===start&&n.quote===quote);
    setError("");setBody(found?.body||"");setEdit({note:found||{id:crypto.randomUUID(),message:id,start,end:start+quote.length,quote,body:"",num:Math.max(0,...notes.map(n=>n.num))+1},x:box.left,y:box.bottom+5,writing:false});
  }
  const editor=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!edit)return;const outside=(e:PointerEvent)=>{if(!editor.current?.contains(e.target as Node))setEdit(null)};const esc=(e:KeyboardEvent)=>{if(e.key==="Escape")setEdit(null)};document.addEventListener("keydown",esc);document.addEventListener("pointerdown",outside);return()=>{document.removeEventListener("keydown",esc);document.removeEventListener("pointerdown",outside)}},[edit]);
  function save(){if(!edit||!body.trim())return;onNotes([...notes.filter(n=>n.id!==edit.note.id),{...edit.note,body:body.trim()}]);setEdit(null);getSelection()?.removeAllRanges()}
  return <div className="na-annotated"><style>{`::highlight(${highlightKey}){background:#c1e8bd;color:#123b21}`}</style><div ref={content} onMouseUp={select} onContextMenu={e=>{if(getSelection()?.toString()){e.preventDefault();select()}}}>{children}</div>
    {own.map(n=><button className="na-pin" key={n.id} title={n.quote+" — "+n.body} onClick={e=>{const box=e.currentTarget.getBoundingClientRect();setBody(n.body);setEdit({note:n,x:box.left,y:box.bottom,writing:true})}}>注 {n.num}</button>)}
    {edit&&createPortal(<div ref={editor} className="na-note-editor" style={{left:Math.max(6,Math.min(edit.x,innerWidth-285)),top:Math.max(6,Math.min(edit.y,innerHeight-210))}}>
      {edit.writing?<><blockquote>{edit.note.quote}</blockquote><textarea autoFocus aria-label="注释内容" value={body} onChange={e=>setBody(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey){e.preventDefault();save()}}}/><footer>{own.some(n=>n.id===edit.note.id)?<button className="na-delete-note" onClick={()=>{onNotes(notes.filter(n=>n.id!==edit.note.id));setEdit(null);getSelection()?.removeAllRanges()}}>删除</button>:null}<button onClick={()=>setEdit(null)}>取消</button><button className="na-save-note" disabled={!body.trim()} onClick={save}>保存</button></footer></>:<><button disabled={pending} onClick={()=>setEdit({...edit,writing:true})}>添加注释</button>{onSide?<button disabled={pending} onClick={async()=>{setPending(true);setError("");try{await onSide(edit.note.quote,id);setEdit(null);getSelection()?.removeAllRanges()}catch(e){setError(userErrorText(e))}finally{setPending(false)}}}>{pending?"正在打开…":"发起侧边会话"}</button>:null}{error?<small role="alert">{error}</small>:null}</>}
    </div>,document.body)}
  </div>;
}
