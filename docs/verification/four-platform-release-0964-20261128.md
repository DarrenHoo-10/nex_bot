# 移动端排版与未读定位、设置页优化及运行时/飞书通道修复 · 0.9.64 四端发布记录（2026-11-28）

构建来源提交：已推送到 `main` 的 `9aa9d4eae4ac79b32d47fc68564a4e63f0e1165d`（四端安装包与生产 Core / Web UI 均构建自该同一提交）。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.64-preview.1) · [官网下载](https://bot.nexorai.com.cn/#platforms)

## 安装包清单

| 平台 | 版本 | 文件名 | 大小（字节） | SHA-256 |
| --- | --- | --- | ---: | --- |
| Windows x64 | `0.9.64` | `NexBot-0.9.64-x64-Client-Setup.exe` | 149,273,343 | `cc7ea729f5b3a0c978333af7ba089b3f342d5bb1638a3249104ec0373acfc13f` |
| Android 8.0+ | `0.2.62 (262)` | `nexbot-0.2.62-debug.apk` | 44,206,949 | `23f747cdc9d39345b0b6ec0dee0b68c560163d23c03fdd3026ae715ffb7d638f` |
| Mac（Apple 芯片） | `0.2.57 (59)` | `NexBot-0.2.57-mac-arm64.dmg` | 112,880,062 | `f91247a3a13fe9cce7b128c7782e40c26882b13ceadde1d2acfe439f8bc84975` |
| iPhone（iOS 17+，未签名） | `0.2.57 (59)` | `NexBot-0.2.57-ios-unsigned.ipa` | 38,328,827 | `eb35f87e86a8809924a93719d7a702391df25082847cac9422ad4290b6106f3e` |

## 发布范围（自 0.9.63 / 0.2.56 以来）

- `fe022f7c`、`6e8b9f74`：优化设置页布局与移动端两级设置导航，去除分支选择器多余白框，手机端新建会话改为「项目 / 运行工具 / 设置」三标签；修复桌面端子代理 `<task-notification>` 误渲染为用户消息；修复移动端对话页横向溢出，支持进入会话与子话题自动定位最早未读消息及统一毛玻璃风格「回到底部」胶囊（同步适配 Apple SwiftUI）。
- `d1cc261a`：修复 Apple 端未关联项目分组在 Release 内联下触发的空字节闪退。
- `0960d314`：修复并行工具回放命中在途 `agent.delegate` / 已中断可恢复工具误报「工具未获批准」、Worker 退出清理遗留 `executing` 调用、`feishu_read` 只读报错不再标为 `unknown`、过滤孤儿飞书连接器并按助手名区分、设备回包对账守卫、飞书群报错不再刷出「通道通知」话题，以及浅色主题下飞书话题副标题对比度修复。
- `9aa9d4ea`：四端版本同步升至 Windows `0.9.64`、Android `0.2.62 (262)`、Mac / iPhone `0.2.57 (59)`。

## 构建与校验证据

1. **静态检查**：`9aa9d4ea` 推送前通过 `pnpm lint`（0 warning / 0 error）、`pnpm typecheck` 与 `pnpm i18n:check`（10 种语言 3686 条目有效）。
2. **Windows `0.9.64`**：本机 `pnpm package:client:win` 构建 `NexBot-0.9.64-x64-Client-Setup.exe`，并对打包后的 `win-unpacked/NexBot Client.exe` 运行 `node scripts/smoke-shell-login.mjs --exe=...`，全部 20 项登录、设备状态、设置页与退出隔离冒烟通过（同步修正脚本中旧文案「本设备」→「当前设备」）。
3. **Android `0.2.62 (262)`**：本机 JDK 17（`azul-17.0.9`）+ Android SDK 36 执行 `./gradlew --no-daemon :app:assembleDebug`；`aapt2 dump badging` 核验 `com.nexorai.nexbot.debug` `0.2.62 (262)`；`apksigner verify --print-certs` 验证通过，调试证书 SHA-256 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b` 与 0.2.61 一致；确认 APK 内 `assets/workspace/assets/main-BYJPdm0R.css` 包含话题副标题对比度与移动端横向溢出修复。
4. **Mac / iPhone `0.2.57 (59)`**：在 `mac-air` 独立临时克隆 `9aa9d4ea`，执行 `corepack pnpm install --frozen-lockfile`、`node scripts/build-nexbot-icons.mjs`、`NexClientKit` `swift test` 与新建独立模拟器（`iPhone 16 Pro / iOS 18.6`）执行 `RENDER_TESTS=false bash apps/apple/scripts/release-preview.sh`。挂盘校验 DMG（`com.nexbot.mac`、`0.2.57 (59)`、`codesign --verify --deep --strict`、内置可执行 `Executor/node`）；解压校验 IPA（`com.nexbot.ios`、`0.2.57 (59)`、无 `_CodeSignature`）。构建结束后已复核确认临时目录与独立模拟器均已删除。
5. **生产 Core 与 Web UI 部署（`mac-air`）**：基于 `9aa9d4ea` 构建覆盖包并暂存至 `~/nexbot/releases/main-9aa9d4ea-20261128`；对全部 6 个工作区数据库的 SQLite `.backup` 副本完成 `integrity_check=ok`、`foreign_key_check=0`、`schema_migrations=61` 复演及隔离候选 Core 验收。无在途任务时由脱离进程 `deploy-core.py` 备份并切换重启（退出码 `0`），6 个工作区业务表哈希切换前后完全一致，本机与公网 `https://bot.nexorai.com.cn` 全部 16 项静态资源及 `nexbot-web-version=0.9.64` 逐字节匹配，`/health` 为 200，未鉴权 `/api/state` 与 `/api/cli-agents` 为 401。
6. **GitHub 预发布、OSS 镜像、更新接口与主页核验**：
   - 创建并验证 GitHub 预发布 `nexbot-v0.9.64-preview.1`（6 个附件大小与 SHA-256 与本地一致）。
   - 备份原 OSS 清单至 `~/nexbot/backups/client-manifest-before-0964.json`，经 `publish-client-update.mjs --dry-run` 核对后上传全部 4 个安装包并完成读回 SHA-256 校验与清单更新（保留历史 `windows` 便携版 `0.9.51` 条目）。
   - 校验公网 `/api/client/update`：旧版本（Windows `0.9.63` NSIS、Android `0.2.61`、Mac `0.2.56`、iOS `0.2.56`）均正确下发对应新版本，当前版本均返回 `available: false`；实际完整下载全部 4 个返回安装包，字节数与 SHA-256 均与上表完全一致。
   - 校验 `/api/client/downloads`、官网主页 [HomePage.tsx](../../src/personal/HomePage.tsx)（动态消费 `/api/client/downloads`）与 [README.md](../../README.md) 四端版本与下载链接全部一致。

## 验证限制

- 未在物理 Android 手机和物理 iPhone 上进行实机安装与手工交互操作。
- Apple 打包未开启渲染截图测试（`RENDER_TESTS=false`）。
- 未在本机覆盖安装用户生产 Windows 客户端；`0960d314` CI 中暴露的两处测试问题（`src/personal/api.ts` Node 环境 `window` 判空与 `feishu.test.ts` 孤儿连接器断言）已在发布后同步修复提交。
