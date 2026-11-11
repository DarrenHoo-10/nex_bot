import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createPersonalApp } from '../index.ts';

it('exposes outbox only through authenticated owner settings and verifies receipts without a chat POST',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'feishu-outbox-http-'));
  let providerRequests=0;
  const content=JSON.stringify({elements:[{tag:'markdown',content:'synthetic report'}]});
  const app=await createPersonalApp({dir,key:randomBytes(32),token:'fixture',identity:false,hostDevice:false,memoryRuntime:false,modelCatalog:{fetchDisabled:true},feishu:{
    registerApp:async()=>{throw new Error('unused');},ownershipAllowed:async()=>true,
    sharedApp:appId=>({app_id:appId,enabled:1,owner_open_id:'ou_owner',bot_id:'fixture',bot_open_id:'ou_bot'}),
    sendRequest:async(_app,method,url)=>{
      providerRequests++;expect(method).toBe('GET');expect(url).toContain('card_msg_content_type=user_card_content');
      return {data:{items:[{message_id:'om_verified',chat_id:'oc_chat',msg_type:'interactive',sender:{id:'cli_app',id_type:'app_id',sender_type:'app'},body:{content}}]}};
    },
  }});
  const request=(route:string,token:string,data?:unknown)=>fetch(app.origin+'/api/'+route,{headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(data?{method:'POST',body:JSON.stringify(data)}:{})});
  try {
    app.feishu.claimGroup({appId:'cli_app',chatId:'oc_chat',actorOpenId:'ou_owner'});
    app.store.insert('feishu_delivery_parts',{id:'part',source_key:'report',app_id:'cli_app',chat_id:'oc_chat',conversation_id:'topic',content,part:0,uuid:'stable',state:'needs_reconciliation',attempts:2,actor_open_id:'ou_owner',audience:'public',created_at:Date.now(),post_tracking_version:1});
    expect((await request('feishu/deliveries','invalid')).status).toBe(401);
    expect((await request('feishu/deliveries/reconcile','invalid',{id:'part',action:'not_delivered'})).status).toBe(401);
    const listing=await request('feishu/deliveries','fixture');expect(listing.status).toBe(200);
    expect((await listing.json() as {parts:unknown[]}).parts).toMatchObject([{id:'part',state:'needs_reconciliation',chat_id:'oc_chat'}]);
    const confirmed=await request('feishu/deliveries/reconcile','fixture',{id:'part',action:'delivered',messageId:'om_verified',evidence:'matched original destination and card'});
    const receipt=await confirmed.json();expect(receipt).toEqual({id:'part',state:'sent'});expect(confirmed.status).toBe(200);
    expect(providerRequests).toBe(1);expect(app.store.get("SELECT alias FROM feishu_topic_aliases WHERE conversation_id='topic'")?.alias).toBe('om_verified');
  } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
},30000);
