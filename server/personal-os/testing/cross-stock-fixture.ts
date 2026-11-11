/** Spawned only by the Stock cross-service test, all providers and credentials synthetic. */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createPersonalApp } from '../index.ts';
import { createWorkspaceService } from '../workspaces.ts';
import { startFakeIdentity } from './fake-identity.ts';
import { startFakeFeishu } from './fake-feishu.ts';
import { startFakeModel } from '../../runtime/pi/p0/fake-model.ts';
const configuration=JSON.parse(readFileSync(process.argv[2], 'utf8')) as {dir:string;stockUrl:string;serviceToken:string};
if(new URL(configuration.stockUrl).hostname!=='127.0.0.1')throw new Error('Only loopback Stock fixtures are allowed');
const identity=await startFakeIdentity({hexCookies:true,includeRole:true}),model=await startFakeModel(),fake=await startFakeFeishu();
const options={dir:configuration.dir,key:randomBytes(32),token:'synthetic-bootstrap',identity:{fixtureOrigin:identity.origin},memoryRuntime:false as const,
 stock:{url:configuration.stockUrl,token:configuration.serviceToken,instanceId:'fixture-stock',coreId:'fixture-core'},
 feishu:{registerApp:fake.registerApp,transport:fake.createTransport,fetchImpl:((input,init)=>fetch(String(input).replaceAll('https://open.feishu.cn',fake.origin),init)) as typeof fetch}};
const initial=await createPersonalApp(options),operator=initial.store.get('SELECT * FROM user_sessions WHERE id=?',initial.store.session)!;
const challenge=initial.identity!.start({account:'owner@example.test',name:'synthetic native owner'},operator);
const owner=await initial.identity!.respond({...challenge,password:' synthetic password '},operator);
initial.store.saveConfig({provider:'openai',endpoint:model.origin+'/v1',model:'fixture',apiKey:'synthetic'});
await initial.close();
const app=await createWorkspaceService(options);
async function post(route:string,body:unknown){const response=await fetch(app.origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error(`Native fixture login ${response.status}`);return await response.json() as Record<string,unknown>;}
const otherChallenge=await post('auth/start',{account:'other@example.test',name:'synthetic native other'});
const other=await post('auth/respond',{...otherChallenge,password:' synthetic password '});
for(const child of app.workspaces.values())child.store.saveConfig({provider:'openai',endpoint:model.origin+'/v1',model:'fixture',apiKey:'synthetic'});
const accounts=[...identity.sessions.entries()].map(([cookie,session])=>({cookie,csrf:session.csrf,subject:session.subject}));
process.stdout.write('NEX_CROSS_SERVICE_READY '+JSON.stringify({coreOrigin:app.origin,identityOrigin:identity.origin,ownerCoreToken:owner.token,otherCoreToken:other.token,accounts})+'\n');
const lines=createInterface({input:process.stdin});
for await (const line of lines){
 try {const request=JSON.parse(line);let result:unknown={ok:true};
  if(request.action==='model')model.scripts.push({kind:'openai-text',text:String(request.text)});
  else if(request.action==='modelTool')model.scripts.push({kind:'openai-tool',calls:[{id:'synthetic-tool',name:'broker',args:JSON.stringify(request.arguments)}]});
  else if(request.action==='inspect'){const target=[app,...app.workspaces.values()].find(t=>t.store.get('SELECT subject FROM external_identities WHERE status=\'active\'')?.subject===request.subject);result=target?.store.all('SELECT task_id,status,tool_name,result_json FROM tool_calls ORDER BY created_at')??[];}
  else if(request.action==='revoke'){for(const session of identity.sessions.values())if(session.subject===request.subject)session.active=false;}
  else if(request.action==='feishu')fake.deliver('cli_fake',request.event);
  else if(request.action==='sent')result=fake.sent;
  else if(request.action==='close')break;
  process.stdout.write('NEX_CROSS_SERVICE_RESULT '+JSON.stringify({id:request.id,result})+'\n');
 }catch{process.stdout.write('NEX_CROSS_SERVICE_ERROR\n');}
}
await app.close();await fake.close();await model.close();await identity.close();
