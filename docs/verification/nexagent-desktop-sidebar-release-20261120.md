# NexAgent 会话目录跟随 Claude 桌面端侧边栏 · 发布记录 — 2026-11-20

发布 `nexbot-v0.9.37-preview.1`，源码 `main` 的
[`f445a21e`](https://github.com/DarrenHoo-10/nex_bot/commit/f445a21e7874585b8e320cc21db19c8daee82f07)
（分支 `codex/nexagent-project-ui-review` 快进合并；pre-push 的 lint、typecheck、
locale 检查通过）。上一版见 [0.9.36 发布记录](nexagent-workbench-release-20261119.md)。

| 平台 | 版本 | 本次 |
| --- | --- | --- |
| Core / 网页 | `main-f445a21e-20261120` | 部署到 Mac Air，无数据迁移 |
| Windows x64 | 0.9.37 | 新发布（电脑端执行器） |
| Android | 0.2.36 (236) | 新发布（随包网页界面） |
| Mac / iPhone | 0.2.28 (30) | 未重发，沿用 0.9.35 发布 |

## 起因与参照

用户指出同一个 Claude 桌面端会话在 NexAgent 里显示成 3 行。桌面端为每个会话保留一份索引
（`%LOCALAPPDATA%\Claude-3p\claude-code-sessions\<账号>\<组织>\local_<uuid>.json`）：
`cliSessionId` 是当前转录，`priorCliSessionIds` 是续接、回退前的转录。本机该会话的记录为
`48ccb4cb`（3 条消息，未复制进后续）→ `5e958483`（928 条，其中 925 条被回退复制进当前段）
→ `f696727c`（当前）。实现参照 [nwverse/persona](https://github.com/nwverse/persona)
`docs/integrations/claude-integration.md` 的 “The desktop app's sidebar” 与
`server/internal/node/claudedesktop.go`。

## 改动

- **一会话一行**：早期转录在当前转录已列出且不更新时隐藏，否则保留（最坏两次，绝不消失）。
- **归档与删除**：归档会话及其早期转录隐藏（运行中除外）；`deleted_<uuid>` 标记立即隐藏；
  桌面端转录无索引条目指向且超过 2 分钟才判为已删除；读不了的条目提到的 id 保留；
  索引无可读条目时不判定。
- **不受窗口限制**：未归档的侧边栏会话（最新 100 个）不受 14 天窗口限制；转录没有标题或目录时用条目的。
- **父子关系只信记录**：`spawnedFrom.sessionId`（`btw` 为侧聊，经新字段 `sideOf` 放进父会话侧边页签、
  不进左树；其余为子会话 `forkOf`），否则 `forkedFromSessionId`；`lineageDetached` 视为顶层。
  移除按前 3 条消息 uuid 推断分叉。与 persona 的差异：persona 把分叉也折进父会话对话，
  这里分叉和任务会话仍按定稿挂在左树父会话下，与桌面端侧边栏一致。
- **自动化会话**：只排除 `claude -p` 一次性运行（`sdk-cli` 首尾一致），保留 `sdk-ts`/`sdk-py`；
  运行中的 SDK 会话不作为运行中列出。
- **仓库根**：读 `.git`（目录、worktree 的 `gitdir` + `commondir`、子模块），不启动 git；主目录及以上不算项目。
- **停止**：桌面端或终端中运行的 Claude 会话，经其 inbox 以 `priority: "now"` 发送停止语
  （persona 的 `interruptOutside`）；空闲会话拒绝且不发送。

## 证据

- **自动化**：cli-agents 全量 75 个测试文件 1233 项，其中 `server/personal-os/cli-agents/hub.test.ts` 3 项为并行端口抖动，
  单独连跑两次 29/29 通过。新增覆盖：索引解析（早期转录、归档、btw/userFork/forkedFrom、
  lineageDetached、删除标记、残缺条目）、隐藏规则及“绝不消失”的保留条件、删除宽限、侧边栏标题、
  一次性 SDK 过滤、`.git` 布局（主仓库、worktree、子模块、`\\?\`、主目录、缓存时效）、
  inbox 停止（priority now、空闲拒绝）、UI 侧聊页签与左树排除、停止按钮。
- **本机真实数据只读演练**（打包后的 discovery，读 `~/.claude` 与桌面端索引，不写任何文件）：
  本对话 3 段合为一行「nex_agent开发」；`.persona\assistant` 自动化会话不再出现；
  Claude 会话 45 行，37 行解析到仓库根（`nex_bot`、`nex_stock`、`TokenDance`、`nex_mail` 各一个项目），
  9 个子会话；扫描 870 ms（此前 git 方式冷启动约 1.2 s）。
- **Core**：候选版本在临时 Core（合成数据）通过；部署时无进行中任务，备份
  `~/nexbot/backups/main-f445a21e-20261120-pre`，6 个工作区业务哈希一致；本机与公网 13 个资源逐字节一致；
  从本机独立复核 `/health` 200、未鉴权 401、经中继的流 401；schema 仍为 56。
- **Windows**：`NexBot-0.9.37-x64-Client-Portable.exe`（203,708,930 B，SHA-256 `c04be978…656e8e`，
  ProductVersion 0.9.37）隔离登录冒烟通过，残留 herdr-core 已结束。
- **Android**：`nexbot-0.2.36-debug.apk`（44,050,165 B，SHA-256 `81e02afc…459890`，versionCode 236），
  单元测试 94 项 0 失败，与已发布版本同一调试证书（`af012179…cb4b`）。
- **发布**：GitHub 资产大小与摘要一致；OSS 上传回读校验；旧清单私存；`/api/client/update`
  对 0.9.36、0.2.35 提供新版，对新版本不再提供，下载字节与清单一致；Mac/iPhone 仍为 0.2.28。
- **主页与 README**：线上主页四张下载卡版本、链接、大小、SHA-256 与发布文件一致，发布说明链接指向
  `nexbot-v0.9.37-preview.1`；README 同步。

## 限制

- 停止经 inbox 只在隔离测试里验证，尚未在真实桌面端会话上验收；macOS 上 persona 会让桌面端经
  `claude://` 打开未运行的会话再发送，此处未做（Windows 上 persona 同样按已停止处理）。
- 未读状态（`lastFocusedAt`/`lastTurnEdgeAt`）与定时任务归组未做。
- Mac / iPhone 原生客户端未适配新工作台；均未在实体手机上安装测试。
