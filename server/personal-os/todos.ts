import {
  CoreStore,
  canonical,
  hash,
  now,
  optionalText,
  text,
  type Row,
} from "./store.ts";
import type { AgentModule } from "./agents.ts";
import type {
  TodoItem,
  TodoStatus,
  TodoStep,
} from "../../shared/personal-todos.ts";

export class TodoConflict extends Error {
  status = 409;
}
export class TodoModule {
  constructor(
    readonly store: CoreStore,
    readonly agents: AgentModule,
  ) {}
  private row(todoId: string) {
    const row = this.store.get(
      "SELECT * FROM todos WHERE id=? AND workspace_id=? AND owner_user_id=? AND deleted_at IS NULL",
      todoId,
      this.store.workspace,
      this.store.owner,
    );
    if (!row) throw new Error("待办不存在或已删除");
    return row;
  }
  private checked(data: Record<string, unknown>) {
    const row = this.row(text(data.id, 100));
    if (!Number.isSafeInteger(data.version) || row.version !== data.version)
      throw new TodoConflict("待办已在其他设备更新，请刷新后重试");
    return row;
  }
  private event(todoId: string, label: string) {
    this.store.insert("todo_events", {
      todo_id: todoId,
      label,
      created_at: now(),
    });
  }
  private view(row: Row): TodoItem {
    const task = row.task_id
      ? this.store.get(
          "SELECT status,result_summary FROM tasks WHERE id=?",
          row.task_id,
        )
      : undefined;
    const forgotten =
      row.task_id &&
      this.store.get(
        "SELECT task_id FROM memory_forgotten_tasks WHERE task_id=?",
        row.task_id,
      );
    return {
      id: String(row.id),
      title: String(row.title),
      description: String(row.description),
      owner: row.bot_id ? String(row.bot_id) : "me",
      date: String(row.due_date),
      priority: String(row.priority),
      status: row.status as TodoStatus,
      version: Number(row.version),
      steps: JSON.parse(String(row.steps_json)) as TodoStep[],
      taskId: row.task_id ? String(row.task_id) : null,
      taskStatus: task ? String(task.status) : null,
      result: forgotten ? "" : String(task?.result_summary ?? ""),
      log: this.store
        .all(
          "SELECT label FROM todo_events WHERE todo_id=? ORDER BY id DESC LIMIT 50",
          row.id,
        )
        .map((e) => String(e.label)),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  list() {
    return this.store
      .all(
        "SELECT * FROM todos WHERE workspace_id=? AND owner_user_id=? AND deleted_at IS NULL ORDER BY created_at DESC",
        this.store.workspace,
        this.store.owner,
      )
      .map((row) => this.view(row));
  }
  get(todoId: string) {
    return this.view(this.row(todoId));
  }
  // Broker and the panel share the same records. Saving a note never starts work.
  tool(call: Row, args: Record<string, unknown>) {
    if (call.tool_name === "todo.list") return { items: this.list() };
    if (call.tool_name !== "todo.save") throw new Error("未知的待办能力");
    return this.store.transaction(() => {
      const receipt = this.store.get("SELECT * FROM todo_tool_receipts WHERE call_id=?", call.id);
      if (receipt) {
        if (receipt.argument_hash !== call.argument_hash) throw new Error("待办调用身份冲突");
        return { saved: true, item: this.get(String(receipt.todo_id)) };
      }
      const existing = args.todoId === undefined ? undefined : this.get(text(args.todoId, 100));
      const item = this.save({
        id: existing?.id ?? `tool:${call.id}`,
        version: existing ? args.expectedVersion : 0,
        title: args.title ?? existing?.title,
        description: args.description ?? existing?.description ?? "",
        owner: args.owner ?? existing?.owner ?? "me",
        date: args.date ?? existing?.date ?? "",
        priority: args.priority ?? existing?.priority ?? "普通",
        steps: args.steps ?? existing?.steps ?? [],
      });
      this.store.insert("todo_tool_receipts", { call_id: call.id, argument_hash: call.argument_hash, todo_id: item.id });
      return { saved: true, item };
    });
  }
  save(data: Record<string, unknown>) {
    const todoId = text(data.id, 100),
      title = text(data.title, 120),
      description = optionalText(data.description, 4000),
      date = optionalText(data.date, 10),
      owner = text(data.owner, 100),
      priority = text(data.priority, 10);
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number(date.slice(0, 4)) < 1900 ||
        new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date)
    )
      throw new Error("截止日期无效");
    if (!["高", "普通", "低"].includes(priority)) throw new Error("优先级无效");
    if (
      owner !== "me" &&
      !this.store.get(
        "SELECT id FROM bots WHERE id=? AND workspace_id=? AND status='active'",
        owner,
        this.store.workspace,
      )
    )
      throw new Error("请选择可用的 Agent");
    if (
      !Array.isArray(data.steps) ||
      data.steps.length > 50 ||
      data.steps.some(
        (s) =>
          !s ||
          typeof s !== "object" ||
          typeof s.done !== "boolean" ||
          typeof s.text !== "string" ||
          !s.text.trim() ||
          s.text.length > 300,
      )
    )
      throw new Error("步骤无效");
    const steps = JSON.stringify(
        data.steps.map((s) => ({ text: s.text.trim(), done: s.done })),
      ),
      bot = owner === "me" ? null : owner;
    this.store.transaction(() => {
      const existing = this.store.get(
        "SELECT id FROM todos WHERE id=?",
        todoId,
      );
      if (existing) {
        const row = this.checked(data);
        if (row.status === "running" && row.task_id)
          throw new TodoConflict("请先停止执行，再编辑待办");
        this.store.run(
          "UPDATE todos SET title=?,description=?,bot_id=?,due_date=?,priority=?,steps_json=?,task_id=CASE WHEN bot_id IS NOT ? THEN NULL ELSE task_id END,status=CASE WHEN bot_id IS NOT ? AND status IN ('review','running') THEN 'todo' ELSE status END,version=version+1,updated_at=? WHERE id=?",
          title,
          description,
          bot,
          date,
          priority,
          steps,
          bot,
          bot,
          now(),
          todoId,
        );
        this.event(todoId, "你更新了待办");
      } else {
        if (data.version !== 0) throw new TodoConflict("待办已变化，请刷新");
        this.store.insert("todos", {
          id: todoId,
          ...this.store.scope(),
          title,
          description,
          bot_id: bot,
          due_date: date,
          priority,
          status: "todo",
          steps_json: steps,
          created_at: now(),
          updated_at: now(),
        });
        this.event(todoId, "你添加了待办");
      }
      this.store.audit("todo.save", "todo", todoId, {});
    });
    this.agents.runtime.changed();
    return this.get(todoId);
  }
  action(data: Record<string, unknown>, sessionId: string) {
    const todoId = text(data.id, 100),
      action = text(data.action, 20);
    let stopTask: string | undefined;
    this.store.transaction(() => {
      if (action === "start") {
        const clientId = text(data.clientId, 100),
          digest = hash(canonical(data));
        const receipt = this.store.get(
          "SELECT * FROM todo_runs WHERE client_id=?",
          clientId,
        );
        if (receipt) {
          if (receipt.todo_id !== todoId || receipt.request_hash !== digest)
            throw new TodoConflict("执行请求已变化");
          this.row(todoId);
          return;
        }
        const row = this.checked(data);
        if (!["todo", "review"].includes(String(row.status)) || !row.bot_id)
          throw new TodoConflict("请选择 Agent，并确认待办尚未完成");
        if (this.agents.active(String(row.bot_id)))
          throw new TodoConflict("该 Agent 正在处理其他工作，请稍后再开始");
        const feedback = optionalText(data.feedback, 2000);
        const previous = this.get(todoId).result;
        const steps = (JSON.parse(String(row.steps_json)) as TodoStep[])
          .map((s) => `- [${s.done ? "x" : " "}] ${s.text}`)
          .join("\n");
        const prompt = `请完成待办：${row.title}\n\n${row.description}${steps ? "\n\n步骤：\n" + steps : ""}${row.due_date ? "\n截止日期：" + row.due_date : ""}${feedback ? "\n\n上一版结果：\n" + previous.slice(0, 12000) + "\n\n修改要求：" + feedback : ""}\n\n完成后提交具体结果，等待用户验收。`;
        const sent = this.agents.send(
          String(row.bot_id),
          prompt,
          `todo:${clientId}`,
          sessionId,
        );
        this.store.run(
          "UPDATE todos SET status='running',task_id=?,version=version+1,updated_at=? WHERE id=?",
          sent.taskId,
          now(),
          todoId,
        );
        this.store.insert("todo_runs", {
          client_id: clientId,
          todo_id: todoId,
          request_hash: digest,
          task_id: sent.taskId,
        });
        this.event(todoId, feedback ? "已提交修改要求" : "已交给 AI 执行");
      } else {
        const row = this.checked(data);
        if (action === "begin") {
          if (row.status !== "todo" || row.bot_id)
            throw new TodoConflict("只能开始自己的未开始待办");
          this.store.run(
            "UPDATE todos SET status='running',task_id=NULL,version=version+1,updated_at=? WHERE id=?",
            now(),
            todoId,
          );
          this.event(todoId, "你开始处理待办");
        } else if (action === "stop") {
          if (row.status !== "running")
            throw new TodoConflict("这条待办没有正在执行的任务");
          if (row.task_id) stopTask = String(row.task_id);
          else {
            this.store.run(
              "UPDATE todos SET status='todo',version=version+1,updated_at=? WHERE id=?",
              now(),
              todoId,
            );
            this.event(todoId, "你暂停了待办");
          }
        } else {
          if (row.status === "running" && row.task_id)
            throw new TodoConflict("请先停止执行");
          if (action === "delete")
            this.store.run(
              "UPDATE todos SET deleted_at=?,version=version+1 WHERE id=?",
              now(),
              todoId,
            );
          else if (action === "complete" || action === "reopen") {
            if (action === "reopen" && row.status !== "done")
              throw new TodoConflict("待办尚未完成");
            this.store.run(
              "UPDATE todos SET status=?,updated_at=?,version=version+1 WHERE id=?",
              action === "complete" ? "done" : "todo",
              now(),
              todoId,
            );
            this.event(
              todoId,
              action === "complete" ? "你确认完成了待办" : "你重新打开了待办",
            );
          } else throw new Error("未知的待办操作");
        }
      }
      this.store.audit(`todo.${action}`, "todo", todoId, {});
    });
    if (stopTask) this.agents.runtime.cancel(stopTask, "用户停止了待办执行");
    this.agents.runtime.changed();
    return action === "delete" ? { deleted: true } : this.get(todoId);
  }
}
