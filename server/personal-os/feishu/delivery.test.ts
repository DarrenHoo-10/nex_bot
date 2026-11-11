import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe,it,expect,afterEach,vi } from 'vitest';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { CoreStore } from '../store.ts';
import { FeishuModule } from './module.ts';
import { FeishuApi } from './api.ts';
import { ensureFeishuDeliverySchema } from './delivery.ts';
import { normalizeFeishuEvent } from './transport.ts';
import type { AgentModule } from '../agents.ts';
import type { TaskRuntime } from '../runtime.ts';
import { messageEvent,cardActionEvent } from '../testing/fake-feishu.ts';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse()) await close();});
const settle=()=>new Promise(resolve=>setTimeout(resolve,40));
function fixture() {
  const dir=mkdtempSync(path.join(os.tmpdir(),'feishu-ledger-'));
  const store=new CoreStore(dir,randomBytes(32),'synthetic');
  let owner='ou_owner',sequence=0,failAt=0;
  const sent:Array<{method:string,path:string,body:Record<string,unknown>}>=[];
  const send=vi.fn((_bot:string,_text:string,_client:string,_session:string,options:{conversationId?:string})=>({taskId:`task-${++sequence}`,conversationId:options.conversationId??`conversation-${sequence}`,messageId:`input-${sequence}`}));
  const createTopic=vi.fn(()=>{const bot=store.get('SELECT id FROM bots')??{id:store.createBot('fixture')};return {id:store.createConversation(String(bot.id),`report-${++sequence}`)};});
  const agents={send,createTopic,publish:vi.fn()} as unknown as AgentModule;
  const runtime={taskRoot:(id:string)=>id} as unknown as TaskRuntime;
  const channel=new FeishuModule(store,()=>{},agents,runtime,{registerApp:async()=>{throw new Error('unused');},sharedApp:(appId)=>({app_id:appId,enabled:1,owner_open_id:owner,bot_id:'finance',bot_open_id:'ou_fake_bot',tenant_key:'fake'}),sendRequest:async(_appId,method,url,body,beforeSend)=>{
    const payload=body as Record<string,unknown>;
    if(failAt && sent.length+1===failAt){failAt=0;throw new Error('synthetic interruption');}
    beforeSend?.();
    sent.push({method,path:url,body:payload});
    return {data:{message_id:`out-${sent.length}`}};
  }});
  cleanups.push(async()=>{await channel.close();store.close();if(path.dirname(dir)!==os.tmpdir()||!path.basename(dir).startsWith('feishu-ledger-'))throw new Error('cleanup');rmSync(dir,{recursive:true,force:true});});
  const event=(id:string,chat='chat',parentId?:string,group=false,actor='ou_owner')=>messageEvent({messageId:id,chatId:chat,parentId,chatType:group?'group':'p2p',senderOpenId:actor,content:JSON.stringify({text:'question'}),...(group?{mentions:[{id:{open_id:'ou_fake_bot'},key:'@bot'}]}:{})});
  return {store,channel,send,createTopic,sent,event,revoke:()=>{owner='revoked';},fail:(at:number)=>{failAt=at;}};
}

describe('Feishu durable routing and SDK boundary',()=>{
  it('normalizes real SDK message/card callbacks and wrapped fixtures identically',async()=>{
    const f=fixture(),bodies:unknown[]=[];
    const dispatcher=new EventDispatcher({}).register({
      'im.message.receive_v1':(raw:unknown)=>{bodies.push(raw);f.channel.receiveMessage('cli_fake',normalizeFeishuEvent(raw));},
      'card.action.trigger':(raw:unknown)=>{bodies.push(raw);return f.channel.handleCardAction('cli_fake',normalizeFeishuEvent(raw));},
    } as never);
    await dispatcher.invoke(f.event('sdk'),{needCheck:false});
    await dispatcher.invoke(cardActionEvent({openId:'ou_owner',value:{kind:'unknown'}}),{needCheck:false});
    expect((bodies[0] as Record<string,unknown>).message).toBeDefined();
    expect((bodies[0] as Record<string,unknown>).event).toBeUndefined();
    expect((bodies[1] as Record<string,unknown>).operator).toBeDefined();
    await settle();expect(f.send).toHaveBeenCalledTimes(1);
    f.channel.receiveMessage('cli_fake',f.event('sdk'));await settle();expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('commits before ACK and routes independent roots plus every chunk alias to its original topic',async()=>{
    const f=fixture();f.channel.receiveMessage('cli_fake',f.event('a'));
    expect(f.store.get("SELECT state FROM personal_feishu_messages WHERE message_id='a'")?.state).toBe('pending');
    await settle();f.channel.receiveMessage('cli_fake',f.event('b'));await settle();
    expect(f.send.mock.calls[0][4]).toMatchObject({newConversation:true});
    expect(f.send.mock.calls[1][4]).toMatchObject({newConversation:true});
    const alias=f.store.get("SELECT * FROM feishu_topic_aliases WHERE alias='out-1'")!;
    f.channel.receiveMessage('cli_fake',f.event('follow','chat','out-1'));await settle();
    expect(f.send.mock.calls[2][4]).toMatchObject({conversationId:alias.conversation_id});
    f.channel.receiveMessage('cli_other', {...f.event('a'),header:{app_id:'cli_other'}});await settle();
    expect(f.send).toHaveBeenCalledTimes(4);
  });
  it('joins child-before-root and isolates equal ids in other chats',async()=>{
    const f=fixture();f.channel.receiveMessage('cli_fake',f.event('child','chat','root'));await settle();
    const first=f.store.get("SELECT conversation_id FROM personal_feishu_messages WHERE message_id='child'")!;
    f.channel.receiveMessage('cli_fake',f.event('root'));await settle();
    expect(f.send.mock.calls[1][4]).toMatchObject({conversationId:first.conversation_id});
    f.channel.receiveMessage('cli_fake',f.event('root','other'));await settle();
    expect(f.send.mock.calls[2][4]).toMatchObject({newConversation:true});
  });
  it('ignores unbound private users and permits public group members only after owner claims',async()=>{
    const f=fixture();f.channel.receiveMessage('cli_fake',f.event('stranger','private',undefined,false,'other'));
    f.channel.receiveMessage('cli_fake',f.event('unclaimed','group',undefined,true,'other'));await settle();expect(f.send).not.toHaveBeenCalled();
    f.channel.claimGroup({appId:'cli_fake',chatId:'group',actorOpenId:'ou_owner'});
    f.channel.receiveMessage('cli_fake',f.event('public','group',undefined,true,'other'));await settle();
    expect(f.send.mock.calls[0][4]).toMatchObject({audience:'public'});
    f.revoke();expect(await f.channel.channelAuthorize({id:'task-1'})).toBe(true);
    f.channel.receiveMessage('cli_fake',f.event('oldowner'));await settle();expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('selects verified public report variants, dedupes, and cancels queued deliveries when subscription changes',async()=>{
    const f=fixture();f.channel.claimGroup({appId:'cli_fake',chatId:'group',actorOpenId:'ou_owner'});
    const sub=f.channel.updateSubscription({appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['review'],audience:'public'});
    const report={instanceId:'stock',reportId:'r1',version:'1',kind:'review',tradingDay:'2026-11-10',views:[{audience:'private' as const,content:'PRIVATE HOLDINGS',verified:true},{audience:'public' as const,content:'public market',verified:true}]};
    f.channel.ingestReport(report);await settle();
    expect(JSON.stringify(f.sent)).toContain('public market');expect(JSON.stringify(f.sent)).not.toContain('PRIVATE HOLDINGS');
    f.channel.ingestReport(report);await settle();expect(f.createTopic).toHaveBeenCalledTimes(1);expect(f.sent).toHaveLength(1);
    f.fail(2);f.channel.ingestReport({...report,reportId:'r2'});await settle();
    f.channel.updateSubscription({appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['review'],audience:'public',version:sub.version,enabled:false});
    f.store.run("UPDATE feishu_delivery_parts SET next_at=0");await f.channel.flushOutbox();
    expect(f.sent).toHaveLength(1);expect(f.store.get("SELECT state FROM feishu_delivery_parts WHERE state='cancelled'")).toBeDefined();
  });
  it('retains known chunk receipts on third-part failure and resumes with the same idempotency UUID',async()=>{
    const f=fixture();f.channel.claimGroup({appId:'cli_fake',chatId:'group',actorOpenId:'ou_owner'});
    f.channel.updateSubscription({appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['brief'],audience:'public'});
    f.fail(3);f.channel.ingestReport({instanceId:'stock',reportId:'long',version:'1',kind:'brief',tradingDay:'today',views:[{audience:'public',verified:true,content:'x'.repeat(8000)}]});await settle();
    expect(f.sent).toHaveLength(2);expect(f.store.all("SELECT id FROM feishu_delivery_parts WHERE state='sent'")).toHaveLength(2);
    f.store.run("UPDATE feishu_delivery_parts SET next_at=0");await f.channel.flushOutbox();expect(f.sent).toHaveLength(3);
    expect(f.sent[1].path).toContain('/out-1/reply');expect(f.sent[2].path).toContain('/out-1/reply');
    expect(new Set(f.sent.map(s=>s.body.uuid)).size).toBe(3);
  });
  it('persists failed inbound routing and recovers the original receipt without a duplicate topic',async()=>{
    const f=fixture();f.send.mockImplementationOnce(()=>{throw new Error('synthetic crash before accept');});
    const event=f.event('recover');f.channel.receiveMessage('cli_fake',event);await settle();
    expect(f.store.get("SELECT state FROM personal_feishu_messages WHERE message_id='recover'")?.state).toBe('retry');
    expect(f.store.all('SELECT * FROM feishu_topic_aliases')).toHaveLength(0);
    f.store.run('UPDATE personal_feishu_messages SET next_at=0');f.channel.receiveMessage('cli_fake',event);await settle();
    expect(f.store.get("SELECT state FROM personal_feishu_messages WHERE message_id='recover'")?.state).toBe('routed');
    expect(f.store.all('SELECT * FROM personal_feishu_messages')).toHaveLength(1);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('reconciles subscription tool writes and pauses durable sends during ownership handoff',async()=>{
    const f=fixture();f.channel.claimGroup({appId:'cli_fake',chatId:'group',actorOpenId:'ou_owner'});
    const args={operation:'upsert',appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['review'],audience:'public'};
    const first=f.channel.manageDelivery({id:'call-1'},args);
    expect(f.channel.manageDelivery({id:'call-1'},args)).toEqual(first);
    expect(()=>f.channel.manageDelivery({id:'call-1'},{...args,kinds:['other']})).toThrow('操作标识内容冲突');
    f.channel.setOwnershipGuard(async()=>false);
    f.channel.ingestReport({instanceId:'stock',reportId:'paused',version:'1',kind:'review',tradingDay:'today',views:[{audience:'public',verified:true,content:'market'}]});await settle();
    expect(f.sent).toHaveLength(0);expect(f.store.get("SELECT state FROM feishu_delivery_parts")?.state).toBe('pending');
    f.channel.setOwnershipGuard(async()=>true);await f.channel.flushOutbox();expect(f.sent).toHaveLength(1);
  });

  it('persists report scenarios, applies current scenarios on retry, and migrates old rows as proactive',async()=>{
    const f=fixture();f.channel.claimGroup({appId:'cli_fake',chatId:'group',actorOpenId:'ou_owner'});
    const sub=f.channel.updateSubscription({appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['review'],scenarios:['scheduled'],audience:'public'});
    f.channel.setOwnershipGuard(async()=>false);
    f.channel.ingestReport({instanceId:'stock',reportId:'scheduled',version:'1',kind:'review',tradingDay:'today',scenario:'scheduled',views:[{audience:'public',verified:true,content:'market'}]});await settle();
    expect(f.store.get('SELECT scenario FROM feishu_delivery_parts')?.scenario).toBe('scheduled');
    f.channel.updateSubscription({appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['review'],scenarios:['proactive'],audience:'public',version:sub.version});
    f.channel.setOwnershipGuard(async()=>true);await f.channel.flushOutbox();
    expect(f.sent).toHaveLength(0);expect(f.store.get('SELECT state FROM feishu_delivery_parts')?.state).toBe('cancelled');
    f.store.db.exec('ALTER TABLE feishu_delivery_parts DROP COLUMN scenario');ensureFeishuDeliverySchema(f.store);
    expect(f.store.get('SELECT scenario FROM feishu_delivery_parts')?.scenario).toBe('proactive');
  });
  it.each(['authorization','ownership'] as const)('cancels a claimed part when rules change during %s await',async(phase)=>{
    const f=fixture();f.channel.claimGroup({appId:'cli_fake',chatId:'group',actorOpenId:'ou_owner'});
    const sub=f.channel.updateSubscription({appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['review'],audience:'public'});
    let release!:()=>void,entered!:()=>void;
    const blocked=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>entered=r);
    if(phase==='authorization')f.channel.setRouting({authorizeActor:async()=>{entered();await blocked;return true;}});
    else {let checks=0;f.channel.setOwnershipGuard(async(_app,operation)=>{if(operation==='send'&&++checks===2){entered();await blocked;}return true;});}
    f.channel.ingestReport({instanceId:'stock',reportId:'race',version:'1',kind:'review',tradingDay:'today',views:[{audience:'public',verified:true,content:'market'}]});
    await reached;
    f.channel.updateSubscription({appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['review'],scenarios:['manual'],audience:'public',version:sub.version});
    release();await settle();
    expect(f.sent).toHaveLength(0);expect(f.store.get('SELECT state FROM feishu_delivery_parts')?.state).toBe('cancelled');
  });
  it.each(['unsubscribe','move','unbind'] as const)('rechecks destination and actor immediately before send after %s',async(mutation)=>{
    const f=fixture();f.channel.claimGroup({appId:'cli_fake',chatId:'group',actorOpenId:'ou_owner'});
    const sub=f.channel.updateSubscription({appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['review'],audience:'public'});
    let release!:()=>void,entered!:()=>void;
    const blocked=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>entered=r);
    let checks=0;f.channel.setOwnershipGuard(async(_app,operation)=>{if(operation==='send'&&++checks===2){entered();await blocked;}return true;});
    f.channel.ingestReport({instanceId:'stock',reportId:'destination-race',version:'1',kind:'review',tradingDay:'today',views:[{audience:'public',verified:true,content:'market'}]});await reached;
    if(mutation==='unbind')f.revoke();
    else {
      f.channel.updateSubscription({appId:'cli_fake',chatId:'group',instanceId:'stock',kinds:['review'],audience:'public',enabled:false,version:sub.version});
      if(mutation==='move'){
        f.channel.claimGroup({appId:'cli_fake',chatId:'other-group',actorOpenId:'ou_owner'});
        f.channel.updateSubscription({appId:'cli_fake',chatId:'other-group',instanceId:'stock',kinds:['review'],audience:'public'});
      }
    }
    release();await settle();expect(f.sent).toHaveLength(0);expect(f.store.get('SELECT state FROM feishu_delivery_parts')?.state).toBe('cancelled');
  });
  it('runs the final guard after the real API token await before making a message HTTP request',async()=>{
    let release!:()=>void,entered!:()=>void,allowed=true,messageRequests=0;
    const blocked=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>entered=r);
    const api=new FeishuApi((async(input)=>{
      if(String(input).includes('/auth/v3/tenant_access_token/internal')){entered();await blocked;return Response.json({code:0,tenant_access_token:'synthetic',expire:7200});}
      messageRequests++;return Response.json({code:0,data:{message_id:'should-not-send'}});
    }) as typeof fetch);
    const sending=api.request({appId:'cli_guard',appSecret:'synthetic',brand:'feishu'},'POST','/open-apis/im/v1/messages',{},()=>{if(!allowed)throw new Error('rules_changed');});
    const rejected=expect(sending).rejects.toThrow('rules_changed');
    await reached;allowed=false;release();await rejected;expect(messageRequests).toBe(0);
  });

});
