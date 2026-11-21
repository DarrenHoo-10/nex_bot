# NexAgent 发往跳过权限模式 Claude 会话的消息 · 发布记录 — 2026-11-21

发布 `nexbot-v0.9.40-preview.1`，源码 `main` 的
[`f9cded2a`](https://github.com/DarrenHoo-10/nex_bot/commit/f9cded2a9f857733f627a9d031ec38678be00b89)
（修复提交 `fc083303` 合并 0.9.39 之后的 `main`；pre-push 的 lint、typecheck、locale 检查通过）。
上一版见 [0.9.39 发布记录](nexagent-1121-release-20261121.md)。

| 平台 | 版本 | 本次 |
| --- | --- | --- |
| Core / 网页 | `main-f9cded2a-20261121` | 部署到 Mac Air，无数据迁移 |
| Windows x64 | 0.9.40 | 新发布（电脑端执行器的消息发送修复） |
| Android | 0.2.39 (239) | 新发布（随包网页界面） |
| Mac / iPhone | 0.2.31 (33) | 新发布（Mac 内置的电脑端执行器同样修复；Apple 原生界面无改动） |

## 问题与原因

用户在 NexAgent 里给 Claude 桌面端会话发「现在能部署了吗」，页面显示「已送达，等待回复…」，会话里却没有这条消息。

- 电脑端操作记录：16:07:44、16:10:17 两次 `send` 都写入了会话的 inbox 管道，结果 `delivery: "unconfirmed"`。
- 同一会话收到其他 Claude 会话的消息时，会话记录里立即出现 `queue-operation enqueue`；NexBot 这两次没有任何记录。
- Claude Code 2.1.330 对 inbox 消息按权限类别把关：接收会话处于 `bypassPermissions` 时，只有用
  `<cross-session-message from-mode="bypass">` 声明同一类别的消息才进入队列；未声明的被扣下（hold，
  `cause=no-mode-asserted`），不写入会话记录。目标会话的记录里 `permissionMode` 均为 `bypassPermissions`。
- 页面误报「已送达」：工作台发送路径（`workbench.submit`）丢掉了电脑端返回的 `delivery`。
- 此前 inbox 发送只在假 inbox 上测试过，本机从未有会话收到过 NexBot 远程消息。

## 改动

1. **电脑端**（`server/personal-os/cli-agents-node/inbox.ts`）：发送前读会话记录末尾最近的权限模式
   （plan 沿用进入前的类别）。跳过权限会话用 Claude Code 的信封声明 `from-mode="bypass"`；其他会话照旧不声明
   （默认会话收到未声明的消息会排队，收到 `bypass` 反而扣下）。消息和「停止」都走这条路；正文里的结束标签按
   Claude Code 自己的写法转义（`<\`），信封保持完整。
2. **Core**（`workbench.ts`）：发送结果带回 `delivery` / `waiting`。
3. **页面**（`SessionPane.tsx`）：电脑未确认时进度行显示「已发送，等待会话接收…」，输入框下方「已发送，未确认」。

## 证据

- **真实 Claude Code 2.1.330 的临时无头会话**（独立 `CLAUDE_CONFIG_DIR`、`--messaging-socket-path`、
  `--debug-file`，未登录，不是用户的会话；用后删除）：

  | 接收会话 | 帧 | 结果 |
  | --- | --- | --- |
  | bypassPermissions | 旧格式（无声明） | held，`no-mode-asserted` |
  | bypassPermissions | `from-mode="bypass"` | Routed user message to queue |
  | default | 旧格式 | Routed user message to queue |
  | default | `from-mode="prompting"` | Routed |
  | default | `from-mode="bypass"` | held，`mode-mismatch` |
  | bypassPermissions | `from-mode="prompting"` | held，`mode-mismatch` |

  修改后的 `sendToInbox` 对 bypass 会话与默认会话：消息（正文含 `</cross-session-message>`）和「停止」
  （priority now）全部进入队列。
- **自动化**：`cli-agents-node`、`cli-agents`、`src/personal/cli-agents` 49 个文件 870 项通过；新增测试
  （权限类别读取、信封与转义、bypass/默认会话的帧、Core 带回 `unconfirmed`、页面不再误报）在旧代码上失败。
  前端与服务端 `tsc` 通过。按用户要求未跑全量 vitest（合并树上的全量运行在一小时后中止）。
- **Core**：候选版本在 Mac 上隔离 Core（合成数据）通过；部署时无进行中任务，备份
  `~/nexbot/backups/main-f9cded2a-20261121-pre`，6 个工作区业务哈希一致；本机与公网 13 个资源逐字节一致；
  从本机独立复核 `/health` 200、未鉴权 401、经中继的流 401。
- **Windows**：`NexBot-0.9.40-x64-Client-Portable.exe`（203,719,605 B，SHA-256 `74fbae81…778776`，
  ProductVersion 0.9.40），执行器 `client-node.js` 含修复；在临时用户目录通过登录冒烟（20 项），冒烟留下的
  herdr-core 已结束（用户自己运行中的 0.9.37 客户端未动）。
- **Android**：`nexbot-0.2.39-debug.apk`（44,058,265 B，`6e03a598…8f6057`，versionCode 239），单元测试 94 项
  0 失败，与 0.2.38 同一调试证书（`af012179…cb4b`）。
- **Mac / iPhone**：从推送提交全新克隆构建，专用模拟器用后删除；`NexBot-0.2.31-mac-arm64.dmg`
  （108,678,226 B，`a223ad5d…b43aa6`，0.2.31 (33)，`codesign --verify --deep --strict` 通过，内置执行器含修复）、
  `NexBot-0.2.31-ios-unsigned.ipa`（36,615,423 B，`c839bd42…f9fc9a5`，0.2.31 (33)）；`NexClientKit` 255 项、
  Mac 与 iOS 界面测试各 15 项通过。
- **发布**：GitHub 6 个资产大小与摘要和本地一致；OSS 上传回读校验；旧清单私存于
  `~/nexbot/backups/main-f9cded2a-20261121-pre/client-manifest.json`。`/api/client/update` 对 0.9.39、0.2.38、
  0.2.30 提供新版，对新版本不再提供，下载字节与清单的大小和 SHA-256 一致。
- **主页与 README**：线上主页四张下载卡版本、链接、大小、SHA-256 与发布文件一致，标签
  `nexbot-v0.9.40-preview.1`；README 同步。

## 限制

- 临时会话未登录，只核对到 Claude Code 接受消息进入队列，未看到模型对信封内消息的实际回复；模型看到的是
  「来自另一会话」的信封，正文的说明写明是用户本人的话。
- 权限模式取自会话记录：在电脑上刚切换模式、还没在会话里发过消息时，读到的是旧模式，消息可能仍被扣下
  （页面显示「已发送，未确认」）。
- 修复前被扣下的两条消息仍停在那个会话里，不会自动送达，需要重发。
- 修复只在电脑端客户端升级后生效（Windows 0.9.40、Mac 0.2.31）；均未在实体手机上安装测试。
