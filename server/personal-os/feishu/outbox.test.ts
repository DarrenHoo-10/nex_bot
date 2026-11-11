import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreStore, type Row } from '../store.ts';
import type { AgentModule } from '../agents.ts';
import type { TaskRuntime } from '../runtime.ts';
import { FeishuModule } from './module.ts';
import { FeishuApi, FeishuApiError } from './api.ts';
import { FEISHU_UUID_WINDOW_MS, postWindowExpired } from './delivery.ts';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.restoreAllMocks();});
function fixture() {
  const dir=mkdtempSync(path.join(os.tmpdir(),'feishu-outbox-'));
  const store=new CoreStore(dir,randomBytes(32),'synthetic');
  const requests:{method:string;body:unknown;url:string}[]=[];
  let owner='ou_owner',unknown=false;
  let before:(()=>void)|undefined;
  let message:Record<string,unknown>={};
  let failure:Error|undefined;
  const channels:FeishuModule[]=[];
  function open() {
    const channel=new FeishuModule(store,()=>{},{} as AgentModule,{} as TaskRuntime,{
      registerApp:async()=>{throw new Error('unused');},
      sharedApp:appId=>({app_id:appId,enabled:1,owner_open_id:owner,bot_id:'finance',bot_open_id:'ou_bot'}),
      sendRequest:async(_app,method,url,body,guard)=>{
        before?.();guard?.();requests.push({method,body,url});
        if(method==='GET')return {data:{items:[message]}};
        if(failure)throw failure;
        if(unknown)throw new Error('connection lost after provider accepted');
        return {data:{message_id:`om_sent${requests.length}`}};
      },
    });
    channels.push(channel);return channel;
  }
  let channel=open();
  channel.claimGroup({appId:'cli_app',chatId:'oc_chat',actorOpenId:'ou_owner'});
  function queue(key:string,extra:Row={}) {
    store.insert('feishu_delivery_parts',{
      id:key,source_key:key,app_id:'cli_app',chat_id:'oc_chat',conversation_id:`topic-${key}`,
      content:JSON.stringify({elements:[{tag:'markdown',content:`answer ${key}`}]}),part:0,
      uuid:`uuid-${key}`,actor_open_id:'ou_owner',audience:'public',created_at:Date.now(),post_tracking_version:1,
      ...extra,
    });return store.get('SELECT * FROM feishu_delivery_parts WHERE id=?',key)!;
  }
  cleanup.push(async()=>{for(const c of channels)await c.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,requests,queue,get channel(){return channel;},
    restart:async()=>{await channel.close();channel=open();return channel;},
    unknown:(value=true)=>{unknown=value;},before:(fn?:()=>void)=>{before=fn;},failure:(error?:Error)=>{failure=error;},
    revoke:()=>{owner='ou_other';},
    message:(part:Row,changes:Record<string,unknown>={})=>{message={message_id:'om_verified',chat_id:part.chat_id,msg_type:'interactive',deleted:false,sender:{id:part.app_id,id_type:'app_id',sender_type:'app'},body:{content:part.content},...(part.root_id?{root_id:part.root_id}:{}),...changes};},
  };
}

describe('Feishu provider UUID window and owner reconciliation',()=>{
  it('records the first real POST, preserves it and UUID on in-window retries',async()=>{
    const f=fixture();f.queue('a');f.unknown();await f.channel.flushOutbox();
    const first=f.store.get("SELECT * FROM feishu_delivery_parts WHERE id='a'")!;
    expect(first.state).toBe('pending');expect(first.first_post_at).toBeTypeOf('number');
    f.store.run("UPDATE feishu_delivery_parts SET next_at=0 WHERE id='a'");f.unknown(false);await f.channel.flushOutbox();
    expect(f.store.get("SELECT * FROM feishu_delivery_parts WHERE id='a'")).toMatchObject({state:'sent',first_post_at:first.first_post_at,uuid:first.uuid});
    expect(f.requests.map(r=>(r.body as Row).uuid)).toEqual([first.uuid,first.uuid]);
  });
  it('stops exactly at the window boundary, blocks following segments, and sends unrelated topics',async()=>{
    const f=fixture(),at=Date.now();vi.spyOn(Date,'now').mockReturnValue(at);
    f.queue('a',{first_post_at:at-FEISHU_UUID_WINDOW_MS,attempts:1});
    f.queue('b',{source_key:'a',part:1});f.queue('other');
    await f.channel.flushOutbox();
    expect(f.store.get("SELECT state FROM feishu_delivery_parts WHERE id='a'")?.state).toBe('needs_reconciliation');
    expect(f.store.get("SELECT state FROM feishu_delivery_parts WHERE id='b'")?.state).toBe('pending');
    expect(f.requests).toHaveLength(1);expect((f.requests[0].body as Row).uuid).toBe('uuid-other');
    expect(postWindowExpired({first_post_at:at+1},at)).toBe(true);
  });
  it('rechecks expiry after token/gate waits immediately before provider POST',async()=>{
    const f=fixture(),at=Date.now();let clock=at;vi.spyOn(Date,'now').mockImplementation(()=>clock);
    f.queue('a',{first_post_at:at-FEISHU_UUID_WINDOW_MS+1,attempts:1});
    f.before(()=>{clock=at+1;});await f.channel.flushOutbox();
    expect(f.requests).toHaveLength(0);
    expect(f.store.get("SELECT state FROM feishu_delivery_parts WHERE id='a'")?.state).toBe('needs_reconciliation');
  });
  it('recovers within-window crashes, quarantines legacy unknown and expired attempts, and safely recovers PATCH',async()=>{
    const f=fixture(),at=Date.now();
    f.queue('recent',{state:'sending',attempts:1,first_post_at:at-100});
    f.queue('old',{state:'sending',attempts:1,first_post_at:at-FEISHU_UUID_WINDOW_MS-100});
    f.queue('legacy',{state:'pending',attempts:1,post_tracking_version:0});
    f.queue('notposted',{state:'sending',attempts:1});
    f.queue('patch',{operation:'patch',target_id:'om_placeholder',state:'sending',attempts:1,first_post_at:at-FEISHU_UUID_WINDOW_MS-100});
    await f.restart();await f.channel.flushOutbox();
    expect(f.store.get("SELECT state FROM feishu_delivery_parts WHERE id='recent'")?.state).toBe('sent');
    expect(f.store.get("SELECT state FROM feishu_delivery_parts WHERE id='notposted'")?.state).toBe('sent');
    for(const key of ['old','legacy'])expect(f.store.get('SELECT state FROM feishu_delivery_parts WHERE id=?',key)?.state).toBe('needs_reconciliation');
    expect(f.store.get("SELECT state,message_id FROM feishu_delivery_parts WHERE id='patch'")).toEqual({state:'sent',message_id:'om_placeholder'});
    expect(f.requests).toHaveLength(3);expect(f.requests.some(r=>r.method==='PATCH')).toBe(true);
  });
  it.each([
    {chat_id:'oc_wrong'}, {sender:{id:'cli_other',id_type:'app_id',sender_type:'app'}},
    {sender:{id:'cli_app',id_type:'open_id',sender_type:'user'}}, {body:{content:'{"elements":[]}'}},
    {deleted:true}, {message_id:'om_wrong'}, {msg_type:'text'},
  ])('rejects unproven provider receipts: %j',async(changes)=>{
    const f=fixture(),part=f.queue('a',{state:'needs_reconciliation',attempts:1});f.message(part,changes);
    await expect(f.channel.reconcileDelivery({id:'a',action:'delivered',messageId:'om_verified',evidence:'checked group history'},'owner')).rejects.toThrow('不匹配');
    expect(f.store.all('SELECT * FROM feishu_topic_aliases')).toHaveLength(0);
    expect(f.requests.every(r=>r.method==='GET')).toBe(true);
  });
  it('verifies the original card, commits receipt and alias with an audit, then releases later parts',async()=>{
    const f=fixture(),part=f.queue('a',{state:'needs_reconciliation',attempts:1,first_post_at:Date.now()-7200000});
    f.queue('b',{source_key:'a',part:1,conversation_id:part.conversation_id});f.message(part);
    await f.channel.reconcileDelivery({id:'a',action:'delivered',messageId:'om_verified',evidence:'checked group history'},'owner');
    await new Promise(r=>setTimeout(r,10));await f.channel.flushOutbox();
    expect(f.requests[0].url).toContain('card_msg_content_type=user_card_content');
    expect(f.store.get("SELECT state,message_id FROM feishu_delivery_parts WHERE id='a'")).toEqual({state:'sent',message_id:'om_verified'});
    expect(f.store.get("SELECT conversation_id FROM feishu_topic_aliases WHERE alias='om_verified'")?.conversation_id).toBe(part.conversation_id);
    expect(f.store.get('SELECT action,actor,previous_uuid FROM feishu_delivery_reconciliations')).toMatchObject({action:'delivered',actor:'owner',previous_uuid:'uuid-a'});
    expect(f.requests.filter(r=>r.method==='POST')).toHaveLength(1);
    expect(f.requests[1].url).toContain('/om_verified/reply');
  });
  it('requires explicit non-delivery evidence, checks current rules, and opens a fresh UUID attempt only on deliberate retry',async()=>{
    const f=fixture();f.queue('a',{state:'needs_reconciliation',attempts:2,first_post_at:Date.now()-7200000});
    const request={id:'a',action:'not_delivered',evidence:'verified full group history'};
    await expect(f.channel.reconcileDelivery(request,'owner')).rejects.toThrow('明确核实');
    f.store.run("UPDATE feishu_destinations SET enabled=0");
    await expect(f.channel.reconcileDelivery({...request,confirmedNotDelivered:true},'owner')).rejects.toThrow('当前投递规则');
    expect(f.requests).toHaveLength(0);
    f.store.run("UPDATE feishu_destinations SET enabled=1");
    await f.channel.reconcileDelivery({...request,confirmedNotDelivered:true},'owner');
    await new Promise(r=>setTimeout(r,10));await f.channel.flushOutbox();
    const part=f.store.get("SELECT * FROM feishu_delivery_parts WHERE id='a'")!;
    expect(part.uuid).not.toBe('uuid-a');expect(Number(part.first_post_at)).toBeGreaterThan(Date.now()-1000);expect(part.state).toBe('sent');
    expect(f.store.get('SELECT first_post_at FROM feishu_delivery_reconciliations')?.first_post_at).toBeLessThan(Date.now()-7000000);
    f.revoke();expect(f.channel.deliveries()).toHaveLength(0);
  });
  it('reconstructs legacy later-segment roots from confirmed receipts and refuses another thread',async()=>{
    const f=fixture();f.queue('root',{state:'sent',message_id:'om_root'});
    const part=f.queue('later',{source_key:'root',part:1,state:'needs_reconciliation',attempts:1,post_tracking_version:0});
    f.message(part,{root_id:'om_other_root'});
    const request={id:'later',action:'delivered',messageId:'om_verified',evidence:'checked original report thread'};
    await expect(f.channel.reconcileDelivery(request,'owner')).rejects.toThrow('不匹配');
    f.message(part,{root_id:'om_root'});await f.channel.reconcileDelivery(request,'owner');
    expect(f.store.get("SELECT root_id,state FROM feishu_delivery_parts WHERE id='later'")).toEqual({root_id:'om_root',state:'sent'});
    expect(f.store.get("SELECT root_id FROM feishu_topic_aliases WHERE alias='om_verified'")?.root_id).toBe('om_root');
  });
  it('does not turn PATCH frequency limits or ambiguous failures into duplicate new messages',async()=>{
    const f=fixture();f.queue('a',{operation:'patch',target_id:'om_placeholder'});
    f.failure(new FeishuApiError(230020,'frequency limit',400));await f.channel.flushOutbox();
    expect(f.store.get("SELECT operation,state,first_post_at FROM feishu_delivery_parts WHERE id='a'")).toEqual({operation:'patch',state:'pending',first_post_at:null});
    f.store.run('UPDATE feishu_delivery_parts SET next_at=0');f.failure(new FeishuApiError(230011,'message not found',400));await f.channel.flushOutbox();
    expect(f.store.get("SELECT operation FROM feishu_delivery_parts WHERE id='a'")?.operation).toBe('send');
    f.store.run('UPDATE feishu_delivery_parts SET next_at=0');f.failure();await f.channel.flushOutbox();
    expect(f.requests.map(r=>r.method)).toEqual(['PATCH','PATCH','POST']);
  });
  it('checks every real API retry and never performs an out-of-window second POST',async()=>{
    const at=Date.now();let clock=at,posts=0,guards=0;vi.spyOn(Date,'now').mockImplementation(()=>clock);
    const api=new FeishuApi((async(input)=>{
      if(String(input).includes('/auth/'))return Response.json({code:0,tenant_access_token:'fixture',expire:7200});
      posts++;clock=at+FEISHU_UUID_WINDOW_MS;
      return Response.json({code:230020,msg:'limited'},{status:429});
    }) as typeof fetch);
    await expect(api.request({appId:'cli_app',appSecret:'fixture',brand:'feishu'},'POST','/open-apis/im/v1/messages',{},()=>{
      guards++;if(postWindowExpired({first_post_at:at},clock))throw new Error('uuid_window_expired');
    })).rejects.toThrow('uuid_window_expired');
    expect(posts).toBe(1);expect(guards).toBe(2);
  });
  it('fails closed for synchronous throws and rejected ownership guards before any provider request',async()=>{
    const f=fixture();f.queue('a');
    f.channel.setOwnershipGuard(()=>{throw new Error('synthetic synchronous guard failure');});
    await f.channel.flushOutbox();expect(f.requests).toHaveLength(0);
    f.channel.setOwnershipGuard(async()=>{throw new Error('synthetic asynchronous guard failure');});
    await f.channel.flushOutbox();expect(f.requests).toHaveLength(0);
    // Production guards are Promise<boolean>; defensive runtime handling also accepts a synchronous false.
    f.channel.setOwnershipGuard((()=>false) as unknown as Parameters<FeishuModule['setOwnershipGuard']>[0]);
    await f.channel.flushOutbox();expect(f.requests).toHaveLength(0);
    expect(f.store.get("SELECT state FROM feishu_delivery_parts WHERE id='a'")?.state).toBe('pending');
  });
});
