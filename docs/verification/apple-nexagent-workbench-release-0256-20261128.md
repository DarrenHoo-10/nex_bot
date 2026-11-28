# Mac / iOS 原生 NexAgent 工作台补齐与 Mac 应用内更新修复 · 0.2.56 与 Core 发布记录（2026-11-28）

## 发布范围与基线

- **源提交（`origin/main`）**：`18da1e4a69e420f0bec8a618a29d03473b45f20f`（在 PR #25 合并提交 `1cf9b841` 基础上升级 `apps/apple/project.yml` 至 `0.2.56 (58)`）。
- **生产 Core 与 Web UI**：`mac-air`（`~/nexbot/releases/main-18da1e4a-20261128`，由 `main-bd1ffa28-20261128` 切换）。
- **GitHub 预发布**：[`nexbot-apple-v0.2.56-preview.1`](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-apple-v0.2.56-preview.1)。
- **保留未重发平台**：Windows `0.9.63`（`NexBot-0.9.63-x64-Client-Setup.exe`）与 Android `0.2.61`（`nexbot-0.2.61-debug.apk`），继续沿用 `nexbot-v0.9.63-preview.1` 的已验证安装包与 OSS 镜像条目。

## 发布产物与校验摘要

| 平台 | 版本 | 文件名 | 大小（字节） | SHA-256 |
| --- | --- | --- | --- | --- |
| Mac（Apple Silicon） | 0.2.56 (58) | `NexBot-0.2.56-mac-arm64.dmg` | 112,877,389 | `634e70c651a38f738509b59a8ce73c672ae68f4d9dc8b4c390708e030532b8b0` |
| iPhone（iOS 17+，未签名） | 0.2.56 (58) | `NexBot-0.2.56-ios-unsigned.ipa` | 38,330,283 | `f50b9385431ea9a7ddd238dcf737470f1a0ab88930350e753471fd3ed2f93e34` |

## 验证证据

1. **静态检查与主分支推送**
   - `git push origin main` 触发 pre-push 静态校验：`pnpm lint`（`oxlint --deny-warnings .` 0 warning / 0 error）、`pnpm typecheck`（`tsc -b && tsc -p tsconfig.server.json`）、`pnpm i18n:check`（10 种语言 3686 条目有效）全部通过。
2. **Core 与 Web UI 灰度预演及线上切换（`mac-air`）**
   - 本地 `node scripts/build-personal.mjs --core` 构建覆盖包，上传并在 `~/nexbot/releases/main-18da1e4a-20261128` 完成预演。
   - `verify-candidate.mjs` 独立候选实例通过 `/health`、未鉴权 `/api/state` 与 `/api/cli-agents` 返回 401、WebSocket `/api/cli-agents/stream` 鉴权与 `sub.list`、`dcp/v1/connect` 拒绝校验，以及全部 6 个工作区（`data/core.db` 与 5 个 `account-workspaces/*/core.db`）的 SQLite `.backup` 副本 `PRAGMA integrity_check = ok`、`PRAGMA foreign_key_check = 0` 与 `schema_migrations = 61` 校验。
   - 经由 `nohup` 独立后台进程执行 `deploy-core.py`：先确认无活跃任务并备份 `config/`、`data/` 与 `run-core.py` 至 `~/nexbot/backups/main-18da1e4a-20261128-pre`，切换后退出码为 `0`；本地（`127.0.0.1:8799`）与公网（`https://bot.nexorai.com.cn`）16 个静态资产均与本地构建逐字节一致，6 个工作区业务表哈希切换前后完全一致。
   - 从本机复核公网 `https://bot.nexorai.com.cn`：`/health` 返回 `200`，未鉴权 `/api/state` 与 `/api/cli-agents` 返回 `401`，`/` 与本地 `dist-personal/server/ui/index.html` 逐字节一致。
3. **Mac / iOS 0.2.56 全新克隆构建与产物校验（`mac-air`）**
   - 在临时目录全新 `git clone` 检出 `18da1e4a69e420f0bec8a618a29d03473b45f20f`，执行 `corepack pnpm install --frozen-lockfile` 与 `node scripts/build-nexbot-icons.mjs`。
   - `NexClientKit` 单元测试通过（289 个 XCTest + 1 个 Swift Testing，0 失败）。
   - 使用新建独立模拟器（`iPhone 16 Pro / iOS 18.6`）执行 `RENDER_TESTS=false bash apps/apple/scripts/release-preview.sh`。
   - 挂盘校验 `NexBot-0.2.56-mac-arm64.dmg`：`CFBundleIdentifier = com.nexbot.mac`、`CFBundleShortVersionString = 0.2.56`、`CFBundleVersion = 58`、`codesign --verify --deep --strict` 通过、内嵌 `Contents/Resources/Executor/node` 可执行。
   - 解压校验 `NexBot-0.2.56-ios-unsigned.ipa`：`CFBundleIdentifier = com.nexbot.ios`、`CFBundleShortVersionString = 0.2.56`、`CFBundleVersion = 58`、无 `_CodeSignature` 目录。
   - 构建完成后临时克隆目录与独立模拟器均已删除并复核确认清理干净。
4. **GitHub 预发布、OSS 镜像与官网/更新接口核对**
   - GitHub 预发布 `nexbot-apple-v0.2.56-preview.1` 上传 4 个文件（DMG、IPA、`SHA256SUMS.txt`、`SOURCE_COMMIT.txt`），`gh release view` 返回的各文件大小与 SHA-256 摘要与本地完全一致。
   - 先备份原 OSS 清单至 `~/nexbot/backups/main-18da1e4a-20261128-pre/client-manifest.json`，执行 `scripts/publish-client-update.mjs --dry-run` 确认仅更新 `mac` / `ios` 并保留 `windows-setup (0.9.63)`、`android (0.2.61)`、`windows (0.9.51)` 后写入正式清单，两个安装包均通过上传后读回 SHA-256 校验。
   - 核对线上接口：`GET /api/client/update?platform=mac&version=0.2.55` 与 `?platform=ios&version=0.2.55` 均返回 `0.2.56`，`?version=0.2.56` 均返回 `available: false`；实际下载两个安装包并核对字节大小与 SHA-256 全部一致。
   - 核对官网下载清单接口 `GET /api/client/downloads` 与 `README.md`：四端展示版本与下载入口一致（Windows `0.9.63`、Android `0.2.61`、Mac `0.2.56`、iPhone `0.2.56`）。

## 验证限制

- 未运行 `RENDER_TESTS=true` 的 Apple 渲染截图回归测试。
- 未在物理 iPhone 上执行 AltStore 重签安装与实机交互验证。
- 未在已安装旧版 `0.2.55` 的真实用户 Mac 环境上执行原地自动更新演练（代码层已通过 `AppUpdater.swift` 修复 `@MainActor` 退出死锁逻辑并完成编译与签名校验）。
