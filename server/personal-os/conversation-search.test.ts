import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createPersonalApp } from './index.ts';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function fixture(){
 const root=mkdtempSync(path.join(os.tmpdir(),'nex-search-'));
 const app=await createPersonalApp({dir:root,key:randomBytes(32),token:'synthetic-search',identity:false,memoryRuntime:false,hostDevice:false});
 cleanups.push(async()=>{await app.close();if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('nex-search-'))throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});
 const a=app.store.createBot('工作助手'),b=app.store.createBot('研究助手');return {app,a,b};
}
it('searches older messages across assistants with literal matching, snippets and stable pagination',async()=>{
 const {app,a,b}=await fixture();
 for(let i=0;i<180;i++)app.agents.publish(a,'user','message',i===2?'旧记录中的三国演义':'普通消息 '+i,'old:'+i);
 app.agents.publish(b,'assistant','message','x'.repeat(500)+'三国演义研究笔记','other');
 const matches=app.agents.searchConversations('三国演义');expect(matches.results).toHaveLength(2);expect(matches.results.map(r=>r.botId)).toEqual([b,a]);expect(matches.results[0].snippet).toContain('三国演义');expect(matches.results[0].snippet.length).toBeLessThan(185);
 expect(app.agents.messages(a).some(m=>String(m.content).includes('三国演义'))).toBe(false);
 const around=app.agents.messagesAround(a,String(matches.results[1].id));expect(around.some(m=>m.id===matches.results[1].id)).toBe(true);expect(around.length).toBeLessThanOrEqual(100);
 expect(()=>app.agents.messagesAround(b,String(matches.results[1].id))).toThrow();
 app.agents.publish(a,'user','message','字面量 50%_value','literal');expect(app.agents.searchConversations('%_').results).toHaveLength(1);
 for(let i=0;i<65;i++)app.agents.publish(a,'user','message','分页记录 '+i,'page:'+i);
 const first=app.agents.searchConversations('分页记录'),second=app.agents.searchConversations('分页记录',first.nextBefore!);
 expect(first.results).toHaveLength(50);expect(second.results).toHaveLength(15);expect(second.nextBefore).toBe(null);expect(new Set([...first.results,...second.results].map(r=>r.id)).size).toBe(65);
});
it('protects archived/forgotten records and validates authenticated search requests',async()=>{
 const {app,a,b}=await fixture();
 app.agents.publish(a,'user','message','[已遗忘]','forgotten');app.agents.publish(b,'user','message','归档秘密','archived');app.store.run("UPDATE bots SET status='archived' WHERE id=?",b);
 expect(app.agents.searchConversations('[已遗忘]').results).toHaveLength(0);expect(app.agents.searchConversations('归档秘密').results).toHaveLength(0);
 const get=(route:string,auth=true)=>fetch(app.origin+'/api/'+route,{headers:auth?{Authorization:'Bearer synthetic-search'}:{}});
 expect((await get('agents/search?q=test',false)).status).toBe(401);
 expect((await get('agents/search?q=')).ok).toBe(false);expect((await get('agents/search?q=test&before=-1')).ok).toBe(false);
 const found=await get('agents/search?q=test');expect(found.status).toBe(200);expect(await found.json()).toMatchObject({results:[],nextBefore:null,sync:{coreId:expect.any(String)}});
 const id=app.store.get('SELECT id FROM agent_messages WHERE bot_id=?',a)!.id;
 expect((await get('agents/messages?bot='+a+'&around='+id)).ok).toBe(false);
});
