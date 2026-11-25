# NexAgent 工作台修正与补齐 · 发布记录 — 2026-11-19

发布 `nexbot-v0.9.36-preview.1`，源码 `main` 的
[`f5403d93`](https://github.com/DarrenHoo-10/nex_bot/commit/f5403d93f04ed51b35e4b09080eafbe4e2025bd1)
（分支 `codex/nexagent-project-ui-review` 快进合并；pre-push 的 lint、typecheck、
locale 检查通过）。问题排查与方案见
[上线后排查](../plans/2026-11-18-nexagent-workbench-ui-audit.md)。上一版 Core 部署见
[2026-11-16 记录](nexagent-workbench-deploy-20261116.md)。

| 平台 | 版本 | 本次 |
| --- | --- | --- |
| Core / 网页 | `main-f5403d93-20261119` | 部署到 Mac Air |
| Windows x64 | 0.9.36 | 新发布（含电脑端执行器） |
| Android | 0.2.35 (235) | 新发布（随包网页界面） |
| Mac / iPhone | 0.2.28 (30) | 未重发，沿用 0.9.35 发布；原生端未适配新工作台 |

## 改动

- 第一批（`41749d9a`）：会话行左对齐；改名、归档、删除在会话没有工作台行时按原生 key 生效；
  「隐藏」并入「归档」；输入框按设计稿（文件、目标、上下文、模型、排队/引导、停止）；
  发送后显示状态；旧执行器的 Git 卡回「版本过旧」。
- 第二、三批（`f5403d93`）：设备上报 `repoRoot`、`forkOf`，排除 `sdk-*` 自动化会话与
  Claude 桌面端已归档会话；`start` 支持 `forkFrom`（Claude `--resume --fork-session`、
  Codex `codex fork`），能力 `forkEngines`；会话树按仓库归并、按分叉嵌套、7 天前折叠；
  侧聊正式可用；迁移 56 新增 `cli_agent_notes` 持久化注释；英文回复优先显示中文；
  标题栏使用 Core 保存的名称。

## 证据

- **自动化**：cli-agents 相关 75 个测试文件 1219 项通过（之后补 1 项标题栏用例）。
  personal-os 更大范围有 7 项失败，在已部署的 `61203ab7` 上以同样方式失败
  （appearance、compaction-timing、episodes、image-models、sender-device、workspaces），
  与本次无关；另 2 项并发运行时的端口抖动单独重跑通过。
- **隔离夹具**（`smoke-cli-agents.mjs --workbench`，真实 herdr-core、替身 CLI，无头浏览器走正式入口）：
  同层会话图标对齐；无工作台行的会话归档后进入「已归档」并可恢复；运行中出现排队/引导与停止，
  无原生下拉框；发送后 250 ms 内显示「已送达，等待回复…」；选区注释写入 Core 并在刷新后高亮；
  侧聊首发建 `kind=side` 行并绑定会话，左树不变；分叉建 `kind=fork` 行挂在原会话下。
  夹具设备的 PATH 不含 git，Git 卡只验证了降级显示。
- **真实数据只读核对**（子代理在本机）：91 → 74 行（隐藏 17 个 Claude 桌面端已归档会话），
  52 个 Claude 会话中 46 个得到 `repoRoot`，`nex_stock`、`nex_bot` 各归为一个项目；
  共享 987/991 条消息的一对会话得到 `forkOf`。
- **Core**：迁移 56 在全部 6 个工作区库的 SQLite `.backup` 副本上演练，55→56，业务表哈希不变，
  副本已删除；候选版本在临时 Core（合成数据）通过检查（含注释与按 key 归档路由、迁移 56）；
  部署时无进行中任务，备份 `~/nexbot/backups/main-f5403d93-20261119-pre`（数据与配置哈希一致），
  6 个工作区业务哈希切换前后一致；本机与公网 13 个资源逐字节一致；从本机独立复核
  `/health` 200、`/api/state`、`/api/cli-agents`、经中继的流 401；线上库 schema 56，
  `cli_agent_sessions` 92 行不变。
- **Windows**：从 `f5403d93` 的干净工作树构建 `NexBot-0.9.36-x64-Client-Portable.exe`
  （203,707,006 B，SHA-256 `f105485a…dddc75`，ProductVersion 0.9.36）；
  隔离的临时 home/LOCALAPPDATA 登录冒烟 20 项通过，残留 herdr-core 已结束。
- **Android**：`:core:test :app:testDebugUnitTest :app:assembleDebug` 通过（单元测试 94 项 0 失败）；
  `nexbot-0.2.35-debug.apk`（44,050,021 B，SHA-256 `a3dab72f…8338af`，versionCode 235）
  与已发布 0.2.34 同一调试证书（`af012179…cb4b`）。
- **发布**：GitHub 预发布资产大小与 SHA-256 摘要和本地一致；OSS 镜像上传并回读校验；
  旧清单私存于备份目录；`/api/client/update` 对 Windows 0.9.35、Android 0.2.34 提供新版，
  对新版本不再提供，下载字节与清单大小、SHA-256 一致；Mac/iPhone 仍提供 0.2.28。
- **主页与 README**：线上主页四张下载卡的版本、链接、大小、SHA-256 与发布文件一致，发布说明链接指向
  `nexbot-v0.9.36-preview.1`；README 同步 Windows 0.9.36、Android 0.2.35、Mac/iOS 0.2.28。

## 限制

- 未用真实 Claude Code、Codex 账号验收原生分叉与接续（`--fork-session`、`codex fork` 只在参数与认领层面测试），
  P0 原生通道矩阵仍未执行；侧聊首发的 `/start` 无幂等键，回执丢失时重试可能多建一个会话。
- Codex 只能从 rollout 的 `forked_from_id` 识别分叉；Claude 多级链式分叉按最早成员挂载。
- Mac / iPhone 原生客户端未适配新工作台；均未在实体手机安装测试。
- 清理夹具时误删了另一会话于 11-15 启动、仍在运行的 18807 评审夹具临时目录中的未占用文件
  （仅合成数据），该夹具需用原命令重启。
