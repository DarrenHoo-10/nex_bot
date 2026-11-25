# NexAgent 输入框模型显示、Codex 新建会话修复与 0.9.50 预览发布（2026-11-25）

部署和安装包来自已推送到 `main` 的 `05821e9d7559e4ff9c788b769b9886b0be00c46f`。[预览发行与校验文件](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.50-preview.1)

| 平台 | 版本 |
|---|---|
| Core / Web | `main-05821e9d-20261125` |
| Windows x64 | 0.9.50 |
| Android | 0.2.49（249） |
| Mac（Apple 芯片） | 0.2.42（44） |
| iPhone | 0.2.42（44） |

## 改动

- NexAgent 输入框在上下文圆环左侧显示当前模型，单行、限宽、超出截断；手机布局只显示模型名，「+」菜单不再列「模型」。iOS 用按钮打开模型面板，macOS 用菜单选择模型。
- 输入框的「+」菜单、上下文详情和注释等弹层，按下弹层及其按钮以外的位置（包括输入框）即收起；后台任务列表补上点外部收起；排队消息图标的提示只在可悬停的设备上随悬停显示。
- 上下文用量改用 K / M 显示（Web 复用 `formatCompactTokens`，Apple 复用 `Usage.compactTokens`）。窗口数值仍取 Codex 记录的 `model_context_window`：gpt-6.2-sol 为 500,000 × 95% = 475,000，gpt-6.2-astra 为 272,000 × 95% = 258,400。
- 执行端启动 Codex 终端时追加 `-c check_for_update_on_startup=false`。此前 Codex 0.163 在新建会话时停在「Update available」菜单（这台电脑上的 t8、t9、t11、t12），12:27 的一次新建在菜单上收到回车后执行了安装脚本并退出（t15）。

## 候选构建和生产部署

- 合并后的树在推送前通过 lint、类型和语言目录检查（Mac 上推送，pre-push 钩子执行）。
- Codex 参数在 Codex 0.172 上用临时 `CODEX_HOME`（缓存的最新版本设为 9.9.9）对照：不带参数显示更新提示，带参数直接进入会话。
- 独立候选 Core 通过健康、鉴权、有界历史和实时文字检查，schema 仍为 58，13 个资源与构建一致。生产空闲时完成切换与备份，6 个工作区业务数据哈希及配置一致。公网健康检查为 200，受保护 API 的匿名请求为 401；从 Windows 独立下载的首页 HTML 及其引用资源与发布目录逐字节一致。
- Windows 便携发行包通过 20 项隔离登录检查；包内执行端含新的 Codex 启动参数，界面资源含新的模型按钮样式。Android APK 已核对版本、构建号及与 0.2.48 相同的调试签名（`af0121…cb4b`）。
- Apple：NexClientKit 272 项 XCTest 通过（含改为 K/M 的 `testContextUsage`），Mac、iOS 发行构建成功。核对 DMG 完整性与临时签名，核对 IPA 的版本、构建号、包内容和未签名状态。

## 下载与更新

- GitHub 预览版标签指向构建提交。四个安装包和两个校验文件的大小、SHA-256 与本地一致。
- 发布清单更新前保存了上一版（Core 主机 `backups/main-05821e9d-20261125-pre/client-manifest.json`）。OSS 上传回读校验通过，公网 Core 刷新清单后四个平台更新接口均向旧版本提供新版、向新版返回无更新，从接口实际下载的安装包大小和 SHA-256 一致。
- README 下载与安装说明已更新。实际渲染的官网四端版本、下载链接、大小和 SHA-256 与公开清单及本次发布一致。[官网下载区](https://bot.nexorai.com.cn/#platforms)

## 验证范围

- 构建提交的 [CI](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45556050459) 中 core tests 有 5 项失败，均为测试问题：`launch.test.ts` 两处 `planLaunch` 断言未加新的 Codex 参数；`Composer.test.ts` 新增用例缺少 happy-dom 的 popover 桩；`CliAgentsWorkspace.test.ts` 的排队引导断言未随 `bd35d66d` 加上 `{ questionId }` 参数（此项在 `983141c9` 已失败）。修复后这三个文件 103 项本地通过，随本记录提交。Kotlin 任务因 Maven Central 返回 429 下载 Robolectric 失败，与代码无关。
- 界面效果未在实体手机上查看。Apple 渲染测试按惯例跳过，macOS 模型菜单未手动操作。
