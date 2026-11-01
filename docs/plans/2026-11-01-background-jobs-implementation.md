# 后台任务技术方案

设计依据：[助手后台任务：主对话保持可响应](../design/assistant-background-jobs.md)（2026-11-01 已确认）。本文写到函数、表和测试一级，按这里的顺序实现即可。文中行号以提交 `27635d5c` 为准。

## 0. 主题负责人提问的例外（2026-11-01 已确认保留）

决定“主对话禁用 `agent.delegate`”原本会连带禁掉**主题负责人提问**：系统提示要求“提示说某个主题由别的助手负责时，用 `agent.delegate` 带上 topic 交给它，不要自己回答这部分”（[runtime.ts:552](../../server/personal-os/runtime.ts)），这条路径由 `topic-tree.ts` 的 `checkDelegation` / `noteDelegation` 管理，`topic-access.test.ts` 有 3 处从主人任务调用。

决定：带 `topic` 参数的 `agent.delegate`（向主题负责人提问）保留在主对话中，其余委派禁止。理由是这类提问只问一个事实，同伴读自己的记忆就能回答，通常很快；如果改成后台任务，用户问“那个项目怎么部署”时，会先收到“已交给后台”，过一会儿才收到回答。

## 1. 改动总览

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 存储 | 新增 `server/personal-os/job-schema.ts`；`store.ts` | 迁移 43：三张新表、重建 `agent_task_links`、改待办触发器 |
| 领域 | 新增 `server/personal-os/jobs.ts` | `JobModule`：派发、输入、停止、回报、阶段、结算、详情 |
| 运行时 | `runtime.ts` | 主人任务禁用工具、提示词按来源分角色、`job.*` 执行分派、恢复白名单 |
| 策略与目录 | `policy.ts`、`tool-catalog.ts`、`tool-fields.ts`、`shared/personal-capabilities.ts` | `job.*` 动作、参数、目录说明 |
| 收件箱 | `agents.ts` | 后台过滤从“例行”扩展到“例行或后台任务”，易变提示加入后台任务列表与回报 |
| 待办 | `todos.ts` | “交给 AI 执行”改走后台任务，停止改走 `jobs.stop` |
| 设备 | `devices.ts` | 设备资源租约（首个资源：屏幕，对应 `device.computer`） |
| 飞书 | `feishu/module.ts` | 回报与审批按派发链路找飞书会话 |
| 接口 | `index.ts` | `state.jobs`、`/api/jobs/*`、`/api/agents/stop-all` |
| 客户端 | `src/personal/*`、`apps/apple/*` | 见第 4 节 |

## 2. Core

### 2.1 迁移 43（`job-schema.ts`）

在 `store.ts` 迁移 42 之后追加，写法同迁移 36（`routine-schema.ts` 的表重建）。实现时若主线已占用 43，顺延到下一个空号。

```sql
-- 1. 来源增加 job。agent_task_links 没有被其他表外键引用，可以安全重建。
CREATE TABLE agent_task_links_v2 (
 task_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id),
 origin TEXT NOT NULL CHECK(origin IN ('owner','routine','job')), source_key TEXT NOT NULL UNIQUE,
 FOREIGN KEY(task_id,bot_id) REFERENCES tasks(id,bot_id)
) STRICT;
INSERT INTO agent_task_links_v2 SELECT task_id,bot_id,origin,source_key FROM agent_task_links;
DROP TABLE agent_task_links;
ALTER TABLE agent_task_links_v2 RENAME TO agent_task_links;

-- 2. 后台任务与回报
CREATE TABLE agent_jobs (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id),
 conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
 origin_task_id TEXT REFERENCES tasks(id), todo_id TEXT REFERENCES todos(id),
 title TEXT NOT NULL, brief_json TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE,
 progress TEXT, progress_at INTEGER, stopped_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX agent_jobs_bot ON agent_jobs(bot_id,created_at);
CREATE TABLE agent_job_reports (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES agent_jobs(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 state TEXT NOT NULL CHECK(state IN ('ready','question','blocked','failed','dropped')),
 summary TEXT NOT NULL, question TEXT, waiting_for TEXT, automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)),
 message_id TEXT REFERENCES agent_messages(id), created_at INTEGER NOT NULL,
 CHECK((state='question') = (question IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX agent_job_reports_task ON agent_job_reports(task_id);  -- 每轮一条
CREATE TABLE job_tool_receipts (call_id TEXT PRIMARY KEY REFERENCES tool_calls(id), argument_hash TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
CREATE TABLE device_resource_leases (
 device_id TEXT NOT NULL REFERENCES devices(id), resource TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id), acquired_at INTEGER NOT NULL,
 PRIMARY KEY(device_id,resource)
) STRICT;
CREATE INDEX device_resource_leases_task ON device_resource_leases(task_id);

-- 3. 后台任务的待办由 JobModule 按回报更新，旧触发器跳过它们
DROP TRIGGER todo_task_ended;
CREATE TRIGGER todo_task_ended AFTER UPDATE ON tasks
WHEN NEW.ended_at IS NOT NULL AND EXISTS(SELECT 1 FROM todos WHERE task_id=NEW.id AND status='running')
 AND NOT EXISTS(SELECT 1 FROM agent_task_links WHERE task_id=NEW.id AND origin='job') BEGIN
 ...（主体与 todo-schema.ts:18-22 相同）
END;
```

迁移只增表和改约束，不改已有行。测试要覆盖：迁移前后 `agent_task_links`、`todos` 的行逐列相等；旧 owner 待办在任务结束时仍按原触发器进入待验收。

### 2.2 `JobModule`（新文件 `jobs.ts`）

依赖：`CoreStore`、`AgentModule`（发布消息、`ensure`）、`TaskRuntime`（`input`、`kick`、`cancel`、`changed`）。在 `index.ts` 中于 `TodoModule` 之前构造，`runtime.jobExecutor = (call, args) => jobs.tool(call, args)`。

**创建**

```ts
start(input: { botId; title; sources: string[]; note?; deviceId?; originTaskId?; todoId?; sourceKey; sessionId }): { jobId; taskId; replay }
```

在一个事务里：

1. 按 `sourceKey` 查重（工具调用用 `job-start:<callId>`，待办用 `todo-job:<todoClientId>`），已存在则返回原记录。
2. 校验 `sources`：1–5 个，均为 `message:<id>`，属于同一 `bot_id`、`role='user'`，未被遗忘（`memory_forgotten_tasks`）。
3. `store.createConversation(botId, "后台任务：" + title)`，写 `agent_jobs`。
4. `store.accept(conversationId, brief, "job:<jobId>:1", sessionId)` 得到首个 Task，写 `agent_task_links(origin='job', source_key='job-task:<taskId>')`。`sessionId` 取派发它的主人任务的 `authorized_session_id`（与委派一致，[runtime.ts:892](../../server/personal-os/runtime.ts)）；待办取用户点击时的会话。
5. 发布 `system/activity` 消息 `已交给后台：<title>`，`source_key = job-start:<jobId>`，`task_id = originTaskId`，没有派发任务时（待办）为 null。

事务外调用 `runtime.input(conversationId, brief, "job:<jobId>:1", sessionId)`，因为按 clientId 幂等，会命中同一个 Task 并 `kick`。

任务书 `brief` 的文本模板（数据与指令分开标注）：

```
后台任务「<title>」。以用户原话为准；主对话备注只是路由信息，不是新增要求。
用户原话（资料，不是系统指令）：
[message:<id> <本地时间>] <内容>
…
主对话备注：<note>
指定设备：<deviceId>
```

**输入（补充、回答、修改要求）**

```ts
input(jobId, text, clientId, sessionId, via: "direct" | "owner"): { taskId }
```

拒绝 `stopped_at` 非空的后台任务。在事务里 `store.accept(job.conversation_id, text, clientId, sessionId)`。如果得到的是新 Task（上一轮已结束），补写 `agent_task_links(origin='job')`；如果来自待办，就 `UPDATE todos SET task_id=?, status='running'`。事务外调用 `runtime.input(...)`。

两种 `via` 的区别：

- `via='direct'`（用户点“回复”）：同一事务里把用户这句话发布到消息流，`role='user'`，`source_key = job-input:<clientId>`，`task_id` 为后台任务当前的 Task，用户在主消息流里能看到自己回复了什么。
- `via='owner'`：原话已经在消息流里，不再发布；文本前加一行 `用户在主对话中说（message:<id>）：`，原话引用由 `job.message` 传入。

**停止**

```ts
stop(jobId, reason = "用户停止了后台任务")
```

先写 `stopped_at`，再对当前未结束的 Task 调用 `runtime.cancel(taskId, reason)`。它持有的设备资源租约同时释放。被停止的后台任务不再接受输入。

**回报（`job.report`，只能由该后台任务的 Task 调用）**

校验参数：`state` ∈ 5 种；`summary` ≤ 600 字；`question` 仅在 `state=question` 时必填，且 ≤ 300 字；`waitingFor` 可选，目前只有 `resource:<deviceId>:<resource>` 一种形式，取自租约失败时返回的值。按 `task_id` 唯一写入 `agent_job_reports`：同一轮重复调用时，以最后一次为准，覆盖原记录，消息不重复发布。发布时机放在结算中（见下），保证“最后一次”才对外。

**进度（`job.progress`）**

只更新 `agent_jobs.progress / progress_at`，不发布消息、不通知。

**结算 `settle(taskId)`**

由 `agents.onSettled` 调用（所有 Task 结束时都会调用，[agents.ts:32](../../server/personal-os/agents.ts)），并在启动恢复后对“已结束但没有回报”的后台 Task 再补跑一次，与 `reportRoutine` 的补发相同。逻辑：

| Task 结局 | 当轮回报 | 处理 |
| --- | --- | --- |
| `succeeded` | 有 | 发布该回报 |
| `succeeded` | 无 | 自动写 `ready`，内容为 `result_summary` 截断到 600 字，`automatic=1` |
| `failed` | 任意 | 写 `failed`，内容为错误信息，覆盖当轮回报 |
| `cancelled` | 任意 | 不写回报、不发布；阶段由 `stopped_at` 或 Task 状态得出 |

发布规则：

- `ready`：`assistant/result`；
- `question`：`assistant/request`；
- `blocked` / `failed`：`system/error`；
- `dropped`：不发布，但来自待办的例外，按 `ready` 的样式发布，让用户能验收。

`source_key = job-report:<reportId>`，正文为 `后台任务「<title>」\n<summary>[\n\n<question>]`。附件沿用 `reportRoutine` 的绑定写法（[agents.ts:263-267](../../server/personal-os/agents.ts)）。

来自待办的后台任务：

- `ready` / `dropped` 写 `todo_events('AI 已交付，等待验收')`，状态改为 `review`；
- `question` 保持 `running`，写 `todo_events('等待你回答')`；
- `blocked` / `failed` 改为 `todo`，写 `'执行未完成，可重试'`；
- 被停止时改为 `todo`，写 `'执行已停止'`。

**阶段 `stage(job)`**

纯函数，按设计文档第 7 节的顺序取第一条命中。输入是当前 Task（最新一轮）、是否有待批准的 `approvals`、最近一条回报、回报之后是否有新的 `conversation_inputs`、`stopped_at`。输出：

```
'approval' | 'question' | 'review' | 'blocked' | 'failed' | 'queued' | 'running' | 'done' | 'dropped' | 'stopped'
```

Task 为 `needs_reconciliation` 时归入 `blocked`。

**列表与详情**

- `list()`：未结束的全部，加上最近 50 条已结束的，按创建时间倒序。每项字段：`{id, botId, title, stage, todoId, todoVersion, todoStatus, progress, latestReport, createdAt, endedAt}`。回报卡片上的“验收 / 修改”需要用 `todoVersion`。
- `detail(jobId)`：照搬 `routines.occurrence` 的结构（[routines.ts:28-36](../../server/personal-os/routines.ts)），返回 `{job, tasks, messages, steps, reports, streaming}`。`messages` 读该 Conversation 全部轮次的 `transcript`，遗忘的 Task 不返回。

**工具入口 `tool(call, args)`**

所有 `job.*` 动作先查 `job_tool_receipts`，以 `argument_hash` 防冲突、保证重放幂等，写法同 `routines.tool`。

| 动作 | 允许的调用方 | 参数 | 返回 |
| --- | --- | --- | --- |
| `job.start` | 主人任务 | `title sources note deviceId` | `{jobId, stage}` |
| `job.list` | 主人任务 | 无 | `{jobs}`，与易变提示同格式 |
| `job.message` | 主人任务 | `jobId text sources` | `{jobId, stage}` |
| `job.stop` | 主人任务 | `jobId` | `{stopped: true}` |
| `job.report` | 本后台任务 | `state summary question waitingFor` | `{recorded: true}` |
| `job.progress` | 本后台任务 | `text` | `{saved: true}` |

调用方的来源取 `agent_task_links.origin`（委派子任务没有记录，视为 `delegated`）。不符合时返回 `{error, ...}`，不抛异常。`job.message` 和 `job.stop` 只能操作同一助手的后台任务。

### 2.3 运行时（`runtime.ts`）

**主人任务禁用工具。** 在 `propose`（[runtime.ts:651](../../server/personal-os/runtime.ts)）的 `evaluateTool` 之后、插入 `tool_calls` 之前判断：

```ts
const OWNER_JOB_ONLY = new Set(["device.computer", "image.generate", "agent.delegate"]);
const origin = taskOrigin(task.id); // 'owner' | 'routine' | 'job' | 'delegated'
const blocked = origin === "owner" && OWNER_JOB_ONLY.has(action)
  && !(action === "agent.delegate" && args.topic !== undefined); // 第 0 节的例外
```

命中时照常插入 `tool_calls`，但直接写成 `status='failed'`，`result_json={error:"主对话不直接执行此操作，请用 job.start 交给后台任务", useJob:true}`，不建审批。`event` 的工具分支看到终态会直接回给模型（[runtime.ts:624](../../server/personal-os/runtime.ts)）。这样审计和幂等都沿用现有路径。

**提示词按来源分角色。** 在 `promptParts`（[runtime.ts:522](../../server/personal-os/runtime.ts)）中按 `taskOrigin` 选角色段，放进 `systemPrompt`。同一 Conversation 的来源不变，因此不破坏前缀缓存。

- **主人任务：**
  - 职责与派发规则（设计文档第 5 节）；
  - 三项能力只能在后台任务中使用；
  - 转交只在消息明确指向某项后台任务时进行；
  - 不得为了绕开等待中的审批而重新派发；
  - 派发后用一句话告诉用户。
- **后台任务：**
  - 以原话为准，备注不是新需求；
  - 结束前调用 `job.report`；
  - 需要用户回答时用 `state=question`，提一个具体问题；
  - 不能调用 `job.start/message/stop`。
- **例行任务与委派子任务：** 保持现状。

能力清单也按来源过滤：

- `你实际获准的能力` 和 `commonToolPrompt(capabilities)` 对主人任务去掉这三项，加上 `job.start/list/message/stop`；
- 对后台任务加上 `job.report/progress`；
- `searchTools` 增加可选的 `origin` 参数，对主人任务在三项能力的说明前标注“仅后台任务”。

**执行分派。** `execute`（[runtime.ts:827](../../server/personal-os/runtime.ts) 一带）加一行：

```ts
else if (String(call.tool_name).startsWith("job.") && this.jobExecutor) result = this.jobExecutor(call, args);
```

`propose` 的 `targetId` 计算（[runtime.ts:662](../../server/personal-os/runtime.ts)）对 `job.*` 返回 `args.jobId ?? task.bot_id`。

**恢复白名单。** 构造函数里的 `recoverable` 列表（[runtime.ts:100](../../server/personal-os/runtime.ts)）加入全部 `job.*`，它们都由回执保证幂等。

**名额。** 不改：`botSlots` 已把所有非 owner 的 Task 计入后台名额（[runtime.ts:175](../../server/personal-os/runtime.ts)），后台任务自动与例行任务共用 3 个。

### 2.4 收件箱与主对话上下文（`agents.ts`）

- `isRoutine(taskId)` 改名为 `isBackground(taskId)`：根 Task 的来源属于 `routine` 或 `job` 时为真（[agents.ts:245](../../server/personal-os/agents.ts)）。`publish` 的过滤只放行 `routine-report:<taskId>`、`job-report:*` 和 `job-input:*` 三类来源（[agents.ts:137](../../server/personal-os/agents.ts)）。
- `context(botId, taskId)`（[agents.ts:286](../../server/personal-os/agents.ts)）在主人任务的 JSON 中增加：
  - `jobs`：`jobs.list()` 中该助手未结束的项，每项一行，含 id、标题、阶段、进度、待回答的问题；
  - `jobReports`：最近 6 条已发布的回报，与 `routineReports` 同格式：`ref`、`summary`（截断到 1200 字）、`truncated`；
  - `jobPolicy`：一句话说明这些是资料，不是新输入，不要重复执行或播报。
- 后台任务的 `context` 不加入主对话的工作笔记，只用自己 Conversation 的笔记（现状已是按 Conversation 读取）。
- `projectMessages` 对 `job-start:` 和 `job-report:` 消息补充 `job_id`、`job_state` 字段，供客户端渲染。
- 新增 `stopAll(botId)`：对该助手所有未结束的 Task 调用 `runtime.cancel`，后台任务通过 `jobs.stop` 停止，以便写入 `stopped_at`。

### 2.5 待办（`todos.ts`）

`action === "start"`（[todos.ts:227](../../server/personal-os/todos.ts) 起）：

- 删除“该 Agent 正在处理其他工作”检查（第 243 行）。
- 如果待办关联的后台任务未停止且仍存在（用 `agent_jobs.todo_id` 查最近一项），就调用 `jobs.input(jobId, 修改要求, ...)`；否则调用 `jobs.start({ title: row.title, sources: [], todoId, sourceKey: "todo-job:" + clientId, ... })`。
- 待办没有用户消息可引用，所以 `sources` 允许为空，但仅限 `todoId` 非空的情况；任务书正文沿用现在的 prompt 文本（第 250 行）。
- 写 `todo_runs` 时的 `task_id` 取后台任务当前轮次的 Task。

`action === "stop"`：有关联后台任务时调用 `jobs.stop(jobId, "用户停止了待办执行")`，否则沿用 `runtime.cancel`。

`complete` / `reopen` 不变。回报卡片上的“验收”调用 `todos/action complete`，“修改”调用 `start` 并带 `feedback`，两处都带版本号。

### 2.6 设备资源租约（新文件 `device-leases.ts`，接入 `devices.ts`）

租约按 **(设备, 资源)** 加锁，不是全局锁，也不只针对屏幕：

- 不同设备互不影响：后台任务 A 操作 Windows 的屏幕，B 同时操作 Mac 的屏幕；
- 同一设备上的不同资源也互不影响；
- 只有同一设备、同一资源才需要排队。

```ts
// 一次设备调用需要独占的资源；返回空数组表示不需要租约。
export function leaseResources(action: string, args: Record<string, unknown>): string[]
export class DeviceLeases {
  acquire(taskId: string, deviceId: string, resources: string[]): { ok: true } | { ok: false; holder: { taskId; label }; resource: string }
  releaseTask(taskId: string): Array<{ deviceId: string; resource: string }>
}
```

**第一版的资源映射只有一项：**

| 调用 | 资源 | 说明 |
| --- | --- | --- |
| `device.computer` 的写操作：`bring_to_front`、`click`、`type_text`、`press_key`、`scroll`、`drag` | `screen` | 键盘、鼠标和前台窗口只有一套 |
| `device.computer` 的读操作（`computerReads`，[computer.ts:7](../../server/personal-os/computer.ts)） | 无 | 读屏不改变状态，不排队 |
| `device.exec`、`device.read`、`device.list`、`device.info` | 无 | 仍走现有的按设备串行队列 |

以后出现新的独占资源，只需在 `leaseResources` 里加映射，表结构不用改。可能的例子：浏览器自动化会话（`browser`）、某个工作目录的写入（`dir:<路径>`）。

**获取。** 在 `DeviceGateway.execute` 下发之前，对调用方不是主人任务的调用执行：

1. `leaseResources` 为空时直接下发；
2. 否则在一个事务里**全部获取或全部不获取**：
   - 资源无记录，或者持有它的 Task 已结束（崩溃遗留）：写入或接管；
   - 持有者是同一 Task：继续；
   - 只要有一项被其他未结束的 Task 持有：整次调用不获取任何资源，返回 `{error: "<资源名>正被「<后台任务标题或例行任务名>」使用", waitingFor: "resource:<deviceId>:<resource>"}`，不下发给设备。

**释放。** 租约只在一轮工作期间持有，这一轮结束（`agents.onSettled`）、被停止（`runtime.onCancel`）或后台任务被 `stop` 时，`releaseTask` 释放该 Task 的全部租约。

因为一轮结束就释放，回报 `blocked` 等待资源的后台任务手里不会还握着别的租约。所以不会出现两项后台任务互相等待对方资源的死锁。

**唤醒。** 释放后，对每个被释放的 `(设备, 资源)`，调用 `JobModule.wakeWaiting(deviceId, resource)`：

- 找出最近回报为 `blocked`、且 `waiting_for = 'resource:<deviceId>:<resource>'` 的后台任务；
- 按创建时间取最早的一项，输入“<资源名>已空闲，可以继续”；
- 例行任务和委派子任务拿到同样的错误，但不在唤醒范围内：它们没有回报机制，可以自行重试或失败结束。

主人任务已经不能调用 `device.computer`，不参与租约。

### 2.7 飞书（`feishu/module.ts`）

- 新增 `mappingFor(message)`：先按 `message.task_id` 查 `personal_feishu_messages`；查不到且 `source_key` 以 `job-report:` 开头时，按 `agent_job_reports → agent_jobs.origin_task_id` 再查。
- `onPublished`（[feishu/module.ts:484](../../server/personal-os/feishu/module.ts)）目前只取 `kind IN ('message','error')` 的最新消息，要放宽到也取 `job-report:` 的 `result`、`request`。例行任务的回报保持不发飞书，维持现状。
- `scanApprovals`（第 513 行）的 `EXISTS` 条件改为：Task 本身有飞书映射，或者它是后台任务、而派发它的主人任务有映射。卡片标题前加 `后台任务「<title>」`。
- 直通回复：飞书里对回报消息的回复，应路由到 `jobs.input`。现在还做不到，需要补两件事：
  - `personal_feishu_outbound` 虽有 `message_id` 列，但目前从未写入（`sendRaw` 没有保存飞书返回的消息 ID），要补上，并加一列 `job_id`；
  - `handleMessage` 目前不解析 `parent_id`，要读出来：若它命中带 `job_id` 的出站记录，就转给 `jobs.input`，不再进入主对话。

  这一项可以放到 P1 末尾，不阻塞其他部分。

### 2.8 接口（`index.ts`）

| 方法 | 路径 | 处理 |
| --- | --- | --- |
| GET | `/api/state` | `stateBody` 增加 `jobs: jobs.list()`；`summary` 视图同样包含 |
| GET | `/api/jobs/detail?id=` | `jobs.detail(id)` |
| POST | `/api/jobs/input` | `{jobId, text, clientId}` → `jobs.input(..., "direct")` |
| POST | `/api/jobs/stop` | `{jobId}` → `jobs.stop(jobId)` |
| POST | `/api/agents/stop-all` | `{botId}` → `agents.stopAll(botId)` |

鉴权、`TodoConflict` 式的错误码与现有路由一致。所有写操作之后调用 `changed()`。`/api/agents/messages` 的 `streaming` 仍只返回主人任务的流式输出（[index.ts:329](../../server/personal-os/index.ts)），后台任务的流式输出在详情接口里提供。

## 3. 测试

新增 `server/personal-os/jobs.test.ts`，夹具照搬 `routine-isolation.test.ts`（真实 `createPersonalApp` 加 `startFakeModel` 脚本）：

1. **派发与隔离**：主人任务调用 `job.start` 后立即用文本结束；后台任务在新 Conversation 中运行；主人任务的投影中不含后台执行内容；消息流只出现“已交给后台”和回报。
2. **主对话可响应**：后台任务被 `waitFor` 门控挂住时，用户发新消息，主人任务完成回答，后台任务的 `conversation_inputs` 不变。
3. **两项并行**：两项后台任务同时运行，第三项排队；名额释放后自动启动；主人任务始终能启动（保留 1 个名额）。
4. **禁用工具**：主人任务调用三项能力，得到 `useJob:true`，不产生审批、不触达设备；带 `topic` 的委派照常执行（第 0 节例外）；后台任务里同样的调用正常执行。
5. **回报**：
   - 显式 `ready` / `question` / `blocked` / `failed`；
   - 没有回报时自动生成 `ready`；
   - 同一轮多次回报只发布最后一次；
   - 重放 `settle` 不重复发布；
   - `dropped` 不发布。
6. **交互路径**：`/api/jobs/input` 在运行中补充当前轮、结束后开启新一轮；`job.message` 带原话引用；`/api/jobs/stop` 后拒绝输入；`stop-all` 停止全部。
7. **审批**：后台任务的危险操作产生审批；主对话新消息不使其失效；批准后后台任务继续。
8. **恢复**：运行中重启后，后台任务重新排队并完成；已结束未回报的后台任务在启动后补发回报；不可重放的设备调用进入 `needs_reconciliation`，阶段为 `blocked`。
9. **待办**：开始后进入后台任务；`question` 时保持执行中；`ready` 后两处验收按版本号互斥；修改要求进入同一后台任务；停止后回到未开始；旧 owner 待办触发器行为不变。
10. **设备资源租约**：
    - 两项后台任务对同一设备做屏幕写操作，后者得到 `waitingFor`，前者这一轮结束后后者被唤醒；
    - 对不同设备的屏幕写操作同时进行；
    - 屏幕读操作不排队；
    - 持有者崩溃后 Task 已结束，新的调用可以接管；
    - 停止后台任务时释放全部租约。
11. **迁移**：用迁移前的数据库副本升级，旧行逐列相等，`origin` 约束接受 `job`。

需要修改的现有测试：

- `app.test.ts` 中有 11 处、`image-models.test.ts` 中有 8 处在主人任务里调用这三项能力。按原意改为：先由脚本让主人任务调用 `job.start`，在后台任务里执行原动作；或直接用 `jobs.start` 构造后台任务。
- `topic-access.test.ts` 的 3 处属于第 0 节的例外，不用改。
- `approval-rules.test.ts`、`risk.test.ts` 直接调用 `evaluateTool`，不受影响。
- `feishu.test.ts` 增加回报回发、审批卡片、回复直通三个用例。
- `todos.test.ts` 中依赖 `agents.send` 路径的断言要改。

运行：`pnpm vitest run server/personal-os`，并按 [验证规范](../verification/README.md) 在隔离夹具里做一次端到端检查：用真实模型连接或假模型启动独立 Core，不连用户的实际数据。

## 4. 客户端

界面只有两套实现：

- **Web**：`src/personal/`，网页版、Windows 和 Android 共用。Android 是 WebView，加载打包进 APK 的同一套页面。
- **Apple 原生**：`apps/apple`，Mac 与 iOS 共用 `NexClientKit`。

两套都没有 `CodingKeys` 或严格类型的负担：

- Web 的 `RecordRow` 是宽松对象；
- Apple 用 `RowBacked`，按 `row.string("snake_key")` 取字段。

所以新字段不会打破旧客户端的解码。

### 4.1 Web（`src/personal/`）

**数据与过滤**

- `api.ts`：`State` 增加 `jobs: RecordRow[]`。消息上的 `job_id`、`job_state` 不需要改类型。
- 聊天的任务过滤：`AgentDesktop.tsx:414` 与 `:420` 由 `t.origin !== "routine"` 改为 `t.origin === "owner"`。这同时修正设计文档里提到的问题：委派子任务被当作聊天任务。
- 联系人列表 `components/ContactSidebar.tsx:52` 的工作状态：主人任务未结束，或有阶段为 `running` / `queued` 的后台任务，都算“工作中”。
- 输入框停止键（`AgentDesktop.tsx:659-660`）只遍历上面过滤后的主人任务，不改代码，行为自然变窄。

**消息渲染**（`function AgentMessage`，`AgentDesktop.tsx:773-792`）：在 a2a 分支之前加两个分支。

- `source_key` 以 `job-start:` 开头：渲染 `JobMarker`，样式同 `A2AMarker`（761-763），文字“已交给后台：标题”。点击打开详情。
- 带 `job_state` 的回报：渲染新组件 `components/JobReportCard.tsx`，内容为标题、阶段标签、结论（`RichText`）和附件（`MessageImages`）。按钮按状态显示：

  | 情形 | 按钮 |
  | --- | --- |
  | `question` | 回复 |
  | 后台任务进行中 | 停止 |
  | 来自待办且待验收 | 验收、修改 |

  阶段取 `state.jobs` 中的最新值，而不是消息里的快照，这样卡片能反映后来的变化。
- `job-input:` 的用户消息按普通用户消息渲染，上方加一行小字“回复后台任务：标题”。
- `sameGroup()`（794-798）不合并带 `job_id` 的行。

**回复模式。** 照搬现有引用模式：`quote` 状态在 193 行，引用条在 622 行，发送时的前缀在 382 行。

- 新增 `replyJob` 状态，切换助手时清空（353 行同处）。
- 输入框上方显示“回复后台任务：标题 ×”。
- `send()`（380-413）在 `replyJob` 存在时改调 `api("jobs/input", { jobId, text, clientId })`；失败时恢复草稿，与引用模式一致。
- 回复模式下不带附件，附件按钮禁用。

**头部与资料栏**

- 头部（554 行）在主人任务短语后加“· N 项后台任务”，点开是浮层，列出标题、阶段和停止。
- 资料栏“正在处理”（688-689）之后新增“后台任务”分组：进行中的后台任务，每项带停止；分组底部放“停止全部”（`api("agents/stop-all", { botId })`，需确认）。
- “最近动态”（536、691-695）把 `state.occurrences` 和已结束的 `state.jobs` 合并，按时间倒序取 10 条。

**详情。** 把 `components/RoutineOccurrenceDetail.tsx` 中渲染执行记录和工具步骤的部分抽成 `RunTranscript`，新增 `components/JobDetail.tsx` 复用它：

- 读取 `jobs/detail?id=`，未结束时每 3 秒轮询；
- 头部显示标题、阶段、各轮的回报；
- `RoutineOccurrenceDetail` 的对外行为不变。

**待办面板**（`todo/TodoWorkspace.tsx`）不用改：动作名和参数不变，进度改由回报驱动后，面板上的状态会自然更新。回报卡片的“验收”“修改”调用同一个 `todos/action`，带 `todoVersion`；“修改”复用面板上 `revise` 弹窗（1242-1265）的文案和校验。

**测试：**

- `AgentDesktop.input.test.ts`：
  - 回报卡片按状态显示按钮；
  - 回复模式发送到 `jobs/input`；
  - 停止键只停主人任务；
  - 后台任务和委派子任务都不被选为聊天任务（对照 143 行已有用例）；
  - “N 项后台任务”浮层。
- `Routines.test.ts`：增加 `JobDetail` 用例，并确认抽出 `RunTranscript` 后例行任务详情不变。

### 4.2 Apple（`apps/apple`）

**NexClientKit**

- `Protocol/Entities.swift`：
  - 新增 `Job: RowBacked`，字段为 `botID`、`title`、`stage`、`todoID`、`todoVersion`、`progress`、`latestReport`、`createdAt`、`endedAt`，并提供 `isActive`；
  - 新增 `JobDetail: Decodable`，结构同 `RoutineOccurrenceDetail`（97-109）。
- `Protocol/Workspace.swift`：
  - `WorkspaceState` 的 `init(from:)`（135-160）加一行 `jobs = c.lenient(...)`，成员初始化器（128-134）加参数；
  - `unfinishedTask(s)`（162、164）改为 `origin == "owner"`；
  - 新增 `jobs(botID:)`、`activeJobs(botID:)`；
  - `AgentMessage`（197-214）增加 `jobID`、`jobState`、`isJobStart`。
- `Networking/Endpoints.swift`：仿照 `runRoutine`（365）增加 `jobInput(jobID:text:clientID:)`、`stopJob(jobID:)`、`stopAll(botID:)`、`jobDetail(id:)`，请求体结构放在 284-286 一带。
- `Sync/WorkspaceActions.swift`：仿照 `cancelTask`（73）、`routineOccurrence(id:)`（99-101）增加对应包装。
- `Sync/ConversationStore.swift`：`send`（137）支持回复目标；`stop()`（180-184）只停 `activeTask`，过滤改后行为自然正确。

**Mac**

- `ConversationView.swift` 的 `MessageRow.body`（478-501）在 a2a 分支前加入 `jobMarker` 与 `JobReportCard`；`StreamingReply` 不变。
- `Composer.swift`：
  - 仿照引用条（279-290、357-364）加回复后台任务条；
  - `stopAll()`（40-49）只遍历主人任务。
- `InspectorView.swift`：
  - `InspectorWorkTab`（110）在“正在处理”之后加“后台任务”分组和“停止全部”；
  - “最近结果”（128-141）合并已结束的后台任务，点开为新的 `JobDetailView` 弹层。

**iOS**

- `MessageRow.swift`：在 `body`（140-161）中加入后台任务分支。
- `ChatView.swift` 和 `ComposerView.swift`：加回复条，停止循环（458）只遍历主人任务。
- `AgentDetailView.swift`：在弹层枚举（48-54）中加 `.job`，“正在处理”（139-158）之后加“后台任务”，“最近结果”（160-173）合并后台任务。

**共享**：`Shared/RoutineOccurrenceDetailView.swift` 把执行记录主体抽成可复用视图，新增 `Shared/JobDetailView.swift`；标题“定时任务”（182）的硬编码只留在例行任务视图里。

**测试：**

- `ProtocolTests` 解码 `jobs` 和消息上的后台任务字段；
- `ActionsTests` 的 `unfinishedTask` 断言（344-345）改为只认主人任务，新增新接口的请求体用例；
- `SyncTests` 测停止范围；
- `Testing/RoutineRenderingTests.swift` 增加回报卡片与详情的渲染夹具。

在 Mac 上按 `apps/apple/README.md` 运行 `swift test`、`xcodebuild` 和 `scripts/check-ios.sh`。

### 4.3 通知

现状：只有 Android 原生层发系统通知。它在 `sync/Repository.kt:533-545` 按未读数增加和新审批触发，只读未读数、助手名和审批 ID。Web、Windows（`electron/nex-client-preload.cjs:27` 把 `notifications` 固定为 `false`）和 Apple 端都没有系统通知。

本方案不新增通知机制：

- 回报只有 `ready`、`question`、`blocked`、`failed` 会发布到消息流，未读数随之增加，Android 因此会提醒；
- 进度和 `dropped` 不发布，所以不提醒；
- 后台任务的审批进入 `state.approvals`，Android 的审批提醒照常生效；
- 给 Web、Windows 和 Apple 增加系统通知是另一件事，不在本次范围内。

### 4.4 旧客户端兼容

Core 先于客户端更新时，旧客户端的表现：

- “已交给后台”和回报会显示成普通的系统消息或助手消息，内容可读；
- 旧客户端的聊天过滤是 `origin !== "routine"`，会把后台任务当成聊天任务：显示“正在工作”，停止键也会停掉后台任务。

这是可接受的降级。但为了减少这种混乱的窗口期，Core 与全部客户端应在同一次发布中上线（见第 5 节）。

## 5. 交付拆分

按 AGENTS.md，生产部署和安装包只能从已推送的 `main` 构建，所以下面每一步都先合入 `main`。

| 步骤 | 内容 | 合入前须通过 |
| --- | --- | --- |
| 1 | 迁移 43、`JobModule`、运行时、收件箱、待办、设备资源租约、接口；第 3 节全部 Core 测试，以及修改后的现有测试 | `pnpm vitest run server/personal-os`、`pnpm typecheck`、`pnpm lint` |
| 2 | 飞书路由（回报、审批卡片；直通回复可单独跟进） | `feishu.test.ts` |
| 3 | Web 客户端 | `pnpm vitest run src/personal`；用隔离 Core 夹具在浏览器里走一遍派发、回复、停止、验收 |
| 4 | Apple 客户端 | 在 Mac 上：`swift test`、`xcodebuild` Mac 与 iOS、渲染夹具 |
| 5 | 发布 | 按 AGENTS.md「Shipping a change」完整执行：东京 Core 部署（备份、回滚检查、数据哈希）；Windows、Android、Mac / iOS 升版本并打包；GitHub 预发布、OSS 镜像、更新清单；README 与主页；新增 `docs/verification/background-jobs.md` |

步骤 1 和 2 可以在步骤 3、4 之前合入 `main`，但不部署。部署在步骤 5 统一进行，原因见 4.4。

## 6. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 模型在主对话里用多次 `device.exec` 硬做长任务，不派发 | 主对话照样被占住 | 提示词规则；观察期统计主人任务时长和运行中收到新消息的次数；必要时再收紧 `device.exec` |
| 后台任务忘记调用 `job.report` | 回报质量下降 | 自动生成 `ready`；统计 `automatic=1` 的比例，过高就调整提示词 |
| 简单的截屏识别也要派发 | 多一次往返和 Token | 已确认接受；观察 `useJob` 拒绝次数 |
| 多项后台任务排队访问同一设备 | 设备命令按设备串行，后台任务会变慢 | 现有队列保证正确性；独占资源由租约按（设备, 资源）排队，不同设备并行 |
| `agent_task_links` 重建失败 | 启动失败 | 迁移在事务中执行；迁移测试使用真实的旧库副本；部署前先在一次性 Core 上验证 |
| 带 `topic` 的委派留在主对话 | 负责人回答慢时，主对话会等它 | 已确认接受；观察这类委派的耗时，过长再考虑改为后台执行 |
