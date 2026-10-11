import { CoreStore, hash, id, now, optionalText, text, type Row } from "./store.ts";
import type { TaskRuntime } from "./runtime.ts";
import { actions } from "./policy.ts";

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
      if (store.get("SELECT task_id FROM agent_task_links WHERE task_id=?", task.id)) this.publish(String(task.bot_id), role, role === "system" ? "error" : "message", content, source, task.id);
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
  updatePolicy(data: Record<string, unknown>) {
    const botId = text(data.id, 100), version = Number(data.version);
    const tools = data.tools;
    if (!Array.isArray(tools) || tools.some((tool) => !actions.includes(tool))) throw new Error("工具清单无效");
    this.store.transaction(() => {
      this.ensure(botId);
      if (!Number.isSafeInteger(version) || version < 1 || this.store.run("UPDATE bot_policies SET policy_json=?,approval_mode='allow_scoped',version=version+1 WHERE bot_id=? AND version=?", JSON.stringify({ tools: [...new Set(tools)] }), botId, version).changes !== 1) throw new Error("权限已变化，请刷新");
      this.store.audit("agent.policy.update", "bot", botId, { version: version + 1, tools: data.tools });
    });
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
    return this.store.get("SELECT t.* FROM tasks t JOIN agent_task_links l ON l.task_id=t.id WHERE l.bot_id=? AND t.ended_at IS NULL ORDER BY t.created_at LIMIT 1", botId);
  }
  send(botId: string, content: string, clientId: string) {
    content = text(content); clientId = text(clientId, 200);
    const digest = hash(content);
    const accepted = this.store.transaction(() => {
      this.ensure(botId);
      const receipt = this.store.get("SELECT * FROM agent_input_receipts WHERE bot_id=? AND client_message_id=?", botId, clientId);
      if (receipt) { if (receipt.request_hash !== digest) throw new Error("同一消息 ID 的内容不同"); return { taskId: String(receipt.task_id), conversationId: String(receipt.conversation_id), replay: true }; }
      const active = this.active(botId), conversationId = active ? String(active.conversation_id) : this.store.createConversation(botId, "Agent 工作上下文");
      const taskId = this.store.accept(conversationId, content, clientId);
      this.store.run("INSERT OR IGNORE INTO agent_task_links VALUES(?,?,?,?)", taskId, botId, "owner", `owner-task:${taskId}`);
      this.store.insert("agent_input_receipts", { bot_id: botId, client_message_id: clientId, request_hash: digest, task_id: taskId, conversation_id: conversationId });
      this.store.run("UPDATE agent_inboxes SET active_task_id=? WHERE bot_id=?", taskId, botId);
      this.publish(botId, "user", "message", content, `agent-input:${botId}:${clientId}`, taskId);
      return { taskId, conversationId, replay: false };
    });
    if (!accepted.replay) this.runtime.input(accepted.conversationId, content, clientId);
    this.runtime.changed(); return { taskId: accepted.taskId };
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
    const history = this.store.all("SELECT role,kind,content FROM agent_messages WHERE bot_id=? AND (task_id IS NULL OR task_id!=?) ORDER BY seq DESC LIMIT 12", botId, taskId).reverse();
    const journal = this.store.all("SELECT objective,result FROM agent_journal WHERE bot_id=? AND task_id!=? ORDER BY created_at DESC LIMIT 3", botId, taskId);
    return JSON.stringify({ recentMessages: history.map((m) => ({ ...m, content: String(m.content).slice(0, 800) })), completedWork: journal.map((j) => ({ objective: String(j.objective).slice(0, 300), result: String(j.result).slice(0, 1500) })) });
  }
  search(botId: string, query: string) {
    const needle = "%" + text(query, 200).replace(/[\\%_]/g, "\\$&") + "%";
    return this.store.all("SELECT role,kind,substr(content,1,4000) content,created_at FROM agent_messages WHERE bot_id=? AND content LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 10", botId, needle);
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
      const source = /^a2a-(sent|received|returned|replied):(.+)$/.exec(String(message.source_key));
      if (!source) return message;
      const link = this.store.get("SELECT * FROM a2a_messages WHERE id=?", source[2]);
      if (!link) return message;
      const direction = source[1], outgoing = direction === "sent" || direction === "returned";
      if (message.bot_id !== (outgoing ? link.sender_bot_id : link.receiver_bot_id)) return message;
      // Read projection also presents 0.3.0/0.3.1 system reply records as the
      // receiver's own reply. Keep persisted IDs, sequence and original facts.
      return { ...message, a2a_direction: direction, a2a_peer_id: outgoing ? link.receiver_bot_id : link.sender_bot_id,
        ...(direction === "replied" ? { role: link.status === "succeeded" ? "assistant" : "system", kind: link.status === "succeeded" ? "result" : "error", sender_bot_id: null, content: link.result ? String(JSON.parse(String(link.result)).result ?? "任务已结束") : "任务已取消" } : {}) };
    });
  }
  contacts() {
    return this.store.all("SELECT b.id,b.name,b.instructions,b.version,i.read_seq,(SELECT COUNT(*) FROM agent_messages m WHERE m.bot_id=b.id AND m.seq>i.read_seq AND m.role!='user') unread_count,(SELECT content FROM agent_messages WHERE bot_id=b.id ORDER BY seq DESC LIMIT 1) last_message,(SELECT created_at FROM agent_messages WHERE bot_id=b.id ORDER BY seq DESC LIMIT 1) last_message_at FROM bots b JOIN agent_inboxes i ON i.bot_id=b.id WHERE b.status='active' ORDER BY b.created_at");
  }
}
