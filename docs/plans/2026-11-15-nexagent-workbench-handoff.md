# NexAgent 工作台 MVP 开发交接

分支 `codex/nexagent-project-ui-review`。从本分支继续，先读 [MVP 实施方案](2026-11-15-nexagent-workbench-mvp.md)，界面细节以[交互定稿](../design/nexagent-workbench-v1.md)为准。

| 已提交 | 内容 |
| --- | --- |
| `5a5d035e` | 定稿工作台、交互夹具与回归用例 |
| `a9fb3f24` | 技术方案、原型截图及重现步骤 |
| `dcc3a404` | 明确接续原生 App / CLI 已有会话的验收条件 |
| `bc676516` | Web、Windows 和三个 Harness 的实施范围、工作包及验收矩阵 |

## 从 P0 开始

1. 在隔离的 Windows 测试账号和临时仓库里，从 Codex 原生窗口发一条含随机标记的消息 A。记下产品版本、启动入口与脱敏的原生会话 ID。
2. 在 NexAgent Web 找到同一会话，发一条需要用到 A 才能回答的问题 B。核对原窗口收到 B、两个窗口都看到回复 C，再打开 Windows 工作台并重连。会话 ID 应保持一致，B 只出现一次。
3. 分别从原生 App 和独立 CLI 重做。对 Claude Code、ZCode 记录同样的结果。尽早探测 ZCode 已运行 Host 的授权通道和三家的外部会话中断能力。把各入口的可读、可写、定向引导、定向停止分开记录。缺少能力的格子标明版本、阻塞点和复测条件。
4. 将实测矩阵存到 `docs/verification/`，按[验证约定](../verification/README.md)留证。可并行推进 P1 的协议与数据库迁移。随后依实施方案接适配器、队列和双端 UI。

## 已定的产品语义

- MVP 交付 Web 和 Windows，只接 Codex、Claude Code、ZCode。适配器按**当前会话**声明能力，Core 统一管理队列、修订关系和回执。
- 运行中默认排队。排队项可原位编辑、撤回或转为引导。引导须命中正在运行的目标轮次。
- 已发消息可编辑并重新发送，生成一条关联原文的新消息，原文和已有回复保留。
- 停止只作用于当前会话的当前轮次，同时暂停队列。用户可在原会话继续输入，或手动继续队列。
- 原型的侧聊、fork、Git 卡片和终端交互已经定稿。外部 App 的会话写接口和托管 PTY 的键盘输入需分别验证。

## 动手前留意

当前 [共享协议](../../shared/cli-agents.ts) 和 [SQLite 表约束](../../server/personal-os/cli-agents/schema.ts) 仅接受 Codex、Claude；增加 ZCode 要同步处理旧库迁移和旧客户端解码。现有 [bridge](../../server/personal-os/cli-agents-node/bridge.ts) 的中断操作依赖托管终端地址，外部会话需要单独验证控制路由。夹具可以重现交互，三家真实产品的双端往返、引导和停止仍待实测。

本次交接时，此工作树另有既存的 `apps/apple/Packages/NexMarkdown/Sources/NexMarkdown/Resources/html-preview.html` 工作区修改，提交时请按路径暂存本任务文件。
