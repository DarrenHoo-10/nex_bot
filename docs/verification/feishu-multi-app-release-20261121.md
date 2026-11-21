# 飞书多应用与按群回复设置 · 发布记录 — 2026-11-21

发布 `nexbot-v0.9.38-preview.1`，源码 `main` 的
[`eae7a894`](https://github.com/DarrenHoo-10/nex_bot/commit/eae7a8944c2d58d84d476d6ffde0667646dae539)
（功能提交 `b2cc1297` 加版本号提交，从 `52277179` 快进；pre-push 的 lint、typecheck、locale 检查通过）。
改动与本地验证见 [本地验证记录](feishu-multi-app-20261121.md)，上一版见 [0.9.37 发布记录](nexagent-desktop-sidebar-release-20261120.md)。

| 平台 | 版本 | 本次 |
| --- | --- | --- |
| Core / 网页 | `main-eae7a894-20261121` | 部署到 Mac Air；加法式表结构变更（`feishu_group_settings` 与三处新列） |
| Windows x64 | 0.9.38 | 新发布 |
| Android | 0.2.37 (237) | 新发布 |
| Mac / iPhone | 0.2.29 (31) | 新发布 |

## 证据

- **构建来源**：从 `git worktree add --detach eae7a894` 的干净工作区构建 Core、网页、Windows 和 Android；Apple 在 Mac 上从全新 `git clone` 检出同一提交构建。
- **迁移演练**：在 Mac Air 上用 SQLite `.backup` 复制全部 6 个工作区数据库，以候选版本的 store 与 `ensureFeishuDeliverySchema` 打开并重复执行两次；新表与新列齐全，业务表与飞书表（应用、消息、目的地、话题别名、订阅）哈希不变；副本已删除。
- **候选检查**：Mac Air 隔离临时 Core（合成数据）通过原有检查，并确认 `/api/feishu/groups` 未登录 401、未知应用 400、保存未知应用的群 400、新表存在。
- **部署**：无进行中任务时切换；备份 `~/nexbot/backups/main-eae7a894-20261121-pre`（含切换前的客户端更新清单），6 个工作区业务哈希一致；本机与公网 13 个资源与构建逐字节一致。从本机独立复核 `/health` 200、未鉴权 401、经中继的流 401、`/api/feishu/groups` 未鉴权 401。
- **Windows**：`NexBot-0.9.38-x64-Client-Portable.exe`（203,712,364 B，SHA-256 `86572de4…19e2c7`，ProductVersion 0.9.38）在临时 LOCALAPPDATA/APPDATA 下登录冒烟 20 项通过，冒烟留下的 herdr-core 已结束（未动用户正在运行的 0.9.37）。
- **Android**：`nexbot-0.2.37-debug.apk`（44,054,381 B，SHA-256 `29c16526…b4d807`，versionCode 237），单元测试 94 项 0 失败，调试证书与已发布版本相同（`af012179…cb4b`）。
- **Mac / iPhone**：`NexBot-0.2.29-mac-arm64.dmg`（108,679,930 B，SHA-256 `fe04f39b…053bbb`，临时签名，含执行器）、`NexBot-0.2.29-ios-unsigned.ipa`（36,613,085 B，SHA-256 `2fdc69da…786acf`，未签名），版本 0.2.29 (31)；NexClientKit `swift test` 255 项、Mac 与 iOS 渲染测试各 15 项通过；专用模拟器与克隆目录已删除。
- **发布**：GitHub 六个资产大小与 SHA-256 与本地一致；OSS 上传回读校验；`/api/client/update` 对 0.9.37、0.2.36、0.2.28（Mac、iOS）提供新版，对新版本不再提供，四个安装包下载字节与清单一致。
- **主页与 README**：线上主页四张下载卡的版本、链接、大小、SHA-256 与发布文件一致，发布说明链接指向 `nexbot-v0.9.38-preview.1`；README 下载表同步为本次发布。

## 限制

- 尚未用真实飞书应用验收多应用、群列表与各回复模式；群信息字段按开放平台文档实现。
- Apple 端聊天里，除金融助手外，其他接收飞书的助手还不显示飞书话题卡片；Mac / iPhone 设置界面未在设备上实际操作。
- 共享的金融助手应用暂不支持按群设置。均未在实体手机上安装测试。
