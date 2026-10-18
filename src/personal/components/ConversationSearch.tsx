import { useEffect, useRef, useState } from 'react';
import { api, type State } from '../api';
export type ConversationMatch = { id:string; botId:string; botName:string; createdAt:number; snippet:string };
type Results = { results:ConversationMatch[]; nextBefore:number|null; sync:State['sync'] };
export function ConversationSearch({query,sync,onSelect}:{query:string;sync:State['sync'];onSelect:(match:ConversationMatch)=>void}) {
  const [result,setResult]=useState<Results>(),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const alive=useRef(true),pending=useRef(false);
  async function load(before?:number){
    if(pending.current)return;pending.current=true;setBusy(true);setError('');
    try{
      const next=await api<Results>(`agents/search?q=${encodeURIComponent(query)}${before?`&before=${before}`:''}`);
      if(!alive.current)return;
      if(next.sync.coreId!==sync.coreId||next.sync.bootId!==sync.bootId||next.sync.privacyEpoch!==sync.privacyEpoch){setResult(undefined);setError('会话记录已变化，请重新搜索');return;}
      setResult(previous=>({...next,results:before&&previous?[...previous.results,...next.results]:next.results}));
    }catch(failure){if(alive.current)setError(failure instanceof Error?failure.message:'搜索失败');}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{
    alive.current=true;const timer=setTimeout(()=>void load(),250);
    return()=>{alive.current=false;clearTimeout(timer);};
  // The parent remounts on query/account/privacy changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  return <section className="conversation-search-results" aria-label="会话搜索结果">
    {result?.results.map(item=><button type="button" className="conversation-search-result" key={item.id} onClick={()=>onSelect(item)}><span><strong>{item.botName}</strong><time>{new Date(item.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></span><p>{item.snippet}</p></button>)}
    {busy&&<p className="sidebar-empty" role="status">正在搜索…</p>}
    {!busy&&!error&&result?.results.length===0&&<p className="sidebar-empty">没有找到会话记录</p>}
    {error&&<div className="sidebar-empty" role="alert">{error}<button type="button" onClick={()=>void load(result?.nextBefore??undefined)}>重试</button></div>}
    {!error&&result?.nextBefore&&<button type="button" className="text-button" disabled={busy} onClick={()=>void load(result.nextBefore!)}>加载更多结果</button>}
  </section>;
}
