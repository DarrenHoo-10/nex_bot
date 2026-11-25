# NexAgent 引导消息与 Windows 安装向导 · 0.9.52 预览版

四端安装包和生产 Core 构建自已推送的主分支提交 `c02290e195de41d8496eeb39ecf9d3e3644b03de`。[预览版与校验文件](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.52-preview.1)

| 工件 | 版本 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| Windows x64 Setup | 0.9.52 | 149119615 | `ba7fcab6d5d6c9e81153eec344d3054823366f71d5d846118a8bd93dff665e01` |
| Android APK | 0.2.51 (251) | 44111029 | `70a0538f86a16dcab597d266ea7d1f905a8b9eb5a0fdcfe075eea217a7a93ffb` |
| macOS arm64 DMG | 0.2.44 (46) | 110532850 | `322109d24a0fd630603ca6a9e3183a172593846c43c79bb1fb3336b66edcc4ba` |
| iPhone IPA | 0.2.44 (46) | 37394373 | `b5fd1d701f56f9a160fb452f42b3c6e61dbe592da9e7582acd36e71f2748b8cc` |

## 安装包与服务验收

- Windows 在一次性虚拟机中从上述提交构建 Setup。验证了非空目录保护、自选安装目录、开始菜单和桌面快捷方式、卸载登记、覆盖安装保留路径及配置，以及最小化后再次启动恢复原窗口。用实际安装的可执行文件通过 20 项登录检查。发布前比对了 Actions 工件 ZIP 的 SHA-256，再提取其中通过验收的 EXE。[Windows 验收日志](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45656006652)
- Android 从 APK 读取包名、版本和构建号，使用 `apksigner verify` 验证签名，证书与 0.2.50 一致。
- Apple 原生界面补齐了队列的暂停原因字段。macOS、iOS 专用模拟器及 iPhone Release 构建成功。挂载实际 DMG 核对版本、签名和设备执行器，解包 IPA 核对版本、可执行文件和未签名状态。验收后已清理专用模拟器和临时源码。手机端验证限于构建及工件检查，未在实体手机安装。
- Core 在 6 份 SQLite 在线备份副本上预演迁移 59，隔离候选通过后于空闲时切换。生产已备份配置和数据，切换后 6 个工作区业务数据校验一致。内外网健康接口返回 200，受保护接口对匿名请求返回 401，首页 HTML 和 13 个静态文件与候选一致。

## 发布与更新

- GitHub 预览版的四个安装包、校验清单和源码提交文件均已核对大小与摘要。OSS 发布前已备份原清单，试运行后上传并逐一回读校验。
- 从公网更新接口检查四端，上一版本获得对应安装包，当前版本不再提示更新。逐个下载接口返回的文件，字节数和 SHA-256 与上表一致。Windows 安装版使用 NSIS 更新通道，0.9.51 便携版用户需手动运行一次 Setup。
- 用浏览器打开生产官网，从实际渲染的四个平台下载入口核对版本和下载文件。四个文件的字节数与 SHA-256 均与上表一致。
- 本地 Android 单测通过。GitHub 初次下载 Robolectric 依赖遇到 Maven Central 限流，在发布标签上重跑后 Kotlin、Android 应用测试、APK 构建和 Core 通信样例校验均通过。[发布标签 CI](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45658834362)
