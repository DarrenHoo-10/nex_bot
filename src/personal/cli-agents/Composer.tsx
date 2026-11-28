// Message box under a session. What it offers follows composerMode(): send
// (and interrupt while running), continue a stopped session, or a plain hint
// when the session cannot be driven from here.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, BookOpen, Square, Plus, LoaderCircle, ListOrdered, ChevronDown, CircleDashed, MessageSquareText, Paperclip, Target, X, Check, CornerUpRight, Pencil, ImagePlus, Undo2, Shield, ChevronRight } from "lucide-react";
import { MAX_SEND_TEXT, cliPermissionLabel, utf8ByteLength, type CliContextUsage, type CliPermissionMode, type CliSessionView } from "../../../shared/cli-agents";
import { cliErrorText, fetchSkills, uploadAttachment, type CliQueueEntry, type SendResult } from "./api";
import { desktop } from "../api";
import { imageFilesFromClipboard } from "../transcript-session";
import {attachmentPreview,attachmentReferences,getExtras,isPickedImage,recallSent,rememberSent,saveExtras,type ComposerExtras} from "./composer-additions";
import { composerMode } from "./session-model";
import { SkillPicker } from "../components/SkillPicker";
import { CliModelMenu, type LaunchChoice } from "./CliModelMenu";
import { useCompactComposer } from "../components/use-compact-composer";
import { formatCompactTokens } from "../../lib/token-count";
import type { CliQueue } from "./api";
import { isVisibleQueueEntry } from "./use-queue";
import { ImageLightbox } from "../components/ImageLightbox";

// Drafts live as long as the page, one per session.
const drafts = new Map<string, string>();

export function discardComposerDraft(id:string){ drafts.delete(id);saveExtras(id,{files:[],goal:null}); }

export const OUTSIDE_NOTE = "发送到电脑上的会话";
export const UNCONFIRMED_NOTE = "已发送，未确认";
export const NATIVE_QUEUED_NOTE = "Codex 已接收，等待开始";
export const WAITING_NOTE = "将在电脑上回答问题后读取";

/** What a send to a session outside nex_bot's terminals adds to the status line; a confirmed one says nothing more. */
export function deliveryNote(result: unknown): string {
  const sent = (result && typeof result === "object" ? result : {}) as Partial<SendResult>;
  if (sent.nativeQueued) return NATIVE_QUEUED_NOTE;
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
  onUploadPreview?(text: string | null): void;
  onInterrupt(): Promise<unknown>;
  /** the session's live outbox; queued entries show, edit, withdraw and steer here */
  queue?: CliQueue | null;
  guided?: ReadonlySet<string>;
  /** an edit-and-resend the transcript asked for; null closes it */
  revision?: { messageId: string; text: string } | null;
  onCancelRevision?(): void;
  onQueueWithdraw?(entryId: string, version: number): Promise<void>;
  onQueueEdit?(entryId: string, version: number, text: string): Promise<void>;
  steerQuestionId?: string;
  interruptWaiting?: boolean;
  onQueueSteer?(entryId: string, version: number): Promise<void>;
  onQueueResume?(): Promise<void>;
  /** an open session's permission modes (its CLI's own), chosen from the + menu; `pending` until the CLI took the choice */
  permissions?: { modes: readonly CliPermissionMode[]; value?: CliPermissionMode; pending?: string; onChange(mode: CliPermissionMode): void };
}

export function Composer({ session, onSend, onUploadPreview, onInterrupt, notes=[], onNotes, draft, starter, features, launch, onLaunch, queue=null, guided, revision=null, onCancelRevision, onQueueWithdraw, onQueueEdit, steerQuestionId, interruptWaiting, onQueueSteer, permissions, onQueueResume }: ComposerProps) {
  const mode = draft || starter ? {kind:"send",running:false,outside:false} as const : composerMode(session);
  const review=useReview(), details=draft?undefined:review?.records[session.key];
  const model=draft?.model || details?.model || review?.models[session.engine]?.[0] || session.model?.trim() || "";
  const effort=draft?.effort || details?.effort || "标准";
  const [panel,setPanel]=useState<"add"|"skill"|"model"|"notes"|"context"|"permissions"|null>(null);
  const compact = useCompactComposer();
  const modelTrigger = compact ? "na-model-button na-model-chip" : "na-model-button";
  const [slashSearch, setSlashSearch] = useState(false);
  const skillKey = starter ? undefined : session.key;
  const previewSkills = review?.skills;
  const canListSkills = !!previewSkills || features?.includes("skills");
  const loadSkills = useCallback(async (signal: AbortSignal) => {
    if (previewSkills) return previewSkills.map(name => ({ name: name.replace(/^[/\u0024]/, ""), description: "" }));
    if (!canListSkills) throw new Error("请更新会话所在电脑的客户端后使用技能");
    return fetchSkills(session.deviceId, session.engine, session.cwd, skillKey, signal);
  }, [previewSkills, canListSkills, session.deviceId, session.engine, session.cwd, skillKey]);
  const [skill,setSkill]=useState("");
  const [editingQueue,setEditingQueue]=useState<{id:string;version:number;text:string}|null>(null);
  const running=session.state==="running"&&!draft;
  const context=draft||starter?undefined:session.context;
  const [sentAt,setSentAt]=useState(0);
  const active=!draft && (running||!!steerQuestionId||interruptWaiting||(!!review&&sentAt>Date.now()-9000));
  const realQueue = !draft ? (queue?.entries ?? []).filter(entry => isVisibleQueueEntry(entry) && !guided?.has(entry.id)) : [];
  const draftRef=useRef<HTMLTextAreaElement>(null);
  const formRef=useRef<HTMLFormElement>(null);
  useEffect(()=>{
    if(!panel)return;
    if(panel==="add")formRef.current?.querySelector<HTMLButtonElement>(".na-add-menu button")?.focus();
    // A press anywhere but the open panel and the button that opened it closes the panel, the
    // message field included. The CLI model menu is its own popover and closes itself.
    const dismiss=(e:Event)=>{
      if(panel==="model"&&!review)return;
      const form=formRef.current,target=e.target as Node;
      const inside=[form?.querySelector(".na-compose-pop"),form?.querySelector(`[data-panel-trigger="${panel}"]`),panel==="skill"?draftRef.current:null];
      if(!inside.some(node=>node?.contains(target)))setPanel(null);
    };
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"){setPanel(null);if(panel==="add")formRef.current?.querySelector<HTMLButtonElement>(".na-add-trigger")?.focus();else draftRef.current?.focus()}};
    document.addEventListener("pointerdown",dismiss,true);
    document.addEventListener("click",dismiss,true);
    document.addEventListener("keydown",escape);
    return ()=>{document.removeEventListener("pointerdown",dismiss,true);document.removeEventListener("click",dismiss,true);document.removeEventListener("keydown",escape)};
  },[panel,review]);
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
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const imeEndedAt = useRef(0);
  const mounted = useRef(true);
  // a steer that could not join the turn leaves its note until the message has gone out from the queue
  const steered = useRef<string | null>(null);
  useEffect(() => {
    const id = steered.current;
    if (!id || queue?.entries.some((entry) => entry.id === id && entry.status === "pending")) return;
    steered.current = null;
    setError("");
  }, [queue]);
  // outside the review fixture: the CLI's own models and effort levels
  const choice:LaunchChoice=draft?{model:draft.model,effort:draft.effort}:launch??{model:"",effort:""};
  const launchOptions=!!features?.includes("launchOptions");
  /** a Claude in a NexBot terminal switches at once (/model, /effort); anything else on its next start */
  const switchesNow=!draft && !starter && mode.kind==="send" && !mode.outside && session.engine==="claude";
  const managedProtocol = !draft && (session.sendVia === "acp" || (session.sendVia === "host" && session.liveIn === "background"));
  const protocolModelBlocked = !starter && !draft && (session.engine === "agy" || session.engine === "zcode") && session.state !== "stopped" && (!managedProtocol || session.state !== "idle");
  const pickerOff=(!launchOptions && !switchesNow) || protocolModelBlocked;
  const pickerNote=protocolModelBlocked ? (managedProtocol ? "会话空闲时可更改模型" : session.engine === "agy" ? "可在终端里更改模型" : "当前无法更改模型") : pickerOff ? "电脑端版本过旧，升级后可用" : "";
  const canOpenModelMenu = true;
  function choose(next:LaunchChoice){if(draft)draft.configure(next.model,next.effort);else onLaunch?.(next)}
  function configure(nextModel:string,nextEffort:string) {
    if(draft)draft.configure(nextModel,nextEffort);
    else if(review)void run(()=>review.run("settings",session.key,{model:nextModel,effort:nextEffort}));
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // In the Windows Electron client, image-only Ctrl+V is intercepted in main (`nex-client-clipboard.mjs`)
  // and forwarded via `onClipboardImage` so screenshots paste directly into the NexAgent composer.
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const pasteBlockedRef = useRef(false);
  pasteBlockedRef.current = busy || !!draft?.busy;
  const isSideDraftRef = useRef(false);
  isSideDraftRef.current = !!draft;
  useEffect(() => {
    const bridge = (window as unknown as { nex?: typeof desktop }).nex ?? desktop;
    return bridge?.onClipboardImage?.((image) => {
      const form = formRef.current;
      if (!form || !form.isConnected || pasteBlockedRef.current) return;
      if (form.closest("[hidden], [inert], [aria-hidden='true']")) return;
      const activeEl = document.activeElement;
      if (isSideDraftRef.current && (!activeEl || !form.contains(activeEl))) return;
      if (activeEl && activeEl !== document.body && !form.contains(activeEl)) {
        if (activeEl.closest(".cli-term, input, textarea, [contenteditable='true']")) return;
      }
      const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array();
      if (!bytes.byteLength || !image.type.startsWith("image/")) return;
      const blob = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(blob).set(bytes);
      addFilesRef.current([new File([blob], image.name.trim() || "截图.png", { type: image.type })]);
    });
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
  const invocation = skill && mode.kind === "send" && mode.outside && session.sendVia === "inbox" ? `请调用 Skill 工具使用「${skill.slice(1)}」技能。` : skill;
  const body=[invocation,goal?"当前目标："+goal:"",text.trim(),...notes.map(n=>"引用「"+n.quote+"」\n注释："+n.body)].filter(Boolean).join("\n\n");
  const tooLarge=utf8ByteLength(body)>MAX_SEND_TEXT;
  // a new session may start without a message: it only opens the CLI in that folder
  const canSubmit=(starter ? starter.ready : !!(body || extra.files.length)) && (extra.goal===null || !!goal);
  const stopOnly = mode.kind==="send" && mode.running && !sending && !(body || extra.files.length);
  const managedTerminal = !draft && session.liveIn === "nexbot" && !!session.terminal;
  const claudeInbox = !draft && session.engine === "claude" && session.sendVia === "inbox";
  const queuesWhileBusy = !revision && (managedTerminal || managedProtocol || claudeInbox) && (running || session.state === "waiting");
  const canSteer = session.online && queue?.pauseReason !== "stopped" && (
    (managedTerminal && (steerQuestionId || interruptWaiting)) || (running && (managedTerminal || (managedProtocol && session.state === "running") || (claudeInbox && features?.includes("inboxSteer"))))
  );
  const steerLabel = steerQuestionId ? "取消提问并引导" : interruptWaiting ? "中断并引导" : "引导";
  // the paused note matters only while something waits in the queue
  const pausedNote = !review && queue?.paused && realQueue.length > 0;
  const submit = async () => {
    if(!canSubmit || submitting.current || busy || draft?.busy || tooLarge)return;
    if(starter){
      starter.onStart(body, extra.files.map(entry=>entry.file));
      drafts.delete(key);saveExtras(key,{files:[],goal:null});
      if(mounted.current){setExtra(getExtras(key));change("");setSkill("");setPanel(null);onNotes?.([])}
      return;
    }
    // The box empties at once and the message shows in the conversation (SessionPane);
    // only a failure puts it back.
    const kept={text,files:extra.files,goal:extra.goal,skill,notes};
    drafts.delete(key);saveExtras(key,{files:[],goal:extra.goal});
    setText("");setExtra(getExtras(key));setSkill("");setPanel(null);if(notes.length)onNotes?.([]);
    setError("");setNote("");
    // uploads take a while: the button shows it, typing stays open
    const uploads=kept.files.length>0;
    submitting.current = true;
    setSending(true);
    if (uploads) onUploadPreview?.(attachmentPreview(body, kept.files.map(entry => entry.file)));
    let result:unknown;
    try {
      // Images use Core storage even when the executor cannot upload device files.
      const upload=review?.fileUpload ? true : features?.includes("attach") ? (file:File)=>uploadAttachment(session.key,file) : false;
      const references = uploads ? await attachmentReferences(kept.files, session.key, upload) : [];
      const value=[body,...references].filter(Boolean).join("\n\n");
      if(utf8ByteLength(value)>MAX_SEND_TEXT)throw Error("消息和附件内容超过可发送长度");
      rememberSent(session.key, body, kept.files);
      if (uploads) onUploadPreview?.(null);
      // a resend replaces the message the agent is on: it goes now, never into the queue
      result = active&&review&&!revision ? await review.run("queue",session.key,{text:value})
        : queuesWhileBusy ? await onSend(value, "queue") : await onSend(value);
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
      submitting.current = false;
      if (mounted.current) {
        if (uploads) onUploadPreview?.(null);
        setSending(false);
      }
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
      {!!extra.files.length && <div className="na-file-list">{extra.files.map(entry=>{
        const remove=()=>changeExtra({...extra,files:extra.files.filter(f=>f.id!==entry.id)});
        // images show only their thumbnail, which opens the picture; other files keep their name
        return entry.file.type.startsWith("image/")?<ImageDraft key={entry.id} file={entry.file} busy={busy} onRemove={remove}/>
          :<span key={entry.id} className="na-file-chip"><Paperclip size={14}/><span title={entry.file.name}>{entry.file.name}</span><button type="button" disabled={busy} aria-label={"移除 "+entry.file.name} onClick={remove}><X size={12}/></button></span>;
      })}</div>}
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
          {entry.status==="failed" ? <small className="na-queued-state" data-tone="error" role="alert">{session.engine === "codex" && entry.errorCode === "read_only" ? "消息未发送，请检查 Codex 终端" : "发送失败"}</small> : null}
          {entry.status==="pending" || entry.status==="failed" ? <span className="na-queued-actions">
            {entry.status==="pending" && onQueueSteer && canSteer ? <button type="button" onClick={()=>{steered.current=entry.id;void run(()=>onQueueSteer(entry.id, entry.version)).then(done=>{if(done)steered.current=null})}}><CornerUpRight size={14} aria-hidden="true"/>{steerLabel}</button> : null}
            {onQueueEdit ? <button type="button" className="is-icon" aria-label={"编辑排队消息 "+(i+1)} data-tip="编辑" onClick={()=>setEditingQueue({id:entry.id,version:entry.version,text:entry.text})}><Pencil size={13}/></button> : null}
            {onQueueWithdraw ? <button type="button" className="is-icon" aria-label="撤销" data-tip="撤销" onClick={()=>void run(()=>onQueueWithdraw(entry.id, entry.version))}><Undo2 size={14}/></button> : null}
          </span> : null}
        </div>
      ))}
      {skill?<button className="na-skill-chip" type="button" onClick={()=>setSkill("")}>{skill} ×</button>:null}
      {notes.length?<button className="na-skill-chip" type="button" data-panel-trigger="notes" title={notes.map(n=>n.quote+" — "+n.body).join("\n")} onClick={()=>setPanel(panel==="notes"?null:"notes")}>{notes.length} 条注释</button>:null}
      <textarea ref={draftRef} autoFocus={!!draft || !!starter} readOnly={!!draft && (busy || draft.busy)}
        aria-label="发送给 Agent 的消息"
        placeholder={starter?"要做什么？":review?"发消息，或输入 / 选择技能":draft?"发消息":"发消息，或输入 / 使用技能"}
        rows={Math.min(5, Math.max(1, text.split("\n").length))}
        value={text}
        onChange={(event) => {change(event.target.value);const slash = !!canListSkills && /^\/\S*$/.test(event.target.value); setSlashSearch(slash); setPanel(slash ? "skill" : null)}}
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
            void submit();
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
          {(session.engine === "codex" || session.engine === "claude" || session.engine === "zcode") && <button type="button" onClick={() => { setSlashSearch(false); setPanel("skill"); }}><BookOpen size={16}/><span>技能</span></button>}
          <button type="button" aria-pressed={extra.goal!==null} onClick={()=>{setPanel(null);changeExtra({...extra,goal:extra.goal===null?"":null})}}><Target size={16}/><span>目标模式</span>{extra.goal!==null && <Check size={14}/>}</button>
          {permissions?.modes.length ? <button type="button" aria-haspopup="true" onClick={()=>setPanel("permissions")}><Shield size={16}/><span>权限模式</span>{permissions.value ? <small>{cliPermissionLabel(session.engine, permissions.value)}</small> : null}<ChevronRight size={14}/></button> : null}
        </div>}
        {panel==="permissions" && permissions ? <div className="na-permission-menu" role="radiogroup" aria-label="权限模式">
          {permissions.modes.map(mode=><button key={mode} type="button" role="radio" aria-checked={permissions.value===mode} onClick={()=>{permissions.onChange(mode);setPanel(null)}}><span>{cliPermissionLabel(session.engine, mode)}</span>{permissions.value===mode ? <Check size={14}/> : null}</button>)}
          {permissions.pending ? <small className="na-permission-note">{permissions.pending}</small> : null}
        </div> : null}
        {panel==="context"?<ContextDetail usage={context}/>:null}
        {panel === "skill" && <SkillPicker load={loadSkills} externalQuery={slashSearch ? text : undefined} select={row => {
          setSkill((session.engine === "codex" ? "$" : "/") + row.name);
          if (slashSearch) change("");
          setPanel(null); draftRef.current?.focus();
        }}/>}
        {panel==="model"&&review?<><label>模型<select aria-label="模型" value={model} onChange={e=>configure(e.target.value,effort)}>{(review.models[session.engine]??[]).map(m=><option key={m}>{m}</option>)}</select></label><label>推理强度<select aria-label="推理强度" value={effort} onChange={e=>configure(model!,e.target.value)}><option>标准</option><option>高</option></select></label></>:null}
        {panel==="notes"?notes.map(n=><div key={n.id}><b>{n.num}. {n.quote}</b><p>{n.body}</p><button type="button" onClick={()=>onNotes?.(notes.filter(v=>v.id!==n.id))}>移除</button></div>):null}
      </div>:null}
      <div className="cli-composer-actions">
        <>
          <button type="button" className="na-add-trigger" data-panel-trigger="add" disabled={busy || draft?.busy} aria-label="添加" title="添加" aria-expanded={panel==="add"} onClick={()=>setPanel(panel==="add"?null:"add")}><Plus size={20}/></button>
          <span className="na-grow"/>
          {/* the model sits left of the context ring on one line; a phone shows only its name */}
          {review ? <button type="button" className={modelTrigger} data-panel-trigger="model" aria-label="模型设置" aria-expanded={panel==="model"} title={model} onClick={()=>setPanel(panel==="model"?null:"model")}>
            <span>{model}</span><span className="na-effort">{effort}</span><ChevronDown size={13}/>
          </button> : !canOpenModelMenu ? null : <CliModelMenu deviceId={session.deviceId} engine={session.engine} live={!!features?.includes("models")}
            triggerClassName={modelTrigger} open={panel === "model"} onOpenChange={open => setPanel(current => open ? "model" : current === "model" ? null : current)}
            choice={choice} onChange={choose} running={session.model} disabled={pickerOff} note={pickerNote}/>}
          {draft||starter ? null : <button type="button" className="na-context" data-panel-trigger="context" aria-label="上下文用量" title={contextSummary(context)} data-level={contextLevel(context)} aria-expanded={panel==="context"} onClick={()=>setPanel(panel==="context"?null:"context")}><ContextRing usage={context}/></button>}
        </>
        {/* one button: Stop while a turn runs and the box is empty, Send once there is something to send */}
        {stopOnly ? <button type="button" className="na-stop" aria-label={review?"中断":"停止"} title={review?"中断":"停止当前运行并暂停队列"} disabled={busy} onClick={() => void run(onInterrupt)}><Square size={12} fill="currentColor" strokeWidth={0}/></button> : null}
        {stopOnly ? null : <button type="submit" className="primary" aria-busy={sending || !!draft?.busy} title={sending?"正在处理…":queuesWhileBusy ? "排队发送" : "发送"} aria-label="发送" disabled={sending || !!draft?.busy || busy || !canSubmit || tooLarge}>{draft?.busy || (sending && !onUploadPreview) ? <LoaderCircle className="na-busy-icon" size={17}/> : <ArrowUp size={19}/>}</button>}
      </div>
      {tooLarge ? <small role="alert" className="cli-composer-error">内容太长</small> : error ? <small role="alert" className="cli-composer-error">{error}</small> : null}
      {mode.kind==="send" && mode.outside && note ? <small className="cli-composer-note" role="status" data-testid="cli-composer-note">{note}</small> : null}
    </form>
  );
}

/** Tokens as the CLIs and the assistant's usage show them: 950, 47.5K, 475K, 1M. */
export const tokenText = formatCompactTokens;
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
  if (!usage) return <div className="na-context-detail"><b>上下文用量</b><small role="status">暂无记录</small></div>;
  const share = contextShare(usage);
  return <div className="na-context-detail" data-level={contextLevel(usage)}>
    <div className="na-context-head"><b>上下文</b>{share === null ? null : <strong>{Math.round(share * 100)}%</strong>}</div>
    {share === null ? null : <div className="na-context-bar"><span style={{ width: `${Math.max(2, share * 100)}%` }}/></div>}
    <small>{share === null ? `已用 ${tokenText(usage.used)} tokens` : `已用 ${tokenText(usage.used)} / ${tokenText(usage.window!)} tokens`}</small>
  </div>;
}

/** An image about to be sent: its thumbnail, which opens the full picture (closed from its top-right corner),
 * and a remove button on the thumbnail's corner.
 * A data: URL, since the page's CSP refuses blob: images. */
function ImageDraft({file,busy,onRemove}:{file:File;busy:boolean;onRemove():void}) {
  const [url,setUrl]=useState("");
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    let live=true;const reader=new FileReader();
    reader.onload=()=>{if(live&&typeof reader.result==="string")setUrl(reader.result)};
    reader.readAsDataURL(file);
    return ()=>{live=false;reader.abort()};
  },[file]);
  return <span className="na-file-chip" data-image>
    <button type="button" className="na-file-view" disabled={!url} aria-label={"查看图片 "+file.name} title={file.name} onClick={()=>setOpen(true)}>{url?<img className="na-file-thumb" src={url} alt=""/>:<ImagePlus size={16}/>}</button>
    <button type="button" className="na-file-remove" disabled={busy} aria-label={"移除 "+file.name} onClick={onRemove}><X size={11}/></button>
    {open&&url?<ImageLightbox src={url} alt={file.name} onClose={()=>setOpen(false)}/>:null}
  </span>;
}
