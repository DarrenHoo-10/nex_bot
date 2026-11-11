import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';

type Part = {
  id:string; source_key:string; app_id:string; chat_id:string; conversation_id:string;
  part:number; state:string; operation:string; content:string; attempts:number;
  first_post_at:number|null; dedupUntil:number|null; message_id:string|null; error:string|null;
  reconciliation?:{action:string;actor:string;evidence:string;message_id:string|null;recorded_at:number}[];
};
const states:Record<string,string>={pending:'等待发送',sending:'正在发送',sent:'已送达',cancelled:'已取消',needs_reconciliation:'待人工对账'};
function preview(content:string) {
  try {return (JSON.parse(content).elements as {content?:string}[]).map(element=>element.content??'').join('\n');}
  catch {return content;}
}

/** Owner settings only. Reconciliation never posts a diagnostic into the destination chat. */
export function FeishuOutboxSettings({revision}:{revision:unknown}) {
  const [parts,setParts]=useState<Part[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const reload=useCallback(async()=>{const result=await api<{parts:Part[]}>('feishu/deliveries');setParts(result.parts);},[]);
  useEffect(()=>{void reload().catch(e=>setError(e instanceof Error?e.message:'无法读取投递状态'));},[revision,reload]);
  function reconcile(event:FormEvent<HTMLFormElement>,part:Part) {
    event.preventDefault();
    const values=new FormData(event.currentTarget);
    setBusy(true);setError('');
    void api('feishu/deliveries/reconcile',{
      id:part.id,action:values.get('action'),messageId:values.get('messageId'),evidence:values.get('evidence'),
      confirmedNotDelivered:values.get('confirmedNotDelivered')==='on',
    }).then(reload).catch(e=>setError(e instanceof Error?e.message:'对账失败')).finally(()=>setBusy(false));
  }
  if(!parts.length&&!error)return null;
  return <section className="connector-detail" aria-label="飞书投递对账">
    <h3>投递状态与对账</h3>
    <p className="muted">飞书发送去重仅有效一小时。超过窗口且结果不明时，该分段及后续分段暂停，需主人核对；其他话题继续投递。</p>
    <button disabled={busy} onClick={()=>void reload().catch(e=>setError(String(e)))}>刷新投递状态</button>
    {error&&<p role="alert" className="connector-feedback is-error">{error}</p>}
    {parts.map(part=><details key={part.id} open={part.state==='needs_reconciliation'}>
      <summary>{states[part.state]??part.state} · 第 {part.part+1} 段 · {part.chat_id}</summary>
      <p className="muted">应用 {part.app_id} · 话题 {part.conversation_id} · 尝试 {part.attempts} 次 · {part.operation==='patch'?'更新卡片':'发送消息'}</p>
      <p className="muted">首次实际发送：{part.first_post_at?new Date(part.first_post_at).toLocaleString():'无可信发送时间'}{part.dedupUntil?` · 去重截止：${new Date(part.dedupUntil).toLocaleString()}`:''}{part.message_id?` · ${part.message_id}`:''}</p>
      <pre style={{whiteSpace:'pre-wrap',maxHeight:200,overflow:'auto'}}>{preview(part.content)}</pre>
      {part.reconciliation?.map((entry,index)=><p className="muted" key={index}>对账 · {new Date(entry.recorded_at).toLocaleString()} · {entry.action==='delivered'?'已核验送达':'已核实未送达'} · {entry.evidence}{entry.message_id?` · ${entry.message_id}`:''}</p>)}
      {part.state==='needs_reconciliation'&&<form onSubmit={event=>reconcile(event,part)}>
        <label className="field">核对结果<select name="action"><option value="delivered">已送达，核验并登记</option><option value="not_delivered">已核实未送达，允许重新发送</option></select></label>
        <label className="field">已送达的飞书 message_id<input name="messageId" placeholder="om_…（已送达时必填）"/></label>
        <label className="field">人工核对依据<textarea name="evidence" required placeholder="记录核对的群、时间与结果"/></label>
        <label style={{display:'flex',alignItems:'center',gap:8,margin:'12px 0'}}><input type="checkbox" name="confirmedNotDelivered" style={{width:'auto',flex:'0 0 auto',margin:0}}/>选择重新发送时，我已核实此分段未送达</label>
        <p className="muted">登记已送达会验证原应用、群、发送者与完整卡片内容。重新发送会复查当前目的地和订阅规则。</p>
        <button disabled={busy}>提交对账</button>
      </form>}
    </details>)}
  </section>;
}
