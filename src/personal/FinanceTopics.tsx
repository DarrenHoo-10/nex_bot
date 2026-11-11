import './finance-topics.css';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {api,type RecordRow,str} from './api';
type Topic={conversationId:string;title:string;audience:'private'|'public';sourceContext:Record<string,unknown>;last_activity_at:number;message_count:number;unread_count:number;messages:RecordRow[];activeTask:{id:string;status:string}|null};
type Task=RecordRow & {effects:RecordRow[]};
type Feed={messages:RecordRow[];streaming:Array<{taskId:string;text:string}>};
export function FinanceTopics({botId,render,settings}:{botId:string;render:(value:string)=>ReactNode;settings:ReactNode}) {
 const [topics,setTopics]=useState<Topic[]>([]),[selected,setSelected]=useState<string|null>(null),[drafting,setDrafting]=useState(false),[draft,setDraft]=useState(''),[feed,setFeed]=useState<Feed>({messages:[],streaming:[]}),[error,setError]=useState(''),[sending,setSending]=useState(false);
 const [tasks,setTasks]=useState<Task[]>([]),[editing,setEditing]=useState<string|null>(null);
 const readThrough=useRef(new Map<string,number>()),retryTasks=useRef(new Map<string,string>());
 const epoch=useRef(0),retry=useRef<{text:string;conversationId:string|null;clientId:string}|null>(null),drafts=useRef(new Map<string,string>()),selection=useRef<string|null>(null);
 selection.current=selected;
 const topic=topics.find(t=>t.conversationId===selected);
 async function refresh() {
  const version=++epoch.current,current=selection.current;
  try {
   const result=await api<{topics:Topic[]}>(`agents/topics?bot=${encodeURIComponent(botId)}`);
   const next=current ? await api<Feed>(`agents/messages?bot=${encodeURIComponent(botId)}&conversationId=${encodeURIComponent(current)}`) : {messages:[],streaming:[]};
   const history=current?await api<{tasks:Task[]}>(`agents/tasks?bot=${encodeURIComponent(botId)}&conversationId=${encodeURIComponent(current)}`):{tasks:[]};
   if(version!==epoch.current||current!==selection.current) return;
   setTasks(history.tasks);
   setTopics(result.topics);setFeed(next);
   const seq=Number(next.messages.at(-1)?.seq??0);
   if(current&&seq&&document.hasFocus()&&(readThrough.current.get(current)??0)<seq) {await api('agents/read',{botId,conversationId:current,seq});readThrough.current.set(current,seq);}
  }catch(failure){if(version===epoch.current)setError(failure instanceof Error?failure.message:'加载失败');}
 }
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),1500);return()=>{clearInterval(timer);++epoch.current;};},[botId,selected]); // requests are fenced across topic switches
 function open(id:string|null,isDraft=false) {
  drafts.current.set(selected??'new',draft);++epoch.current;selection.current=id;setSelected(id);setDrafting(isDraft);setDraft(drafts.current.get(id??'new')??'');setFeed({messages:[],streaming:[]});setError('');retry.current=null;setEditing(null);setTasks([]);
 }
 async function send() {
  const text=draft.trim(),current=selected;
  if(!text||sending||(!current&&!drafting))return;
  const request=retry.current?.text===text&&retry.current.conversationId===current ? retry.current : {text,conversationId:current,clientId:crypto.randomUUID()};retry.current=request;setSending(true);setError('');
  try {
   const result=await api<{conversationId:string}>(editing?'agents/edit':'agents/input',{botId,text,clientId:request.clientId,...(editing?{messageId:editing}:{}),...(current?{conversationId:current}:{newConversation:true,audience:'private',sourceContext:{channel:'nexbot'}})});
   retry.current=null;setEditing(null);drafts.current.delete(current??'new');
   if(selection.current===current){setDraft('');selection.current=result.conversationId;setSelected(result.conversationId);setDrafting(false);await refresh();}
  }catch(failure){setError(failure instanceof Error?failure.message:'发送失败');}finally{setSending(false);}
 }
 const destination=topic?.audience==='public' ? `回复到飞书话题${typeof topic.sourceContext.chatName==='string'?' · '+topic.sourceContext.chatName:''}` : '私人话题';
 return <section className="finance-topics" aria-label="金融助手话题">
  <div className="finance-topic-toolbar"><button type="button" onClick={()=>open(null)}>话题列表</button><button type="button" onClick={()=>open(null,true)}>＋ 新对话</button>{settings}</div>
  {error?<div role="alert" className="error-banner">{error}</div>:null}
  {!selected&&!drafting?<div className="finance-topic-list">{topics.length?topics.map(t=><button type="button" className="finance-topic-card glass" key={t.conversationId} onClick={()=>open(t.conversationId)}>
   <strong>{t.title}</strong><small>{t.audience==='public'?'飞书 · 公开话题':'私人话题'} · {new Date(t.last_activity_at).toLocaleString()} · {t.message_count} 条消息{t.unread_count?' · '+t.unread_count+' 未读':''}{t.activeTask?' · 进行中':''}</small>
   {t.messages.map(m=><span key={str(m.id)}>{m.role==='user'?'我':'金融助手'}：{str(m.content).slice(0,160)}</span>)}<span>回复话题 →</span>
  </button>):<p className="welcome">点击“新对话”开始研究</p>}</div>:<>
   <div className="transcript"><div className="transcript-inner"><h2>{topic?.title??'新对话'}</h2><small>{drafting?'私人草稿':destination}</small>
    {feed.messages.map(m=><article className={`message ${m.role==='user'?'outgoing':'incoming'}`} key={str(m.id)}><strong>{m.role==='user'?'我':'金融助手'}</strong><div className="bubble">{render(str(m.content))}</div>{m.input_status==='pending'?<button type="button" onClick={()=>{setEditing(str(m.id));setDraft(str(m.content));retry.current=null;}}>编辑排队消息</button>:null}</article>)}
    {feed.streaming.map(s=><article className="message incoming" key={s.taskId}><div className="bubble" role="status">{render(s.text)}</div></article>)}
    {topic?.activeTask&&!feed.streaming.length?<p role="status">正在研究…</p>:null}
   </div></div>
   <details className="finance-task-history"><summary>任务记录 · {tasks.length}</summary>{tasks.map(task=><div key={str(task.id)}><strong>{str(task.status)}</strong><span>{str(task.objective).slice(0,120)}</span>{task.effects.map(effect=><small key={str(effect.id)}>{str(effect.tool_name)} · {str(effect.status)}</small>)}{['failed','cancelled'].includes(str(task.status))?<button type="button" onClick={()=>void api('agents/retry',{botId,conversationId:selected,taskId:task.id,clientId:(()=>{const id=retryTasks.current.get(str(task.id))??crypto.randomUUID();retryTasks.current.set(str(task.id),id);return id;})()}).then(()=>{retryTasks.current.delete(str(task.id));return refresh();}).catch(e=>setError(e.message))}>重试任务</button>:null}</div>)}</details>
   <div className="composer-area"><form className="composer conversation-input glass" onSubmit={e=>{e.preventDefault();void send();}}><textarea aria-label="金融助手消息" placeholder={editing?'编辑排队消息…':drafting?'开始私人对话…':destination} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/><div className="actions"><button type="submit" disabled={sending||!draft.trim()}>{sending?'发送中…':'发送'}</button>{selected&&topic?.activeTask?<button type="button" onClick={()=>{void api('agents/cancel',{botId,conversationId:selected}).then(refresh).catch(e=>setError(e.message));}}>停止本话题</button>:null}</div></form></div>
  </>}
 </section>;
}
