# Personal Agent / Hindsight 0.4.0 实现记录

日期：2026-10-11。分支：`codex/feature-personal-ai-os-design`。

本轮完成生产中文记忆资源、带引用的综合记忆与主题遗忘。最终安装包和本机升级的实际结果见[验收记录](../verification/personal-os.md)。没有上传用户资料或推送 GitHub。

## Agent 与主设备

全新空间没有默认 Agent。任意名字的实例复用固定 Pi SDK、工具 Broker、公开目录与私有 bank；补充身份可空。每次模型请求刷新当前名字、职责、专长与有效工具权限，编辑不会触发通知或额外模型调用。更名不改变 ID、bank、权限或历史。

Agent 只直接读取自己的私有 bank 与 workspace 共享 bank。需要其他知识时，通过实时目录向同伴求助，同伴检索自己的记忆并回复。A2A 自动进行；危险操作只在实际执行方的联系人消息流申请批准。设备授权受 Core BotPolicy 与 Node LocalGrant 双重约束。

既有安装保留现存 Agent、消息、文档 ID / 版本与 vault；真实 0.3.3 隔离 fixture 已验证迁移，不按新初始化规则删除旧数据。

安装包内置 Python 3.12.10、Hindsight 0.10.3、原生 pg0 / PostgreSQL 依赖与两个 CPU 中文模型。用户无需安装 Python、Docker 或维护数据库，只需配置已有模型服务的 endpoint、模型与 API Key。其他设备经 Core 获取服务，不能直接连接引擎。

Hindsight 和数据库只监听 loopback。内部鉴权信息由私有 stdin 传入，不交给 renderer、Pi 或 Node；paid Key 只保存在 Core 加密 vault，通过本地网关代理。生产 Python 拒绝资源目录外的 `sys.path`，模型只读本地文件、禁止远程代码和隐式下载。启动校验完整模型文件集与 SHA-256，发行保留全部资源 inventory，避免 UV overlay 错把开发机缓存当内置依赖。

| 资源 | 固定版本 / revision |
|---|---|
| Python Windows embeddable | 3.12.10 |
| Hindsight | 0.10.3 |
| Python 依赖 | `scripts/memory-runtime-requirements.txt` 中 213 项精确版本 |
| Embeddings | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` / `e8f8c211226b894fcb81acc59f3b34ba3efd5f42` |
| Reranker | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` / `1427fd652930e4ba29e8149678df786c240d8825` |

`prepare-memory-runtime.py` 仅用于构建，用户启动不下载依赖或模型。模型卡、Python 与依赖许可证随包分发。资源及测试结果保存在被忽略的 `dist-personal/`、`release/`，不复制实际 profile。

引擎意外退出后最多恢复三次，采用 5 / 10 / 20 秒退避。应用退出只停止自己拥有的服务及数据库。服务不可用时保留业务原文和来源 outbox，报告降级，不将失败抽取伪装成已完成。

## 来源、检索与综合

Core SQLite 保存用户消息、A2A、明确文档与来源账本；Hindsight PostgreSQL 保存事实、实体、向量和观察。migration 3、4 实际落地 bank、版本、source、transfer、receipt、来源依赖、publication、forget rules、tombstone 和综合缓存，Core 不复制一套向量 / 实体引擎。

首次交付前持久化 operation UUID；native async retain 完成后才记录回执。ACK 丢失核对同一个 UUID，避免重复抽取。纠正 / 撤回先隔离 bank，再替换物理 bank，以当前有效来源重建；旧 bank retirement 完成后才开放新 bank。

自动 retain 使用配置模型抽取，auto consolidation 产生 native observations。recall 返回 world / experience 及具备完整来源链的 observation；缺失 / 截断 provenance 时不返回观察。结果区分用户陈述、同伴转述、Agent 推断和综合观察，可展开所有有效原文来源。

`memory.reflect` 分别综合自身私有与共享 bank，只返回具备有效原文证据的回答。完成时再次核对整次读取的 bank generation、物理 ID、Bot、策略和 Task。在等待第二个 bank 时，第一个 bank 被撤回也会使整次结果失效。综合缓存绑定 scoped generations，随纠正、撤回、遗忘失效。

Agent 上下文自动注入 scoped recall 与明确记忆。记录实际呈现的来源、最近消息 / 工作记录和 A2A 父任务依赖，为遗忘追踪因果副本。公开目录来自当前资料，不从旧记忆猜测联系人身份。

共享 publication 是 owner 显式意图，绑定原文来源及哈希、记录副本来源边。普通 Agent 私有写入不能偷偷发布到 workspace；用户也可直接创建共享文档。

## 预算与审批

真实 SDK 每次 HTTP 尝试从 native trace 取得 bank、operation、purpose；retain / consolidate / reflect 都记账。网关强制配置的模型和 endpoint，不转发内部身份标记，支持 OpenAI 兼容及 Anthropic，包括 reflect 的工具调用 / 返回。

后台并发 1，前台优先。每日后台维护每 bank 上限 30 次 / 100,000 预留 tokens，workspace 上限 100 次 / 300,000，仅统计 task_id IS NULL 的请求。失败 / unknown 保留预留额，缺少 usage 不等于免费。按照后续 [用户任务控制决定](2026-10-11-manual-task-control.md)，Agent reflect、Pi 与 A2A 子任务均无累计任务额度，仍逐次记账；停止任务会中止对应的前台记忆模型请求。后台忙或维护额度耗尽时延后 native 作业，不影响用户任务的累计用量。

安全检索、普通私有写入与 A2A 自动执行。已知只读终端观察自动执行；脚本、未知或危险命令、文档撤回及 Agent 发起的彻底遗忘需执行方批准。遗忘批准冻结预览 revision / 数量，范围变化必须重新预览。

## 撤回与彻底遗忘

撤回停止将文档用于长期检索，保留业务历史。彻底遗忘是独立操作：输入主题、预览范围、确认执行。主题匹配采用规范化原文 / 标题子串；预览是实际清理清单，不声称自动理解所有别名或转述。

清理范围包含当前文档 / 全部版本 / 搜索项 / 消息；消耗来源的 Task、下游历史依赖、A2A 链、显式共享副本与已登记整理副本；Task 原文 / 结果、输入、transcript、journal、工具参数 / 结果、A2A payload / result、相关审计正文及综合缓存。混合多个来源的回答整条清理，无关来源保留。

受影响的 Pi 投影与内存 worker 清空，未完成工作、审批和输出投递停止。引擎取消并等待自己拥有的 bank 执行者，再删除原 bank 的事实、实体、观察等派生数据，以剩余有效来源重建。原文先清理，bank 未清理 / 重建未完成时状态为 `cleaning`，旧派生结果不可读取，不能显示“遗忘完成”。旧 bank ID 持久退役，迟到写入返回 410，重启不能复活。

加密 `forget-journal.json` 在 SQLite 修改前原子写入，只保留 ID、哈希和计划。恢复较旧 Core DB 到同一 profile 后，启动先重放日志，再开放历史与来源导入。tombstone 阻止相同正文后台重捕获。

边界：这不是 SSD 物理擦除，不删除用户文件、模型服务日志或未知外部备份。整体覆盖 profile（包括遗忘日志）的旧备份无法保留后来的遗忘决定。未登记依赖又不含匹配词的人工改写无法自动证明被清理，用户应检查预览并补充主题。三类长期知识页编辑 / 持续更新接口仍属后续功能，综合缓存不冒充该接口。

## 验收证据

- 真实引擎 / PostgreSQL / 随包 CPU 模型：100 条独立标注中文查询，Recall@10 = 0.96，原文 LIKE 基线 = 0。这是合成语料检索验证，不代表所有真实任务或 paid-provider 抽取质量。
- 构建 Core、worker、memory、Pi：55 项通过，覆盖 A2A、执行方审批、0.3.3 迁移、完整引用、两 bank 并发撤回、遗忘因果副本 / Pi 上下文、旧 Core DB 恢复。
- 生产资源 native fixture 通过：真实 deferred retain 归属、鉴权、正向检索、隔离、native reflect 引用、派生清理、迟到 410、自动重启和持久退役。
- Frontend / server TypeScript、产品代码 lint、65 项既有 DDL contract checks 通过。

最终 EXE 与本机升级的实测追加到[Windows 验收记录](../verification/personal-os.md)，以已测试文件的 SHA-256 为准。
