import { useEffect, useRef, useState } from 'react';
import { api, listModels, str, type RecordRow, type State } from './api';
import { ModelPicker } from './components/ModelPicker';
import { MemoryWorkbench } from './MemoryWorkbench';

type Monitor={settings:RecordRow;totals:RecordRow;groups:RecordRow[];trend:RecordRow[];compression:RecordRow;historyRange:RecordRow;counts:RecordRow[];calls:RecordRow[];pending:number;imports:RecordRow[];memoryTokens:number|null;working:boolean;documents:RecordRow[];cost:null};
const date=(value:unknown)=>{if(typeof value!=='number')return '';const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const purposes:Record<string,string>={retain:'事实与经历',consolidate:'归纳整理',understanding:'长期理解',reflect:'深度查询',compact:'上下文压缩'};
const number=(value:unknown)=>typeof value==='number'?value.toLocaleString():'未知';
export function MemoryDashboard({state,active}:{state:State;active:boolean}){
  const [botId,setBotId]=useState(str(state.bots[0]?.id)),[days,setDays]=useState(7),[monitor,setMonitor]=useState<Monitor>();
  const [enabled,setEnabled]=useState(false),[model,setModel]=useState(''),[budget,setBudget]=useState('100000');
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[source,setSource]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState('');
  const scope=useRef(''),initialized=useRef(''),draftVersion=useRef(0);scope.current=botId+':'+days+':'+state.sync.privacyEpoch;
  async function refresh(){const target=botId,requestScope=scope.current;const result=await api<Monitor>('memory/monitor',{botId:target,days});if(scope.current!==requestScope)return;setMonitor(result);if(initialized.current!==target){initialized.current=target;draftVersion.current=Number(result.settings.version);setEnabled(Boolean(result.settings.enabled));setModel(str(result.settings.model));setBudget(str(result.settings.daily_budget));setFrom(date(result.historyRange.first));setTo(date(result.historyRange.last));}}
  useEffect(()=>{if(!botId&&state.bots[0])setBotId(str(state.bots[0].id));},[state.bots,botId]);
  useEffect(()=>{
    if(!active||!botId)return;let alive=true;
    const load=()=>{if(alive)void refresh().catch(error=>{if(alive)setNotice(error instanceof Error?error.message:'读取失败');});};
    load();const timer=setInterval(load,5000);return()=>{alive=false;clearInterval(timer);};
  // The editable form is intentionally not reset by polling.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[active,botId,days,state.sync.privacyEpoch]);
  useEffect(()=>{setSource('');setMonitor(undefined);initialized.current='';},[state.sync.privacyEpoch]);
  const perform=async(fn:()=>Promise<void>)=>{setBusy(true);setNotice('');try{await fn();await refresh();}catch(error){setNotice(error instanceof Error?error.message:'操作失败');}finally{setBusy(false);}};
  if(!state.bots.length)return <p className="muted">创建助手后即可设置长期记忆。</p>;
  const status=!monitor?.settings.enabled?'已关闭':monitor.working?'正在整理':monitor.settings.last_error?'等待重试':monitor.pending?'等待整理':'已就绪';
  return <section className="preferences-section memory-dashboard" data-memory-dashboard>
    <label className="field">个人助手<select aria-label="记忆所属助手" value={botId} onChange={e=>{setMonitor(undefined);setSource('');setNotice('');initialized.current='';setBotId(e.target.value);}}>{state.bots.map(bot=><option key={str(bot.id)} value={str(bot.id)}>{bot.name}</option>)}</select></label>
    {monitor&&<><form onSubmit={event=>{event.preventDefault();void perform(async()=>{await api('memory/settings',{botId,version:draftVersion.current,enabled,model,dailyBudget:Number(budget)});initialized.current='';setNotice('记忆设置已保存');});}}>
      <fieldset disabled={busy}>
        <label className="preferences-toggle"><strong>开启长期记忆</strong><input type="checkbox" role="switch" name="personalMemoryEnabled" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/></label>
        <p className="muted">开启后，助手会整理对话并形成长期记忆，产生额外 Token 消耗。</p>
        <div className="field"><span>记忆模型</span><ModelPicker key={JSON.stringify([botId,state.config?.provider_id,state.config?.endpoint])} name="personalMemoryModel" label="选择记忆模型" value={model} onChange={setModel} emptyLabel={`跟随助手模型（${state.config?.default_model??'未配置'}）`} models={state.modelVisibility?.models} loadModels={()=>listModels({provider:str(state.config?.provider_id),endpoint:str(state.config?.endpoint),apiKey:''})}/></div>
        <label className="field">每日后台预算（Token）<input name="memoryDailyBudget" type="number" min="0" max="100000000" step="1000" required value={budget} onChange={e=>setBudget(e.target.value)}/><small>0 表示不限；达到预算后暂停整理，聊天继续。</small></label>
        <button type="submit" className="primary">{busy?'处理中…':'保存记忆设置'}</button>
      </fieldset>
    </form>
    <div className="memory-monitor-heading"><h3>记忆监控</h3><select aria-label="统计时间范围" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={1}>今日</option><option value={7}>近 7 天</option><option value={30}>近 30 天</option></select></div>
    <div className="memory-stats">
      <article><small>运行状态</small><strong>{status}</strong><span>{monitor.pending} 条待整理</span></article>
      <article><small>输入 Token</small><strong>{number(monitor.totals.input_tokens)}</strong><span>缓存读取 {number(monitor.totals.cache_read)}</span></article>
      <article><small>输出 Token</small><strong>{number(monitor.totals.output_tokens)}</strong><span>{number(monitor.totals.calls)} 次调用</span></article>
      <article><small>注入聊天的记忆</small><strong>{number(monitor.memoryTokens)}</strong><span>计入聊天输入，不重复计费</span></article>
    </div>
    <p className="muted">最后整理：{monitor.settings.last_success?new Date(Number(monitor.settings.last_success)).toLocaleString():'尚未整理'} · 估算费用：未知（未配置价格）</p>
    {!!monitor.settings.last_error&&<p role="alert" className="model-error">{monitor.settings.last_error}</p>}
    {Number(monitor.totals.unknown_calls)>0&&<p className="muted">{monitor.totals.unknown_calls} 次调用用量未知，预算暂按预留量计算。</p>}
    <div className="memory-usage-bars">{monitor.groups.map(group=><div key={str(group.purpose)}><span>{purposes[str(group.purpose)]??group.purpose}</span><meter min={0} max={Math.max(1,...monitor.groups.map(row=>Number(row.input_tokens)+Number(row.output_tokens)))} value={Number(group.input_tokens)+Number(group.output_tokens)}/><span>{number(typeof group.input_tokens==='number'&&typeof group.output_tokens==='number'?group.input_tokens+group.output_tokens:null)}</span></div>)}</div>
    <details className="preferences-advanced"><summary>每日用量</summary><div className="memory-usage-bars">{monitor.trend.map(day=><div key={str(day.day)}><span>{day.day}</span><meter min={0} max={Math.max(1,...monitor.trend.map(row=>Number(row.tokens)))} value={Number(day.tokens)}/><span>{number(day.tokens)}</span></div>)}</div></details>
    <p className="muted">连续会话 · 80% 触发压缩 · 已压缩 {number(monitor.compression.count)} 次</p>
    <div className="memory-counts">{[['fact','事实'],['experience','经历'],['observation','归纳'],['understanding','长期理解']].map(([kind,label])=><span key={kind}>{label} <strong>{monitor.counts.find(row=>row.kind===kind)?.count??0}</strong></span>)}</div>
    {monitor.documents.map(doc=><details className="preferences-advanced" key={str(doc.id)}><summary>{doc.title} · v{doc.version}</summary><p style={{whiteSpace:'pre-wrap'}}>{doc.content}</p>{(JSON.parse(str(doc.refs_json)) as Array<{id:string}>).map(ref=><button key={ref.id} disabled={busy} onClick={()=>void perform(async()=>{const requestScope=scope.current;const result=await api<{content:string}>('memory/expand',{botId,ref:`message:${ref.id}`});if(scope.current===requestScope)setSource(result.content);})}>查看原文</button>)}</details>)}
    {source&&<pre className="memory-source">{source}</pre>}
    <details className="preferences-advanced"><summary>调用明细</summary><div className="memory-table"><table><thead><tr><th>时间</th><th>用途／模型</th><th>输入</th><th>输出</th><th>状态</th></tr></thead><tbody>{monitor.calls.map(call=><tr key={str(call.id)}><td>{new Date(Number(call.created_at)).toLocaleTimeString()}</td><td>{purposes[str(call.purpose)]??call.purpose}<small>{call.model}</small></td><td>{number(call.input_tokens)}</td><td>{number(call.output_tokens)}</td><td>{({succeeded:'完成',running:'进行中',unknown:'结果未知',invalid:'响应无效'} as Record<string,string>)[str(call.status)]??call.status}</td></tr>)}</tbody></table></div></details>
    <details className="preferences-advanced"><summary>导入历史</summary><form onSubmit={e=>{e.preventDefault();void perform(async()=>{await api('memory/import',{botId,fromTime:new Date(from+'T00:00:00').getTime(),toTime:new Date(to+'T23:59:59.999').getTime()});setNotice('所选历史已加入整理队列');});}}><label className="field">开始日期<input type="date" value={from} onChange={e=>setFrom(e.target.value)} required/></label><label className="field">结束日期<input type="date" min={from} value={to} onChange={e=>setTo(e.target.value)} required/></label><small>仅导入所选时间段，产生额外 Token 消耗。</small><button disabled={busy||!monitor.settings.enabled}>导入所选历史</button></form><p>{monitor.imports.length} 项导入等待处理</p></details>
    </>}
    <details className="preferences-advanced"><summary>查找与遗忘</summary><MemoryWorkbench key={botId+':'+state.sync.privacyEpoch} botId={botId} bots={state.bots}/></details>
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
