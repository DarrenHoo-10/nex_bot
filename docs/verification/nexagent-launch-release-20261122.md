# NexAgent 模型清单与即时新建会话 · 发布记录 — 2026-11-22

发布 `nexbot-v0.9.41-preview.1`，源码 `main` 的
[`b71302d5`](https://github.com/DarrenHoo-10/nex_bot/commit/b71302d5df19a93e422c4a78a52c5f4fce1d9b2c)
（功能提交 `c1a0cd46` 合并 `98ae9504` 之后的 `main`；合并树上 lint、两套 `tsc`、多语言检查通过，pre-push 同样通过）。
上一版见 [0.9.40 发布记录](nexagent-inbox-release-20261121.md)。

| 平台 | 版本 | 本次 |
| --- | --- | --- |
| Core / 网页 | `main-b71302d5-20261122` | 部署到 Mac Air，无数据迁移 |
| Windows x64 | 0.9.41 | 新发布（电脑端读取模型清单、并行准备启动） |
| Android | 0.2.40 (240) | 新发布（随包网页界面） |
| Mac / iPhone | 0.2.32 (34) | 新发布（新建会话：首条消息、默认分支、模型清单、即时显示） |

## 问题与原因

1. **模型选择不参考 NexBot**：1121 版加入模型选择时用了原生下拉框和写死的模型列表（fable/opus/sonnet/haiku、
   五个 gpt），不读电脑上 CLI 的配置，所以和终端里 `/model` 能选的不一致。
2. **新建会话慢、卡在对话框**：对话框等 `start` 返回才关闭。`start` 串行执行：启动终端组件、找 CLI、准备
   hooks、建工作树（本仓库 3872 个文件，`git worktree add` 实测约 5.7 秒）、启动 CLI 后再等会话出现
   （Claude 最多 5 秒；Claude Code 在第一条消息前不写会话记录，本机 11-21 由 NexBot 启动的一个会话始终没有
   记录文件；Codex 最多等 20 秒认领）。

## 改动

- **电脑端**（`cli-agents-node/models.ts`，新能力 `models`）：读 Claude Code 2.1.330 的 `/model` 行——内置别名
  （`ANTHROPIC_DEFAULT_<ALIAS>_MODEL[_NAME|_DESCRIPTION]`）、`ANTHROPIC_CUSTOM_MODEL_OPTION`、managed 或用户
  settings 的 `modelPicker.options`（`replaceBuiltInOptions` 隐藏内置行），按 `availableModels` 过滤，推理强度取自
  `CLAUDE_CODE_MODEL_CAPABILITIES`；Codex 读 `models_cache.json`（去掉隐藏行，按 priority）与 `config.toml` 的默认值。
  字段语义取自 Claude Code 2.1.330 可执行文件里的设置说明。`start` 并行准备终端、CLI、hooks 与工作树。
- **Core**：`GET /api/cli-agents/models?deviceId=&engine=`；旧执行器返回「电脑端版本过旧」。模型名允许 `/`。
- **网页**：`CliModelMenu` 与 NexBot 的 `ModelMenu` 同一套样式和弹层定位（抽出 `useAnchoredPopover`）。新建会话
  对话框加「第一条消息」和模型菜单；提交即关闭，`use-launches.ts` 在后台启动并发送首条消息（未列出时每 0.5 秒
  重试，最多 15 秒），列表与右侧先显示占位会话（问题 + 「处理中…」），真实会话列出后接替；失败可重试，沿用同一
  `requestId`。工作树分支默认 `nexagent/` 加 6 位随机字符。
- **Mac / iPhone**：`CliLaunches.swift` 与新建会话表单同样实现；输入框里的模型菜单 Apple 端仍未提供（此前也没有）。

## 证据

- **开发期测试**（发版前未再跑，按 `AGENTS.md`）：`src/personal`、`shared`、`cli-agents`、`cli-agents-node`
  共 99 个文件 1453 项通过，含新增的模型读取（7 项）、Core 接口、对话框即时关闭、默认分支、失败重试；Mac 上
  `NexClientKit` 261 项通过（新增 6 项），Mac 与 iOS 模拟器目标编译通过。
- **浏览器**（隔离环境：假身份、替身 Claude、真实 herdr-core 0.1.21；设备 settings 写入两条 `modelPicker` 网关模型）：
  模型菜单列出默认（标出设备当前模型）、四个内置别名（Opus 显示映射的模型）与两条网关模型；选 GLM-5.3 后推理强度
  只剩「默认/低/中/高」；点「开始会话」61 毫秒后对话框关闭并显示问题与「处理中…」；首条消息送达并收到替身回复，
  输入框保留所选模型。工作树开关自动填入 `nexagent/0sj2qg`；隔离设备没有 git，显示「找不到 git」及「重试 / 关闭」。
  `scripts/smoke-cli-agents.mjs` 完整运行从会话列表一步起失败（其 DOM 断言早于 NexAgent 改版，失败与本次无关），
  页面无未捕获错误。
- **Core**：候选版本在 Mac 上隔离 Core（合成数据）通过，含模型接口 401、未知 engine 400、未知电脑 409、带 `/` 的
  模型名不被当作非法参数；部署时无进行中任务，备份 `~/nexbot/backups/main-b71302d5-20261122-pre`，6 个工作区业务
  哈希一致；本机与公网 13 个资源逐字节一致；从本机独立复核 `/health` 200、未鉴权 401（含 `/api/cli-agents/models`）、
  经中继的流 401。
- **Windows**：`NexBot-0.9.41-x64-Client-Portable.exe`（203,725,860 B，SHA-256 `78bd06b9…cc09d18`，ProductVersion
  0.9.41），执行器含模型读取，界面含新对话框；在临时用户目录通过登录冒烟（20 项），冒烟留下的 herdr-core 已结束
  （用户运行中的 0.9.40 客户端未动）。
- **Android**：`nexbot-0.2.40-debug.apk`（44,062,873 B，`837bb88c…647d97e`，versionCode 240），与上一版同一调试
  证书（`af012179…cb4b`），随包界面含新对话框。
- **Mac / iPhone**：Mac 上从推送提交全新克隆构建，专用模拟器用后删除；`NexBot-0.2.32-mac-arm64.dmg`
  （108,840,471 B，`b2860903…4a772fa`，0.2.32 (34)，`codesign --verify --deep --strict` 通过，内置执行器含模型读取）、
  `NexBot-0.2.32-ios-unsigned.ipa`（36,690,459 B，`c891afdb…08e1ddd9`，0.2.32 (34)），两个二进制都含
  `CliLaunch` 符号。
- **发布**：GitHub 6 个资产大小与摘要和本地一致；OSS 4 个安装包上传回读校验；旧清单私存于
  `~/nexbot/backups/main-b71302d5-20261122-pre/client-manifest.json`。`/api/client/update` 对 0.9.40、0.2.39、0.2.31
  提供新版，对新版本不再提供，下载字节与清单的大小和 SHA-256 一致。
- **主页与 README**：线上主页四张下载卡版本、链接、大小、SHA-256 与发布文件一致，标签 `nexbot-v0.9.41-preview.1`；
  README 同步。

## 限制

- 未在真实的 Claude / Codex 会话上验收模型清单与带 `/` 的网关模型启动；用户本机 settings 只做过只读核对。
- 真实电脑上的端到端启动耗时未测（工作树检出约 5.7 秒仍在，只是不再挡住界面）。
- GitHub 的 HTTPS 在本机不通、代理 12012 未运行，源码经 SSH 推送；发布与资产查询经 `api.github.com` 直连。
- 新功能需电脑端升级（Windows 0.9.41、Mac 0.2.32）；均未在实体手机上安装测试。
