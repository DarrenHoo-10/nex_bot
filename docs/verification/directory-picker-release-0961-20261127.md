# 目录选择器优化、移动端体验修复与 AGY/Codex 桌面会话改进 · 0.9.61 四端发布记录

构建提交：已推送到 `main` 的 `4359e3534d8126a7d807dd5b62e15c65f5e5e75b`。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.61-preview.1) · [官网下载](https://bot.nexorai.com.cn/#platforms)

## 发布范围（自 0.9.60 以来）

- `4fa574ad`：优化 NexAgent 目录选择器 UI（Web / Windows / Android 移动端改为底部抽屉 Sheet、取消触屏自动弹软键盘、修复搜索框双层绿框与面包屑横向滚动条、添加左右渐隐与一键清空、默认不渲染 `.` 开头隐藏目录、目录行精简为点击进入 + 双行路径底栏确认；同步更新 Apple SwiftUI `AgentDirectoryBrowser` 与 iOS `.sheet` 呈现）。
- `867f9dda`：将 Antigravity 桌面会话接入历史读取与续接流程。
- `a6c6f440`：使用首条消息替换 Codex 新会话的占位名称。
- `4359e353`：修复移动端侧边栏背景、添加 Agent 弹窗抖动、将后台任务入口移入右侧面板并完善手机端切回列表（含 Apple 端同步）。

## 构建与校验

- **静态检查与主分支 CI**：
  - 提交 `4fa574ad`（目录选择器 UI 重构）已完整通过 [主分支 CI `45990973479`](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45990973479) 与 Docker 镜像构建 `45990973279`。
  - 构建提交 `4359e353` 的 [CI `45994886169`](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45994886169) 中 `typecheck + lint`（含多语言目录校验、Electron 校验与生产 UI 构建）已通过，Docker 构建 `45994886068` 已通过；发布记录归档时 `core tests` 仍在运行，而 `Kotlin tests + Android fixtures` 因 Maven Central 临时返回 `HTTP 429 Too Many Requests`（拉取 `org.robolectric:nativeruntime-dist-compat:1.0.18` 限流）失败，非代码断言失败。
- **Windows 安装包（`0.9.61`）**：在 [GitHub Actions 隔离 Windows VM `45995485715`](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45995485715) 基于 `4359e353` 构建并完成 Setup 安装校验与安装后 20 项 `smoke-shell-login.mjs` 登录冒烟。
- **Android APK（`0.2.59` / `259`）**：本机 JDK 17 + Android SDK 36 基于 `4359e353` 执行 `./gradlew --no-daemon :app:assembleDebug` 构建，`aapt2` 校验包名 `com.nexorai.nexbot.debug`、版本 `0.2.59 (259)`；`apksigner` 校验通过，调试证书 SHA-256 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b` 与 0.2.58 一致；确认 APK 内 `assets/workspace/assets/CliAgentsWorkspace-xnh6nWhh.js` 与 `assets/workspace/assets/main-OX0AQPBj.css` 均包含新目录选择器代码与样式。
- **Mac / iPhone（`0.2.53` / `55`）**：在 Mac Air 独立临时克隆（`4359e353`）与新建专用 iOS 模拟器完成 `release-preview.sh`（`RENDER_TESTS=false`）构建，随后删除临时目录与专用模拟器。挂载实际 DMG 核验 `CFBundleShortVersionString=0.2.53`、`CFBundleVersion=55`、`com.nexbot.mac`、`codesign --verify --deep --strict` 与内置执行器字节一致；解压实际 IPA 核验 `0.2.53 (55)`、`com.nexbot.ios` 及未签名状态。`swift test` 共执行 278 项 XCTest + 1 项 Swift Testing 全部通过。

## 安装包

| 安装包 | 字节 | SHA-256 |
| --- | ---: | --- |
| `NexBot-0.9.61-x64-Client-Setup.exe` | 149215677 | `402948f5b601e33559678d1ebef28d6c109996db3bed683c3816b2ee56efbee2` |
| `nexbot-0.2.59-debug.apk` | 44263071 | `0369185774e157cc49bcd60399ae8e8d2a46218b4967f48094453cc90b312d78` |
| `NexBot-0.2.53-mac-arm64.dmg` | 111140389 | `5fa5082b615e4bfcee15db7a32ef1d027fc4c35efb91f1fee1d2fe47e108075f` |
| `NexBot-0.2.53-ios-unsigned.ipa` | 37631613 | `28f713fdbea443150ce93e5ffe41766806990a63cac9c5f5c6e9d258f4381ce0` |

## 生产部署与分发

- **Mac Air Core 部署**：基于 `main-27bd7b79-20261127` 暂存叠加 `main-4359e353-20261127`；在全部 6 个工作区数据库的 SQLite `.backup` 副本上通过 `PRAGMA integrity_check`、`PRAGMA foreign_key_check` 与迁移版本核对（最高版本 61，无新增迁移），并由独立隔离候选 Core 验证全部路由与资源。在无活动任务时由 `nohup` 独立进程完成 `config`/`data` 备份（`~/nexbot/backups/main-4359e353-20261127-pre`）及哈希核对、切换 `run-core.py` 并重启 `gui/<uid>/cn.nexorai.nexbot-core`，部署退出码 0、无回滚，6 个工作区业务表哈希切换前后一致。
- **公网 Core 核验**：从公网独立验证 `https://bot.nexorai.com.cn`：`/health` 返回 200，匿名访问 `/api/state`、`/api/cli-agents` 与 WebSocket `/api/cli-agents/stream` 均返回 401，首页 `nexbot-web-version` 为 `0.9.61`，首页及全部 12 个静态资源与构建产物字节一致。
- **GitHub 与 OSS 分发**：创建并公开预发布 `nexbot-v0.9.61-preview.1`（指向 `4359e3534d8126a7d807dd5b62e15c65f5e5e75b`），6 个附件（4 个安装包 + `SHA256SUMS.txt` + `SOURCE_COMMIT.txt`）大小与 SHA-256 均与本地文件一致。私有备份旧 OSS 清单至 `~/nexbot/backups/main-4359e353-20261127-pre/client-manifest.json`，先 `--dry-run` 校对再上传读回校验全部 4 个安装包并写入新清单。
- **更新接口与官网主页核验**：公网 `/api/client/update` 对旧版本（Windows `0.9.60` NSIS、Android `0.2.58`、Mac `0.2.52`、iOS `0.2.52`）均返回对应新版本，当前版本均返回 `available: false`；完整下载四份返回安装包，字节数与 SHA-256 均与上表一致。无头 Electron 访问 `https://bot.nexorai.com.cn/#platforms` 核验四端渲染版本号与下载链接均同清单与 README 一致。

## 验证边界

- 未在实体 Android 手机或实体 iPhone 上手动安装操作。
- Apple 打包未开启渲染截图测试（`RENDER_TESTS=false`）。
- 未在本机覆盖安装 Windows 生产客户端，未向用户生产会话写入消息。
