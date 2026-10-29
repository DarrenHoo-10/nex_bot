# 用户主题与助手主题：归属、权限与转交

状态：草案（2026-10-30）。范围：Core（`server/personal-os`）。不新增设置界面：权限在对话里产生，变更以系统消息显示。
前置：[记忆重新设计](memory-recall.md)的主题条目（迁移 35，[topic-memory.ts](../../server/personal-os/topic-memory.ts)）。
线上主题迁移（`topics-v1`）跑完之后才开始归组与升级。
取代 [持续事项](continuity-items.md) 和已删除的草稿 `topic-projects.md`、`topic-containers.md`。

## 1. 目标

- 记忆的主人是用户。用户自己的事（nex_bot、投资、健康……）是**用户主题**，交给哪个助手，哪个助手才能访问。
- 助手积累的做事经验是**助手主题**，只属于它自己。
- 一个主题可以装下几千条来自对话的资料（事实、段落档案、记忆文档），仍然检索准、能维护。主题最多两级。
- 助手之间有一张**助手地图**，知道彼此负责哪些用户主题；问到自己无权访问的事，交给负责的那一个助手。
- 权限全部在对话中自动产生，包括敏感主题，不弹确认，不做设置界面。

## 2. 现状

| 已有 | 说明 |
|---|---|
| 主题条目 | `assistant_memories.kind='topic'`，属于一个助手（`bot_id`）；标题 ≤ 30 字，说明 ≤ 60 字，正文 ≤ 400 Token；证据在 `assistant_topic_evidence` |
| 事实分类 | 提取规则把记忆分成 `fact`（召回时标为 `user_stated`）和 `experience`（`agent_inferred`），见 `assistant-memory.ts:154` |
| 可见范围 | 主题、事实、段落档案只有本助手可见（`retrieval-index.ts` 的 `scope`）；记忆文档可以是本助手私有，也可以工作区共享 |
| 核心记忆 | 每个助手一份，另有一份工作区共享；模型只能改自己那份（`memory.core.update` 只接受 `scope='bot'`） |
| 同伴目录 | `agent.directory`（`policy.ts:94`）：名字、身份说明、专长、能力、忙闲；没有“负责什么” |
| 委派 | `agent.delegate`：只发送问题和必要背景，不复制私有历史；结果以 `peer` 消息回到委派方 |
| 记忆提取 | 读取本助手的 `user`、`assistant`、`peer` 三种消息（`assistant-memory.ts:303`），也读取段落档案 |

## 3. 模型

### 3.1 两类主题

| | 用户主题 | 助手主题 |
|---|---|---|
| 归谁 | 用户 | 一个助手 |
| 内容 | 用户自己的事：状态、决定及原因、约束、偏好 | 助手的做事经验：做法、环境细节、踩过的坑 |
| 证据 | `fact`（用户原话里的信息） | `experience`（助手自己的总结） |
| 谁能访问 | 被授权的助手（第 5 节） | 只有它自己 |

两类主题结构相同，都最多两级：**容器主题**只有子主题和汇总概要；**叶主题**有证据和成员。没有父主题的叶主题就是顶层主题。

**事实按主题归位，不按提取者归位。** 一条 `fact` 无论是哪个助手提取的，都并入最接近的用户主题；提取它的助手并不因此获得该主题的访问权。
例如用户在理财助手那里顺口提到 nex_bot，这条事实会进入 nex_bot 主题；归并时读写 nex_bot 正文的是该主题的维护者，理财助手看不到。
没有足够接近的用户主题时，新建一个用户主题，默认由提取它的助手负责。

### 3.2 每个用户主题的两个设置

| 设置 | 选项 | 默认 |
|---|---|---|
| 访问范围 | 指定助手：负责（读写）或可读；或者全部助手（`*`，以后新建的助手也包括在内） | 产生第一批证据的助手负责 |
| 加载方式 | 常驻：概要放进核心记忆，每次请求都带上；按需：召回时才带上 | 按需 |

### 3.3 “关于我”

“关于我”是一个特殊的用户主题：访问范围为全部助手，加载方式为常驻，取代现在工作区共享核心记忆里的“关于用户”。

- 它可以有子主题（沟通偏好、设备、健康……）。子主题默认继承“全部助手”，用户可以在对话里单独收紧（“别让理财助手看我的健康情况”）。
- 只有它的概要常驻，子主题按需召回。
- **只接受 `fact`。** `experience` 不能进入“关于我”，否则一个助手的推断会通过常驻加载扩散到所有助手。
- 用户手工改过的行保持不动（现有规则）。

## 4. 主题边界

### 4.1 什么时候建容器

一组顶层叶主题要收进一个新容器，三条都要满足：

1. **有锚点**：围绕一个具体对象，比如一个仓库或产品、一个账户或资产组合、一家公司或客户、一个长期活动（某项考试、某次装修）。泛泛的同类话题不建容器。
2. **会复现**：证据原文分布在至少 3 个不同的日子，最早和最晚相隔至少 14 天。按原文消息的时间算，因为迁移会在同一天批量写入事实。
3. **上下文独立**：这组主题的约束和事实只在这个领域成立，带到别的领域会误导。

用户明确要求时可以跳过第 2 条；没有锚点的仍然不建，模型请用户说出范围。

### 4.2 粒度规则

| 规则 | 例子 |
|---|---|
| 按领域分，不按任务分。和已有容器共用锚点的主题，进入该容器 | “nex_bot 记忆系统”进入 nex_bot |
| 一个容器至少 3 个子主题；少于 2 个时解散，子主题回到顶层 | |
| 每个助手可见的容器最多 10 个（`CONTAINER_LIMIT`），达到上限后只能合并 | 迫使粒度保持粗 |
| 只有两级；子主题超过 40 个时，展开只列召回最多、最近更新的 20 个 | |
| 用户主题和助手主题不混在同一个容器里 | |

### 4.3 后台整理能做什么

| 动作 | 方式 | 条件 |
|---|---|---|
| 子主题继承 | 自动，确定性 | 归并时从叶主题 X 拆出的新主题，与 X 同属一个容器、同一种归属 |
| 进入已有容器 | 自动，确定性 | 标题或正文含容器的名称、别名或锚点；或者与容器中心向量相似度 ≥ 0.7 且比第二名高至少 0.05 |
| 新建容器 | 自动，一次模型调用 | 满足 4.1；模型确认锚点并给出名称、别名、概要，没有锚点就不建；每次最多 1 个 |
| 合并容器 | 自动 | 锚点规范化后相同，**且两边的访问范围完全相同**；访问范围不同时保留为两个主题，由转交规则（第 6 节）处理 |
| 拆分容器 | 不做 | |
| 解散容器 | 自动 | 有效子主题少于 2 个 |

宁可不归，也不错归。每个动作写一行 `assistant_topic_moves`，可以撤销；`placed_by='owner'` 的归属不会被后台改动。
合并要求访问范围相同，是因为合并会让一方看到另一方的内容，这只能由用户的话来决定（第 5 节）。

### 4.4 段落档案和记忆文档归到哪个主题

在后台整理时确定，因为事实是在归档之后才提取出来的：

1. **按事实**：来源消息落在这一段里（同一会话，时间在 `started_at` 与 `ended_at` 之间）的事实，至少 2 条指向同一个叶主题时，归入该主题，按事实数取前 3 个。
2. **按向量**：档案向量与叶主题向量相似度 ≥ 0.7，且比第二名高至少 0.05。
3. 都不满足就不归属，仍然可以检索。

记忆文档只用第 2 条。一份档案或文档最多属于 3 个主题，因为归属只用来加分，不用来过滤。

## 5. 权限

### 5.1 角色、继承与覆盖

- 角色：**负责**（读写，维护费用由它承担）、**可读**、**无**。
- 授权对象可以是具体某个助手，也可以是 `*`（全部助手）。
- 子主题继承父主题的授权；子主题上的授权覆盖继承来的授权；对具体助手的授权覆盖对 `*` 的授权。“别让理财助手看我的健康”就是在“健康”子主题上给理财助手写一条“无”。
- 一个用户主题至少有一个负责者；撤销最后一个负责者时，该主题转由用户最近对话过的、可读它的助手负责；没有可读者时，交给最初的负责者，并在对话里说明。

### 5.2 权限覆盖什么

被授权的助手可以读该主题的概要、子主题和事实。**不包括**其他助手的对话原文（`message:`、`entry:`），也不包括其他助手的段落档案。
需要原文时，委派给拥有那段对话的助手。这和现在“委派不复制私有历史”的规则一致。

### 5.3 在对话中授权和撤销

模型调用 `memory.topic`（第 11 节）完成授权或撤销，Core 在执行前做两项检查：

1. **来源检查**：触发这次调用的任务必须是用户在 1:1 对话里发起的。委派产生的子任务（`a2a_messages.child_task_id`）、例行任务（`routine_origins`）、
   webhook 等其他来源一律拒绝。工具结果、网页内容、其他助手的回复都不能触发授权。
2. **原话检查**：调用必须带 `quote`，是用户这次任务输入里的原话（规范化空白后，作为子串出现，至少 4 个字）。对不上就拒绝。
   这样模型的理解只用来判断是哪个主题、给谁，授权本身必须有用户的话作为依据。

| 用户说的话 | 结果 |
|---|---|
| 对理财助手说“以后我的投资交给你管” | 理财助手负责“投资” |
| 对开发助手说“把投资交给理财助手” | 理财助手负责“投资”；任何助手都能替用户把主题交给别的助手 |
| “你也看看 nex_bot 吧” / “以后你也能看 nex_bot” | 当前助手可读 nex_bot |
| “以后别让理财助手看 nex_bot” | 撤销，在任何助手那里说都立即生效 |
| “把 nex_bot 常驻” | 加载方式改为常驻；超出核心记忆上限时拒绝，并提示需要精简 |
| “谁能看我的健康信息” | 列出当前授权（`memory.topic` 的 `access`） |

- 授权只针对用户点名的那个主题及其子主题，不顺带授权相邻主题。模型拿不准用户指的是哪个主题时要问，不能猜。
- 每次变更在发生的对话里写一条系统消息，比如“已允许 理财助手 负责「投资」”，使用现有的系统消息（`agents.ts` 的 `publish`），各客户端都已能显示。
- 敏感主题（健康、财务账户、证件、家庭与人际）**也不弹确认**，这是已定的产品决定。防线是上面的来源检查和原话检查，以及随时可以撤销。

### 5.4 没有临时读权限

用户直接问一个无权访问的主题时，不授予临时读权限，按第 6 节转交。只有用户明确说“你也看看”“以后你也能看”，才算授权。

## 6. 无权限时的转交

1. **Core 识别。** 召回前的主题路由（8.2）在**全部**用户主题上判断，包括当前助手无权访问的。命中的主题当前助手无权访问时，
   Core 在这次请求的易变尾部加一行：本次问题涉及「nex_bot」，你没有访问权限，由 开发助手 负责，用 `agent.delegate(botId, message, topic="memory:<id>")` 交给它。
   提示里只出现顶层容器的名称，不出现子主题名称。
2. **只交给一个助手。** 目标由 Core 选定：该主题的负责者；有多个负责者时，取最近维护过它的那个。
3. **硬限制。** 带 `topic` 的委派必须发给 Core 指定的助手；同一个任务里，同一个主题只能委派一次。违反时拒绝，并把指定的目标告诉模型。
4. **多个主题。** 一个问题涉及几个无权访问的主题时，每个主题各委派一次。当前助手有权访问的部分自己回答。
5. **负责的助手**按自己的权限查、自己回答；问题以委派消息进入它的子会话，按现有规则处理。

### 6.1 转交回来的内容不进提问助手的记忆

否则提问的助手会把对方的回答提取成自己的事实，等于绕过了权限。规则：

- 一个任务只要出现过无权访问主题的提示，该任务里的 `peer` 结果消息，以及委派之后的 `assistant` 消息，都不参与记忆提取。用户的消息照常提取。
- 段落归档时，Core 在交给整理模型之前，把这些消息替换成一行“（已转交 开发助手 回答 nex_bot 的问题，内容不归档）”，所以档案里也不会有。
- 原文仍然留在提问助手的对话记录里，用户能看到，`message:`/`entry:` 也能展开。这条规则管的是派生出来的记忆（事实、主题、档案），不是用户自己的聊天记录。

## 7. 助手地图

同伴目录（`agent.directory`）增加 `responsibilities`：每个助手**负责**的顶层用户主题名称。

```text
- 开发助手：负责 nex_bot、服务器与设备
- 理财助手：负责 投资、家庭账单
```

- 只列顶层名称，不列子主题、概要和“可读”关系，避免把内容带给不该看的助手。“关于我”不列，因为它对所有助手开放。
- 助手主题不进地图，标题也不显示。
- 地图在系统提示的固定前缀里（同伴目录本来就在那里），只在负责关系变化时才变。

## 8. 召回与加载

### 8.1 检索范围

一个助手的检索范围是：它自己的助手主题和资料，加上它负责或可读的用户主题（顶层、子主题和事实），再加上工作区共享的记忆文档。
`retrieval-index.ts` 里 `memory` 池的 `scope` 从 `r.bot_id=?` 改为“`r.bot_id=?`，或 `r.id` 是本助手可访问的用户主题或其事实”。
其他助手提取、但还没有并入用户主题的事实，在并入之前不可见。

### 8.2 路由加分，不过滤

在 `Retrieval.retrieve` 里、查询向量算出之后判断，复用同一个向量：

1. 提示里出现顶层主题的名称、别名或锚点：命中，最多 2 个。
2. 否则查询向量与容器中心向量相似度 ≥ 0.6，且比第二名高至少 0.05：命中 1 个。
3. 都不满足：不路由。

命中的主题当前助手可以访问时：在 BM25 或向量已检出的候选里，属于它的资料（容器自身、子主题、成员档案和文档）在 RRF 融合时加 `1/(RRF_K+1)`，
更容易进入重排前的前 20 名；是否召回仍由重排门槛（0.3）决定。没被检出的资料不会被加进来。
无权访问时走第 6 节。命中和加分记录在 `task_recall.topic_ids`。短输入（“继续”）按现有规则不召回，路由也不运行。

### 8.3 核心记忆的组成

每个助手的核心记忆（≤ 1500 Token）由三部分拼成：

1. **常驻的用户主题概要**：“关于我”，以及用户设为常驻、该助手可读的其他用户主题。
2. **主题索引**：该助手可访问的顶层用户主题，以及它自己的顶层助手主题，每个一行；容器一行，子主题不单独占行。用 `memory.search("memory:<id>")` 展开下一层，最多 20 个。
3. 该助手现有的 `about` 行，保持不变（第 10 节）。

放不下时，先去掉召回最少、最旧的叶主题行，再去掉容器行，常驻概要不去掉；常驻设置导致超出上限时，在设置时就拒绝。
索引跟着现有的更新节奏（≥ 5 个新事实，且距上次 ≥ 6 小时），不增加前缀缓存失效的次数。

### 8.4 向量扫描

现在每次查询都从 SQLite 读出本助手的全部向量（`vectorRows`）。本助手可访问的向量超过 2000 个时，改为在内存里缓存一份矩阵：
按（助手、模型、维度）缓存，`memory_vectors` 或访问授权变化时作废；全部缓存合计不超过 128 MB，超出时淘汰最久未用的助手。结果必须与逐条计算一致。

## 9. 维护（后台步骤 `organize`）

在 `assistant-memory.ts` 的 `process` 里，`consolidate` 和 `indexTopics` 之间加一步 `organize`，加入 `steps` 列表，有自己的失败退避，
只在 `topics.migrated(botId)` 之后运行，受记忆开关和每日预算约束。

- **谁来维护**：用户主题由它的负责者在自己的整理中维护，费用算在该助手的每日预算里；有多个负责者时，由最近维护过它的那个负责。助手主题由它自己维护。
- **事实归并**：`merge` 处理本助手负责的用户主题时，也要取其他助手提取、尚未归位的 `fact`（`pending()` 不再只按 `bot_id` 取）。`experience` 只进本助手的助手主题。
- **一次整理依次做**：
  1. 子主题继承；
  2. 档案与文档归属（4.4），每次最多 200 项；
  3. 进入已有容器；
  4. 新建容器（新增顶层叶主题 ≥ 5 个，且距上次判断 ≥ 24 小时；一次模型调用）；
  5. 合并与解散；
  6. 重写容器概要：自上次以来至少 3 个子主题有变化、或子主题有增减，或满 7 天且有变化；最多 2 个，每个容器每 24 小时最多一次。
- 第 4、6 步之外不调用模型；一次整理的模型调用不超过 3 次。叶主题加入新档案时不改写概要。

## 10. 表结构与迁移

### 10.1 表（迁移 36，取当时的下一个迁移号）

```sql
-- 主题的归属、层级与加载
ALTER TABLE assistant_topics ADD COLUMN owner TEXT NOT NULL DEFAULT 'bot';   -- 'bot' 助手主题 | 'user' 用户主题
ALTER TABLE assistant_topics ADD COLUMN role TEXT NOT NULL DEFAULT 'leaf';   -- 'leaf' | 'container'
ALTER TABLE assistant_topics ADD COLUMN parent_id TEXT;
ALTER TABLE assistant_topics ADD COLUMN special TEXT;                         -- 'about_me' 或 NULL
ALTER TABLE assistant_topics ADD COLUMN resident INTEGER NOT NULL DEFAULT 0; -- 常驻
ALTER TABLE assistant_topics ADD COLUMN anchor TEXT NOT NULL DEFAULT '';
ALTER TABLE assistant_topics ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE assistant_topics ADD COLUMN placed_by TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE assistant_topics ADD COLUMN split_from TEXT;
ALTER TABLE assistant_topics ADD COLUMN overview_stale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assistant_topics ADD COLUMN overview_at INTEGER;
CREATE INDEX IF NOT EXISTS assistant_topics_parent ON assistant_topics(parent_id);

-- 用户主题的授权；principal 为助手 id 或 '*'
CREATE TABLE IF NOT EXISTS user_topic_access(
  topic_id TEXT NOT NULL, principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('steward','reader','none')),
  granted_by_bot TEXT NOT NULL, task_id TEXT NOT NULL, quote TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY(topic_id,principal)) STRICT;
CREATE INDEX IF NOT EXISTS user_topic_access_principal ON user_topic_access(principal);

-- 档案与文档归属哪些叶主题（每项最多 3 个），以及已判断过的项
CREATE TABLE IF NOT EXISTS assistant_topic_members(
  topic_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('episode','document')), ref_id TEXT NOT NULL,
  bot_id TEXT NOT NULL, placed_by TEXT NOT NULL DEFAULT 'auto', added_at INTEGER NOT NULL,
  PRIMARY KEY(topic_id,kind,ref_id)) STRICT;
CREATE INDEX IF NOT EXISTS assistant_topic_members_ref ON assistant_topic_members(kind,ref_id);
CREATE TABLE IF NOT EXISTS assistant_topic_member_scan(
  bot_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, scanned_at INTEGER NOT NULL,
  PRIMARY KEY(kind,ref_id)) STRICT;

-- 归组与授权的每次变动，用于撤销与核对
CREATE TABLE IF NOT EXISTS assistant_topic_moves(
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, topic_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('contain','release','create','promote','merge','dissolve','rename','grant','revoke','resident','revert')),
  before_json TEXT NOT NULL, after_json TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('auto','owner','model')), reverted_by TEXT, created_at INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS assistant_topic_moves_bot ON assistant_topic_moves(bot_id,created_at);

-- 无权限转交：用于委派的硬限制与记忆隔离
CREATE TABLE IF NOT EXISTS topic_delegations(
  task_id TEXT NOT NULL, topic_id TEXT NOT NULL, target_bot_id TEXT NOT NULL,
  call_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(task_id,topic_id)) STRICT;

ALTER TABLE task_recall ADD COLUMN topic_ids TEXT NOT NULL DEFAULT '[]';
```

- `assistant_memories.bot_id` 对用户主题表示“最初的负责者”，不再表示可见范围；可见范围只看 `user_topic_access`。
- 容器的 `refs_json` 为 `[]`。`TopicMemory.topics()` 对容器不调用 `valid()`，改为要求至少 2 个有效子主题。
- `user_topic_access` 的 `steward` 对应正文里的“负责”，`reader` 对应“可读”。

### 10.2 迁移原则：不改变可见范围

迁移和自动整理都不能让任何助手看到它以前看不到的内容。只有用户的话（第 5.3 节）可以扩大可见范围。

1. **结构**：所有现有主题保持为助手主题、顶层叶主题，召回结果和核心记忆文本与迁移前逐字节相同。
2. **“关于我”**：工作区共享核心记忆的 `about` 行转为“关于我”的概要，访问范围 `*`，常驻。所有助手本来就能看到这些行，可见范围不变。
3. **助手自己的 `about` 行**：保持在该助手的核心记忆里，不并入“关于我”，因为并入会让其他助手看到。之后用户说“记住……”时写入的是“关于我”。
4. **升级为用户主题**：后台整理把证据中 `fact` 占 70% 以上的助手主题升为用户主题，访问范围只有原来那个助手，记为一行 `promote`，可以撤销。
   可见范围不变，所以全自动。
5. **同名的用户主题**：两个助手各自升级出的“nex_bot”访问范围不同，不会自动合并；用户把 nex_bot 交给一个助手之后，两边范围一致，下一次整理时合并。

## 11. 工具与提示

新增动作 `memory.topic`，由 `memory.write` 的授权覆盖（与 `memory.core.update` 相同，`policy.ts:23`），自动执行：

| `op` | 参数 | 作用 |
|---|---|---|
| `tree` | | 本助手可访问的主题树 |
| `access` | `topic` | 该主题的当前授权（只对可访问它的助手开放；无权访问时返回负责者） |
| `grant` | `topic`、`bot`（或 `*`）、`role`、`quote` | 授权；做来源检查与原话检查 |
| `revoke` | `topic`、`bot`（或 `*`）、`quote` | 撤销；同样检查 |
| `resident` | `topic`、`on`、`quote` | 设为常驻或取消 |
| `group` / `move` / `rename` / `merge` | 同前 | 按用户要求调整结构，`placed_by='owner'`；`merge` 要求访问范围相同 |
| `revert` | `moveId` | 撤销一次变动 |

`agent.delegate` 增加可选参数 `topic`，用于第 6 节的转交。

系统提示增加三句：用户把某件事交给某个助手、要求某个助手也能看、或要求收回时，用 `memory.topic` 并在 `quote` 里填用户的原话；
提示说某个主题由别的助手负责时，用 `agent.delegate` 带上 `topic` 交给它，不要自己回答这部分；不要主动归组，后台整理会处理。

需要同步修改：`runtime.ts:97` 可恢复工具列表、`runtime.ts:625` `targetId`、`agents.ts:349` 工具摘要、`broker-tool.ts` 动作说明。

## 12. 遗忘与一致性

- 叶主题被遗忘或退役：离开容器，容器概要标为待重写；有效子主题少于 2 个时解散。重写前容器只显示“主题（待整理）”。
- 档案或文档被遗忘：删除它的成员与扫描记录。
- 遗忘覆盖整个助手：删除它的助手主题、它在 `user_topic_access` 中的授权、它的变动记录和向量缓存。
  它负责的用户主题**不删除**，因为它们属于用户：按 5.1 转给其他负责者；其中来自该助手对话的事实随来源一起被遗忘。
- 容器名称、别名和概要由模型生成，任一子主题被遗忘时一起重写。

## 13. 分阶段

1. **结构**：两级主题、成员、`organize`、索引折叠、路由加分、向量缓存。只作用于助手主题，行为与现在一致，便于单独验证。
2. **归属与权限**：用户主题、“关于我”、升级、授权与撤销、助手地图、无权限转交与记忆隔离。
3. **按实测决定**：超过 3000 字的档案与文档分块（需要重建 `memory_vectors`，加 `chunk` 类型）。

## 14. 改动清单

| 内容 | 文件 |
|---|---|
| 迁移 | `store.ts`，新建 `user-topic-schema.ts` |
| 层级、成员、归组、升级、合并、解散、撤销、容器概要 | 新建 `topic-tree.ts` |
| 授权、继承与覆盖、来源与原话检查 | 新建 `topic-access.ts` |
| `organize` 步骤、跨助手事实归位、提取时跳过转交内容 | `assistant-memory.ts`（`steps`、`process`、`retainPending`）、`topic-memory.ts`（`pending`、`commit`、`topics`、`indexTopics`） |
| 档案输入替换转交内容 | `runtime.ts`（`summarize` 的 `episode` 分支） |
| 检索范围、路由、加分、向量缓存、容器展开 | `retrieval-index.ts`（`scope`）、`retrieval.ts`（`retrieve`、`exact`、`vectorHits`）、`task-recall.ts` |
| 核心记忆拼装、常驻概要、“关于我” | `core-memory.ts`、`topic-memory.ts` |
| 无权限提示、委派硬限制 | `runtime.ts`（易变尾部、`delegate`） |
| 助手地图 | `policy.ts`（`directory`） |
| 工具与提示 | `runtime.ts`、`policy.ts`、`agents.ts`、`broker-tool.ts` |
| 遗忘 | `memory-privacy.ts` |

## 15. 验证

按 [docs/verification/README.md](../verification/README.md)：只用临时目录里的隔离实例、合成模型和合成检索服务，不碰线上数据。
新建 `server/personal-os/topic-tree.test.ts` 与 `server/personal-os/topic-access.test.ts`，沿用 `memory-topics.test.ts`、`memory-recall.test.ts` 的夹具；
合成检索服务按文本返回可控的向量，以便精确构造相似度。

### 15.1 结构（阶段 1）

- 迁移后召回结果、核心记忆文本与迁移前逐字节相同；重复运行没有变化。
- 建容器：满足复现与锚点的 4 个主题建出容器；一天之内、只有 2 个主题、模型返回空锚点时都不建；被拒绝的组在没有新主题加入前不再送审；达到 10 个后不再新建。
- 进入容器、子主题继承、档案归属（按事实 2 条门槛、最多 3 个主题、向量差距不足时不归）。
- 概要：新档案加入不触发模型调用；容器概要按节奏重写，24 小时内不重写第二次。
- 路由：别名命中时成员档案进入前 20；无关提示的候选顺序与没有容器时逐字节相同；加分后重排低于 0.3 的不出现。
- 索引折叠后容器只占一行，手工改过的行还在，总量 ≤ 1500 Token。
- 向量缓存与逐条计算的前 50 名完全一致；写入或授权变化后作废。
- 一次整理的模型调用 ≤ 3 次；预算用完时 `organize` 跳过。

### 15.2 归属与权限（阶段 2）

- **事实归位**：助手 B 提取的关于 nex_bot 的事实并入 A 负责的 nex_bot 主题；B 的召回和 `memory.search` 都看不到这个主题和这条事实；`experience` 不进入用户主题，也不进入“关于我”。
- **升级**：`fact` 占 70% 以上的助手主题升为用户主题，升级前后每个助手的召回结果和核心记忆逐字节相同。
- **授权**：
  - 用户原话“以后我的投资交给你管”→ 授权成功，对话里出现一条系统消息，地图更新。
  - 模型给的 `quote` 不在用户输入里 → 拒绝。
  - 委派子任务、例行任务、工具结果里出现同样的话 → 拒绝。
  - 授权只覆盖点名的主题及其子主题，不覆盖相邻主题。
- **继承与覆盖**：“关于我”对 `*` 开放，“健康”子主题对理财助手设为“无”后，理财助手能召回“沟通偏好”，不能召回“健康”；新建的助手能看到“关于我”。
- **常驻**：设为常驻后概要进入可读助手的核心记忆；超出上限时拒绝。
- **转交**：
  - 理财助手被问到 nex_bot：易变尾部出现提示，只指向开发助手。
  - 带 `topic` 委派给其他助手被拒绝；同一任务同一主题第二次委派被拒绝。
  - 问题同时涉及投资与 nex_bot 时，只委派 nex_bot 的部分。
- **记忆隔离**：转交任务结束后，理财助手的记忆提取跳过 `peer` 结果和委派之后的回复，但提取了用户消息；该段的档案里只有“已转交”一行；对话原文仍可展开。
- **合并**：访问范围不同的两个“nex_bot”不合并；授权使范围一致后，下一次整理时合并。
- **遗忘**：遗忘整个助手后，它负责的用户主题还在，并已转给其他负责者；来自它对话的事实已被遗忘；不留它的授权、变动记录和向量缓存。

现有测试必须继续通过：`memory-topics.test.ts`、`memory-recall.test.ts`、`retrieval.test.ts`、`memory-native.test.ts`、`memory.test.ts`、`episodes.test.ts`。

### 15.3 线上预演与上线

- 线上主题迁移跑完后，在 Tokyo 用当前数据的**副本**起一个一次性 Core，以 `organize --dry-run` 运行，只输出：每个助手会建出的容器、会升级为用户主题的主题、
  同名但访问范围不同的用户主题、向量数、超过 3000 字的档案占比、单次查询读取向量的耗时。结果只给 owner 看，副本用完即删。用它确定各项初值和第 13 节第 3 阶段要不要做。
- 每个阶段按 [AGENTS.md](../../AGENTS.md) 的部署流程上线 Core；`/health` 为 200；迁移后主题数不变。
- 上线一周后只读统计：召回中有加分的比例、`revert` 占变动的比例、授权与撤销次数、转交次数及被拒绝的委派次数、核心记忆的 Token 数、单次召回的耗时。
- 结果写入 `docs/verification/user-topics.md`，并从 `docs/verification/README.md` 链接。

## 16. 已定与待定

已定：

- 不做设置界面；权限全部在对话中自动产生；敏感主题也不确认。
- 无权访问时不授予临时读权限，由 Core 指定一个负责者转交。
- “关于我”是用户主题中对全部助手开放、常驻的那一个，只接受 `fact`。
- 迁移与自动整理不扩大任何助手的可见范围。

待定：

- 复现条件与档案归属要从事实追到原文的时间与会话；实现时先确认 `refs_json` 的来源都能在 `agent_messages` 里解析到，解析不到时退回事实的 `created_at`，并在 `topics-v1` 完成后的头 14 天里不自动建容器。
- 升级门槛（`fact` 占 70%）和各相似度门槛的初值，以预演结果为准。
- 一个用户主题有多个负责者时，维护费用是否在它们之间分摊。第一版只算在最近维护者头上。
