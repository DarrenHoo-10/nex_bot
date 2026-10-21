import { CoreStore, hash, id, now, optionalText, text, type Row } from "./store.ts";
import type { TaskRuntime } from "./runtime.ts";
import { actions, policyTools } from "./policy.ts";
import { universalImageActions } from '../../shared/personal-capabilities.ts';
import { parseAppearance } from "../../shared/personal-appearance.ts";
import { tokens } from './token-estimate.ts';
import { relevance } from './assistant-memory.ts';

// The contact and its inbox survive any number of execution contexts. Pi
// sessions belong to work, and never define the identity visible to the owner.
export class AgentModule {
  onPublished?: (botId: string) => void;
  constructor(readonly store: CoreStore, readonly runtime: TaskRuntime) {
    store.transaction(() => {
      for (const bot of store.all("SELECT id FROM bots")) this.ensure(String(bot.id));
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
    runtime.onResult = (task, role, content, source) => {
      if (source.startsWith("image:") || store.get("SELECT task_id FROM agent_task_links WHERE task_id=?", task.id)) this.publish(String(task.bot_id), role, role === "system" ? "error" : "message", content, source, task.id);
    };
    runtime.onSettled = (taskId) => {
      const task = store.get("SELECT * FROM tasks WHERE id=?", taskId);
      if (task?.ended_at !== null && task?.status === "succeeded") this.journal(task);
      store.run("UPDATE agent_inboxes SET active_task_id=NULL WHERE active_task_id=?", taskId);
    };
    runtime.onDelegation = (link, completed) => this.delegation(link, completed);
    runtime.agentHistory = (botId, taskId) => this.context(botId, taskId);
    runtime.historySearch = (botId, query) => this.search(botId, query);
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
      const config = this.store.config();
      if (!config) throw new Error("请先配置模型连接");
      if (data.provider !== config.provider_id || data.endpoint !== config.endpoint) throw new Error("模型连接已变化，请重新选择");
      if (data.version !== (this.store.botModelSelection(botId)?.model_selection_version ?? 0)) throw new Error("模型已在其他设备更新，请重新选择");
      this.store.run("INSERT INTO agent_model_settings(bot_id,provider,endpoint,model,version) VALUES(?,?,?,?,1) ON CONFLICT(bot_id,provider,endpoint) DO UPDATE SET model=excluded.model,version=version+1", botId, config.provider_id, config.endpoint, model);
      this.store.modelConfig(botId);
      this.store.audit("agent.model.update", "bot", botId, { model });
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
    const tools = [...new Set([...data.tools, ...universalImageActions])];
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
      this.store.run("UPDATE agent_routines SET enabled=0,version=version+1 WHERE bot_id=?", botId);
      this.store.audit("agent.archive", "bot", botId, { version: version + 1 });
    });
    this.runtime.changed();
  }
  publish(botId: string, role: string, kind: string, content: string, source: string, taskId: Row[string] = null, sender: Row[string] = null, timestamp = now()) {
    return this.store.transaction(() => {
      this.ensure(botId);
      if (this.store.get("SELECT id FROM agent_messages WHERE source_key=?", source)) return;
      const inbox = this.store.get("SELECT next_seq FROM agent_inboxes WHERE bot_id=?", botId)!;
      const messageId = id();
      this.store.insert("agent_messages", { id: messageId, bot_id: botId, ...this.store.scope(), seq: inbox.next_seq, role, kind, sender_bot_id: sender, task_id: taskId, content, source_key: source, created_at: timestamp });
      this.runtime.memory.ledger.message(this.store.get("SELECT * FROM agent_messages WHERE id=?", messageId)!);
      this.store.run("UPDATE agent_inboxes SET next_seq=next_seq+1 WHERE bot_id=?", botId);
      if (role !== "user") queueMicrotask(() => { if (!this.runtime.closing && this.store.get("SELECT id FROM agent_messages WHERE source_key=?", source)) this.onPublished?.(botId); });
    });
  }
  active(botId: string) {
    // Include legacy work so a new entry point cannot bypass an older approval.
    // A routine task that has yielded/is cancelling does not block user input.
    return this.store.get("SELECT t.* FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE l.bot_id=? AND t.ended_at IS NULL AND NOT (l.origin='routine' AND t.status='cancelling') ORDER BY t.created_at LIMIT 1", botId);
  }
  send(botId: string, content: string, clientId: string, sessionId = this.store.session) {
    content = text(content); clientId = text(clientId, 200);
    const digest = hash(content);
    this.ensure(botId);
    const existingReceipt = this.store.get("SELECT * FROM agent_input_receipts WHERE bot_id=? AND client_message_id=?", botId, clientId);
    if (existingReceipt) {
      if (existingReceipt.request_hash !== digest) throw new Error("同一消息 ID 的内容不同");
      return { taskId: String(existingReceipt.task_id) };
    }
    // Priority delivery: direct user input preempts active background routine work
    // (unless the routine is awaiting unknown-effect reconciliation).
    const activeRoutine = this.store.get(
      "SELECT t.id FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE l.bot_id=? AND l.origin='routine' AND t.ended_at IS NULL AND t.status IN ('queued','running','paused') ORDER BY t.created_at LIMIT 1",
      botId,
    );
    if (activeRoutine) {
      this.runtime.cancel(String(activeRoutine.id), "例行任务已让路给用户新消息");
      this.store.run("UPDATE routine_occurrences SET status='cancelled' WHERE task_id=? AND status IN ('pending','running')", activeRoutine.id);
      this.store.run("UPDATE agent_inboxes SET active_task_id=NULL WHERE bot_id=? AND active_task_id=?", botId, activeRoutine.id);
      this.publish(botId, "system", "activity", "例行任务已让路给用户新消息", `routine-yield:${activeRoutine.id}`, activeRoutine.id);
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
    this.runtime.changed(); return { taskId: accepted.taskId };
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
        this.store.run("UPDATE bot_policies SET policy_json=? WHERE bot_id=?", JSON.stringify({ tools: actions.filter((tool) => granted.includes(tool)) }), botId);
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
      if (this.active(botId)) return;
      const conversation = this.store.createConversation(botId, `例行任务：${name}`);
      const taskId = this.store.accept(conversation, `按用户配置的例行任务执行：${name}\n${prompt}`, source);
      this.store.insert("agent_task_links", { task_id: taskId, bot_id: botId, origin: "routine", source_key: source });
      this.store.run("UPDATE agent_inboxes SET active_task_id=? WHERE bot_id=?", taskId, botId);
      this.publish(botId, "system", "activity", `开始例行任务：${name}`, `routine-start:${source}`, taskId);
      return taskId;
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
    const checkpoint = this.store.get('SELECT id,summary FROM context_checkpoints WHERE bot_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 1',botId,conversation ?? null);
    // Full recent turns live in the persistent Pi projection. Only other work
    // needs an index here; never duplicate or mechanically clip current turns.
    const history = this.store.all("SELECT m.id,m.role,m.content FROM agent_messages m LEFT JOIN tasks t ON t.id=m.task_id WHERE m.bot_id=? AND (t.conversation_id IS NULL OR t.conversation_id!=?) ORDER BY m.seq DESC",botId,conversation ?? null);
    let remaining=2000; const recent: Row[]=[];
    for(const row of history){ const size=tokens(row);if(size>remaining)continue;recent.unshift(row);remaining-=size; }
    const query=String(this.store.get("SELECT content FROM agent_messages WHERE bot_id=? AND role='user' ORDER BY seq DESC LIMIT 1",botId)?.content??'');
    const references=query.match(/(?:message|entry):[a-zA-Z0-9-]+/g)??[];
    const recalled:Row[]=[];let budget=2500;
    const matches=references.flatMap(ref=>this.search(botId,ref));
    if(/之前|上次|此前|以前|原来|早先|previous|earlier/i.test(query))matches.push(...this.store.all("SELECT id,content,role FROM agent_messages WHERE bot_id=? AND task_id IS NOT ? AND content!='[已遗忘]'",botId,taskId).map(row=>({...row,score:relevance(query,String(row.content))})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score));
    for(const row of matches){const size=tokens(row);if(size>budget||recalled.some(prior=>prior.id===row.id))continue;recalled.push(row);budget-=size;}
    const note=this.store.get('SELECT content,version FROM assistant_working_notes WHERE bot_id=?',botId);
    return JSON.stringify({ checkpoint:checkpoint?.id??null,workingNote:note??null,otherRecentWork:recent,recalledHistory:recalled,history:'通过 memory.search 搜索早期原文；query="message:<id>" 可展开消息，query="entry:<id>" 可展开运行记录。' });
  }
  search(botId: string, query: string) {
    if(query.startsWith('message:')) return this.store.all('SELECT id,role,content,created_at FROM agent_messages WHERE bot_id=? AND id=?',botId,query.slice(8));
    if(query.startsWith('entry:')) {
      const entryId=query.slice(6);
      for(const session of this.store.all('SELECT id FROM runtime_sessions WHERE bot_id=?',botId)) {
        const entry=this.runtime.projection.load(String(session.id))?.find(entry=>entry.type!=='session'&&entry.id===entryId);
        if(entry)return [{id:entryId,content:JSON.stringify(entry)}];
      }
      return [];
    }
    const needle = "%" + text(query, 200).replace(/[\\%_]/g, "\\$&") + "%";
    return this.store.all("SELECT id,role,kind,content,created_at FROM agent_messages WHERE bot_id=? AND content LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 10", botId, needle);
  }
  searchConversations(query: string, before?: number) {
    const value = text(query,200), needle = '%' + value.replace(/[\\%_]/g,'\\$&') + '%';
    if (before!==undefined && (!Number.isSafeInteger(before)||before<=0)) throw new Error('搜索位置无效');
    const rows = this.store.all("SELECT m.rowid position,m.id,m.bot_id,m.seq,m.content,m.created_at,b.name bot_name FROM agent_messages m JOIN bots b ON b.id=m.bot_id WHERE b.workspace_id=? AND b.owner_user_id=? AND b.status='active' AND m.rowid<? AND m.content<>'[已遗忘]' AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=m.task_id) AND m.content LIKE ? ESCAPE '\\' ORDER BY m.rowid DESC LIMIT 51",this.store.workspace,this.store.owner,before??Number.MAX_SAFE_INTEGER,needle);
    const page=rows.slice(0,50);
    return { results:page.map(row=>{
      const content=String(row.content),index=content.toLowerCase().indexOf(value.toLowerCase()),start=Math.max(0,index-45);
      return {id:row.id,botId:row.bot_id,botName:row.bot_name,createdAt:row.created_at,snippet:(start?'…':'')+content.slice(start,start+180)+(content.length>start+180?'…':'')};
    }), nextBefore:rows.length>50?Number(page.at(-1)!.position):null };
  }
  messagesAround(botId: string, messageId: string) {
    this.ensure(botId);
    const target=this.store.get("SELECT seq FROM agent_messages m WHERE bot_id=? AND id=? AND content<>'[已遗忘]' AND NOT EXISTS(SELECT 1 FROM memory_forgotten_tasks f WHERE f.task_id=m.task_id)",botId,messageId);
    if (!target) throw new Error('该消息已不存在或已遗忘');
    const before=this.store.all('SELECT * FROM (SELECT * FROM agent_messages WHERE bot_id=? AND seq<? ORDER BY seq DESC LIMIT 40) ORDER BY seq',botId,target.seq);
    const after=this.store.all('SELECT * FROM agent_messages WHERE bot_id=? AND seq>=? ORDER BY seq LIMIT 60',botId,target.seq);
    return this.projectMessages([...before,...after]);
  }
  read(botId: string, seq: number) {
    this.ensure(botId);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("读取位置无效");
    this.store.run("UPDATE agent_inboxes SET read_seq=MAX(read_seq,MIN(?,next_seq-1)) WHERE bot_id=?", seq, botId);
  }
  messages(botId: string, before?: number) {
    this.ensure(botId);
    return this.projectMessages(this.store.all("SELECT * FROM (SELECT * FROM agent_messages WHERE bot_id=? AND seq<? ORDER BY seq DESC LIMIT 100) ORDER BY seq", botId, before ?? Number.MAX_SAFE_INTEGER));
  }
  messagesAfter(botId: string, after: number) {
    this.ensure(botId);
    return this.projectMessages(this.store.all("SELECT * FROM agent_messages WHERE bot_id=? AND seq>? ORDER BY seq LIMIT 200", botId, after));
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
    return this.store.all("SELECT b.id,b.name,b.instructions,b.version,i.read_seq,a.appearance_json,COALESCE(a.version,0) appearance_version,(SELECT COUNT(*) FROM agent_messages m WHERE m.bot_id=b.id AND m.seq>i.read_seq AND m.role!='user') unread_count,(SELECT content FROM agent_messages WHERE bot_id=b.id ORDER BY seq DESC LIMIT 1) last_message,(SELECT created_at FROM agent_messages WHERE bot_id=b.id ORDER BY seq DESC LIMIT 1) last_message_at FROM bots b JOIN agent_inboxes i ON i.bot_id=b.id LEFT JOIN bot_appearance a ON a.bot_id=b.id WHERE b.status='active' ORDER BY b.created_at");
  }
}
