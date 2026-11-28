# NexAgent 多 Agent 协作（第 1 期）· 0.9.65 四端与生产 Core 发布记录（2026-11-28）

构建来源提交：已推送到 `main` 的 `74c8f3089203de5f7ba7e5d77bded9bbc8925e8e`（四端安装包与生产 Core / Web UI 均构建自该同一提交）。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.65-preview.1) · [官网下载](https://bot.nexorai.com.cn/#platforms)

## 安装包清单

| 平台 | 版本 | 文件名 | 大小（字节） | SHA-256 |
| --- | --- | --- | ---: | --- |
| Windows x64 | `0.9.65` | `NexBot-0.9.65-x64-Client-Setup.exe` | 149,295,569 | `9f31212b9573d2f9d86694aed9525d579ea1725d8700eb033d6d5d9309fa9e27` |
| Android 8.0+ | `0.2.63 (263)` | `nexbot-0.2.63-debug.apk` | 44,224,525 | `021022d0da44912a43bae73eaf7304f695d605694c178d9d0005dc8c374374d5` |
| Mac（Apple 芯片） | `0.2.58 (60)` | `NexBot-0.2.58-mac-arm64.dmg` | 112,903,186 | `cc226013bc12fe3fef2d5df5d72012e8f9b5699717aad047806f4fa4121fbaf4` |
| iPhone（iOS 17+，未签名） | `0.2.58 (60)` | `NexBot-0.2.58-ios-unsigned.ipa` | 38,328,824 | `d9925472b256d9440cbc3b0633f3020e504791aee4c242b4247ee0bd9d660ddb` |

## 发布范围（自 0.9.64 / 0.2.62 / 0.2.57 以来）

- `fce5d132`、`ec51620e`：实现 NexAgent 多 Agent 协作第 1 期并合入 `main`：
  - **Core（Schema 迁移 62）**：重建 `cli_agent_workbench` 支持 `kind='worker'`，新增 `cli_team_runs`、`cli_team_workers`、`cli_team_tasks`、`cli_team_dispatches`、`cli_team_mail`、`cli_team_settings` 持久化表；实现多工人并行调度、`--after` 多级任务依赖与失败传递、Worktree 隔离、边界确认卡、断线重连恢复、`start_op_id` 迟到回包对账及不确定投递状态保护。
  - **电脑端执行器（Windows / Mac）**：随客户端内置 `nex` CLI、`nex-mcp`（Codex 单次启动隔离挂载）与 Claude Code `nex` 技能插件；询问模式下对纯 `nex` 命令安全自动放行并校验 `--file`/`--findings` 仅限会话目录内；终端回退投递统一替换为单行 `nex inbox` 提示；AGY 超过 32 KiB 正文自动回落到指针投递。
  - **Web / Windows / Android 协同界面**：主会话下折叠展示协作工人会话与状态、主/工人顶部快切条、暂停/恢复协作与单工人停止，以及「设置 → NexAgent 协作」配置页（Apple 原生 SwiftUI 协作视图待第 2 期补齐；Mac `0.2.58` 已内置更新后的协作执行器）。
- `74c8f308`：四端版本同步升至 Windows `0.9.65`、Android `0.2.63 (263)`、Mac / iPhone `0.2.58 (60)`；修复 `hub.ts` 对 `cli_agent_ops` 迟到 `send` 回包的对账处理、`device-git.ts` 对 Windows Git `already checked out at` 报错的识别，以及相关测试回归断言。

## 构建与校验证据

1. **静态检查与 CI（`74c8f308`）**：
   - 本地通过 `pnpm i18n:check`（10 种语言 3686 条目有效）、`pnpm typecheck`、`pnpm lint`（0 warning / 0 error）、`pnpm check:electron`（83 个模块）。
   - GitHub Actions `CI`（run `46142707284`）：`typecheck + lint`（1m50s）与 `core tests`（13m53s，覆盖 Core、Web UI、Shared 全部核心链路测试）均 100% 通过；`Docker image`（run `46142707379`）通过。
   - 本地补充运行 `src/personal` 与 `shared` 65 个测试文件 845 项测试、`cli-agents` 与存储层回归测试、Android `:core:test` 及 `capture-android-fixtures.mjs --check`（7 份契约固件无漂移），均通过。
2. **生产 Core 与 Web UI 部署（`mac-air`，Schema 61 → 62 迁移演练与切换）**：
   - 基于 `74c8f308` 构建 `core`/`ui` 覆盖包并暂存至 `~/nexbot/releases/main-74c8f308-20261128`。
   - **迁移 61 → 62 实盘备份演练**：在 `verify-candidate.mjs` 中对全部 6 个生产工作区数据库（`data/core.db` 及 `data/account-workspaces/*/core.db`）的只读 SQLite `.backup` 副本逐一以编译后的候选 Core 跑完 `61 → 62` 迁移（禁用全部外部连接器），全部 6 个工作区 `integrity_check=ok`、`foreign_key_check=0`、`schema_migrations=62`、新增 6 张 `cli_team_*` 表与 `cli_agent_workbench` `'worker'` 约束齐备，且 `cli_agent_workbench`（含 101 行主工作区）与 8 张业务表迁移前后内容 SHA-256 哈希 100% 一致。
   - 隔离候选 Core 验证 `/health` 200、未鉴权 `/api/state`/`/api/cli-agents`/`/api/cli-agents/teams`/`/api/cli-agents/team-settings` 均返回 401、鉴权后协作接口与配置读写正常、WebSocket 鉴权正常、全部 16 项静态资源与协作前端代码逐字节匹配。
   - 确认无活跃任务后由脱离进程 `deploy-core.py` 备份 `config`/`data`/`run-core.py` 至 `~/nexbot/backups/main-74c8f308-20261128-pre` 并校验备份文件哈希，切换重启完成（退出码 `0`）；6 个工作区切换前后业务与工作台表哈希一致，本机与公网 `https://bot.nexorai.com.cn` 全部 16 项静态资源逐字节匹配。
3. **Windows `0.9.65`**：本机 `pnpm package:client:win` 构建 `NexBot-0.9.65-x64-Client-Setup.exe`，确认内置 `resources/client-executor/cli-agents-plugin/skills/nex/SKILL.md`；对 `win-unpacked/NexBot Client.exe` 运行 `node scripts/smoke-shell-login.mjs --exe=...`，全部 20 项冒烟用例通过。
4. **Android `0.2.63 (263)`**：本机 JDK 17（`azul-17.0.9`）+ Android SDK 36 执行 `./gradlew --no-daemon :app:assembleDebug`；`aapt2 dump badging` 核验 `com.nexorai.nexbot.debug` `0.2.63 (263)`；`apksigner verify --print-certs` 验证通过，调试证书 SHA-256 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b` 与 `0.2.62` 一致；确认 APK 内 `assets/workspace/assets/` 已包含协作设置与实时同步代码。
5. **Mac / iPhone `0.2.58 (60)`**：在 `mac-air` 全新临时目录克隆 `74c8f308`，执行 `corepack pnpm install --frozen-lockfile`、`node scripts/build-nexbot-icons.mjs`、`NexClientKit` `swift test`，创建独立模拟器（`NexBot-Release-0258` / `iPhone 16 Pro / iOS 18.6`）执行 `RENDER_TESTS=false bash apps/apple/scripts/release-preview.sh`。挂盘校验 DMG（`com.nexbot.mac`、`0.2.58 (60)`、`codesign --verify --deep --strict`、可执行 `Executor/node` 与 `Executor/client-executor/cli-agents-plugin/skills/nex/SKILL.md`）；解压校验 IPA（`com.nexbot.ios`、`0.2.58 (60)`、无 `_CodeSignature`）。构建结束后已复核确认临时目录与独立模拟器均已删除。
6. **GitHub 预发布、OSS 镜像、在线更新与主页核验**：
   - 创建并核对 GitHub 预发布 `nexbot-v0.9.65-preview.1` 全部 6 个附件的大小与 SHA-256 摘要，与本地产物一致。
   - 备份原 OSS 清单至 `~/nexbot/backups/main-74c8f308-20261128-pre/client-manifest.json`，经 `publish-client-update.mjs --dry-run` 核对后上传全部 4 个安装包并读回校验 SHA-256，更新共享清单（保留历史 `windows` 便携版 `0.9.51` 条目）。
   - 校验公网 `https://bot.nexorai.com.cn/api/client/update`：旧版本（Windows `0.9.64` NSIS、Android `0.2.62`、Mac `0.2.57`、iOS `0.2.57`）均正确下发新版，当前版本均返回 `available: false`；实际完整下载全部 4 个下发安装包，字节数与 SHA-256 均与上表完全一致。
   - 校验公网 `/api/client/downloads`、主页 [HomePage.tsx](../../src/personal/HomePage.tsx)（动态消费 `/api/client/downloads`）与 [README.md](../../README.md) 四端版本与下载链接全部一致。

## 验证限制

- 未在真实物理 Android 手机、iPhone 或全新 Windows 机器上做人工安装与 GUI 交互点检。
- Apple 构建使用 `RENDER_TESTS=false` 跳过 UI 渲染截图测试；Apple 原生 SwiftUI 协作界面将在第 2 期补齐（当前 Mac `0.2.58` 仅随内置执行器支持作为协作执行节点）。
- GitHub Actions `Kotlin tests + Android fixtures` 任务因 CI 侧 Robolectric 从 Maven Central 下载依赖发生网络 I/O 错误失败；本地已完成 `:core:test`、`:app:assembleDebug` 与 `capture-android-fixtures.mjs --check` 校验。
- Windows 安装包尚无商业代码签名，Mac DMG 为临时签名未公证，Android APK 使用调试签名。
