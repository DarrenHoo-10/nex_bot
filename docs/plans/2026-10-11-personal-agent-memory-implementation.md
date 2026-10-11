# Personal Agent / Hindsight 首批实现记录

日期：2026-10-11。分支：`codex/feature-personal-ai-os-design`。

本轮落实统一 Agent、自动 A2A、执行方审批与真实 Hindsight 接入基础。它不是 M4 完整记忆发行版；本机已安装的 0.3.3 没有被修改。

## 已实现行为

- 全新工作空间没有默认 Agent；显式创建与归档最后一个实例之后都不会补建。既有实例、消息、ID 与记忆保留。
- 任意名字的 Agent 使用相同 Pi / Broker 流程。名字与可空补充职责决定身份表达，不生成职业类型或权限。公开专长为可选实例数据；公开目录包含当前资料、有效工具能力、可用状态与版本。
- 每次实际模型请求刷新自己与同伴的资料。更名、补充职责、专长和权限变化不会发送身份通知或引发额外模型调用。
- `agent.delegate` 自动执行；双方消息流沿用 compact A2A 标记与接收方折叠回复。父子 ID、深度、循环检查、恢复、取消与根任务调用预算继续生效。
- 基础工具策略显式授予记忆与联系同伴能力。设备工具由用户单独配置；设备侧 LocalGrant 是第二层约束。目录中不宣传已撤销设备的能力。
- 已授权只读操作和普通私有记忆写入自动执行；任意终端命令与私有文档清理需要实际执行 Agent 的一次批准。发起方只显示等待与跳转，不代替接收方批准。
- 旧 pending safe Approval 在启动恢复中正式取消并重新检查同一 ToolCall。旧拒绝/取消不复活；危险操作保留原审批约束。

## Core 与记忆引擎

`MemoryModule` 管理明确记忆原文，`MemoryLedger` 管理来源与投递，`HindsightClient` 隔离固定 v0.10.3 HTTP DTO。Pi 不持有 provider bank ID 或服务凭据。

每个 Agent 显式创建时，在同一 SQLite 事务中生成私有 bank binding。共享 bank 在第一个共享来源出现时生成。逻辑 binding ID 不因改名变化；物理 bank 在纠正/删除后的安全重建中可以替换。

消息、A2A 已提交的请求/结果与当前显式文档版本，和 source registry / transfer 在同一事务中登记。既有明确文档导入当前有效版本；不会自动导入整个旧消息历史或扫描设备文件。明显凭据不进入引擎投递队列。

来源记录定位原业务 ID 与版本、正文哈希、来源类别、根来源、时间与 Task。用户陈述、同伴转述和 Agent 推断分别标记。Core 不建立模型生成的事实、实体、向量或知识页数据库。

新增 SQLite migration 3 包含 `bot_public_profiles`、bank bindings、显式文档版本快照、source registry、transfers、receipts、provider document mappings、retired banks 与 memory model invocations，采用 STRICT / FK / CHECK / 幂等约束。完整设计中的 publication、forget rules、知识页和持久缓存表尚未落地，不能据此把整个设计 DDL 宣称为已实现。

公开目录的 `directory_version` 首版使用资料、策略和设备授权的 SHA-256 指纹；它是 opaque revision，不是整数序号。资料版本沿用 Bot version，能力版本沿用 BotPolicy version。

## 投递、纠正与检索

来源先提交，随后由 Core 串行协调 Hindsight 的真实持久作业。每次首次交付前保存 client-supplied operation UUID，提交 native async retain；接收成功不算完成，只有 native operation `completed` 才提交一个 Core receipt。

固定 v0.10.3 的不存在作业响应是 HTTP 200 / `status=not_found`，适配器同时处理这一形式与 HTTP 404。丢失 ACK 时先按原 UUID 核对；已存在的作业不会重复提交。无法核对的历史 unknown 保留为待处理，不重新生成一个 UUID 盲目抽取。

显式文档纠正/删除先撤回旧来源、推进 visibility generation、隔离该 bank 的派生读取并切换物理 bank。旧 bank 的作业取消/清理单独跟踪，新 bank 从当前有效来源重建。迟到的 recall 和模型结果在 generation / physical ID 检查处丢弃。新 bank 完成所有有效来源及旧 bank retirement 确认后才开放。

Agent 的每个实际回答请求与 `memory.search` 检索自身私有 bank + 共享 bank。语义结果只接受能映射到当前有效来源的 world / experience facts，携带 scope、sourceClass 和原文 reference；observation、reflect 和知识页暂未开放。异步边界后重新检查策略与可见性。没有服务时仍保留消息、显式记忆和待投递来源，返回明确的 raw-text fallback 状态。

当前文档删除是来源撤回与引擎可见性清理。它不等于主题级彻底遗忘，也不承诺自动识别所有历史消息、A2A 转述、Pi 上下文或备份副本。完整 forget/publication 用例仍按主方案实现及验收。

## 主设备服务与预算

`ManagedMemoryService` 使用独立 loopback model gateway、私有 stdin 启动配置与专属 profile / pg0 namespace 管理真实 Python Hindsight + PostgreSQL。paid provider Key 只在 Core vault 中解密；daemon 只得到内部 service tokens 和本地数据库凭据。退出关闭自己启动的进程树，不操作用户现有 Hindsight / coding-agent 服务。

daemon 固定 `hindsight-api-slim==0.10.3`，替换该版本的 OpenAI provider transport：每次实际 SDK HTTP 尝试从 `ConfiguredLLMProvider` 的 native trace context 取得 bank、operation 和 purpose。测试证明延后的 retain 作业也携带归属；没有依赖入口 HTTP header 自动传入后台。

网关只接受注册 bank 的归属请求并强制配置中的模型与 endpoint。兼容配置的 OpenAI 与 Anthropic；内部归属字段不转发给上游。每次实际尝试单独记账，失败/unknown 保留预留额；日限制为每 bank 30 次 / 100,000 预留 tokens、工作空间 100 次 / 300,000，后台并发 1，运行中的前台 Task 优先。byte upper bound + 输出上限用于保守 token 预留，不展示虚构费用。

首版关闭 auto consolidation、reflect、页面更新与未归属的初始化模型调用。失败 transfer 保留来源与状态，不声称已入长期记忆；自动跨日恢复失败作业及按错误分类的运维入口仍待补齐。

## 构建资源状态

构建复制 native service 脚本。生产入口只从受管理的 `memory-runtime/runtime.json` 发现私有 runtime，不隐式下载，不复用系统 Hindsight 配置。manifest 约定：

```json
{
  "release": "0.10.3",
  "python": "python/python.exe",
  "models": {
    "embeddings": "models/embeddings",
    "reranker": "models/reranker",
    "sha256": {"models/embeddings/example-file": "SHA256"}
  }
}
```

实际 manifest 必须覆盖两个模型目录的完整文件集；路径限定在资源目录内，启动逐文件校验 SHA-256，模型只使用本地文件并禁止 remote code。上例仅解释结构，不是可发行资源清单。

当前 checkout **尚未提供通过中文质量门槛的生产 runtime/model 资源包**，因此普通桌面运行明确显示“语义记忆服务尚未安装”，继续使用原文检索并保留 outbox。native fixture 显式使用 UV 缓存中的固定引擎与合成 embedding/reranker；这一开关不是用户界面或 Device Node 的配置项。

## 本轮证据

- 构建产物 Core / worker 工作流、memory 与 Pi 套件：49 项通过（22 Core、7 memory、20 Pi）。Memory 测试含真实 0.3.3 隔离 fixture 的升级迁移，验证既有 Agent、记忆 ID/版本和 vault 密文保持不变。
- 构建产物 genuine native Hindsight fixture：1 项通过。真实 Windows pg0/PostgreSQL、引擎迁移、服务鉴权、异步 retain、真实 SDK HTTP transport attribution、预算记账、完成回执及正常退出。模型是 loopback fake，ML 模型是明确 fixture；不是中文质量验收。
- 独立 native spike 证明真实引擎两个 bank 的文档隔离与文档删除，使用 provider none / synthetic embedding，不代表完整派生遗忘。
- development Electron 的真实 renderer smoke 通过：零默认 Agent、显式创建、optional identity、静默资料刷新、自动 A2A、折叠回复、后台例行任务、tray restore 与 graceful Quit。
- Frontend/server TypeScript 与本轮产品代码 lint 通过。

所有检查均为合成内容和隔离 profile，无用户实际模型调用、无已安装应用数据修改、无 GitHub 上传。截图保存在被忽略的本地 release 目录。

## 后续发布门槛

固定生产 Python/依赖/中文模型 revision 与 hash，完成 100 条中文标注查询质量验收、原生引擎崩溃/重启与资源包测试、明确共享 publication / 撤回及完整 forget 的副本处理，再开放受预算约束的综合记忆与知识页。最后生成并验证新的 Setup / Portable，才升级本机安装。
