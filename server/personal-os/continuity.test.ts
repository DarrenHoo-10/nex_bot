import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
import { startFakePersonalMemory } from './testing/fake-personal-memory.ts';
import { hash } from './store.ts';
import { assistantCompletion } from './assistant-model.ts';

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
    app.store.db.exec('DROP TABLE workspace_memory_settings; DROP TABLE attachment_objects; DROP TABLE image_model_selections; DROP TABLE image_models; DELETE FROM schema_migrations WHERE version>=16;');
    const {CoreStore}=await import('./store.ts');
    const reopened=new CoreStore(app.store.dir,app.store.key,'synthetic-token');
    try {
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
