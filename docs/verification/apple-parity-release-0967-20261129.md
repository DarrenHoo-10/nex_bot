# Mac / iPhone 全面功能与 UI 对齐、多 Agent 协作界面补齐与审查修复 · 0.9.67 四端与生产 Core 发布记录（2026-11-29）

构建来源提交：已推送到 `main` 的 `e2b167d6fe7375f4af6b965dd0b7b785ecb04069`（Mac / iPhone 构建自 `e2b167d6` 干净克隆；生产 Core / Web UI、Windows 与 Android 构建自 `19970455368e04771a1796a42cfca0275acdd70d`，后续 `7561ca7d`–`e2b167d6` 仅改动 `apps/apple/`，非 Apple 源码树与 `e2b167d6` 完全一致）。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.67-preview.1) · [官网下载](https://bot.nexorai.com.cn/#platforms)

## 安装包清单

| 平台 | 版本 | 文件名 | 大小（字节） | SHA-256 |
| --- | --- | --- | ---: | --- |
| Windows x64 | `0.9.67` | `NexBot-0.9.67-x64-Client-Setup.exe` | 149,301,893 | `da27ae541ac3eae52fa01575102c0f7f63b06d477293d84c540fdec983085149` |
| Android 8.0+ | `0.2.65 (265)` | `nexbot-0.2.65-debug.apk` | 44,228,569 | `7f75639ff591e63f84e65a3c8bf0a29fea73f72072cf5747181d5918b202da55` |
| Mac（Apple 芯片） | `0.2.60 (62)` | `NexBot-0.2.60-mac-arm64.dmg` | 117,852,766 | `36280e1c1a34c4f9cc0d96f44219b6497d7596cc3876e6b694a471d185cc28d5` |
| iPhone（iOS 17+，未签名） | `0.2.60 (62)` | `NexBot-0.2.60-ios-unsigned.ipa` | 40,674,595 | `d8321757f4ad5017a47b807bec5a4ce1adf9777c584f7ce0dc907a6318e0a37b` |

## 发布范围（自 0.9.66 / 0.2.64 / 0.2.59 以来）

- `3d50a351`、`08c8d3ce`：
  - 修复 `isLeadAllowedTempFilePath` 在工作目录位于系统临时目录时的路径边界；优化未读滚动定位、设置页返回、飞书先响应，移除后台任务汇报卡片停止键，过滤 AGY 子代理噪音会话。
- `89ccf3f0`、`19970455`、`7561ca7d`、`0a73e6ef`、`cc1cbcac`、`0e7d5bc6`、`e2b167d6`：
  - **Mac / iPhone 原生客户端全面对齐 Windows 与 Android**：补齐 NexAgent 原生多 Agent 协作面板、主会话折叠协作者、隐藏失败协作者、精炼简报与审查分级标签（`P0–P3`/`Clean`）、点击「查看 >」跳转协作者会话、协作设置页、完整 Markdown 块（表格/代码/引用）与工具步骤详情抽屉、飞书投递与分群设置、统一待办、金融话题、GitHub / Gmail 连接器、设置项与视觉交互对齐。
  - **代码审查 9 项修复**：`CliPermissionMode` 补齐 `Codable` 及容错解码；令牌轮换与 `4401` 时强制替换已打开的 WebSocket 并恢复原有订阅；`.fileImporter` 拆分弹窗与导入类型状态避免丢图；后台任务重试复用原 `clientID`；编辑重发传 `requestId: nil` 不误暂停队列；乐观消息按 Core `source_key` 精确确认；保存图片请求不带 `?preview=1` 的原图并按真实 `UTType` 写入；iOS 相册保存通过 `PhotoAlbumSaver` 等待系统回调并展示权限/写入错误；终端搜索改为 `unicodeScalars` + 跨块 `pendingCR` 增量解析 CRLF。
  - **发布构建验证中发现并修复**：修复 `SyncTests` 中 `08c8d3ce` 引入的 Swift 6 并发闭包崩溃及切回聊天时过期未读锚点、`project.yml` 中 `NSPhotoLibraryAddUsageDescription` UTF-8 编码、`CliFolderGroup` `public init`、SwiftTerm `non-open` `keyDown` 拦截（改用 `performKeyEquivalent` + 本地按键监听），以及 iOS `ChatView` / `ConnectedView` 过长表达式拆分。

## 构建与校验证据

1. **静态检查与 CI**：
   - 每次推送前均通过 `pnpm lint`（0 warning / 0 error）、`pnpm typecheck` 与 `pnpm i18n:check`（10 种语言 3686 条目有效）。
   - GitHub Actions `CI`（run `46169442316`）：`typecheck + lint`、`core tests`、`CI` 均通过；`Kotlin tests + Android fixtures` 共 28/29 通过，仅 1 项预存的 `ChatScreenTest.kt:76`（`shows the transcript, the approval buttons and the composer`）断言失败（本次未改动 Kotlin 源码）；最新提交 `e2b167d6` 对应的 run `46171643281` 已排队触发。
2. **生产 Core 与 Web UI 部署（`mac-air`，Schema 62）**：
   - 基于 `19970455` 构建 `core`/`ui` 覆盖包并暂存至 `~/nexbot/releases/main-19970455-20261129`（`package.json` 与生产一致）。
   - `verify-candidate.mjs` 在隔离候选 Core 核验 `/health` 200、未鉴权 `/api/state`/`/api/cli-agents`/`/api/cli-agents/teams`/`/api/cli-agents/team-settings` 均返回 401、WebSocket 鉴权、全部 16 项静态资源逐字节匹配（含 `na-team-brief-counts`），并对全部 6 个生产工作区数据库（`data/core.db` 及 `data/account-workspaces/*/core.db`）的只读 SQLite `.backup` 副本完成启动预演（全部 `integrity_check=ok`、`foreign_key_check=0`、业务与工作台表内容哈希 100% 一致）。
   - 确认无活跃任务后由脱离进程 `deploy-core.py` 备份 `config`/`data`/`run-core.py` 至 `~/nexbot/backups/main-19970455-20261129-pre` 并核对备份哈希，切换重启完成（`deploy-core.exit=0`）；全部 6 个工作区切换前后业务数据哈希一致，本机与公网 `https://bot.nexorai.com.cn` 全部 16 项静态资源逐字节匹配。
3. **Windows `0.9.67`**：本机 `pnpm package:client:win` 构建 `NexBot-0.9.67-x64-Client-Setup.exe`，确认内置 `resources/client-executor/cli-agents-plugin/skills/nex/SKILL.md` 及 `hooks/hooks.json`；对 `win-unpacked/NexBot Client.exe` 运行 `node scripts/smoke-shell-login.mjs --exe=...`，全部 20 项冒烟用例通过。
4. **Android `0.2.65 (265)`**：本机 JDK 17（`azul-17.0.9`）+ Android SDK 36 执行 `./gradlew --no-daemon :app:assembleDebug`；`aapt2 dump badging` 核验 `com.nexorai.nexbot.debug` `0.2.65 (265)`（`minSdkVersion=26`、`targetSdkVersion=36`）；`apksigner verify --print-certs` 验证通过，调试证书 SHA-256 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b` 与历次发布一致。
5. **Mac / iPhone `0.2.60 (62)`**：在 `mac-air` 全新临时目录克隆 `e2b167d6`，执行 `corepack pnpm install --frozen-lockfile`、`node scripts/build-nexbot-icons.mjs`、`NexClientKit` `swift test`（290 项 XCTest + 1 项 Swift Testing，全部 291 项 0 失败），创建独立模拟器 `NexBot-Release-0260-19970455`（`iPhone 16 Pro / iOS 18.6`）执行 `RENDER_TESTS=false bash apps/apple/scripts/release-preview.sh`。挂盘核验 DMG（`com.nexbot.mac` `0.2.60 (62)`、`codesign --verify --deep --strict`、可执行 `Executor/node`、`SKILL.md` 与 `hooks.json`）；解压核验 IPA（`com.nexbot.ios` `0.2.60 (62)`、无 `_CodeSignature`）。构建后已核查确认临时目录与独立模拟器均已删除。
6. **GitHub 预发布、OSS 镜像、在线更新与主页核验**：
   - 创建并核对 GitHub 预发布 `nexbot-v0.9.67-preview.1` 全部 6 个附件的大小与 SHA-256 摘要，与本地产物逐项一致。
   - 备份原 OSS 清单至 `~/nexbot/backups/main-19970455-20261129-pre/client-manifest.json`，经 `mirror-oss.py`（`--dry-run`）复核后上传全部 4 个安装包并读回校验 SHA-256，更新共享清单（保留历史 `windows` 便携版 `0.9.51` 条目）。
   - 从本机执行 `verify-live-updates.mjs` 校验公网 `https://bot.nexorai.com.cn`：`/health` 200、4 个未鉴权接口 401；`/api/client/update` 对旧版本（Windows `0.9.66` NSIS、Android `0.2.64`、Mac `0.2.59`、iOS `0.2.59`）均正确下发新版，当前版本均返回 `available: false`；完整下载全部 4 个下发安装包，字节数与 SHA-256 均与上表完全一致。
   - 校验公网 `/api/client/downloads`、主页 [HomePage.tsx](../../src/personal/HomePage.tsx)（动态消费 `/api/client/downloads` 覆盖四端）与 [README.md](../../README.md) 版本号及下载链接一致。

## 验证限制

- 未在真实物理 Android 手机、iPhone 或全新 Windows 机器上做人工安装与 GUI 交互点检。
- Apple 构建使用 `RENDER_TESTS=false` 跳过 UI 渲染截图测试。
- Windows 安装包尚无商业代码签名，Mac DMG 为临时签名未公证，Android APK 使用调试签名。
- 生产 Core / Web UI、Windows 与 Android 构建自 `19970455`，Mac / iPhone 构建自 `e2b167d6`；其间 4 个提交仅修改 `apps/apple/`，非 Apple 源码树与 `e2b167d6` 零差异。
