import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
import { startFakePersonalMemory } from './testing/fake-personal-memory.ts';
import { hash } from './store.ts';
import { assistantCompletion } from './assistant-model.ts';
import { ChatFiles } from './chat-files.ts';
import { tokens } from './token-estimate.ts';
import { systemPromptText } from './context-tools.ts';

type Fixture={root:string;fake:Awaited<ReturnType<typeof startFakePersonalMemory>>;app:Awaited<ReturnType<typeof createPersonalApp>>;bot:string};
const fixtures:Fixture[]=[];
async function fixture(){
  const root=mkdtempSync(path.join(os.tmpdir(),'nex-continuity-')),fake=await startFakePersonalMemory();
  const app=await createPersonalApp({dir:root,key:randomBytes(32),token:'synthetic-token',identity:false,memoryRuntime:false,hostDevice:false});
  app.store.saveConfig({provider:'openai',endpoint:fake.origin+'/v1',model:'fixture-chat',apiKey:'synthetic-only',contextWindow:64000,maxOutputTokens:4096});
  const bot=app.store.createBot('合成个人助手');clearInterval(app.runtime.memory.personal.timer);
  const result={root,fake,app,bot};fixtures.push(result);return result;
}
async function wait(check:()=>boolean,app:Awaited<ReturnType<typeof fixture>>['app']){
  const until=Date.now()+25000;while(!check()){
    const failed=app.store.get("SELECT result_summary FROM tasks WHERE status='failed'");if(failed)throw new Error(String(failed.result_summary));
    if(Date.now()>until)throw new Error('Fixture timeout: '+JSON.stringify(app.store.all('SELECT status,result_summary FROM tasks')));await new Promise(resolve=>setTimeout(resolve,30));
  }
}
afterEach(async()=>{for(const {app,fake,root} of fixtures.splice(0)){await app.close();await fake.close();if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('nex-continuity-'))throw new Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});}});
describe('Continuous personal assistant and memory',()=>{
  it('keeps inventory, images and long results through tool continuations and the next user turn while they fit',async()=>{
    const {app,fake,bot}=await fixture();
    // The standard for "fits" is the working budget; a large explicit one keeps everything complete.
    app.store.saveConfig({provider:'openai',endpoint:fake.origin+'/v1',model:'fixture-chat',contextWindow:200000,maxOutputTokens:4096,contextBudget:150000});
    app.runtime.deviceDirectory=()=>Array.from({length:25},(_,i)=>({id:`fixture-${i}`,name:`INVENTORY-${i}`,online:true,description:'x'.repeat(250)}));
    const note=app.runtime.memory.write(bot,{title:'当前资料',content:'LONG-RESULT-BEGIN '+ '资料'.repeat(8500)+' LONG-RESULT-END'});
    const files=new ChatFiles(app.store);
    const image=files.upload({botId:bot,name:'synthetic.png',data:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(900000,65)]).toString('base64')},app.store.session);
    fake.scripts.push({action:'device.inventory',args:{}},{action:'attachment.read',args:{attachmentId:image.id}},{action:'memory.read',args:{documentId:note.documentId}},...Array.from({length:4},()=>({action:'agent.directory',args:{}})),'已核对');
    const task=app.agents.send(bot,`保留所有资料，只讨论。\n![合成图片](/api/attachments/${image.id})`,'tool-capacity').taskId;
    files.bind([image.id],bot,'tool-capacity');
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);
    const next=app.agents.send(bot,'继续比较刚才的列表和资料','tool-capacity-next').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',next)?.status==='succeeded',app);
    const request=JSON.stringify(fake.requests.at(-1));
    expect(request).toContain('INVENTORY-24');expect(request).toContain('LONG-RESULT-END');expect(request).toContain('data:image/png;base64,');
    expect(request).not.toContain('较早工具输出已收起');
    expect(fake.requests.every(row=>row.stream)).toBe(true);
    expect(app.store.all('SELECT * FROM context_checkpoints')).toHaveLength(0);
  },60000);
  it('summarizes an older result only under real pressure, retaining exact user input, recent results and paired calls',async()=>{
    const {app,fake,bot}=await fixture();
    const first=app.runtime.memory.write(bot,{title:'前期资料',content:'OLDER-DETAIL '+ '资料'.repeat(9000)});
    const second=app.runtime.memory.write(bot,{title:'最新资料',content:'RECENT-DETAIL '+ '信息'.repeat(9000)});
    fake.scripts.push({action:'memory.read',args:{documentId:first.documentId}},{action:'memory.read',args:{documentId:second.documentId}},'完成比较');
    const task=app.agents.send(bot,'USER-EXACT：只比较，不修改；保留编号 12345。','pressure').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);
    const last=fake.requests.filter(row=>row.stream).at(-1)!;
    const messages=last.messages as Array<{role:string;content:string;tool_call_id?:string;tool_calls?:Array<{id:string}>}>;
    expect(JSON.stringify(last)).toContain('USER-EXACT：只比较，不修改；保留编号 12345。');
    expect(JSON.stringify(last)).toContain('RECENT-DETAIL');expect(JSON.stringify(last)).toContain('工具结果摘要');
    for(const result of messages.filter(m=>m.role==='tool'))expect(messages.some(m=>m.tool_calls?.some(call=>call.id===result.tool_call_id))).toBe(true);
    const checkpoint=app.store.get('SELECT first_entry FROM context_checkpoints WHERE first_entry=last_entry')!;
    expect(app.agents.search(bot,'entry:'+checkpoint.first_entry)[0].content).toContain('OLDER-DETAIL');
  },60000);
  it('leaves original results intact when a pressure summary is incomplete',async()=>{
    const {app,fake,bot}=await fixture();
    const first=app.runtime.memory.write(bot,{title:'前期资料',content:'FAILURE-ORIGINAL '+ '资料'.repeat(9000)});
    const second=app.runtime.memory.write(bot,{title:'最新资料',content:'FAILURE-RECENT '+ '信息'.repeat(9000)});
    fake.scripts.push({action:'memory.read',args:{documentId:first.documentId}},{action:'memory.read',args:{documentId:second.documentId}});
    fake.setOverride(body=>body.stream?undefined:{choices:[{message:{content:'partial'},finish_reason:'length'}],usage:{prompt_tokens:50,completion_tokens:10}});
    const task=app.agents.send(bot,'保留原文，摘要失败不得丢弃内容','pressure-failure').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='failed',app);
    expect(app.store.get('SELECT result_summary FROM tasks WHERE id=?',task)?.result_summary).toContain('未完整结束');
    expect(app.store.all('SELECT * FROM context_checkpoints')).toHaveLength(0);
    const session=app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?',bot)!;
    const entries=app.runtime.projection.load(String(session.id))!;
    expect(entries.some(entry=>entry.type==='context_edit')).toBe(false);
    expect(JSON.stringify(entries)).toContain('FAILURE-ORIGINAL');expect(JSON.stringify(entries)).toContain('FAILURE-RECENT');
    expect(fake.requests.filter(row=>row.stream)).toHaveLength(2);
  },60000);
  it('pages an oversized result explicitly and retrieves original ranges without re-executing the source tool',async()=>{
    const {app,fake,bot}=await fixture();
    const files=new ChatFiles(app.store),file=files.upload({botId:bot,name:'large.txt',data:Buffer.from('PAGE-BEGIN '+ '资料'.repeat(20000)+' PAGE-END').toString('base64')},app.store.session);
    fake.scripts.push({action:'attachment.read',args:{attachmentId:file.id}},'原文已分页');
    const task=app.agents.send(bot,`读这份资料 [large.txt](/api/attachments/${file.id})`,'page-source').taskId;
    files.bind([file.id],bot,'page-source');
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);
    const messages=fake.requests.filter(row=>row.stream).at(-1)!.messages as Array<{role:string;content:string}>;
    const page=JSON.parse(messages.find(m=>m.role==='tool')!.content);
    expect(page.notice).toContain('并非完整结果');expect(page.page.nextOffset).toBeGreaterThan(0);
    const original=String(app.agents.search(bot,page.query)[0].content);
    const offset=original.indexOf('PAGE-END');expect(offset).toBeGreaterThan(page.page.nextOffset);
    fake.scripts.push({action:'memory.search',args:{query:page.query,offset,limit:100}},...Array.from({length:4},()=>({action:'agent.directory',args:{}})),'已取回末尾');
    const next=app.agents.send(bot,'取回原文末尾','page-retrieve').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',next)?.status==='succeeded',app);
    expect(JSON.stringify(fake.requests.filter(row=>row.stream).at(-1))).toContain('PAGE-END');
    expect(app.store.all("SELECT id FROM tool_calls WHERE tool_name='attachment.read'")).toHaveLength(1);
    expect(app.agents.search(app.store.createBot('另一助手'),page.query,{offset,limit:100})).toEqual([]);
    expect(()=>app.agents.search(bot,page.query,{offset:-1,limit:100})).toThrow('offset');
    expect(()=>app.agents.search(bot,page.query,{limit:100001})).toThrow('limit');
  },60000);
  // History accepted under a larger window (or earlier projection rules) must
  // compact when it suddenly far exceeds the summarizer's own window.
  async function backlog(app:Fixture['app'],bot:string,fake:Fixture['fake'],turns:Array<Array<{action:string;args:Record<string,unknown>}|string>>){
    // History accepted under a roomy working budget; a large explicit one stands in for it.
    app.store.saveConfig({provider:'openai',endpoint:fake.origin+'/v1',model:'fixture-chat',contextWindow:400000,maxOutputTokens:4096,contextBudget:400000});
    for(const [index,script] of turns.entries()){
      fake.scripts.push(...script);
      const task=app.agents.send(bot,`积压第 ${index} 轮`,`backlog-${index}`).taskId;
      await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);
    }
    expect(app.store.all('SELECT * FROM context_checkpoints')).toHaveLength(0);
    app.store.saveConfig({provider:'openai',endpoint:fake.origin+'/v1',model:'fixture-chat',contextWindow:64000,maxOutputTokens:4096,contextBudget:null});
    const summarizer=fake.requests.length;
    const task=app.agents.send(bot,'BACKLOG-NEXT：继续','backlog-next').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);
    const compact=fake.requests.slice(summarizer).filter(row=>!row.stream);
    for(const row of compact)expect(tokens(row.messages)+Number(row.max_tokens)).toBeLessThan(64000);
    return compact;
  }
  it('summarizes dominant old tool results before compacting a backlog larger than the window',async()=>{
    const {app,fake,bot}=await fixture();
    const notes=Array.from({length:5},(_,i)=>app.runtime.memory.write(bot,{title:`积压资料 ${i}`,content:`BACKLOG-RESULT-${i} `+'资料'.repeat(6000)}));
    // One turn holds every result: turn-start digests only touch turns older than the latest completed one.
    const compact=await backlog(app,bot,fake,[[...notes.map(note=>({action:'memory.read',args:{documentId:note.documentId}})),'已读完']]);
    expect(compact.filter(row=>JSON.stringify(row).includes('"status\\":\\"succeeded\\"')).length).toBeGreaterThanOrEqual(3);
    // Long-term memory recall may quote the notes in the system prompt.
    const last=JSON.stringify((fake.requests.filter(row=>row.stream).at(-1)!.messages as Array<{role:string}>).filter(message=>message.role!=='system'));
    expect(last).toContain('BACKLOG-NEXT');expect(last).not.toContain('BACKLOG-RESULT-0');
    const session=app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?',bot)!;
    const entries=app.runtime.projection.load(String(session.id))!;
    const edit=entries.find(entry=>entry.type==='context_edit')!;
    expect(JSON.stringify(edit)).toContain('工具结果摘要');
    expect(app.agents.search(bot,'entry:'+(edit as {targetId:string}).targetId)[0].content).toMatch(/BACKLOG-RESULT-\d/);
  },90000);
  it('compacts a backlog of long turns in window-sized batches carrying the running summary',async()=>{
    const {app,fake,bot}=await fixture();
    const compact=await backlog(app,bot,fake,Array.from({length:5},(_,i)=>[`BACKLOG-REPLY-${i} `+'回答'.repeat(5000)]));
    expect(compact.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(compact[0])).toContain('BACKLOG-REPLY-0');expect(JSON.stringify(compact[0])).not.toContain('"role\\":\\"summary\\"');
    expect(JSON.stringify(compact.at(-1))).toContain('"role\\":\\"summary\\"');
    const last=JSON.stringify(fake.requests.filter(row=>row.stream).at(-1));
    expect(last).toContain('工作笔记');expect(last).toContain('BACKLOG-NEXT');expect(last).not.toContain('BACKLOG-REPLY-0');
  },90000);
  it('uses the unified memory model for every assistant and preserves it across toggles and restart',async()=>{
    const {app,bot,fake}=await fixture(),memory=app.runtime.memory.personal;
    memory.saveGlobal({version:0,enabled:true,model:'fixture-memory'});
    const other=app.store.createBot('不同聊天模型的助手');
    const config=app.store.modelConfig();
    app.agents.updateModel({id:other,provider:config.provider,endpoint:config.endpoint,model:'other-chat',version:0});
    for(const target of [bot,other])app.agents.publish(target,'user','message','请记住此合成偏好','preference:'+target);
    await memory.flush();await memory.flush();
    expect(memory.rows(bot).length).toBeGreaterThan(0);expect(memory.rows(other).length,JSON.stringify(memory.settings(other))).toBeGreaterThan(0);
    expect(fake.requests.length).toBeGreaterThan(0);expect(fake.requests.every(request=>request.model==='fixture-memory')).toBe(true);
    const cursor=memory.settings(bot).cursor_seq,controller=new AbortController();memory.controller=controller;
    memory.saveGlobal({version:1,enabled:true,model:'replacement-memory'});
    expect(controller.signal.aborted).toBe(true);expect(memory.settings(bot).cursor_seq).toBe(cursor);
    expect(memory.settings(other).model).toBe('replacement-memory');
    expect(()=>memory.saveGlobal({version:1,enabled:true,model:'stale'})).toThrow('已变化');
    expect(()=>memory.saveGlobal({version:2,enabled:true,model:123})).toThrow('模型');
    memory.saveGlobal({version:2,enabled:false});
    expect(memory.summary()).toMatchObject({enabled:0,model:'replacement-memory'});
    const {CoreStore}=await import('./store.ts');const reopened=new CoreStore(app.store.dir,app.store.key,'synthetic-token');
    try{expect(reopened.get('SELECT model FROM workspace_memory_settings')?.model).toBe('replacement-memory');}finally{reopened.close();}
    memory.saveGlobal({version:3,enabled:true,model:''});
    fake.requests.length=0;app.agents.publish(other,'user','message','新的合成偏好','next');
    await memory.flush();await memory.flush();
    expect(fake.requests.length).toBeGreaterThan(0);expect(fake.requests.every(request=>request.model==='fixture-chat')).toBe(true);
  });
  it('uses one persistent switch for existing and future assistants and rejects stale changes',async()=>{
    const {app,bot}=await fixture(), memory=app.runtime.memory.personal;
    const other=app.store.createBot('第二助手');
    expect(memory.summary()).toMatchObject({enabled:0,totalTokens:0,incomplete:false});
    memory.saveGlobal({version:0,enabled:true});
    expect(memory.enabled(bot)).toBe(true);expect(memory.enabled(other)).toBe(true);
    const future=app.store.createBot('后来创建的助手');expect(memory.enabled(future)).toBe(true);
    app.agents.publish(future,'user','message','第一条也要保留','first');
    expect(memory.settings(future).cursor_seq).toBe(0);
    const abort=new AbortController();memory.controller=abort;
    memory.saveGlobal({version:1,enabled:false});
    expect(abort.signal.aborted).toBe(true);
    for(const target of [bot,other,future])expect(memory.enabled(target)).toBe(false);
    app.agents.publish(future,'user','message','关闭期间的消息','off');
    expect(()=>memory.saveGlobal({version:1,enabled:true})).toThrow('已变化');
    memory.saveGlobal({version:2,enabled:true});
    expect(memory.settings(future).cursor_seq).toBe(2);
    const {CoreStore}=await import('./store.ts');
    const reopened=new CoreStore(app.store.dir,app.store.key,'synthetic-token');
    try{expect(reopened.get('SELECT enabled,version FROM workspace_memory_settings')).toMatchObject({enabled:1,version:3});}finally{reopened.close();}
  });
  it('aggregates lifetime memory tokens without counting compaction or cache twice',async()=>{
    const {app,bot}=await fixture(),other=app.store.createBot('第二助手'),memory=app.runtime.memory.personal;
    for(const [id,target,purpose,input,output,cache] of [['a',bot,'retain',100,20,80],['b',other,'reflect',200,30,100],['c',bot,'compact',999,999,500],['d',bot,'retain',null,null,null]] as const){
      app.store.run('INSERT INTO assistant_usage(id,bot_id,purpose,model,status,reserved_tokens,input_tokens,output_tokens,cache_read,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,target,purpose,'fixture','succeeded',2000,input,output,cache,1);
    }
    expect(memory.summary()).toMatchObject({totalTokens:350,incomplete:true});
    memory.saveGlobal({version:0,enabled:true});memory.saveGlobal({version:1,enabled:false});
    expect(memory.summary()).toMatchObject({totalTokens:350,incomplete:true});
  });
  it('migrates mixed old switches to off without changing saved models or budgets',async()=>{
    const {app,bot}=await fixture(),other=app.store.createBot('旧关闭助手');
    app.runtime.memory.personal.save(bot,{version:0,enabled:true,model:'fixture-memory',dailyBudget:80000});
    app.store.run('UPDATE assistant_memory_settings SET enabled=0 WHERE bot_id=?',other);
    app.store.db.exec('DROP TABLE conversation_episodes; DROP TABLE conversation_episode_search; DROP TABLE conversation_topic_marks; ALTER TABLE assistant_memory_settings DROP COLUMN episode_cursor; DROP TABLE maintenance_runs; DROP INDEX assistant_usage_maintain; ALTER TABLE assistant_usage DROP COLUMN conversation_id; ALTER TABLE model_limit_overrides DROP COLUMN context_budget; DROP TABLE model_calibration; DROP TABLE agent_approval_rules; DROP TABLE workspace_memory_settings; DROP TABLE attachment_objects; DROP TABLE image_model_selections; DROP TABLE image_models; DROP INDEX IF EXISTS personal_connector_account; DROP TABLE personal_feishu_apps; DROP TABLE personal_feishu_messages; DROP TABLE personal_feishu_outbound; DELETE FROM schema_migrations WHERE version>=16;');
    app.store.db.exec('ALTER TABLE personal_connectors DROP COLUMN provider; ALTER TABLE personal_connectors DROP COLUMN account; ALTER TABLE personal_connectors DROP COLUMN kind;');
    const {CoreStore}=await import('./store.ts');
    const reopened=new CoreStore(app.store.dir,app.store.key,'synthetic-token');
    try {
      expect(reopened.get('SELECT version FROM schema_migrations WHERE version=29')?.version).toBe(29);
      expect(reopened.get('SELECT COUNT(*) n FROM conversation_episodes')?.n).toBe(0);
      expect(reopened.get('SELECT COUNT(*) n FROM conversation_episode_search')?.n).toBe(0);
      expect(reopened.get('SELECT COUNT(*) n FROM conversation_topic_marks')?.n).toBe(0);
      expect(reopened.get("SELECT COUNT(*) n FROM pragma_table_info('assistant_memory_settings') WHERE name='episode_cursor'")?.n).toBe(1);
      expect(reopened.get('SELECT COUNT(*) n FROM maintenance_runs')?.n).toBe(0);
      expect(reopened.get("SELECT COUNT(*) n FROM pragma_table_info('assistant_usage') WHERE name='conversation_id'")?.n).toBe(1);
      expect(reopened.get("SELECT COUNT(*) n FROM pragma_table_info('model_limit_overrides') WHERE name='context_budget'")?.n).toBe(1);
      expect(reopened.get('SELECT COUNT(*) n FROM model_calibration')?.n).toBe(0);
      expect(reopened.get('SELECT enabled FROM workspace_memory_settings')?.enabled).toBe(0);
      expect(reopened.all('SELECT enabled FROM assistant_memory_settings').every(row=>row.enabled===0)).toBe(true);
      expect(reopened.get('SELECT model,daily_budget FROM assistant_memory_settings WHERE bot_id=?',bot)).toMatchObject({model:'fixture-memory',daily_budget:80000});
    } finally {reopened.close();}
  });
  it('exposes the global switch through authenticated routes and refuses old per-assistant writes',async()=>{
    const {app,bot}=await fixture();
    const post=(route:string,data:unknown,token='synthetic-token')=>fetch(app.origin+'/api/memory/'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)});
    expect((await post('summary',{},'invalid')).status).toBe(401);
    expect(await (await post('settings',{version:0,enabled:true})).json()).toMatchObject({enabled:1,version:1});
    expect((await post('settings',{botId:bot,version:1,enabled:false})).ok).toBe(false);
    expect(await (await post('summary',{})).json()).toMatchObject({enabled:1});
  });
  it('keeps full turns beyond twelve messages in the same logical conversation',async()=>{
    const {app,fake,bot}=await fixture();
    for(let n=0;n<15;n++){
      const task=app.agents.send(bot,n?'继续第'+n+'轮':'只讨论，不部署。唯一标记 INITIAL-REFERENCE','round-'+n).taskId;
      await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);
      await wait(()=>!app.runtime.workers.size,app);
    }
    expect(app.store.all('SELECT DISTINCT conversation_id FROM tasks WHERE bot_id=?',bot)).toHaveLength(1);
    expect(JSON.stringify(fake.requests.at(-1))).toContain('INITIAL-REFERENCE');
    expect((fake.requests.at(-1)?.tools as unknown[])?.length).toBe(1);
    expect(app.store.all('SELECT * FROM agent_messages WHERE bot_id=?',bot)).toHaveLength(30);
    expect(app.store.get('SELECT cache_read FROM model_invocations ORDER BY created_at DESC LIMIT 1')?.cache_read).toBe(100);
  },90000);
  it('compacts repeatedly without deleting originals and exposes entry references',async()=>{
    const {app,fake,bot}=await fixture();
    for(let n=0;n<10;n++){
      const task=app.agents.send(bot,(n?'旧讨论资料':'只讨论，不部署。INITIAL-REFERENCE')+'。合成资料'.repeat(1800),'long-'+n).taskId;
      await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);
    }
    const checkpoints=app.store.all('SELECT * FROM context_checkpoints');expect(checkpoints.length).toBeGreaterThan(1);
    expect(app.store.all('SELECT * FROM agent_messages WHERE bot_id=?',bot)).toHaveLength(20);
    expect(JSON.stringify(fake.requests.at(-1))).toContain('只讨论，不部署');
    expect(app.agents.search(bot,'entry:'+checkpoints[0].first_entry)).toHaveLength(1);
    expect(app.runtime.memory.personal.monitor(bot).groups.some(row=>row.purpose==='compact')).toBe(true);
  },90000);
  it('starts after opt-in, uses selected model, builds grounded understanding and reports usage',async()=>{
    const {app,fake,bot}=await fixture(),memory=app.runtime.memory.personal;
    app.agents.publish(bot,'user','message','旧历史不得自动导入','old');
    memory.save(bot,{version:0,enabled:true,model:'fixture-memory',dailyBudget:100000});
    app.agents.publish(bot,'user','message','这个项目先讨论完整方案，再实现','new');
    await memory.flush();
    expect(fake.requests).toHaveLength(3);expect(fake.requests.every(request=>request.model==='fixture-memory')).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain('旧历史不得自动导入');
    expect(memory.rows(bot).map(row=>row.kind)).toEqual(expect.arrayContaining(['fact','observation','understanding']));
    expect(memory.monitor(bot).totals).toMatchObject({input_tokens:1200,output_tokens:240,cache_read:300,unknown_calls:0});
    const recalled=memory.recall(bot,'项目方案');expect(recalled.length).toBeGreaterThan(0);
    expect(app.runtime.memory.expand(bot,recalled[0].refs[0]).content).toContain('讨论完整方案');
    const other=app.store.createBot('另一助手');expect(()=>app.runtime.memory.expand(other,recalled[0].refs[0])).toThrow();
  });
  it('pauses at budget, keeps pending work, and refuses invented provenance atomically',async()=>{
    const {app,fake,bot}=await fixture(),memory=app.runtime.memory.personal;
    memory.save(bot,{version:0,enabled:true,model:'fixture-memory',dailyBudget:100});app.agents.publish(bot,'user','message','记住项目约束','source');
    await memory.flush();expect(fake.requests).toHaveLength(0);expect(memory.monitor(bot).pending).toBe(1);expect(memory.settings(bot).last_error).toContain('预算');
    memory.save(bot,{version:1,enabled:true,model:'fixture-memory',dailyBudget:100000});
    fake.setOverride(()=>({choices:[{message:{content:JSON.stringify({items:[{kind:'fact',title:'伪造',content:'没有来源',sources:['unseen-source']}]})},finish_reason:'stop'}]}));
    await memory.flush();expect(memory.rows(bot)).toHaveLength(0);expect(memory.monitor(bot).pending).toBe(1);expect(memory.monitor(bot).totals?.unknown_calls).toBe(1);
  });
  it('rejects a late result after disabling, and does not consume its source cursor',async()=>{
    const {app,fake,bot}=await fixture(),memory=app.runtime.memory.personal;
    memory.save(bot,{version:0,enabled:true,dailyBudget:100000});app.agents.publish(bot,'user','message','尚未提取的偏好','source');
    let release!:()=>void;fake.setOverride(async()=>{await new Promise<void>(resolve=>{release=resolve;});return undefined;});
    const job=memory.flush();await wait(()=>!!release,app);
    memory.save(bot,{version:1,enabled:false,dailyBudget:100000});release();await job;
    expect(memory.rows(bot)).toHaveLength(0);expect(memory.settings(bot).cursor_seq).toBe(0);expect(memory.recall(bot,'偏好')).toEqual([]);
  });
  it('does not store incomplete summaries, counts unknown usage, and handles Anthropic cache totals',async()=>{
    const {app,fake,bot}=await fixture();
    fake.setOverride(()=>({choices:[{message:{content:'partial'},finish_reason:'length'}],usage:{prompt_tokens:50,completion_tokens:10}}));
    await expect(assistantCompletion(app.store,{botId:bot,purpose:'compact',instruction:'summary',content:'source'})).rejects.toThrow('未完整结束');
    expect(app.store.get('SELECT status FROM assistant_usage')?.status).toBe('invalid');
    app.store.saveConfig({provider:'anthropic',endpoint:fake.origin,model:'fixture-chat',apiKey:'synthetic-only'});
    fake.setOverride(()=>({content:[{type:'text',text:'完整'}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:5,cache_read_input_tokens:100,cache_creation_input_tokens:30}}));
    await assistantCompletion(app.store,{botId:bot,purpose:'retain',instruction:'summary',content:'source'});
    expect(app.store.get('SELECT input_tokens,cache_read,cache_write FROM assistant_usage ORDER BY created_at DESC LIMIT 1')).toMatchObject({input_tokens:150,cache_read:100,cache_write:30});
  });
  it('forgets original and derived memories without resurrecting background content',async()=>{
    const {app,bot}=await fixture(),memory=app.runtime.memory.personal;
    memory.save(bot,{version:0,enabled:true,dailyBudget:100000});app.agents.publish(bot,'user','message','待遗忘的合成偏好','source');await memory.flush();
    const plan=app.runtime.memory.privacy.preview(bot,{query:'待遗忘'});app.runtime.memory.forget(bot,{query:'待遗忘'},plan.revision);
    expect(app.store.all('SELECT * FROM assistant_memories')).toHaveLength(0);
    expect(app.store.all('SELECT * FROM assistant_memory_versions')).toHaveLength(0);
    expect(app.store.get('SELECT content FROM agent_messages')?.content).toBe('[已遗忘]');
    expect(hash('[已遗忘]')).not.toBe(hash('待遗忘的合成偏好'));
  });
  it('checks tool continuations and preserves paired tool calls during compaction',async()=>{
    const {app,fake,bot}=await fixture();
    const note=app.runtime.memory.write(bot,{title:'合成资料',content:'资料'.repeat(9500)});
    const first=app.agents.send(bot,'保留初始约束。'+'旧材料'.repeat(3000),'tool-setup').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',first)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);
    fake.scripts.push({action:'memory.read',args:{documentId:note.documentId}},'已读取资料');
    const task=app.agents.send(bot,'读取资料，遵守初始约束','tool-followup').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);
    const requests=fake.requests.filter(row=>row.stream);
    const last=requests.at(-1)!;expect(last.tools).toHaveLength(1);
    const messages=last.messages as Array<{role:string;tool_call_id?:string;tool_calls?:Array<{id:string}>}>;
    const resultIndex=messages.findIndex(row=>row.role==='tool');expect(resultIndex).toBeGreaterThan(0);
    expect(messages.slice(0,resultIndex).some(row=>row.tool_calls?.some(call=>call.id===messages[resultIndex].tool_call_id))).toBe(true);
    expect(app.store.all('SELECT * FROM context_checkpoints').length).toBeGreaterThan(0);
  },60000);
  const turn=async(app:Fixture['app'],bot:string,text:string,key:string,status='succeeded')=>{
    const task=app.agents.send(bot,text,key).taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status===status,app);
    // A failed task is reported by wait() as an error while its worker is still closing.
    while(app.runtime.workers.size)await new Promise(resolve=>setTimeout(resolve,20));
    return task;
  };
  const streamed=(fake:Fixture['fake'])=>fake.requests.filter(row=>row.stream);
  it('stores the projection as rows and calibrates the model from each completed receipt',async()=>{
    const {app,fake,bot}=await fixture();
    fake.setUsageScale(.5);
    await turn(app,bot,'第一轮：只讨论。','calibrate-one');await turn(app,bot,'第二轮：继续。','calibrate-two');
    const runtime=String(app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?',bot)!.id),projection=app.runtime.projection;
    const stored=projection.load(runtime)!;
    expect(stored[0].type).toBe('session');
    expect(projection.db.prepare('SELECT seq FROM projection_entries WHERE runtime_id=? ORDER BY seq').all(runtime).map(row=>row.seq)).toEqual(stored.map((_,index)=>index));
    expect(projection.db.prepare('SELECT COUNT(*) n FROM projections').get()?.n).toBe(0);
    const config=app.store.modelConfig(),row=app.store.get('SELECT * FROM model_calibration')!;
    expect(row).toMatchObject({provider:config.provider,endpoint:config.endpoint,model:config.model});
    expect(Number(row.samples)).toBe(streamed(fake).length);expect(Number(row.ratio)).toBeGreaterThan(.45);expect(Number(row.ratio)).toBeLessThan(.55);
    expect(app.store.calibration.ratio(config)).toBe(Number(row.ratio));
    // The receipt's input is what the provider reported, i.e. half the offline estimate of the request.
    const last=streamed(fake).at(-1)!,input=Number(app.store.get('SELECT input_tokens FROM model_invocations ORDER BY created_at DESC LIMIT 1')!.input_tokens);
    expect(input).toBeGreaterThan(tokens(last)*.45);expect(input).toBeLessThan(tokens(last)*.55);
  },60000);
  // Three 10500-character turns put the raw estimate between the 51,200-token trigger and 90% of the 64,000-token window.
  const ballast='合成资料'.repeat(2625);
  it('starts reduction on the calibrated count: a raw estimate above the trigger waits, one near the window still reduces',async()=>{
    const control=await fixture();
    for(const n of [0,1,2])await turn(control.app,control.bot,`第${n}轮 ${ballast}`,'control-'+n);
    expect(control.app.store.all('SELECT * FROM context_checkpoints').length).toBeGreaterThan(0);
    const {app,fake,bot}=await fixture();
    fake.setUsageScale(.5);app.store.calibration.record(app.store.modelConfig(),1000,2000);
    for(const n of [0,1,2])await turn(app,bot,`第${n}轮 ${ballast}`,'calibrated-'+n);
    const last=streamed(fake).at(-1)!,raw=tokens(last);
    expect(raw).toBeGreaterThan(51200);expect(raw).toBeLessThan(64000*.9);
    expect(app.store.all('SELECT * FROM context_checkpoints')).toHaveLength(0);
    expect(app.runtime.projection.load(String(app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?',bot)!.id))!.some(entry=>entry.type==='compaction'||entry.type==='context_edit')).toBe(false);
    expect(JSON.stringify(last)).toContain('第0轮');
    expect(fake.requests.every(row=>row.stream)).toBe(true);
    // The raw estimate would no longer fit the window soon: reduction starts however low the ratio reads.
    await turn(app,bot,`第3轮 ${ballast}`,'calibrated-3');
    expect(app.store.all('SELECT * FROM context_checkpoints').length).toBeGreaterThan(0);
    expect(tokens(streamed(fake).at(-1))).toBeLessThan(64000-256);
  },180000);
  it('keeps the raw estimate for capacity: a request that reduction cannot fit is refused however the ratio reads',async()=>{
    const {app,fake,bot}=await fixture();
    app.store.saveConfig({provider:'openai',endpoint:fake.origin+'/v1',model:'fixture-chat',contextWindow:40000,maxOutputTokens:4096});
    fake.setUsageScale(.3);app.store.calibration.record(app.store.modelConfig(),1000,10000);
    expect(app.store.calibration.ratio(app.store.modelConfig())).toBe(.3);
    // About 55,000 raw tokens in one input: 16,500 calibrated, far below the 32,000 trigger, but above the 40,000 window.
    const task=await turn(app,bot,'合成资料'.repeat(8000),'oversize','failed');
    expect(app.store.get('SELECT result_summary FROM tasks WHERE id=?',task)?.result_summary).toContain('仍超过输入预算');
    expect(fake.requests).toHaveLength(0);expect(app.store.all('SELECT * FROM context_checkpoints')).toHaveLength(0);
  },60000);
  type Wire={role:string;content:unknown;tool_calls?:unknown};
  const configure=(app:Fixture['app'],fake:Fixture['fake'],extra:Record<string,unknown>)=>app.store.saveConfig({provider:'openai',endpoint:fake.origin+'/v1',model:'fixture-chat',maxOutputTokens:4096,...extra});
  const bigDoc=(app:Fixture['app'],bot:string,label:string)=>app.runtime.memory.write(bot,{title:label,content:`${label} `+'资料'.repeat(1500)});
  const runtimeOf=(app:Fixture['app'],bot:string)=>String(app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?',bot)!.id);
  const withoutSystem=(request:Record<string,unknown>)=>JSON.stringify((request.messages as Wire[]).filter(message=>message.role!=='system'&&message.role!=='developer'));
  it('reduces at the working budget although the whole request fits the window, and sends what cannot reach the target but still fits',async()=>{
    const {app,fake,bot}=await fixture();
    configure(app,fake,{contextWindow:200000,contextBudget:12000});
    const note=bigDoc(app,bot,'BUDGET-RESULT');
    fake.scripts.push({action:'memory.read',args:{documentId:note.documentId}},'第一轮完成');
    // The current turn is protected: ~13,500 tokens of result exceed the budget yet fit the window, so the request is sent as is.
    await turn(app,bot,'读取资料','budget-one');
    expect(JSON.stringify(streamed(fake).at(-1))).toContain('BUDGET-RESULT');expect(streamed(fake).length).toBe(2);
    expect(app.store.all('SELECT * FROM context_checkpoints')).toHaveLength(0);
    // The next turn starts above the budget: the earlier turn is summarized. The base prompt alone may exceed half the budget; the request still goes out.
    const next=await turn(app,bot,'继续','budget-two');
    expect(app.store.all('SELECT * FROM context_checkpoints').length).toBeGreaterThan(0);
    expect(withoutSystem(streamed(fake).at(-1)!)).not.toContain('BUDGET-RESULT');
    expect(app.store.get('SELECT status FROM tasks WHERE id=?',next)?.status).toBe('succeeded');
  },90000);
  it('defaults the working budget to min(64k, input budget) and lets an explicit value win',async()=>{
    const {app,fake}=await fixture();
    configure(app,fake,{contextWindow:400000});
    expect(app.store.modelConfig().contextBudget).toBe(64000);
    configure(app,fake,{contextWindow:64000});
    expect(app.store.modelConfig().contextBudget).toBe(51200);
    configure(app,fake,{contextWindow:400000,contextBudget:200000});
    expect(app.store.modelConfig().contextBudget).toBe(200000);
  });
  it('starts reduction at the budget, keeps summarizing older results down to half of it and does not repeat on the next turn',async()=>{
    const {app,fake,bot}=await fixture();
    configure(app,fake,{contextWindow:200000,contextBudget:60000});
    const notes=Array.from({length:10},(_,i)=>bigDoc(app,bot,`STAGE-${i}`));
    fake.scripts.push(...notes.map(note=>({action:'memory.read',args:{documentId:note.documentId}})),'完成');
    await turn(app,bot,'逐个读取资料','stage-one');
    const sizes=streamed(fake).map(row=>tokens(row));
    const first=sizes.findIndex((_,index)=>index>0&&sizes[index]<sizes[index-1]);
    // Requests grow with each result until the budget is crossed; then older results are summarized until at most half the budget remains.
    expect(first).toBeGreaterThan(1);
    for(const size of sizes.slice(0,first))expect(size).toBeLessThan(60000);
    // The stage keeps going down to half the budget (30,000), not merely below 60,000; the newest result is never summarized.
    expect(sizes[first]).toBeLessThanOrEqual(30000+600);
    const edits=app.runtime.projection.load(runtimeOf(app,bot))!.filter(entry=>entry.type==='context_edit');
    expect(edits.length).toBeGreaterThanOrEqual(4);
    const after=app.store.all('SELECT * FROM context_checkpoints').length;
    // The turn ended below the budget: the next turn adds no further reduction.
    await turn(app,bot,'继续','stage-two');
    expect(app.store.all('SELECT * FROM context_checkpoints').length).toBe(after);
    expect(tokens(streamed(fake).at(-1))).toBeLessThan(60000);
  },120000);
  it('digests tool results of turns older than the latest completed one when a turn starts; the latest turn stays full and edited or small results are left alone',async()=>{
    const {app,fake,bot}=await fixture();
    const one=bigDoc(app,bot,'DIGEST-ONE'),two=bigDoc(app,bot,'DIGEST-TWO');
    fake.scripts.push({action:'agent.directory',args:{}},{action:'memory.read',args:{documentId:one.documentId}},'第一轮完成',{action:'memory.read',args:{documentId:two.documentId}},'第二轮完成');
    await turn(app,bot,'第一轮：读取资料','digest-1');await turn(app,bot,'第二轮：读取另一份资料','digest-2');
    const runtime=runtimeOf(app,bot),edits=()=>app.runtime.projection.load(runtime)!.filter(entry=>entry.type==='context_edit') as Array<{targetId:string}>;
    const summaries=()=>fake.requests.filter(row=>!row.stream).length;
    // Two turns: nothing is older than the latest completed turn yet.
    expect(summaries()).toBe(0);expect(edits()).toHaveLength(0);
    expect(withoutSystem(streamed(fake).at(-1)!)).toContain('DIGEST-ONE');
    await turn(app,bot,'第三轮：只讨论','digest-3');
    // Turn one's large result is digested before the first request; its small directory result is not; turn two stays complete.
    expect(summaries()).toBe(1);expect(edits()).toHaveLength(1);
    const request=withoutSystem(streamed(fake).at(-1)!);
    expect(request).toContain('DIGEST-TWO');expect(request).not.toContain('DIGEST-ONE');expect(request).toContain('工具结果摘要');
    expect(request).toContain('agent.directory');
    expect(String(app.agents.search(bot,'entry:'+edits()[0].targetId)[0].content)).toContain('DIGEST-ONE');
    // The next turn digests turn two once; turn one's already edited result is not summarized again.
    await turn(app,bot,'第四轮：继续','digest-4');
    expect(summaries()).toBe(2);expect(edits()).toHaveLength(2);
    expect(withoutSystem(streamed(fake).at(-1)!)).not.toContain('DIGEST-TWO');
    expect(String(app.agents.search(bot,'entry:'+edits()[1].targetId)[0].content)).toContain('DIGEST-TWO');
    await turn(app,bot,'第五轮：继续','digest-5');
    expect(summaries()).toBe(2);expect(edits()).toHaveLength(2);
  },120000);
  it('keeps a digest failure from failing the turn and leaves the original result',async()=>{
    const {app,fake,bot}=await fixture();
    const one=bigDoc(app,bot,'FAILED-DIGEST-ONE');
    fake.scripts.push({action:'memory.read',args:{documentId:one.documentId}},'第一轮完成');
    await turn(app,bot,'第一轮：读取资料','digest-fail-1');await turn(app,bot,'第二轮','digest-fail-2');
    fake.setOverride(body=>body.stream?undefined:{choices:[{message:{content:'partial'},finish_reason:'length'}],usage:{prompt_tokens:50,completion_tokens:10}});
    await turn(app,bot,'第三轮','digest-fail-3');
    expect(app.runtime.projection.load(runtimeOf(app,bot))!.some(entry=>entry.type==='context_edit')).toBe(false);
    expect(withoutSystem(streamed(fake).at(-1)!)).toContain('FAILED-DIGEST-ONE');
  },90000);
  it('replaces images of older turns with text markers while the original entry keeps the bytes',async()=>{
    const {app,fake,bot}=await fixture();
    const files=new ChatFiles(app.store),image=files.upload({botId:bot,name:'older.png',data:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(2000,65)]).toString('base64')},app.store.session);
    fake.scripts.push({action:'attachment.read',args:{attachmentId:image.id}},'已看图');
    const first=app.agents.send(bot,`看这张图\n![合成图片](/api/attachments/${image.id})`,'image-one').taskId;files.bind([image.id],bot,'image-one');
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',first)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);
    await turn(app,bot,'第二轮：继续','image-two');
    expect(JSON.stringify(streamed(fake).at(-1))).toContain('data:image/png;base64,');
    expect(app.runtime.projection.load(runtimeOf(app,bot))!.some(entry=>entry.type==='context_edit')).toBe(false);
    await turn(app,bot,'第三轮：继续','image-three');
    const last=JSON.stringify(streamed(fake).at(-1));
    expect(last).not.toContain('data:image/png;base64,');expect(last).toContain(`[图片 attachment:${image.id}]`);
    expect(fake.requests.every(row=>row.stream)).toBe(true);
    const stored=app.runtime.projection.load(runtimeOf(app,bot))!;
    const edit=stored.find(entry=>entry.type==='context_edit') as {targetId:string}|undefined;
    expect(edit).toBeDefined();
    const target=stored.find(entry=>entry.id===edit!.targetId)!;
    expect(JSON.stringify(target)).toContain('"type":"image"');expect(JSON.stringify(target)).toContain('"data":"iVBORw0KGg');
    expect(String(app.agents.search(bot,'entry:'+edit!.targetId)[0].content)).toContain('[图片原文保留');
  },90000);
  it('keeps the stable system message byte-identical when a peer starts or finishes a task and shows availability in the volatile block',async()=>{
    const {app,bot}=await fixture();
    const peer=app.store.createBot('同伴助手');
    const task=await turn(app,bot,'第一轮：只讨论。','peer-one');
    const before=app.runtime.promptParts(task);
    app.agents.send(peer,'同伴开始工作','peer-busy');
    const during=app.runtime.promptParts(task);
    expect(during.systemPrompt).toBe(before.systemPrompt);
    expect(before.systemPrompt).toContain(peer);expect(before.systemPrompt).not.toContain('availability');expect(before.systemPrompt).not.toContain('directory_version');
    expect(before.volatilePrompt).toContain(`{"id":"${peer}","availability":"ready"}`);
    expect(during.volatilePrompt).toContain(`{"id":"${peer}","availability":"busy"}`);
    await wait(()=>!app.runtime.workers.size&&!app.store.get('SELECT id FROM tasks WHERE bot_id=? AND ended_at IS NULL',peer),app);
    expect(app.runtime.promptParts(task).systemPrompt).toBe(before.systemPrompt);
  },60000);
  const isVolatile=(message:Wire)=>message.role==='user'&&typeof message.content==='string'&&message.content.startsWith('<system-reminder>');
  const answerRequests=(fake:Fixture['fake'])=>fake.requests.filter(row=>row.stream).map(row=>row.messages as Wire[]);
  const systemEntries=(app:Fixture['app'],bot:string,prompt=true)=>app.runtime.projection.load(String(app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?',bot)!.id))!.filter(entry=>entry.type==='message'&&entry.message.role==='system'&&!!systemPromptText(entry)===prompt);
  it('keeps every request a byte-identical prefix of the next one; the volatile block is outside the system message and the projection',async()=>{
    const {app,fake,bot}=await fixture();
    fake.scripts.push({action:'agent.directory',args:{}},'第一轮完成','第二轮完成');
    const first=app.agents.send(bot,'第一轮：只讨论。','prefix-one').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',first)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);
    await new Promise(resolve=>setTimeout(resolve,20));
    const second=app.agents.send(bot,'第二轮：继续。','prefix-two').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',second)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);
    const requests=answerRequests(fake);expect(requests).toHaveLength(3);
    const volatile=requests.map(messages=>messages.filter(isVolatile));
    for(const [index,messages] of requests.entries()){
      // One system message holding only the stable prompt, one volatile block.
      const systems=messages.filter(m=>m.role==='system'||m.role==='developer');
      expect(systems).toHaveLength(1);expect(messages[0]).toBe(systems[0]);
      expect(String(systems[0].content)).toContain('长期记忆（只包含');expect(String(systems[0].content)).not.toContain('<system-reminder>');expect(String(systems[0].content)).not.toContain('当前 Core 时间');
      expect(volatile[index]).toHaveLength(1);expect(String(volatile[index][0].content)).toContain('当前 Core 时间');expect(String(volatile[index][0].content)).toContain('设备实时目录');
    }
    expect(requests[0].at(-2)).toBe(volatile[0][0]);expect(requests[0].at(-1)).toMatchObject({role:'user'});
    // Tool continuation: after the tool result; user turn: right before the new input.
    expect(requests[1].at(-1)).toBe(volatile[1][0]);expect(requests[1].at(-2)).toMatchObject({role:'tool'});
    expect(requests[2].at(-2)).toBe(volatile[2][0]);expect(JSON.stringify(requests[2].at(-1))).toContain('第二轮：继续。');
    // Volatile text changes per request; everything else is a byte-identical prefix of the next request.
    expect(new Set(volatile.map(([m])=>m.content)).size).toBe(3);
    const stable=requests.map(messages=>messages.filter(m=>!isVolatile(m)));
    for(const [index,messages] of stable.slice(1).entries())expect(JSON.stringify(messages.slice(0,stable[index].length))).toBe(JSON.stringify(stable[index]));
    expect(stable[2].length).toBeGreaterThan(stable[1].length);
    // The projection never stores the volatile block and keeps one system entry.
    const stored=app.runtime.projection.load(String(app.store.get('SELECT id FROM runtime_sessions WHERE bot_id=?',bot)!.id))!;
    expect(JSON.stringify(stored)).not.toContain('当前 Core 时间');expect(systemEntries(app,bot)).toHaveLength(1);
  },60000);
  it('appends a new system entry only when the stable prompt changes and drops stale ones on the next load',async()=>{
    const {app,fake,bot}=await fixture();
    const turn=async(text:string)=>{const task=app.agents.send(bot,text,'system-'+text).taskId;await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);await wait(()=>!app.runtime.workers.size,app);};
    await turn('一');await turn('二');
    const unchanged=systemEntries(app,bot);expect(unchanged).toHaveLength(1);
    app.runtime.memory.write(bot,{title:'新账本记忆',content:'让稳定前缀变化'});
    await turn('三');
    const changed=systemEntries(app,bot);expect(changed).toHaveLength(2);
    expect(String((changed[1] as {message:{content:string}}).message.content)).toContain('新账本记忆');
    await turn('四');
    expect(systemEntries(app,bot)).toHaveLength(1);
    // The SDK's own tool declarations do not grow with each run either.
    expect(systemEntries(app,bot,false).length).toBeLessThanOrEqual(2);
    expect(answerRequests(fake).every(messages=>messages.filter(m=>m.role==='system').length===1)).toBe(true);
  },60000);
  it('keeps a scoped working note even when long-term memory is off',async()=>{
    const {app,fake,bot}=await fixture();
    fake.scripts.push({action:'memory.write',args:{scope:'context',title:'工作笔记',content:'当前只讨论，不部署。下一步等用户确认。',expectedVersion:0}},'已记录');
    const task=app.agents.send(bot,'记下当前工作的约束','working-note').taskId;
    await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',task)?.status==='succeeded',app);
    expect(app.store.get('SELECT version FROM assistant_working_notes WHERE bot_id=?',bot)?.version).toBe(1);
    expect(app.runtime.systemPrompt(task)).toContain('下一步等用户确认');
    expect(app.runtime.memory.personal.enabled(bot)).toBe(false);
    expect(app.store.all('SELECT * FROM assistant_memories')).toHaveLength(0);
  },30000);
  it('imports only an explicit range and skips messages written while disabled',async()=>{
    const {app,bot,fake}=await fixture(),memory=app.runtime.memory.personal;
    app.agents.publish(bot,'user','message','旧记录甲','old-a');app.agents.publish(bot,'user','message','旧记录乙','old-b');
    memory.save(bot,{version:0,enabled:true,dailyBudget:100000});memory.importHistory(bot,1,1);await memory.flush();
    expect(JSON.stringify(fake.requests)).toContain('旧记录甲');expect(JSON.stringify(fake.requests)).not.toContain('旧记录乙');
    memory.save(bot,{version:1,enabled:false,dailyBudget:100000});app.agents.publish(bot,'user','message','关闭期间的记录','off');
    memory.save(bot,{version:2,enabled:true,dailyBudget:100000});await memory.flush();
    expect(JSON.stringify(fake.requests)).not.toContain('关闭期间的记录');
    expect(app.agents.search(bot,'关闭期间')).toHaveLength(1);
  });
  it('updates observations with provenance and stops recalling stale understanding after a correction',async()=>{
    const {app,bot,fake}=await fixture(),memory=app.runtime.memory.personal;
    memory.save(bot,{version:0,enabled:true,dailyBudget:100000});app.agents.publish(bot,'user','message','这个项目使用方案甲','old');await memory.flush();
    const observation=memory.rows(bot).find(row=>row.kind==='observation')!;
    fake.setOverride(body=>{
      const messages=body.messages as Array<{content:string}>;
      if(!messages[0].content.includes('合并同一事项'))return undefined;
      const input=JSON.parse(messages.at(-1)!.content);
      return {choices:[{message:{content:JSON.stringify({items:[{id:observation.id,title:'当前项目方案',content:'用户已将方案甲改为方案乙',sources:input.facts.flatMap((row:{refs_json:string})=>JSON.parse(row.refs_json).map((ref:{id:string})=>ref.id))}]})},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:100}};
    });
    app.agents.publish(bot,'user','message','更正：这个项目改为方案乙','new');app.store.run('UPDATE assistant_memory_settings SET next_attempt=0 WHERE bot_id=?',bot);await memory.flush();
    expect(app.store.get('SELECT version FROM assistant_memories WHERE id=?',observation.id)?.version).toBe(2);
    expect(memory.rows(bot).filter(row=>row.kind==='understanding')).toHaveLength(0);
    expect(JSON.stringify(memory.recall(bot,'项目方案'))).toContain('改为方案乙');
  });
});
