import { randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { createPersonalApp } from '../index.ts';
import { createWorkspaceService } from '../workspaces.ts';
import { startFakeIdentity } from '../testing/fake-identity.ts';
import { startFakeFeishu,messageEvent,cardActionEvent } from '../testing/fake-feishu.ts';
import { startFakeModel } from '../../runtime/pi/p0/fake-model.ts';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});

it("opens a child workspace's active Web QR from an anonymous phone and revokes it on cancellation or expiry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "feishu-web-scan-"));
  cleanup.push(async () => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const provider = await startFakeIdentity();
  cleanup.push(() => provider.close());
  const original = "https://accounts.feishu.cn/fixture?code=synthetic&addons=kept";
  let expiresIn = 120;
  const service = await createWorkspaceService({
    dir, key: randomBytes(32), token: "fixture", identity: { fixtureOrigin: provider.origin },
    memoryRuntime: false, modelCatalog: { fetchDisabled: true },
    feishu: { registerApp: async options => {
      options.onQRCodeReady({ url: original, expireIn: expiresIn });
      return new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } },
  });
  cleanup.push(() => service.close());
  let token = "";
  const bootstrap = await fetch(service.origin + "/api/session", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "fixture" }) });
  expect(bootstrap.status).toBe(200);
  let cookie = bootstrap.headers.getSetCookie()[0].split(";")[0];
  const api = async <T = Record<string, unknown>>(route: string, body?: object): Promise<T> => {
    const response = await fetch(service.origin + "/api/" + route, {
      headers: { Authorization: "Bearer " + token, Cookie: cookie, "Content-Type": "application/json" },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toBe(200);
    return await response.json() as T;
  };
  const first = await api("auth/start", { account: "owner@example.test", name: "owner" });
  await api("auth/respond", { ...first, password: " synthetic password " });
  cookie = "";
  const start = await api("auth/start", { account: "other@example.test", name: "other" });
  token = (await api<{token: string}>("auth/respond", { ...start, password: " synthetic password " })).token;
  expect(service.workspaces.size).toBe(1);
  const { botId } = await api<{botId: string}>("agents/finance");
  const begin = async () => {
    await api("feishu/register/start", { botId });
    const job = (await api<{feishu: {job: {scanPath: string}}}>("state")).feishu.job;
    expect(job.scanPath).toMatch(/^\/feishu\/s\/[\w-]{22}$/);
    return new URL(job.scanPath, service.origin);
  };
  const scan = await begin();
  const visit = (url: URL) => fetch(url, { redirect: "manual" });
  const page = await visit(scan);
  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toBe(original);
  expect(page.headers.get("cache-control")).toBe("no-store");
  await api("feishu/register/cancel", {});
  expect((await visit(scan)).status).toBe(410);
  expiresIn = 0;
  const expired = await begin();
  expect(expired.href).not.toBe(scan.href);
  expect((await visit(expired)).status).toBe(410);
  await api("feishu/register/cancel", {});
}, 30000);
it('routes one app to two verified account databases, one public group owner, and revokes old private actions',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'feishu-accounts-'));
  cleanup.push(async()=>{if(path.dirname(dir)!==os.tmpdir()||!path.basename(dir).startsWith('feishu-accounts-'))throw new Error('cleanup');rmSync(dir,{recursive:true,force:true});});
  const provider=await startFakeIdentity(),fake=await startFakeFeishu(),model=await startFakeModel();
  cleanup.push(()=>provider.close(),()=>fake.close(),()=>model.close());
  let starts=0;
  const options={dir,sharedFeishuAppId:'cli_fake',key:randomBytes(32),token:'synthetic',identity:{fixtureOrigin:provider.origin},memoryRuntime:false as const,feishu:{registerApp:fake.registerApp,transport:async(...args:Parameters<typeof fake.createTransport>)=>{starts++;return fake.createTransport(...args);},fetchImpl:((input,init)=>fetch(String(input).replaceAll('https://open.feishu.cn',fake.origin),init)) as typeof fetch}};
  const initial=await createPersonalApp(options),operator=initial.store.get('SELECT * FROM user_sessions WHERE id=?',initial.store.session)!;
  const challenge=initial.identity!.start({account:'owner@example.test',name:'owner'},operator);
  const owner=await initial.identity!.respond({...challenge,password:' synthetic password '},operator);await initial.close();
  const service=await createWorkspaceService(options);cleanup.push(()=>service.close());
  async function api(route:string,token:string,data?:unknown){const response=await fetch(service.origin+'/api/'+route,{headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(data?{method:'POST',body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json() as Record<string,unknown>};}
  const login=await api('auth/start','',{account:'other@example.test',name:'other'});
  const other=await api('auth/respond','',{...login.body,password:' synthetic password '});expect(other.status).toBe(200);
  const child=[...service.workspaces.values()][0];
  service.store.saveConfig({provider:'openai',endpoint:model.origin+'/v1',model:'fixture',apiKey:'synthetic'});
  child.store.saveConfig({provider:'openai',endpoint:model.origin+'/v1',model:'fixture',apiKey:'synthetic'});
  const bot=service.agents.finance();
  expect((await api('feishu/register/start',owner.token,{botId:bot.botId})).status).toBe(200);
  await expect.poll(()=>service.store.get('SELECT connection FROM personal_feishu_apps')?.connection).toBe('connected');
  const code=await api('feishu/accounts/bind',String(other.body.token),{appId:'cli_fake'});expect(code.status).toBe(200);
  await service.feishuRouter.dispatch('cli_fake',messageEvent({messageId:'bind-b',chatId:'dm-b',senderOpenId:'ou_b',content:JSON.stringify({text:code.body.code})}),'message');
  expect(starts).toBe(1);expect(child.store.get('SELECT app_secret FROM personal_feishu_apps')).toBeUndefined();
  model.scripts.push({kind:'openai-text',text:'B private answer'});
  await service.feishuRouter.dispatch('cli_fake',messageEvent({messageId:'b-input',chatId:'dm-b',senderOpenId:'ou_b',content:JSON.stringify({text:'B private question'})}),'message');
  await expect.poll(()=>child.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='b-input'")?.task_id).toBeTruthy();
  await expect.poll(()=>JSON.stringify(fake.sent).includes('B private answer'),{timeout:20_000}).toBe(true);
  expect(JSON.stringify(service.agents.topics(bot.botId))).not.toContain('B private question');
  model.scripts.push({kind:'openai-text',text:'A public answer'});
  const group=messageEvent({messageId:'g-a',chatId:'shared-group',chatType:'group',senderOpenId:'ou_owner',mentions:[{id:{open_id:'ou_fake_bot'},key:'@bot'}],content:JSON.stringify({text:'public question'})});
  await expect.poll(()=>service.store.get('SELECT bot_open_id FROM personal_feishu_apps')?.bot_open_id).toBe('ou_fake_bot');
  await service.feishuRouter.dispatch('cli_fake',group,'message');
  await expect.poll(()=>JSON.stringify(fake.sent).includes('A public answer'),{timeout:20_000}).toBe(true);
  const groupTopic=service.store.get("SELECT conversation_id FROM personal_feishu_messages WHERE message_id='g-a'")!;
  model.scripts.push({kind:'openai-text',text:'public follow-up'});
  await service.feishuRouter.dispatch('cli_fake',messageEvent({messageId:'g-b',parentId:'g-a',chatId:'shared-group',chatType:'group',senderOpenId:'ou_b',content:JSON.stringify({text:'another member asks'})}),'message');
  await expect.poll(()=>JSON.stringify(fake.sent).includes('public follow-up'),{timeout:20_000}).toBe(true);
  expect(service.store.get("SELECT conversation_id FROM personal_feishu_messages WHERE message_id='g-b'")?.conversation_id).toBe(groupTopic.conversation_id);
  expect(child.store.get("SELECT message_id FROM personal_feishu_messages WHERE message_id='g-b'")).toBeUndefined();
  expect((await api('feishu/accounts/unbind',String(other.body.token),{appId:'cli_fake'})).status).toBe(200);
  await service.feishuRouter.dispatch('cli_fake',messageEvent({messageId:'revoked-b',chatId:'dm-b',senderOpenId:'ou_b',content:JSON.stringify({text:'must not execute'})}),'message');
  expect(child.store.get("SELECT message_id FROM personal_feishu_messages WHERE message_id='revoked-b'")).toBeUndefined();
  expect(await service.feishuRouter.dispatch('cli_fake',cardActionEvent({openId:'ou_b',value:{kind:'stop',taskId:'fake'}}),'card')).toMatchObject({toast:{type:'error'}});
  expect(starts).toBe(1);
  // Unconfigured apps retain their selected assistant even with exactly one connected app.
  service.feishuRouter.setSharedApp(undefined);
  const legacyBot=service.store.createBot('Existing unrelated assistant');
  service.store.run('UPDATE personal_feishu_apps SET bot_id=?',legacyBot);
  model.scripts.push({kind:'openai-text',text:'legacy assistant answer'});
  await service.feishuRouter.dispatch('cli_fake',messageEvent({messageId:'legacy',chatId:'legacy-dm',senderOpenId:'ou_owner',content:JSON.stringify({text:'legacy question'})}),'message');
  await expect.poll(()=>service.store.get("SELECT task_id FROM personal_feishu_messages WHERE message_id='legacy'")?.task_id).toBeTruthy();
  const task=service.store.get("SELECT t.bot_id FROM tasks t JOIN personal_feishu_messages m ON m.task_id=t.id WHERE m.message_id='legacy'");
  expect(task?.bot_id).toBe(legacyBot);
  expect(service.feishuRouter.appsFor(child)).toHaveLength(0);
},60_000);
