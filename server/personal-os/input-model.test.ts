import {it,expect} from 'vitest';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {createPersonalApp} from './index.ts';import {StockHistory,type HistoryTransport} from './stock-history.ts';import {startFakeModel} from '../runtime/pi/p0/fake-model.ts';
const wait=async(check:()=>boolean)=>{const end=Date.now()+25000;while(!check()){if(Date.now()>end)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,30));}};
it('persists a single-input model and reasoning through FIFO/restart, preserves automatic next turns, and never changes the assistant default',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'nex-input-model-')),key=randomBytes(32),base=await startFakeModel(),other=await startFakeModel();
 const options={dir,key,token:'fixture',identity:false as const,hostDevice:false as const,memoryRuntime:false as const,modelCatalog:{fetchDisabled:true}};
 let app=await createPersonalApp(options);let history!:StockHistory;
 const transport:HistoryTransport={historyScope:async()=>({instanceId:'fixture-stock',issuer:'https://issuer.example.test',subject:'owner'}),historyPage:async()=>({messages:[],nextCursor:0,hasMore:false,cursorVersion:2,capabilities:{deletions:true}})};
 const install=()=>{history=new StockHistory(app.store,app.agents,app.runtime,transport);app.runtime.prepareConversation=conv=>history.prepare(conv);};install();
 try{
  app.store.saveConfig({provider:'openai',endpoint:base.origin+'/v1',model:'default-model',apiKey:'synthetic-default-key'});
  const connectionId=app.store.saveConnection({name:'Other',provider:'openai',endpoint:other.origin+'/v1',defaultModel:'override-model',apiKey:'synthetic-override-key',enabled:true});
  app.store.saveModelOptions({connectionId,model:'override-model',reasoning:['low','high'],version:0});
  const kick=app.runtime.kick;app.runtime.kick=()=>{};
  const first=await history.send(app.store.session,{sessionId:'legacy',text:'first auto','clientId':'first'});
  const input={sessionId:'legacy',text:'single override',clientId:'override',modelSelection:{connectionId,model:'override-model',reasoning:'high'}};
  const second=await history.send(app.store.session,input);expect(second.taskId).toBeNull();expect(await history.send(app.store.session,input)).toEqual(second);
  await expect(history.send(app.store.session,{...input,modelSelection:{...input.modelSelection,reasoning:'low'}})).rejects.toThrow('同一消息 ID');
  expect(app.store.modelConfig(first.botId).model).toBe('default-model');
  const selection=String(app.store.get('SELECT model_selection_json FROM agent_topic_inputs WHERE client_id=?','override')?.model_selection_json);expect(selection).toContain('override-model');expect(selection).not.toContain('synthetic-override-key');
  app.store.saveConfig({provider:'openai',endpoint:base.origin+'/v1',model:'changed-default',apiKey:'synthetic-default-key'});
  base.scripts.push({kind:'openai-text',text:'first complete'},{kind:'openai-text',text:'third auto complete'});other.scripts.push({kind:'openai-text',text:'override complete'});
  await history.close();await app.close();app=await createPersonalApp(options);install();
  await wait(()=>app.store.all("SELECT id FROM tasks WHERE status='succeeded'").length===2);
  const body=JSON.parse(other.requests.find(r=>r.url.includes('completions'))!.body);expect(body.model).toBe('override-model');expect(body.reasoning_effort).toBe('high');expect(app.store.modelConfig(first.botId).model).toBe('changed-default');
  const third=await history.send(app.store.session,{sessionId:'legacy',text:'next auto',clientId:'third'});await wait(()=>app.store.get('SELECT status FROM tasks WHERE id=?',third.taskId)?.status==='succeeded');expect(base.requests.filter(r=>r.url.includes('completions'))).toHaveLength(2);expect(other.requests.filter(r=>r.url.includes('completions'))).toHaveLength(1);
  await expect(history.send(app.store.session,{sessionId:'bad-reasoning',text:'bad',clientId:'bad',modelSelection:{connectionId,model:'override-model',reasoning:'max'}})).rejects.toThrow('不支持');
  expect(app.store.get('SELECT session_id FROM stock_history_aliases WHERE session_id=?','bad-reasoning')).toBeUndefined();
  app.runtime.kick=()=>{};
  const active=await history.send(app.store.session,{sessionId:'cancel-model',text:'wait',clientId:'wait'}),queued=await history.send(app.store.session,{sessionId:'cancel-model',text:'do not run',clientId:'cancel-override',modelSelection:input.modelSelection});
  app.agents.cancelMessage(active.botId,active.conversationId,queued.messageId);expect(app.store.get('SELECT status FROM agent_topic_inputs WHERE client_id=?','cancel-override')?.status).toBe('cancelled');expect(app.store.get('SELECT task_id FROM agent_topic_inputs WHERE client_id=?','cancel-override')?.task_id).toBeNull();
  app.agents.cancelTopic(active.botId,active.conversationId);app.runtime.kick=kick;
 }finally{await history!.close();await app.close();await base.close();await other.close();rmSync(dir,{recursive:true,force:true});}
},40000);
it('fails a revoked pinned provider instead of silently running the default model',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'nex-input-revoked-')),fake=await startFakeModel(),app=await createPersonalApp({dir,key:randomBytes(32),token:'fixture',identity:false,hostDevice:false,memoryRuntime:false,modelCatalog:{fetchDisabled:true}});
 try{app.store.saveConfig({provider:'openai',endpoint:fake.origin+'/v1',model:'default-model',apiKey:'synthetic'});const connectionId=app.store.saveConnection({name:'Pinned',provider:'openai',endpoint:fake.origin+'/other',defaultModel:'pinned-model',apiKey:'synthetic',enabled:true});const {botId}=app.agents.finance();const kick=app.runtime.kick;app.runtime.kick=()=>{};const first=app.agents.send(botId,'first','first',undefined,{newConversation:true}),second=app.agents.send(botId,'pinned','pinned',undefined,{conversationId:first.conversationId,modelSelection:{connectionId,model:'pinned-model'}});app.store.run('UPDATE model_connections SET enabled=0 WHERE id=?',connectionId);app.runtime.kick=kick;app.runtime.finishTask(first.taskId!,'succeeded','first done');await wait(()=>!!app.store.get("SELECT t.id FROM tasks t JOIN agent_topic_inputs i ON i.task_id=t.id WHERE i.client_id='pinned' AND t.status='failed'"));expect(fake.requests.filter(r=>r.url.includes('completions'))).toHaveLength(0);expect(second.taskId).toBeNull();}finally{await app.close();await fake.close();rmSync(dir,{recursive:true,force:true});}
},30000);
