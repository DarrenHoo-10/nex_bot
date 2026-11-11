import { CoreStore, hash, id, now, optionalText, text, canonical, type Row } from "./store.ts";
import { entryPage, entryText } from './context-tools.ts';
import type { TaskRuntime } from "./runtime.ts";
import type { JobModule } from "./jobs.ts";
import { actions, policyTools } from "./policy.ts";
import { universalActions } from '../../shared/personal-capabilities.ts';
import { parseAppearance } from "../../shared/personal-appearance.ts";

// The contact and its inbox survive any number of execution contexts. Pi
// sessions belong to work, and never define the identity visible to the owner.
export type TopicInputOptions = { conversationId?: string; newConversation?: boolean; sourceContext?: Record<string, unknown>; audience?: 'private' | 'public';modelSelection?:{connectionId?:string;model?:string;reasoning?:string} };
export type PublishedMessage = { botId: string; messageId: string; conversationId: string | null; taskId: string | null };
// Keep receipts and referenced rows in storage while excluding removed conversations from inbox reads.
const visibleInbox = "(SELECT m.*,m.rowid AS rowid FROM agent_messages m WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id=m.conversation_id AND c.status='deleted'))";
export class AgentModule {
  beforeTopicInput?: (botId:string,conversationId:string)=>void;
  onPublished?: (botId: string, event: PublishedMessage) => void;
  /** Background jobs; set by the app once the job module exists. */
  jobs?: JobModule;
  constructor(readonly store: CoreStore, readonly runtime: TaskRuntime) {
    store.transaction(() => {
      for (const bot of store.all("SELECT id FROM bots")) this.ensure(String(bot.id));
      // Older releases bound background work to the owner inbox. Recovery must
      // drop that pointer without cancelling or replaying the routine.
      store.run("UPDATE agent_inboxes SET active_task_id=NULL WHERE active_task_id IN (SELECT task_id FROM agent_task_links WHERE origin='routine')");
      if (store.get("SELECT id FROM agent_bootstrap WHERE id=1")) return;
      for (const message of store.all("SELECT t.*,c.bot_id FROM transcript t JOIN conversations c ON c.id=t.conversation_id WHERE c.id NOT IN (SELECT child_conversation_id FROM a2a_messages) ORDER BY t.created_at,t.rowid")) {
        this.publish(String(message.bot_id), String(message.role), message.role === "system" ? "error" : "message", String(message.content), `legacy:${message.id}`, message.task_id, null, Number(message.created_at));
      }
      for (const task of store.all("SELECT * FROM tasks WHERE id NOT IN (SELECT child_task_id FROM a2a_messages)")) {
        store.run("INSERT OR IGNORE INTO agent_task_links VALUES(?,?,?,?)", task.id, task.bot_id, "owner", `legacy-task:${task.id}`);
        if (task.ended_at !== null && task.status === "succeeded") this.journal(task);
      }
      for (const link of store.all("SELECT * FROM a2a_messages")) { this.delegation(link, false); if (link.finished_at !== null) this.delegation(link, true); }
      store.insert("agent_bootstrap", { id: 1, completed_at: now() });
    });
    queueMicrotask(() => { if (!runtime.closing) this.drainTopics(); });
    runtime.onResult = (task, role, content, source) => {
      if (source.startsWith("image:") || store.get("SELECT task_id FROM agent_task_links WHERE task_id=?", task.id)) this.publish(String(task.bot_id), role, role === "system" ? "error" : "message", content, source, task.id);
    };
    runtime.onSettled = (taskId) => {
      const task = store.get("SELECT * FROM tasks WHERE id=?", taskId);
      if (task?.ended_at !== null && task?.status === "succeeded") this.journal(task);
      this.reportRoutine(taskId);
      // onSettled runs inside the transaction that ends the task. A job settlement must never roll that back, so it
      // runs after the commit; if it fails, the task stays ended and recovery settles it again (publishing once).
      queueMicrotask(() => {
        if (this.runtime.closing) return;
        try { this.jobs?.settle(taskId); this.drainTopics(); }
        catch (error) { console.warn("Background job settlement will be retried:", error instanceof Error ? error.message : error); }
      });
      store.run("UPDATE agent_inboxes SET active_task_id=NULL WHERE active_task_id=?", taskId);
    };
    runtime.onDelegation = (link, completed) => this.delegation(link, completed);
    runtime.agentHistory = (botId, taskId) => this.context(botId, taskId);
    runtime.historySearch = (botId, query, page) => this.search(botId, query, page);
  }
  ensure(botId: string) {
    const bot = this.store.get("SELECT id FROM bots WHERE id=? AND workspace_id=? AND owner_user_id=?", botId, this.store.workspace, this.store.owner);
    if (!bot) throw new Error("Agent 不存在");
    this.store.run("INSERT OR IGNORE INTO agent_inboxes(bot_id,workspace_id,owner_user_id) VALUES(?,?,?)", botId, this.store.workspace, this.store.owner);
  }
  updateProfile(data: Record<string, unknown>) {
    const botId = text(data.id, 100), name = text(data.name, 80), instructions = optionalText(data.instructions), version = Number(data.version);
    const expertise = data.expertise;
    if (expertise !== undefined && (!Array.isArray(expertise) || expertise.length > 20 || expertise.some((item) => typeof item !== "string" || !item.trim() || item.length > 80))) throw new Error("专长标签无效");
    this.store.transaction(() => {
      this.ensure(botId);
      if (!Number.isSafeInteger(version) || version < 1 || this.store.run("UPDATE bots SET name=?,instructions=?,version=version+1 WHERE id=? AND version=? AND status='active'", name, instructions, botId, version).changes !== 1) throw new Error("Agent 已被更新，请刷新");
      if (Array.isArray(expertise)) this.store.run("UPDATE bot_public_profiles SET expertise_json=? WHERE bot_id=?", JSON.stringify([...new Set(expertise.map((item: string) => item.trim()))]), botId);
      this.store.audit("agent.profile.update", "bot", botId, { version: version + 1 });
    });
    // Identity metadata does not change permissions, task IDs or inbox history.
    // Every worker obtains the latest identities at its model-request boundary.
    this.runtime.changed();
  }
  updateModel(data: Record<string, unknown>) {
    const botId = text(data.id, 100), model = data.model === "" ? "" : text(data.model, 200);
    this.store.transaction(() => {
      this.ensure(botId);
      if (!this.store.get("SELECT id FROM bots WHERE id=? AND status='active'", botId)) throw new Error("助手已归档");
      if (this.store.get("SELECT id FROM tasks WHERE bot_id=? AND ended_at IS NULL", botId)) throw new Error("请等待当前任务结束或停止任务后切换模型");
      // With connectionId the assistant may switch provider; without it (older clients) the provider must not have changed.
      const saved = this.store.saveBotModel(botId, { ...data, model });
      this.store.modelConfig(botId);
      this.store.audit("agent.model.update", "bot", botId, { model, connectionId: this.store.botModelSelection(botId)?.selected_connection, reasoning: saved.reasoning });
    });
    this.runtime.changed();
  }
  updateAppearance(data: Record<string, unknown>) {
    const botId = text(data.id, 100), appearance = parseAppearance(data.appearance), version = Number(data.version);
    this.store.transaction(() => {
      this.ensure(botId);
      if (!this.store.get("SELECT id FROM bots WHERE id=? AND status='active'", botId)) throw new Error("Agent 已归档");
      const current = this.store.get("SELECT version FROM bot_appearance WHERE bot_id=?", botId);
      if (!Number.isSafeInteger(version) || version < 0 || Number(current?.version ?? 0) !== version) throw new Error("头像已在其他设备更新，请关闭后重新打开");
      if (current) this.store.run("UPDATE bot_appearance SET appearance_json=?,version=version+1 WHERE bot_id=?", JSON.stringify(appearance), botId);
      else this.store.insert("bot_appearance", { bot_id: botId, appearance_json: JSON.stringify(appearance), version: 1 });
      this.store.audit("agent.appearance.update", "bot", botId, { version: version + 1 });
    });
    this.runtime.changed();
  }
  updatePolicy(data: Record<string, unknown>) {
    const botId = text(data.id, 100), version = Number(data.version);
    if (!Array.isArray(data.tools) || data.tools.some((tool) => !actions.includes(tool))) throw new Error("工具清单无效");
    const tools = [...new Set([...data.tools, ...universalActions])];
    this.store.transaction(() => {
      this.ensure(botId);
      if (!Number.isSafeInteger(version) || version < 1 || this.store.run("UPDATE bot_policies SET policy_json=?,approval_mode='allow_scoped',version=version+1 WHERE bot_id=? AND version=?", JSON.stringify({ tools: [...new Set(tools)] }), botId, version).changes !== 1) throw new Error("权限已变化，请刷新");
      this.store.audit("agent.policy.update", "bot", botId, { version: version + 1, tools });
    });
    this.runtime.changed();
  }
  policyView(botId: string) {
    const policy = this.store.get('SELECT version policy_version,policy_json FROM bot_policies WHERE bot_id=?', botId);
    return policy && { ...policy, policy_json: JSON.stringify({ ...JSON.parse(String(policy.policy_json)), tools: policyTools(policy) }) };
  }
  updateApprovalMode(data: Record<string, unknown>) {
    const botId = text(data.id, 100), mode = data.mode;
    if (mode !== "standard" && mode !== "full") throw new Error("权限模式无效");
    this.ensure(botId);
    this.store.transaction(() => {
      const current = this.store.get("SELECT version FROM agent_approval_settings WHERE bot_id=?", botId);
      if (data.version !== (current?.version ?? 0)) throw new Error("权限模式已变化，请刷新");
      this.store.run("INSERT INTO agent_approval_settings(bot_id,mode,version) VALUES(?,?,1) ON CONFLICT(bot_id) DO UPDATE SET mode=excluded.mode,version=version+1", botId, mode);
      this.store.audit("agent.approval_mode.update", "bot", botId, { mode });
    });
    // Explicitly selecting full mode authorizes pending effects too, with the
    // existing per-call digest/grant checks. Never revive rejected/unknown work.
    if (mode === "full") for (const approval of this.store.all("SELECT a.*,t.task_id FROM approvals a JOIN tool_calls t ON t.id=a.tool_call_id WHERE t.bot_id=? AND t.status='awaiting_approval' AND a.status='pending'", botId)) {
      try { this.runtime.decide(String(approval.id), String(approval.argument_hash), true); } catch { this.runtime.cancel(String(approval.task_id), "操作权限已变化，旧操作已停止，请重新发送要求"); }
    }
    this.runtime.changed();
  }
  archive(data: Record<string, unknown>) {
    const botId = text(data.id, 100), version = Number(data.version);
    this.store.transaction(() => {
      this.ensure(botId);
      if (this.store.get("SELECT id FROM tasks WHERE bot_id=? AND ended_at IS NULL", botId)) throw new Error("请先停止并核对该 Agent 的未结束工作");
      if (this.store.run("UPDATE bots SET status='archived',version=version+1 WHERE id=? AND version=? AND status='active'", botId, version).changes !== 1) throw new Error("Agent 已变化，请刷新");
      // Jobs waiting for an answer have no unfinished task; archiving ends them too. Finished jobs keep their outcome.
      for (const job of this.jobs?.openFor(botId) ?? []) this.store.run("UPDATE agent_jobs SET stopped_at=? WHERE id=? AND stopped_at IS NULL", now(), job.id);
      this.store.run("UPDATE agent_routines SET enabled=0,version=version+1 WHERE bot_id=?", botId);
      this.store.run("UPDATE routine_occurrences SET status='cancelled',reason='助手已归档',finished_at=? WHERE status='pending' AND routine_id IN (SELECT id FROM agent_routines WHERE bot_id=?)", now(), botId);
      this.store.audit("agent.archive", "bot", botId, { version: version + 1 });
    });
    this.runtime.changed();
  }
  publish(botId: string, role: string, kind: string, content: string, source: string, taskId: Row[string] = null, sender: Row[string] = null, timestamp = now(), conversationId: string | null = null) {
    // Routine and background job transcripts (including delegated work and generated media) belong to execution
    // details. Only the durable settlement reports, and the user's own direct replies to a job, reach the inbox.
    if (taskId && this.isBackground(String(taskId)) && source !== `routine-report:${taskId}` && !source.startsWith("job-report:") && !source.startsWith("job-input:")) return;
    return this.store.transaction(() => {
      this.ensure(botId);
      if (this.store.get("SELECT id FROM agent_messages WHERE source_key=?", source)) return;
      const inbox = this.store.get("SELECT next_seq FROM agent_inboxes WHERE bot_id=?", botId)!;
      const messageId = id();
      conversationId ??= taskId ? String(this.store.get("SELECT conversation_id FROM tasks WHERE id=?", taskId)?.conversation_id ?? "") || null : null;
      if(taskId && conversationId) conversationId=String(this.store.get('SELECT root_conversation_id FROM agent_topic_children WHERE conversation_id=?',conversationId)?.root_conversation_id??conversationId);
      if (conversationId && this.store.get("SELECT id FROM conversations WHERE id=? AND status='deleted'", conversationId)) return;
      this.store.insert("agent_messages", { id: messageId, bot_id: botId, ...this.store.scope(), seq: inbox.next_seq, role, kind, sender_bot_id: sender, task_id: taskId, content, source_key: source, created_at: timestamp, conversation_id: conversationId });
      this.runtime.memory.ledger.message(this.store.get("SELECT * FROM agent_messages WHERE id=?", messageId)!);
      this.store.run("UPDATE agent_inboxes SET next_seq=next_seq+1 WHERE bot_id=?", botId);
      if (role !== "user") queueMicrotask(() => { if (!this.runtime.closing && this.store.get("SELECT id FROM agent_messages WHERE source_key=?", source)) this.onPublished?.(botId, {botId,messageId,conversationId,taskId: taskId ? String(taskId) : null}); });
      return messageId;
    });
  }
  active(botId: string) {
    // Only direct owner work can be steered by the primary conversation.
    return this.store.get("SELECT t.* FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE l.bot_id=? AND l.origin='owner' AND NOT EXISTS(SELECT 1 FROM agent_topics p WHERE p.conversation_id=t.conversation_id) AND t.ended_at IS NULL ORDER BY t.created_at LIMIT 1", botId);
  }
  send(botId: string, content: string, clientId: string, sessionId?: string): {taskId:string;conversationId:string;messageId:string};
  send(botId: string, content: string, clientId: string, sessionId: string | undefined, options: TopicInputOptions): {taskId:string|null;conversationId:string;messageId:string;queued?:boolean};
  send(botId: string, content: string, clientId: string, sessionId = this.store.session, options: TopicInputOptions = {}) {
    if (options.newConversation || options.conversationId) return this.sendTopic(botId, content, clientId, sessionId, options);
    if(this.store.get('SELECT position FROM agent_topic_inputs WHERE bot_id=? AND client_id=?',botId,clientId)) throw new Error('消息 ID 已用于话题');
    content = text(content); clientId = text(clientId, 200);
    const digest = hash(content);
    this.ensure(botId);
    const existingReceipt = this.store.get("SELECT * FROM agent_input_receipts WHERE bot_id=? AND client_message_id=?", botId, clientId);
    if (existingReceipt) {
      if (existingReceipt.request_hash !== digest) throw new Error("同一消息 ID 的内容不同");
      return { taskId: String(existingReceipt.task_id), conversationId: String(existingReceipt.conversation_id), messageId: String(this.store.get("SELECT id FROM agent_messages WHERE source_key=?", `agent-input:${botId}:${clientId}`)?.id ?? "") };
    }
    const accepted = this.store.transaction(() => {
      const receipt = this.store.get("SELECT * FROM agent_input_receipts WHERE bot_id=? AND client_message_id=?", botId, clientId);
      if (receipt) { if (receipt.request_hash !== digest) throw new Error("同一消息 ID 的内容不同"); return { taskId: String(receipt.task_id), conversationId: String(receipt.conversation_id), replay: true }; }
      const active = this.active(botId);
      const bound = this.store.get("SELECT a.conversation_id FROM assistant_conversations a JOIN conversations c ON c.id=a.conversation_id WHERE a.bot_id=? AND c.status='open'", botId);
      const conversationId = active ? String(active.conversation_id) : bound ? String(bound.conversation_id) : this.store.createConversation(botId, "连续对话");
      if (!active) this.store.run("INSERT INTO assistant_conversations VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET conversation_id=excluded.conversation_id", botId, conversationId);
      const taskId = this.store.accept(conversationId, content, clientId, sessionId);
      this.store.run("INSERT OR IGNORE INTO agent_task_links VALUES(?,?,?,?)", taskId, botId, "owner", `owner-task:${taskId}`);
      this.store.insert("agent_input_receipts", { bot_id: botId, client_message_id: clientId, request_hash: digest, task_id: taskId, conversation_id: conversationId });
      this.store.run("UPDATE agent_inboxes SET active_task_id=? WHERE bot_id=?", taskId, botId);
      this.publish(botId, "user", "message", content, `agent-input:${botId}:${clientId}`, taskId);
      return { taskId, conversationId, replay: false };
    });
    if (!accepted.replay) this.runtime.input(accepted.conversationId, content, clientId, sessionId);
    this.runtime.changed(); return { taskId: accepted.taskId, conversationId: accepted.conversationId, messageId: String(this.store.get("SELECT id FROM agent_messages WHERE source_key=?", `agent-input:${botId}:${clientId}`)?.id ?? "") };
  }
  finance() {
    return this.store.transaction(() => {
      const bound = this.store.get("SELECT bot_id FROM agent_roles WHERE workspace_id=? AND owner_user_id=? AND role='finance_assistant'", this.store.workspace, this.store.owner);
      if (bound) { this.ensure(String(bound.bot_id)); return {botId: String(bound.bot_id)}; }
      const botId = this.store.createBot('金融助手', '研究金融市场、证券与策略，基于证据回答。来源对象只是研究起点，可以跨标的查证。');
      this.store.insert('agent_roles', {...this.store.scope(), role:'finance_assistant',bot_id:botId});
      this.store.run("INSERT INTO agent_approval_settings(bot_id,mode,version) VALUES(?,'full',1)",botId);
      return {botId};
    });
  }
  createTopic(botId: string, options: {title:string;audience:'private'|'public';sourceContext?:Record<string,unknown>}) {
    this.ensure(botId);
    if(!['private','public'].includes(options.audience)) throw new Error('受众无效');
    return this.store.transaction(() => {
      const conversationId=this.store.createConversation(botId,text(options.title,160));
      this.store.insert('agent_topics',{conversation_id:conversationId,bot_id:botId,audience:options.audience,source_context:canonical(options.sourceContext??{}),created_at:now()});
      return {id:conversationId,conversationId};
    });
  }
  topic(botId: string, conversationId: string) {
    this.ensure(botId);
    const topic = this.store.get('SELECT p.*,c.title,c.status FROM agent_topics p JOIN conversations c ON c.id=p.conversation_id WHERE p.bot_id=? AND p.conversation_id=? AND c.workspace_id=? AND c.owner_user_id=?',botId,conversationId,this.store.workspace,this.store.owner);
    if (!topic||topic.status==='deleted') throw new Error('话题不存在');
    return topic;
  }
  topics(botId: string) {
    this.ensure(botId);
    return this.store.all(`SELECT p.*,c.title,c.status,COALESCE(MAX(m.created_at),p.created_at) last_activity_at,COUNT(m.id) message_count,SUM(CASE WHEN m.role!='user' AND m.source_key NOT LIKE 'stock-history:%' AND m.seq>p.read_seq THEN 1 ELSE 0 END) unread_count FROM agent_topics p JOIN conversations c ON c.id=p.conversation_id LEFT JOIN agent_messages m ON m.conversation_id=p.conversation_id AND m.bot_id=p.bot_id WHERE p.bot_id=? AND c.status!='deleted' GROUP BY p.conversation_id ORDER BY last_activity_at DESC`,botId).map(row => ({...row, conversationId:row.conversation_id,unread_count:Number(row.unread_count??0),sourceContext:JSON.parse(String(row.source_context)),messages:this.topicMessages(botId,String(row.conversation_id)).slice(-2),activeTask:this.store.get('SELECT id,status FROM tasks WHERE (conversation_id=? OR conversation_id IN (SELECT conversation_id FROM agent_topic_children WHERE root_conversation_id=?)) AND ended_at IS NULL ORDER BY created_at LIMIT 1',row.conversation_id,row.conversation_id)??null}));
  }
  topicMessages(botId: string, conversationId: string, before = Number.MAX_SAFE_INTEGER, after = -1) {
    this.topic(botId,conversationId);
    return this.projectMessages(this.store.all(`SELECT m.*,(SELECT status FROM agent_topic_inputs i WHERE i.message_id=m.id) input_status FROM (SELECT * FROM agent_messages WHERE bot_id=? AND conversation_id=? AND seq<? AND seq>? ORDER BY seq ${after>=0?'ASC':'DESC'} LIMIT 200) m ORDER BY seq`,botId,conversationId,before,after));
  }
  private sendTopic(botId: string, content: string, clientId: string, sessionId: string, options: TopicInputOptions) {
    this.ensure(botId); content=text(content); clientId=text(clientId,200);
    if (options.newConversation && options.conversationId) throw new Error('新话题与已有话题不能同时指定');
    if (options.audience && !['private','public'].includes(options.audience)) throw new Error('受众无效');
    const source=canonical(options.sourceContext??{});
    if (source.length>8000) throw new Error('来源过长');
    const digest=hash(canonical({content,options}));
    const accepted=this.store.transaction(() => {
      const prior=this.store.get('SELECT * FROM agent_topic_inputs WHERE bot_id=? AND client_id=?',botId,clientId);
      if (prior) { if (prior.request_hash!==digest) throw new Error('同一消息 ID 的请求不同'); return prior; }
      if(this.store.get('SELECT task_id FROM agent_input_receipts WHERE bot_id=? AND client_message_id=?',botId,clientId)) throw new Error('消息 ID 已使用');
      const modelSelection=options.modelSelection!==undefined?this.store.resolveInputModel(botId,options.modelSelection):null;
      if(!modelSelection)this.store.modelConfig(botId);
      const conversationId=options.conversationId ? text(options.conversationId,100) : this.store.createConversation(botId,content.slice(0,60));
      if(options.conversationId) {
        const topic=this.topic(botId,conversationId);
        this.beforeTopicInput?.(botId,conversationId);
        if(topic.status!=='open'||options.audience&&options.audience!==topic.audience||options.sourceContext&&source!==topic.source_context) throw new Error('话题受众或来源不可更改');
      } else this.store.insert('agent_topics',{conversation_id:conversationId,bot_id:botId,audience:options.audience??'private',source_context:source,created_at:now()});
      const messageId=this.publish(botId,'user','message',content,`agent-input:${botId}:${clientId}`,null,null,now(),conversationId)!;
      this.store.insert('agent_topic_inputs',{bot_id:botId,client_id:clientId,request_hash:digest,conversation_id:conversationId,message_id:messageId,content,session_id:sessionId,status:'pending',model_selection_json:modelSelection?JSON.stringify(modelSelection):null});
      return this.store.get('SELECT * FROM agent_topic_inputs WHERE bot_id=? AND client_id=?',botId,clientId)!;
    });
    this.drainTopics(); this.runtime.changed();
    const receipt=this.store.get('SELECT * FROM agent_topic_inputs WHERE position=?',accepted.position)!;
    return {taskId:receipt.task_id ? String(receipt.task_id) : null,conversationId:String(receipt.conversation_id),messageId:String(receipt.message_id),queued:receipt.status==='pending'};
  }
  drainTopics() {
    for (const input of this.store.all("SELECT * FROM agent_topic_inputs WHERE status='pending' ORDER BY position")) {
      if(this.store.get('SELECT id FROM tasks WHERE conversation_id=? AND ended_at IS NULL',input.conversation_id)) continue;
      this.store.transaction(() => {
        const taskId=this.store.accept(String(input.conversation_id),String(input.content),String(input.client_id),String(input.session_id),input.model_selection_json?JSON.parse(String(input.model_selection_json)):undefined);
        this.store.run('INSERT OR IGNORE INTO agent_task_links VALUES(?,?,?,?)',taskId,input.bot_id,'owner',`owner-task:${taskId}`);
        if(input.model_selection_json)this.store.run('INSERT OR IGNORE INTO task_model_selections VALUES(?,?)',taskId,input.model_selection_json);
        this.store.run("UPDATE agent_topic_inputs SET status='accepted',task_id=? WHERE position=? AND status='pending'",taskId,input.position);
        this.store.run('UPDATE agent_messages SET task_id=? WHERE id=?',taskId,input.message_id);
      });
      const taskId=String(this.store.get('SELECT task_id FROM agent_topic_inputs WHERE position=?',input.position)!.task_id);
      queueMicrotask(()=>{if(!this.runtime.closing)this.runtime.kick(taskId);});
    }
  }
  topicTasks(botId: string, conversationId: string) {
    this.topic(botId,conversationId);
    return this.store.all('SELECT id,bot_id,conversation_id,objective,status,result_summary,created_at,ended_at FROM tasks WHERE conversation_id=? OR conversation_id IN (SELECT conversation_id FROM agent_topic_children WHERE root_conversation_id=?) ORDER BY created_at,rowid',conversationId,conversationId).map(task=>({...task,effects:this.store.all('SELECT id,tool_name,status FROM tool_calls WHERE task_id=? ORDER BY created_at,rowid',task.id)}));
  }
  retryTopic(botId: string, conversationId: string, taskId: string, clientId: string, sessionId = this.store.session) {
    this.topic(botId,conversationId);
    const task=this.store.get('SELECT * FROM tasks WHERE id=? AND conversation_id=?',taskId,conversationId);
    if(!task||task.ended_at===null||!['failed','cancelled'].includes(String(task.status))) throw new Error('本任务不可重试');
    const tree=this.store.all(`WITH RECURSIVE work(id) AS (SELECT ? UNION SELECT a.child_task_id FROM a2a_messages a JOIN work w ON a.parent_task_id=w.id UNION SELECT t.id FROM tasks t JOIN agent_jobs j ON t.conversation_id=j.conversation_id JOIN work w ON j.origin_task_id=w.id) SELECT id FROM work`,taskId).map(row=>String(row.id));
    const marks=tree.map(()=>'?').join(',');
    if(this.store.get(`SELECT id FROM tasks WHERE id IN (${marks}) AND ended_at IS NULL LIMIT 1`,...tree)) throw new Error('子任务仍在进行，请先核对并停止');
    const unsafe=this.store.get(`SELECT id FROM tool_calls WHERE task_id IN (${marks}) AND status IN ('succeeded','executing','unknown') AND tool_name NOT IN ('tool.search','memory.search','memory.read','connector.list','connector.tools','device.inventory','device.info','device.list','device.read','skill.list','skill.read') LIMIT 1`,...tree);
    if(unsafe) throw new Error('本任务含已执行或结果未知的操作，请核对效果后发送新的要求');
    return this.send(botId,String(task.objective),text(clientId,200),sessionId,{conversationId,...(this.store.get('SELECT selection_json FROM task_model_selections WHERE task_id=?',taskId)?{modelSelection:JSON.parse(String(this.store.get('SELECT selection_json FROM task_model_selections WHERE task_id=?',taskId)!.selection_json))}:{})});
  }
  editTopic(botId: string, conversationId: string, messageId: string, content: string, clientId: string, sessionId=this.store.session) {
    this.topic(botId,conversationId); content=text(content);clientId=text(clientId,200);
    const digest=hash(canonical({conversationId,messageId,content}));
    return this.store.transaction(()=>{
      const edit=this.store.get('SELECT * FROM agent_topic_edits WHERE bot_id=? AND client_id=?',botId,clientId);
      if(edit) { if(edit.request_hash!==digest) throw new Error('编辑请求标识已用于不同内容'); const replay=this.store.get('SELECT model_selection_json FROM agent_topic_inputs WHERE bot_id=? AND client_id=?',botId,clientId);return this.send(botId,content,clientId,sessionId,{conversationId,...(replay?.model_selection_json?{modelSelection:JSON.parse(String(replay.model_selection_json))}:{})}); }
      const pending=this.store.get("SELECT * FROM agent_topic_inputs WHERE bot_id=? AND conversation_id=? AND message_id=? AND status='pending' AND task_id IS NULL",botId,conversationId,messageId);
      if(!pending) throw new Error('只能编辑尚未开始的排队消息，执行后的操作须先核对');
      this.store.run("UPDATE agent_topic_inputs SET status='cancelled' WHERE position=?",pending.position);
      this.store.run("UPDATE agent_messages SET content='[已替换]' WHERE id=?",messageId);
      const result=this.send(botId,content,clientId,sessionId,{conversationId,...(pending.model_selection_json?{modelSelection:JSON.parse(String(pending.model_selection_json))}:{})});
      this.store.insert('agent_topic_edits',{bot_id:botId,client_id:clientId,request_hash:digest});
      return result;
    });
  }
  cancelMessage(botId:string,conversationId:string,messageId:string){
    this.topic(botId,conversationId);
    const input=this.store.get('SELECT * FROM agent_topic_inputs WHERE bot_id=? AND conversation_id=? AND message_id=?',botId,conversationId,messageId);
    if(!input)throw new Error('话题输入不存在');
    if(input.status==='pending')this.store.run("UPDATE agent_topic_inputs SET status='cancelled' WHERE position=?",input.position);
    if(input.task_id){
      const tree=this.store.all(`WITH RECURSIVE work(id) AS (SELECT ? UNION SELECT a.child_task_id FROM a2a_messages a JOIN work w ON a.parent_task_id=w.id UNION SELECT t.id FROM tasks t JOIN agent_jobs j ON t.conversation_id=j.conversation_id JOIN work w ON j.origin_task_id=w.id) SELECT id FROM work`,input.task_id);
      for(const task of tree)if(this.store.get('SELECT id FROM tasks WHERE id=? AND ended_at IS NULL',task.id))this.runtime.cancel(String(task.id),'用户停止了这条消息的任务');
      this.store.run('UPDATE agent_jobs SET stopped_at=? WHERE origin_task_id=? AND stopped_at IS NULL',now(),input.task_id);
    }
    this.runtime.changed();return {stopped:true,messageId};
  }
  cancelTopic(botId: string, conversationId: string) {
    this.topic(botId,conversationId);
    this.store.run("UPDATE agent_topic_inputs SET status='cancelled' WHERE conversation_id=? AND status='pending'",conversationId);
    for(const task of this.store.all('SELECT id FROM tasks WHERE (conversation_id=? OR conversation_id IN (SELECT conversation_id FROM agent_topic_children WHERE root_conversation_id=?)) AND ended_at IS NULL',conversationId,conversationId)) this.runtime.cancel(String(task.id),'用户停止了本话题');
    this.store.run('UPDATE agent_jobs SET stopped_at=? WHERE conversation_id IN (SELECT conversation_id FROM agent_topic_children WHERE root_conversation_id=?) AND stopped_at IS NULL',now(),conversationId);
    this.runtime.changed(); return {stopped:true};
  }
  /** The user starts a new topic: the assistant's next input opens a new episode (the previous one is archived and folded). */
  newTopic(botId: string) {
    this.ensure(botId);
    const bound = this.store.get("SELECT a.conversation_id FROM assistant_conversations a JOIN conversations c ON c.id=a.conversation_id WHERE a.bot_id=? AND c.status='open'", botId);
    // A message sent while the conversation is working steers that task; it cannot open an episode.
    if (bound && this.store.get("SELECT id FROM tasks WHERE conversation_id=? AND ended_at IS NULL", bound.conversation_id)) throw new Error("请等待当前任务结束后再开启新话题");
    const marked = !!bound && this.runtime.episodes.markTopic(String(bound.conversation_id));
    this.runtime.changed();
    return { marked };
  }
  tool(call: Row, args: Record<string, unknown>) {
    const action = text(args.action, 40);
    const prior = this.store.get("SELECT details_json FROM audit_records WHERE action=? AND entity_id=?", `steward.${action}`, String(call.id));
    if (prior) return JSON.parse(String(prior.details_json)).result;
    if (action === "agent.create") {
      const name = text(args.name, 80), instructions = optionalText(args.instructions, 8000);
      const expertise = Array.isArray(args.expertise) ? [...new Set(args.expertise.map((item) => text(item, 80)))] : [];
      return this.store.transaction(() => {
        const botId = this.store.createBot(name, instructions);
        // A new Agent never receives more capabilities than the Agent that created it.
        const creator = this.store.get("SELECT * FROM bot_policies WHERE bot_id=?", String(call.bot_id));
        const granted = creator ? policyTools(creator) : [];
        const inheritDefaults = creator && JSON.parse(String(creator.policy_json)).inheritDefaults === true;
        this.store.run("UPDATE bot_policies SET policy_json=? WHERE bot_id=?", JSON.stringify({ tools: actions.filter((tool) => granted.includes(tool)), ...(inheritDefaults ? { inheritDefaults: true } : {}) }), botId);
        this.ensure(botId);
        if (expertise.length) this.store.run("UPDATE bot_public_profiles SET expertise_json=? WHERE bot_id=?", JSON.stringify(expertise), botId);
        const result = { created: true, botId, name, instructions, expertise };
        this.store.audit("steward.agent.create", "tool_call", String(call.id), { byBotId: call.bot_id, botId, result });
        this.publish(String(call.bot_id), "system", "activity", `已招募新同伴：${name}`, `steward-create:${call.id}`, call.task_id);
        return result;
      });
    }
    if (action === "agent.update") {
      const targetId = text(args.botId, 100);
      return this.store.transaction(() => {
        this.ensure(targetId);
        const current = this.store.get("SELECT * FROM bots WHERE id=? AND status='active'", targetId);
        if (!current) throw new Error("目标 Agent 不存在或已停用");
        if (args.expectedVersion !== undefined && Number(args.expectedVersion) !== Number(current.version)) throw new Error("Agent 资料已变化，请刷新后重试");
        const nextName = args.name !== undefined ? text(args.name, 80) : String(current.name);
        const nextInstructions = args.instructions !== undefined ? optionalText(args.instructions, 8000) : String(current.instructions ?? "");
        const expertise = Array.isArray(args.expertise) ? [...new Set(args.expertise.map((item) => text(item, 80)))] : undefined;
        this.store.run("UPDATE bots SET name=?,instructions=?,version=version+1 WHERE id=?", nextName, nextInstructions, targetId);
        if (expertise !== undefined) this.store.run("UPDATE bot_public_profiles SET expertise_json=? WHERE bot_id=?", JSON.stringify(expertise), targetId);
        const result = { updated: true, botId: targetId, name: nextName, instructions: nextInstructions, version: Number(current.version) + 1, ...(expertise !== undefined ? { expertise } : {}) };
        this.store.audit("steward.agent.update", "tool_call", String(call.id), { byBotId: call.bot_id, botId: targetId, result });
        this.publish(String(call.bot_id), "system", "activity", `已更新同伴资料：${nextName}`, `steward-update:${call.id}`, call.task_id);
        return result;
      });
    }
    throw new Error("不支持的同伴管理操作");
  }
  startRoutine(botId: string, prompt: string, name: string, source: string) {
    return this.store.transaction(() => {
      this.ensure(botId);
      const previous = this.store.get("SELECT task_id FROM agent_task_links WHERE source_key=?", source);
      if (previous) return String(previous.task_id);
      const conversation = this.store.createConversation(botId, `例行任务：${name}`);
      const taskId = this.store.accept(conversation, `按用户配置的例行任务执行：${name}\n${prompt}`, source);
      // accept derives a title from the input; preserve the full source name for
      // reports even when the routine is renamed or removed before completion.
      this.store.run("UPDATE conversations SET title=? WHERE id=?", `例行任务：${name}`, conversation);
      this.store.insert("agent_task_links", { task_id: taskId, bot_id: botId, origin: "routine", source_key: source });
      return taskId;
    });
  }
  private isBackground(taskId: string) {
    return !!this.store.get("SELECT task_id FROM agent_task_links WHERE task_id=? AND origin IN ('routine','job')", this.runtime.taskRoot(taskId));
  }
  /** Stops every unfinished piece of an assistant's work: its background jobs (marked stopped) and then the rest. */
  stopAll(botId: string, reason = "用户停止了全部工作") {
    this.ensure(botId);
    this.store.run("UPDATE agent_topic_inputs SET status='cancelled' WHERE bot_id=? AND status='pending'",botId);
    // Finished jobs keep their outcome; only open ones (running, waiting for an answer, blocked...) are stopped.
    for (const job of this.jobs?.openFor(botId) ?? []) this.jobs?.stop(job.id, reason);
    for (const task of this.store.all("SELECT id FROM tasks WHERE bot_id=? AND ended_at IS NULL ORDER BY created_at", botId)) this.runtime.cancel(String(task.id), reason);
    this.runtime.changed();
    return { stopped: true };
  }
  /** Durable, idempotent delivery. The scheduler also calls this after recovery. */
  reportRoutine(taskId: string) {
    return this.store.transaction(() => {
      const task = this.store.get("SELECT t.*,c.title FROM tasks t JOIN agent_task_links l ON l.task_id=t.id JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND l.origin='routine' AND t.ended_at IS NOT NULL", taskId);
      if (!task || this.store.get("SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?", taskId)) return;
      // Upgrades already delivered old terminal answers/errors directly. Do not
      // replay the complete historical backlog under the new report key.
      if (this.store.get("SELECT id FROM agent_messages WHERE task_id=? AND (source_key LIKE 'answer:%' OR source_key LIKE 'error:%')", taskId)) return;
      const occurrence = this.store.get("SELECT name,status,reason FROM routine_occurrences WHERE task_id=?", taskId);
      if (occurrence?.status === "skipped") return;
      const name = String(occurrence?.name || String(task.title).replace(/^例行任务：/, "")).split("\n")[0];
      const result = String(task.result_summary ?? "").trim() || (task.status === "succeeded" ? "已完成" : task.status === "cancelled" ? "已停止" : "执行失败");
      const source = `routine-report:${taskId}`;
      const images = task.status === "succeeded" ? this.reportImages(taskId, result) : [];
      const content = [`定时任务「${name}」\n${result}`, ...images].join("\n\n");
      return this.publishReport(String(task.bot_id), task.status === "succeeded" ? "assistant" : "system", task.status === "succeeded" ? "result" : "error", content, source, taskId);
    });
  }
  /**
   * Generated files of a background run (routine or job round) are results too: they are delivered only with its
   * report. Returns the run's image messages whose attachment the report text does not already show.
   */
  reportImages(taskId: string, text: string): string[] {
    return this.store.all("SELECT content FROM transcript WHERE task_id=? AND source_key LIKE 'image:%' ORDER BY created_at,rowid", taskId).map((row) => String(row.content))
      .filter((content) => ![...content.matchAll(/\/api\/attachments\/([\w-]+)/g)].some((match) => text.includes(match[0])));
  }
  /** Publishes a background run's report once and binds the attachments it shows to it, so attachment authorization works. Returns the message id. */
  publishReport(botId: string, role: string, kind: string, content: string, source: string, taskId: string): string | undefined {
    return this.store.transaction(() => {
      this.publish(botId, role, kind, content, source, taskId);
      const message = this.store.get("SELECT id,content FROM agent_messages WHERE source_key=?", source);
      if (message) for (const match of String(message.content).matchAll(/\/api\/attachments\/([\w-]+)/g)) this.store.run("UPDATE chat_attachments SET message_id=? WHERE id=? AND bot_id=? AND message_id IS NULL", message.id, match[1], botId);
      return message ? String(message.id) : undefined;
    });
  }
  journal(task: Row) {
    this.store.run("INSERT INTO agent_journal VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING", task.id, task.bot_id, String(task.objective).slice(0, 1200), String(task.result_summary ?? "").slice(0, 3000), task.ended_at ?? now());
  }
  delegation(link: Row, completed: boolean) {
    const sender = String(link.sender_bot_id), receiver = String(link.receiver_bot_id);
    const name = String(this.store.get("SELECT name FROM bots WHERE id=?", receiver)?.name ?? "Agent");
    if (!completed) {
      this.publish(sender, "system", "request", `已联系 ${name}：${link.payload}`, `a2a-sent:${link.id}`, link.parent_task_id, receiver, Number(link.created_at));
      this.publish(receiver, "peer", "request", String(link.payload), `a2a-received:${link.id}`, link.child_task_id, sender, Number(link.created_at));
    } else {
      const result = link.result ? JSON.parse(String(link.result)).result : "任务已取消";
      this.publish(sender, "peer", "result", String(result ?? "任务已结束"), `a2a-returned:${link.id}`, link.parent_task_id, receiver, Number(link.finished_at));
      this.publish(receiver, link.status === "succeeded" ? "assistant" : "system", link.status === "succeeded" ? "result" : "error", String(result ?? "任务已结束"), `a2a-replied:${link.id}`, link.child_task_id, null, Number(link.finished_at));
    }
  }
  context(botId: string, taskId: string) {
    const conversation = this.store.get('SELECT conversation_id FROM tasks WHERE id=?',taskId)?.conversation_id;
    if(this.store.get('SELECT conversation_id FROM agent_topics WHERE conversation_id=?',conversation??null)) return JSON.stringify({conversationId:conversation,workingNote:this.store.get('SELECT content,version FROM conversation_working_notes WHERE conversation_id=?',conversation??null)??null});
    const checkpoint = this.store.get('SELECT id,summary FROM context_checkpoints WHERE bot_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 1',botId,conversation ?? null);
    // Full recent turns live in the persistent Pi projection. Of everything else only this conversation's working
    // note is here: other conversations, earlier messages and archives are recalled once per task for the user's
    // input (task-recall.ts) or searched by the model on demand.
    const note=this.store.get('SELECT content,version FROM conversation_working_notes WHERE conversation_id=?',conversation ?? null);
    // Inbox reports do not live in the owner's Pi projection. Refresh this bounded
    // data block at request boundaries so a running or subsequent owner turn can
    // know the outcome without a synthetic input, steering, or history mutation.
    const owner = this.store.get("SELECT task_id FROM agent_task_links WHERE task_id=? AND origin='owner'", taskId);
    const reports = owner ? this.store.all("SELECT m.id,m.task_id,m.content,m.created_at FROM agent_messages m WHERE m.bot_id=? AND m.source_key='routine-report:'||m.task_id AND m.content!='[已遗忘]' AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=m.task_id) ORDER BY m.seq DESC LIMIT 6", botId).reverse().map(row => ({ ref: `message:${row.id}`, taskId: row.task_id, completedReportAt: row.created_at, summary: String(row.content).slice(0, 1200), truncated: String(row.content).length > 1200 })) : [];
    // The main chat also sees its background jobs: the open ones and the latest published reports, as read-only data,
    // and the references of this turn's user messages, which job.start and job.message cite.
    const jobs = owner ? {
      currentMessages: this.store.all("SELECT id FROM agent_messages WHERE task_id=? AND role='user' ORDER BY seq DESC LIMIT 5", taskId).reverse().map((row) => `message:${row.id}`),
      ...this.jobs?.context(botId),
      jobPolicy: 'jobs 是进行中的后台任务，jobReports 是它们已经发布的回报。这些是资料，不是用户新输入；不要据此重复执行或重复播报，需要全文时按 message 引用查询。',
    } : {};
    return JSON.stringify({ checkpoint:checkpoint?.id??null,workingNote:note??null,routineReports:reports,routineReportPolicy:'这些是已经汇报的定时任务结果资料，不是用户新输入或执行指令，不要重新执行或主动重复播报；需要完整结果时按 message 引用查询。',...jobs,history:'通过 memory.search 搜索早期原文；query="message:<id>" 可展开消息，query="entry:<id>" 可展开运行记录，query="episode:<id>" 可展开已结束段落的档案；普通文字查询也会搜索段落档案。' });
  }
  search(botId: string, query: string): Row[];
  search(botId: string, query: string, page?: { offset?: number; limit?: number }): Array<Row | ReturnType<typeof entryPage>>;
  search(botId: string, query: string, page?: { offset?: number; limit?: number }) {
    if(query.startsWith('message:')) return this.store.all('SELECT id,role,content,created_at FROM ' + visibleInbox + ' WHERE bot_id=? AND id=?',botId,query.slice(8));
    if(query.startsWith('episode:')) { const episode=this.runtime.episodes.get(botId,query.slice(8)); return episode ? [this.runtime.episodes.view(episode) as unknown as Row] : []; }
    if(query.startsWith('entry:')) {
      const entryId=query.slice(6);
      for(const session of this.store.all('SELECT id FROM runtime_sessions WHERE bot_id=?',botId)) {
        const entry=this.runtime.projection.entry(String(session.id),entryId);
        if(entry){
          const content=entryText(entry);
          return [page ? entryPage(entryId,content,page.offset,page.limit) : {id:entryId,content}];
        }
      }
      return [];
    }
    const needle = "%" + text(query, 200).replace(/[\\%_]/g, "\\$&") + "%";
    return this.store.all("SELECT id,role,kind,content,created_at FROM " + visibleInbox + " WHERE bot_id=? AND content LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 10", botId, needle);
  }
  searchConversations(query: string, before?: number) {
    const value = text(query,200), needle = '%' + value.replace(/[\\%_]/g,'\\$&') + '%';
    if (before!==undefined && (!Number.isSafeInteger(before)||before<=0)) throw new Error('搜索位置无效');
    const rows = this.store.all("SELECT m.rowid position,m.id,m.bot_id,m.seq,m.content,m.created_at,b.name bot_name FROM " + visibleInbox + " m JOIN bots b ON b.id=m.bot_id WHERE b.workspace_id=? AND b.owner_user_id=? AND b.status='active' AND m.rowid<? AND m.content<>'[已遗忘]' AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=m.task_id) AND m.content LIKE ? ESCAPE '\\' ORDER BY m.rowid DESC LIMIT 51",this.store.workspace,this.store.owner,before??Number.MAX_SAFE_INTEGER,needle);
    const page=rows.slice(0,50);
    return { results:page.map(row=>{
      const content=String(row.content),index=content.toLowerCase().indexOf(value.toLowerCase()),start=Math.max(0,index-45);
      return {id:row.id,botId:row.bot_id,botName:row.bot_name,createdAt:row.created_at,snippet:(start?'…':'')+content.slice(start,start+180)+(content.length>start+180?'…':'')};
    }), nextBefore:rows.length>50?Number(page.at(-1)!.position):null };
  }
  messagesAround(botId: string, messageId: string) {
    this.ensure(botId);
    const target=this.store.get("SELECT seq FROM " + visibleInbox + " m WHERE bot_id=? AND id=? AND content<>'[已遗忘]' AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=m.task_id)",botId,messageId);
    if (!target) throw new Error('该消息已不存在或已遗忘');
    const before=this.store.all('SELECT * FROM (SELECT * FROM ' + visibleInbox + ' WHERE bot_id=? AND seq<? ORDER BY seq DESC LIMIT 40) ORDER BY seq',botId,target.seq);
    const after=this.store.all('SELECT * FROM ' + visibleInbox + ' WHERE bot_id=? AND seq>=? ORDER BY seq LIMIT 60',botId,target.seq);
    return this.projectMessages([...before,...after]);
  }
  read(botId: string, seq: number, conversationId?: string) {
    this.ensure(botId);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("读取位置无效");
    if(conversationId) { this.topic(botId,conversationId); this.store.run('UPDATE agent_topics SET read_seq=MAX(read_seq,MIN(?,COALESCE((SELECT MAX(seq) FROM agent_messages WHERE conversation_id=?),0))) WHERE conversation_id=?',seq,conversationId,conversationId); return; }
    this.store.run("UPDATE agent_inboxes SET read_seq=MAX(read_seq,MIN(?,next_seq-1)) WHERE bot_id=?", seq, botId);
  }
  messages(botId: string, before?: number) {
    this.ensure(botId);
    return this.projectMessages(this.store.all("SELECT * FROM (SELECT * FROM " + visibleInbox + " WHERE bot_id=? AND seq<? ORDER BY seq DESC LIMIT 100) ORDER BY seq", botId, before ?? Number.MAX_SAFE_INTEGER));
  }
  messagesAfter(botId: string, after: number) {
    this.ensure(botId);
    return this.projectMessages(this.store.all("SELECT * FROM " + visibleInbox + " WHERE bot_id=? AND seq>? ORDER BY seq LIMIT 200", botId, after));
  }
  private projectMessages(messages: Row[]) {
    return messages.map((message) => {
      let projected: Record<string, unknown> = message;
      const source = /^a2a-(sent|received|returned|replied):(.+)$/.exec(String(message.source_key));
      if (source) {
        const link = this.store.get("SELECT * FROM a2a_messages WHERE id=?", source[2]);
        if (link) {
          const direction = source[1], outgoing = direction === "sent" || direction === "returned";
          if (message.bot_id === (outgoing ? link.sender_bot_id : link.receiver_bot_id)) {
            // Read projection also presents 0.3.0/0.3.1 system reply records as the
            // receiver's own reply. Keep persisted IDs, sequence and original facts.
            projected = { ...message, a2a_direction: direction, a2a_peer_id: outgoing ? link.receiver_bot_id : link.sender_bot_id,
              ...(direction === "replied" ? { role: link.status === "succeeded" ? "assistant" : "system", kind: link.status === "succeeded" ? "result" : "error", sender_bot_id: null, content: link.result ? String(JSON.parse(String(link.result)).result ?? "任务已结束") : "任务已取消" } : {}) };
          }
        }
      }
      const job = /^job-(start|report|input):(.+)$/.exec(String(message.source_key));
      if (job) {
        const report = job[1] === "report" ? this.store.get("SELECT job_id,state FROM agent_job_reports WHERE id=?", job[2]) : undefined;
        const jobId = job[1] === "start" ? job[2] : job[1] === "report" ? report?.job_id : this.store.get("SELECT j.id FROM agent_jobs j JOIN tasks t ON t.conversation_id=j.conversation_id WHERE t.id=?", String(message.task_id ?? ""))?.id;
        const row = jobId ? this.store.get("SELECT title FROM agent_jobs WHERE id=?", String(jobId)) : undefined;
        if (row) projected = { ...projected, job_id: jobId, job_title: row.title, ...(job[1] === "report" ? { job_state: report!.state } : {}) };
      }
      if (projected.role === "assistant" && projected.kind === "message" && !String(projected.source_key).startsWith("image:") && projected.task_id && projected.content !== "[已遗忘]" && !this.store.get("SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?", String(projected.task_id))) {
        const calls = this.store.all("SELECT id,tool_name,target_id,arguments_json,result_json,status,created_at FROM tool_calls WHERE task_id=? ORDER BY created_at,rowid", String(projected.task_id));
        if (calls.length) {
          projected = {
            ...projected,
            tool_steps: calls.map((c) => {
              let summary = String(c.target_id ?? "");
              try {
                const a = JSON.parse(String(c.arguments_json || "{}")) as Record<string, unknown>;
                if (c.tool_name === "memory.write" || c.tool_name === "memory.search" || c.tool_name === "memory.reflect") summary = String(a.title || a.query || summary).slice(0, 80);
                else if (c.tool_name === "memory.core.update") summary = "核心记忆";
                else if (c.tool_name === "memory.topic") summary = `主题${String(a.op ?? "")}`.slice(0, 40);
                else if (c.tool_name === "device.read" || c.tool_name === "device.list") summary = String(a.path || ".").slice(0, 120);
                else if (c.tool_name === "device.exec") summary = String(a.command || "").slice(0, 80);
                else if (c.tool_name === "device.computer") summary = String(a.operation || "").slice(0, 60);
                else if (c.tool_name === "agent.delegate" || c.tool_name === "agent.update") {
                  const peerName = this.store.get("SELECT name FROM bots WHERE id=?", String(a.botId || c.target_id))?.name;
                  summary = peerName ? `${peerName}${a.message ? ` · ${String(a.message).slice(0, 40)}` : ""}` : String(a.botId || summary);
                } else if (c.tool_name === "agent.create") summary = String(a.name || "");
                else if (String(c.tool_name).startsWith("routine.")) summary = String(a.name || a.routineId || "");
                else if (c.tool_name === "skill.read") summary = String(a.skillId || "");
              } catch { /* ignore */ }
              let preview = "";
              if (c.result_json) {
                try {
                  const parsed = JSON.parse(String(c.result_json));
                  const { images: _images, ...rest } = (parsed && typeof parsed === "object" ? parsed : { value: parsed }) as Record<string, unknown>;
                  preview = JSON.stringify(rest, null, 2).slice(0, 1600);
                } catch { preview = String(c.result_json).slice(0, 1600); }
              }
              return { id: String(c.id), tool_name: String(c.tool_name), status: String(c.status), summary, preview, created_at: Number(c.created_at) };
            }),
          };
        }
      }
      return projected as Row;
    });
  }
  contacts() {
    return this.store.all("SELECT b.id,b.name,b.instructions,b.version,i.read_seq,a.appearance_json,COALESCE(a.version,0) appearance_version,(SELECT COUNT(*) FROM " + visibleInbox + " m WHERE m.bot_id=b.id AND m.seq>i.read_seq AND m.role!='user' AND m.source_key NOT LIKE 'stock-history:%') unread_count,(SELECT content FROM " + visibleInbox + " WHERE bot_id=b.id ORDER BY seq DESC LIMIT 1) last_message,(SELECT created_at FROM " + visibleInbox + " WHERE bot_id=b.id ORDER BY seq DESC LIMIT 1) last_message_at FROM bots b JOIN agent_inboxes i ON i.bot_id=b.id LEFT JOIN bot_appearance a ON a.bot_id=b.id WHERE b.status='active' ORDER BY b.created_at");
  }
}
