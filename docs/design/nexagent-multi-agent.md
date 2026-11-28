# NexAgent 多 Agent 协作：Orca 调研与设计方案

状态：调研完成，设计与 Web 视觉稿已确认，Web 前端界面原型已落盘，第 0 期实测与后端/执行器待实现。

2026-11-28 按用户意见修订：

- 流程不固定；协作命令行定名为 `nex`；界面中文名定为“协作”（代码名 `team`）。
- 协作由用户的提示词开启，之后交给主会话自己决定，单个主会话（单次协作）最多 5 个工人。
- 设置“Agent 可自行派活”默认关；“询问”模式下默认单独放行纯 `nex` 单条命令；不加手动派活的入口。
- 工人不能再派活，但可以用自己的子代理。
- 界面复用现有的主子会话层级，补充同一主会话多轮协作的历史工人折叠规则，并固化 Web 前端视觉规范；Apple 端后续再补（正式发版前对齐）。

参考：

- [stablyai/orca](https://github.com/stablyai/orca)（MIT）：调研基于 commit `d1a3598f`（2026-11-27）。下文出现的 Orca 路径都相对这个仓库的根目录。
- 本仓库：[Agent 模式](agent-mode.md)、[NexAgent 工作台](nexagent-workbench-v1.md)。

**目标**

NexAgent 里的会话能把工作派给其他编程 Agent（Claude Code、Codex、Antigravity CLI），收回结果，再安排后续工作。怎么拆、派给谁、要不要审查，都由派活的会话按用户的要求决定，NexBot 不规定流程。

用户举的一个例子：Claude 出方案，派 AGY 实现，再让 Codex 审查，最后由 Claude 交付。

## 0. 结论

1. **Orca 的协调者就是一个普通的 CLI Agent。** Orca 不替 Agent 拆任务，只是给它一套命令（`orca orchestration …`）和一份技能文档，派给谁、派什么由 Agent 自己决定。Orca 本身只做三件事：
   - **记账**：Run、任务（可以带依赖）、指派（每次尝试）和消息，都存在 SQLite 里。
   - **派活**：在指定目录启动指定的 CLI，等它就绪，再把“工人前言 + 任务”粘贴进去。
   - **叫醒**：工人汇报后，等协调者空闲，往它的终端里打一行固定提示（“你有 N 条消息，运行 `orca orchestration check`”）；聊天模式下则把整条消息作为一轮用户输入发过去。

   Orca 早期有内置的轮询协调器，现在已经停用（`orchestration run` 不再生效），改成由 Agent 当协调者。
2. **完成要靠工人明确汇报，不靠猜。** 汇报（`worker_done`）必须带任务 ID、指派 ID 和结果。以下三种情况，协调者都会收到一封“升级”消息：
   - 工人一轮结束了却没汇报；
   - 停在审批上；
   - 进程退出。
3. **NexAgent 已经有大半底座。** 现有的包括：每轮结束的事件（`cli.turn`）、每个会话一个消费者的发送队列（工作台 outbox）、新建会话和 worktree、审批卡和监督器。还缺三块：
   - 会话内部调用 NexBot 的通道；
   - 协作账本；
   - Core 里的协作调度器。
4. **建议做法：**
   - **协作工具做成命令行 `nex`。** NexBot 启动的每个会话，PATH 里都有这个命令，不需要先建一个“协作会话”。命令按调用它的会话认人，不依赖对话里的 ID，上下文压缩后也不会丢。
   - **用户用提示词开启协作。** 用户在对话里提出协作，就算同意；之后派几个工人、派给谁、什么时候派、来回几轮，都由主会话自己决定，NexBot 只设上限：单个主会话（单次协作）最多 5 个工人。
     - 界面上不加手动派活的入口。
     - 设置“Agent 可自行派活”默认关；打开后，主会话不等用户提出，也能自己开启协作。
     - “询问”模式下默认放行纯 `nex` 单条命令免审批（不含 shell 拼接/管道/重定向）。
   - **只有主会话能派活。** 工人不和用户直接对话，所以不能再派；复杂的部分可以用它自己的子代理完成，由工人自己决定。
   - **不固定流程。** NexBot 只提供几个基本动作：派活、发消息、汇报、提问、读记录、停止，外加安全上限。先后、并行、互审、来回修改，都由主会话按用户的话组合。
   - **叫醒复用工作台 outbox。** 往终端里只打固定的一行提示，正文用 `nex inbox` 读取；AGY 和 Codex 原生队列可以整条投递。
   - **界面复用现有的主子会话层级。** 工人挂在主会话下面，不另做协作页面。1 期先完成 Web 前端（Windows/Android 共用），Apple 端后续补一层树与协作视图。

## 1. Orca 是怎么做的

### 1.1 对象和角色

| 对象 | 含义 | 关键字段与状态 |
| --- | --- | --- |
| Run | 一次协作的命名空间，也是协调者的收件箱 `run:<id>` | 协调者句柄；`consumer_generation`，换协调者时用来隔离旧的 |
| Task | 一项工作 | spec、deps（JSON 数组）；状态有 pending、ready、dispatched、completed、failed、blocked |
| Dispatch | 某个任务的一次尝试，绑定到一个终端或聊天 | 指派对象、进程标识、retry_of、失败次数；状态有 pending、dispatched、completed、failed、circuit_broken |
| Message | 消息 | 类型有 status、dispatch、worker_done、merge_ready、escalation、handoff、decision_gate、question、heartbeat；另有优先级、已读、投递状态 |
| Delivery | 一次 `check` 取走的一批消息 | 每个收件箱同时最多一批未确认 |
| Decision gate | 协调者定下的待决问题，用来挡住某个任务 | 以第一次回答为准 |

表结构见 `src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts`。

协调者没有专门的程序：用户正在用的 Claude Code 或 Codex 会话，读了技能就成了协调者。工人是协调者用 `worker-start` 启动的另一个会话，可以是另一种 CLI（`--agent claude|codex|antigravity|cursor|…`）。

### 1.2 Agent 怎么学会协作

- **协调者靠技能。**
  - 技能文件 `skills/orchestration/SKILL.md` 只是个很短的入口：教 Agent 找到 `orca` 可执行文件，再运行 `orca skills get orchestration`，从当前这份 Orca 读出与版本匹配的完整说明（`skill-guides/orchestration.md` 和 `references/*.md`）。
  - 技能本体放在 `~/.agents/skills`，再链接到 `~/.claude/skills` 和 `~/.gemini/config/skills`；Codex 直接读 `~/.agents/skills`。
- **工人靠前言，不需要技能。** 前言里有身份、任务 ID、指派 ID 和三条命令：`ask`、`send --type escalation`、`send --type worker_done`，还有“汇报后回到空闲、不要轮询”等规则。代码在 `src/main/runtime/orchestration/workers/launch/worker-dispatch-preamble.ts`。
- **每条命令都显式带 `--from <handle>`**，原因见 1.7。
- **说明里有大量“不要这样做”：**
  - 不要轮询。
  - 不要用 heredoc，它会卡住 shell。多行内容先写进文件，再用 `--body-file` 传。
  - 命令失败了不要自己重试。
  - 不要用 AskUserQuestion 这类本地提问，协调者看不到。

### 1.3 派活：`worker-start`

1. CLI 读取 `--spec`、`--agent`、`--worktree current|new-child|new-top-level`，以及可选的 `--model`、`--effort`，然后调用运行时的 RPC。
2. 选终端还是聊天：默认用终端；用户把这个 Agent 设成聊天时用聊天。SSH、WSL 等场景退回终端。
3. 需要时先建 worktree，再按注册表（`src/shared/agent-launch/catalog/tui-agent-config.ts`）启动 CLI。启动时关掉自动更新提示、预先写入目录信任、按权限设置传参。
4. 等 CLI 就绪，默认最多等 60 秒。
   - 就绪的判断综合钩子、窗口标题、OSC 7501 状态和屏幕上的输入框。
   - 超时后转到后台继续等。
   - CLI 没装，也表现为就绪超时。
5. 投递前言和任务：
   - **聊天**：作为一轮结构化的用户输入发送。
   - **终端**：
     - 整段文字用括号粘贴（`ESC[200~ … ESC[201~`）一次写入，回车单独写。
     - Claude 要先打一行引导语，否则它会忽略粘贴进来的大段说明。
     - Codex 会丢掉和粘贴放在同一次写入里的输入。
   - **回车时机**：等界面渲染完才回车。Windows 上按 ConPTY 每毫秒 64 字节估算等待时间，Codex 每个字符再加 3 毫秒。回车后输入框里还留着这段文字，就再按一次。
6. 回执带任务 ID、指派 ID 和下一步：“结束本轮，Orca 会叫醒你。”

### 1.4 汇报、提问和升级

- **`worker_done`**：在一个事务里写入消息、结算指派和任务、记录回执，然后叫醒协调者。
  - 调用方由服务端自己记录的“哪个面板、哪个进程”认定，调用参数冒充不了（源码原话：caller params never supply lifecycle authority）。
  - 发错指派、旧进程补报、重复汇报，或被拒绝，或按重复处理。
  - `outcome=failed` 只表示没法完成，比如没有仓库权限。做完了但测试没过，仍算 succeeded，问题写进正文。
- **`ask`**：立即返回 pending，工人随即结束本轮。答复作为消息送回，同样会叫醒工人。
- **一轮结束却没汇报**：只发一封升级消息，用稳定的 ID 去重，比如 “Worker stopped without reporting”、“Worker is waiting on a prompt”。以下情况不算没汇报：工人正在 `check --wait`，在等答复，或者还有没结束的子工人。
- **进程退出**：指派判为失败，任务回到 ready。同一个任务连续失败 3 次就熔断，只能由用户决定是否重开。
- **审批**：工人停在权限提示上时，Orca 会通知协调者，但默认只有人能批准。打开设置后，协调者也能代批，以先回答的为准。

### 1.5 叫醒

| 收件方 | 投递方式 |
| --- | --- |
| 终端里的 Agent | 只打一行固定提示 ``You have N orchestration message(s). Run `orca orchestration check`.``，再单独回车。**消息正文从不打进终端。** |
| 聊天里的 Agent | 每封消息作为一轮用户输入，带 From、Subject 和回复方式，排在当前工作的后面。消息太大时改发提示。 |

终端投递的细节（`src/main/runtime/orchestration/mailbox/terminal-pointer/`）：

- **Agent 正在工作也可以投递**：已知的 CLI 会把新输入排进队列；不认识的程序在忙时先扣住。
- **扣住的情况**：
  - 有审批或对话框；
  - 用户的输入框里有草稿；
  - 重启后屏幕还没恢复；
  - Agent 正在休眠。

  最多扣 10 分钟，每 2 秒重查一次。设上限是因为按 Esc 关掉对话框不会触发钩子。
- **防重复**：每封消息记“已预留、已写入、已回车”三种状态，并绑定终端和进程。崩溃后，已经写过的就算已投递、不再重打；消息保持未读，等 Agent 自己 `check`。
- **回车没生效**：输入框里还是那行提示，就再按一次回车。还不行就不再往里写，只通知协调者。

`check` 一次最多取 50 封，取走即确认。结尾会告诉 Agent 下一步：“还有消息，再 check 一次”，或者“结束本轮，不要轮询”。

### 1.6 怎么判断一轮结束

- **钩子**：给每个 CLI 装钩子，钩子带令牌 POST 到本机 `127.0.0.1:<port>/hook/<agent>`。
  - 端口和令牌每次都从文件重读，所以 Orca 重启后，已经在跑的会话也能连上。
  - 连不上时先写进 spool 文件，之后补报。
  - Claude 的钩子装在 `~/.claude/settings.json` 或插件目录；Codex 的装在 Orca 自己的 CODEX_HOME；agy 的装在 `~/.gemini/config/hooks.json`。
  - agy 会在 10 秒后杀掉钩子，所以 Windows 上钩子用原生 exe 运行，不启动 Electron。
- **屏幕证据**：钩子之外，还看窗口标题、OSC 7501、输入框的样子和输出是否安静。每种 CLI 一套规则（`src/main/runtime/agent-state-rules/*.json`）。例如 Codex 会先发 Stop、再画出计划菜单，所以屏幕上出现 “Proposed Plan” 时要多等 750 毫秒。
- **工人停下**：钩子状态变化后，再安静 1.5 秒，才记一次“完成”“出错”或“等输入”。

### 1.7 用命令行要处理的坑

Orca 也是命令行，下面这些坑都踩过。`nex` 要一开始就处理，做法见第 7 节。

- **Windows 的 `.cmd` 会改坏参数**：`%`、`^`、引号和换行都会出问题。Orca 的 `orca.cmd` 遇到会被 cmd.exe 改坏的正文直接拒绝，Windows 上改用原生启动器（`src/main/cli/launchers/orca-cli-child-path.ts`）。
- **长文本不能走 shell**：
  - PowerShell 5.1 把管道内容传给原生程序时按 ASCII 编码，中文会变成问号。
  - heredoc 和 here-string 在 Agent 的 shell 工具里会卡住。
  - 所以长文本一律先写文件，再传路径。
- **环境变量会被剥掉**：
  - Codex 的 `shell_environment_policy` 丢过 Orca 的 `ORCA_TERMINAL_HANDLE`（#25775）。
  - Claude 的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 会去掉名字含 KEY、TOKEN 的变量。
  - Orca 的办法是每条命令都写 `--from <句柄>`。这样身份就落在了对话里，上下文压缩后可能丢失。
- **沙箱读不到可执行文件**：Windows 上 Codex 的沙箱用另一个账号跑命令，读不到 Orca 的安装目录（#49301），只能请求提权后重跑。
- **Orca 自身的其他问题**：
  - 钩子写进用户的全局配置：`~/.claude/settings.json`、`~/.gemini/config/hooks.json`，Codex 则换了一个单独的 CODEX_HOME。NexAgent 只用每个会话自己的 `--plugin-dir`，这一点要保持。
  - 失败任务的下游一直停在 pending。
  - 心跳只记时间，不判超时。

## 2. NexAgent 现状：能复用什么、缺什么

| 需要的能力 | NexAgent 现在 | 本方案 |
| --- | --- | --- |
| 在指定目录启动指定的 CLI | `cli.op start`，支持新 worktree（`DeviceGit.worktree()`）、模型、effort、权限 | 复用，加上 `team` 参数 |
| 知道一轮结束 | `cli.turn` → `CliTurnEvent` → `hub.onTurnEnd`。来源：Claude 的 Stop 钩子、Codex 的 rollout、AGY 的 ACP 回调 | 复用，并补上断线时丢掉的轮次结束 |
| 空闲后再发、不重复发 | 工作台 outbox：每个会话一个消费者，等轮次结束再发；结果不确定就暂停，不重发 | 复用：一封协作消息就是一条 outbox 条目 |
| 审批和提问卡 | `cli.request` 和请求卡，手机上可以回答 | 复用。工人的审批仍归用户 |
| 自动动作前的安全检查 | 监督器：动作前重读会话；用户 120 秒内有输入就不动 | 复用同一套检查 |
| 读工人的记录 | `cli.read`，能解析 Claude、Codex、AGY 的记录；助手用的 `readView` 有截断 | 复用。Orca 读不了终端里 agy 的记录，这一点 NexAgent 更好 |
| 会话树 | `cli_agent_workbench`，kind 为 main、fork、side | 加 `worker` |
| 会话内调用 NexBot | **没有**。只有 Claude 钩子管道，且只收 question、permission、post、stop | **新增** `nex` 命令和会话管道 |
| 协作账本 | **没有** | **新增**，见第 8 节 |
| 调度器 | **没有**。监督器只管单个会话 | **新增** Core 协作调度器 |

现状里还有几点要注意：

- **AGY 不是终端。** 它在 NexAgent 里是 `agy acp` 子进程，没有 PTY。空闲 5 分钟后进程会退出，下次用 `session/load` 接回来。所以 AGY 天然走结构化通道，可以整条投递。
- **新会话默认权限是 full。**
  - Claude 会带 `--dangerously-skip-permissions`，Codex 会带 `--dangerously-bypass-approvals-and-sandbox`。
  - 协作会派生出更多会话，所以每个工人都要能单独指定权限（7.3）。
  - 现有的 `readonly` 模式在 Codex 上对应 `sandbox_mode=read-only`。
- **broker 工具的审批不再强制。** 自 2026-11-27 的提交 75487ffd 起，`policy.ts` 的 `evaluateTool` 恒返回 false，助手 broker 工具（`cli.start/send/interrupt`）不再要求审批。协作不能依赖这一层，要有自己的规则。
- **轮次结束可能丢失。** 断线期间 `TurnTracker.report` 会直接丢弃上报；`lastTurns` 和轮次计数也只在内存里。调度器不能只靠“轮次结束”这一个事件，要能按会话状态补齐。
- **浏览器收不到会话树的更新。** `hub.ts` 定义了 `onWorkbench`，但没有任何地方订阅；`stream.ts` 不转发，`use-workbench.ts` 却在等这些推送。协作视图要一并补上。
- **Codex 原生队列有条件。** `codex queue` 要求 Codex 0.172 以上；Windows 上还必须是 `codex.exe`（不能是 `codex.cmd`），一条消息约 16K 字符封顶。用不了队列时，发给 Codex 的消息走终端输入。

## 3. 目标与不做的事

**目标**

- 用户在提示词里提出协作后，NexBot 启动或接管的会话就可以把工作派给其他会话，并收回结果。派几个、派给谁，由它自己决定，最多 5 个工人。
- 流程不固定。先后、并行、互审、多轮修改，都由主会话按用户的话决定；NexBot 只提供基本动作和上限。
- 工人可以是 Claude Code、Codex 或 Antigravity CLI，主控也可以是其中任何一个。
- 每个工人都是普通的 NexAgent 会话：可以打开、看记录、接手，也能在里面回答它的审批。
- 断线、重启或某个工人失败时，不重复派活、不丢汇报，主控和用户都知道发生了什么。

**不做的事**

- Core 不运行 CLI，也不保存 CLI 的凭据（沿用 Agent 模式的原则）。
- 不用无头模式，工人也是交互式会话；AGY 照现状走 ACP。
- 不改用户的全局 CLI 配置。第一版只给 NexBot 启动的会话提供命令。把 `nex` 装进系统 PATH、让用户自己的终端和桌面应用也能用，放到第 3 期，由用户在设置里打开。
- 工人不能再派工人。只有和用户直接对话的主会话能派活；工人复杂的部分可以用它自己的子代理完成（比如 Claude 的 Task 工具），用不用由工人决定。
- 界面上不加手动派活的入口，派活只由提示词触发。
- 不自动推送、部署、合并到主分支或删除分支，这些仍然由用户本人批准。
- 第一版不跨设备派活，工人和主控在同一台电脑上。

## 4. 术语

| 术语 | 含义 | 代码名 |
| --- | --- | --- |
| 协作 | 一个主会话和它派出的工人，相当于 Orca 的 Run。主会话第一次派活时自动创建 | `team` |
| 主会话（主控） | 和用户直接对话、负责派活的会话 | `lead` |
| 工人 | 主会话派出的会话。不和用户直接对话，不能再派活 | `worker` |
| 任务 | 派给工人的一项工作。角色是自由填写的标签，比如实现、审查、调研 | `team task` |
| 指派 | 把某个任务交给某个工人的一次尝试 | `dispatch` |
| 协作消息 | 主控和工人之间的消息：任务、汇报、提问、答复、升级、通知 | `team mail` |
| `nex` | 会话里可用的命令行，主控和工人都用它 | |

代码里统一叫 `team`，以免和现有的 “Agent”（助手联系人）及 `cli-agent` 混用。

## 5. 方案选择

### 5.1 谁来编排

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A. 主控自己派活（Orca 的做法） | NexBot 只提供基本动作，主控决定怎么拆、派给谁、要不要审查 | **采用。** 灵活，能覆盖用户的各种说法 |
| B. NexBot 固定流水线 | NexBot 按预设的顺序依次给各会话发消息，再从回复里抽结果 | 不采用。流程太死；只能靠轮次结束和回复的文字猜进度；Orca 也已经放弃了内置协调器 |
| C. Pi 助手当协调者 | 助手用 broker 工具驱动各个 CLI 会话 | 放到后期，接到同一套调度器上即可 |

调度器只做确定性的事：记账、投递、催促没汇报的工人、依赖失败时阻塞下游、执行上限。它不判断工作该怎么做。

### 5.2 会话怎么调用 NexBot

| 方式 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 命令行 `nex` | 三种 CLI 都能运行 shell 命令；不用在启动时挂载，NexBot 启动的任何会话随时能用；用户和脚本也能用；以后装进系统 PATH，桌面应用里的会话也能用 | 要处理参数、编码、环境变量和沙箱（1.7） | **主通道**（Claude、AGY、Codex `full` 模式） |
| 单次启动 MCP 轻桥接 | 参数是结构化的；运行在沙箱外，不受 Windows 受限令牌命名管道 `EPERM` 限制；Codex 可用 `-c mcp_servers.nex.tools.<name>.approval_mode="approve"` 零拼接风险免审批 | 只能在启动时挂上，老会话用不了 | **第 1 期用于 Codex 沙箱/`ask`/`readonly` 会话**（第 0 期实测通过，无需改 `~/.codex/config.toml`） |

## 6. 总体结构

```
网页、Windows、Android（共用 Web UI）；Mac、iOS（SwiftUI）
   │  HTTP /api/cli-agents/teams/*；WebSocket 推送 cli.team
   ▼
Core
   ├─ CliAgentHub（现有）：会话、轮次结束、请求
   ├─ 工作台 outbox（现有）：按会话排队投递
   └─ 协作调度器（新增）：账本、派活、结算汇报、叫醒、升级、上限
   │  DCP：cli.op start 带 team 参数；新增 cli.team.call 和 cli.team.result
   ▼
电脑上的设备执行器
   ├─ Agent 桥（现有）
   ├─ 会话管道（扩展现有的钩子管道，鉴权方式相同）
   └─ bin/nex（新增）：启动会话时加进它的 PATH
          Claude、Codex：经 herdr-core 终端的环境
          AGY：经 ACP 子进程的环境
```

一次命令的路径：CLI 的 shell 工具运行 `nex …` → 本机会话管道（带会话凭据）→ Agent 桥 → `cli.team.call` → Core 调度器，结果原路返回。

账本放在 Core，所以以后主控和工人可以在不同的电脑上，由 Core 转发（第 3 期）。

## 7. `nex` 命令

### 7.1 怎么放进会话

- **目录和脚本**：NexBot 在数据目录里放一个 `bin` 目录。
  - Windows 上有两个入口：`nex.cmd`，给 PowerShell 和 cmd 用；无扩展名的 sh 脚本 `nex`，给 Git Bash 用（Windows 上的 Claude 优先用 Git Bash）。
  - Mac 上是一个 sh 脚本 `nex`。
  - 脚本用钩子已经在用的运行时（`NEXBOT_HOOK_NODE` 加 `ELECTRON_RUN_AS_NODE=1`）执行 `nex.mjs`。
- **加进 PATH**：启动或继续会话时，把这个目录加到 PATH 的最前面。nex_bot 终端（Claude、Codex）经 herdr-core 的 `terminal.run` 环境，AGY 经 ACP 子进程的环境。
- **两个环境变量**：同时写入 `NEX_PIPE`（管道地址）和 `NEX_SESSION`（会话凭据）。名字里不带 KEY、TOKEN、SECRET，以免被 Codex 和 Claude 剥掉。
- **老会话**：这个功能上线前就在运行的会话，PATH 里没有这个目录，下次继续时会自动带上。
- **参数规则**（第 0 期实测确认）：
  - 参数里只放名字、ID 和枚举值。
  - 正文一律用 `--file <路径>`，由 `nex` 自己按 UTF-8 读取（Windows 下 `cmd.exe`、PowerShell 5.1、Git Bash 均已实测字节级通过）。
  - `--text` 只用于不含 `%`、`^`、`"` 和换行的短句（实测 PowerShell 即使使用单引号调用 `nex.cmd`，`cmd.exe` 的 `%*` 仍会展开 `%VAR%` 并吞掉内嵌 `"`；Git Bash 走 POSIX `nex` 无此问题）。
  - 如第 2 期需要行内自由文本参数，再改为原生 `nex.exe` 启动器。
- **沙箱回退通道**（第 0 期实测确认）：
  - Windows 上 Codex 受限令牌沙箱访问默认 DACL 命名管道会报 `EPERM`，但同环境下回环 HTTP（`127.0.0.1` + 每会话 HMAC Bearer）可通；更优解是对 Codex 沙箱/`ask`/`readonly` 会话直接以单次启动参数 `-c mcp_servers.nex=...` 挂载沙箱外 MCP 轻桥接（零全局配置改动）。

### 7.2 身份

- **会话管道**：设备执行器把现有的钩子管道扩展成会话管道。凭据格式和钩子令牌一样（HMAC 加会话引用），claude、codex、agy 三种引擎都认。凭据只在 NexBot 持有这个会话期间有效。
- **兜底**：环境变量被剥掉时，`nex` 把自己的进程号发给执行器。执行器沿父进程往上找，找到 NexBot 管理的终端或 ACP 进程，就认定是那个会话。都找不到就拒绝，提示“只能在 NexBot 启动的会话里使用”。（第 0 期实测确认三端均未剥离 `NEX_PIPE`/`NEX_SESSION`；且 Windows 11 已移除 `wmic.exe`，PowerShell `Get-CimInstance` 耗时 1.1–3.2 秒，因此常规调用绝不走 WMI 父进程查询，仅在确实缺失环境变量时触发并缓存或使用 Win32 轻量查询。）
- **命令里不带 ID**：协作、任务、指派的 ID 都不用写。Core 按会话查出调用方是谁、手上是哪个指派，所以冒充不了，上下文压缩后也不会丢。旧指派、别的会话发来的、重复的汇报，一律拒绝或按幂等处理。

### 7.3 命令

**主控用**

| 命令 | 作用 |
| --- | --- |
| `nex agents` | 这台电脑上能派的 Agent：是否已安装、版本、能用的权限模式 |
| `nex start <agent> --title <标题> --file <任务说明> [选项]` | 派出一个工人，返回它的名字（如 `agy-1`）。第一次派活时自动创建协作。选项见下 |
| `nex status` | 列出所有工人：角色、任务、状态、权限、最近一次汇报的摘要，以及未读消息数 |
| `nex inbox` | 读取新消息并标为已读 |
| `nex send <工人> --file <正文>` | 给工人发消息。对方已经汇报过的，自动开一个跟进任务 |
| `nex reply <消息ID> --text <答复>` | 回答工人的提问 |
| `nex read <工人> [--limit n]` | 读工人最近的记录，截断规则同 `readView` |
| `nex stop <工人> [--reason <原因>]` | 中断工人，并结束它的指派 |
| `nex done --file <交付摘要>` | 声明交付完成：协作结束，并通知用户。还有工人没结算时会拒绝，并列出是哪些 |
| `nex guide` | 打印与当前版本一致的完整用法 |

`start` 的选项：

- `--role <标签>`：自由填写，只用于显示，比如“实现”“审查”。
- `--in here|worktree|<工人>`：工作目录。`here` 是主控的目录（默认）；`worktree` 是从主控当前分支新开的 worktree；也可以写某个工人的名字，用它的目录，适合审查。
- `--after <工人,…>`：等这些工人汇报成功后再启动。
- `--model`、`--effort`、`--permissions`：不写就用偏好里的默认值。

工人运行 `start` 一律拒绝，提示“工人不能派活，复杂的部分可以用你自己的子代理”。

**工人用**

| 命令 | 作用 |
| --- | --- |
| `nex task` | 读当前任务：协作规则、任务说明、工作目录、基线提交，以及主控后来补充的消息 |
| `nex ask --text <问题> [--options a,b]` | 向主控提问，立即返回；答复会作为消息送回 |
| `nex report --outcome succeeded\|failed --file <汇报> [--files a,b] [--findings <json 文件>]` | 每个指派只报一次，参数含义见下 |
| `nex escalate --file <说明>` | 卡住了，需要主控处理 |
| `nex inbox` | 同主控 |
| `nex note --text <进度>` | 记录进度，不叫醒主控 |

`report` 的参数：

- `failed` 只表示没法完成。做完了但有问题，仍报 `succeeded`，问题写进汇报。
- 审查类任务用 `--findings` 逐条列出问题，格式是 `[{severity, file, line?, issue}]`。

**输出**

- 默认输出短文本，最后一行写下一步该做什么；加 `--json` 输出结构化结果。
- 会改状态的命令都打印回执。回执丢了（超时或断线）时，只打印“结果待确认”和查询方法，不让 Agent 自己重试，沿用“变更操作不自动重发”的规则。

### 7.4 让主控知道有这套命令

工人不需要额外说明，第一条消息已经交代清楚（7.5）。主会话需要一段短说明：用户要你用协作的方式做、让别的 Agent 做事、拆开并行或请别的 Agent 审查时，先运行 `nex guide`。设置“Agent 可自行派活”打开时，说明会换成“你觉得需要时也可以自己派”。说明这样送到各引擎：

- **Claude**：放进 NexBot 插件目录的 `skills/nex/SKILL.md`，随 `--plugin-dir` 加载，不碰 `~/.claude`（第 0 期实测通过）。
- **AGY**：通过 ACP `session/new` 的 `_meta.antigravity.systemPrompt.append` 下发（第 0 期实测通过，且跨进程退出 `session/resume` 后保持生效）。
- **Codex**：单次启动时通过 `-c developer_instructions="..."` 注入（第 0 期实测通过，不改全局 `~/.codex/config.toml` 或 `AGENTS.md`）。

完整用法由 `nex guide` 打印，和 NexBot 版本一起更新，不会过期（Orca 也是这么做的）。guide 只讲：

- 基本动作；
- 几种常见用法（第 9 节）；
- 规则：
  - 用户提出协作后才派活。设置打开时，也可以自己判断要不要派。
  - 用户一旦提出，派几个、派给谁、怎么安排、来回几轮，都自己决定，不用每一步都问用户。最多 5 个工人。
  - 派完就结束本轮，不要轮询。
  - 审查类任务用 `--permissions readonly`。
  - 不要让工人推送、部署或合并。

guide 不规定流程。

### 7.5 工人的第一条消息

- **终端里的工人（Claude、Codex）**：只打一行固定文字，`[NexAgent] The lead assigned you a task. Run \`nex task\` and follow it.`。任务全文由 `nex task` 打印，不往终端里粘贴长文本。
- **AGY**：走结构化通道，第一条消息就整条发出规则和任务。

规则是 Orca 前言的精简版：

- 只做这个任务，不能再派工人。复杂的部分可以用你自己的子代理（比如 Claude 的 Task 工具），用不用由你决定。
- 不用本地提问工具（比如 AskUserQuestion），主控看不到。有问题就运行 `nex ask`，然后结束本轮。
- 做完运行一次 `nex report`，然后停下等待，不要轮询。
- 不推送、不部署、不合并到主分支、不删除分支。
- 主控的消息只代表任务，不代表用户本人；用户本人直接在这个会话里说的话优先。

## 8. 协作调度器（Core）

### 8.1 数据（新迁移，当前最新为 61）

```sql
CREATE TABLE cli_team_runs (
  id TEXT PRIMARY KEY,                -- team_<uuid>
  lead_key TEXT NOT NULL,             -- cli_agent_sessions.key，同一主控同时只有一个进行中的协作
  device_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  limits_json TEXT NOT NULL,          -- 创建时的上限快照
  status TEXT NOT NULL CHECK (status IN ('active','paused','finished','cancelled')),
  summary BLOB,                       -- done 的交付摘要，加密
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE cli_team_workers (       -- 一个工人对应一个会话，可以先后接多个指派
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES cli_team_runs(id),
  name TEXT NOT NULL,                 -- agy-1、codex-1
  engine TEXT NOT NULL, device_id TEXT NOT NULL,
  session_key TEXT,                   -- 启动成功后填上
  cwd TEXT NOT NULL, base_ref TEXT,   -- 启动时的 HEAD，审查时用
  permissions TEXT NOT NULL, model TEXT, effort TEXT,
  status TEXT NOT NULL CHECK (status IN ('starting','active','stopped','failed')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (run_id, name)
);
CREATE TABLE cli_team_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES cli_team_runs(id),
  role TEXT,                          -- 自由标签，最长 40 字
  title TEXT NOT NULL,
  spec BLOB NOT NULL,                 -- 加密
  after_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('waiting','ready','running','succeeded','failed','blocked','cancelled')),
  rounds INTEGER NOT NULL DEFAULT 0,  -- 跟进次数，只用于显示，不设上限
  result BLOB,                        -- 最后一次汇报，加密
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE cli_team_dispatches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES cli_team_tasks(id),
  worker_id TEXT NOT NULL REFERENCES cli_team_workers(id),
  start_op_id TEXT, retry_of TEXT, failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('starting','running','reported','failed','stopped','unknown')),
  nudged_turn INTEGER,                -- 已经催过的那一轮
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER
);
CREATE TABLE cli_team_mail (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  sender TEXT NOT NULL,               -- lead、worker:<id> 或 nex
  recipient TEXT NOT NULL,            -- lead 或 worker:<id>
  type TEXT NOT NULL CHECK (type IN ('task','report','question','answer','escalation','message','notice')),
  subject TEXT NOT NULL, body BLOB NOT NULL, payload_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','queued','delivered','read','held')),
  outbox_id TEXT, reply_to TEXT,
  created_at INTEGER NOT NULL, delivered_at INTEGER, read_at INTEGER,
  UNIQUE (run_id, seq)
);
```

- **会话树**：`cli_agent_workbench.kind` 加上 `worker`，`parent_id` 指向主会话，会话列表沿用现有的树，就能把工人挂在主会话下面（第 11 节）。SQLite 改不了已有的 CHECK 约束，所以要重建这张表。
- **加密和审计**：消息正文和任务说明跟 `cli_agent_items` 一样加密保存。每个动作都写审计，动作方记为 `team:<协作 ID>:<工人名或 lead>`。

### 8.2 状态

- **任务**：
  - 主线是 `waiting`（等依赖）→ `ready` → `running` → `succeeded` 或 `failed`。
  - 另有 `blocked`（依赖失败或被扣住）和 `cancelled`。
  - 依赖失败时，调度器把下游标成 `blocked` 并告诉主控。Orca 的下游会一直停在 pending，这里不照搬。
- **指派**：
  - 主线是 `starting` → `running` → `reported`、`failed` 或 `stopped`。
  - 启动结果不确定（超时或断线）记为 `unknown`，不自动重试，只告诉主控；之后会话出现了再接上。
  - 同一个任务连续启动失败 3 次就熔断，主控不能再重试，只能交给用户。

### 8.3 派活（`nex start`）

1. **检查**：
   - 设置“派活”没有关闭。
   - 调用方不是工人。工人调用一律拒绝，这一条是硬规则。
   - 协作没有暂停，工人数还没到 5 个。

   用户有没有在提示词里提出协作，NexBot 无法可靠判断，所以不在这里检查，只写进主会话的说明里（7.4），由 5 个工人的上限兜底。
   - 引擎在偏好允许的范围内，这台电脑装了这个 CLI，执行器支持 `team` 能力。
2. **建记录**：调用方还没有进行中的协作时，先建一个，它就是主控。再写入任务、工人和指派，指派状态为 `starting`。工人名用引擎名加序号。
3. **定目录**：
   - `here`：主控的目录。
   - `worktree`：走现有的建 worktree 流程，分支名为 `team/<协作短名>/<工人名>`。
   - 工人名：那个工人的目录。

   同时记下 `base_ref`，即设备上 `git rev-parse HEAD` 的结果。
4. **启动会话**：发 `cli.op start`，带上引擎、目录、权限、模型，以及 `team: {run, worker}`。设备据此把 `nex` 加进 PATH、写入会话凭据，并在会话树里把它标成 `worker`。
5. **投第一条消息**：会话出现后，填上 `session_key`，状态改为 `running`，然后投递第一条消息（7.5）。投递走工作台 outbox：`delivery: queue`，`requestId` 用消息 ID。Codex 新会话已有的“等输入框出现再发”的逻辑照用。
6. **返回给主控**：`agy-1 started. End your turn now; its report will be delivered to you. Do not poll.`

### 8.4 投递和叫醒

发给会话的消息一律走工作台 outbox，动作方是 `team`。

- **排队**：每个会话一个消费者，等当前轮次结束再发。结果不确定就暂停，不重发。用户自己发的消息排在前面。
- **投递前检查**（与监督器相同），四项都满足才发：
  - 会话还在同一轮；
  - 没有待处理的审批或提问；
  - 用户 120 秒内没在这个会话里输入过；
  - 电脑前没有未发送的草稿（`hc_draft`）。
- **扣住**：检查不通过就扣住，每 2 秒重查一次，最多扣 10 分钟。到时界面上显示“消息待投递”，不强行发。
- **按通道决定发什么**：

| 收件方的通道 | 发什么 |
| --- | --- |
| AGY（ACP prompt） | 整条消息。头部是 `[NexAgent team] From agy-1 · report · <主题>`，然后是正文和回复方法（空闲退出后经 `session/resume` / `session/load` 自动接回，第 0 期实测通过） |
| Codex 原生队列（`codex queue`） | 8 KB 以内发整条（第 0 期实测 8,232 字节 53 行 UTF-8 通过），超过就改发提示 |
| Claude 原生收件箱（托管 `full` 模式） | 8 KB 以内经 `messagingSocketPath` 直投整条消息，主控无需再跑 `nex inbox`（第 0 期实测 `herdr-core` 托管会话直投 2,726 字节确认通过）；不可用或 `ask` 模式退回下行 |
| 终端（非收件箱 Claude，以及用不了原生队列的 Codex） | 只打固定的一行：`[NexAgent] You have N new team messages. Run \`nex inbox\`.` |

- **终端里只打常量文字。** 这与监督器“自动发送的文字是常量”的规则一致。Agent 写的内容只走结构化通道，或者由 `nex` 打印，并且标明出自另一个 Agent。
- **不只等“轮次结束”这一个事件。** 下面三种时候也要再查一遍有没有未投递的消息：会话变成空闲（`cli.sessions` 更新）、设备重新连上（`cli.resync`）、Core 重启。这样可以补上 `TurnTracker` 在断线时丢掉的轮次结束。

### 8.5 一轮结束却没汇报

调度器订阅 `hub.onTurnEnd`。工人的一轮结束时，按下面的顺序处理：

1. 本轮运行过 `report`、`ask` 或 `escalate`，或者有待处理的审批：不做任何事。
2. 否则等 10 秒（汇报可能还在路上），再查一遍。
3. 第一次没汇报：发一段固定的催促，`[NexAgent] Your turn ended without a report. If the task is done, run nex report; if you need the lead, run nex ask; if you are blocked, run nex escalate.`，并记下 `nudged_turn`。
4. 催过之后又结束一轮，还是没汇报：给主控发升级消息“agy-1 停下了但没有汇报”，附上工人最后一段回复（最多 1000 字）。读记录、发消息还是停掉它，由主控决定。
5. 工人会话停止、ACP 断开或进程退出：指派记为 `failed`，并告诉主控。主控可以重新派，重派计入熔断次数。

主控是用户的会话，不催。

### 8.6 审批和提问

- **工人的权限提示**：照常变成 NexAgent 的请求卡，**由用户处理**，同时告诉主控“agy-1 在等审批”。默认不让主控代批；以后可以加一个默认关闭的设置“允许主控代批工人的审批”，以先回答的为准。
- **工人的 `ask`**：发给主控。主控能回答就 `reply`，不能就在自己的会话里问用户。
- **主控自己的提问和审批**：与普通会话一样。

### 8.7 上限

| 上限 | 默认 |
| --- | --- |
| 一个主会话的工人数 | 5（设置里可改）。一个主会话同时只有一个进行中的协作，`done` 或用户结束后，下一个协作重新计数 |
| 层级 | 固定一层：工人不能派活 |
| 每小时的协作消息 | 60，防止来回打转 |
| 协作空闲多久自动暂停 | 24 小时 |
| 同一任务连续启动失败熔断 | 3 次 |

- 5 个工人之内，同时跑几个、每个任务来回几轮，都由主会话决定，不另设限制。
- 超出上限时，命令直接拒绝并说明原因，主会话头部的“协作”按钮上同时提示用户（第 11 节）。
- 用户可以暂停协作。暂停后不再投递消息，也不能派新工人，但正在运行的会话不受影响。

## 9. 用法举例（不是固定流程）

NexBot 不内置任何流程。下面这些是主控按用户的话组合出来的用法；`nex guide` 里也只把它们当作例子。

### 9.1 Claude 出方案 → AGY 实现 → Codex 审查 → Claude 交付

用户对一个 Claude 会话说：“方案你出，实现交给 agy，做完让 codex 审查，最后给我结果。”

1. Claude 读代码、写方案，存进 `plan.md`，然后运行 `nex start agy --role 实现 --title "实现登录限流" --file plan.md`，结束本轮。
2. 调度器启动 AGY 会话，整条发出规则和任务，AGY 开始修改。
3. AGY 改完，写好汇报，运行 `nex report --outcome succeeded --file report.md`。调度器结算这次指派，等 Claude 空闲后往它的终端打一行提示。
4. Claude 运行 `nex inbox` 读到汇报，然后运行 `nex start codex --role 审查 --in agy-1 --permissions readonly --title "审查登录限流" --file review.md`。
5. Codex 只读审查，运行 `nex report --findings findings.json …`。主控收到消息，界面上显示一张审查卡。
6. 有问题时：
   - Claude 运行 `nex send agy-1 --file fixes.md`，调度器给 AGY 开一个跟进任务。
   - AGY 改完再次汇报。
   - Claude 运行 `nex send codex-1 --file recheck.md`，请 Codex 复审。这样复用原来的会话，保留之前的上下文。
7. 来回几轮由 Claude 决定。最后 Claude 自己核对（跑测试、看 diff），在会话里写交付说明，运行 `nex done --file summary.md`。

### 9.2 两个 Agent 各做一版，主控挑

“让 agy 和 codex 各做一版，你比较后挑好的。”

- 主控运行两次 `start`，都带 `--in worktree`。
- 两个汇报都到了以后，主控用 `nex read` 看过程，再到两个 worktree 里各看一遍 diff，然后告诉用户选哪个，以及理由。

### 9.3 拆开并行

“前端、后端、测试分三个人做。”

- 主控派三个工人，各自 `--in worktree`。测试的那个带 `--after` 前两个工人，等它们完成后再启动。
- 全部完成后，主控把三个分支合到协作分支上，再交付。

### 9.4 先审方案再动手

“方案写好先让 codex 挑挑毛病。”

主控运行 `start codex --permissions readonly`，让 Codex 审 `plan.md`。改好方案后再派人实现，或者自己动手。

### 9.5 换主控

主控也可以是 Codex 或 AGY，用法完全相同。

### 9.6 协作偏好（设置）

设置页新增独立 **“协作”** 分类，包含：

| 设置 | 默认 |
| --- | --- |
| 派活方式 | “用户提出时”。另外两个选项：“Agent 可自行派活”，即主会话觉得需要时自己开启协作；“关闭” |
| 单个主会话工人上限 | 5（按单次协作计，设置里可改） |
| 询问模式下默认放行 `nex` 命令 | 开（仅放行单条纯 `nex` 命令，不含 shell 拼接、管道或重定向） |
| 可用 Agent 与默认权限 | 这台电脑上已安装的 claude、codex、agy，可分别启用并指定默认权限（默认跟随引擎设置，`--permissions` 可覆盖） |
| 工人的默认模型 | 跟随各引擎的默认设置 |
| 安全上限（只读事实） | 单层派活、每小时 60 条协作消息、空闲 24 小时自动暂停、连续启动失败 3 次熔断（见 8.7） |

这些只是偏好，不是流程。

## 10. 安全

- **用户用提示词开启协作。**
  - 用户提出协作，就算同意；之后的安排都交给主会话，不再逐步确认。
  - “用户有没有提出”NexBot 无法可靠判断，所以这一条只写在 guide 和技能说明里。硬限制是工人数上限 5 和设置“派活”的“关闭”选项。
  - 每个工人都挂在主会话下面，随时可以打开或停止。
- **终端里只打常量文字。** Agent 写的内容不进 PTY。
- **只有主会话能派活。** 工人运行 `nex start` 一律拒绝。工人可以用自己的子代理，这些子代理在工人的进程里运行，不算工人，也不占上限。
- **询问模式下放行 `nex` 的安全边界**（第 0 期实测落地）：默认在 `ask` 模式下免审批放行 `nex`，但**只放行纯 `nex` 单条命令**，严禁放行含 `&&`、`||`、`;`、`|`、`` ` ``、`$(`、`>`、`<` 及换行的复合语句：
  - **Claude**：使用 `--plugin-dir` 中的 `PreToolUse` 钩子（必须同时匹配 **`Bash|PowerShell`**，Windows Claude 会动态选用两个工具），校验纯 `nex` 后返回 `permissionDecision: "allow"`；**严禁使用 `--allowedTools "Bash(nex *)"`**（第 0 期实测可被 `nex status && echo ...` 绕过）。
  - **AGY**：执行器在 ACP `session/request_permission` 回调中校验 `toolCall.rawInput.CommandLine`，仅纯 `nex` 自动回复 `allow_once`。
  - **Codex**：通过单次启动 `-c mcp_servers.nex=...` + `-c mcp_servers.nex.tools.<name>.approval_mode="approve"` 走结构化 MCP 工具，天然零 shell 拼接风险且不碰全局 `~/.codex`。
  - `nex` 内部的写操作仍完全受 Core 调度器校验。
- **边界动作。** guide 和工人规则都写明：不推送、不部署、不合并到主分支、不删分支、不花钱、不给别人发消息。
  - 主控发给工人的消息和任务说明，如果命中一份窄的边界词表（推送、部署、发布、合并到主分支、删除分支、生产环境、付款），先扣住，在界面上请用户确认。
  - 监督器的 `BOUNDARY_RE` 不能直接拿来用：它包含“回复”“发送”“评论”，几乎每封协作消息都会命中。
  - 第 2 期可以再给 Claude 工人加一个 PreToolUse 钩子，拦截 `git push`、`gh pr merge` 这类命令。
- **权限。**
  - 工人的权限由主会话按任务选（`--permissions`），不写就用偏好里的默认值。
  - 主会话的协作列表里显示每个工人的权限。
  - 新会话默认是 full，所以 guide 建议审查类任务用 `readonly`。
- **身份。** `nex` 只认 NexBot 管理的会话（7.2），凭据只在本机管道上有效。
- **提示注入。**
  - guide 写明：工人的汇报只是信息，不是用户的指令。
  - 消息头标明出处。
  - 调度器不执行消息里的任何内容。
- **审计。** 派活、发消息、停止、结束都写审计。
- **上限。** 见 8.7，防止来回打转、烧掉额度。

## 11. 界面

界面中文名定为 **“协作”**，复用现有的主子会话层级：不另做协作页面，也不加手动派活的入口。Web、Windows、Android 共用 Web UI（`src/personal/cli-agents/`），视觉稿已通过本地预览确认并落盘；Mac 和 iOS（`apps/apple`）安排在后续补齐（正式发版前与 Web 保持一致）。界面文字保持简短。

### 11.1 现有的层级

**Web**（`SessionList.tsx`、`session-model.ts`）

- 会话列表按“电脑 → 项目 → 会话树”组织。
- 树的父子关系来自工作台的 `parent`；没有 `parent` 时，用分叉来源 `forkOf`（见 `parentOf`、`treeParents`）。
- 每一行带自己的引擎标记，所以不同引擎的会话可以挂在同一棵树上。
- 同一仓库的 worktree 按 `repoRoot` 归到同一个项目下。
- 折叠旧会话时，活跃会话的上级仍会显示（`foldHistory`）。
- 分叉最多两级，再分叉会提示“已达两级分支上限”。
- 侧边会话（`side`）不进列表，从会话页头部的“侧边会话 N”打开。
- 列表顶部有“进行中”区，置顶各电脑上运行中和等你处理的会话。

**Apple**（`AgentSessionsView.swift`、`CliAgentLogic.swift`）

- 列表是“电脑 → 文件夹 → 平铺的会话”，也有“进行中”区。
- 没有树：Swift 代码里没有任何地方读 `forkOf` 或工作台的父级。后续补一层工人树与协作视图。

### 11.2 工人怎么挂上去（已固化视觉规范）

- **会话列表与多轮协作历史折叠**：
  - 工人用新增的 `worker` 类型，`parent` 指向主会话。Web 的树不用改结构，工人直接挂在主会话下面。
  - 工人行显示引擎标记、状态点（沿用工作中/等你处理色调，新增已汇报绿点与失败红点）、任务标题和无边框浅色角色字（不放“已汇报”胶囊，避免挤压任务标题；仅需介入的“等你处理”和“失败”保留标签）。
  - 工人不能再分叉，菜单里不显示“创建分支”，工人这一支保持两层。
  - 跨目录或非 git 目录下的工人，统一跟随主会话的项目分组，不退到顶层或其他项目。
  - **多轮协作历史工人**：
    - 命令行侧每次协作仍按 `run` 从 1 编号（`agy-1`、`codex-1`）；列表以任务标题与角色为主，不会视觉撞名。
    - 主会话刚完成协作、尚未开启新协作时，最近一次协作的工人保持展开便于复查（超过 7 天随项目级 `更早 N` 折叠）。
    - 主会话开启新协作后，往期已结束协作的工人自动收进主会话分支底部的 **`历史协作 N`** 折叠行（复用 `.na-older` 样式，展开按协作标题和状态轻分组，保持两层不加第三层）。
    - 当前选中的会话、搜索命中项、或用户手动重新激活为运行中/等你处理的旧工人，自动保持可见不折叠。
  - 切到“按时间”平铺视图时，工人行用副标签标明 `协作 · 〈角色〉`。
- **“进行中”区**：
  - 正常工作的工人不单独置顶，只在主会话行显示 `N 个工人工作中`（协作暂停时显示 `协作已暂停`）。
  - 工人等你处理时单独置顶，保留 `等你处理` 标签，并在副行标明 `协作 · 来自〈主会话标题〉`。
- **主会话页协作浮层**（`TeamPanel.tsx`）：
  - 头部加 `协作 N` 按钮（仅历史协作时弱化显示 `协作`），带简洁状态圆点（运行绿/预警或等待橙/失败红）。
  - 浮层内工人列表采用对齐两列结构：左侧为引擎图标卡、任务标题、点分隔元信息（`角色 · 权限 · 代号 · 问题数/上下文`）与严格纵线对齐的圆点状态文案（`• 工作中` / `• 已汇报` / `• 等你处理`）；最右固定 `28px` 槽位放圆形停止图标按钮（运行/等待中，hover 变红）或轻箭头 `›`（已结束）。
  - 底部为对称双栏浅底操作条：`暂停协作`（暂停后变为 `恢复协作`）和 `结束协作`（点击后展开行内二次确认）；下方折叠显示 `历史协作` 次数、交付摘要与旧工人入口。
  - 超出上限或消息待投递提示显示在浮层顶部。
- **工人会话页顶部条**：
  - 头部下方显示轻量导航条：协作节点图标 + `协作 · 来自〈主会话标题〉`（不用 `↖`/`↗` 斜箭头，点击整条返回主会话）；右侧用 `·` 分隔角色、权限、代号与圆点状态。
  - 输入框照常可用，用户随时可以插手。用户在工人里说的话，优先于主会话派的任务（工人规则里写明）。
  - 审批卡照常显示在这里。
- **消息卡**（`TeamMessageCard.tsx`）：
  - 协作消息在记录里渲染为按任务类型区分主色的结构化卡片（浅主色顶栏 + 主色边框 + 类型标签 + 右侧无边框 `查看 ›` 跳转按钮，深浅色双模式适配）：
    - **派发**（`task`）：钴蓝；
    - **汇报 / 交付**（`report` / `done`）：翠绿（带无边框涉及文件条）；
    - **审查**（`review`）：靛紫（问题列表用细线分隔，带 `• 高`/`• 中` 严重度圆点与 `file:line`）；
    - **修改**（`followup`）：琥珀橙；
    - **提问 / 答复**（`question` / `answer`）：青绿；
    - **异常 / 失败**（`escalation` / `failed`）：绯红。
  - Web 在 `TranscriptView.tsx` 里实现，Apple 后续在 `AgentSessionDetail.swift` 里对齐。
- **归档**：主会话归档时，连带该主会话下所有协作（含历史协作）的工人一起归档；恢复时一起恢复。
- **通知**：工人等你处理、协作完成时发通知。Web 用浏览器通知，Apple 后续用 `AgentNotifier.swift`。
- **设置**：独立 `协作` 分类（`TeamSettings.tsx`，见 9.6）。

接口：

- `GET /api/cli-agents/teams?lead=<key>`
- `POST /api/cli-agents/teams/<id>/pause`、`/resume`、`/cancel`
- `POST /api/cli-agents/teams/<id>/workers/<name>/stop`
- `GET /api/cli-agents/team-settings`、`PUT /api/cli-agents/team-settings`
- 流里新增 `cli.team` 推送（快照和增量），同时补上 `stream.ts` 对工作台树更新的转发。

## 12. 分阶段交付

| 期 | 内容 | 验收 |
| --- | --- | --- |
| 0 实测（Windows 已完成） | 实测清单见本节下文；Windows 隔离实测结果见 [`docs/verification/nexagent-multi-agent-phase0-20261128.md`](../verification/nexagent-multi-agent-phase0-20261128.md)（macOS 项待发版准备/Mac 联调补测） | 已产出 `docs/verification/` 记录并回写本设计 |
| 1 最小可用（Core + 执行器 + Web） | Core 迁移和调度器；会话管道、`nex` 命令（含 Codex 沙箱/`ask` 单次 `-c mcp_servers.nex` 轻桥接）和 PATH 注入；三端主控说明（Claude 技能、AGY `systemPrompt.append`、Codex `-c developer_instructions`）；outbox 投递（AGY ACP、Codex `queue`、Claude 托管原生收件箱、终端唤醒）；催促和升级；询问模式下纯 `nex` 放行（Claude `PreToolUse` `Bash\|PowerShell`、AGY 执行器回调、Codex MCP `approval_mode`）；新 worktree 信任弹窗与 `codexEmptyComposer` 修复；单机协作；Web 前端接入真实接口（视觉稿已完成） | 在隔离环境里跑通 9.1 和 9.2；工人运行 `start` 被拒；第 6 个工人被拒；断开设备链路再恢复后，消息不丢也不重复 |
| 2 补全与 Apple 对齐 | Apple 端补一层工人树、协作面板、工人顶部条、消息卡、通知与设置（正式发版前与 Web 齐平）；主会话代批开关；Claude 工人的命令拦截；需要时改用原生 `nex.exe` 启动器；协作列表里显示每个工人的上下文用量；通知 | 逐项验收 |
| 3 扩展 | 跨设备派活（Core 转发）；把 `nex` 装进系统 PATH，让用户自己的终端和桌面应用里的会话也能用（按父进程认出 Claude 桌面会话，经原生收件箱叫醒）；Pi 助手当主控；ZCode | 逐项验收 |

第 0 期实测清单：

- 三种 CLI 的 shell 里能否找到并执行 `nex`：
  - Claude：Windows 上的 Git Bash 和 PowerShell，Mac 上的 zsh；
  - Codex：PowerShell，以及 full、ask、readonly 三种权限下，Windows 和 Mac 的沙箱里能否连上管道；
  - AGY：ACP 子进程的环境能否传到它的 shell 工具。
- 环境变量会不会被剥掉（Codex 的 `shell_environment_policy`、Claude 的 scrub），以及父进程兜底在 Windows 上的耗时。
- Windows 上 `.cmd` 传中文和特殊字符的情况，以及 `--file` 读 UTF-8。
- 主控说明的三个通道：Claude 插件技能能否加载；AGY 的 `systemPrompt.append`；Codex 单次启动的指令通道。
- “询问”模式下精确放行纯 `nex` 单条命令（并拒绝含 `&&`/`;`/`|`/`$(` 等拼接语句）的三端实现：Claude 的 `--allowedTools`/钩子、AGY 的执行器自动答复、Codex 的命令规则。
- 投递：
  - 终端里的一行提示能否稳定提交；
  - `codex queue` 能否发 8 KB 的多行消息；
  - AGY 进程退出后，能否 `session/load` 接回并收到消息；
  - Claude 原生收件箱能否给 nex_bot 终端里的会话投递整条消息（能的话，主控就不用再运行 `inbox`）。

实测和验收都按 `docs/verification/README.md` 在隔离环境里做：AGY 用一次性的 `ANTIGRAVITY_CLI_CONFIG_DIR`，Claude 和 Codex 用测试目录，不碰用户真实的会话历史。

## 13. 风险和待定

- **命令行能否在三种 CLI 里稳定可用，是整个方案的前提**，第 0 期先测。被沙箱挡住的会话，退回 MCP 后备，或者换权限。
- **主控不按规矩走**，比如派完不结束本轮，或者反复运行 `status`：命令输出写明下一步；`status` 限频；账本的正确性不依赖主控守规矩。
- **主会话在用户没提出时派活**：说明里限定了触发条件，但 NexBot 无法可靠判断用户是否提出过。兜底靠两样：单主会话工人数上限 5，以及设置“派活”可以关闭。
- **成本**：每个工人都是完整的 CLI 会话，花的是用户自己的额度。第 2 期在主会话的协作列表里接入真实上下文用量（`context-usage.ts` 已有，前端位置已预留）。
- **新 worktree 目录信任弹窗**（第 0 期新发现）：给工人新开 git worktree 时，交互式 Claude Code 会弹工作区信任确认且默认光标在 `> No, exit`，Codex 会弹 `Folder access`（且 `-c projects.<path>.trust_level` 无法覆盖，现有 `codexEmptyComposer` 也会把弹窗第一项 `› 1. Trust and continue` 误判成空输入框）。第 1 期启动新 worktree 工人时需同步修复空输入框判定并妥善处理信任确认。
- **macOS 实测留待补齐**：第 0 期已在 Windows 11 完成隔离实测（包括 Codex Windows 沙箱改走单次 `-c mcp_servers.nex` 与 `-c developer_instructions` 定案）；macOS 下的 zsh 与 Seatbelt 沙箱行为待后续 Mac 联调阶段补测。

## 附：Orca 关键文件

| 内容 | 路径 |
| --- | --- |
| 协调者技能和说明 | `skills/orchestration/SKILL.md`、`skill-guides/orchestration.md`、`skill-guides/orchestration/references/` |
| 用户文档 | `docs/site/content/docs/cli/orchestration.mdx` |
| 工人前言 | `src/main/runtime/orchestration/workers/launch/worker-dispatch-preamble.ts` |
| 命令行进 PATH、启动器 | `src/main/cli/launchers/orca-cli-child-path.ts` |
| 调用方身份 | `src/cli/orchestration/identity/terminal-identity.ts` |
| 终端叫醒 | `src/main/runtime/orchestration/mailbox/terminal-pointer/`、`mailbox/formatting/message-formatting.ts` |
| 聊天投递 | `src/main/runtime/orchestration/mailbox/structured-mail/`、`turn-delivery/send-agent-turn.ts` |
| 表结构 | `src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts` |
| 汇报结算 | `src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts` |
| 停下但没汇报 | `src/main/runtime/orchestration/workers/turn-stops/` |
| 钩子 | `src/main/agent-hooks/`、`src/main/antigravity/hook-*.ts` |
| 就绪判断 | `src/main/runtime/terminal/wait/tui-idle-evidence.ts`、`src/main/runtime/agent-state-rules/*.json` |
| 粘贴投递 | `src/shared/agent-launch/startup/agent-prompt-injection.ts` |
| agy 的 ACP 启动 | `src/main/antigravity/antigravity-acp-launch-spec.ts`、`antigravity-host-acp.ts` |
| CLI 注册表 | `src/shared/agent-launch/catalog/tui-agent-config.ts` |
