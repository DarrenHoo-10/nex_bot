# 双品牌界面重构、悬浮动作岛与桌面托盘 · 0.9.53 四端预览发布

四端安装包和生产 Core 构建自已推送的主分支提交 `09104cc9c10845ab8576ff072375029d2ff69527`。[预览版与校验文件](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.53-preview.1)

| 工件 | 版本 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| Windows x64 Setup | 0.9.53 | 149137692 | `1366c1d7f300f89f1b27b1c1970c1095c3a602b2823f8bb37f5f1e57c36779da` |
| Android APK | 0.2.52 (252) | 44143288 | `ef77ebd0a5fe5d031902c3c96ffd551c3ba6bb06c9809201fd911a595a6e52bb` |
| macOS arm64 DMG | 0.2.45 (47) | 111335090 | `52a84542910a82d5bff2b34b24e6f9df58bccb42299fff8232d7929f9616da00` |
| iPhone IPA | 0.2.45 (47) | 37455768 | `806622d34a9fb2fd288bc29621a9bfea01e37759bf41b1e62d30e91a61d1493e` |

## 变更概要

- **Web / Windows / Android 共享 UI**：完成 NexBot 亮蓝与 NexAgent 翡翠青绿双品牌视觉体系、设置中心 6 个面板与深浅色对比度打磨；将权限审批与提问卡片重构为位于消息流下方的悬浮毛玻璃动作岛（去掉「查看完整参数」，单选/多选/连续多题均支持「其他」自定义输入，终态收起为居中状态药丸）；升级工具调用为 Codex 风格无框时间轴与 `Shell` 代码卡；精简输入框与菜单中的冗余提示文案（按用户要求保留长期记忆中「开启后会增加 Token 消耗。」提示）。
- **Windows Electron 桌面端**：新增系统托盘管理（`electron/nex-client-tray.mjs`），关闭窗口默认最小化到系统托盘，托盘菜单提供「打开 NexBot / 暂停或恢复本机控制 / 退出 NexBot」，再次启动或点击托盘自动恢复窗口与任务栏图标，补充 `will-attach-webview` 禁止挂载保护。
- **Apple macOS / iOS 原生 SwiftUI**：同步亮蓝 / 翡翠青绿双品牌色板、Codex 风格无框工具时间轴以及位于消息流下方的悬浮毛玻璃审批/提问动作岛（含 `CliRequestStore`「其他」自定义输入逻辑与单元测试），同步清理冗余提示文案。

## 安装包与服务验收

- **静态检查与单元测试**：合并到 `main` 后通过 `oxlint --deny-warnings`（0 warnings / 0 errors）、`tsc -b && tsc -p tsconfig.server.json` 及 10 语言词库校验；本地通过 `src/personal/` 全部 42 个测试文件（457 项）及 `server/personal-os/nex-client-tray.test.ts`（2 项）。
- **Windows**：在一次性 GitHub Windows 虚拟机中从 `09104cc9` 构建并完成全量验收（[Windows 验收日志](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45665429973)），通过非空目录保护、自选安装目录、开始菜单与桌面快捷方式、卸载登记、覆盖安装保留路径与配置、最小化恢复、`--quit` 退出及实际安装可执行文件的 20 项登录/控制链路冒烟；拉取工件后与日志 SHA-256 逐字节一致。
- **Android**：基于 `09104cc9` 以 JDK 17 / SDK 36 构建 `nexbot-0.2.52-debug.apk`，经 `aapt2 dump badging` 核对包名 `com.nexorai.nexbot.debug`、版本 `0.2.52`（`252`），经 `apksigner verify --print-certs` 验证签名证书 SHA-256（`af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`）与已发布的 `0.2.51` 完全一致，支持无缝覆盖升级。
- **macOS / iOS**：在 Mac Air 独立临时目录克隆 `09104cc9` 并创建专用 iOS 模拟器，通过 `NexClientKit` Swift 单元测试、macOS Release / iOS Simulator / iPhone Release 编译；挂载实际 DMG 核对版本 `0.2.45 (47)`、`codesign --verify --deep --strict` 与内嵌 `Executor/node`，解包 IPA 核对版本 `0.2.45 (47)`、主二进制与未签名状态；验收结束后已清理临时克隆目录与专用模拟器。
- **Core 与 Web UI 生产部署**：在 Mac Air 对 6 份工作区 `core.db` 拍摄 SQLite `.backup` 副本核对 `PRAGMA quick_check = ok` 与 schema 59 一致性，通过独立合成数据候选 Core 验证后，在全工作区零活动任务时经 detached `nohup` 完成配置与数据全量备份（`~/nexbot/backups/main-09104cc9-20261126-pre`）及切换。切换前后 6 个工作区业务表哈希一致，内外网 `/health` 返回 200、`/api/state` 与 `/api/cli-agents` 及匿名 WebSocket 升级返回 401，公网 `https://bot.nexorai.com.cn` 首页 HTML 与全部 12 项静态资产与本地构建逐字节一致。

## 发布、更新与官网核对

- GitHub 预发布 `nexbot-v0.9.53-preview.1` 上传的 4 个安装包、`SHA256SUMS.txt`、`SOURCE_COMMIT.txt` 全部核对大小与 SHA-256 摘要一致。
- OSS 发布前已私有备份原 `manifest.json`（`~/nexbot/backups/manifest-0953-pre/manifest.json`），经 `--dry-run` 预演后上传并逐一回读校验更新清单。
- 公网更新接口 `/api/client/update` 核对全部四端（Windows NSIS `0.9.52 → 0.9.53`、Android `0.2.51 → 0.2.52`、macOS `0.2.44 → 0.2.45`、iOS `0.2.44 → 0.2.45`）：旧版均获得新版本与匹配大小/摘要，当前版本返回 `available: false`，实际下载全部 4 份安装包核对字节数与 SHA-256 均一致。
- 通过无头 Electron 加载生产官网 `https://bot.nexorai.com.cn/#platforms`，核对实际渲染的四端下载卡片版本号、下载链接与「0.9.53 预览版发布说明」链接均与本次发布工件逐字节一致。

## 验证限制

- Android APK 与 iPhone IPA 仅完成构建、包体元信息与签名核对，未在实体手机上执行真机安装与触控回归。
- macOS / iOS 渲染截图套件未在本次发布脚本中启用（`RENDER_TESTS=false`）。
- 推送 `09104cc9` 后的 `Docker image` 工作流（Run `45665262209`）与 `Verify NexBot Windows Setup`（Run `45665429973`）已通过；主 `CI` 工作流（Run `45665262303`）因前序任务排队仍处于 `pending` 状态，需在完成后复核。
