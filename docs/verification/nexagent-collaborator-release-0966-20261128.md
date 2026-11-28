# NexAgent 协作简报化、失败项隐藏与主控规划闭环 · 0.9.66 四端与生产 Core 发布记录（2026-11-28）

构建来源提交：已推送到 `main` 的 `e9070a791e9d47186c4194de4cbbc1bc05ab3db9`（四端安装包与生产 Core / Web UI 均构建自该同一提交）。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.66-preview.1) · [官网下载](https://bot.nexorai.com.cn/#platforms)

## 安装包清单

| 平台 | 版本 | 文件名 | 大小（字节） | SHA-256 |
| --- | --- | --- | ---: | --- |
| Windows x64 | `0.9.66` | `NexBot-0.9.66-x64-Client-Setup.exe` | 149,301,043 | `b886a7c643a9b7d586dfff10b9374c14dcb1a67a0d01706c0079f10d0d6ecedd` |
| Android 8.0+ | `0.2.64 (264)` | `nexbot-0.2.64-debug.apk` | 44,227,945 | `ef5b78a0f826dd81644a44d8d255c54608b1d3eb536cc737a29622e8c4456f2c` |
| Mac（Apple 芯片） | `0.2.59 (61)` | `NexBot-0.2.59-mac-arm64.dmg` | 113,706,792 | `b42f8f2c8a40dbb59d300a33a70da3c1867c854bec2b7d515b58d90a35b696e4` |
| iPhone（iOS 17+，未签名） | `0.2.59 (61)` | `NexBot-0.2.59-ios-unsigned.ipa` | 38,351,173 | `addb347d8641fe7c91cc7077ea739acd30410aa0e53c4393d637b52172e35296` |

## 发布范围（自 0.9.65 / 0.2.63 / 0.2.58 以来）

- `bcf3f394`：对齐 Mac 与 iOS 原生 NexAgent 视觉布局（单行顶栏、引擎图标与卡片式输入框）。
- `b074fd0c`、`5d299b32`、`d0439828`：
  - 精简协作提示词以保持前缀缓存稳定；新增 `nex models [agent]` / `nex_models`，`nex agents` 同步返回实时可用模型 ID，`nex start` 派工前先校验并解析 `--model`。
  - 协作工人固定以最高权限模式（`full`）启动避免审批打断，移除设置页默认权限下拉框；启动失败的工人不再占用 `maxWorkers` 名额，区分明确启动拒绝与不确定回执。
  - Web、Windows（Electron 剪贴板 IPC）与 macOS 原生 NexAgent 输入框支持直接粘贴图片；四端版本升至 `0.9.66` / `0.2.64 (264)` / `0.2.59 (61)`。
- `e9070a79`：
  - **隐藏失败协作者**：协作面板、历史协作、顶栏协作计数与侧栏会话树均不再渲染 `status === "failed"` 的协作者，保留底层会话键映射与级联归档清理；Core 排除失败协作者占用 `maxWorkers` 名额并在 `nex status` 主列表中隐藏失败项。
  - **协作者汇报简报化**：`nex report` / `nex_report` 新增 `--brief` 简报字段并支持从长报告自动提炼要点与分级问题计数；审查员卡片直接展示问题分级统计（如 `发现 3 个问题` + `P1/P2/P3` 标签）与简短结论，实现者卡片仅展示核心要点与折叠文件标签，点右上角 `查看 >` 可进入对应协作者会话查看完整上下文。
  - **协作期主控规划决策约束与审查修复闭环**：Core 通过 `cli.team.config` 下发活跃协作主控会话 `activeLeadRefs`，Claude Code（`PreToolUse` 的 `lead_guard` / `nex_pre`）与 AGY 运行时拦截活跃主控直接编辑项目源码文件或执行项目源码写入命令（仅放行 `.nex-team/` 与临时目录写任务说明文件，普通单 Agent 会话不受影响）；角色感知投递页脚在审查发现问题时引导 `nex send <实现者>` 修复后再 `nex send <审查员>` 复审，记录 `leadDispatchedAt` 避免派活后汇报被误延迟。

## 构建与校验证据

1. **静态检查与 CI（`e9070a79`）**：
   - 推送前通过 `pnpm lint`（0 warning / 0 error）、`pnpm typecheck` 与 `pnpm i18n:check`（10 种语言 3686 条目有效）。
   - GitHub Actions `CI`（run `46151964791`）：`typecheck + lint` 通过；`core tests` 共 2317/2318 通过，仅暴露 1 项 `isLeadAllowedTempFilePath` 在工作目录本身位于系统 `/tmp` 下的边界断言失败（常规工作目录不受影响，已随本次文档提交一并修复并在后续 CI 中复核）；`Kotlin tests + Android fixtures` 因 CI 侧下载 Maven 依赖发生 `java.io.IOException` 失败。
2. **生产 Core 与 Web UI 部署（`mac-air`，Schema 62）**：
   - 基于 `e9070a79` 构建 `core`/`ui` 覆盖包并暂存至 `~/nexbot/releases/main-e9070a79-20261128`（`package.json` 与生产一致）。
   - `verify-candidate.mjs` 在隔离候选 Core 核验 `/health` 200、未鉴权 `/api/state`/`/api/cli-agents`/`/api/cli-agents/teams`/`/api/cli-agents/team-settings` 均返回 401、WebSocket 鉴权、全部 16 项静态资源逐字节匹配（含 `na-team-brief-counts` 简报 UI 与 Core 内 `activeLeadRefs`），并对全部 6 个生产工作区数据库（`data/core.db` 及 `data/account-workspaces/*/core.db`）的只读 SQLite `.backup` 副本完成启动预演（全部 `integrity_check=ok`、`foreign_key_check=0`、业务与工作台表内容哈希 100% 一致）。
   - 确认无活跃任务后由脱离进程 `deploy-core.py` 备份 `config`/`data`/`run-core.py` 至 `~/nexbot/backups/main-e9070a79-20261128-pre` 并核对备份哈希，切换重启完成（`deploy-core.exit=0`）；全部 6 个工作区切换前后业务数据哈希一致，本机与公网 `https://bot.nexorai.com.cn` 全部 16 项静态资源逐字节匹配；另从本机 Windows 独立复核公网 `/health` 200、4 个未鉴权接口 401 与首页静态资源。
3. **Windows `0.9.66`**：本机 `pnpm package:client:win` 构建 `NexBot-0.9.66-x64-Client-Setup.exe`，确认内置 `resources/client-executor/cli-agents-plugin/skills/nex/SKILL.md` 及 `hooks/hooks.json`（含 `lead_guard`）；对 `win-unpacked/NexBot Client.exe` 运行 `node scripts/smoke-shell-login.mjs --exe=...`，全部 20 项冒烟用例通过。
4. **Android `0.2.64 (264)`**：本机 JDK 17（`azul-17.0.9`）+ Android SDK 36 执行 `./gradlew --no-daemon :app:assembleDebug`；`aapt2 dump badging` 核验 `com.nexorai.nexbot.debug` `0.2.64 (264)`（`minSdkVersion=26`、`targetSdkVersion=36`）；`apksigner verify --print-certs` 验证通过，调试证书 SHA-256 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b` 与 `0.2.63` 一致；确认打包前端资源包含 `na-team-brief-counts` 简报 UI。
5. **Mac / iPhone `0.2.59 (61)`**：在 `mac-air` 全新临时目录克隆 `e9070a79`，执行 `corepack pnpm install --frozen-lockfile`、`node scripts/build-nexbot-icons.mjs`、`NexClientKit` `swift test`，创建独立模拟器 `NexBot-Release-0259-e9070a79`（`iPhone 16 Pro / iOS 18.6`）执行 `RENDER_TESTS=false bash apps/apple/scripts/release-preview.sh`。挂盘核验 DMG（`com.nexbot.mac` `0.2.59 (61)`、`codesign --verify --deep --strict`、可执行 `Executor/node`、`SKILL.md` 与 `hooks.json` 中的 `lead_guard`）；解压核验 IPA（`com.nexbot.ios` `0.2.59 (61)`、无 `_CodeSignature`）。构建后已核查确认临时目录与独立模拟器均已删除。
6. **GitHub 预发布、OSS 镜像、在线更新与主页核验**：
   - 创建并核对 GitHub 预发布 `nexbot-v0.9.66-preview.1` 全部 6 个附件的大小与 SHA-256 摘要，与本地产物逐项一致。
   - 备份原 OSS 清单至 `~/nexbot/backups/main-e9070a79-20261128-pre/client-manifest.json`，经 `publish-client-update.mjs --dry-run` 复核后上传全部 4 个安装包并读回校验 SHA-256，更新共享清单（保留历史 `windows` 便携版 `0.9.51` 条目）。
   - 从本机校验公网 `https://bot.nexorai.com.cn/api/client/update`：旧版本（Windows `0.9.65` NSIS、Android `0.2.63`、Mac `0.2.58`、iOS `0.2.58`）均正确下发新版，当前版本均返回 `available: false`；完整下载全部 4 个下发安装包，字节数与 SHA-256 均与上表完全一致。
   - 校验公网 `https://bot.nexorai.com.cn/api/client/downloads`、主页 [HomePage.tsx](../../src/personal/HomePage.tsx)（动态消费 `/api/client/downloads` 覆盖全部四端）与 [README.md](../../README.md) 版本号及下载链接全部一致。

## 验证限制

- 未在真实物理 Android 手机、iPhone 或全新 Windows 机器上做人工安装与 GUI 交互点检。
- Apple 构建使用 `RENDER_TESTS=false` 跳过 UI 渲染截图测试；Apple 原生 SwiftUI 协作面板将在第 2 期补齐（Mac `0.2.59` 已内置更新后的协作执行器与 `lead_guard`）。
- Windows 安装包尚无商业代码签名，Mac DMG 为临时签名未公证，Android APK 使用调试签名。
- `e9070a79` 打包产物中，当会话工作目录本身位于系统临时目录（如 `/tmp/...`）时 `isLeadAllowedTempFilePath` 会误放行该工作目录下的文件（正常项目目录不受影响）；该边界修复已于本次发版记录同步合入 `main`。
