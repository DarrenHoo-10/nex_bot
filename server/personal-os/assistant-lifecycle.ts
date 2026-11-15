import { setImmediate as yieldToIO } from "node:timers/promises";
import { type Row, canonical, hash, id, now, text } from "./store.ts";
import type { CoreStore } from "./store.ts";
import type { TaskRuntime } from "./runtime.ts";
import { vectorCache } from "./vector-cache.ts";
import { IdentityError } from "./identity-provider.ts";
import type { ForgetPlan } from "./memory-privacy.ts";

type Action = "reset_memory" | "delete";
type Ticket = { bot: string; action: Action; revision: string; expires: number };
export class AssistantLifecycle {
  private previews = new Map<string, Ticket>();
  private sweeping?: Promise<void>;
  private failedObjects = new Set<string>();
  constructor(readonly store: CoreStore, readonly runtime: TaskRuntime, private readonly disconnect: (ids:string[])=>void) {}

  private scope(bot: string, action: Action) {
    const s = this.store;
    const target = s.get("SELECT name,version,(SELECT revision FROM bot_lifecycle_revisions WHERE bot_id=bots.id) revision FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", bot, s.workspace, s.owner);
    if (!target) throw new IdentityError(404, "助手不存在");
    const busy = !!s.get("SELECT 1 FROM agent_topic_inputs WHERE bot_id=? AND status='pending'",bot)
      || !!s.get("SELECT id FROM tasks WHERE bot_id=? AND ended_at IS NULL", bot)
      || !!s.get("SELECT id FROM tool_calls WHERE bot_id=? AND status='unknown' AND NOT EXISTS(SELECT 1 FROM call_reconciliations WHERE tool_call_id=tool_calls.id)",bot)
      || [...s.attachmentJobs.keys()].some(key => s.get("SELECT 1 FROM chat_attachments WHERE id=? AND bot_id=?",key,bot));
    return { target, revision:hash(canonical({bot,action,target})), busy };
  }
  private counts(bot:string){
    const count=(table:string,filter="1")=>Number(this.store.get(`SELECT count(*) n FROM ${table} WHERE bot_id=? AND ${filter}`,bot)!.n);
    return {
      conversations:count("conversations","status!='deleted'"),messages:count("agent_messages"),
      memories:count("memory_documents","scope='bot' AND status!='deleted'")+count("assistant_memories","id NOT IN (SELECT topic_id FROM assistant_topics WHERE owner='user')"),
      routines:count("agent_routines","deleted_at IS NULL"),todos:count("todos"),
    };
  }
  preview(data: Record<string,unknown>) {
    const bot = text(data.botId,100), action = data.action;
    if (action !== "delete" && action !== "reset_memory") throw new Error("无效操作");
    const { target, revision, busy } = this.scope(bot,action);
    const counts=this.counts(bot);
    for (const [key,item] of this.previews) if (item.expires <= now()) this.previews.delete(key);
    const previewId=id();
    this.previews.set(previewId,{ bot,action,revision,expires:now()+60_000 });
    return {previewId,name:target.name,counts,blocked:busy};
  }
  execute(data: Record<string,unknown>) {
    const s=this.store, request=text(data.requestId,100), preview=text(data.previewId,100);
    const previous=s.get("SELECT preview_id FROM bot_lifecycle_operations WHERE id=?",request);
    if(previous){if(previous.preview_id!==preview)throw new IdentityError(409,"操作标识已使用");return this.status(request);}
    const ticket=this.previews.get(preview);
    if(!ticket||ticket.expires<=now())throw new IdentityError(409,"确认已过期，请重新打开菜单");
    const {bot,action}=ticket;
    s.transaction(()=>{
      const {revision,busy}=this.scope(bot,action);
      if(revision!==ticket.revision||busy)throw new IdentityError(409,"助手状态已变化，请核对未结束工作后重新确认");
      s.insert("bot_lifecycle_operations",{id:request,preview_id:preview,bot_id:bot,created_at:now(),phase:"references"});
      s.run("UPDATE bots SET status='deleted',version=version+1,memory_epoch=memory_epoch+1 WHERE id=?",bot);
      const replacement = action==="reset_memory" ? this.replace(bot) : null;
      s.run("UPDATE bot_lifecycle_operations SET replacement_id=? WHERE id=?",replacement,request);
      if(replacement)s.run("UPDATE agent_roles SET bot_id=? WHERE bot_id=?",replacement,bot);
      else s.run("DELETE FROM agent_roles WHERE bot_id=?",bot);
      s.run("UPDATE stock_history_aliases SET deleted_at=COALESCE(deleted_at,?) WHERE bot_id=?",now(),bot);
      s.run("UPDATE todos SET bot_id=?,task_id=NULL,version=version+1 WHERE bot_id=?",replacement,bot);
      s.run("UPDATE sync_state SET privacy_epoch=privacy_epoch+1 WHERE id=1");
      s.audit("agent."+action,"bot",bot,{operationId:request,replacement});
    });
    this.previews.delete(preview);
    this.runtime.memory.personal.pause(bot);
    for(const run of this.runtime.maintenance.values()) if(run.botId===bot)this.runtime.stopMaintenance(run.conversationId);
    this.runtime.changed();
    this.wake();
    return this.status(request);
  }

  private replace(bot:string) {
    const s=this.store, old=s.get("SELECT * FROM bots WHERE id=?",bot)!;
    const fresh=s.createBot(String(old.name),old.instructions);
    s.run("UPDATE bots SET model_connection_id=?,model_id=?,created_at=? WHERE id=?",old.model_connection_id,old.model_id,old.created_at,fresh);
    // These tables contain settings only. Transfer ownership so existing grant and rule IDs remain stable.
    for(const table of ["bot_policies","bot_public_profiles","bot_appearance","agent_approval_settings","agent_approval_rules","agent_model_settings","personal_connector_grants","personal_feishu_apps"]){
      s.run(`DELETE FROM ${table} WHERE bot_id=?`,fresh);
      s.run(`UPDATE ${table} SET bot_id=? WHERE bot_id=?`,fresh,bot);
    }
    s.run("UPDATE agent_approval_rules SET target_id=? WHERE bot_id=? AND action='agent.update' AND target_id=?",fresh,fresh,bot);
    for(const grant of s.all("SELECT * FROM device_grants WHERE bot_id=? AND status='active' AND expires_at>?",bot,now()))
      s.insert("device_grants",{...grant,id:id(),bot_id:fresh});
    s.run("DELETE FROM assistant_memory_settings WHERE bot_id=?",fresh);
    s.run("INSERT INTO assistant_memory_settings(bot_id,enabled,model,daily_budget,updated_at) SELECT ?,enabled,model,daily_budget,? FROM assistant_memory_settings WHERE bot_id=?",fresh,now(),bot);
    s.run("UPDATE user_topic_access SET principal=? WHERE principal=?",fresh,bot);
    s.run("UPDATE assistant_topics SET maintainer=? WHERE owner='user' AND maintainer=?",fresh,bot);
    // Keep the original attribution of user topics attached to the replacement.
    s.run("UPDATE assistant_memories SET bot_id=? WHERE bot_id=? AND id IN (SELECT topic_id FROM assistant_topics WHERE owner='user')",fresh,bot);
    s.run("UPDATE assistant_topics SET bot_id=? WHERE bot_id=? AND owner='user'",fresh,bot);
    for(const rule of s.all("SELECT * FROM agent_routines WHERE bot_id=? AND deleted_at IS NULL",bot)){
      const ruleId=id();
      s.insert("agent_routines",{...rule,id:ruleId,bot_id:fresh});
      s.run("UPDATE routine_occurrences SET routine_id=? WHERE routine_id=? AND status='pending' AND task_id IS NULL",ruleId,rule.id);
    }
    return fresh;
  }

  // Each committed phase or page can be resumed by a fresh process.
  private cleanPage(job:Row) {
    const s=this.store, bot=String(job.bot_id), request=String(job.id);
    const next=(phase:string)=>s.run("UPDATE bot_lifecycle_operations SET phase=?,page_cursor='' WHERE id=?",phase,request);
    const cursor=(value:string)=>s.run("UPDATE bot_lifecycle_operations SET page_cursor=? WHERE id=?",value,request);
    const plan:ForgetPlan={bots:[],documents:[],memories:[],messages:[],sources:[],tasks:[],banks:[],hashes:[],revision:request,selectorHash:request};
    const redact=()=>this.runtime.memory.privacy.redact(plan,request,true);
    switch(job.phase){
      case "references":
      case "reference_versions": {
        const table=job.phase==="references" ? "assistant_memories" : "assistant_memory_versions";
        const belongs=s.db.prepare(`SELECT 1 FROM agent_messages WHERE id=$ref AND bot_id=$bot
          UNION ALL SELECT 1 FROM assistant_memories WHERE id=$ref AND bot_id=$bot AND id NOT IN (SELECT topic_id FROM assistant_topics WHERE owner='user')
          UNION ALL SELECT 1 FROM memory_documents WHERE id=$ref AND bot_id=$bot AND scope='bot'
          UNION ALL SELECT 1 FROM conversation_episodes WHERE id=substr($ref,9) AND $ref LIKE 'episode:%' AND bot_id=$bot LIMIT 1`);
        const rows=s.all(`SELECT rowid position,id,version,refs_json FROM ${table} WHERE rowid>? AND refs_json!='[]'
          AND id IN (SELECT topic_id FROM assistant_topics WHERE owner='user') ORDER BY rowid LIMIT 64`,Number(job.page_cursor));
        for(const row of rows){
          const refs=JSON.parse(String(row.refs_json)) as {id:string}[];
          const kept=refs.filter(ref=>!belongs.get({ref:ref.id.replace(/^memory:/,""),bot}));
          if(kept.length!==refs.length)s.run(`UPDATE ${table} SET refs_json=? WHERE id=? AND version=?`,JSON.stringify(kept),row.id,row.version);
        }
        if(rows.length===64)cursor(String(rows.at(-1)!.position));
        else if(job.phase==="references")next("reference_versions");
        else{
          s.run("UPDATE assistant_topics SET parent_id=NULL WHERE bot_id=? AND owner='bot'",bot);
          s.run("UPDATE user_topic_access SET quote='' WHERE task_id IN (SELECT id FROM tasks WHERE bot_id=?)",bot);
          next("attachments");
        }
        break;
      }
      case "attachments": {
        const page=s.all("SELECT id FROM chat_attachments WHERE bot_id=? LIMIT 64",bot);
        for(const row of page){
          s.run("INSERT OR IGNORE INTO bot_lifecycle_objects SELECT ?,object_key FROM attachment_objects WHERE attachment_id=?",request,row.id);
          s.run("DELETE FROM chat_attachments WHERE id=?",row.id);
        }
        if(page.length<64)next("messages");
        break;
      }
      case "messages": {
        const page=s.all("SELECT id FROM agent_messages WHERE bot_id=? LIMIT 256",bot);
        for(const row of page){
          s.run("DELETE FROM assistant_memory_uses WHERE message_id=?",row.id);
          s.run("UPDATE agent_job_reports SET message_id=NULL WHERE message_id=?",row.id);
          s.run("UPDATE stock_history_messages SET message_id=NULL,deleted_at=COALESCE(deleted_at,?) WHERE message_id=?",now(),row.id);
          s.run("DELETE FROM agent_messages WHERE id=?",row.id);
        }
        if(page.length<256)next("tasks");
        break;
      }
      case "tasks": {
        plan.tasks=s.all("SELECT id FROM tasks WHERE bot_id=? AND id>? ORDER BY id LIMIT 24",bot,job.page_cursor).map(row=>String(row.id));
        if(plan.tasks.length){
          this.runtime.forgetFence(plan);
          redact();
          cursor(plan.tasks.at(-1)!);
        }
        if(plan.tasks.length<24)next("memories");
        break;
      }
      case "memories": {
        plan.memories=s.all("SELECT id FROM assistant_memories WHERE bot_id=? AND id NOT IN (SELECT topic_id FROM assistant_topics WHERE owner='user') LIMIT 64",bot).map(row=>String(row.id));
        plan.documents=s.all("SELECT id FROM memory_documents WHERE bot_id=? AND scope='bot' AND id>? ORDER BY id LIMIT 64",bot,job.page_cursor).map(row=>String(row.id));
        if(plan.memories.length||plan.documents.length)redact();
        if(plan.documents.length)cursor(plan.documents.at(-1)!);
        if(plan.memories.length<64 && plan.documents.length<64)next("archives");
        break;
      }
      case "archives": {
        const rows=s.all("SELECT id FROM conversation_episodes WHERE bot_id=? LIMIT 32",bot);
        for(const row of rows)this.runtime.memory.privacy.episodes.remove(String(row.id));
        this.runtime.memory.core.dropRefs(new Set(rows.map(row=>"episode:"+row.id)));
        if(rows.length<32)next("sessions");
        break;
      }
      case "sessions": {
        const rows=s.all("SELECT id FROM runtime_sessions WHERE bot_id=? AND id>? ORDER BY id LIMIT 12",bot,job.page_cursor);
        for(const row of rows){
          this.runtime.projection.clear(String(row.id));
          this.runtime.failures.clearRuntime(String(row.id));
        }
        if(rows.length<12)next("finish");
        else cursor(String(rows.at(-1)!.id));
        break;
      }
      case "finish": {
        plan.bots=[bot];
        redact();
        for(const bank of s.all("SELECT id,provider_bank_id FROM memory_bank_bindings WHERE scope='bot' AND bot_id=?",bot)){
          if(this.runtime.memory.ledger.client || s.get("SELECT 1 FROM memory_transfers WHERE bank_id=? AND (attempts>0 OR status NOT IN ('queued','cancelled'))",bank.id)){
            s.run("INSERT OR IGNORE INTO bot_lifecycle_banks VALUES(?,?)",request,bank.provider_bank_id);
            s.run("INSERT OR IGNORE INTO memory_bank_retirements VALUES(?,?,'queued',?)",bank.provider_bank_id,bank.id,now());
          }
          s.run("UPDATE memory_source_registry SET status='retracted' WHERE bank_id=?",bank.id);
          s.run("UPDATE memory_transfers SET status='cancelled' WHERE bank_id=?",bank.id);
          s.run("DELETE FROM memory_transfer_receipts WHERE transfer_id IN (SELECT id FROM memory_transfers WHERE bank_id=?)",bank.id);
          s.run("UPDATE memory_bank_bindings SET provider_bank_id=?,state='deleted' WHERE id=?",id(),bank.id);
        }
        s.run("DELETE FROM assistant_topic_member_scan WHERE bot_id=?",bot);
        s.run("DELETE FROM assistant_topic_moves WHERE bot_id=? AND topic_id NOT IN (SELECT topic_id FROM assistant_topics WHERE owner='user')",bot);
        s.run("DELETE FROM assistant_topic_organize WHERE bot_id=?",bot);
        vectorCache(s).drop(bot);
        s.run("DELETE FROM transcript WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id=?)",bot);
        s.run("UPDATE conversations SET status='deleted',title='' WHERE bot_id=?",bot);
        for(const table of ["agent_input_receipts","agent_journal","assistant_conversations","assistant_core_memory","core_memory_receipts","assistant_memory_settings"])
          s.run(`DELETE FROM ${table} WHERE bot_id=?`,bot);
        s.run("UPDATE device_calls SET result_json='{}' WHERE bot_id=? AND result_json IS NOT NULL",bot);
        s.run("UPDATE agent_inboxes SET active_task_id=NULL,read_seq=next_seq-1 WHERE bot_id=?",bot);
        s.run("DELETE FROM agent_job_reports WHERE job_id IN (SELECT id FROM agent_jobs WHERE bot_id=?)",bot);
        s.run("DELETE FROM agent_jobs WHERE bot_id=?",bot);
        s.run("DELETE FROM job_tool_receipts WHERE call_id IN (SELECT id FROM tool_calls WHERE bot_id=?)",bot);
        s.run("DELETE FROM agent_topic_children WHERE root_conversation_id IN (SELECT id FROM conversations WHERE bot_id=?)",bot);
        s.run("DELETE FROM stock_history_compactions WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id=?)",bot);
        for(const table of ["agent_topic_inputs","agent_topic_edits","agent_topics"])s.run(`DELETE FROM ${table} WHERE bot_id=?`,bot);
        const disconnected=this.removeIdentity(bot);
        next("done");
        return disconnected;
      }
      default: throw new Error("未知的助手清理阶段");
    }
    return [];
  }
  private removeIdentity(bot:string){
    const s=this.store;
    s.run("UPDATE assistant_topics SET maintainer=NULL WHERE owner='user' AND maintainer=?",bot);
    s.run("DELETE FROM routine_origins WHERE routine_id IN (SELECT id FROM agent_routines WHERE bot_id=?)",bot);
    s.run("DELETE FROM routine_occurrences WHERE routine_id IN (SELECT id FROM agent_routines WHERE bot_id=?)",bot);
    s.run("DELETE FROM agent_routines WHERE bot_id=?",bot);
    s.run("UPDATE device_grants SET status='revoked',version=version+1 WHERE bot_id=? AND status='active'",bot);
    const connectors=s.all("SELECT connector_id,app_id FROM personal_feishu_apps WHERE bot_id=?",bot);
    for(const connector of connectors){
      s.run("DELETE FROM personal_feishu_messages WHERE app_id=?",connector.app_id);
      s.run("DELETE FROM personal_feishu_outbound WHERE app_id=?",connector.app_id);
      s.run("DELETE FROM personal_connectors WHERE id=?",connector.connector_id);
    }
    for(const table of ["bot_policies","personal_connector_grants","agent_model_settings","agent_approval_rules","agent_approval_settings","bot_appearance","bot_public_profiles","user_topic_indexed","resident_shortened"])
      s.run(`DELETE FROM ${table} WHERE bot_id=?`,bot);
    s.run("DELETE FROM user_topic_access WHERE principal=?",bot);
    s.run("DELETE FROM topic_delegations WHERE target_bot_id=? OR task_id IN (SELECT id FROM tasks WHERE bot_id=?)",bot,bot);
    s.run("UPDATE memory_bank_bindings SET state='deleted' WHERE scope='bot' AND bot_id=?",bot);
    s.run("UPDATE bots SET status='deleted',name='',instructions='',model_connection_id=NULL,model_id=NULL WHERE id=?",bot);
    return connectors.map(row=>String(row.connector_id));
  }
  status(request:string){
    const job=this.store.get("SELECT replacement_id,phase,retry_at FROM bot_lifecycle_operations WHERE id=?",request);
    if(!job)throw new IdentityError(404,"操作不存在");
    const pending=job.phase!=="done" || this.store.get("SELECT 1 FROM bot_lifecycle_objects WHERE operation_id=?",request)
      ||this.store.get("SELECT 1 FROM bot_lifecycle_banks b JOIN memory_bank_retirements r USING(provider_bank_id) WHERE operation_id=? AND r.status!='succeeded'",request);
    return {operationId:request,replacementId:job.replacement_id,status:pending?(job.retry_at || this.failedObjects.has(request)?"needs_retry":"cleaning"):"completed"};
  }
  private local?:Promise<void>;
  private closing=false;
  private wake(){
    if(this.closing || this.local)return;
    this.local=this.drain().finally(()=>{this.local=undefined;});
  }
  private async drain(){
    while(!this.closing){
      await yieldToIO();
      if(this.closing)return;
      const job=this.store.get("SELECT * FROM bot_lifecycle_operations WHERE phase!='done' AND retry_at<=? ORDER BY retry_at,created_at LIMIT 1",now());
      if(!job)return;
      try{
        const disconnected=this.store.transaction(()=>{
          if(job.retry_at)this.store.run("UPDATE bot_lifecycle_operations SET retry_at=0 WHERE id=?",job.id);
          return this.cleanPage(job);
        });
        if(disconnected.length)this.disconnect(disconnected);
        if(job.phase==="finish"){this.runtime.changed();void this.runtime.memory.ledger.flush();this.sweep();}
      }catch(error){
        this.store.run("UPDATE bot_lifecycle_operations SET retry_at=? WHERE id=?",now()+15_000,job.id);
        console.warn("Assistant cleanup will retry",job.id,job.phase,error instanceof Error ? error.name : "error");
      }
    }
  }
  sweep(){
    this.wake();
    if(!this.closing && !this.sweeping)this.sweeping=this.cleanObjects().finally(()=>{this.sweeping=undefined;});
    return this.sweeping;
  }
  async close(){
    this.closing=true;
    await Promise.all([this.local,this.sweeping]);
  }
  private async cleanObjects(){
    const storage=this.store.attachmentObjects;
    for(const row of this.store.all("SELECT operation_id,object_key FROM bot_lifecycle_objects")){
      try{
        if(!storage?.delete){this.failedObjects.add(String(row.operation_id));continue;}
        if(!this.store.get("SELECT 1 FROM attachment_objects WHERE object_key=?",row.object_key))await storage.delete(String(row.object_key));
        this.store.run("DELETE FROM bot_lifecycle_objects WHERE operation_id=? AND object_key=?",row.operation_id,row.object_key);
        if(!this.store.get("SELECT 1 FROM bot_lifecycle_objects WHERE operation_id=?",row.operation_id))this.failedObjects.delete(String(row.operation_id));
      }catch{this.failedObjects.add(String(row.operation_id));}
    }
  }
}
