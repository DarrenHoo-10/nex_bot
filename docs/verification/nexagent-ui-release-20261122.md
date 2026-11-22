# NexAgent 新建会话页、侧栏与上下文用量 · 发布记录 — 2026-11-22

发布 `nexbot-v0.9.42-preview.1`，源码 `main` 的
[`3cb740a6`](https://github.com/DarrenHoo-10/nex_bot/commit/3cb740a683199ad7cf589d086f6cf69bc74d5189)
（直接接在 0.9.41 记录提交 `ba826fb9` 之后；lint、两套 `tsc`、多语言检查通过，pre-push 同样通过）。
上一版见 [0.9.41 发布记录](nexagent-launch-release-20261122.md)。

| 平台 | 版本 | 本次 |
| --- | --- | --- |
| Core / 网页 | `main-3cb740a6-20261122` | 部署到 Mac Air，无数据迁移 |
| Windows x64 | 0.9.42 | 新发布（电脑端列目录、建目录、上下文用量；界面） |
| Android | 0.2.41 (241) | 新发布（随包网页界面） |
| Mac / iPhone | 0.2.33 (35) | 新发布（Mac 内置电脑端同上；原生界面未改） |

## 改动

- **新建会话**：不再弹窗，右侧是会话同款 `Composer`（新增 `starter` 模式：+ 图片/文件/目标模式、技能、模型菜单），
  上方一排目录（`DirectoryPicker`）、运行工具（`HarnessPicker`，未安装的灰显）、工作树。目录可上一级/下一级、
  路径导航、搜索、输入路径或新文件夹名；不存在的目录标「新建」，启动时由电脑创建。附件在会话列出后上传并随首条消息发出。
- **电脑端**：新操作 `dirs`（`cli-agents-node/dirs.ts`：子文件夹、Git 标记、不列 `.git`，根目录列盘符与主目录），
  `start` 的 `createDir`（建目录及父目录，与分叉、工作树互斥）；能力字段 `dirs`。上下文用量（`context-usage.ts`）：
  Claude 取最后一次主线程回复的 `usage`（输入、缓存读写、输出之和），窗口按 settings 的 `autoCompactWindow`、
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`[1m]` 默认模型推断，否则 20 万（已超 20 万的按 100 万）；Codex 取最后一个
  `token_count` 的 `last_token_usage.total_tokens` 与 `model_context_window`。会话行新增 `context`。
- **Core**：`GET /api/cli-agents/dirs`；`/start` 接受 `createDir`（非布尔或与工作树同用返回 400，旧执行器提示升级）；
  `context` 只存内存并在变化时推送，不改数据库。
- **网页**：启动中的会话按正常对话布局；处理中改为对话里的三点气泡（参照 NexBot），署名只在每轮第一条回复；
  侧栏顶部「新建会话」（去掉品牌旁的 +），置顶「进行中」可收起并记住，图标状态点，单台电脑不显示电脑行，项目为小标题；
  排队消息为卡片，引导/编辑/撤销为图标并有悬停说明；输入框上下文圆环（70% 琥珀、90% 红）。

## 证据

- **开发期测试**（发版前未再跑，按 `AGENTS.md`）：`src/personal`、`shared`、`cli-agents`、`cli-agents-node` 1442 项通过；
  新增列目录/建目录、上下文读取（含经电脑端完整会话列表的用例：修复前因 `toWire` 漏字段而失败）、Core 接口、
  新建页（上下级、建目录、工作树、附件随首条消息上传、电脑离线）、进行中收起、上下文圆环。
- **浏览器**（隔离环境：假身份、替身 Claude、真实 herdr-core）：从侧栏「新建会话」进入，浏览替身电脑真实文件夹，
  输入新目录 `delta` 后电脑上建出该目录、会话启动、首条消息收到回复；进行中置顶与收起；排队卡片与悬停说明；
  向演示会话记录写入真实格式的用量后圆环显示 78%（77.6 万 / 100 万）。
- **Core**：候选版本在 Mac 隔离 Core（合成数据）通过（目录接口 401、相对路径 400、未知电脑 409、createDir 校验）；
  部署时无进行中任务，备份 `~/nexbot/backups/main-3cb740a6-20261122-pre`，6 个工作区业务哈希一致；本机与公网 13 个资源逐字节一致；
  从本机复核 `/health` 200、未鉴权 401（含 `/api/cli-agents/dirs`）、经中继的流 401。
- **Windows**：`NexBot-0.9.42-x64-Client-Portable.exe`（203,732,273 B，`6064b3cb…62adc`，ProductVersion 0.9.42），
  执行器含列目录与上下文读取，界面含新页面；临时用户目录登录冒烟通过，冒烟留下的 herdr-core 已结束。
- **Android**：`nexbot-0.2.41-debug.apk`（44,069,093 B，`659ff058…762d78`，versionCode 241），同一调试证书（`af012179…cb4b`）。
- **Mac / iPhone**：从推送提交全新克隆构建，专用模拟器用后删除；`NexBot-0.2.33-mac-arm64.dmg`（108,812,103 B，
  `5958a43d…ea70e74`，0.2.33 (35)，`codesign --verify --deep --strict` 通过，内置执行器含列目录与上下文读取）、
  `NexBot-0.2.33-ios-unsigned.ipa`（36,690,459 B，`a8863c97…a515d1`，0.2.33 (35)）。
- **发布**：GitHub 6 个资产大小与摘要和本地一致；OSS 回读校验；旧清单私存于
  `~/nexbot/backups/main-3cb740a6-20261122-pre/client-manifest.json`。`/api/client/update` 对 0.9.41、0.2.40、0.2.32
  提供新版，对新版本不再提供，下载与清单的大小和 SHA-256 一致。
- **主页与 README**：线上主页四张下载卡的版本、链接、大小、SHA-256 与发布文件一致，标签 `nexbot-v0.9.42-preview.1`；README 同步。

## 限制

- Mac / iPhone 原生界面本次未改：新建会话页、侧栏、排队卡片、上下文圆环待后续版本。
- Claude 的上下文窗口是推断值，可能与终端显示不同；Codex 的窗口为其自身记录。
- 未在真实的 Claude / Codex 会话上验收目录浏览、建目录与上下文用量；替身 Claude 不写用量，圆环在写入的演示记录上验证。
- 新功能需电脑端升级（Windows 0.9.42、Mac 0.2.33）；均未在实体手机上安装测试。
