// Isolated Core + real hidden Electron renderer; no user profile or live provider.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { get, createServer } from "node:http";
import { startFakeIdentity } from "../server/personal-os/testing/fake-identity.ts";
import { startFakeModel } from "../server/runtime/pi/p0/fake-model.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-image-fixture-"));
const output = path.resolve("release/image-models-verification"); mkdirSync(output, { recursive: true });
const { createPersonalApp } = await import(pathToFileURL(path.resolve("dist-personal/server/core/index.js")).href);
const identity = await startFakeIdentity({ displayName: "演示账号" }), model = await startFakeModel();
// A deterministic 640x400 raster proves actual layout, not just 1px decoding.
const width=640,height=400,pixels=Buffer.alloc((width*3+1)*height);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const offset=y*(width*3+1)+1+x*3;pixels[offset]=30+Math.floor(x/width*100);pixels[offset+1]=100+Math.floor(y/height*100);pixels[offset+2]=210;}
const chunk=(type,data)=>{const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);};
const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]).toString("base64");
let imageRequests = 0;
const imageServer = createServer(async (req,res) => {
  let body=''; for await (const chunk of req) body+=chunk;
  if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:['fixture-model','image-fixture','image-other'].map(id=>({id}))}));return;}
  if(req.url!=='/v1/images/generations'){const upstream=await fetch(model.origin+req.url,{method:req.method,headers:{'Content-Type':'application/json'},...(body?{body}:{})});res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')});res.end(Buffer.from(await upstream.arrayBuffer()));return;}
  if(req.headers.authorization!=='Bearer synthetic-only')throw new Error('Connection credentials not reused');
  imageRequests++; res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({data:[{b64_json:png}]}));
});
await new Promise(resolve=>imageServer.listen(0,"127.0.0.1",resolve));
const imageEndpoint = `http://127.0.0.1:${imageServer.address().port}/v1`;
let token = "synthetic-workspace-bootstrap";
const catalogFetch = async () => { return Response.json({ fixture: { id: "fixture", name: "Fixture", env: [], api: model.origin + "/v1", models: { "fixture-model": { id: "fixture-model", name: "Fixture", tool_call: true, modalities: { input: ["text"] }, limit: { context: 120000, output: 24000 } }, "fixture-other": { id: "fixture-other", name: "Other", tool_call: true, modalities: { input: ["text"] }, limit: { context: 80000, output: 10000 } } } } }); };
const core = await createPersonalApp({ hostDevice:false, dir: path.join(root, "core"), key: randomBytes(32), token, uiDir: path.resolve("dist-personal/server/ui"), memoryRuntime: false, modelCatalog: { fetch: catalogFetch, readSnapshot: () => undefined, log: () => {} }, identity: { fixtureOrigin: identity.origin } });
let child, ws, exited = false, logs = ""; const cases = [], exceptions = [];
async function until(check, label = "renderer state", timeout = 30_000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise((resolve) => setTimeout(resolve, 70)); } }
async function api(route, data) { const response = await fetch(core.origin + "/api/" + route, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) }); const value = await response.json(); if (!response.ok) throw new Error(value.error); return value; }
let command, evaluate;
const click = (selector) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw new Error('Control unavailable: '+${JSON.stringify(selector)});el.click();})()`);
const textButton = (text, scope = "document") => evaluate(`(()=>{const el=[...${scope}.querySelectorAll('button')].find(e=>e.getClientRects().length>0&&(e.textContent.trim()===${JSON.stringify(text)}||e.querySelector(':scope > span')?.textContent.trim()===${JSON.stringify(text)}));if(!el||el.disabled)throw new Error('Button unavailable: '+${JSON.stringify(text)});el.click();})()`);
async function input(selector, value) { if (selector === 'input[name=model]') { await click('[aria-label="默认模型"]'); await until(()=>evaluate("document.querySelector('.model-picker-popover')?.matches(':popover-open')")); await input('.model-picker-popover input[aria-label="搜索模型"]',value); await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); return; } await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function screenshot(name) { await new Promise((resolve) => setTimeout(resolve, 250)); writeFileSync(path.join(output, name + ".png"), Buffer.from((await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64")); }
async function geometry() {
  const result = await evaluate(`(()=>{const main=document.querySelector('main');const c=document.querySelector('.composer');return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,mainWidth:main.getBoundingClientRect().width,composer:c?{left:c.getBoundingClientRect().left,right:c.getBoundingClientRect().right,bottom:c.getBoundingClientRect().bottom}:null,height:innerHeight};})()`);
  if (result.overflow || result.mainWidth < 300 || (result.composer && (result.composer.left < 0 || result.composer.right > result.width + 1 || result.composer.bottom > result.height + 1))) throw new Error("Layout overflow: " + JSON.stringify(result));
  return result;
}
try {
  const bootstrap = await fetch(core.origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const loginRequest = async (route, data) => { const response = await fetch(core.origin + "/api/" + route, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(data) }); if (!response.ok) throw new Error("Fixture login failed"); return response.json(); };
  const transaction = await loginRequest("auth/start", { account: "owner@example.test", name: "界面验收" });
  token = (await loginRequest("auth/respond", { ...transaction, password: " synthetic password " })).token;
  // Keep exported reference screenshots free of this machine's hostname.
  core.store.run("UPDATE devices SET name=?", "演示设备");
  await api("config", { provider: "openai", endpoint: imageEndpoint, model: "fixture-model", apiKey: "synthetic-only" });
  await api("bots", { name: "工作助手", instructions: "整理信息。" });
  core.store.run("UPDATE bot_policies SET policy_json=?", JSON.stringify({tools:[]}));
  const profile = path.join(root, "renderer"); mkdirSync(profile, { recursive: true });
  const entry = path.join(root, "renderer.cjs");
  writeFileSync(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});await w.webContents.session.cookies.set({url:${JSON.stringify(core.origin)},name:'nex',value:${JSON.stringify(token)},httpOnly:true,sameSite:'strict',path:'/'});await w.loadURL(${JSON.stringify(core.origin)});});app.on('window-all-closed',()=>app.quit());`);
  const stagedElectron = path.resolve("dist-personal/electron", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron.exe");
  const electron = existsSync(stagedElectron) ? stagedElectron : createRequire(import.meta.url)("electron");
  child = spawn(electron, [entry, "--remote-debugging-port=0"], { windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, TEMP: os.tmpdir(), TMP: os.tmpdir() }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => logs += data); child.stderr.on("data", (data) => logs += data); child.on("exit", () => exited = true);
  await until(() => { if (exited) throw new Error("Fixture renderer exited: " + logs); return existsSync(path.join(profile, "DevToolsActivePort")); }, "hidden renderer boot");
  const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  // Electron can receive a port on fetch's browser-blocked list on Windows.
  // Read this owned debugger endpoint through Node HTTP instead.
  const targets = await new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}/json/list`, response => {
      let body = ""; response.on("data", chunk => body += chunk); response.on("error", reject);
      response.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on("error", reject); request.setTimeout(15000, () => request.destroy(new Error("Debugger timeout")));
  });
  ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl); await new Promise((resolve) => ws.once("open", resolve));
  let sequence = 0; const replies = new Map();
  ws.on("message", (raw) => { const event = JSON.parse(raw); if (event.method === "Runtime.exceptionThrown") exceptions.push(event.params.exceptionDetails.text); const pending = replies.get(event.id); if (pending) { replies.delete(event.id); if (event.error) pending.reject(new Error(event.error.message)); else pending.resolve(event.result); } });
  command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { replies.delete(id); reject(new Error("CDP timeout: " + method)); }, 20_000); replies.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); ws.send(JSON.stringify({ id, method, params })); });
  evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate("!!document.querySelector('.contact-item')"), "authenticated workspace");
  await click(".workspace-account-name");
  await textButton("设置", "document.querySelector('.account-menu')");
  await textButton("模型", "document.querySelector('.preferences-nav')");
  const section = "document.querySelector('[aria-label=生图模型]')";
  const visibleSection = "document.querySelector('[data-model-visibility]')";
  await until(()=>evaluate(`!${section}.querySelector('.model-picker-trigger').disabled && !${visibleSection}.querySelector('.model-picker-trigger').disabled`));
  if(await evaluate(`${section}.querySelector('[role=listbox]')!==null || ${visibleSection}.querySelector('[role=listbox]')!==null`))throw new Error('Model lists should start collapsed');
  if(await evaluate(`[...${visibleSection}.querySelectorAll('button')].some(el=>['全部显示','清空选择','只看已选','刷新目录'].includes(el.textContent.trim()))`))throw new Error('Removed actions remain');
  await textButton('选择生图模型',section);
  await until(()=>evaluate(`${section}.querySelectorAll('[role=option]').length===3`));
  if(await evaluate(`${section}.querySelectorAll('input[type=password],input[name=endpoint],input[name=model]').length`))throw new Error('Independent model configuration remains');
  const choose = id => evaluate(`(()=>{const el=[...${section}.querySelectorAll('[role=option]')].find(el=>el.textContent.includes(${JSON.stringify(id)}));if(!el)throw new Error('Missing catalog model');el.click();})()`);
  if(await evaluate(`[...${section}.querySelectorAll('button'),...${visibleSection}.querySelectorAll('button')].some(el=>el.textContent.includes('保存'))`))throw new Error('Manual save buttons remain');
  await evaluate(`(()=>{const original=window.fetch.bind(window);window.fixtureFetch=original;window.fetch=async (url,options)=>{if(String(url).endsWith('/api/models/images'))await new Promise(resolve=>setTimeout(resolve,120));return original(url,options);};const rows=[...${section}.querySelectorAll('[role=option]')];rows.find(el=>el.textContent.includes('image-fixture')).click();rows.find(el=>el.textContent.includes('image-other')).click();})()`);
  await until(()=>core.store.imageModelSelection().models.length===2);
  await until(()=>evaluate(`!${section}.textContent.includes('保存中…')`));
  await textButton('完成',section);
  await evaluate('window.fetch=window.fixtureFetch');
  cases.push('rapid-multiselect-autosaves-without-losing-clicks');
  await until(()=>core.store.imageModelSelection().models.length===2);
  if(core.store.all('SELECT id FROM image_models').length!==0)throw new Error('Standalone model created');
  if(await evaluate(`${section}.querySelector('[role=listbox]')!==null || ${section}.querySelectorAll('.model-selection-value').length!==2`))throw new Error('Selected image models not echoed');
  cases.push('collapsed-image-selection-with-selected-model-echo');
  await textButton('选择显示的模型',visibleSection);
  await evaluate(`${visibleSection}.querySelector('[role=option]').click()`);
  await textButton('完成',visibleSection);
  await until(()=>core.store.modelVisibility().models?.length===2);
  if(await evaluate(`${visibleSection}.querySelector('[role=listbox]')!==null || ${visibleSection}.querySelectorAll('.model-selection-value').length!==2`))throw new Error('Visible models not echoed');
  if(await evaluate(`${section}.textContent.includes('已保存') || ${visibleSection}.textContent.includes('已保存')`))throw new Error('Saved badges remain');
  cases.push('collapsed-visible-selection-with-removed-toolbar-and-saved-echo');
  await textButton('选择生图模型',section);
  await evaluate(`window.fetch=async (url,options)=>String(url).endsWith('/api/models/images')?new Response(JSON.stringify({error:'Synthetic save failure'}),{status:503,headers:{'Content-Type':'application/json'}}):window.fixtureFetch(url,options)`);
  await choose('fixture-model');
  await until(()=>evaluate(`${section}.querySelector('[role=alert]')?.textContent.includes('未保存')`));
  if(core.store.imageModelSelection().models.length!==2 || await evaluate(`${section}.querySelectorAll('.model-selection-value').length!==2`))throw new Error('Failed selection did not revert');
  await evaluate('window.fetch=window.fixtureFetch');
  await choose('fixture-model');
  await until(()=>core.store.imageModelSelection().models.length===3);
  await choose('fixture-model');
  await until(()=>core.store.imageModelSelection().models.length===2);
  await until(()=>evaluate(`!${section}.textContent.includes('保存中…') && !${section}.querySelector('[role=alert]')`));
  await textButton('完成',section);
  cases.push('autosave-failure-reverts-with-error-and-next-selection-recovers');
  await evaluate("document.querySelector('[aria-label=生图模型]').scrollIntoView({block:'center'})");
  await geometry(); await screenshot("image-models-desktop");
  await command("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelector('[aria-label=生图模型]').scrollIntoView({block:'center'})");
  await geometry();await screenshot("image-models-mobile");
  await textButton('选择生图模型',section);
  await until(()=>evaluate(`${section}.querySelector('.model-picker-popover')?.matches(':popover-open')`));
  if(!await evaluate(`(()=>{const r=${section}.querySelector('.model-picker-popover').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`))throw new Error('Mobile picker overflow');
  await screenshot('image-model-picker-mobile');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(()=>evaluate(`${section}.querySelector('[role=listbox]')===null`));
  cases.push("multiple-models-desktop-and-mobile-layout-and-escape");
  await command("Emulation.setDeviceMetricsOverride", {width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await textButton('选择生图模型',section); await choose('image-other'); await textButton('完成',section);
  await until(()=>core.store.imageModelSelection().models.length===1);
  cases.push('deselect-model-and-save');
  await command("Page.reload"); await until(()=>evaluate("!!document.querySelector('.contact-item')"));
  await click('.workspace-account-name'); await textButton('设置',"document.querySelector('.account-menu')"); await textButton('模型',"document.querySelector('.preferences-nav')");
  await until(()=>evaluate(`${section}.querySelectorAll('.model-selection-value').length===1 && ${visibleSection}.querySelectorAll('.model-selection-value').length===2`));
  if(!await evaluate(`${section}.querySelector('.model-selection-value').textContent==='image-fixture'`))throw new Error('Auto-saved model not restored');
  cases.push('both-autosaved-selections-persist-after-reload');
  await click('.contact-item');
  await until(()=>evaluate("!!document.querySelector('textarea[aria-label=\"发送给 Agent 的消息\"]')"));
  await textButton('设置', "document.querySelector('.inspector-tabs')");
  await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(el=>el.textContent.includes('已授权')&&el.textContent.includes('配置'));if(!button)throw new Error('Missing tool permissions');button.click();})()`);
  await until(()=>evaluate("document.querySelector('.policy-grid')!==null"));
  if(!await evaluate(`['查看生图模型','按需生成图片'].every(label=>{const input=[...document.querySelectorAll('.policy-grid label')].find(el=>el.textContent.includes(label))?.querySelector('input');return input?.checked&&input.disabled;})`))throw new Error('Universal image permissions are not locked on');
  await textButton('取消', "document.querySelector('.policy-grid').closest('form')");
  cases.push('restricted-agent-image-permissions-always-on');
  model.scripts.push({kind:"openai-tool",calls:[{id:"fixture-image",name:"broker",args:JSON.stringify({action:"image.generate",prompt:"a blue bird"})}]},{kind:"openai-text",text:"图片已生成"});
  await input('textarea[aria-label="发送给 Agent 的消息"]',"画一只蓝色小鸟");
  await click('[aria-label="发送消息"]');
  await until(()=>evaluate("!!document.querySelector('.message-image img')?.naturalWidth"),"decoded generated image",45000);
  if(imageRequests!==1)throw new Error("Unexpected image requests");
  await until(()=>core.store.get("SELECT status FROM tasks ORDER BY created_at DESC LIMIT 1")?.status==="succeeded");
  const imageUrl=await evaluate("new URL(document.querySelector('.message-image img').src).pathname");
  const download=await fetch(core.origin+imageUrl,{headers:{Authorization:`Bearer ${token}`}});
  if(download.headers.get("content-disposition")?.startsWith("attachment;")!==true||Buffer.from(await download.arrayBuffer()).toString("base64")!==png)throw new Error("Image download mismatch");
  await click('[aria-label="收起助手详情"]');
  await screenshot("generated-image-desktop");
  await command("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await geometry();
  if(!await evaluate("(()=>{const r=document.querySelector('.message-image img').getBoundingClientRect();return r.width>100&&r.left>=0&&r.right<=innerWidth;})()"))throw new Error("Image preview does not fit mobile");
  await screenshot("generated-image-mobile");
  cases.push("generated-image-thumbnail-and-authenticated-download");
  await command("Emulation.setDeviceMetricsOverride", {width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await click('.message-image');
  await until(()=>evaluate("!!document.querySelector('.image-lightbox')"),"image lightbox");
  if(await evaluate("[...document.querySelectorAll('.image-lightbox button')].map(b=>b.getAttribute('aria-label')).join('|')")!=="删除图片")throw new Error("Lightbox exposes extra controls");
  await click('.image-lightbox-delete');
  await until(()=>evaluate("!document.querySelector('.message-image')"),"image deleted from message",15000);
  cases.push("image-lightbox-x-deletes-generated-image");
  const htmlProbeRequests = [];
  ws.on('message', raw => { const event = JSON.parse(raw); if (event.method === 'Network.requestWillBeSent' && event.params.request.url.includes('static-html-probe')) htmlProbeRequests.push(event.params.request.url); });
  await command('Network.enable');
  model.scripts.push({kind:'openai-text', text: '<h2>静态 HTML 验收</h2><p>支持 <b>加粗</b>、<span style="color:red;font-weight:bold;position:fixed">红色文字</span> 和换行<br>第二行。</p><table><tr><th>项目</th><th>状态</th></tr><tr><td>静态表格</td><td><strong>已完成</strong></td></tr></table><ul><li>原生列表</li></ul>\n\n- [x] Markdown 任务\n\n<a href="https://example.com">普通链接</a><script>window.__staticHTMLExecuted=true</script><img src="https://static-html-probe.invalid/pixel" onerror="window.__staticHTMLExecuted=true" alt="外部图片"><form><input value="禁止表单"></form><iframe src="https://static-html-probe.invalid"></iframe>'});
  await input('textarea[aria-label="发送给 Agent 的消息"]', '展示静态 HTML 示例');
  await click('[aria-label="发送消息"]');
  await until(()=>core.store.get("SELECT status FROM tasks ORDER BY created_at DESC LIMIT 1")?.status==="succeeded");
  const htmlState = `(()=>{const el=[...document.querySelectorAll('.markdown')].find(e=>e.querySelector('h2')?.textContent==='静态 HTML 验收');if(!el)return null;const span=el.querySelector('span[style]');return {table:el.querySelectorAll('table td').length,red:span&&getComputedStyle(span).color,position:span&&getComputedStyle(span).position,blocked:!!el.querySelector('script,iframe,form,img,[onclick],[onerror]'),checked:el.querySelector('input[type=checkbox]')?.checked,disabled:el.querySelector('input[type=checkbox]')?.disabled,executed:!!window.__staticHTMLExecuted,externalTarget:el.querySelector('a')?.target};})()`;
  await until(async()=>!!(await evaluate(htmlState))?.checked, 'static HTML rendered');
  const htmlResult=await evaluate(htmlState);
  if(htmlResult.table!==2||htmlResult.red!=='rgb(255, 0, 0)'||htmlResult.position!=='static'||htmlResult.blocked||htmlResult.executed||!htmlResult.disabled||htmlResult.externalTarget!=='_blank'||htmlProbeRequests.length)throw new Error('Static HTML mismatch: '+JSON.stringify({htmlResult,htmlProbeRequests}));
  await geometry(); await screenshot('static-html-mobile');
  await command("Emulation.setDeviceMetricsOverride", {width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await geometry(); await screenshot('static-html-desktop');
  cases.push('static-html-and-markdown-desktop-mobile-without-scripts-or-network');
  const chartSamples = [
    {type:'bar',title:'示例数据 · 每日订单',labels:['周一','周二','周三','周四','周五','周六','周日'],series:[{name:'本周',values:[12,18,15,26,22,31,28]},{name:'上周',values:[10,14,13,21,20,25,24]}],unit:'单'},
    {type:'histogram',title:'示例数据 · 响应时长分布',values:[0,1,2,3,4,5,6,7,8,9,10],bins:5,xLabel:'响应时长',unit:'秒'},
    {type:'line',title:'示例数据 · 收入趋势',labels:['一月','二月','三月','四月'],series:[{name:'收入',values:[200,350,null,480]},{name:'成本',values:[150,190,210,250]}],unit:'元'},
    {type:'pie',title:'示例数据 · 渠道占比',labels:['自然访问','社交媒体','推广'],values:[50,30,20],unit:'次'},
  ];
  const chartReply = '以下为示例数据。\n\n' + chartSamples.map(s=>'```chart\n'+JSON.stringify(s)+'\n```').join('\n\n') + '\n\n<b>四种图表验收</b>';
  model.scripts.push({kind:'openai-text',text:chartReply});
  await input('textarea[aria-label="发送给 Agent 的消息"]','展示四种统计图表'); await click('[aria-label="发送消息"]');
  await until(()=>evaluate("document.querySelectorAll('.nex-chart[data-chart-type]').length===4"),'four chart types');
  if(!model.requests.some(r=>r.body.includes('直方图格式')))throw new Error('Chart contract not sent to model');
  if(await evaluate("!!document.querySelector('.chat-chart pre > code.language-chart')"))throw new Error('Chart JSON shown as code');
  for (const type of ['bar','histogram','line','pie']) {
    const selector=`.nex-chart[data-chart-type=${type}]`;
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    await geometry(); await screenshot(`chart-${type}-desktop`);
    await evaluate(`(()=>{const mark=document.querySelector(${JSON.stringify(selector+' [data-label]')});mark.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));})()`);
    if(!await evaluate(`document.querySelector(${JSON.stringify(selector+' .nex-chart-tooltip')}).textContent.includes('：')`))throw new Error('Chart hover missing');
  }
  await click('.nex-chart[data-chart-type=histogram] summary');
  if(await evaluate("[...document.querySelectorAll('.nex-chart[data-chart-type=histogram] tbody td')].reduce((sum,td)=>sum+Number(td.textContent),0)")!==11)throw new Error('Histogram count mismatch');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  for (const type of ['bar','histogram','line','pie']) {
    await evaluate(`document.querySelector('.nex-chart[data-chart-type=${type}]').scrollIntoView({block:'center'})`);
    await geometry(); await screenshot(`chart-${type}-mobile`);
  }
  await evaluate("document.querySelector('.nex-chart[data-chart-type=pie] [data-label]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  if(!await evaluate("document.querySelector('.nex-chart[data-chart-type=pie] .nex-chart-tooltip').textContent.includes('50%')"))throw new Error('Touch/click value missing');
  await command('Page.reload');
  await until(()=>evaluate("document.querySelectorAll('.nex-chart[data-chart-type]').length===4"),'chart history reload');
  cases.push('four-chart-types-model-contract-hover-touch-data-and-reload');
  if (exceptions.length) throw new Error("Renderer exception: " + exceptions.join("; "));
  const report = { passed: true, cases, imageRequests, screenshots: output };
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error, logs.slice(-5000)); if (command) { await screenshot("failure").catch(() => {}); console.error(await evaluate("document.body.innerText").catch(() => "")); } throw error; }
finally {
  ws?.close();
  if (child && !exited) { if (process.platform === "win32") { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await new Promise((resolve) => killer.on("close", resolve)); } else child.kill("SIGTERM"); }
  imageServer.closeAllConnections(); await new Promise(resolve=>imageServer.close(resolve));
  await core.close(); await model.close(); await identity.close();
  if (path.dirname(root).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(root).startsWith("nex-image-fixture-")) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn("Owned fixture retained for cleanup:", root); }
  }
}
