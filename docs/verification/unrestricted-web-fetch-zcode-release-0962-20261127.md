# 助手全权限放开、内置 `web.fetch`、后台任务对话修复与 ZCode/Windows 更新改进 · 0.9.62 四端发布记录

构建提交：已推送到 `main` 的 `54f96e016e2cd8aa9e493408496d933db0a4cf35`。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.62-preview.1) · [官网下载](https://bot.nexorai.com.cn/#platforms)

## 发布范围（自 0.9.61 以来）

- `75487ffd`、`516dc504`、`54f96e01`：
  - 全面放开助手默认权限与各类限制：所有活跃助手默认 `full` 审批模式并免审批开放全部可用工具；主对话可直接调用 `device.*`、`cli.*`、`connector.*`、`agent.delegate`、`image.generate` 等能力；私聊与飞书群公开话题及其后台子任务均获得完整设备、能力、记忆与工具上下文；放开设备节点绝对路径、`~` 路径、系统/代理环境变量与 110 秒命令执行上限（保持 30 秒接单租约兼容 `device_calls` 约束 + 120 秒执行截止时间）；放开跨助手记忆文档、用户主题、例行任务、后台任务与 CLI 会话发送限制；同步更新 Web、Android 与 Apple 客户端默认模式及标签。
  - 新增内置 `web.fetch` 工具（HTTP/HTTPS、重定向跟随、30s 超时、2MB 响应上限与轻量 HTML 文本提取），支持助手直接读取公开网页与 GitHub Releases/API（同步注册到 Core / Web / Apple 图标与文案）。
  - 修复后台任务对话（`JobChat`）三项问题并增强操作展示：按 `task_id` 合并去重 `job.report` 与终轮回复消除重复双气泡；剥离 `用户在主对话中说（message:...）：` 与 `主对话备注：` 内部包装文案；防止后台直发消息被重复引用转交；过滤内部回报计数并将「N 项操作」改为可点击展开列表（同步更新 Apple `JobViews.swift` / `Entities.swift`）。
- `663d0801`：修复 Windows 客户端点击立即更新时 PowerShell 静默退出的问题。
- `9cc7a2dd`：打通 NexAgent ZCode 会话发现、新建恢复与双向对话（含 Web / Apple 端同步）。

## 构建与校验

- **静态检查与主分支 CI**：
  - 构建提交 `54f96e01` 通过本机 pre-push 静态检查（`pnpm lint` 0 warning/0 error、`pnpm typecheck` 通过、`pnpm i18n:check` 通过），[Docker 镜像构建 `46011546537`](https://github.com/DarrenHoo-10/nex_bot/actions/runs/46011546537) 已通过；[主分支 CI `46011546479`](https://github.com/DarrenHoo-10/nex_bot/actions/runs/46011546479) 已触发排队（上轮提交 `516dc504` 的 CI `46006685400` 已跑通 2264/2269 项核心测试，剩余 5 项均已在 `54f96e01` 中修复）。
- **Windows 安装包（`0.9.62`）**：在 [GitHub Actions 隔离 Windows VM `46011615686`](https://github.com/DarrenHoo-10/nex_bot/actions/runs/46011615686) 基于 `54f96e01` 构建并完成 Setup 安装校验与安装后 20 项 `smoke-shell-login.mjs` 登录冒烟。
- **Android APK（`0.2.60` / `260`）**：本机 JDK 17 + Android SDK 36 基于 `54f96e01` 执行 `./gradlew --no-daemon :app:assembleDebug` 构建，`aapt2` 校验包名 `com.nexorai.nexbot.debug`、版本 `0.2.60 (260)`；`apksigner` 校验通过，调试证书 SHA-256 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b` 与 0.2.59 一致；确认 APK 内 `assets/workspace/assets/main-4H-moZO0.js` 与 `assets/workspace/assets/main-FacsFYBN.css` 包含 `web.fetch` 与 `job-chat-steps-wrap` 变更。
- **Mac / iPhone（`0.2.54` / `56`）**：在 Mac Air 独立临时克隆（`54f96e01`）与新建专用 iOS 模拟器完成 `release-preview.sh`（`RENDER_TESTS=false`）构建，随后删除临时目录与专用模拟器。挂载实际 DMG 核验 `CFBundleShortVersionString=0.2.54`、`CFBundleVersion=56`、`com.nexbot.mac`、`codesign --verify --deep --strict` 与内置执行器字节一致；解压实际 IPA 核验 `0.2.54 (56)`、`com.nexbot.ios` 及未签名状态。`swift test` 共执行 278 项 XCTest + 1 项 Swift Testing 全部通过。

## 安装包

| 安装包 | 字节 | SHA-256 |
| --- | ---: | --- |
| `NexBot-0.9.62-x64-Client-Setup.exe` | 149227860 | `65458d87fdc21918d883a5addeaad42626900e4200092130a661286c9d3e608a` |
| `nexbot-0.2.60-debug.apk` | 44157496 | `31a6fd51e173c32686d66e94a59ea7797efcb4d023f1415df7620a7806813675` |
| `NexBot-0.2.54-mac-arm64.dmg` | 111147284 | `4c11be9254b82be3da0ea7fe1b3519dffca9baeff4ebb47e699f8a6698d1b63f` |
| `NexBot-0.2.54-ios-unsigned.ipa` | 37633879 | `7ac3350483484939c74d5f0214793f6433bf0fd96b55e6de269c61e3faf418cc` |

## 生产部署与分发

- **Mac Air Core 部署**：基于 `main-4359e353-20261127` 暂存叠加 `main-54f96e01-20261127`；在全部 6 个工作区数据库的 SQLite `.backup` 副本上通过 `PRAGMA integrity_check`、`PRAGMA foreign_key_check` 与迁移版本核对（最高版本 61，无新增迁移），并由独立隔离候选 Core 验证全部路由与资源。在无活动任务时由 `nohup` 独立进程完成 `config`/`data` 备份（`~/nexbot/backups/main-54f96e01-20261127-pre`）及哈希核对、切换 `run-core.py` 并重启 `gui/<uid>/cn.nexorai.nexbot-core`，部署退出码 0、无回滚，6 个工作区业务表哈希切换前后一致。
- **公网 Core 核验**：从公网独立验证 `https://bot.nexorai.com.cn`：`/health` 返回 200，匿名访问 `/api/state`、`/api/cli-agents` 与 WebSocket `/api/cli-agents/stream` 均返回 401，首页 `nexbot-web-version` 为 `0.9.62`，首页及全部 12 个静态资源与构建产物字节一致。
- **GitHub 与 OSS 分发**：创建并公开预发布 `nexbot-v0.9.62-preview.1`（指向 `54f96e016e2cd8aa9e493408496d933db0a4cf35`），6 个附件（4 个安装包 + `SHA256SUMS.txt` + `SOURCE_COMMIT.txt`）大小与 SHA-256 均与本地文件一致。私有备份旧 OSS 清单至 `~/nexbot/backups/main-54f96e01-20261127-pre/client-manifest.json`，先 `--dry-run` 校对再上传读回校验全部 4 个安装包并写入新清单。
- **更新接口与官网主页核验**：公网 `/api/client/update` 对旧版本（Windows `0.9.61` NSIS、Android `0.2.59`、Mac `0.2.53`、iOS `0.2.53`）均返回对应新版本，当前版本均返回 `available: false`；完整下载四份返回安装包，字节数与 SHA-256 均与上表一致。无头 Electron 访问 `https://bot.nexorai.com.cn/#platforms` 核验四端渲染版本号与下载链接均同清单与 README 一致。

## 验证边界

- 未在实体 Android 手机或实体 iPhone 上手动安装操作。
- Apple 打包未开启渲染截图测试（`RENDER_TESTS=false`）。
- 未在本机覆盖安装 Windows 生产客户端，未向用户生产会话写入消息。
