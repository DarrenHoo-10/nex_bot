import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ChatFiles } from "./chat-files.ts";
import { expect,it,vi } from "vitest";
import { createPersonalApp } from "./index.ts";

it("previews, fences and clears only the confirmed assistant across reset, replay and delete", async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),"nex-lifecycle-"));
 const objects=new Map<string,string>();
 let allowRemoteDelete=false;
 const options={dir,key:randomBytes(32),token:"fixture-only",identity:false as const,hostDevice:false as const,memoryRuntime:false as const,
   attachmentObjects:{async put(key:string,value:string){objects.set(key,value);},async get(key:string){return objects.get(key)!;},async delete(key:string){if(!allowRemoteDelete)throw Error("fixture unavailable");objects.delete(key);}}};
 let app=await createPersonalApp(options);
 const api=async(route:string,body?:unknown)=>{
   const result=await fetch(app.origin+"/api/"+route,{method:body?"POST":"GET",headers:{Authorization:"Bearer fixture-only","Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});
   return {status:result.status,value:await result.json() as {replacementId:string;blocked:boolean;previewId:string;status:string;counts:{messages:number};results:unknown[]}};
 };
 try {
   const a=app.store.createBot("A","A instructions"),b=app.store.createBot("B");
   app.agents.publish(a,"user","message","private-A","fixture:a");
   app.agents.publish(b,"user","message","private-B","fixture:b");
   const old=app.store.get("SELECT id FROM agent_messages WHERE bot_id=?",a)!.id;
   const preview=async(action:string,botId:string=a)=>(await api("bots/lifecycle/preview",{botId,action})).value;
   const execute=(previewId:string,requestId:string)=>api("bots/lifecycle/execute",{previewId,requestId});
   app.store.saveConfig({provider:"openai",endpoint:"http://127.0.0.1:1/v1",model:"fixture",apiKey:"synthetic"});
   const conversation=app.store.createConversation(a,"private-A");
   const task=app.store.accept(conversation,"private-A","old-input");
   expect((await preview("reset_memory")).blocked).toBe(true);
   app.runtime.cancel(task,"fixture");
   const memory=app.runtime.memory;
   const privateDoc=memory.write(a,{title:"private-A",content:"private-A"});
   const shared=memory.write(a,{title:"shared",content:"shared-text",scope:"workspace"});
   const files=new ChatFiles(app.store);
   const file=files.upload({botId:a,name:"private.txt",data:Buffer.from("private-A").toString("base64")},app.store.session);
   app.store.run("UPDATE chat_attachments SET message_id=? WHERE id=?",old,file.id);
   await files.persist(file.id);
   expect(objects.size).toBe(1);
   app.store.run("INSERT INTO assistant_memories(id,bot_id,kind,title,content,refs_json,created_at,updated_at) VALUES('shared-topic',?,'topic','Shared','Shared body',?,1,1)",a,JSON.stringify([{id:old}]));
   app.store.run("INSERT INTO assistant_topics(topic_id,bot_id,summary,owner) VALUES('shared-topic',?,'Shared summary','user')",a);
   app.store.insert("agent_jobs",{id:"fixture-job",bot_id:a,conversation_id:conversation,title:"old job",brief_json:"{}",source_key:"fixture-job",created_at:1,stopped_at:1});
   app.store.insert("agent_job_reports",{id:"fixture-report",job_id:"fixture-job",task_id:task,state:"ready",summary:"old report",message_id:old,created_at:1});
   app.store.insert("stock_history_aliases",{scope_id:"fixture-scope",session_id:"fixture-session",bot_id:a,conversation_id:conversation});
   app.store.insert("stock_history_messages",{scope_id:"fixture-scope",session_id:"fixture-session",external_id:"old",message_id:old,source_hash:"fixture",source_cursor:1});
   const stale=await preview("reset_memory");
   app.agents.publish(a,"user","message","late","fixture:late");
   expect((await execute(stale.previewId,"stale")).status).toBe(409);
   app.store.run("INSERT INTO bot_appearance VALUES(?,?,3)",a,'{"kind":"fixture"}');
   app.store.run("INSERT OR REPLACE INTO assistant_memory_settings(bot_id,enabled,model,daily_budget,cursor_seq,updated_at) VALUES(?,1,'fixture-model',80000,800,1)",a);
   app.routines.save({botId:a,name:"daily check",prompt:"fixture",scheduleKind:"interval",intervalMinutes:60,enabled:false});
   // Keep a committed deletion pending across an actual Core shutdown.
   app.store.db.exec("CREATE TRIGGER fixture_stop_cleanup BEFORE DELETE ON agent_messages WHEN OLD.source_key='bulk900' BEGIN SELECT RAISE(ABORT,'fixture interruption'); END;");
   const insert=app.store.db.prepare("INSERT INTO agent_messages(id,bot_id,workspace_id,owner_user_id,seq,role,kind,content,source_key,created_at) VALUES(?,?,?, ?,?,'user','message','bulk',?,1)");
   app.store.transaction(()=>{
     for(let seq=100;seq<6100;seq++)insert.run("bulk"+seq,a,app.store.workspace,app.store.owner,seq,"bulk"+seq);
     app.store.run("UPDATE agent_inboxes SET next_seq=6100 WHERE bot_id=?",a);
   });
   const reset=await preview("reset_memory");
   expect(reset.counts.messages).toBeGreaterThanOrEqual(2);
   const done=await execute(reset.previewId,"reset");
   expect(done.status).toBe(202);
   expect(done.value).toMatchObject({status:"cleaning"});
   const fresh=done.value.replacementId;
   expect(fresh).toBeTruthy();
   expect(fresh).not.toBe(a);
   expect(app.agents.contacts().find(bot=>bot.id===fresh)).toMatchObject({name:"A",instructions:"A instructions",last_message:null,replaces_id:a,appearance_version:3});
   expect(app.store.get("SELECT enabled,model,daily_budget,cursor_seq FROM assistant_memory_settings WHERE bot_id=?",fresh)).toMatchObject({enabled:1,model:"fixture-model",daily_budget:80000,cursor_seq:0});
   expect(app.routines.list().filter(row=>row.name==="daily check").map(row=>row.bot_id)).toEqual([fresh]);
   expect((await execute(reset.previewId,"reset")).value).toMatchObject({operationId:"reset",replacementId:fresh});
   expect((await api("messages?conversation="+conversation)).status).toBe(404);
   expect((await api("agents/messages?bot="+a)).status).toBe(404);
   expect((await api("agents/search?q=private-A")).value.results).toHaveLength(0);
   expect(app.store.state().conversations.map(c=>c.id)).not.toContain(conversation);
   app.agents.publish(fresh,"user","message","fresh message","fixture:fresh");
   await vi.waitFor(()=>expect(app.store.get("SELECT retry_at FROM bot_lifecycle_operations WHERE id='reset'")?.retry_at).toBeGreaterThan(0));
   expect(app.store.get("SELECT count(*) n FROM agent_messages WHERE bot_id=?",a)?.n).toBeGreaterThan(0);
   expect(app.store.get("SELECT count(*) n FROM agent_messages WHERE bot_id=?",a)?.n).toBeLessThan(6000);
   await app.close();
   // Remove the artificial fault and advance its retry deadline while Core is offline.
   const {DatabaseSync}=await import("node:sqlite");
   const db=new DatabaseSync(path.join(dir,"core.db"));
   try {db.exec("DROP TRIGGER fixture_stop_cleanup; UPDATE bot_lifecycle_operations SET retry_at=0 WHERE id='reset'");}finally{db.close();}
   app=await createPersonalApp(options);
   await vi.waitFor(()=>expect(app.store.get("SELECT phase FROM bot_lifecycle_operations WHERE id='reset'")?.phase).toBe("done"),{timeout:10000});
   await vi.waitFor(async()=>expect((await api("bots/lifecycle/operations/reset")).value.status).toBe("needs_retry"));
   allowRemoteDelete=true;
   await vi.waitFor(async()=>expect((await api("bots/lifecycle/operations/reset")).value.status).toBe("completed"),{timeout:20000,interval:200});
   expect(objects.size).toBe(0);
   expect(app.store.get("SELECT id FROM agent_jobs WHERE bot_id=?",a)).toBeUndefined();
   expect(app.store.get("SELECT message_id,deleted_at FROM stock_history_messages WHERE external_id='old'")).toMatchObject({message_id:null,deleted_at:expect.any(Number)});
   expect(app.store.get("SELECT content FROM memory_content WHERE document_id=?",privateDoc.documentId)?.content).toBe("");
   expect(app.store.get("SELECT content FROM memory_content WHERE document_id=?",shared.documentId)?.content).toBe("shared-text");
   expect(app.store.get("SELECT 1 FROM chat_attachments WHERE id=?",file.id)).toBeUndefined();
   expect(app.store.get("SELECT status FROM conversations WHERE id=?",conversation)?.status).toBe("deleted");
   expect(app.store.get("SELECT content FROM agent_messages WHERE bot_id=?",fresh)?.content).toBe("fresh message");
   expect(app.store.get("SELECT content,refs_json FROM assistant_memories WHERE id='shared-topic'")).toMatchObject({content:"Shared body",refs_json:"[]"});
   expect((await api("messages?conversation="+conversation)).status).toBe(404);
   expect((await api("agents/messages?bot="+a+"&around="+old)).status).toBe(404);
   expect((await api("agents/search?q=private-A")).value.results).toHaveLength(0);
   expect((await api("agents/search?q=private-B")).value.results).toHaveLength(1);
   expect((await api("agents/input",{botId:a,text:"offline",clientId:"old"})).status).toBe(404);
   expect((await execute((await preview("delete",fresh)).previewId,"delete")).value).toMatchObject({status:"cleaning",replacementId:null});
   expect(app.agents.contacts().map(bot=>bot.id)).not.toContain(fresh);
   await vi.waitFor(async()=>expect((await api("bots/lifecycle/operations/delete")).value.status).toBe("completed"));
 } finally {await app.close(); rmSync(dir,{recursive:true,force:true});}
},45000);
