# NexAgent 会话工作台 · Core 部署记录 — 2026-11-16

生产 Core/UI release `main-f43ca09d-20261116`，commit
[`f43ca09d`](https://github.com/DarrenHoo-10/nex_bot/commit/f43ca09d56578f872d8e5229f929d45148394c8f)
（工作台 MVP 分支 `codex/nexagent-project-ui-review` 在合并当时 origin/main 并解冲突、
迁移改号 55 后快进合并到 `main` 推送；pre-push 钩子 lint/typecheck/locale 全过）。

开发与缺口：[dev record](nexagent-workbench-mvp-dev-20261115.md)。
部署模板沿用 [GitHub 连接器部署记录](github-connector-deploy-20261115.md)。

## 合并与构建证据

- 合并时发现 main 已占用迁移 53/54（连接器重建），工作台迁移改号为 **55**；三处冲突
  （store.ts 迁移块、index.ts 返回对象、verification README 索引）逐一解决，合并树
  tsc（client+server）全绿、cli-agents 全量 **1107 项测试通过**。
- pre-push oxlint 拦下分支原型遗留的 3 条告警（两处刻意的控制字符正则显式豁免、
  一处集合直迭代），修复后全仓 0 告警。
- 构建于 `f43ca09d`（`node scripts/build-personal.mjs --core`）。

## 部署证据（Mac Core，bot.nexorai.com.cn）

- Staged `/Users/darrenhoo/nexbot/releases/main-f43ca09d-20261116`：复制当前运行的
  `main-169e5021-20261115`，**替换** `core/`、`ui/`、`package.json`、`SOURCE_COMMIT`。
  首次 tar 叠压混入上一版旧哈希资源（82≠59 个文件，出现旧 `personal-DaoVG7iQ.js`），
  改为删除 `core/`、`ui/` 后重解，规范化路径/空格后 **59 个文件 SHA-256 与本地构建
  逐字节一致（MANIFEST-MATCH）**。
- **迁移演练（真实生产数据副本）**：`~/nexbot/rehearsal-20261116/` 内用 sqlite3 backup
  API 取 core.db（迁移 54，**89 行会话 = 69 claude + 20 codex，54 行缓存**）、runtime.db、
  vault-key.bin、backend.json 与全部 5 个账号工作区库（各 v54）。丢弃 Core（staged 构建、
  端口 18999）启动后：core 与 5 个工作区全部到 **v55**，会话行/缓存行数与引擎分布逐项
  一致，`cli_agent_workbench`/`outbox`/`queue_state`/`send_requests` 均为空表就位；
  `/health` 200、`/personal.html` 200、未鉴权 `/api/cli-agents` 与 `/items` 均 401，
  日志 `{"type":"ready","initialized":true}`。
  （第一次演练抓到两个非迁移问题：PUBLIC_ORIGIN 校验要求 HTTPS——改用生产同值；
  pkill 按命令行匹配杀不掉首跑进程导致 EADDRINUSE 二次崩溃——按端口清理后干净通过。）
- 活跃任务检查：生产 running tasks 0。
- 备份 `/Users/darrenhoo/nexbot/backups/main-f43ca09d-20261116-pre/`：core.db/runtime.db
  （sqlite3 backup API）、vault-key.bin、core.env、core.plist、runtime-env.json、旧 run-core.py。
- 基线计数（切换前后一致）：users 1 / bots 8 / conversations 54 / agent_messages 247 /
  personal_connectors 4。切换后 schema max **55**，`cli_agent_sessions` 89（69/20 不变）、
  items 54 不变，四张新表已建且为空（尚未有工作台写入）。
- `run-core.py` 指向新版本后 `launchctl kickstart -k` 重启 `cn.nexorai.nexbot-core`；
  进程运行 `releases/main-f43ca09d-20261116/core/service.js`。
- 公网验证（https://bot.nexorai.com.cn）：`/health` 200；未鉴权 `POST /api/agents/input` 401、
  `GET /api/cli-agents` 401；`/personal.html`、`personal-CgJTdrHb.js`、
  `CliAgentsWorkspace-Aqo4SMIl.css` 与本地构建 SHA-256 逐字节一致。
- 演练目录与 overlay 包已清理；回滚 = 恢复备份中的 run-core.py（指回
  `main-169e5021-20261115`）并 kickstart，v55 迁移只增不删、旧版本代码对新增表无感知。

## Limits

- **只部署 Core/UI**。设备执行器（Windows 客户端内置 bridge）未升级：旧执行器按现有
  协议工作（只报 claude/codex），工作台队列/引导/编辑重发对旧设备会话全部可用（Core 侧
  契约），ZCode 会话要到执行器升级后才会出现在列表。新 UI 经 Core 下发到浏览器与
  Windows 客户端的"从 Core 加载"路径；Android/安装包内嵌 UI 与客户端版本号本次未动，
  未发布任何安装包 → README 与官网下载页无需变化（沿用上次 Core-only 部署的边界）。
- **P0 真品矩阵与 P8 双端验收仍未执行**（见 dev record 的复测条件）；引导的设备级
  expectedTurnId 校验、ZCode host 写通道（当前适配器缺省只读）依赖 P0 结论。
- 工作台逻辑会话行是惰性创建：第一次在界面上使用某会话（发送/改名等）才会落
  `cli_agent_workbench` 行，当前生产四张新表为空属预期。
