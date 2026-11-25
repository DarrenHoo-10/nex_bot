# Agent 会话发布验收（0.9.35）

构建来自已推送的 main 提交 `72d927efe5895b37e7068e7e1903664619445684`。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.35-preview.1)

| 平台 | 版本 | 验证 |
| --- | --- | --- |
| Web / Core | `main-72d927ef-20261115` | 在生产数据副本上演练迁移；候选版本在 Mac Air 隔离 Core 中检查；切换后本地和公网检查 |
| Windows x64 | 0.9.35 | 实际便携 EXE 在隔离用户目录中通过 20 项登录检查；包内 herdr-core 0.1.21 与钩子插件 |
| Android | 0.2.34（234） | Core 65 项、app 29 项测试；签名证书与 0.2.33 相同；包内含 xterm 资源 |
| macOS / iOS | 0.2.28（30） | 客户端 `swift test`；Mac、iOS 各 15 项渲染测试；DMG 版本、签名、执行器、herdr-core 0.1.21 与钩子插件；IPA 版本与未签名状态 |

## 合并

合并 main 时，main 已把迁移 48、49 用于助手重置和删除，并已在生产运行。Agent 模式的迁移因此改为 50（会话表）和 51（请求与监督表），排在 main 之后。合并后的检查：

- 类型检查和 lint 通过。
- 浏览器端到端冒烟 `scripts/smoke-cli-agents.mjs` 19 项全过。
- Core、shared、web 测试 1842 项中有 11 项失败，均与本次改动无关：
  - `server/personal-os/appearance.test.ts`、`server/personal-os/episodes.test.ts`、`server/personal-os/workspaces.test.ts`：在 origin/main（`51782122`）上单独运行同样失败。0.9.34 起，未知或他人的助手 ID 返回 404，这三项测试仍期望 400。
  - `server/personal-os/compaction-timing.test.ts`、`server/personal-os/image-models.test.ts`、`server/personal-os/sender-device.test.ts`：在 Agent 模式之前的提交 `dd76aa68` 上同样失败。
  - `server/personal-os/cli-agents/supervisor.test.ts`、`server/personal-os/memory.test.ts`、`server/personal-os/stock-finance.test.ts`：单独重跑通过，是并行负载下的超时。

## Core 验收

- **迁移演练**：用 SQLite 只读备份复制 6 个工作区数据库，用随机密钥打开副本执行迁移 50、51。业务表（助手、消息、附件、记忆、策略、外部身份）哈希前后一致，副本随后删除。
- **候选检查**：在 Mac Air 的隔离临时 Core 中，只用合成数据，检查了以下各项：
  - 120 条消息分页、健康检查、未登录 401、网页与资源字节一致；
  - Agent 会话接口未登录返回 401、列表为空；
  - 未知设备的新建请求被拒绝；
  - 会话流同源未登录 401，无 Origin 无凭据 403，外站 Origin 403，登录后能收到列表；
  - 设备通道仍只接受设备凭据。
- **切换**：
  - 先确认没有未结束的任务，再停服务，把数据和配置私下备份到 `~/nexbot/backups/main-72d927ef-20261115-pre`，并核对文件哈希。
  - 切换后本地和公网健康检查 200，13 个网页资源与构建字节一致。
  - 6 个工作区的业务表哈希与停机备份一致。
- **公网复核**：在另一台电脑上经公网域名复核，`/health` 200，未登录的 `/api/state` 和 `/api/cli-agents` 返回 401，HTML 与全部 13 个资源（含 2 个 xterm 文件）与本地构建字节一致。会话流 WebSocket 能经 Cloudflare 和首尔中转到达 Core，未登录时被拒绝（401）。

## 安装包校验

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.2.28-ios-unsigned.ipa | 36394780 | 64e784488e44bf51369e12ac38a33a72541fda1c1d88fd094669ba1e0ef9d5de |
| NexBot-0.2.28-mac-arm64.dmg | 108056207 | 888718b7522b7c0b00ea2c988e9d3713defbb0da1ba11d662db2627f3ef1ef63 |
| nexbot-0.2.34-debug.apk | 43994369 | ad82b544ab19ff4a7979211c82f24b6b5f5b99a6d87fd69f51fab32edf124e18 |
| NexBot-0.9.35-x64-Client-Portable.exe | 203648180 | 141550abd7f40e8e5bbe0216bb00407a0b7d98e72929912d25e59ec481976146 |

- 签名：Windows 未签名，Mac 使用临时签名且未经公证，Android 为调试签名。
- 测试设备：iOS 在专用模拟器执行渲染测试，模拟器已删除；未在实体手机上安装。
- Windows 登录检查的隔离方式：新客户端默认开启「Agent 会话」。检查时把用户目录和 `LOCALAPPDATA` 指向临时目录，所以没有读取本机真实的 Claude、Codex 会话。检查结束后，停止了测试客户端留下的 herdr-core 进程，并删除了临时目录。

## 发布渠道和更新验证

- **GitHub**：预览版标签指向构建提交，四个安装包及两个校验文件的大小和摘要均与本地文件一致。
- **OSS 与更新清单**：先私下备份旧的更新清单并完成发布预演，再把四端安装包同步到 OSS，并更新清单。
- **线上更新接口**：逐个平台用上一版本号请求，四端都返回本次版本；用当前版本号请求，均无可用更新。通过接口返回的链接重新下载四个安装包，大小和 SHA-256 均与上表一致。
- **主页**：在浏览器中打开生产主页，四张下载卡的版本、文件、摘要和链接都与下载清单一致，「0.9.35 预览版发布说明」指向本次标签。

## 未验证

- 没有用真实的 Claude Code、Codex 账号验收 Agent 会话。以下几项仍需在独立的 Windows 用户或虚拟机中，用测试账号确认：
  - 钩子审批卡；
  - AskUserQuestion 的回答格式；
  - 带空格的 `--plugin-dir`；
  - Claude 收件箱；
  - 加入 Codex 共享守护进程。
- AGENTS.md 中「Core 部署到东京」一节已过期：生产 Core 自 2026-11-14 起运行在 Mac Air。本次按 0.9.34 在 Mac Air 上的部署方式执行。
