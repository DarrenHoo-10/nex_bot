// Message box under a session. What it offers follows composerMode(): send
// (and interrupt while running), continue a stopped session, or a plain hint
// when the session cannot be driven from here.
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square, Plus, LoaderCircle, ListOrdered, ChevronDown, CircleDashed, MessageSquareText, Paperclip, Target, X, Check, CornerUpRight, Pencil } from "lucide-react";
import { MAX_SEND_TEXT, utf8ByteLength, type CliSessionView } from "../../../shared/cli-agents";
import { cliErrorText, type CliQueueEntry, type SendResult } from "./api";
import {fileReference,getExtras,saveExtras,type ComposerExtras} from "./composer-additions";
import { composerMode } from "./session-model";
import type { CliQueue } from "./api";

// Drafts live as long as the page, one per session.
const drafts = new Map<string, string>();

export function discardComposerDraft(id:string){ drafts.delete(id);saveExtras(id,{files:[],goal:null}); }

export const OUTSIDE_NOTE = "发送到电脑上的会话";
export const UNCONFIRMED_NOTE = "已发送，未确认";
export const WAITING_NOTE = "将在电脑上回答问题后读取";

/** What a send to a session outside nex_bot's terminals adds to the status line; a confirmed one says nothing more. */
export function deliveryNote(result: unknown): string {
  const sent = (result && typeof result === "object" ? result : {}) as Partial<SendResult>;
  return [sent.delivery === "unconfirmed" ? UNCONFIRMED_NOTE : "", sent.waiting ? WAITING_NOTE : ""].filter(Boolean).join("，");
}

import { useReview, type Note } from "./WorkbenchReview";

export interface SideDraftOptions {
  id:string; quote:string; model:string; effort:string;
  busy?:boolean;
  configure(model:string,effort:string):void;
}
export interface ComposerProps {
  draft?: SideDraftOptions;
  notes?:Note[];
  onNotes?(notes:Note[]):void;
  session: CliSessionView;
  onSend(text: string, delivery?: "send"|"queue"|"steer"): Promise<unknown>;
  onInterrupt(): Promise<unknown>;
  /** the session's live outbox; queued entries show, edit, withdraw and steer here */
  queue?: CliQueue | null;
  /** an edit-and-resend the transcript asked for; null closes it */
  revision?: { messageId: string; text: string } | null;
  onCancelRevision?(): void;
  onQueueWithdraw?(entryId: string, version: number): Promise<void>;
  onQueueEdit?(entryId: string, version: number, text: string): Promise<void>;
  onQueueSteer?(entryId: string): Promise<void>;
  onQueueResume?(): Promise<void>;
}

export function Composer({ session, onSend, onInterrupt, notes=[], onNotes, draft, queue=null, revision=null, onCancelRevision, onQueueWithdraw, onQueueEdit, onQueueSteer, onQueueResume }: ComposerProps) {
  const mode = draft ? {kind:"send",running:false,outside:false} as const : composerMode(session);
  const review=useReview(), details=draft?undefined:review?.records[session.key];
  const model=draft?.model || details?.model || review?.models[session.engine]?.[0] || session.model?.trim() || "";
  const effort=draft?.effort || details?.effort || "标准";
  const [panel,setPanel]=useState<"add"|"skill"|"model"|"notes"|"context"|null>(null);
  const [delivery,setDelivery]=useState("queue");
  const [skill,setSkill]=useState("");
  const [editingQueue,setEditingQueue]=useState<{id:string;version:number;text:string}|null>(null);
  const running=session.state==="running"&&!draft;
  const [sentAt,setSentAt]=useState(0);
  const active=!draft && (running||(!!review&&sentAt>Date.now()-9000));
  const realQueue = !draft ? (queue?.entries ?? []).filter(entry=>entry.status==="pending"||entry.status==="uncertain") : [];
  const draftRef=useRef<HTMLTextAreaElement>(null);
  const formRef=useRef<HTMLFormElement>(null);
  useEffect(()=>{
    if(!panel)return;
    if(panel==="add")formRef.current?.querySelector<HTMLButtonElement>(".na-add-menu button")?.focus();
    const dismiss=(e:PointerEvent)=>{if(!formRef.current?.contains(e.target as Node))setPanel(null)};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"){setPanel(null);if(panel==="add")formRef.current?.querySelector<HTMLButtonElement>(".na-add-trigger")?.focus();else draftRef.current?.focus()}};
    document.addEventListener("pointerdown",dismiss);
    document.addEventListener("keydown",escape);
    return ()=>{document.removeEventListener("pointerdown",dismiss);document.removeEventListener("keydown",escape)};
  },[panel]);
  const key = draft?.id ?? session.key;
  const [extra,setExtra]=useState(()=>getExtras(key));
  const picker=useRef<HTMLInputElement>(null),goalField=useRef<HTMLInputElement>(null);
  function changeExtra(next:ComposerExtras){saveExtras(key,next);setExtra(next);setError("")}
  // edit-and-resend: the original text loads in place; cancelling restores the
  // draft the user had, sending leaves the box empty like any send
  const revisionStash = useRef<string | null>(null);
  const revisionSent = useRef(false);
  const revisionId = revision?.messageId ?? null;
  const [text, setText] = useState(() => revision?.text ?? drafts.get(key) ?? "");
  const [sending,setSending]=useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const imeEndedAt = useRef(0);
  const mounted = useRef(true);
  function configure(nextModel:string,nextEffort:string) {
    if(draft)draft.configure(nextModel,nextEffort);
    else if(review)void run(()=>review.run("settings",session.key,{model:nextModel,effort:nextEffort}));
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (revisionId && revision) {
      if (revisionStash.current === null) revisionStash.current = drafts.get(key) ?? "";
      revisionSent.current = false;
      setText(revision.text);
    } else if (!revisionId) {
      if (revisionSent.current) {
        revisionStash.current = null;
        revisionSent.current = false;
        return;
      }
      if (revisionStash.current !== null) {
        const restore = revisionStash.current;
        revisionStash.current = null;
        if (!drafts.get(key) && restore) { drafts.set(key, restore); setText(restore); }
      }
    }
  }, [revisionId, revision, key]);

  // another session: its own draft, no stale error. An active revision holds
  // the box; when it clears, the draft (restored on cancel, emptied on send) applies.
  useEffect(() => {
    if (revisionId) return;
    setText(drafts.get(key) ?? "");setExtra(getExtras(key));
    setError("");
    setNote("");
  }, [key, revisionId]);

  const change = (value: string) => {
    setText(value);
    if (value) drafts.set(key, value);
    else drafts.delete(key);
    if (error) setError("");
    if (note) setNote("");
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      return { result: await action() };
    } catch (cause) {
      if (mounted.current) setError(cliErrorText(cause));
      return null;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const goal=extra.goal?.trim();
  const body=[goal?"当前目标："+goal:"",skill,text.trim(),...notes.map(n=>"引用「"+n.quote+"」\n注释："+n.body)].filter(Boolean).join("\n\n");
  const tooLarge=utf8ByteLength(body)>MAX_SEND_TEXT;
  const canSubmit=!!(body || extra.files.length) && (extra.goal===null || !!goal);
  // 排队/引导 only applies where a turn actually runs: a nex_bot terminal session
  const wantsDelivery = !draft && session.liveIn === "nexbot" && !!session.terminal && running;
  // 排队/引导 is offered only where the choice is honoured: the review fixture, or a running nex_bot terminal
  const offersDelivery = active && (!!review || wantsDelivery);
  // the paused note matters only while something waits in the queue
  const pausedNote = !review && queue?.paused && realQueue.length > 0;
  const submit = async () => {
    if(!canSubmit || busy || draft?.busy || tooLarge)return;
    setSending(true);
    if (revisionId) revisionSent.current = true;
    const sent=await run(async()=>{
      const references=[];
      for(const file of extra.files)references.push(await fileReference(file,session.key,!!review?.fileUpload));
      const value=[body,...references].filter(Boolean).join("\n\n");
      if(utf8ByteLength(value)>MAX_SEND_TEXT)throw Error("消息和附件内容超过可发送长度");
      if(active&&review)return review.run(delivery,session.key,{text:value});
      return wantsDelivery ? onSend(value, delivery as "queue"|"steer") : onSend(value);
    });
    if(mounted.current)setSending(false);
    if (!sent) return;
    const sameDraft=(drafts.get(key) ?? "")===text;
    if(sameDraft)drafts.delete(key);
    saveExtras(key,{files:[],goal:extra.goal});
    if (!mounted.current) { if(notes.length)onNotes?.([]); return; }
    setExtra(getExtras(key));if(sameDraft){change("");setPanel(null)}setSkill("");onNotes?.([]);if(!active)setSentAt(Date.now());
    setNote(deliveryNote(sent.result));
  };

  if (mode.kind === "blocked") {
    return <div className="cli-composer is-blocked" data-testid="cli-composer" role="status"><span>{mode.hint}</span></div>;
  }
  if (mode.kind === "stopped" && mode.hint) {
    return <div className="cli-composer is-blocked" role="status">{mode.hint}</div>;
  }
  return (
    <form ref={formRef} className="cli-composer na-message-box" data-testid="cli-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <input type="file" hidden multiple ref={picker} aria-label="选择文件" onChange={e=>{
        const files=Array.from(e.currentTarget.files||[]);e.currentTarget.value="";
        if(files.some(file=>file.size>32*1024*1024)){setError("单个附件不能超过 32 MB");return}
        if(files.length)changeExtra({...extra,files:[...extra.files,...files.map(file=>({id:crypto.randomUUID(),file}))]});
      }}/>
      {!!extra.files.length && <div className="na-file-list">{extra.files.map(entry=><span key={entry.id} className="na-file-chip"><Paperclip size={14}/><span title={entry.file.name}>{entry.file.name}</span><button type="button" disabled={busy} aria-label={"移除 "+entry.file.name} onClick={()=>changeExtra({...extra,files:extra.files.filter(f=>f.id!==entry.id)})}><X size={12}/></button></span>)}</div>}
      {extra.goal!==null && <div className="na-goal-field"><Target size={15}/><label>目标<input autoFocus ref={goalField} aria-label="会话目标" placeholder="想持续完成什么？" value={extra.goal} disabled={busy} onChange={e=>changeExtra({...extra,goal:e.target.value})}/></label><button type="button" disabled={busy} aria-label="退出目标模式" onClick={()=>changeExtra({...extra,goal:null})}><X size={13}/></button></div>}
      {draft?.quote && <details className="na-selected-fragment"><summary><MessageSquareText size={14}/>1 个已选文本片段</summary><blockquote>{draft.quote}</blockquote></details>}
      {revision ? <div className="na-revising" role="status"><Pencil size={13}/>正在编辑已发送消息，发送后将作为新消息重发
        <button type="button" aria-label="取消编辑重发" onClick={() => { if (revisionStash.current !== null) drafts.set(key, revisionStash.current); revisionStash.current = null; onCancelRevision?.(); setText(drafts.get(key) ?? ""); }}><X size={12}/>取消</button></div> : null}
      {review&&details?.queue?.map((entry,i)=><div className="na-queued" key={entry.id}><ListOrdered size={14}/>排队 {i+1} · {entry.text}<button type="button" onClick={()=>void run(()=>review.run("unqueue",session.key,{id:entry.id}))}>撤回</button></div>)}
      {pausedNote && queue ? <div className="na-queued-paused" role="status">队列已暂停{queue.pauseReason === "stopped" ? "（已停止）" : queue.pauseReason === "uncertain" ? "（结果待确认）" : queue.pauseReason === "failed" ? "（有失败条目）" : queue.pauseReason === "device_offline" ? "（电脑离线）" : ""}{onQueueResume ? <button type="button" onClick={()=>void run(onQueueResume)}>继续队列</button> : null}</div> : null}
      {!review&&realQueue.map((entry: CliQueueEntry, i) => editingQueue?.id === entry.id ? (
        <div className="na-queued na-queued-edit" key={entry.id}>
          <ListOrdered size={14}/>排队 {i+1}
          <textarea aria-label="编辑排队消息" value={editingQueue.text} rows={2} onChange={(e)=>setEditingQueue({...editingQueue, text:e.target.value})}/>
          <button type="button" onClick={()=>void run(async()=>{await onQueueEdit?.(entry.id, entry.version, editingQueue.text);setEditingQueue(null)})}>保存</button>
          <button type="button" onClick={()=>setEditingQueue(null)}>取消</button>
        </div>
      ) : (
        <div className="na-queued" key={entry.id}>
          <ListOrdered size={14}/>排队 {i+1} · {entry.text}
          {entry.status==="uncertain" ? <small role="status">待确认</small> : null}
          {entry.status==="failed" && entry.errorCode ? <small role="alert">发送失败</small> : null}
          {entry.status==="pending" && onQueueEdit ? <button type="button" aria-label={"编辑排队消息 "+(i+1)} onClick={()=>setEditingQueue({id:entry.id,version:entry.version,text:entry.text})}><Pencil size={12}/></button> : null}
          {entry.status==="pending" && onQueueWithdraw ? <button type="button" onClick={()=>void run(()=>onQueueWithdraw(entry.id, entry.version))}>撤回</button> : null}
          {entry.status==="pending" && onQueueSteer && running ? <button type="button" onClick={()=>void run(()=>onQueueSteer(entry.id))}><CornerUpRight size={12}/>立即引导</button> : null}
        </div>
      ))}
      {skill?<button className="na-skill-chip" type="button" onClick={()=>setSkill("")}>{skill} ×</button>:null}
      {notes.length?<button className="na-skill-chip" type="button" title={notes.map(n=>n.quote+" — "+n.body).join("\n")} onClick={()=>setPanel(panel==="notes"?null:"notes")}>{notes.length} 条注释</button>:null}
      <textarea ref={draftRef} autoFocus={!!draft} readOnly={!!draft && (busy || draft.busy)}
        aria-label="发送给 Agent 的消息"
        placeholder={review?"发消息，或输入 / 选择技能":draft?"发消息":"发消息，或输入 / 使用技能"}
        rows={Math.min(5, Math.max(1, text.split("\n").length))}
        value={text}
        onChange={(event) => {change(event.target.value);if(review)setPanel(/^\/\S*$/.test(event.target.value)?"skill":null)}}
        onCompositionEnd={() => { imeEndedAt.current = Date.now(); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || Date.now() - imeEndedAt.current < 150) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if(panel==="skill"&&review){const next=review.skills.find(s=>s.startsWith(text));if(next){setSkill(next);change("");setPanel(null)}return} void submit();
          }
        }}
      />
      {panel?<div className="na-compose-pop" data-panel={panel}>
        {panel==="add" && <div className="na-add-menu" role="group" onKeyDown={event=>{
          if(event.key!=="ArrowDown" && event.key!=="ArrowUp")return;
          event.preventDefault();const buttons=Array.from(event.currentTarget.querySelectorAll("button"));const at=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(at+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length]?.focus();
        }} aria-label="添加到消息">
          <button type="button" onClick={()=>{setPanel(null);picker.current?.click()}}><Paperclip size={16}/><span>文件</span></button>
          <button type="button" aria-pressed={extra.goal!==null} onClick={()=>{setPanel(null);changeExtra({...extra,goal:extra.goal===null?"":null})}}><Target size={16}/><span>目标模式</span>{extra.goal!==null && <Check size={14}/>}</button>
        </div>}
        {panel==="context"?<small role="status">当前 Harness 未提供上下文用量</small>:null}
        {panel==="skill"&&review?review.skills.filter(s=>!text.startsWith("/")||s.startsWith(text)).map(s=><button type="button" key={s} onClick={()=>{setSkill(s);if(text.startsWith("/"))change("");setPanel(null);draftRef.current?.focus()}}>{s}</button>):null}
        {panel==="model"&&review?<><label>模型<select aria-label="模型" value={model} onChange={e=>configure(e.target.value,effort)}>{(review.models[session.engine]??[]).map(m=><option key={m}>{m}</option>)}</select></label><label>推理强度<select aria-label="推理强度" value={effort} onChange={e=>configure(model!,e.target.value)}><option>标准</option><option>高</option></select></label></>:null}
        {panel==="notes"?notes.map(n=><div key={n.id}><b>{n.num}. {n.quote}</b><p>{n.body}</p><button type="button" onClick={()=>onNotes?.(notes.filter(v=>v.id!==n.id))}>移除</button></div>):null}
      </div>:null}
      <div className="cli-composer-actions">
        <>
          <button type="button" className="na-add-trigger" disabled={busy || draft?.busy} aria-label="添加" title="添加" aria-expanded={panel==="add"} onClick={()=>setPanel(panel==="add"?null:"add")}><Plus size={20}/></button>
          <span className="na-grow"/>
          <button type="button" className="na-context" aria-label="上下文用量" title="查看上下文用量" aria-expanded={panel==="context"} onClick={()=>setPanel(panel==="context"?null:"context")}><CircleDashed size={15}/></button>
          {review ? <button type="button" className="na-model-button" aria-label="模型设置" aria-expanded={panel==="model"} onClick={()=>setPanel(panel==="model"?null:"model")}>
            <span>{model}</span><span className="na-effort">{effort}</span><ChevronDown size={13}/>
          </button> : model ? <span className="na-model-label" title="当前模型">{model}</span> : null}
        </>
        {offersDelivery && <div className="na-delivery" role="radiogroup" aria-label="发送方式">
          {([["queue","排队"],["steer","引导"]] as const).map(([value,text])=><button key={value} type="button" role="radio" aria-checked={delivery===value} onClick={()=>setDelivery(value)}>{text}</button>)}
        </div>}
        {mode.kind==="send" && mode.running ? <button type="button" className="na-stop" aria-label={review?"中断":"停止"} title={review?"中断":"停止当前运行并暂停队列"} disabled={busy} onClick={() => void run(onInterrupt)}><Square size={12} fill="currentColor" strokeWidth={0}/></button> : null}
        <button type="submit" className="primary" aria-busy={sending || !!draft?.busy} title={sending?"正在处理…":offersDelivery?(delivery==="queue"?"排队发送":"引导当前任务"):"发送"} aria-label="发送" disabled={!!draft?.busy || busy || !canSubmit || tooLarge}>{sending || draft?.busy ? <LoaderCircle className="na-busy-icon" size={17}/> : <ArrowUp size={19}/>}</button>
      </div>
      {tooLarge ? <small role="alert" className="cli-composer-error">内容太长</small> : error ? <small role="alert" className="cli-composer-error">{error}</small> : null}
      {mode.kind==="send" && mode.outside ? <small className="cli-composer-note" role="status" data-testid="cli-composer-note">{note || OUTSIDE_NOTE}</small> : null}
    </form>
  );
}
