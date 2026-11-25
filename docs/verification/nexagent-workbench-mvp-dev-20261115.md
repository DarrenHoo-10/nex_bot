# NexAgent 会话工作台 MVP · 开发阶段验证记录

2026-11-15。分支 `codex/nexagent-project-ui-review` 的未提交工作树（按交接要求暂不提交）。
基线是[交接](../plans/2026-11-15-nexagent-workbench-handoff.md)与 [MVP 实施方案](../plans/2026-11-15-nexagent-workbench-mvp.md)；
本记录覆盖 P1–P7 的既定开发工作与可自动化验证。**P0（三家真实产品双端往返实测）与 P8（双端发布候选验收）未执行**，
原因与复测条件见文末。所有运行均为隔离夹具，未触碰用户正在使用的窗口或数据。

## 已交付的工作包

| 包 | 交付物 |
| --- | --- |
| P1 协议与存储 | `shared/cli-agents.ts`：`zcode` 引擎、`host` 写入通道、`steer`/`git` 设备 op、`turn_changed`/`conflict` 错误码、`queue`/`workbench` 推送消息与解析器。`server/personal-os/cli-agents/schema.ts` 迁移 55（合并时改号，main 的 53/54 已被连接器重建占用）：重建 `cli_agent_sessions`（去掉固定 engine CHECK，行数校验后提交），新增 `cli_agent_workbench`（逻辑会话树）、`cli_agent_outbox`（排队正文加密存储）、`cli_agent_queue_state`（暂停原因与序号）、`cli_agent_send_requests`（requestId 幂等）。 |
| P2–P4 适配器 | `cli-agents-node/harness.ts` 编译期注册层（claude/codex/zcode，逐会话能力：发送/引导/中断/终端/fork）。`cli-agents-node/zcode.ts` ZCode 适配器：从本机 `~/.zcode/cli/db.sqlite` 只读发现（`session`/`message`/`part`/`session_runtime_presence`），live pid→running，转录分页；`sendVia: "host"` 仅在设备提供 `ZcodeHostChannel` 时声明。bridge/discovery/launch 全部接线（第四个 Harness 只需注册 ID + 适配器 + 图标 + 契约用例）。 |
| P5 消息调度 | `cli-agents/workbench.ts`：发送/排队/引导/编辑重发四种动作、原子认领、按轮次 END 串行消费、停止暂停队列、继续队列、不确定结果只对账不重发、双击幂等、requestId 冲突、编辑/撤回版本检查。hub 新增 `opTracked`（opId 随失败返回）、queue/workbench 推送与设备上线监听。routes 扩展 `POST /send`（delivery/clientMessageId/requestId/revisesMessageId）、`/interrupt`（requestId→停止）、`/queue/{edit,withdraw,steer,resume}`、`/sessions/{branch,rename,archive,restore,delete}`、`GET /queue`、`GET /sessions/git`；`/start` 支持 worktree。设备端新增 `steer`/`git` op 与 `device-git.ts`（设备本地执行 Git，参数数组、无 shell、requestId 去重建树）。 |
| P6 对话输入 | `api.ts` 工作台契约封装；`use-queue.ts` 流式队列；Composer 真实队列展示（原位编辑/撤回/立即引导）、暂停横幅、运行中的排队/引导选择、停止按钮；SessionPane 发送携带幂等对、编辑重发载入原文与取消恢复草稿；TranscriptView 用户消息"编辑并重发"。 |
| P7 工作台正式数据 | 逻辑会话树（`use-workbench.ts` + `workbench` 推送）；SessionList 在无评审夹具时走 Core 数据（显示名/父子树/归档视图/fork/改名/归档/恢复/删除）；SessionInfoCard 无夹具时走 `GET /sessions/git`；NewSessionDialog 真实工作树开关（`/start` 携带 worktreeBranch+requestId）。 |

## 自动化证据

全部在隔离临时目录/内存库上运行，通过命令（branch 检出根目录执行）：

```powershell
corepack pnpm exec vitest run shared server/personal-os/cli-agents server/personal-os/cli-agents-node src/personal/cli-agents
corepack pnpm exec tsc -b && corepack pnpm exec tsc -p tsconfig.server.json --noEmit
```

- **结果：69 个测试文件、1107 项测试全部通过**（6 skipped 为既有跳过项）。首次全量运行曾出现 6 项并发端口抖动失败（`fetch failed: bad port`），单独重跑与第二次全量均全绿。
- 新增专项：
  - `server/personal-os/cli-agents/workbench.test.ts`（10 项）：运行轮次后按序排队投递、send 冲突返回 busy、停止暂停队列且迟到 END 不放行、引导命中运行轮次/超时返回 turn_changed、双击幂等与 requestId 冲突、双端并发改队首（先到者赢、后到者 409）、撤回终态、丢回执→uncertain→迟到回执对账→不重发、分支树（fork 深度上限、同名 requestId 幂等、改名版本冲突、归档/恢复/删除后子项上移、原生会话不动）、worktree 启动并绑定分支行。
  - `server/personal-os/cli-agents/schema.test.ts`（3 项）：迁移 55（合并时改号，main 的 53/54 已被连接器重建占用） 对旧形状库逐行拷贝、ZCode 行可写、state CHECK 与 items 外键级联保留、outbox 唯一约束。
  - `server/personal-os/cli-agents-node/zcode.test.ts`（11 项）：发现（live/idle/archived/deleted、host 路由）、死 pid、无库、转录分页（隐藏消息/工具部件跳过、before 边界）、marker、host 通道契约、harness 注册表（三家逐会话能力矩阵）。
  - `server/personal-os/cli-agents-node/device-git.test.ts`（4 项）：真实临时仓库的状态快照（分支/头/更改文件/增删行）、非 Git 目录 none、worktree 建/重试复用/已存在分支 detach 附着、非法分支名拒绝。
  - `src/personal/cli-agents/use-queue.test.ts`（6 项）：队列展示/撤回/原位编辑/暂停横幅/待确认条目无操作/运行中才可引导；编辑重发载入原文、以当前发送方式重发、取消恢复草稿。
- 夹具回归：`node scripts/smoke-cli-agents.mjs --workbench --serve=18819` 启动成功（隔离 Core + 真实 herdr-core 设备进程 + 构建产物），评审入口可进；正式入口（不带 `workspace=nexagent-review`）经无头浏览器核对：会话树/设备/项目/Harness 图标来自 Core 数据、发送经工作台契约送达并出现在转录、Git 卡片走 `/api/cli-agents/sessions/git`（非 Git 目录正确显示"当前目录没有 Git 信息"）、"编辑并重发"入口出现、新建会话对话框显示真实工作树开关。夹具已停止、临时目录已删除、端口已释放。

## 明确未做（缺口与复测条件）

| 项 | 现状 | 复测条件 |
| --- | --- | --- |
| P0 三家 × App/CLI 原生通道实测矩阵 | 未执行：需要 Windows 隔离账号上的真实 Codex/Claude Code/ZCode 产品与人工操作原生窗口，无法在本开发会话中如实产生 | 按交接第 1–3 步在隔离账号执行，逐格记录版本/证据/限制 |
| ZCode 写入通道（host） | 适配器与契约就绪；`ZcodeHostChannel` 默认不提供，ZCode 会话按只读呈现（sendVia 缺省） | 需在真实 ZCode Host 上验证 V4 命令通道后注入实现；P0 第 4 步 |
| Codex App/CLI、Claude inbox 的真实双端往返（N1–N5 真品矩阵） | 现有 bridge-outside/inbox/codex-daemon 隔离测试（74 项）与交接时一致，未新增真品证据 | 同 P0 |
| P8 双端发布候选验收 | 未执行：需要隔离 Core 部署与实际 Windows 客户端打包 | 依赖 P0 矩阵先出结论 |
| 引导的设备级 expectedTurnId | Core 在派发前校验运行状态；设备侧按轮次拒绝引导待 P0 确认各家能力后接入 | 依赖 P0 |
| 设备端 Git 工作树的真实三端运行 | `device-git.ts` 用真实 Git 在临时仓库验证 | 真机 smoke 在 P8 一并覆盖 |

## 回放命令

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm exec vitest run shared server/personal-os/cli-agents server/personal-os/cli-agents-node src/personal/cli-agents
node scripts/smoke-cli-agents.mjs --workbench --serve=18809
```
