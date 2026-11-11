import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { FinanceChannelSettings } from './FinanceChannelSettings';
import { FeishuOutboxSettings } from './FeishuOutboxSettings';
type SharedApp={appId:string;brand:string;bound:boolean;canManageChannel?:boolean;status?:string;tenantKey?:string;bindingVersion?:number};
type Destination={app_id:string;chat_id:string;chat_type:string;enabled:number};
type Subscription={id:string;app_id:string;chat_id:string;instance_id:string;kinds:string[];scenarios:string[];audience:string;enabled:number;version:number};
export function FeishuDeliverySettings({revision,onSharedAvailable}:{revision:unknown;onSharedAvailable(available:boolean):void}) {
  const [apps,setApps]=useState<SharedApp[]>([]),[destinations,setDestinations]=useState<Destination[]>([]),[subscriptions,setSubscriptions]=useState<Subscription[]>([]);
  const [code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[appId,setAppId]=useState(''),[editing,setEditing]=useState<Subscription|null>(null);
  const reload=useCallback(async()=>{
    const [nextApps,nextDestinations,nextSubscriptions]=await Promise.all([api<SharedApp[]>('feishu/accounts'),api<Destination[]>('feishu/destinations'),api<Subscription[]>('feishu/subscriptions')]);
    setApps(nextApps);setDestinations(nextDestinations);setSubscriptions(nextSubscriptions);onSharedAvailable(nextApps.length>0);
  },[onSharedAvailable]);
  useEffect(()=>{void reload().catch(()=>{});},[reload,revision]);
  const act=async(operation:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await operation();await reload();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
  const selected=appId||apps[0]?.appId||'';
  function save(event:FormEvent<HTMLFormElement>){event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));const destination=destinations.find(d=>d.app_id===selected&&d.chat_id===values.chatId);
    void act(async()=>{await api('feishu/subscriptions',{appId:selected,chatId:editing?.chat_id??values.chatId,instanceId:editing?.instance_id??values.instanceId,kinds:String(values.kinds).split(/[,，]/).map(s=>s.trim()).filter(Boolean),scenarios:values.scenario==='all'?['all']:['proactive'],audience:destination?.chat_type==='group'?'public':'private',enabled:true,...(editing?{version:editing.version}:{})});setEditing(null);});
  }
  if(!apps.length&&!subscriptions.length)return <FeishuOutboxSettings revision={revision}/>;
  return <><section className="connector-detail" aria-label="飞书账号与投递">
    <h3>账号与投递</h3>
    {error&&<p role="alert" className="connector-feedback is-error">{error}</p>}
    {apps.find(app=>app.appId===selected)?.canManageChannel&&<FinanceChannelSettings key={selected} appId={selected}/>}
    {apps.length>0&&<>
      <label className="field">应用<select value={selected} onChange={e=>{setAppId(e.target.value);setCode('');setEditing(null);}}>{apps.map(a=><option key={a.appId} value={a.appId}>{a.appId} · {a.bound?'已绑定':'未绑定'}</option>)}</select></label>
      <p className="muted">{apps.find(a=>a.appId===selected)?.status==='connected'?'通道已连接':'通道未连接'}</p>
      <div className="actions"><button disabled={busy} onClick={()=>void act(async()=>{const result=await api<{code:string}>('feishu/accounts/bind',{appId:selected});setCode(result.code);})}>{apps.find(a=>a.appId===selected)?.bound?'重新绑定':'生成账号绑定码'}</button>{apps.find(a=>a.appId===selected)?.bound&&<button disabled={busy} onClick={()=>void act(()=>api('feishu/accounts/unbind',{appId:selected}))}>解除账号绑定</button>}</div>
      {code&&<p className="connector-feedback">在飞书私聊发送：<code>{code}</code></p>}
      {apps.find(a=>a.appId===selected)?.bound&&<form onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void act(()=>api('feishu/accounts/claim',{appId:selected,chatId:values.get('chatId')}));}}><label className="field">群 ID<input name="chatId" required /></label><button disabled={busy}>绑定已验证的群</button></form>}
    </>}
    <h3>订阅</h3>
    {subscriptions.map(s=><div className="connection-meta" key={s.id}><span>{s.chat_id} · {s.kinds.join('、')} · {s.enabled?'已启用':'已暂停'}</span><div className="actions"><button disabled={busy} onClick={()=>{setAppId(s.app_id);setEditing(s);}}>修改</button><button disabled={busy} onClick={()=>void act(()=>api('feishu/subscriptions',{appId:s.app_id,chatId:s.chat_id,instanceId:s.instance_id,kinds:s.kinds,scenarios:s.scenarios,audience:s.audience,version:s.version,enabled:!s.enabled}))}>{s.enabled?'暂停':'恢复'}</button></div></div>)}
    {destinations.some(d=>d.app_id===selected&&d.enabled)&&<form key={editing?.id??selected} onSubmit={save}>
      <label className="field">目的地<select name="chatId" defaultValue={editing?.chat_id} disabled={!!editing}>{destinations.filter(d=>d.app_id===selected&&d.enabled).map(d=><option key={d.chat_id} value={d.chat_id}>{d.chat_type==='group'?'群':'私人'} · {d.chat_id}</option>)}</select></label>
      <label className="field">金融实例<input name="instanceId" defaultValue={editing?.instance_id} readOnly={!!editing} required /></label>
      <label className="field">内容类型<input name="kinds" defaultValue={editing?.kinds.join(',')} required placeholder="多个类型用逗号分隔" /></label>
      <label className="field">适用场景<select name="scenario" defaultValue={editing?.scenarios.includes('all')?'all':'proactive'}><option value="proactive">主动推送</option><option value="all">主动推送与话题回复</option></select></label>
      <div className="actions"><button disabled={busy}>{editing?'保存修改':'新增订阅'}</button>{editing&&<button type="button" onClick={()=>setEditing(null)}>取消</button>}</div>
    </form>}
  </section><FeishuOutboxSettings revision={revision}/></>;
}
