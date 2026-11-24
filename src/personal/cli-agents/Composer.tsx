// Message box under a session. What it offers follows composerMode(): send
// (and interrupt while running), continue a stopped session, or a plain hint
// when the session cannot be driven from here.
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Cpu, Square, Plus, LoaderCircle, ListOrdered, ChevronDown, CircleDashed, MessageSquareText, Paperclip, Target, X, Check, CornerUpRight, Pencil, ImagePlus, Undo2 } from "lucide-react";
import { MAX_SEND_TEXT, utf8ByteLength, type CliContextUsage, type CliSessionView } from "../../../shared/cli-agents";
import { cliErrorText, uploadAttachment, type CliQueueEntry, type SendResult } from "./api";
import { imageFilesFromClipboard } from "../transcript-session";
import {fileReference,getExtras,isPickedImage,recallSent,rememberSent,saveExtras,type ComposerExtras} from "./composer-additions";
import { composerMode } from "./session-model";
import { CliModelMenu, type LaunchChoice } from "./CliModelMenu";
import { useCompactComposer } from "../components/use-compact-composer";
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
export type { LaunchChoice } from "./CliModelMenu";

/** The message box of a session that does not exist yet: sending starts it with this message (and the picked files). */
export interface ComposerStarter {
  /** the folder, CLI and computer are set */
  ready: boolean;
  /** `text` already carries the goal, skill and notes; files go up once the session runs */
  onStart(text: string, files: File[]): void;
}

/** Biggest attachment the computer accepts. */
export const ATTACH_MAX = 8 * 1024 * 1024;

export interface ComposerProps {
  draft?: SideDraftOptions;
  /** a new session: same box, sending starts it */
  starter?: ComposerStarter;
  /** what the session's computer supports (Core's device view); absent for older executors */
  features?: readonly string[];
  /** the model and effort chosen for this session, and where the choice goes */
  launch?: LaunchChoice;
  onLaunch?(next: LaunchChoice): void;
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

export function Composer({ session, onSend, onInterrupt, notes=[], onNotes, draft, starter, features, launch, onLaunch, queue=null, revision=null, onCancelRevision, onQueueWithdraw, onQueueEdit, onQueueSteer, onQueueResume }: ComposerProps) {
  const mode = draft || starter ? {kind:"send",running:false,outside:false} as const : composerMode(session);
  const review=useReview(), details=draft?undefined:review?.records[session.key];
  const model=draft?.model || details?.model || review?.models[session.engine]?.[0] || session.model?.trim() || "";
  const effort=draft?.effort || details?.effort || "标准";
  const [panel,setPanel]=useState<"add"|"skill"|"model"|"notes"|"context"|null>(null);
  const compact = useCompactComposer();
  const addTrigger = useRef<HTMLButtonElement>(null);
  const [delivery,setDelivery]=useState("queue");
  const [skill,setSkill]=useState("");
  const [editingQueue,setEditingQueue]=useState<{id:string;version:number;text:string}|null>(null);
  const running=session.state==="running"&&!draft;
  const context=draft||starter?undefined:session.context;
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
  const picker=useRef<HTMLInputElement>(null),imagePicker=useRef<HTMLInputElement>(null),goalField=useRef<HTMLInputElement>(null);
  function changeExtra(next:ComposerExtras){saveExtras(key,next);setExtra(next);setError("")}
  function addFiles(files:File[]){
    if(!files.length)return;
    if(files.some(file=>file.size>ATTACH_MAX)){setError("单个附件不能超过 8 MB");return}
    if(files.some(file=>isPickedImage(file) && file.size>5*1024*1024)){setError("图片不能超过 5 MB");return}
    const current=getExtras(key);
    if([...current.files.map(entry=>entry.file), ...files].filter(isPickedImage).length>5){setError("最多添加 5 张图片");return}
    changeExtra({...current,files:[...current.files,...files.map(file=>({id:crypto.randomUUID(),file}))]});
  }
  // edit-and-resend: the message's words (and its files, when this page sent it) come back
  // into the box like any draft; emptying the box drops the edit
  const revisionId = revision?.messageId ?? null;
  const [text, setText] = useState(() => revision?.text ?? drafts.get(key) ?? "");
  const [sending,setSending]=useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const imeEndedAt = useRef(0);
  const mounted = useRef(true);
  // outside the review fixture: the CLI's own models and effort levels
  const choice:LaunchChoice=draft?{model:draft.model,effort:draft.effort}:launch??{model:"",effort:""};
  const launchOptions=!!features?.includes("launchOptions");
  /** a Claude in a NexBot terminal switches at once (/model, /effort); anything else on its next start */
  const switchesNow=!draft && !starter && mode.kind==="send" && !mode.outside && session.engine==="claude";
  const pickerOff=!launchOptions && !switchesNow;
  const pickerNote=pickerOff ? "电脑端版本过旧，升级后可用" : draft || starter ? "" : switchesNow ? "下条消息生效" : mode.kind==="stopped" ? "继续会话时生效" : "下次在 NexBot 中继续时生效";
  const canOpenModelMenu = !!review || session.engine !== "zcode";
  function choose(next:LaunchChoice){if(draft)draft.configure(next.model,next.effort);else onLaunch?.(next)}
  function configure(nextModel:string,nextEffort:string) {
    if(draft)draft.configure(nextModel,nextEffort);
    else if(review)void run(()=>review.run("settings",session.key,{model:nextModel,effort:nextEffort}));
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!revisionId || !revision) return;
    const restored = recallSent(key, revision.text);
    const words = restored ? restored.body : revision.text;
    if (words) drafts.set(key, words); else drafts.delete(key);
    saveExtras(key, { ...getExtras(key), files: restored ? restored.files : [] });
    setText(words); setExtra(getExtras(key)); setError(""); setNote("");
    draftRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionId, key]);

  // another session: its own draft, no stale error
  useEffect(() => {
    if (revisionId) return;
    setText(drafts.get(key) ?? "");setExtra(getExtras(key));
    setError("");
    setNote("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const change = (value: string) => {
    setText(value);
    if (value) drafts.set(key, value);
    else drafts.delete(key);
    if (error) setError("");
    if (note) setNote("");
    // an edit whose words were all deleted is dropped: the message goes back in place
    if (!value && revisionId && !getExtras(key).files.length) onCancelRevision?.();
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
  // a new session may start without a message: it only opens the CLI in that folder
  const canSubmit=(starter ? starter.ready : !!(body || extra.files.length)) && (extra.goal===null || !!goal);
  const stopOnly = mode.kind==="send" && mode.running && !sending && !(body || extra.files.length);
  // 排队/引导 only applies where a turn actually runs: a nex_bot terminal session
  const wantsDelivery = !draft && session.liveIn === "nexbot" && !!session.terminal && running;
  // 排队/引导 is offered only where the choice is honoured (the review fixture, or a running nex_bot
  // terminal), and only for a message about to go while the agent is busy
  const offersDelivery = active && (!!review || wantsDelivery) && !!(body || extra.files.length) && !revision;
  // the paused note matters only while something waits in the queue
  const pausedNote = !review && queue?.paused && realQueue.length > 0;
  const submit = async () => {
    if(!canSubmit || busy || draft?.busy || tooLarge)return;
    if(starter){
      starter.onStart(body, extra.files.map(entry=>entry.file));
      drafts.delete(key);saveExtras(key,{files:[],goal:null});
      if(mounted.current){setExtra(getExtras(key));change("");setSkill("");setPanel(null);onNotes?.([])}
      return;
    }
    // The box empties at once and the message shows in the conversation (SessionPane);
    // only a failure puts it back.
    const kept={text,files:extra.files,goal:extra.goal,skill,notes,choice:delivery};
    drafts.delete(key);saveExtras(key,{files:[],goal:extra.goal});
    setText("");setExtra(getExtras(key));setSkill("");setPanel(null);if(notes.length)onNotes?.([]);
    setError("");setNote("");
    // uploads take a while: the button shows it, typing stays open
    const uploads=kept.files.length>0;
    if(uploads)setSending(true);
    let result:unknown;
    try {
      const references=[];
      // Images use Core storage even when the executor cannot upload device files.
      const upload=review?.fileUpload ? true : features?.includes("attach") ? (file:File)=>uploadAttachment(session.key,file) : false;
      for(const entry of kept.files)references.push(await fileReference(entry,session.key,upload));
      const value=[body,...references].filter(Boolean).join("\n\n");
      if(utf8ByteLength(value)>MAX_SEND_TEXT)throw Error("消息和附件内容超过可发送长度");
      rememberSent(session.key, body, kept.files);
      // a resend replaces the message the agent is on: it goes now, never into the queue
      result = active&&review&&!revision ? await review.run(kept.choice,session.key,{text:value})
        : wantsDelivery&&!revision ? await onSend(value, kept.choice as "queue"|"steer") : await onSend(value);
    } catch (cause) {
      // the message goes back in the box, unless something new was typed meanwhile
      if (!drafts.get(key) && !getExtras(key).files.length) {
        if (kept.text) drafts.set(key, kept.text);
        saveExtras(key,{files:kept.files,goal:kept.goal});
        if (kept.notes.length) onNotes?.(kept.notes);
        if (mounted.current) { setText(kept.text); setExtra(getExtras(key)); setSkill(kept.skill); }
      }
      if (mounted.current) setError(cliErrorText(cause));
      return;
    } finally {
      if (uploads && mounted.current) setSending(false);
    }
    if (!mounted.current) return;
    if(!active)setSentAt(Date.now());
    setNote(deliveryNote(result));
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
        const files=Array.from(e.currentTarget.files||[]);e.currentTarget.value="";addFiles(files);
      }}/>
      <input type="file" hidden multiple accept="image/*" ref={imagePicker} aria-label="选择图片" onChange={e=>{
        const files=Array.from(e.currentTarget.files||[]);e.currentTarget.value="";addFiles(files);
      }}/>
      {!!extra.files.length && <div className="na-file-list">{extra.files.map(entry=><span key={entry.id} className="na-file-chip" data-image={entry.file.type.startsWith("image/")||undefined}>{entry.file.type.startsWith("image/")?<FileThumb file={entry.file}/>:<Paperclip size={14}/>}<span title={entry.file.name}>{entry.file.name}</span><button type="button" disabled={busy} aria-label={"移除 "+entry.file.name} onClick={()=>changeExtra({...extra,files:extra.files.filter(f=>f.id!==entry.id)})}><X size={12}/></button></span>)}</div>}
      {extra.goal!==null && <div className="na-goal-field"><Target size={15}/><label>目标<input autoFocus ref={goalField} aria-label="会话目标" placeholder="想持续完成什么？" value={extra.goal} disabled={busy} onChange={e=>changeExtra({...extra,goal:e.target.value})}/></label><button type="button" disabled={busy} aria-label="退出目标模式" onClick={()=>changeExtra({...extra,goal:null})}><X size={13}/></button></div>}
      {draft?.quote && <details className="na-selected-fragment"><summary><MessageSquareText size={14}/>1 个已选文本片段</summary><blockquote>{draft.quote}</blockquote></details>}
      {review&&details?.queue?.map((entry,i)=><div className="na-queued" key={entry.id}>
        <span className="na-queued-label"><ListOrdered size={13}/>排队 {i+1}</span><span className="na-queued-text" title={entry.text}>{entry.text}</span>
        <span className="na-queued-actions"><button type="button" className="is-icon" aria-label="撤销" data-tip="撤销" onClick={()=>void run(()=>review.run("unqueue",session.key,{id:entry.id}))}><Undo2 size={14}/></button></span>
      </div>)}
      {pausedNote && queue ? <div className="na-queued-paused" role="status">队列已暂停{queue.pauseReason === "stopped" ? "（已停止）" : queue.pauseReason === "uncertain" ? "（结果待确认）" : queue.pauseReason === "failed" ? "（有失败条目）" : queue.pauseReason === "device_offline" ? "（电脑离线）" : ""}{onQueueResume ? <button type="button" onClick={()=>void run(onQueueResume)}>继续队列</button> : null}</div> : null}
      {!review&&realQueue.map((entry: CliQueueEntry, i) => editingQueue?.id === entry.id ? (
        <div className="na-queued na-queued-edit" key={entry.id}>
          <span className="na-queued-label"><ListOrdered size={13}/>排队 {i+1}</span>
          <textarea aria-label="编辑排队消息" autoFocus value={editingQueue.text} rows={2} onChange={(e)=>setEditingQueue({...editingQueue, text:e.target.value})}/>
          <span className="na-queued-actions">
            <button type="button" onClick={()=>setEditingQueue(null)}>取消</button>
            <button type="button" className="is-primary" onClick={()=>void run(async()=>{await onQueueEdit?.(entry.id, entry.version, editingQueue.text);setEditingQueue(null)})}>保存</button>
          </span>
        </div>
      ) : (
        <div className="na-queued" key={entry.id}>
          <span className="na-queued-label"><ListOrdered size={13}/>排队 {i+1}</span>
          <span className="na-queued-text" title={entry.text}>{entry.text}</span>
          {entry.status==="uncertain" ? <small className="na-queued-state" role="status">待确认</small> : null}
          {entry.status==="failed" && entry.errorCode ? <small className="na-queued-state" data-tone="error" role="alert">发送失败</small> : null}
          {entry.status==="pending" ? <span className="na-queued-actions">
            {onQueueSteer && running ? <button type="button" className="is-icon" aria-label="引导" data-tip="引导" onClick={()=>void run(()=>onQueueSteer(entry.id))}><CornerUpRight size={14}/></button> : null}
            {onQueueEdit ? <button type="button" className="is-icon" aria-label={"编辑排队消息 "+(i+1)} data-tip="编辑" onClick={()=>setEditingQueue({id:entry.id,version:entry.version,text:entry.text})}><Pencil size={13}/></button> : null}
            {onQueueWithdraw ? <button type="button" className="is-icon" aria-label="撤销" data-tip="撤销" onClick={()=>void run(()=>onQueueWithdraw(entry.id, entry.version))}><Undo2 size={14}/></button> : null}
          </span> : null}
        </div>
      ))}
      {skill?<button className="na-skill-chip" type="button" onClick={()=>setSkill("")}>{skill} ×</button>:null}
      {notes.length?<button className="na-skill-chip" type="button" title={notes.map(n=>n.quote+" — "+n.body).join("\n")} onClick={()=>setPanel(panel==="notes"?null:"notes")}>{notes.length} 条注释</button>:null}
      <textarea ref={draftRef} autoFocus={!!draft || !!starter} readOnly={!!draft && (busy || draft.busy)}
        aria-label="发送给 Agent 的消息"
        placeholder={starter?"要做什么？":review?"发消息，或输入 / 选择技能":draft?"发消息":"发消息，或输入 / 使用技能"}
        rows={Math.min(5, Math.max(1, text.split("\n").length))}
        value={text}
        onChange={(event) => {change(event.target.value);if(review)setPanel(/^\/\S*$/.test(event.target.value)?"skill":null)}}
        onCompositionEnd={() => { imeEndedAt.current = Date.now(); }}
        onPaste={(event) => {
          // a pasted screenshot becomes an attachment, as in the assistant's composer
          const images = imageFilesFromClipboard(event.clipboardData);
          if (!images.length) return;
          event.preventDefault();
          addFiles(images);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || Date.now() - imeEndedAt.current < 150) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if(panel==="skill"&&review){const next=review.skills.find(s=>s.startsWith(text));if(next){setSkill(next);change("");setPanel(null)}return} void submit();
          }
        }}
      />
      {panel && (panel !== "model" || review) ? <div className="na-compose-pop" data-panel={panel}>
        {panel==="add" && <div className="na-add-menu" role="group" onKeyDown={event=>{
          if(event.key!=="ArrowDown" && event.key!=="ArrowUp")return;
          event.preventDefault();const buttons=Array.from(event.currentTarget.querySelectorAll("button"));const at=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(at+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length]?.focus();
        }} aria-label="添加到消息">
          <button type="button" onClick={()=>{setPanel(null);imagePicker.current?.click()}}><ImagePlus size={16}/><span>图片</span></button>
          <button type="button" onClick={()=>{setPanel(null);picker.current?.click()}}><Paperclip size={16}/><span>文件</span></button>
          {compact && canOpenModelMenu && <button type="button" onClick={()=>{addTrigger.current?.focus();setPanel("model")}}><Cpu size={16}/><span>模型</span></button>}
          <button type="button" aria-pressed={extra.goal!==null} onClick={()=>{setPanel(null);changeExtra({...extra,goal:extra.goal===null?"":null})}}><Target size={16}/><span>目标模式</span>{extra.goal!==null && <Check size={14}/>}</button>
        </div>}
        {panel==="context"?<ContextDetail usage={context}/>:null}
        {panel==="skill"&&review?review.skills.filter(s=>!text.startsWith("/")||s.startsWith(text)).map(s=><button type="button" key={s} onClick={()=>{setSkill(s);if(text.startsWith("/"))change("");setPanel(null);draftRef.current?.focus()}}>{s}</button>):null}
        {panel==="model"&&review?<><label>模型<select aria-label="模型" value={model} onChange={e=>configure(e.target.value,effort)}>{(review.models[session.engine]??[]).map(m=><option key={m}>{m}</option>)}</select></label><label>推理强度<select aria-label="推理强度" value={effort} onChange={e=>configure(model!,e.target.value)}><option>标准</option><option>高</option></select></label></>:null}
        {panel==="notes"?notes.map(n=><div key={n.id}><b>{n.num}. {n.quote}</b><p>{n.body}</p><button type="button" onClick={()=>onNotes?.(notes.filter(v=>v.id!==n.id))}>移除</button></div>):null}
      </div>:null}
      <div className="cli-composer-actions">
        <>
          <button ref={addTrigger} type="button" className="na-add-trigger" disabled={busy || draft?.busy} aria-label="添加" title="添加" aria-expanded={panel==="add"} onClick={()=>setPanel(panel==="add"?null:"add")}><Plus size={20}/></button>
          <span className="na-grow"/>
          {draft||starter ? null : <button type="button" className="na-context" aria-label="上下文用量" title={contextSummary(context)} data-level={contextLevel(context)} aria-expanded={panel==="context"} onClick={()=>setPanel(panel==="context"?null:"context")}><ContextRing usage={context}/></button>}
          {review ? !compact && <button type="button" className="na-model-button" aria-label="模型设置" aria-expanded={panel==="model"} onClick={()=>setPanel(panel==="model"?null:"model")}>
            <span>{model}</span><span className="na-effort">{effort}</span><ChevronDown size={13}/>
          </button> : !canOpenModelMenu ? null : <CliModelMenu deviceId={session.deviceId} engine={session.engine} live={!!features?.includes("models")}
            anchorRef={compact ? addTrigger : undefined} open={panel === "model"} onOpenChange={open => setPanel(current => open ? "model" : current === "model" ? null : current)}
            choice={choice} onChange={choose} running={session.model} disabled={pickerOff} note={pickerNote}/>}
        </>
        {offersDelivery && <div className="na-delivery" role="radiogroup" aria-label="发送方式">
          {([["queue","排队"],["steer","引导"]] as const).map(([value,text])=><button key={value} type="button" role="radio" aria-checked={delivery===value} onClick={()=>setDelivery(value)}>{text}</button>)}
        </div>}
        {/* one button: Stop while a turn runs and the box is empty, Send once there is something to send */}
        {stopOnly ? <button type="button" className="na-stop" aria-label={review?"中断":"停止"} title={review?"中断":"停止当前运行并暂停队列"} disabled={busy} onClick={() => void run(onInterrupt)}><Square size={12} fill="currentColor" strokeWidth={0}/></button> : null}
        {stopOnly ? null : <button type="submit" className="primary" aria-busy={sending || !!draft?.busy} title={sending?"正在处理…":offersDelivery?(delivery==="queue"?"排队发送":"引导当前任务"):"发送"} aria-label="发送" disabled={!!draft?.busy || busy || !canSubmit || tooLarge}>{sending || draft?.busy ? <LoaderCircle className="na-busy-icon" size={17}/> : <ArrowUp size={19}/>}</button>}
      </div>
      {tooLarge ? <small role="alert" className="cli-composer-error">内容太长</small> : error ? <small role="alert" className="cli-composer-error">{error}</small> : null}
      {mode.kind==="send" && mode.outside ? <small className="cli-composer-note" role="status" data-testid="cli-composer-note">{note || OUTSIDE_NOTE}</small> : null}
    </form>
  );
}

/** Tokens in the unit people read: 8,123 below ten thousand, else 万 with one decimal. */
export function tokenText(value: number): string {
  if (value < 10_000) return value.toLocaleString("zh-CN");
  const wan = value / 10_000;
  return (wan >= 100 ? Math.round(wan).toString() : wan.toFixed(1).replace(/\.0$/, "")) + " 万";
}
export function contextShare(usage: CliContextUsage | undefined): number | null {
  return usage?.window ? Math.min(1, usage.used / usage.window) : null;
}
/** calm below 70%, a warning to 90%, then the session is about to compact */
export function contextLevel(usage: CliContextUsage | undefined): "none" | "low" | "high" | "full" {
  const share = contextShare(usage);
  return share === null ? "none" : share >= 0.9 ? "full" : share >= 0.7 ? "high" : "low";
}
export function contextSummary(usage: CliContextUsage | undefined): string {
  if (!usage) return "上下文用量：暂无记录";
  const share = contextShare(usage);
  return share === null ? `上下文已用 ${tokenText(usage.used)}` : `上下文 ${Math.round(share * 100)}% · ${tokenText(usage.used)} / ${tokenText(usage.window!)}`;
}

/** The share of the window the last request used, as a ring; dashed while nothing is known. */
function ContextRing({ usage }: { usage: CliContextUsage | undefined }) {
  const share = contextShare(usage);
  if (share === null) return <CircleDashed size={15}/>;
  const r = 6.5, length = 2 * Math.PI * r;
  return <svg className="na-context-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="na-context-track"/>
    <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" strokeLinecap="round" className="na-context-fill"
      strokeDasharray={`${Math.max(0.6, share * length)} ${length}`} transform="rotate(-90 8 8)"/>
  </svg>;
}

function ContextDetail({ usage }: { usage: CliContextUsage | undefined }) {
  if (!usage) return <div className="na-context-detail"><b>上下文用量</b><small role="status">还没有记录：会话回复过一次后显示</small></div>;
  const share = contextShare(usage);
  return <div className="na-context-detail" data-level={contextLevel(usage)}>
    <div className="na-context-head"><b>上下文</b>{share === null ? null : <strong>{Math.round(share * 100)}%</strong>}</div>
    {share === null ? null : <div className="na-context-bar"><span style={{ width: `${Math.max(2, share * 100)}%` }}/></div>}
    <small>{share === null ? `已用 ${tokenText(usage.used)} tokens` : `已用 ${tokenText(usage.used)} / ${tokenText(usage.window!)} tokens`}</small>
  </div>;
}

/** A small preview of an image about to be sent. A data: URL, since the page's CSP refuses blob: images. */
function FileThumb({file}:{file:File}) {
  const [url,setUrl]=useState("");
  useEffect(()=>{
    let live=true;const reader=new FileReader();
    reader.onload=()=>{if(live&&typeof reader.result==="string")setUrl(reader.result)};
    reader.readAsDataURL(file);
    return ()=>{live=false;reader.abort()};
  },[file]);
  return url?<img className="na-file-thumb" src={url} alt=""/>:<Paperclip size={14}/>;
}
