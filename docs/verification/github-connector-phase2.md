# GitHub 连接器第 2 期（监听）验证记录

日期：2026-11-15。分支 `feature/github-connector`。设计见 [docs/design/github-connector.md](../design/github-connector.md)；第 1 期见 [github-connector-phase1.md](github-connector-phase1.md)。

## 交付内容

- **监视配置**（迁移 54：`personal_connector_monitors` + `personal_connector_deliveries`）：仓库列表（≤10 个，显式指定）、CI 模式（default_branch/mine/all/off，默认 mine）、静音仓库、忽略分支模式（glob，`*` 不跨 `/`）、投递方式（notify 直达话题 / task 启动任务）、轮询间隔（60–3600 秒，默认 300）、投递目标助手（单选）、Webhook 密钥（生成一次显示，AES 加密存库）。
- **轮询器**（每 15 秒调度到期监视，单监视防重入）：`/notifications`（If-Modified-Since，304 跳过）→ reason 分类（review_requested/mention/author；ci_activity 取回 subject 判定结论）；PR 列表 diff（`pr_opened`，已见集合存 state）；checks 快照指纹（`sha256(repo|branch|排序失败项)`）——失败投递一次，恢复后解除布防，再失败重新提醒。
- **投递**（幂等账本 `personal_connector_deliveries`，保留 7 天）：notify = `publish` 直发摘要到目标助手话题（0 token）；task = `agents.startRoutine`（source key 幂等，自动走例行任务报告管道）。
- **速率限制**（persona 同款）：记录 core 配额余量（<10% 收缩）、429/带 Retry-After 的 403 按 Retry-After/Reset 暂停，未给时长则 1 分钟翻倍上限 1 小时；暂停期内轮询报"请求过于频繁"并保留游标。
- **Webhook 接收**：`POST /hooks/github/<监视id>`，`X-Hub-Signature-256` HMAC（sha256）timing-safe 校验；映射 pull_request（opened/review_requested/closed）、pull_request_review(submitted)、check_suite(completed 且失败)、issue_comment(提及)；Webhook 与轮询共用同一幂等账本，不重复投递。
- **UI**：Web（ConnectorsPage GitHub 详情的监视区：列表/启停/编辑/删除、添加表单、Webhook 密钥一次性展示）+ Apple（GithubConnectorView 监视区与编辑 sheet、NexClientKit 监视协议与状态解码）。

## 自动验证

| 验证 | 命令/位置 | 结果 |
| --- | --- | --- |
| 监视器测试 | `pnpm vitest run server/personal-os/github-monitor.test.ts` | 7/7 通过 |
| 连接器全量（GitHub 5 + Gmail 19 + MCP 9 + 监视 7） | 同目录四个测试文件 | 40/40 通过 |
| 回归（app/service/feishu/stock-finance） | `pnpm vitest run …` | 67 通过 |
| typecheck | `pnpm typecheck` | 0 错误 |
| NexClientKit（含监视 2 项） | mac-air 隔离临时目录 `swift test` | 254/254 通过 |
| 双端 Xcode 构建 | mac-air `xcodegen` + Mac Release / iOS Debug | 两次 BUILD SUCCEEDED |

测试覆盖：监视校验（仓库格式/连接器类型/投递目标）与 Webhook 密钥仅显示一次；notifications+PR diff+CI 三类事件 notify 投递与跨轮去重；CI 指纹失败→恢复→再失败的布防循环；忽略分支/CI off 跳过；限速暂停与按 Retry-After 恢复（last_error 清空）；task 模式走例行任务管道且 source key 幂等；Webhook HMAC 正确/错误/缺失签名、外仓不投、重复投递去重、事件映射。

## 明确未验证 / 边界

- 全部走隔离 fake-github fixture，未对真实 GitHub 调用；真实 webhook 需要 GitHub 仓库侧配置（URL = Core 公网地址 + `/hooks/github/<id>`，密钥在创建时显示一次）。
- webhook 仅主应用（单工作区）可达；账号工作区（accountWorkspaces）模式下未做按工作区的路由分发。
- `pr_opened` 的"已见集合"随当前开着的 PR 列表收缩——关闭后重开会再次提醒（有意为之）。
- 率限暂停目前按连接器粒度（同一 provider 实例），监视轮询与助手工具调用共享同一暂停状态。
