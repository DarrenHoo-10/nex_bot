# Personal Agent 主设备记忆与协作方案

日期：2026-10-11。状态：首批实现完成，生产记忆发行门槛尚未通过。本文采用用户确定的主设备 Hindsight、Bot 公开职责目录、A2A 自动通信与危险操作审批规则，作为完整实现的契约。checkout 已落实统一 Agent、自动 A2A、记忆来源/outbox、真实引擎接入与隔离验证，详见[实现记录](2026-10-11-personal-agent-memory-implementation.md)。本机已安装的 0.3.3 尚未升级，仍使用原文记忆和旧审批行为。

## 1 主要决策

每个个人 AI 系统有一台常驻主设备。Agent Core、固定 Pi 运行时和真正的 Hindsight 引擎都运行在这台设备上。其他设备通过 Core 获取服务、发送消息或提供设备能力；用户只配置已有模型连接的 API Key。

- Core 继续采用模块化单体，管理身份、Bot、消息、任务、策略、审批、设备和模型预算。
- 首次启动的 Agent 列表为空，由用户显式创建；不存在预置角色、隐藏协调者或按名字选择的专用流程。
- Hindsight 作为主设备上的本地记忆基础设施，负责 retain、recall、reflect、实体关联、observations 和知识页。使用固定版本，通过 Core 的 Memory 模块接入。
- 每个 Bot 有私有 bank；同一工作空间另有一个共享 bank。各 Bot 还读取实时公开职责目录，知道其他 Bot 能帮什么忙。
- 同一用户工作空间内的 A2A 询问、委派和回复自动进行。记忆隔离约束直接检索范围，允许通过有目的的求助获取同伴回答。
- 执行 Agent 在自己的持续消息流里为危险操作申请批准。普通记忆检索、私有记忆整理和内部 A2A 不弹批准框。
- Hindsight 自己的 PostgreSQL 数据与 Core 的 SQLite 业务数据分工明确。安装器负责本地依赖、启动和升级；用户不选择记忆框架，不维护数据库连接。

以上更新原方案的记忆部署与审批设计。固定 Pi、持久 Agent 联系人、独立任务上下文、设备本地授权、重试幂等和原始记录持久化继续适用。

### 1.1 Agent 是统一的领域实体

Agent / Bot 是同一个领域概念，`bots` 是沿用的存储名称。每个实例有稳定 ID、用户指定的名字、可选身份描述、模型连接、工具策略、持续消息流、私有记忆与例行任务。领域模型不定义固定职业枚举，也不按名字创建不同的 Agent 子类、提示词分支、检索范围或 A2A 路由。

所有实例复用同一个 Pi 执行流程、MemoryAdapter、公开目录和 Permission Broker。差异来自用户配置、实际授权和积累的经历。名字与职责作为语义背景帮助模型判断向谁求助，不能作为程序中的固定角色判断或权限依据。更名只更新资料及目录版本，不改变 ID、bank、工具权限和历史。

### 1.2 空工作空间与显式创建

首次初始化只建立 owner、工作空间、模型设置和本地基础设施，不创建 Agent、收件箱、任务或例行职责。客户端显示空联系人列表与“创建 Agent”入口；没有联系人时不能把消息发送给一个隐含的默认 Agent，也不调用模型。

用户执行 CreateAgent 后，事务内创建 Bot、公开资料、收件箱、统一基础 BotPolicy 与私有 bank 的待建立映射；Hindsight 资源经 outbox 幂等建立，不在 Core 事务中假设引擎已成功。共享 bank 按工作空间惰性建立，最多一个。基础策略对所有新实例相同，明确授予自身与共享记忆、公开目录及内部 A2A；设备和外部工具由用户另行授权。没有资料时不进行记忆抽取，空策略不会被运行时自动补权限。

启动、升级、重启、客户端重连，以及最后一个 Agent 归档后，都不补建联系人。已有安装保留现存 Agent 与历史，由用户管理；修改初始化规则不自动删除旧数据。记忆引擎的后台整理是基础设施作业，不是另一个隐藏 Agent。

## 2 主设备和其他设备的关系

```text
                    主设备
 ┌─────────────────────────────────────────┐
 │ NexBot                                  │
 │   Agent Core 模块化单体                  │
 │   ├─ Bots 与公开职责目录                 │
 │   ├─ Agents / A2A / Tasks                │
 │   ├─ Permission Broker / Device Gateway │
 │   ├─ Memory 模块与 HindsightAdapter      │
 │   └─ ModelGateway 与预算账本             │
 │              │ 本机受认证 HTTP           │
 │   Hindsight daemon + PostgreSQL         │
 │   ├─ 用户创建的 Agent A 私有 bank       │
 │   ├─ 用户创建的 Agent B 私有 bank       │
 │   ├─ 其他 Agent 私有 bank               │
 │   └─ workspace 共享 bank                │
 └───────────────────┬─────────────────────┘
                     │ Core 网络接口
             ┌───────┼────────┐
          Windows   Mobile    NAS
          客户端 / Device Node
```

主设备可以是用户常驻的 Windows 电脑、Mac mini 或服务器。Bot 的运行与记忆归属于主设备的 Core，不因为用户从手机或另一台电脑发消息就迁移。普通聊天设备无需安装 Hindsight，也不持有完整记忆数据库。

用户客户端访问经过身份验证的 Core API。Device Node 使用设备凭据提供文件等能力；设备凭据不等于用户会话，也不能读取各 Bot 的长期记忆。主设备离线时客户端显示不可用，不自动启动一个拥有旧记忆副本的第二 Core。

首版只有一个主设备，不实现多主、自动选主或跨设备记忆双写。未来迁移主设备时整体迁移 Core 与 Hindsight 数据、映射和实例身份，Bot ID 与 bank 映射不变。

### 本地运行和安装

Hindsight 官方提供本地 daemon 及 Node.js 启动封装，实际通过 uv / uvx 启动 Python 运行时，再以 HTTP 访问；其主要数据库为 PostgreSQL，也支持内嵌 PostgreSQL。参见 [Node.js API](https://hindsight.vectorize.io/sdks/hindsight-all-npm)、[Storage](https://hindsight.vectorize.io/developer/storage)。

产品的目标是由主设备安装包携带固定的 Hindsight、Python 依赖、数据库与模型资源，并由 NexBot 的本地进程管理器启动。Windows 上的原生依赖、数据库扩展与模型 CPU 支持是 M0 发布前置验证项；存在 npm 启动器不能代替安装包验证。若内嵌 PostgreSQL 分发不支持目标平台，验证主设备本地 PostgreSQL 的打包方式，不把数据改放到外部服务。

Hindsight 只监听主设备 loopback，启用服务凭据；PostgreSQL 同样限制本机访问。其他设备只连接 Core，不能直接连接 Hindsight 或 PostgreSQL。Hindsight 凭据只在 Core 的服务端可用，不交给 renderer、Pi worker、Device Node 或模型。

使用独立的 NexBot profile 和数据目录，不复用本机 coding-agent 插件的 bank 或配置。普通 UI 关闭后 Core、Hindsight 和数据库继续随托盘运行；用户明确退出或停用主设备服务时协调关闭。可见状态分别为 Core 在线、记忆可用、记忆整理滞后，不能用 Core 在线代表 Hindsight 已就绪。

## 3 每个 Bot 可以访问哪些 bank

物理 bank ID 由 Core 分配并保存在映射表，名称中不使用用户邮箱或设备主机名。逻辑范围如下：

| 内容 | 任意当前 Agent |
|---|---|
| 自身私有 bank | 直接检索 |
| 同伴私有 bank | 不直接检索 |
| workspace 共享 bank | 直接检索 |
| 全体 Agent 的公开职责目录 | 实时读取 |
| 同伴对此次求助的回答 | 经 A2A 接收 |

任意 Agent 收到问题时，都按统一规则检索 `自身私有 bank + workspace 共享 bank`。范围由 Core 根据调用的 Bot ID、工作空间和当前策略计算，与名字、职责标签无关，不能由模型传入任意 bank_id。自己的近期消息和当前 Task 上下文可以补充检索，但不因此获得其他 Bot 的历史。

能力目录独立于记忆 bank；它是 Bots 模块管理的实时事实。改名或职责更新后所有 Bot 在下一次实际模型请求前读取最新版本，执行中工具后的继续请求也更新，闲置 Bot 无需额外模型调用或通知。

共享 bank 保存用户要求大家知道的偏好、公共资料和共同决定，不自动汇总每个 Bot 的私有历史。用户说“让所有 Agent 记住这个”或在界面选择共享，便构成共享发布指示，不再多弹一次批准。私有整理默认保持私有，不能自行把推测写成全局用户画像。

Bot 之间可以按需交流它们获准处理的知识。隔离意味着不能直接扫描同伴 bank、原始历史或完整摘要；它不意味着同伴不能回答问题。A2A 返回的相关回答可进入接收方的私有经历，并保留转述来源，不自动变成共享知识。

## 4 Bot 公开职责目录

每个 Agent 都要知道有哪些联系人，以及这些联系人能做什么。目录以稳定 Bot ID 定位，名字是身份的一部分，补充身份与职责描述仍选填。

### BotCard 协议

```json
{
  "bot_id": "bot-7f39",
  "name": "小林",
  "description": "整理资料、核对来源",
  "expertise": ["资料整理", "来源核对"],
  "capabilities": ["document_analysis"],
  "availability": "ready",
  "profile_version": 7,
  "capability_version": 2,
  "directory_version": 12
}
```

- `name` 必填，`description` 可为空；expertise 与 capabilities 可以为空，不要求用户填写一份完整技能表。
- 名字、描述与专长是用户维护的实例数据，不由系统按名字补入职业模板。只有名字时结合名字和当前任务判断是否适合求助，不能由名字推导终端或其他工具权限。上述 BotCard 仅为用户创建实例的示例，不是默认联系人。
- Core 根据已注册能力、BotPolicy 与当前设备授权生成可公开的能力摘要。目录提供语义化能力名，不暴露本地路径、Key、完整 Grant 或私有记忆。
- 能力摘要不是执行凭据。发送、接受委派和实际工具执行时都检查当前策略；目录过期不产生额外权限。
- `availability` 区分 ready、busy、disabled；busy 表示可能排队，不说明无能力。系统停用的 Bot 不接受新任务。
- 目录版本、个人资料版本和能力版本分开；Bot 的显示名字或设备权限变化均能使对应视图更新。

日常联系人数量少时，每次模型请求直接注入全部当前 BotCard；规模增加后可按问题查询目录。目录不调用 Hindsight 做“谁是谁”的推理，也不依赖过去摘要中的旧名字。

Hindsight 可以记录 Bot 曾经更名或参与某项工作，具体路由始终使用目录中的稳定 Bot ID。Hindsight 的人名模糊消歧不能合并两个不同的 Bot 身份。

## 5 任意 Agent 回答问题的统一流程

1. 接收用户问题，保存到当前 Agent 的持续消息流并建立 / 补充后台 Task。
2. 加载当前 Agent 的身份、公开职责目录和自身允许的 bank 范围。
3. 在自身私有 bank 与 workspace 共享 bank 中按问题召回，同时参考当前工作上下文。
4. 若信息和能力足够，由当前 Agent 回答。不必为了每个问题都咨询其他 Bot。
5. 若缺少事实、存在冲突、需要专业能力，或用户明确要求询问同伴，按 BotCard 选择一个最相关 Bot 发出 A2A 求助。
6. 被请求方使用自己的私有 bank、共享 bank 和实际工具能力工作，并返回带来源与不确定性的结果。
7. 发起方接收结果，按同伴转述处理并综合成给用户的答复；必要时指出来源，不能声称自己执行了对方的操作。

以用户创建的两个实例 A、B 为例：用户问 A 某项之前的决定，A 在自身与共享记忆中找不到依据。A 读取当前目录，判断 B 的资料与能力适合处理，再直接向 B 求助。B 按同一流程检索自己的私有 bank 与共享 bank，返回相关依据；A 得到回答，不获得 B 全部记忆。A、B 是说明调用关系的占位符，不是系统定义的角色。

若此次工作需要 A 没有的工具，而 B 已获授权，A 可请求 B 协助。B 使用自己已有的工具权限；若实际操作危险，由 B 申请批准。目录中只有当前 Agent 或没有合适同伴时，使用自身可用信息和能力处理，缺少依据时明确说明，不调用一个内置专家。

### 求助判断和节制

低匹配检索、证据不足、知识冲突、缺少必要工具和明显超出职责，是求助信号。不能把模型自报“置信度 90%”作为唯一标准，也不能在 memory.search 返回空列表时直接断言所有 Bot 都不知道。

首轮通常询问一个联系人，必要时再询问第二个。保留当前 A2A 的深度 3、每根任务最多 8 个子任务、祖先循环检测、统一模型 / token 预算、超时与递归取消。没有合适联系人或对方也无法解决时如实回答，必要时向用户澄清。

## 6 A2A 自动通信和执行方审批

### 6.1 A2A 命令

内部能力 `agent.delegate(botId, message)` 自动执行，不创建 Approval。询问、请求工作、普通回复和消息来源提示均不需要用户逐次批准。调用仍产生持久 ToolCall、A2A 关系、子 Task 与幂等回执，重试不重复派发。

Core 检查：同 owner/workspace、目标存在且未停用、允许的内部 A2A 能力、深度 / 循环 / 预算 / 队列限制。策略拒绝与用户审批是不同结果；禁止的调用直接拒绝，不能弹一个批准框绕过禁止。

发送内容包含问题和最少必要背景，沿用源事件 / 来源引用信息；无需逐条请用户批准背景。禁止自动附上完整父 transcript、整份私有 bank 或凭据。Bot 收到的消息是任务资料，不能覆盖其身份、策略或设备授权。

首版范围是同一用户工作空间的内部 Bot。对外部用户、外部 Bot 或外部组织发送资料属于另一类工具行为，不因名为 A2A 就自动获得本协议的权限。

### 6.2 接收方使用自己的能力

各 Bot 是独立助手，接收方按自己的 BotPolicy、用户资源授权和目标 Device Node 的本地 Grant 执行，并遵守此次任务范围。它不继承发起 Bot 的工具清单，也不继承发起 Bot 的批准令牌。

因此发起方没有某项工具，也可以询问已被用户授权该工具的同伴。工具仍由接收方自己发起，危险操作由接收方自己申请批准。共享的是目标、链路和根任务预算，不是把权限从一个 Bot 拷贝到另一个 Bot。此规则适用于任意 Agent 配对，不按名字或职责预设接收方。

### 6.3 危险操作判定

Broker 按注册工具的实际副作用、参数、资源范围和当前授权判定，使用固定 effect descriptor 和参数校验。不能由模型自行声明 `safe=true`，也不能只按工具名字或命令里是否出现“delete”判断。

| 操作 | 默认处理 |
|---|---|
| 私有 / 共享记忆检索、公开目录、内部 A2A | 在允许范围内自动执行 |
| 追加或版本更新自己的私有记忆、后台整理 | 自动执行，保留 CAS、来源与政策检查 |
| 用户已指定的共享记忆发布 | 执行该明确发布指示，不额外弹批准 |
| 已授权目录中的列目录、只读文件、PDF 分析 | 自动执行；授权外资源拒绝或要求用户配置资源授权 |
| 在已授权产物目录新建文件 | 经参数检查自动执行，不能覆盖已有文件 |
| 删除 / 覆盖已有用户文件、批量不可恢复清理 | 执行方申请具体参数的批准 |
| 任意 shell、安装软件、改系统配置 | 首版执行方逐次申请批准；经验证的固定只读能力可以单独注册自动动作 |
| 对外发送邮件、上传私密资料、公开发布、支付 | 执行方申请批准 |
| 未授予的设备或工具能力 | 拒绝；批准不能突破资源授权上限 |

“危险操作”包含数据破坏、系统修改、对外披露与重要外部副作用。普通记忆追加不是危险操作；不能以“工具有写入”一律要求批准。用户界面直接执行的编辑 / 发布命令已表达相应意图，操作范围仍通过参数与版本检查。

### 6.4 批准框出现在哪里

Approval 的所属 Bot 是实际 `tool_call.bot_id`，所属内部上下文是该工具的 Task，而不是根任务最初的 Bot。

```text
用户 → Agent A → Agent B → 执行危险操作
                       └→ Agent B 消息流：需要你的批准
```

接收方 Agent 的消息流显示具体动作、参数摘要、批准 / 拒绝按钮，联系人列表标记它待批准。发起方显示“{接收方当前名字} 等待你的批准”及跳转入口，不弹是否允许联系同伴的批准框。

用户批准后只允许执行方的该次操作，绑定工具 ID、参数哈希、BotPolicy 与资源授权版本；其他 Bot 不能复用。参数变化、授权撤销或审批过期时重新检查；拒绝 / 取消向根任务返回真实结果，不冒充成功。

保留审批长等待后的持久恢复与 worker 释放机制。UI 把子 Task 的批准投影到实际执行方这个长期联系人，不引入用户可见的子会话入口。

## 7 Hindsight 内的记忆流程

### 7.1 Retain 来源

用户消息已经持久化、Task 完成 / 持久检查点、A2A 请求与结果已提交、用户维护的记忆文档、明确要求保留的已授权文件，都是增量来源。Personal Agent 不等待会话关闭才保存。

Core 先保存原始业务记录和 outbox；MemoryAdapter 按 bank、来源 ID、版本和内容哈希投递到 Hindsight。消息源带实际发言者、Bot ID、Task ID、A2A ID、根来源、发生 / 获知时间、出处和来源类别。Hindsight 接收这些上下文进行抽取和关联。新来源先能通过自己的原文历史查找，事实整理异步完成。

提取与综合采用 Hindsight 的实际能力，不在 Core 新建第二套 fact、entity、vector、observation 和 graph 表。Hindsight 区分外界信息 world、所属 Agent 经历 experience，并自动形成有证据的 observations；Core 补充业务来源映射与确认类别。参见 [Retain](https://hindsight.vectorize.io/developer/retain)、[Observations](https://hindsight.vectorize.io/developer/observations)。

同一 bank 的新来源默认 30 秒防抖，累计 20 条或 Task 结束提前提交，按固定 token 上限分批。只整理新增来源；升级不自动上传全部旧记录给模型，历史回填由用户选择范围。

### 7.2 来源可信度

来源类别是 `owner_confirmed / owner_stated / tool_observed / peer_reported / inferred`，它由实际来源与业务回执决定，不能由 LLM 自报信心升级。

- 用户说“我偏好中文”是用户表达；不能把用户引用故事里的人物信息归到用户。
- 任意同伴自称操作完成仍是同伴报告；成功执行需要对应工具回执。
- A2A 转发保留根来源，防止同一消息经过几个 Bot 转述后被算成多份独立证据。
- 用户明确限制和当前授权不能被记忆综合覆盖。没有新用户指示时，推测不能改写明确确认的规则。
- Hindsight 的 observation 是综合结论，知识页是派生结果；自己的摘要不能作为独立新来源反复 retain。

Core 的来源记录保存 provenance，Hindsight retain metadata/context 与引擎引用建立映射。映射缺失或无法展开证据的结果不标成“已经验证”。不能假设 Hindsight 的原生 fact schema 直接支持所有 NexBot 字段。

### 7.3 Recall 和 Reflect

Core 对允许的每个 bank 分别调用 Hindsight recall，然后在当前 Agent 的上下文里融合结果。Hindsight 使用语义、关键词、关联与时间检索，按预算返回；跨 bank 的综合答复由当前 Bot 完成，不能先调用全库 reflect 再过滤正文。参见 [Recall](https://hindsight.vectorize.io/developer/retrieval)、[Reflect](https://hindsight.vectorize.io/developer/reflect)。

普通问题使用 recall；“为什么当时这样决定”“根据过去经历制定计划”等需要综合时才使用 reflect。reflect 一次只能针对授权的单个 bank；必要时分别综合自己的 bank 和共享 bank，并共享根任务预算。Hindsight 内部推理可能产生多次真实模型请求，预算不能只按一个 HTTP reflect 请求计数。

初始记忆上下文合计最多 2,000 tokens，明确要求深度回顾时最多 4,000 tokens，受剩余模型窗口约束。新 MemoryContext 替换旧固定 15 条装载；自身近期消息保留另一个小预算。

每次实际 Pi 模型请求前刷新身份与目录，检查 bank 内容 / 可见性 generation、政策与引用有效性；没有变化可复用同一目标的缓存。steering、目标变化、重大新资料、纠正、撤回和遗忘使缓存失效。

### 7.4 中文和模型配置

为实际 Hindsight 配置本机多语言 embedding 与多语言 reranker，提取 / 综合复用用户已有模型连接。轻量候选采用官方列出的 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 和 `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`，在 M0 根据中文准确率和主设备资源固定 revision、校验哈希与依赖版本；如质量不足再评估 bge-m3 组合。

Hindsight 官方说明默认 embedding、reranker 与 PostgreSQL 英文全文检索配置不能直接作为中文验收结果，部分中文全文检索扩展未随内嵌数据库提供。参见 [Multilingual Support](https://hindsight.vectorize.io/developer/multilingual)。

Core 保留自己授权范围内的原始消息 / 文档中文关键词补充索引，用于尚未整理内容、短姓名和故障降级；它只索引原始来源，不重复 Hindsight 的事实或向量。真正中文语义召回由 Hindsight 承担，不能把 LIKE 命中称为语义记忆。

模型资源随主设备安装包提供，运行时不自动下载未固定版本。记忆存储与 embedding 在主设备，但用户选择远程 LLM 时，提取 / 综合仍会向该 provider 发送必要文本，设置页说明处理范围与用量。

### 7.5 知识页

每个私有 bank 维护用户偏好、重要决定、工作经验三个问题对应的知识页。共享 bank 的页面只从共享来源生成。目录不放进“用户偏好”页面充当最新身份资料。

页面依据 facts / observations 刷新，不读取其他页面作为新的证据；无变化不调用模型，刷新触发合并，最短间隔 30 分钟。Core 记录页面配置与 provider ID，新鲜度、内容和来源由引擎返回并验证。stale 页面只作导航，回答当前偏好需核对最新有效来源。参见 [Mental Models](https://hindsight.vectorize.io/developer/mental-models)、[Knowledge Pages](https://hindsight.vectorize.io/developer/knowledge-pages)。

## 8 模块职责和存储契约

### 8.1 数据归属

| 存储 / 模块 | 负责的数据 |
|---|---|
| Bots / Core SQLite | 稳定 Bot 身份、公开专长、策略、目录版本与能力摘要来源 |
| Agents / Execution / Core SQLite | 原始消息、任务、完成记录、工具回执、A2A 关系、审批、恢复 |
| Memory / Core SQLite | bank 映射、来源版本、导入回执、共享发布、遗忘规则、政策、预算关联与缓存 |
| Hindsight / 本机 PostgreSQL | 原始导入文档及 chunks、抽取事实、实体、关联、向量、observations、知识页与引擎作业 |
| runtime.db | Pi 会话恢复投影，可清理 / 重建，不是长期记忆库 |

现有 `memory_documents` 与 `memory_content` 保留为用户维护的明确记忆来源，ID、版本和写入回执不变；通过增量事件同步到对应 bank，不改写成另一套模型生成事实表。Markdown 是导出视图，不是第三个正文主存储。

### 8.2 Core 领域对象

| 对象 | 不变量 |
|---|---|
| Agent / Bot | 用户显式创建的统一实体；无固定职业类型，无默认种子实例；稳定 ID 独立于名字和职责 |
| BotCard | 基于稳定 Bot ID 的公开视图；不包含私有历史与执行凭据 |
| MemoryBankBinding | 一个 Bot 一个私有 bank，一个工作空间一个共享 bank；归属与物理 provider ID 不受名字影响 |
| MemorySource | 定位已提交业务来源的精确版本，描述说话者、根来源与适用范围 |
| MemoryTransfer | 追踪向 Hindsight 交付 / 删除的过程；未确认结果不是成功，也不能盲目重发 |
| MemoryPublication | 共享的是确定版本的内容快照；后续私有编辑不自动扩大共享范围 |
| ForgetRule | 优先于回填、重试和缓存；未知清理结果不能允许旧派生再次出现 |
| RiskDecision | Core 按实际效果和参数决定 auto / approval_required / denied，Bot 无权自行改变 |
| Approval | 归属于实际执行 Bot 的确切动作；A2A 消息不创建 Approval |

### 8.3 Core 增量表契约

这些表只约束 Core 与引擎的业务连接。最终增量 DDL 在 M0 后冻结，不直接重建个人数据库。新表使用 STRICT、复合 FK、CHECK 和幂等键；下表带 id 的表默认以 id 为主键。

| 表 | 关键字段 | 约束 |
|---|---|---|
| `bot_public_profiles` | bot_id, workspace_id, owner_user_id, expertise_json, version | PK(bot_id)；与 Bot 归属复合 FK；JSON 封闭 schema；名字和补充职责分别取 bots.name / bots.instructions，不存第二份可独立编辑的身份描述；修改公开专长同事务推进 Bot / 目录版本 |
| `bot_directory_state` | workspace_id, version, updated_at | PK(workspace_id)；目录源提交时同事务递增；availability 由当前执行状态投影 |
| `memory_engine_instances` | id, core_id, provider, release, data_root_ref, status | provider 固定 hindsight；本地实例身份稳定；data_root_ref 不作为远程客户端可读路径 |
| `memory_bank_bindings` | id, instance_id, workspace_id, owner_user_id, scope, bot_id, provider_bank_id, policy_version, content_generation, visibility_generation, state | scope=`bot/workspace`；bot 范围 bot_id 必填，workspace 范围为空；私有 / 共享分别 partial UNIQUE；UNIQUE(instance_id,provider_bank_id)；state=`provisioning/ready/unavailable/quarantined/deleted` |
| `memory_bank_policies` | bank_id, version, source_allowlist_json, auto_retain, auto_refresh, call_limit, token_limit, updated_at | PK(bank_id,version)；版本追加；当前 policy 指针匹配；额度非负 |
| `memory_source_registry` | id, bank_id, source_kind, original_id, source_version, speaker_kind/id, root_origin_key, content_hash, source_class, occurred_at, learned_at, status | UNIQUE(bank_id,source_kind,original_id,source_version)；status=`active/superseded/retracted/purged`；正文通过来源模块取，不再长期复制 Core 消息全文 |
| `memory_provider_documents` | id, bank_id, source_id, provider_document_id, source_version, content_hash, state | source 与 bank 复合 FK；UNIQUE(bank_id,provider_document_id)；映射固定；state=`pending/retained/replacing/deleting/deleted/unknown` |
| `memory_transfers` | id, bank_id, provider_document_mapping_id, kind, request_hash, policy_version, status, provider_operation_id, attempts, claim_version, lease_owner/until, next_attempt_at | kind=`retain/delete/reconcile/refresh`；业务操作+精确来源版本+策略版本幂等；status=`queued/running/succeeded/failed/unknown/cancelled`；claim fencing 单调递增 |
| `memory_transfer_receipts` | transfer_id, provider_result_ref, content_hash, committed_generation, committed_at | PK(transfer_id)；一个 transfer 只提交一个完成回执；回执不声明分布式原子事务 |
| `memory_publications` | id, owner/workspace, private_bank_id, private_source_id/version, shared_bank_id, shared_source_id, content_hash, user_intent_ref, status, created_at, revoked_at | 私有 / 共享 bank 同 owner/workspace；发布绑定明确用户指示；status=`active/revoked`；同指示幂等 |
| `memory_forget_rules` | id, bank_id, selector_kind, selector_json, version, created_at, status | selector=`source/origin/entity_topic`；由 Core 确定和校验范围，模型不能自行提交任意 bank 清理 |
| `memory_page_bindings` | id, bank_id, page_key, question, filters_json, provider_page_id, policy_version, dirty_generation, status | UNIQUE(bank_id,page_key)；page_key 首版三类；共享页面禁止引用私有来源 |
| `memory_context_cache` | id, owner/workspace, bot_id, task_id, input_version, query_hash, banks_json, generations_json, policy_fingerprint, body, citation_refs_json, expires_at | UNIQUE(task_id,input_version,query_hash,policy_fingerprint)；范围与 Task/Bot 复合约束；任何可见性变化使缓存失效 |
| `memory_model_invocations` | id, bank_id, transfer_id?, engine_operation_id?, task_run_id?, request_key, purpose, reserved_tokens, status, usage/cost, timestamps | 每个实际远程请求一行，purpose=`retain/consolidate/reflect/page_refresh`；执行关联经封闭 schema 校验；重试独立记账；unknown 不算零用量 |
| `tool_risk_rules` | action_name, version, effect_kind, parameter_schema, approval_mode, resource_constraints_json | PK(action_name,version)；approval_mode=`auto/required`；独立 Policy 决定是否允许，禁用工具不通过审批解禁 |

`bank_id` 在 Core 表中指 binding 的内部 ID，`provider_bank_id` 是 Hindsight ID。所有同 bank 子表用携带 bank_id 的复合 FK，不能只用一个全局来源 ID 声称隔离。多类型原记录与 citation 引用使用版本化封闭 JSON schema 和所属模块校验；不能依靠模型传来的声明。

source registry 的原记录引用同时检查 owner/workspace/bot 归属；共享来源引用 publication 的明确发布内容快照或用户直接维护的共享文档，不用可读取私有原文的链接代替。发布版本由用户指示确定，不是每次 A2A 的人工审批。缓存记录的 bank 集合、Bot 与 Task 必须匹配，引用不属于当前范围时不返回原文或综合正文。

Core 与 PostgreSQL 没有共享事务：原记录 + outbox 原子提交，之后投递，确认后保存回执。Hindsight 的内部表迁移由其固定版本管理，Core 不直接 INSERT / UPDATE 引擎业务表，也不保证远程 LLM 只收费一次。

## 9 Hindsight 接入和恢复

### 9.1 Adapter 端口

Memory 模块统一暴露 `retainSource`、`recallForBot`、`expandEvidence`、`reflectForBot`、`readKnowledgePage`、`publishMemory` 与 `forgetMemory`。Hindsight SDK / HTTP DTO 留在适配器里，Pi 和领域代码不依赖其数据库模型。

`memory.search` 保留既有 documents / messages 字段，扩展类型化记忆与 citations；`memory.read(documentId)` 保持明确文档含义；新增 `memory.expand(ref)` 与 `memory.page.read(pageKey)`。默认只读能力明确写入 BotPolicy，不在运行时发现空策略后增权。

每次调用先计算允许的 bank，禁止模型调用原始 Hindsight MCP、列出所有 banks 或访问 daemon。服务凭据和 loopback 是入口限制，bank 授权仍由 Core 强制执行。可使用 Hindsight 的 authentication / operation validator 扩展作为额外检查，不能单靠 tags 或 bank 名称实现权限。参见 [Extensions](https://hindsight.vectorize.io/developer/extensions)。

### 9.2 文档更新与幂等

Hindsight 的同 document_id retain 会替换旧内容及其事实，删除文档会删除从它提取的记忆。参见 [Documents API](https://hindsight.vectorize.io/developer/api/documents)。这不能直接等同于 Core 的乐观锁或长期请求去重。

每个来源版本由映射表固定 provider document ID 与哈希。普通重试沿用同一 ID；新版本不能在旧请求未知时无条件覆盖，单个来源串行变更。消息作为独立来源保留历史；用户维护的当前文档更新时保留 Core 版本记录，并先处理旧的引擎快照，再提交新版本。

操作返回后保存 provider_operation_id；API 接收成功不等于后台整理完成。请求超时或 Core 崩溃，先核对 operation / document 状态与哈希，再决定完成或重投；无法核实时标 unknown，禁止宣称已保存。相同 document ID 可能避免重复文档，不能保证重复抽取无额外费用或 facts ID 不变。

Core transfer 状态与 Hindsight operation 状态分别记录，不复制一套引擎 worker。Hindsight 有自己的持久作业队列与状态接口，Core 负责业务源投递、跟踪和补偿。参见 [Operations API](https://hindsight.vectorize.io/developer/api/operations)。

### 9.3 调用预算与模型网关

Hindsight 复用同一模型配置与 Key，所有实际 LLM 请求经过 Core 的受认证 ModelGateway / 兼容代理：发出前登记请求、预留预算，返回后记 usage；retain 重试、consolidation、页面刷新和 reflect 内部多轮均计入。

Hindsight 集成层必须把 bank、operation、purpose 和根 Task 关联传给网关，并为引擎后台任务持久保存关联。普通 HTTP 请求头不会天然出现在 Hindsight 的延后 worker 中；官方扩展文档明确区分请求上下文与后台工作。M0 必须验证所固定版本的 hooks / 模型 transport 接入，不能靠给前端请求添加一个 header 就假定完成预算追踪。

没有有效操作身份或预算的模型请求在网关拒绝；Hindsight 不获得用户的原始 provider Key 来绕过网关。Core 模型适配层转换为配置的 provider 协议，不要求另一个 API Key。其兼容格式、流式、工具格式和错误处理单独验证。

默认后台并发 1，用户任务优先；每 bank 每 UTC 日后台最多 30 个真实请求 / 100,000 预留 tokens，全工作空间最多 100 请求 / 300,000 tokens。Task 内 recall / reflect 的远程请求还计入根任务预算。额度用完暂停整理，原始记录不丢；未知价格只显示 token / 次数，不捏造费用。

### 9.4 故障与可见性

Hindsight 不可用时，Core 仍保存消息、任务与待投递事件；可以按实际可用范围回答和检索自己的原文，明确长期记忆暂不可用，不伪装为完整 recall。服务恢复后从已登记来源增量追赶，不重新扫描全盘或导入其他 Bot 的资料。

删除、纠正或权限撤回开始时，先推进可见性 generation，清空受影响缓存，并隔离相应 bank 的派生读取。直到 provider 删除、来源核对及相关 observation / page 的清理或重建确认完成才解除。此期间可读取另外未受影响的 bank；不能只过滤 recall facts，却仍展示可能含旧内容的综合答案。

## 10 共享 纠正和遗忘

共享发布使用确定版本的内容快照。用户指示大家记住一件事时发布到共享 bank；修改私有原文不自动替换已经发布的共享内容。之后明确更新共享版本，或撤回发布。普通共享指示自动完成，涉及对外披露、批量不可恢复删除等危险副作用才进入执行方批准流程。

用户纠正记录为新的用户来源，保留“获知时间”和“发生 / 适用时间”。有明确纠正才能判定旧状态失效；没有足够证据的冲突同时保留并说明。Hindsight 综合能力通过中文样例验证，Core 不凭新的 assistant 总结冒称用户已确认。

用户在自己的界面删除一条记忆，先登记来源排除 / 撤回规则，后续回填不重新导入相同内容。彻底遗忘按明确范围清理 Core 原始记录、Hindsight 文档和派生、A2A 可定位副本、Pi 投影与缓存。活动 Task 先停止并清理旧上下文，防止回写。

Hindsight document delete 不等于完成所有主题级遗忘。必须验证 observations、knowledge pages、引用和在途作业都已失效；无法逐项证明时保持 bank 隔离并只从有效来源重建。Core 控制的来源 / 共享 / A2A 关系用来追踪副本，不能承诺识别所有没有出处的自然语言转述。

隐私清理不保留被忘原文到审计日志。旧备份、已发到用户配置 provider 的请求和 SSD 历史页不能据此承诺绝对消失；备份需要另行处理，恢复旧备份后先应用保存的遗忘清单，再开放检索和回填。

## 11 迁移与实施顺序

### M0 主设备真实集成验证

在隔离主设备 profile 中验证固定 Hindsight、数据库、中文模型、服务鉴权、两 bank 隔离、文档更新 / 删除、后台作业、模型预算接入、启动 / 关闭与 Windows 安装包兼容性。固定版本从 v0.10.3 验证起，tag commit 为 `eb6df499d35300e5b2f3f029b2e6adda04ed90f8`；模型与依赖也固定 revision/hash。只用合成内容，不修改现有用户数据。

### M1 自动 A2A 和执行方审批

移除生产初始化的默认 Bot 创建逻辑及空列表补建逻辑，客户端提供空状态与显式创建入口。所有用户创建的 Agent 使用统一创建用例和基础策略；既有 Agent 保留。目录、检索、权限和路由不得按名字或固定职业分支。

移除 `agent.delegate` 的逐次审批，接入公开职责目录与风险判定。普通记忆私有写入与已授权设备读取直接执行；危险命令在接收方联系人展示审批。保持既有 A2A call / child / root IDs、预算、恢复和取消。

迁移旧的 pending A2A 批准时，通过正式状态命令取消已经不适用的 Approval，再按新策略重新评估同一个未执行 ToolCall，不能伪造“用户已经批准”；已经明确拒绝或取消的旧调用不自行复活。危险操作的既有待批准记录保持约束并重新检查策略版本。

### M2 Hindsight bank 与增量来源

按原 Bot ID 建立 bank 映射，既有私有 / 共享文档保留 ID、版本和内容，通过 outbox 同步；新消息与 A2A 自动 retain。保留旧 history API 和原文关键词兜底。逻辑遗忘、来源排除与 bank 隔离必须先完成，再启用自动导入。

### M3 通用 Agent 检索与自动求助

接入私有 + 共享 recall、缓存与证据展开，根据目录自动咨询同伴。新能力逐项进入明确 BotPolicy；原本禁用记忆或 A2A 的 Bot 不因升级得到运行时隐式增权。

### M4 综合记忆与主设备交付

启用受预算约束的 reflect 和三类知识页，完善共享变更、完整遗忘、备份恢复核对。打包主设备安装器与客户端 / Node，验收两台设备访问同一 Core 的连续身份和记忆。主设备从未部署 Hindsight 的现有 0.3.3 安装不能被直接宣称已经升级到本方案。

## 12 验收契约

服务 / 消息变更沿用 `docs/verification/README.md` 与 `docs/verification/personal-os.md` 的隔离 fixture；不向用户在线应用发送测试消息。只有文档修订时不运行或修改真实记忆服务。

| 场景 | 必须证明的结果 |
|---|---|
| 空工作空间 | 全新安装、重启与客户端重连均为零 Agent；不创建联系人、任务或模型请求；用户创建后才有对应实体与私有 bank 映射 |
| 实例管理 | 归档最后一个 Agent 后不补建；升级保留旧实例与历史；bank 不因更名变化 |
| 统一执行 | 多个任意名字的 Agent 复用同一流程；名字与职责变化只更新实例资料和目录，不触发预设权限、专用提示词或角色路由 |
| 主设备 | Core、Hindsight 与数据库在同一主设备受管理运行；客户端 / Node 不能直接访问引擎 |
| 私有检索 | 任意 Agent 只调用自身私有 bank 与共享 bank，目录读取不触碰同伴私有 bank |
| 公开职责 | 每个 Bot 知道其他联系人的身份与能力；改名 / 改职责后下一次模型请求使用最新目录，不发额外通知 |
| 自动求助 | 任意 Agent 按当前目录选择合适同伴；同伴检索自己的 bank 并回复，无 A2A 批准框；只有一个 Agent 时不依赖隐藏同伴 |
| 独立权限 | 发起方没有某项工具，仍能咨询有该能力的同伴；接收方未获授权时不执行，获得授权但危险时只向执行方联系人请求批准 |
| 危险执行 | 父子 ToolCall 参数绑定、批准归属与一次执行保持正确；父 Bot 不弹重复框、不复用子 Bot 的许可 |
| 原文和派生 | 提取来源与发言者可追踪，计划不算成功，同伴转述不升级为用户亲述 |
| 中文 recall | 至少 100 条标注查询覆盖改写、短姓名、时间、否定与中英混合；支持事实 Recall@10 ≥ 0.85，较当前 LIKE 基线提升 ≥ 0.20 |
| 纠正 / 删除 | 当前偏好正确，旧记录可解释；共享撤回、并发删除与在途整理不会重新泄漏派生内容 |
| 崩溃 / 重试 | Core 与引擎分别重启后能核对已交付结果；unknown 不盲目重发，A2A 不重复派发 |
| 预算 | 每个真正远程模型请求都关联来源 / operation / Task 并被记账；后台和 reflect 内部调用不能绕过上限 |
| 安装包 | Setup / Portable 能启动固定引擎资源，断网不隐式下载；升级保留用户数据，退出不遗留受管理进程 |

以上是发布门槛。Windows 原生引擎打包、中文质量、异步预算上下文和清理后的派生一致性必须提供真实隔离验证，不能以 API 返回成功替代验收。
