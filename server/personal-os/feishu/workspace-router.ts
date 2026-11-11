import { randomBytes } from "node:crypto";
import { hash, now, text, type CoreStore, type Row } from "../store.ts";
import type { FeishuModule, FeishuModuleOptions } from "./module.ts";
import { normalizeFeishuEvent } from "./transport.ts";

type Target = { changed():void; store: CoreStore; feishu: FeishuModule; agents: {finance():{botId:string}};
  identity?: {authorizeTask(task:Row, fresh?:boolean):Promise<boolean>}; finance?: {config?: {managedAppId?: string}; authorizeBoundOwner():Promise<boolean>} };
function object(v:unknown):Record<string,unknown>{return v&&typeof v==='object'?v as Record<string,unknown>:{};}
/** One transport owner, account-scoped bindings. No application secret leaves its original vault. */
export class FeishuWorkspaceRouter {
  constructor(private readonly central:CoreStore,private readonly targets:()=>Target[]) {
    central.db.exec(`CREATE TABLE IF NOT EXISTS feishu_account_bindings(app_id TEXT NOT NULL,tenant_key TEXT NOT NULL,open_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(app_id,tenant_key,open_id),UNIQUE(app_id,tenant_key,issuer,subject)) STRICT;
      CREATE TABLE IF NOT EXISTS feishu_account_codes(code_hash TEXT PRIMARY KEY,app_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS feishu_group_claims(app_id TEXT NOT NULL,tenant_key TEXT NOT NULL,chat_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,actor_open_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(app_id,tenant_key,chat_id)) STRICT;
      CREATE TABLE IF NOT EXISTS feishu_router_inbox(app_id TEXT NOT NULL,tenant_key TEXT NOT NULL,message_id TEXT NOT NULL,chat_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(app_id,tenant_key,chat_id,message_id)) STRICT;`);
  }
  private sharedAppId:string|undefined;
  setSharedApp(appId:string|undefined){this.sharedAppId=appId;}
  private ownershipGuard:FeishuModuleOptions["ownershipAllowed"];
  setOwnershipGuard(guard:FeishuModuleOptions["ownershipAllowed"]) {this.ownershipGuard=guard;for(const target of this.targets())target.feishu.setOwnershipGuard(guard);}
  private identity(target:Target) {return target.store.get("SELECT e.issuer,e.subject FROM external_identities e JOIN identity_provider p ON p.external_identity_id=e.id WHERE e.status='active'");}
  private target(binding:Row) {return this.targets().find(t=>{const i=this.identity(t);return i?.issuer===binding.issuer&&i.subject===binding.subject;});}
  private source(appId:string) {return this.targets().find(t=>!!t.store.get('SELECT app_id FROM personal_feishu_apps WHERE app_id=?',appId));}
  private app(appId:string) {const source=this.source(appId);return source?.store.get('SELECT a.*,c.enabled FROM personal_feishu_apps a JOIN personal_connectors c ON c.id=a.connector_id WHERE app_id=?',appId);}
  private binding(target:Target,appId:string) {const i=this.identity(target);return i?this.central.get('SELECT * FROM feishu_account_bindings WHERE app_id=? AND issuer=? AND subject=? AND enabled=1',appId,i.issuer,i.subject):undefined;}
  async authorized(target:Target) {
    if(!target.identity||!this.identity(target))return false;
    for (const session of target.store.all("SELECT id FROM user_sessions WHERE protocol='native-v1' AND revoked_at IS NULL AND expires_at>?", now())) {
      if (await target.identity.authorizeTask({authorized_session_id: session.id}, true)) return true;
    }
    return await target.finance?.authorizeBoundOwner().catch(() => false) ?? false;
  }
  install(target:Target) {
    if(this.ownershipGuard)target.feishu.setOwnershipGuard(this.ownershipGuard);
    target.feishu.setRouting({
      routeInbound:(appId,event,kind)=>this.dispatch(appId,event,kind),
      sharedApp:(appId):Row|undefined=>{
        if(appId!==this.sharedAppId)return this.source(appId)===target?undefined:{app_id:appId,enabled:0};
        const app=this.app(appId),binding=this.binding(target,appId);
        const identity=this.identity(target),claim=!binding&&identity?this.central.get('SELECT * FROM feishu_group_claims WHERE app_id=? AND issuer=? AND subject=? AND enabled=1',appId,identity.issuer,identity.subject):undefined;
        // Return a disabled sentinel so a removed binding cannot fall back to local owner metadata.
        if(!app||!binding&&!claim)return {app_id:appId,enabled:0};
        return {app_id:appId,connector_id:app.connector_id,brand:app.brand,enabled:app.enabled,bot_id:target.agents.finance().botId,bot_open_id:app.bot_open_id,owner_open_id:binding?.open_id??claim!.actor_open_id,tenant_key:binding?.tenant_key??claim!.tenant_key,private_enabled:binding?1:0};
      },
      sendRequest:async(appId,method,path,body,beforeSend)=>{
        const source=this.source(appId);if(!source)throw new Error('application_unavailable');
        // Direct credential operation avoids recursively resolving the shared-app facade.
        return source.feishu.requestWithCredentials(appId,method,path,body,beforeSend);
      },
      destinationAllowed:(appId,actor,chatId,audience)=>{
        if(appId!==this.sharedAppId)return this.source(appId)===target;
        if(audience==='private')return this.binding(target,appId)?.open_id===actor;
        const claim=this.central.get('SELECT * FROM feishu_group_claims WHERE app_id=? AND chat_id=? AND enabled=1',appId,chatId);
        return !!claim&&this.target(claim)===target;
      },
      authorizeActor:async(appId,actor,chatId,chatType)=>{
        const binding=this.binding(target,appId),app=this.app(appId),source=this.source(appId);if(!app||app.enabled!==1||!source||!await source.feishu.channelAvailable(appId,'receive'))return false;
        if(appId!==this.sharedAppId)return source===target&&(chatType==='group'||app.owner_open_id===actor);
        if(chatType==='p2p')return !!binding&&binding.open_id===actor&&await this.authorized(target);
        const claim=this.central.get('SELECT * FROM feishu_group_claims WHERE app_id=? AND chat_id=? AND enabled=1',appId,chatId);
        return !!claim&&this.target(claim)===target;
      },
    });
  }
  appsFor(target:Target) {
    const bindingRows=this.central.all('SELECT * FROM feishu_account_bindings WHERE enabled=1');
    return this.targets().flatMap(owner => owner.store.all("SELECT app_id,brand FROM personal_feishu_apps WHERE app_id=?", this.sharedAppId ?? "").map(app => {
      const binding = bindingRows.find(row => row.app_id === app.app_id && this.target(row) === target);
      return { appId: app.app_id, brand: app.brand, status: this.app(String(app.app_id))?.connection,
        canManageChannel: owner === target && owner.finance?.config?.managedAppId === app.app_id, bound: !!binding, tenantKey: binding?.tenant_key };
    }));
  }
  async startBinding(target:Target,data:Record<string,unknown>) {
    const identity=this.identity(target),appId=text(data.appId,100);
    if(appId!==this.sharedAppId)throw new Error("application_not_shared");
    if(!await target.feishu.channelAvailable(appId,"bind"))throw new Error("channel_not_transferred");
    if(!identity||!this.app(appId))throw new Error('application_or_identity_unavailable');
    const code='NEX-'+randomBytes(18).toString('base64url'),expiresAt=now()+10*60_000;
    this.central.insert('feishu_account_codes',{code_hash:hash(code),app_id:appId,issuer:identity.issuer,subject:identity.subject,expires_at:expiresAt,consumed_at:null});
    return {code,expiresAt};
  }
  unbind(target:Target,data:Record<string,unknown>) {
    const binding=this.binding(target,text(data.appId,100));if(!binding)throw new Error('binding_not_found');
    this.central.run('UPDATE feishu_account_bindings SET enabled=0,version=version+1 WHERE app_id=? AND tenant_key=? AND open_id=?',binding.app_id,binding.tenant_key,binding.open_id);
    target.changed();
    // Group public responsibility and its subscriptions remain explicit; no other account inherits them.
    return {ok:true};
  }
  async claim(target:Target,data:Record<string,unknown>) {
    if(!await target.feishu.channelAvailable(text(data.appId,100),"bind"))throw new Error("channel_not_transferred");
    const binding=this.binding(target,text(data.appId,100)),chatId=text(data.chatId,200);
    if(!binding)throw new Error('binding_required');
    // Only a verified inbound event is sufficient membership evidence; arbitrary chat ids cannot claim a group.
    if(!this.central.get("SELECT message_id FROM feishu_router_inbox WHERE app_id=? AND tenant_key=? AND chat_id=? AND json_extract(payload,'$.sender.sender_id.open_id')=? AND json_extract(payload,'$.message.chat_type')='group'",binding.app_id,binding.tenant_key,chatId,binding.open_id))throw new Error('verified_group_membership_required');
    const old=this.central.get('SELECT * FROM feishu_group_claims WHERE app_id=? AND tenant_key=? AND chat_id=?',binding.app_id,binding.tenant_key,chatId);
    if(old&&this.target(old)!==target)throw new Error('group_already_claimed');
    this.central.run('INSERT INTO feishu_group_claims(app_id,tenant_key,chat_id,issuer,subject,actor_open_id) VALUES(?,?,?,?,?,?) ON CONFLICT(app_id,tenant_key,chat_id) DO UPDATE SET enabled=1',binding.app_id,binding.tenant_key,chatId,binding.issuer,binding.subject,binding.open_id);
    return target.feishu.claimGroup({appId:String(binding.app_id),chatId,actorOpenId:String(binding.open_id)});
  }
  async dispatch(appId:string,raw:unknown,kind:'message'|'card'):Promise<unknown> {
    const source=this.source(appId);if(!source||!await source.feishu.channelAvailable(appId,"receive"))throw new Error("channel_not_transferred");
    if(appId!==this.sharedAppId) return kind==='card'?source.feishu.handleCardAction(appId,raw):source.feishu.receiveMessage(appId,raw);
    const event=normalizeFeishuEvent(raw),sender=object(event.sender),operator=object(event.operator),message=object(event.message);
    const tenant=String(sender.tenant_key??operator.tenant_key??''),actor=String(object(sender.sender_id).open_id??operator.open_id??'');
    if(!tenant||!actor||!this.app(appId))throw new Error('unverified_channel_identity');
    const knownTenant=this.central.get('SELECT tenant_key FROM feishu_account_bindings WHERE app_id=? LIMIT 1',appId);
    if(knownTenant&&knownTenant.tenant_key!==tenant)throw new Error('tenant_mismatch');
    const header=object(object(raw).header);if(header.app_id&&header.app_id!==appId)throw new Error('application_mismatch');
    let binding=this.central.get('SELECT * FROM feishu_account_bindings WHERE app_id=? AND tenant_key=? AND open_id=? AND enabled=1',appId,tenant,actor);
    if(kind==='card') {
      const target=binding?this.target(binding):undefined;
      if(!target||!await this.authorized(target))return {toast:{type:'error',content:'账号绑定已失效，请重新登录'}};
      return target.feishu.handleCardAction(appId,event);
    }
    const chatId=String(message.chat_id??''),messageId=String(message.message_id??'');if(!chatId||!messageId||sender.sender_type!=='user')return;
    this.central.run('INSERT OR IGNORE INTO feishu_router_inbox(app_id,tenant_key,message_id,chat_id,payload) VALUES(?,?,?,?,?)',appId,tenant,messageId,chatId,JSON.stringify(event));
    const receipt=this.central.get('SELECT state FROM feishu_router_inbox WHERE app_id=? AND tenant_key=? AND chat_id=? AND message_id=?',appId,tenant,chatId,messageId);
    if(receipt?.state!=='pending')return;
    let content='';try{content=String(object(JSON.parse(String(message.content??'{}'))).text??'').trim();}catch{/* unsupported payload */}
    if(message.chat_type!=='group'&&content.startsWith('NEX-')) {
      const code=this.central.get('SELECT * FROM feishu_account_codes WHERE code_hash=? AND app_id=? AND consumed_at IS NULL AND expires_at>?',hash(content),appId,now());
      if(code){
        const target=this.target(code);if(!target||!await this.authorized(target))throw new Error('account_session_required');
        if(binding&&(binding.issuer!==code.issuer||binding.subject!==code.subject))throw new Error('actor_already_bound');
        this.central.transaction(()=>{
          this.central.run('DELETE FROM feishu_account_bindings WHERE app_id=? AND tenant_key=? AND issuer=? AND subject=? AND enabled=0',appId,tenant,code.issuer,code.subject);
          this.central.run('INSERT INTO feishu_account_bindings(app_id,tenant_key,open_id,issuer,subject) VALUES(?,?,?,?,?) ON CONFLICT(app_id,tenant_key,open_id) DO UPDATE SET enabled=1,version=version+1',appId,tenant,actor,code.issuer,code.subject);
          this.central.run('UPDATE feishu_account_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL',now(),code.code_hash);
        });
        target.changed();
      }
      this.central.run("UPDATE feishu_router_inbox SET state='bound' WHERE app_id=? AND tenant_key=? AND chat_id=? AND message_id=?",appId,tenant,chatId,messageId);return;
    }
    // A QR registration already proves the original owner's actor and current Core account association.
    if(!binding&&!this.central.get('SELECT app_id FROM feishu_account_bindings WHERE app_id=? AND tenant_key=? AND open_id=?',appId,tenant,actor)){const source=this.source(appId),app=this.app(appId),identity=source?this.identity(source):undefined;
      if(source&&identity&&app?.owner_open_id===actor&&await this.authorized(source)){
        this.central.run('INSERT OR IGNORE INTO feishu_account_bindings(app_id,tenant_key,open_id,issuer,subject) VALUES(?,?,?,?,?)',appId,tenant,actor,identity.issuer,identity.subject);
        binding=this.central.get('SELECT * FROM feishu_account_bindings WHERE app_id=? AND tenant_key=? AND open_id=? AND enabled=1',appId,tenant,actor);
      }
    }
    let target=binding?this.target(binding):undefined;
    if(message.chat_type==='group'){
      let claim=this.central.get('SELECT * FROM feishu_group_claims WHERE app_id=? AND tenant_key=? AND chat_id=? AND enabled=1',appId,tenant,chatId);
      if(!claim&&target&&await this.authorized(target)){
        const app=this.app(appId),mentioned=Array.isArray(message.mentions)&&message.mentions.some(m=>object(object(m).id).open_id===app?.bot_open_id);
        if(mentioned){await this.claim(target,{appId,chatId});claim=this.central.get('SELECT * FROM feishu_group_claims WHERE app_id=? AND tenant_key=? AND chat_id=? AND enabled=1',appId,tenant,chatId);}
      }
      target=claim?this.target(claim):undefined;
    }else if(target&&!await this.authorized(target))throw new Error('account_session_required');
    if(!target){this.central.run("UPDATE feishu_router_inbox SET state='ignored' WHERE app_id=? AND tenant_key=? AND chat_id=? AND message_id=?",appId,tenant,chatId,messageId);return;}
    target.feishu.receiveMessage(appId,event);
    this.central.run("UPDATE feishu_router_inbox SET state='routed' WHERE app_id=? AND tenant_key=? AND chat_id=? AND message_id=?",appId,tenant,chatId,messageId);
  }
  async recover(){for(const row of this.central.all("SELECT * FROM feishu_router_inbox WHERE state='pending'")){try{await this.dispatch(String(row.app_id),JSON.parse(String(row.payload)),'message');}catch{/* preserved for explicit identity recovery */}}}
}
