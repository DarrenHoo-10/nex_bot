# AGY 回复渲染修复、可扩展 Harness 重构与过程耗时展示 · 0.9.58 四端预览版

生产 Core、网页、Windows 与 Android 安装包均来自主分支提交 `c77add601aeedfd0368d4f510806ae4d47ee5259`；Mac 与 iPhone 安装包来自紧随其后的主分支提交 `1904c4b092ce405a7dbf3f30a1495769876d3894`（仅在 Apple Swift `ToolStep` 补全 `createdAt` 属性，未改动其他平台代码）。功能提交为 `19819649` 与 `3c97da24`，发布前修正了 `agy-native.ts` 对 Go SQLite 空格分隔零时间戳的解析（V8 非 ISO 回退将其误判为 2001 年的问题）及 Apple `ToolStep.createdAt` 缺失。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.58-preview.1)

## 功能验收

- **AGY 回复渲染与空会话残影清理**：`server/personal-os/cli-agents-node/items.ts` 统一封装 wire 安全条目构造器与大小写无关参数摘要（支持 Claude/Codex 及 AGY 的 PascalCase 参数），超出 `SUMMARY_MAX` 的思维链与未知工具参数会被截断，避免整页历史被 `parseCliItems` 丢弃；`agy-native.ts` 规范化 Go 零时间戳并过滤无 transcript 且非运行中的 0 步空会话，`agy.ts` 在空闲收尾时自动清理 0 步残影；`search.ts` 纳入 AGY 会话搜索。`agy-native.test.ts`、`harness.test.ts` 与 `hub.test.ts` 等 5 个测试集共 81 项用例全部通过。
- **可扩展 CLI Harness 重构**：抽象 `HarnessAdapter`、`HarnessRegistry`、`HarnessDriver` 与 `harness-drivers.ts`，统一 Claude Code、Codex、ZCode、Antigravity CLI 的发现、读取、启动、搜索、模型与能力声明；`3c97da24` 补全 Antigravity 官方四色 SVG 图标并通过 `HarnessMark.test.ts` 校验。
- **慢启动超时与幂等保护**：延长 Android (`WorkspaceTransport.kt`) 与 Apple (`CoreClient.swift` / `CliAgentsClient.swift`) 对启动、续接和发送的请求超时；在 Core (`hub.ts`) 与节点执行器 (`bridge.ts`) 为 Worktree 新建会话增加 `requestId` 幂等保护，避免慢启动重试误建重复工作树与空会话。
- **过程耗时折叠与布局调整**：Web/Windows/Android（`MoreContent.tsx`、`TranscriptView.tsx`、`AgentDesktop.tsx`）与 Apple（`CliAgentLogic.swift`、`RoutineOccurrenceDetailView.swift`、`AgentSessionDetail.swift`、`MessageRow.swift`、`ConversationView.swift`）同步将「更多内容」改为紧凑的 `用时 X分钟 >`（无有效耗时时回退为「更多内容」）并移至助手标识下方，展开时箭头旋转。

## 构建和发布

| 安装包 | 版本 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| NexBot-0.9.58-x64-Client-Setup.exe | 0.9.58 | 149210721 | `ace157a1cfd24bc64434469d7f6e3f8a702bee88a8ff6a551d4da72e2bb81838` |
| nexbot-0.2.57-debug.apk | 0.2.57 (257) | 44152460 | `f950f438b684b82a88fe11818565b62d281e9b90ace7524987f26e09f22d09a2` |
| NexBot-0.2.50-mac-arm64.dmg | 0.2.50 (52) | 112144987 | `ddfb0db4f3c2ccabcd6c1a66cf523c047d6a2e2819654810f6eb74242833aad5` |
| NexBot-0.2.50-ios-unsigned.ipa | 0.2.50 (52) | 37609970 | `cd673f562daa2b892656ec34d10521c19392b5e0b0ccdf8bf60235e755d76028` |

- **Windows**：已通过 GitHub 隔离 Windows VM 的安装、非空目录拒绝、覆盖升级、快捷方式、单实例恢复与安装后登录冒烟，发布安装包哈希与工作流记录逐字节一致；同时本机打包产物 `win-unpacked\NexBot Client.exe` 通过 20 项 `smoke-shell-login.mjs` 验收。[Windows 验证](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45860410771)
- **Android**：`aapt2` 核验包名 `com.nexorai.nexbot.debug`、`versionName=0.2.57`、`versionCode=257`；`apksigner` 校验通过且证书 SHA-256（`af012179...9073cb4b`）与已发布 `0.2.56` 完全一致。本机 `:core:test`、`:app:testDebugUnitTest`、`:app:assembleDebug` 及 7 组 Core 协议夹具一致性检查全部通过。
- **Mac 与 iPhone**：在 Mac Air 上从已推送提交 `1904c4b0` 的干净克隆构建，使用独立临时模拟器（结束后已销毁模拟器与构建目录）。已挂载 DMG 核验 `CFBundleShortVersionString=0.2.50`、`CFBundleVersion=52`、`codesign --verify --deep --strict` 及内置执行器 `Contents/Resources/Executor/node`；已解压核验 IPA 版本、主二进制及未签名状态；`NexClientKit` 通过 277 项 XCTest 与 1 项 Swift Testing 测试。
- **Core 与网页**：本次无新增数据库迁移（保持迁移版本 61），在 Mac Air 对全部 6 个生产工作区的 SQLite `.backup` 副本核验 `PRAGMA integrity_check`、`PRAGMA foreign_key_check` 与迁移版本，并在隔离候选实例验证 API/WS 认证与静态资源。无活动任务时经 `nohup` 独立进程完成 `config` 与 `data` 备份、切换到 `main-c77add60-20261127` 与回滚保护，切换后 6 个工作区业务数据哈希无变动。本地及本机公网复验确认 `/health` 为 200、匿名 `/api/state`、`/api/cli-agents` 及 `/api/cli-agents/stream` 均为 401，公网首页 HTML 及全部 12 个静态资源与本地构建逐字节一致。
- **发布与官网核对**：GitHub 预览版 4 个安装包及 `SHA256SUMS.txt`、`SOURCE_COMMIT.txt` 全部核对字节数和 SHA-256。OSS 清单更新前已私有备份至 `~/nexbot/backups/main-c77add60-20261127-pre/client-manifest.json` 并执行 `--dry-run`，写入后读回校验通过。实时核验 `/api/client/update`：四端上一版本（`0.9.57` / `0.2.56` / `0.2.49` / `0.2.49`）均返回新版更新且实际下载字节与 SHA-256 全部一致，当前版本均无更新。使用无头 Electron 核验实时渲染的 [官网四端下载](https://bot.nexorai.com.cn/#platforms)，四端版本号、标签、链接及对应文件摘要均一致。

## 验证范围

- 仅在本机与隔离环境完成构建、包体、接口与自动化测试，未在实体 Android / iOS 手机上手动安装验证。
- Apple 端未执行 `RENDER_TESTS=true` UI 截图验收。
- 主分支推送后 CI（`45858895403` / `45860596935`）中的 `typecheck + lint` 已通过，Android 远端任务失败（与 0.9.57 相同，本机完整 Gradle 构建、测试与 7 组夹具校验已全部通过），`core tests` 持续执行中。
