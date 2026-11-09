# 助手「工作」页只保留定时任务：全平台发布记录（2026-11-09）

已发布 [nexbot-v0.9.31-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.31-preview.1)：Windows 0.9.31、Android 0.2.30（230）、Mac / iOS 0.2.24（26）。Core、网页和主页在同一次部署中上线。

## 改动

助手详情的「工作」页去掉了「正在处理」「后台任务」和「最近动态」（Mac / iOS 上叫「最近结果」），只留预览卡片和定时任务。对应入口：

- 停止助手的工作：输入框的停止按钮。
- 后台任务：聊天里的任务卡片，或聊天顶部的「N 项后台任务」。
- 定时任务的最近结果：定时任务行的「查看最近结果」。
- 移除了「继续」按钮。它只用于继续运行意外中断、被暂停的任务；现在需要停止后重新发送。

只被这几块使用的组件和样式一并删除：网页的 `.job-row`、`.routine-history`，Apple 的 `JobFlowRow`、`RecentRun`、`RunEntryRow`、`DayLabel`，以及对应的渲染测试。

提交：功能 `bce03146`，版本号、README 与主页 `7a26cdae`。全部构建都来自 `7a26cdae`。

## 验证

- **Web**：网页测试 3727 项通过；另有 2 项依赖机器语言设置的失败，与之前相同。typecheck 和 lint 通过。用测试数据在本地预览中查看，「工作」页只剩「定时任务」，「3 项后台任务」按钮和任务卡片仍在。
- **Core 部署（Tokyo）**：
  - `main-7a26cdae-20261109`，上一版 `main-3a524f51-20261108`，备份 `/data/nexbot/backups/main-7a26cdae-20261109-pre`，drop-in `…-inspector-release.conf`（50 个 `z`）。
  - 候选版通过 `verify.mjs`。6 个账户库只读副本校验通过（schema 46，无迁移）。
  - 停机部署后，记录哈希、配置哈希、`/health`、401、HTML 和资源逐字节比对全部通过；本机另对公网复核，通过。
- **Windows**：精确 EXE 隔离检查 20+24 项。第一次构建时拉取 models.dev 被重置，经本机代理重试成功。
- **Android**：82 项单元测试，证书与已发布版本相同（`af012179…cb4b`）。
- **Apple**：发布前在 Mac 上用干净副本加改动构建：两个应用构建通过，186 项单元测试、Mac 和 iOS 各 15 项渲染测试通过。正式包从干净克隆构建：186 项单元测试、三个目标构建、渲染测试通过；DMG 签名、版本检查通过，IPA 版本与包内容检查通过。临时模拟器和目录已删除。
- **GitHub**：6 个资源的大小和 digest 与本地一致。
- **OSS 与更新**：旧清单（0.9.30 / 0.2.29 / 0.2.23）私密备份到 `/data/nexbot/backups/main-7a26cdae-20261109-pre/previous-manifest.json`。上传并更新清单后，旧版本客户端会收到新版本，新版本不再提示更新；4 个下载与本地文件一致。
- **主页**：无头 Chrome 打开公网主页，0.9.31 发布链接存在；4 个平台的版本、链接、大小和哈希都与已发布安装包一致。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.31-x64-Client-Portable.exe | 199608628 | `c23fd3593552426d2db6c78995b69c2f2b8ddcc87b3eccaad1b136a8d0d5f8a4` |
| nexbot-0.2.30-debug.apk | 43845537 | `a4b3384ebb8b84a7221a8ad4b6b3cec3bd558896f24cfc8d74dac2e8c4315ae3` |
| NexBot-0.2.24-mac-arm64.dmg | 102475652 | `fe274bb0844074b56453b6a28b95e53b8d7a4fda83cb1f325a537961d382221d` |
| NexBot-0.2.24-ios-unsigned.ipa | 34905241 | `4fc704d826906bb6fcaa25ef3cd39bb9b58761ef50451f45937735d00db87d3c` |

## 限制

- Mac / iOS 界面未截图，也未手动操作。
- Windows 打包后的界面只做了登录流程检查，没有逐页查看「工作」页。
