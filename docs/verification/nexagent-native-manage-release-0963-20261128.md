# NexAgent 无时间限制与真实原生归档/删除、全端终端升级与分支选择 · 0.9.63 四端发布记录

构建提交：已推送到 `main` 的 `d748bd6589b96df48693ef3805dedc9a5cb01a09`（Core / Web / Windows / Android 构建自 `bd1ffa280988c6d1a5d4d0f818fcbb53da11065e`；`d748bd65` 相对 `bd1ffa28` 仅包含 `apps/apple/` 两处 SwiftUI `.frame` 编译修复，用于构建 Mac / iPhone）。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.63-preview.1) · [官网下载](https://bot.nexorai.com.cn/#platforms)

## 发布范围（自 0.9.62 以来）

- `2bd36db0`：移除 NexAgent 全 4 个引擎（Claude Code、Codex、ZCode、Antigravity CLI）的默认 14 天历史时间窗口并将单机上限提升至 1000；新增 `sessionManage` 能力与 `archive`/`delete` 原生指令，实现四引擎真实原生归档、恢复与永久删除及双向归档状态同步（同步更新 Core、Web 与 Apple SwiftUI）。
- `0bdcecf8`：参考 Persona 升级全端 Agent 终端交互、快捷键条与浮层 UI，并下线「在电脑上打开」。
- `2ffcfc35`：新建会话区分本地分支切换与 Worktree（含基线分支与工作树干净校验），修复 Git 卡片误判主工作树问题。
- `5f30f134`：修复 NexAgent 移动端「更早」缩进，并将空目录与 ZCode 临时目录归入「未关联项目」。
- `b8e43e78`、`d748bd65`：对齐主对话与子话题未读计数、补齐普通助手话题入口与聚焦补报，并修复 Apple 端话题未读角标 SwiftUI `.frame` 编译问题。
- `9ceaacc0`：折叠展示 Agent 内部协作消息并修复 Windows 覆盖升级占用与退出超时。
- `bd1ffa28`：升级四端发布版本至 Windows `0.9.63`、Android `0.2.61 (261)`、Mac / iPhone `0.2.55 (57)`。

## 构建与校验

- **静态检查与主分支 CI**：
  - `bd1ffa28` 与 `d748bd65` 均通过本机 pre-push 静态检查（`pnpm lint` 0 warning/0 error、`pnpm typecheck` 通过、`pnpm i18n:check` 通过），[Docker 镜像构建 `46111257940`](https://github.com/DarrenHoo-10/nex_bot/actions/runs/46111257940) 通过。
  - [主分支 CI `46112130046`](https://github.com/DarrenHoo-10/nex_bot/actions/runs/46112130046)（`bd1ffa28`）中 `typecheck + lint` 通过、Core/Web/Shared 测试通过 2285/2289 项；其中 3 项旧断言（`agy-native.test.ts` 返回值、`bridge.test.ts` 特征清单、`discovery.test.ts` 桌面归档会话可见性）已在后续提交一并修正，另有 2 项上游测试失败（`device-git.test.ts` 脏工作树错误优先级、Android `ChatScreenTest`）留待对应模块跟进。
- **Windows 安装包（`0.9.63`）**：在 [GitHub Actions 隔离 Windows VM `46112166362`](https://github.com/DarrenHoo-10/nex_bot/actions/runs/46112166362) 基于 `bd1ffa28` 完成打包、Setup 目录校验与安装后 `smoke-shell-login.mjs` 登录冒烟。
- **Android APK（`0.2.61` / `261`）**：本机 JDK 17（`azul-17.0.9`）+ Android SDK 36 基于 `bd1ffa28` 执行 `./gradlew --no-daemon :app:assembleDebug` 构建，`aapt2` 校验包名 `com.nexorai.nexbot.debug`、版本 `0.2.61 (261)`；`apksigner` 校验通过，调试证书 SHA-256 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b` 与 0.2.60 一致；核验 APK 内 `assets/workspace/assets/CliAgentsWorkspace-CCazTHA3.js` 包含 `sessionManage` 变更。
- **Mac / iPhone（`0.2.55` / `57`）**：在 Mac Air 独立临时克隆（`d748bd65`）与新建专用 iOS 模拟器完成 `release-preview.sh`（`RENDER_TESTS=false`）构建，随后自动清理临时目录与专用模拟器。`swift test` 共执行 288 项 XCTest + 1 项 Swift Testing 全部通过。挂载实际 DMG 核验 `CFBundleShortVersionString=0.2.55`、`CFBundleVersion=57`、`com.nexbot.mac`、`codesign --verify --deep --strict` 与内置执行器目录内容；解压实际 IPA 核验 `0.2.55 (57)`、`com.nexbot.ios` 及未签名状态。

## 安装包

| 安装包 | 字节 | SHA-256 |
| --- | ---: | --- |
| `NexBot-0.9.63-x64-Client-Setup.exe` | 149265565 | `fb6f208c298cea91f554745cfde4bdaa0a24902ca5a05a4c62c2d9898e318e40` |
| `nexbot-0.2.61-debug.apk` | 44198225 | `f911da30de74fdb8f7a397fc2733ddb0cc86a399306302cbe5ee9a2dbfe95261` |
| `NexBot-0.2.55-mac-arm64.dmg` | 112652178 | `9cf8f6e1b398529ad82ba3f95cb7db05416beefb4840df58e29c0aef0c948f99` |
| `NexBot-0.2.55-ios-unsigned.ipa` | 37850723 | `a5a8306a89c1a22dd882abbfcfa74c680586122a7d8da9271c78d47adb9d0306` |

## 生产部署与分发

- **Mac Air Core 部署**：基于 `main-54f96e01-20261127` 暂存叠加 `main-bd1ffa28-20261128`；在全部 6 个工作区数据库的 SQLite `.backup` 副本上完成 `PRAGMA integrity_check`、`PRAGMA foreign_key_check` 与候选 Core 启动迁移演练（最高版本 61，无新增迁移），并由独立隔离候选 Core 验证全部路由与资源。在无活动任务时由 `nohup` 独立进程完成 `config`/`data` 备份（`~/nexbot/backups/main-bd1ffa28-20261128-pre`）及文件哈希核对、切换 `run-core.py` 并重启 `gui/<uid>/cn.nexorai.nexbot-core`，部署退出码 0、无回滚，6 个工作区业务表哈希切换前后一致。
- **公网 Core 核验**：从本机独立验证 `https://bot.nexorai.com.cn`：`/health` 返回 200，匿名访问 `/api/state`、`/api/cli-agents` 与 WebSocket `/api/cli-agents/stream` 均返回 401，首页 `nexbot-web-version` 为 `0.9.63`，首页及全部 16 个静态资源与构建产物字节一致。
- **GitHub 与 OSS 分发**：创建并公开预发布 `nexbot-v0.9.63-preview.1`（指向 `d748bd6589b96df48693ef3805dedc9a5cb01a09`），6 个附件（4 个安装包 + `SHA256SUMS.txt` + `SOURCE_COMMIT.txt`）大小与 SHA-256 均与本地文件一致。私有备份旧 OSS 清单至 `~/nexbot/backups/main-bd1ffa28-20261128-pre/client-manifest.json`，先 `--dry-run` 校对再上传读回校验全部 4 个安装包并写入新清单。
- **更新接口与官网主页核验**：公网 `/api/client/update` 对旧版本（Windows `0.9.62` NSIS、Android `0.2.60`、Mac `0.2.54`、iOS `0.2.54`）均返回对应新版本，当前版本均返回 `available: false`；完整下载四份返回安装包，字节数与 SHA-256 均与上表一致。无头 Electron 访问 `https://bot.nexorai.com.cn/#platforms` 核验四端渲染版本号与下载链接均同清单与 README 一致。

## 验证边界

- 未在实体 Android 手机或实体 iPhone 上手动安装操作。
- Apple 打包未开启渲染截图测试（`RENDER_TESTS=false`）。
- 未在本机覆盖安装 Windows 生产客户端，未向用户生产会话写入消息。
