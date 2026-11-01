# 助手后台任务：主对话保持可响应

状态：设计已确认（2026-11-01，第 13 节四项决定），尚未实现。技术方案见 [2026-11-01-background-jobs-implementation.md](../plans/2026-11-01-background-jobs-implementation.md)。

参考：DeepSeek《Super-agent 设计探索》的双层架构（Router / Worker），以及它的原型
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。本方案只借用其中一部分：主对话负责接话和分派，长任务交给独立的后台上下文执行，再以结构化结果回报。不引入常驻 Router、事件过滤或团队授权。

本文服从 [Personal Agent 产品与领域修正](../plans/2026-10-11-personal-agent-product-correction.md)：每个助手只有一条消息流，没有“新对话”或会话列表；Conversation 是内部执行上下文，不是导航对象。

## 1. 问题

每个助手有一条连续对话（`assistant_conversations`），同一时间只有一个未结束的主人任务（`AgentModule.active`，[agents.ts:149](../../server/personal-os/agents.ts)）。任务运行中发来的消息会补进这个任务（`store.accept` 的 `steer`，[store.ts:576](../../server/personal-os/store.ts)），在模型的下一步生效。由此产生五个现象：

1. **话题混在一起。** 正在整理文件时说“顺便查一下明天的天气”，这句话被并入整理任务，两件事共用一个上下文和一个最终答复。
2. **后来的请求要排在前一个后面。** 设备调用按设备串行，每次最长约 35 秒（[devices.ts:153](../../server/personal-os/devices.ts)）；多步电脑操作可能持续数分钟，期间新请求只能等它在下一步被看到。
3. **委派会阻塞发起方。** `agent.delegate` 在子任务结束前一直让父任务等待（`this.wait(worker)`，[runtime.ts:904](../../server/personal-os/runtime.ts)）。
4. **待办执行被拒。** 助手忙时点“交给 AI 执行”会报“该 Agent 正在处理其他工作，请稍后再开始”（[todos.ts:243](../../server/personal-os/todos.ts)）。待办执行本身也走主对话（`agents.send`），会占住主对话。
5. **不能另起话题。** 任务未结束时“新话题”报“请等待当前任务结束后再开启新话题”（[agents.ts:184](../../server/personal-os/agents.ts)）。

已有的例行任务说明这条路可行：它在独立的 Conversation 里执行（[agents.ts:236](../../server/personal-os/agents.ts)），执行过程不进入消息流，结束后只发布一条 `routine-report:<taskId>` 结果；主人任务在每次模型请求前读到最近 6 条结果摘要和引用（`AgentModule.context`，[agents.ts:297](../../server/personal-os/agents.ts)）。本方案把这套机制推广到用户的长任务。

## 2. 目标与不做的事

目标：

- 长任务执行时，主对话仍能立即回答新问题、接新任务、调整或停止已有任务。
- 一个助手可以同时推进多个后台任务，互不污染上下文。
- 后台任务只在有结果、需要用户回答或无法继续时打扰用户，回报是结构化的。
- 重启、断线、审批、停止的既有语义不变。

不做：

- 不增加会话列表、子会话导航或新的联系人；用户仍只面对一条消息流。
- 不引入独立的 Router 模型或常驻会话；主对话仍是现有的主人任务，用助手自己的模型。
- 不改变权限、审批、设备授权和工具策略。后台任务属于同一个助手，权限与主对话相同，不多也不少。
- 不处理飞书群聊未 @ 消息的主动接单（另案：两级过滤与观察模式）。

## 3. 术语

| 术语 | 含义 | 代码名 |
| --- | --- | --- |
| 主对话 | 助手唯一的用户可见消息流背后的那条 Conversation，及其中的主人任务 | `assistant_conversations` / origin `owner` |
| 后台任务 | 主对话派出的一项工作：一个独立 Conversation，可以跨多个 Task 轮次 | `agent_jobs`，origin `job` |
| 任务书 | 派发时交给后台任务的内容：原始消息引用加一句备注 | `brief` |
| 回报 | 后台任务结束一轮时提交的结构化状态 | `agent_job_reports` |

“任务”在界面上已指 Task，因此界面统一叫“后台任务”。

## 4. 总体结构

```
用户（App / 飞书）
   │ 消息
   ▼
主对话（origin=owner，一个 Conversation，一个未结束 Task）
   │  job.start / job.message / job.stop        ▲ 结果摘要 + 引用（只读资料）
   ▼                                            │
后台任务 A（独立 Conversation）──回报──► 消息流（job-report:<id>）
后台任务 B（独立 Conversation）──回报──►     │
   │                                          ▼
   └─ 设备 / 连接器 / 同伴（权限与主对话相同）  未读、飞书回复
```

主对话的职责：回答和完成能马上做完的事；把长任务交给后台任务；把用户对已有后台任务的补充、追问和停止转给它。后台任务做完整的工作，不直接给用户发普通消息，只通过回报发声。

## 5. 何时派发

派发有两个入口。

**确定性入口（不经模型判断）：**

- 待办“交给 AI 执行”直接创建后台任务，不再调用 `agents.send`。待办的 `task_id` 指向后台任务当前轮次的 Task。现有触发器（[todo-schema.ts:17](../../server/personal-os/todo-schema.ts)）在 Task 成功结束时把待办改为待验收；但后台任务成功结束一轮时，可能只是提了一个问题。因此来自后台任务的待办改由回报驱动：`ready` 进入待验收，`question` 保持执行中并显示问题，`blocked` / `failed` 退回未开始。触发器需要排除这类待办。“助手忙就拒绝”的检查改为“后台名额满则排队”。
- 例行任务保持现状。它已经是后台执行，只把它的回报格式向本方案对齐（第 7 节），不迁移数据。

**模型入口：** 主对话获得 broker 动作 `job.start`。系统提示规定：预计需要多步设备或电脑操作、批量处理文件、生成图片、联系同伴，或预计超过一分钟的工作，交给后台任务；问答、单次查询、简单保存在主对话里直接完成。

文章的实验表明，单靠提示词时，模型常常选择自己动手（中性提示下 5 次运行一次都没有委派）。所以只靠提示词不够，还需要 Core 侧的约束（已确认，见第 13 节）：主人任务里不能直接调用 `device.computer`、`image.generate` 和 `agent.delegate`；调用时 Core 返回结构化错误，提示改用 `job.start`。`device.exec`、`device.read`、`device.list` 仍可在主对话直接使用，因为单次调用有 35 秒上限，能覆盖大多数简单查询。

## 6. 任务书：按引用传递上下文

后台任务不继承主对话的历史。`job.start` 的参数：

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `title` | 必填，≤ 40 字 | 显示在消息流和状态里 |
| `sources` | 必填，1–5 个 `message:<id>` | 用户原话的消息引用，至少包括触发这次派发的那条 |
| `note` | 可选，≤ 200 字 | 只写原话里没有的路由事实，例如“用户已确认用方案 B” |
| `deviceId` | 可选 | 用户指定的设备 |

规则（来自 dsh-superagent 的做法）：

- Core 把 `sources` 的原文连同附件引用放进后台任务的首条输入，并标注“以下为用户原话”。备注单独标注为“主对话备注”。
- 后台任务以原话为准。备注和标题不能替代原文，也不能新增需求；主对话不得把请求改写成计划或验收清单。
- 需要更早的背景时，后台任务用现有的 `memory.search` 按 `message:<id>` 或关键词查同一助手的消息流（[agents.ts:302](../../server/personal-os/agents.ts)）。它是同一个助手，读取范围与主对话相同。
- 后台任务开始时照常做一次记忆召回（`TaskRecall`），工作笔记按 Conversation 各自一份，互不覆盖。

## 7. 回报

后台任务每轮结束前调用 `job.report`。如果一轮结束时没有回报，Core 用最终答复补一条 `ready` 回报（结论截断到 600 字，标记为自动生成），保证每一轮都有回报，不会悄悄结束。Task 因运行错误失败时，Core 写一条 `failed` 回报，内容取错误信息；用户停止时不写回报，阶段直接显示为已停止。

| 字段 | 说明 |
| --- | --- |
| `state` | `ready`（有结果）、`question`（需要用户回答才能继续）、`blocked`（缺前提，如设备离线、权限不足）、`failed`、`dropped`（无需处理，例如问题无法复现或已被其他工作覆盖） |
| `summary` | 面向用户的结论，≤ 600 字；技术细节留在执行记录里 |
| `question` | `state=question` 时必填：一个具体问题 |
| `attachments` | 生成的文件，沿用 `/api/attachments/<id>` 绑定规则 |

另有 `job.progress(text)` 只更新内部进度，不进入消息流、不通知用户，主对话可以读到。

Core 处理回报：

1. 写 `agent_job_reports`，并以 `job-report:<reportId>` 为 `source_key` 发布到消息流（幂等，重放不重复）。`dropped` 只写记录、不发布，除非这项后台任务来自待办。
2. 主对话的易变提示（`<system-reminder>`）里增加两段只读资料，与现在的 `routineReports` 同一位置，不破坏提示缓存前缀：
   - **进行中的后台任务**：每项一行，含 id、标题、阶段、最近进度、待回答的问题；
   - **最近回报**：最多 6 条，每条摘要截断到 1200 字，并带 `message:<id>` 引用。
   提示词规定这些是资料，不是新输入，主对话不得据此重复执行或重复播报。
3. 只有 `ready`、`question`、`blocked`、`failed` 会发布到消息流并计入未读，`progress` 和 `dropped` 静默。

### 阶段（从上往下，第一条命中即为当前阶段）

| 阶段 | 条件 | 界面文字 |
| --- | --- | --- |
| 等待批准 | 后台任务的 Task 有待批准的操作 | 等待批准 |
| 等待回答 | 最近一次回报是 `question`，此后用户未回答 | 等待你回答 |
| 待验收 | 来自待办，最近回报是 `ready` | 待验收 |
| 受阻 / 失败 | 最近回报是 `blocked` 或 `failed`，此后用户未回复 | 受阻 · 失败 |
| 排队 | Task 为 `queued`，且没有占到执行名额 | 排队中 |
| 执行中 | Task 运行中 | 执行中 |
| 已结束 | 最近回报是 `ready` 或 `dropped`，Task 已结束 | 已完成 · 无需处理 |
| 已停止 | 用户或主对话停止了它 | 已停止 |

阶段由存储中的 Task、审批和回报推导，不另存状态，所以重启后结果一致。

## 8. 用户如何与后台任务交互

两条路径，对应文章里的“订阅直通”和“慢路径”：

**直通（不经模型）：** 消息流中的后台任务回报和问题卡片带“回复”和“停止”。回复时客户端带上 `jobId`，Core 直接把内容作为该后台任务的新输入（运行中则补充当前轮，已结束则开启新一轮），不经过主对话。停止直接调用 `runtime.cancel`，与现在的停止按钮一致。

**主对话判断：** 用户在主对话里随口提到某项后台任务时（“刚才那个改成 PDF”“别查了”），主对话根据易变提示里的进行中列表，用 `job.message(jobId, text)` 或 `job.stop(jobId)` 转交。只有在消息明确指向某一项（提到标题、回复了它的消息，或只有一项进行中且语义明显相关）时才转交；不确定就直接问用户，不要猜。转交时 Core 同时附上这条用户原话的引用。

主对话转交、开新任务或回答问题后，应在一句话内告诉用户它做了什么，例如“已交给后台：整理下载文件夹”。

**审批：** 后台任务里的危险操作照常产生审批，审批卡片出现在消息流中并标出后台任务标题。主对话或其他后台任务里的新输入不会让它的审批失效，这与 `store.accept` 只作废同一 Task 审批的现行行为一致（[store.ts:579](../../server/personal-os/store.ts)）。批准仍只通过审批卡片完成；主对话不能代替用户批准，也不能转交“同意”之类的话作为批准。

**新话题：** 只要主对话本身没有未结束的 Task，就可以开新话题；后台任务不受影响。

## 9. 并发与资源

- 执行名额沿用每个助手 4 个、后台最多 3 个的规则（[runtime.ts:30](../../server/personal-os/runtime.ts)）。后台任务和例行任务共用这 3 个名额，主对话始终保留 1 个。名额满时新的后台任务进入“排队”，按创建时间先后执行。
- 同一后台任务同时只有一个未结束的 Task（Conversation 级排他，现行规则）。
- **设备资源独占：** 两个后台任务同时操作同一台电脑的屏幕会互相干扰，所以独占资源按（设备, 资源）加租约。不同设备之间、同一设备的不同资源之间互不影响，只有同一设备的同一资源才排队。第一版只有一种资源：屏幕，对应 `device.computer` 的写操作；读屏不排队。以后有新的独占资源时，只需加一条映射。持有者结束一轮或被停止时释放；其他后台任务的调用会返回“屏幕正被『标题』使用”，该任务进入受阻，资源释放后自动续跑。`device.exec` / `device.read` 继续沿用现有的按设备串行队列，不加租约。
- **设备离线：** 后台任务遇到“设备离线”时回报 `blocked`。与另案“设备上线后自动续跑”合并后，可以改为等待设备上线再继续，不占执行名额。

## 10. 存储与恢复

新增表（增量迁移，不改既有行）：

```sql
CREATE TABLE agent_jobs (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_inboxes(bot_id),
 conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
 origin_task_id TEXT REFERENCES tasks(id),        -- 派发它的主人任务；待办派发为 NULL
 todo_id TEXT REFERENCES todos(id),
 title TEXT NOT NULL, brief_json TEXT NOT NULL,   -- sources、note、deviceId
 stopped_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE agent_job_reports (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES agent_jobs(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 state TEXT NOT NULL CHECK(state IN ('ready','question','blocked','failed','dropped')),
 summary TEXT NOT NULL, question TEXT, automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)),
 message_id TEXT REFERENCES agent_messages(id), created_at INTEGER NOT NULL
) STRICT;
```

- `agent_task_links.origin` 的 CHECK 增加 `'job'`。SQLite 不能直接修改 CHECK，需要按迁移规范重建该表，并保留全部行。
- `job.start` 在一个事务里完成：建 Conversation、写 `agent_jobs`、`store.accept` 首条输入、写 `agent_task_links(origin='job')`、发布一条“已交给后台：标题”的活动消息。用 `job-start:<toolCallId>` 去重；工具调用重放时返回同一个后台任务。
- 后台任务的执行记录不进入消息流（与例行任务相同，`publish` 按 origin 过滤）。
- 重启沿用现有恢复：运行中的 Task 回到 `queued` 后重新执行；不可重放的设备或连接器调用标为 `unknown`，Task 进入 `needs_reconciliation`，阶段显示为受阻。后台任务重新开始时，首条恢复说明要求它先核对外部状态，再决定是否重复对外操作。
- 遗忘（`memory_forgotten_tasks`）和归档助手的规则覆盖后台任务：归档前须先停止所有后台任务，与现在“请先停止并核对该 Agent 的未结束工作”一致。

## 11. 外部渠道（飞书）

飞书回复现在按 Task 找来源会话（`personal_feishu_messages.task_id`，[feishu/module.ts:488](../../server/personal-os/feishu/module.ts)），后台任务的 Task 不在这张表里，回报不会发回飞书。

改法：回报投递时先按 `agent_jobs.origin_task_id` 找到派发它的主人任务，再找飞书映射；审批卡片扫描（`scanApprovals`）同样按这条链路查。飞书回复限一条消息，超长时只发摘要，并附“完整结果在 App 中查看”。飞书里回复回报消息即走直通路径。

## 12. 客户端

### 现状

界面只有两套实现：

- **Web**（`src/personal/`，主界面 `AgentDesktop.tsx`）：网页版、Windows 和 Android 共用。Android 登录后在 WebView 里运行打包进 APK 的同一套页面（`WorkspaceScreen.kt`），原生的 `ChatScreen.kt` 没有接入应用。
- **Apple 原生**（`apps/apple`，共用 `NexClientKit`）：Mac 和 iOS。

两套都是：收到 `/api/events` 的变更信号后，重新拉取 `/api/state` 和 `/api/agents/messages`。每个助手只有一条消息流，客户端不使用 `state.conversations`。

和本方案相关的现有显示：

- **“正在工作”指示与停止键**取自“该助手未结束且 `origin != 'routine'` 的 Task”：Web 见 `AgentDesktop.tsx:414`；Apple 见 `Workspace.swift:162-164` 的 `unfinishedTask(s)`。输入框为空时，发送键变成“停止任务”，停止上述全部 Task。
- **流式回复**只返回 `origin='owner'` 的 Task（`index.ts:329`）。
- **例行任务**不出现在聊天的工作指示里，只在助手资料栏的“最近动态”中列出；点开后由 `RoutineOccurrenceDetail`（Apple 端为 `RoutineOccurrenceDetailView`）通过 `/api/routines/occurrence` 显示执行记录。
- **委派**在消息流里显示为居中的“已发消息给 / 消息来自”提示和折叠的“已回复给 X · 展开”。

读代码时发现一个现存问题（未实际运行验证）：委派子任务没有 `agent_task_links` 记录，`origin` 为空，能通过 `!= 'routine'` 的过滤。所以接收委派的助手在聊天里会显示“正在工作”，停止键也会停掉委派子任务。本方案把这个过滤改为 `origin == 'owner'`，顺带修正它。

### 改动

**Core 接口：**

- `/api/state` 的 `tasks[].origin` 增加 `job`，并新增 `jobs` 列表。每项含 `id, botId, title, stage, todoId, latestReport{state, summary, question, messageId}, progress, createdAt`。阶段在 Core 推导，客户端不自行计算。
- 消息流中 `job-report:` 和 `job-start:` 消息投影出 `job_id`、`job_state`。
- 新增 `GET /api/jobs/detail?id=`：返回执行记录与工具步骤，复用例行任务详情的格式。
- 新增 `POST /api/jobs/input {jobId, text, clientId}`（直通回复）和 `POST /api/jobs/stop {jobId}`。

**消息流：**

- 派发提示：居中一行“已交给后台：标题”，样式同委派提示。
- 回报卡片：标题、阶段、结论、附件。
  - `question` 状态：显示问题和“回复”。
  - 来自待办的 `ready`：显示“验收 / 修改”。
  - 进行中：显示“停止”。

  文案只写状态和必要操作，不加说明段落（按 AGENTS.md 的界面文案要求）。
- “回复”让输入框进入“回复后台任务：标题”模式，发送走 `/api/jobs/input`；取消后回到主对话。

**工作指示与停止：**

- 聊天头部和输入框的工作状态只看主人任务（`origin == 'owner'`）。
- 后台任务在头部显示“N 项后台任务”，点开是简短列表：标题、阶段、停止。
- 输入框的停止键只停主对话。资料栏增加“停止全部”。

**资料栏：**

- “最近动态”加入后台任务，与例行任务并列。
- 点开复用 `RoutineOccurrenceDetail` / `RoutineOccurrenceDetailView`，读取 `/api/jobs/detail`。

**新话题：** 主对话空闲即可使用，不受后台任务影响。

**通知：** 目前只有 Android 原生层发系统通知，它按未读数增加和新审批触发（`android/.../sync/Repository.kt:533-545`）。Web、Windows 和 Apple 端都没有系统通知。上述四种回报计入未读，所以 Android 会提醒；后台任务的审批也会照常提醒。本方案不为其他端新增通知机制。

### 各端工作量

| 端 | 改动位置 |
| --- | --- |
| Web / Windows / Android | `src/personal/api.ts` 类型；`AgentDesktop.tsx` 的任务过滤、头部、消息渲染、回复模式；`ContactSidebar.tsx` 的工作状态；资料栏与详情复用 |
| Mac / iOS | `NexClientKit` 的 `Workspace.swift`（`AgentTask.origin`、新增 `Job`、`unfinishedTask(s)` 过滤）、`CoreClient` 新接口；Mac 的 `ConversationView` / `Composer` / `InspectorView`，iOS 的 `ChatView` / `MessageRow` / `ComposerView` / `AgentDetailView` |

Android 不改原生代码，但安装包内带有网页资源，要随 Web 一起重新打包并升版本。

## 13. 已确认的决定（2026-11-01）

1. **主对话禁用长工具。** 主人任务（`origin='owner'`）不能调用 `device.computer`、`image.generate`、`agent.delegate`。Core 在授权检查时拒绝，返回结构化错误 `{ error, useJob: true }`，提示改用 `job.start`。系统提示中这三项也标为“仅后台任务可用”，避免模型反复试错。代价是简单的截屏识别也要派发后台任务，多一次派发的延迟和 Token。后台任务和例行任务不受此限制。
2. **委派在后台执行。** 主对话需要同伴时，用 `job.start` 派发后台任务，由后台任务调用 `agent.delegate`。委派在后台任务内部保持同步等待，主对话不再等待同伴。
3. **待办两处都能验收。** 待办面板保留验收入口，回报卡片也提供“验收 / 修改”，两者调用同一个待办动作，按待办版本号防止重复提交。
4. **后台并发上限沿用 3 个。** 后台任务与例行任务共用每个助手 3 个后台名额，不新增设置。是否需要按账号设总上限，等真实使用数据出来再看。

## 14. 安全与成本

- 后台任务与主对话是同一个助手，策略、设备授权、审批和记忆范围完全相同，不会因为派发而获得新权限。任务书里的原话、备注和附件都是数据，不能授权。
- 停止的范围：停止主对话当前的 Task 不连带停止后台任务（它们已经独立）。新增“停止全部”，停止该助手所有未结束的 Task，逐个复用 `runtime.cancel`（它已会连带停止委派子任务，[runtime.ts:945](../../server/personal-os/runtime.ts)）。
- 不能用并行绕过审批：领域约定“不得靠并行新 Task 绕过等待审批或 `needs_reconciliation`”（[领域模型](../plans/2026-10-07-personal-ai-os-domain-model.md)）。审批针对每次危险调用，另一项后台任务做同样的操作也要单独审批；主对话的提示词禁止为了绕开等待中的审批而重新派发同一件事。
- 成本：每项后台任务多一次首轮提示词（系统提示可命中缓存）和一次召回；主对话的易变提示多出约 1–2K Token 的列表。文章也承认，双层结构是用更多 Token 换取响应速度和稳定性。

## 15. 分阶段交付与验证

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P1 Core | 表与迁移、`job.start/message/stop/report/progress`、阶段推导、易变提示、待办改走后台任务、主对话禁用三项长工具、飞书路由 | 隔离 fixture + 假模型：派发、并行两项、补充、停止、问题与回答、审批、重启恢复、待办验收、主对话调用被禁工具时返回 `useJob`、后台任务内委派、飞书回报；迁移前后数据哈希一致 |
| P2 客户端 | Web / Windows / Android / Mac / iOS 显示回报卡片、阶段、回复与停止 | 各端按 [验证规范](../verification/README.md) 在隔离环境验证；Apple 端在 Mac 上构建测试 |
| P3 观察 | 指标：主人任务时长分布、运行中收到新消息的次数、后台派发率、被禁工具的拒绝次数、回报数和问题数 | 一周真实使用数据，对比上线前；据此判断是否需要按账号设并发总上限 |

验收标准：

1. 后台任务运行时发送新问题，主对话在一轮内回答，且不出现在后台任务的上下文中。
2. 两项后台任务同时执行，各自回报，执行记录互不包含对方内容。
3. 回复问题卡片、停止按钮、主对话转交三条路径都能到达正确的后台任务。
4. 审批、停止、重启、遗忘、归档的现有测试全部通过，并新增后台任务版本。
5. 消息流里只出现派发提示、回报和问题，不出现后台执行过程。
