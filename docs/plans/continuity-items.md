# 持续事项：工作笔记从会话级升级为事项级

状态：搁置（2026-10-29），下一步改为 [用户主题与助手主题](user-topics.md)；持续事项以后作为主题里的内容再做。范围：Core（`server/personal-os`）。第一版不改界面，Web 与 Mac/iOS 无变化。
前置：[记忆重新设计](memory-recall.md)（核心记忆、按提示召回、按会话工作笔记）已上线。

## 1. 目标

- 一件事在不同会话、不同天里都能接着做：在新会话里说“继续”，助手能找到它，并拿到它进行到哪一步、下一步是什么。
- 不另起一套记忆。工作笔记就是事项的正文；Hindsight 风格的提取与召回主链路不动。
- 每次请求里新增的记忆相关内容不超过 300 Token。
- 不要求用户“建项目”。事项由 Core 在写工作笔记时自动建立，用户和模型可以改名、暂停、完成。

## 2. 现状与缺口

| 已有 | 位置 | 说明 |
|---|---|---|
| 按会话的工作笔记 | `conversation_working_notes`（迁移 34，[recall-schema.ts](../../server/personal-os/recall-schema.ts)） | 当前目标、有效约束、未完成事项、引用；≤ 1000 Token；版本号检查 |
| 笔记的写入 | 模型 `memory.write(scope="context")`（`runtime.ts:763`）；压缩与段落归档时 Core 写入（`runtime.ts:250` `writeWorkingNote`） | 模型写超限被拒绝；Core 写超限先压缩到 800 Token |
| 笔记的注入 | `agents.ts:265` `context()` → 易变尾部 | 只注入本会话的笔记 |
| 段落档案 | `conversation_episodes`（[episodes.ts](../../server/personal-os/episodes.ts)） | 段落关闭时冻结 `openItems`、`decisions`、`operations` |

缺口：

1. **跨会话断开。** 笔记的主键是 `conversation_id`，另一个会话看不到（[memory-recall.md:329](memory-recall.md) 已注明）。
2. **未完成事项只有归档，没有后续。** 段落关闭后 `openItems` 留在档案里，没有任何流程去关闭或更新它。
3. **说“继续”召回不到东西。** `RECALL_MIN_CHARS = 4`（`task-recall.ts:14`），“继续”“接着做”会被跳过，而这正是最需要接上的时候。
4. **新话题会改写旧笔记。** 同一会话里换了话题（段落边界 `topic`），新内容写进同一份笔记，旧事的状态被冲掉。

## 3. 设计

### 3.1 概念

- **事项**（continuity item）：属于一个助手，有标题、状态、正文（即工作笔记）和一行“下一步”。
- **会话链接**：一个会话同一时间最多链接一个事项，多个会话可以链接同一个事项。会话的“工作笔记”就是它链接的事项的正文。
- 第一版没有 `type` 字段。项目、任务、待跟进事项只是标题和正文不同，生命周期规则相同；需要按时间提醒的事项用现有的 `routine.save`。

### 3.2 表结构（迁移 36）

```sql
CREATE TABLE IF NOT EXISTS continuity_items(
  id TEXT PRIMARY KEY,                 -- 'c' + 9 位 base36，在索引里短一些
  bot_id TEXT NOT NULL REFERENCES bots(id),
  title TEXT NOT NULL,                 -- ≤ 24 个汉字（≈ 16 Token）
  status TEXT NOT NULL CHECK(status IN ('active','paused','done','dropped')),
  note TEXT NOT NULL,                  -- 原工作笔记正文，≤ WORKING_NOTE_TOKENS
  next_action TEXT NOT NULL DEFAULT '',-- ≤ 40 个汉字，可为空
  task_id TEXT NOT NULL,               -- 最后写入的任务，与原表同义
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,         -- 内容变化
  touched_at INTEGER NOT NULL          -- 内容变化或链接的会话有新输入
) STRICT;
CREATE INDEX IF NOT EXISTS continuity_items_bot ON continuity_items(bot_id,status,touched_at);

CREATE TABLE IF NOT EXISTS conversation_continuity(
  conversation_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES continuity_items(id),
  bot_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_continuity_item ON conversation_continuity(item_id);
```

正文没有拆成 `goal` / `current_state` / `open_items` 几列：这些内容现在本来就是笔记里的段落，由同一个整理模型维护。
拆成列会让模型和 Core 维护两份相同的内容。

### 3.3 迁移

在 `store.ts` 的迁移 35 之后加迁移 36，放在一个事务里：

1. 建上面两张表。
2. `conversation_working_notes` 的每一行生成一个事项，并链接到原会话：
   - `title`：会话标题截到 24 个汉字；标题为空时用“未命名事项”。
   - `status`：`updated_at` 在 14 天内为 `active`，否则为 `paused`。
   - `note`、`task_id`、`version`、`updated_at` 原样复制；`touched_at = updated_at`；`next_action` 为空。
3. `conversation_working_notes` 保留不删，用于回滚（与迁移 34 保留 `assistant_working_notes` 的做法一致）。
4. 委派产生的子会话（`a2a_messages.child_conversation_id`）不迁移、不链接，与迁移 34 的规则相同。

可以重复运行：事项按 `conversation_continuity` 是否已存在跳过。

**回滚**：新版本发布的这一版里，Core 每次写事项正文时，也写一份到当前会话的 `conversation_working_notes`
（同一个事务）。回滚到旧版本时，每个会话仍然有最新的笔记。下一版再取消双写。

### 3.4 写入规则

所有写入都沿用现有的版本号检查：写入方读到的版本已经过期时，本次写入作废，较新的写入保留。

| 时机 | 规则 |
|---|---|
| Core 写笔记（压缩 `history`、段落归档 `episode`），会话没有链接 | 新建事项并链接。标题：段落归档用档案的 `title`，压缩用会话标题 |
| Core 写笔记，会话已有链接 | 写入链接的事项（替代 `writeWorkingNote` 的表） |
| 段落关闭，边界原因是 `gap`（6 小时无输入） | 写入后保持链接 |
| 段落关闭，边界原因是 `topic`（用户换话题） | 先把档案的 `workingNote` 写进当前事项，再解除会话链接；`openItems` 非空时事项保持 `active`，否则转为 `paused`。新话题下一次写笔记时会新建事项 |
| 链接的会话有新输入 | 更新事项的 `touched_at` |
| 事项 14 天未 touched | 不再出现在索引里；同一助手下一次写事项时，在同一个事务里把它转为 `paused`（不删除）。Core 不为此加后台任务 |
| 状态改为 `done` / `dropped` | 解除所有链接到它的会话 |

整理模型的输出增加一个可选字段 `nextAction`（`HISTORY_INSTRUCTION` 与 `EPISODE_INSTRUCTION`，
`parseArchive` 一并解析）：一句话的下一步，≤ 40 个汉字，没有或不确定时为空字符串。为空时不覆盖原有的 `next_action`。

Core 不会自动把事项标为 `done`。完成只能由用户说明，或模型调用工具标记。

### 3.5 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `continuity.list` | `status?`（默认 `active,paused`）、`query?` | 列出本助手的事项：id、标题、状态、下一步、更新时间；`query` 按标题与正文做子串匹配 |
| `continuity.open` | `itemId` | 把当前会话链接到该事项（替换原链接，原事项不变），返回正文与版本 |
| `continuity.update` | `itemId?`（默认当前链接）、`title?`、`note?`、`nextAction?`、`status?`、`expectedVersion` | 修改事项。没有 `itemId` 且会话没有链接时新建并链接。`note` 超过 1000 Token 被拒绝（与现有提示一致） |

- 权限：与 `memory.core.update` 相同，由 `memory.write` 的授权覆盖（`policy.ts:23`），不需要迁移策略数据。
  三个工具都是私有记忆操作，自动执行，不弹批准。
- `memory.write(scope="context")` 保留一个版本，作为 `continuity.update(note)` 写当前链接事项的别名。
  系统提示改为指向 `continuity.update`。
- 需要同步修改的地方：`runtime.ts:97` 可恢复工具列表、`runtime.ts:625` `targetId`、`agents.ts:349` 工具摘要、
  `broker-tool.ts` 的动作说明。

### 3.6 注入与预算

**易变尾部**（在全部历史之后，见 `request-prompt.ts`，不影响前缀缓存，但每次请求都按全价计费）：

1. **当前事项**：替代现有的 `workingNote`。`context()` 返回
   `{ item: { id, title, status, nextAction, note, version } | null }`，上限不变，仍为 1000 Token。
2. **活跃事项索引**：本助手除当前事项外、`status='active'`、按 `touched_at` 倒序的事项，最多 5 条，合计 ≤ 300 Token：

   ```text
   进行中的事项（用户要继续其中一件时用 continuity.open；完整列表用 continuity.list）：
   - [continuity:c3k9x0a2m] NexBot 记忆系统 — 明确记忆与压缩的职责边界（10-28）
   ```

   每行约 55 Token；超出 300 Token 的行不放。没有活跃事项时整段不出现。

| 部分 | 现在 | 之后 |
|---|---|---|
| 核心记忆（固定前缀，可缓存） | ≤ 1500 | ≤ 1500 |
| 按提示召回（每个任务一次） | ≤ 2000 | ≤ 2000 |
| 工作笔记 / 当前事项 | ≤ 1000 | ≤ 1000 |
| 活跃事项索引 | 0 | ≤ 300 |
| **合计** | **≤ 4500** | **≤ 4800** |

索引每次请求都会重新生成，不像召回那样按任务冻结。原因是它很小，而且模型在任务中途改了事项后，下一次请求应该看到新状态。

**记忆开关关闭时**：当前事项的正文照常注入（与现在“工作笔记不属于长期记忆，关闭记忆仍保留”一致）；
索引不注入，因为它带入了其他会话的内容。工具仍可用，用户明确要求时模型可以 `continuity.open`。

**“继续”**：召回规则不变（短输入仍跳过）。索引在易变尾部里，模型看到“继续”时可以直接选一项 `continuity.open`；
只有一个活跃事项时不需要再问用户。系统提示加一句：用户要接着做之前的事、但当前会话没有链接时，先看索引或 `continuity.list`，不要猜。

### 3.7 遗忘与隐私

与现在删除工作笔记的位置相同（`memory-privacy.ts:133`、`:159`）：

- 遗忘计划覆盖的任务：删除该任务所在会话链接的事项，以及链接到该事项的所有会话链接。
  事项正文可能来自被遗忘的内容，宁可多删。
- 遗忘覆盖整个助手：删除该助手的全部事项和链接。
- 回滚表 `conversation_working_notes` 照旧一起删除。

### 3.8 不做

- 自动续跑失败的工具操作。段落档案已经记录 `operations` 的结果和标识，模型据此判断；重试前要按工具核对实际状态，这是幂等性问题，留到以后单独设计。
- 事项进入召回候选池。历史细节仍由段落档案、主题条目和原文检索提供。
- 截止时间、提醒。用 `routine.save`。
- 跨助手共享事项。委派时只发送相关背景，规则不变。
- 界面。以后如果在设置或会话侧栏展示事项，Web 与 Mac/iOS 必须在同一个任务里一起做（见 `AGENTS.md`）。

## 4. 改动清单

| 内容 | 文件 |
|---|---|
| 迁移 36、双写回滚表 | `store.ts`，新建 `continuity-schema-v2.ts`（`continuity-schema.ts` 已是迁移 14 的名字） |
| 事项读写、链接、索引渲染、到期暂停 | 新建 `continuity-items.ts` |
| Core 写笔记改为写事项；`topic` 边界解除链接；`nextAction` | `runtime.ts`（`writeWorkingNote`、`summarize`、两条整理指令）、`episodes.ts`（`parseArchive`） |
| 注入当前事项与索引 | `agents.ts` `context()`、`runtime.ts` 易变尾部提示 |
| 三个工具与别名 | `runtime.ts`、`policy.ts`、`agents.ts`、`broker-tool.ts` |
| 遗忘 | `memory-privacy.ts` |

## 5. 验证

按 [docs/verification/README.md](../verification/README.md)：只用临时目录里的隔离实例和合成模型，不碰线上数据。

### 5.1 单元与集成测试（新建 `server/personal-os/continuity-items.test.ts`）

沿用 `memory-recall.test.ts` 的夹具（`createPersonalApp` + `startFakePersonalMemory` + `startFakeRetrieval`），
在合成模型的请求边界检查实际发出的提示。

- **迁移**：在含 `conversation_working_notes` 的库上运行迁移 36：行数相等，正文与版本一致，14 天边界的状态正确，
  子会话没有被迁移；重复运行没有变化；原表的内容哈希不变。
- **跨会话**：会话 A 写笔记后，会话 B 的请求在索引里看到该事项；B 调 `continuity.open` 后，B 的下一次请求带上 A 的正文；
  B 写入后，A 的下一次请求带上新版本。
- **并发**：A、B 同时以同一版本写入，只有一个成功；整理模型以旧版本写入时被丢弃，模型的写入保留。
- **话题边界**：合成一个 `topic` 边界，档案写入旧事项，会话链接解除；新话题的笔记新建事项；旧事项的状态按 `openItems` 是否为空变为 active 或 paused。`gap` 边界保持链接。
- **预算**：建 8 个活跃事项、标题和下一步都写满，索引 ≤ 300 Token 且最多 5 行；当前事项不在索引里；没有活跃事项时没有这一段。
- **记忆关闭**：当前事项正文仍在，索引不在；`continuity.open` 仍然可用。
- **超限**：`continuity.update` 的正文超过 1000 Token 被拒绝且提示精简；Core 生成的超长笔记被压缩后写入，压缩失败则保留旧正文。
- **生命周期**：14 天未 touched 的事项立即从索引消失，并在该助手下一次写事项时转为 paused；`done` 解除所有链接；Core 从不自动标 done。
- **遗忘**：遗忘一个任务后，它所在会话链接的事项和全部链接被删除；回滚表同时删除；遗忘整个助手后没有残留。
- **回滚双写**：每次写事项后，当前会话的 `conversation_working_notes` 是同一份正文。
- **“继续”**：只有一个活跃事项时，输入“继续”，合成模型收到的请求里有该事项的索引行。

现有测试必须继续通过：`continuity.test.ts`、`memory-recall.test.ts`、`episodes.test.ts`、`compaction-timing.test.ts`、
`memory-native.test.ts`。其中断言 `workingNote` 结构的用例按新的 `item` 结构更新。

### 5.2 端到端

用 `verify-omb` 起隔离实例，通过 `control-omb` 发真实消息：在会话 A 里做一件事直到压缩产生笔记，
新开会话 B 说“继续”，检查 B 的回复接上了 A 的下一步，并保存提供方边界的请求记录作为证据。

### 5.3 上线前后（Tokyo，只读核对）

- 上线前：记录 `conversation_working_notes` 的行数与内容哈希，按 14 天规则预估 active / paused 数量。
- 上线后：事项数等于原表行数（减去子会话），原表哈希不变，`/health` 为 200；
  抽查一个活跃会话，其请求的易变尾部记忆部分不超过 4800 Token。
- 结果写入 `docs/verification/continuity-items.md`，并从 `docs/verification/README.md` 链接。

## 6. 待定

- 14 天自动暂停和 5 条索引上限都是初始值，上线一周后按线上数据调整。
- 迁移生成的事项标题来自会话标题，可能不准确；是否在该事项下一次由 Core 写入时让整理模型顺带给出标题（输出多一个字段，不另外调用模型）。
