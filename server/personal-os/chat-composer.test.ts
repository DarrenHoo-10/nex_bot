import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { createPersonalApp } from "./index.ts";
import { ChatFiles } from "./chat-files.ts";
import { evaluateTool } from "./policy.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(check: () => boolean) { const end = Date.now()+25000; while (!check()) { if (Date.now()>end) throw new Error("Fixture timeout"); await new Promise((resolve) => setTimeout(resolve,25)); } }
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-composer-")), key = randomBytes(32), token = "synthetic-owner";
  cleanups.push(async () => { if (path.dirname(root).toLowerCase() !== os.tmpdir().toLowerCase() || !path.basename(root).startsWith("nex-composer-")) throw new Error("Unsafe cleanup"); rmSync(root,{recursive:true,force:true}); });
  const model = await startFakeModel(); cleanups.push(() => model.close());
  const app = await createPersonalApp({ dir: root,key,token,identity:false,memoryRuntime:false,hostDevice:false }); let current = app; cleanups.push(() => current.close());
  const restart = async () => { await current.close(); current = await createPersonalApp({dir:root,key,token,identity:false,memoryRuntime:false,hostDevice:false}); return current; };
  app.store.saveConfig({ provider:"openai",endpoint:model.origin+"/v1",model:"fixture",apiKey:"synthetic" });
  const bot = app.store.createBot("Fixture"), peer = app.store.createBot("Peer");
  const api = async (route:string,data?:unknown,auth=token) => {
    const response = await fetch(app.origin+"/api/"+route,{headers:{Authorization:`Bearer ${auth}`,"Content-Type":"application/json"},...(data === undefined ? {} : {method:"POST",body:JSON.stringify(data)})});
    return { status:response.status, body:await response.json() as Record<string,string> };
  };
  return {app,model,bot,peer,api,root,key,token,restart};
}
it("uploads, sends, reads through a real worker and downloads a scoped attachment", async () => {
  const f = await fixture();
  const file = (await f.api("attachments",{botId:f.bot,name:"报告.md",data:Buffer.from("SYNTHETIC_REPORT_CONTENT").toString("base64")})).body;
  expect(f.app.store.get("SELECT ciphertext FROM chat_attachments")?.ciphertext).not.toContain("SYNTHETIC_REPORT_CONTENT");
  const files = new ChatFiles(f.app.store);
  await expect(files.read(f.bot,file.id)).rejects.toThrow("不可访问");
  f.model.scripts.push({kind:"openai-tool",calls:[{id:"read-upload",name:"broker",args:JSON.stringify({action:"attachment.read",attachmentId:file.id})}]},{kind:"openai-text",text:"已读附件"});
  const sent = await f.api("agents/input",{botId:f.bot,text:"",clientId:"upload-input",attachments:[file.id]}); expect(sent.status).toBe(202);
  await until(() => f.app.store.get("SELECT status FROM tasks WHERE id=?",sent.body.taskId)?.status === "succeeded");
  expect(f.app.store.get("SELECT result_json FROM tool_calls WHERE provider_tool_call_id='read-upload'")?.result_json).toContain("SYNTHETIC_REPORT_CONTENT");
  expect(f.app.store.all("SELECT id FROM approvals")).toHaveLength(0);
  expect((await f.api("agents/input",{botId:f.bot,text:"",clientId:"upload-input",attachments:[file.id]})).body.taskId).toBe(sent.body.taskId);
  expect(f.app.store.all("SELECT id FROM agent_messages WHERE role='user'")).toHaveLength(1);
  await expect(files.read(f.peer,file.id)).rejects.toThrow("不可访问");
  expect((await f.api("agents/input",{botId:f.peer,text:"wrong bot",clientId:"wrong",attachments:[file.id]})).status).toBe(400);
  const response = await fetch(f.app.origin+"/api/attachments/"+file.id,{headers:{Authorization:`Bearer ${f.token}`}});
  expect(await response.text()).toBe("SYNTHETIC_REPORT_CONTENT"); expect(response.headers.get("content-disposition")).toContain("attachment");
  expect((await fetch(f.app.origin+"/api/attachments/"+file.id)).status).toBe(401);
  // Privacy-redacted messages no longer authorize attachment reads/downloads.
  f.app.store.run("UPDATE agent_messages SET content='[redacted]' WHERE role='user'");
  await expect(files.read(f.bot,file.id)).rejects.toThrow("不可访问");
},60000);

it("bounds uploads, rejects missing/stolen references and exposes images as model image content",async () => {
  const f=await fixture();
  for (const data of ["bad!",Buffer.alloc(5*1024*1024+1).toString("base64")]) expect((await f.api("attachments",{botId:f.bot,name:"big.txt",data})).status).toBe(400);
  expect((await f.api("attachments",{botId:f.bot,name:"x",data:"eA=="},"invalid")).status).toBe(401);
  expect((await f.api("agents/input",{botId:f.bot,text:"x",clientId:"missing",attachments:["absent"]})).status).toBe(400);
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEtcAAAAASUVORK5CYII=";
  const file=(await f.api("attachments",{botId:f.bot,name:"image.png",data:image})).body;
  f.model.scripts.push({kind:"openai-text",text:"image"});
  const sent=(await f.api("agents/input",{botId:f.bot,text:"see",clientId:"image",attachments:[file.id]})).body;
  await until(()=>f.app.store.get("SELECT status FROM tasks WHERE id=?",sent.taskId)?.status === "succeeded");
  expect(await new ChatFiles(f.app.store).read(f.bot,file.id)).toMatchObject({images:[{mimeType:"image/png",data:image}]});
});
it("deletes one sent image while preserving text and removes an image-only message", async () => {
  const f=await fixture(), files=new ChatFiles(f.app.store);
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEtcAAAAASUVORK5CYII=";
  const attach = (source: string, role: "user" | "assistant", content: (url: string) => string) => {
    const file = files.upload({ botId: f.bot, name: "image.png", data: image }, f.app.store.session);
    f.app.agents.publish(f.bot, role, "message", content(`/api/attachments/${file.id}`), source);
    const message = f.app.store.get("SELECT id FROM agent_messages WHERE source_key=?", source)!;
    f.app.store.run("UPDATE chat_attachments SET message_id=? WHERE id=?", message.id, file.id);
    return { file, message };
  };
  const kept = attach("fixture-delete-text", "user", (url) => `保留这段文字\n\n[image.png](${url})`);
  const removed = await f.api("agents/messages/image/delete", { botId: f.bot, messageId: kept.message.id, attachmentId: kept.file.id });
  expect(removed.status).toBe(200);
  expect(f.app.store.get("SELECT content FROM agent_messages WHERE id=?", kept.message.id)?.content).toBe("保留这段文字");
  expect(f.app.store.get("SELECT id FROM chat_attachments WHERE id=?", kept.file.id)).toBeUndefined();
  expect((await f.api("agents/messages/image/delete", { botId: f.bot, messageId: kept.message.id, attachmentId: kept.file.id })).status).toBe(400);
  const only = attach("fixture-delete-only", "assistant", (url) => `![生成图片](${url})`);
  expect((await f.api("agents/messages/image/delete", { botId: f.bot, messageId: only.message.id, attachmentId: only.file.id })).status).toBe(200);
  expect(f.app.store.get("SELECT id FROM agent_messages WHERE id=?", only.message.id)).toBeUndefined();
});

it("switches full mode from the user API, releases pending approval and restores standard mode", async () => {
  const f=await fixture(), args={action:"agent.create",name:"Created by fixture"};
  f.model.scripts.push({kind:"openai-tool",calls:[{id:"create-peer",name:"broker",args:JSON.stringify(args)}]},{kind:"openai-text",text:"done"});
  const task=f.app.agents.send(f.bot,"create peer","mode-input").taskId;
  await until(()=>!!f.app.store.get("SELECT id FROM approvals WHERE status='pending'"));
  expect((await f.api("bots/approval-mode",{id:f.bot,mode:"full",version:0},"invalid")).status).toBe(401);
  expect((await f.api("bots/approval-mode",{id:f.bot,mode:"full",version:0})).status).toBe(200);
  await until(()=>f.app.store.get("SELECT status FROM tasks WHERE id=?",task)?.status === "succeeded");
  expect(f.app.store.get("SELECT id FROM bots WHERE name='Created by fixture'")).toBeTruthy();
  expect(evaluateTool(f.app.store,f.bot,args).approvalRequired).toBe(false);
  await until(()=>!f.app.runtime.workers.size);
  f.model.scripts.push({kind:"openai-tool",calls:[{id:"full-create",name:"broker",args:JSON.stringify({...args,name:"Full mode peer",risk:"dangerous"})}]},{kind:"openai-text",text:"done"});
  const fullTask=f.app.agents.send(f.bot,"create directly","full-input").taskId;
  await until(()=>f.app.store.get("SELECT status FROM tasks WHERE id=?",fullTask)?.status === "succeeded");
  expect(f.app.store.all("SELECT id FROM approvals")).toHaveLength(1);
  expect(f.app.store.get("SELECT id FROM bots WHERE name='Full mode peer'")).toBeTruthy();
  expect(evaluateTool(f.app.store,f.peer,{...args,risk:"standard",approvalMode:"full"}).approvalRequired).toBe(true);
  expect((await f.api("bots/approval-mode",{id:f.bot,mode:"standard",version:0})).status).toBe(400);
  expect(f.app.runtime.systemPrompt(task)).toContain("完全权限");
  expect((await f.api("bots/approval-mode",{id:f.bot,mode:"standard",version:1})).status).toBe(200);
  expect(evaluateTool(f.app.store,f.bot,args).approvalRequired).toBe(true);
  expect((await f.api("bots/approval-mode",{id:f.bot,mode:"full",version:2})).status).toBe(200);
  const policy=f.app.store.get("SELECT * FROM bot_policies WHERE bot_id=?",f.bot)!;
  f.app.agents.updatePolicy({id:f.bot,version:policy.version,tools:["agent.directory"]});
  expect(()=>evaluateTool(f.app.store,f.bot,args)).toThrow("无权");
  await until(()=>!f.app.runtime.workers.size);
  const reopened=await f.restart();
  expect(reopened.store.get("SELECT mode FROM agent_approval_settings WHERE bot_id=?",f.bot)?.mode).toBe("full");
  expect(()=>evaluateTool(reopened.store,f.bot,args)).toThrow("无权");
},60000);

it("pings live device connections and removes a half-open connection without waiting for a new command",async () => {
  const f=await fixture(), pair=f.app.gateway.pair("Heartbeat fixture");
  const socket=new WebSocket(f.app.origin.replace("http:","ws:")+"/dcp/v1/connect",{headers:{Authorization:`Bearer ${pair.token}`},autoPong:false});
  cleanups.push(async()=>{socket.terminate();});
  await new Promise<void>(resolve=>socket.once("open",resolve));
  await until(()=>f.app.gateway.sockets.has(pair.deviceId));
  const ping=new Promise<void>(resolve=>socket.once("ping",()=>resolve()));
  f.app.gateway.heartbeat();await ping;
  f.app.gateway.heartbeat();
  await until(()=>!f.app.gateway.sockets.has(pair.deviceId));
  expect(f.app.gateway.inventory().find(d=>d.id===pair.deviceId)?.online).toBe(false);
});
