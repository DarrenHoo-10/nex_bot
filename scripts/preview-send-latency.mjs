// Visible synthetic conversation for native input latency measurements.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startFakeIdentity } from '../server/personal-os/testing/fake-identity.ts';
import { startFakePersonalMemory } from '../server/personal-os/testing/fake-personal-memory.ts';

const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)??'baseline';
if(!/^[a-z-]+$/.test(label))throw new Error('Invalid label');
const root=mkdtempSync(path.join(os.tmpdir(),'nex-send-latency-'));
const output=path.resolve('release/send-latency');mkdirSync(output,{recursive:true});
const {createPersonalApp}=await import(pathToFileURL(path.resolve('dist-personal/server/core/index.js')).href);
let core,identity,model,child;
try {
  identity=await startFakeIdentity();model=await startFakePersonalMemory();
  core=await createPersonalApp({dir:path.join(root,'core'),key:randomBytes(32),token:'synthetic-bootstrap',hostDevice:false,memoryRuntime:false,uiDir:path.resolve('dist-personal/server/ui'),modelCatalog:{fetchDisabled:true,readSnapshot:()=>undefined,log:()=>{}},identity:{fixtureOrigin:identity.origin}});
  const operator=core.store.get('SELECT * FROM user_sessions WHERE id=?',core.store.session);
  const transaction=core.identity.start({account:'owner@example.test',name:'发送性能测试'},operator);
  const session=await core.identity.respond({...transaction,password:' synthetic password '},operator);
  core.store.saveConfig({provider:'openai',endpoint:model.origin+'/v1',model:'fixture-chat',apiKey:'synthetic-only',contextWindow:500000,maxOutputTokens:4096});
  const bot=core.store.createBot('发送性能测试');
  const section='### 核对结果\n\n这是一段用于性能测试的合成记录，包含列表、代码和表格。\n\n- 保留当前要求\n- 核对设备与运行状态\n- 确认全部资料已读取\n\n| 设备 | 状态 | 数值 |\n| --- | --- | --- |\n| 合成设备 A | 在线 | 12345 |\n| 合成设备 B | 离线 | 67890 |\n\n```text\nsynthetic command output\nall checks complete\n```\n\n';
  for(let i=0;i<60;i++){
    core.agents.publish(bot,'user','message',`第 ${i+1} 轮：请核对这批合成资料。`,'fixture-user-'+i,null,null,Date.now()-120000+i*1000);
    core.agents.publish(bot,'assistant','message',`第 ${i+1} 轮资料\n\n`+section.repeat(4),'fixture-answer-'+i,null,null,Date.now()-119500+i*1000);
  }
  const profile=path.join(root,'renderer');mkdirSync(profile);
  const instrumentation=`(()=>{window.__sendMetrics={events:[],longTasks:[],requests:[]};const m=window.__sendMetrics;new PerformanceObserver(list=>{for(const e of list.getEntries())m.longTasks.push({start:e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:true});for(const type of ['input','submit'])document.addEventListener(type,e=>{if(!e.target.closest('.composer'))return;const start=performance.now();const item={type,start};m.events.push(item);requestAnimationFrame(()=>{item.frame=performance.now()-start;requestAnimationFrame(()=>{item.paint=performance.now()-start;});});},true);const fetchOriginal=window.fetch;window.fetch=async(...args)=>{const url=String(args[0]);const start=performance.now();try{return await fetchOriginal(...args);}finally{m.requests.push({route:url.split('?')[0],start,duration:performance.now()-start});}};})();`;
  const entry=path.join(root,'renderer.cjs');
  writeFileSync(entry,`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1440,height:960,title:'NexBot 发送性能测试 ${label}',autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});w.on('page-title-updated',e=>e.preventDefault());await w.webContents.session.cookies.set({url:${JSON.stringify(core.origin)},name:'nex',value:${JSON.stringify(session.token)},httpOnly:true,sameSite:'strict',path:'/'});await w.loadURL(${JSON.stringify(core.origin)});await w.webContents.executeJavaScript(${JSON.stringify(instrumentation)});setInterval(async()=>{try{const m=await w.webContents.executeJavaScript('JSON.stringify({...window.__sendMetrics,rows:document.querySelectorAll(".message").length})');fs.writeFileSync(${JSON.stringify(path.join(output,label+'.json'))},m);}catch{}},1000);w.show();});app.on('window-all-closed',()=>app.quit());`);
  child=spawn(path.resolve('dist-personal/electron/electron.exe'),[entry],{windowsHide:false,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA,USERPROFILE:process.env.USERPROFILE,TEMP:os.tmpdir(),TMP:os.tmpdir()},stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',()=>{});
  console.log('Synthetic native input fixture ready: '+label);
  await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
} finally {
  await core?.close();await model?.close();await identity?.close();
  if(path.dirname(root)===os.tmpdir()&&path.basename(root).startsWith('nex-send-latency-'))rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
