# NexBot 0.9.48 预览发布（2026-11-25）

构建和部署来自已推送到 `main` 的 `c8e96f44bfbc2df3888722ba9cd974aa334c9300`，包含 `704ab2cc`、合入 Android 登录取消处理的 `5e0fd367` 和 Claude 提问卡修复 `ab13a5a4`。[GitHub 预览版与 SHA-256 清单](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.48-preview.1)

| 平台 | 版本 | 实际交付物 |
|---|---|---|
| Core / Web | Web 0.9.48 | Mac Air 上的生产 Core 和网页 |
| Windows x64 | 0.9.48 | NexBot-0.9.48-x64-Client-Portable.exe |
| Android | 0.2.47（247） | nexbot-0.2.47-debug.apk |
| Mac（Apple 芯片） | 0.2.40（42） | NexBot-0.2.40-mac-arm64.dmg |
| iPhone | 0.2.40（42） | NexBot-0.2.40-ios-unsigned.ipa |

## 移动端审批

使用本次发布的 APK 在专用 Android API 36 x86_64 模拟器上验收。iOS 使用同一提交构建的原生模拟器应用，运行在专用 iPhone 16 Pro（iOS 18.6、Xcode 16.4）。每端使用独立的临时 Core、合成账号和模拟绑定的电脑，均实际点击会话内卡片。

| 操作 | 两端的电脑回包和收尾 |
|---|---|
| 选择提问选项「拒绝」，再点「提交」 | 收到以原题为键、值为「拒绝」的答案，包内 `decision=allow` 表示提交已选答案。 |
| 第一张普通权限卡点「允许」 | 收到 `allow`。 |
| 第二张普通权限卡点「拒绝」 | 收到 `deny`。 |

两端每次操作后均核对卡片关闭和待处理数归零。iPhone IPA 单独核对了包内容、版本、构建号及未签名状态。审批验收环境为模拟器，实机安装和生产账号交互未覆盖。

## Core 与安装包

- 发布前 lint、类型检查和语言目录检查通过。NexAgent hook、协议与卡片相关的 108 项隔离测试通过，1 项跳过。Android 本地 Core 和 App 单元测试共 95 项通过，7 份协议夹具一致。Core 更新与关于界面共 14 项测试通过，Apple 更新逻辑共 3 项测试通过。
- 6 个 SQLite 在线备份副本从 schema 57 升到 58，业务表哈希一致。候选 Core 在临时目录单独启动并通过健康、鉴权和静态资源检查。
- 生产 Core 在空闲时切换。切换前备份数据与配置，切换后 6 个库的业务数据哈希一致、配置一致。公网 `/health` 为 200，受保护 API 匿名访问为 401。生产网页 HTML 和 13 个资源与候选构建逐字节一致。
- Windows 便携包通过 20 项隔离登录验证，无发布者签名。Android 的调试签名证书与 0.2.46 一致。Mac DMG 完整性及内含应用签名通过校验，应用使用临时签名。
- GitHub 安装包和校验文件的大小、SHA-256 与本地一致。OSS 先 dry-run，再上传、回读并校验四个资产，旧更新清单已私下备份。生产首页四端版本、下载链接和发布链接均与清单一致。四端上一版本均收到更新，新版本均返回无更新。实际下载的四份安装包大小与 SHA-256 均一致。升级提示以线上更新接口返回为准，未逐端操作旧安装包的更新弹窗。[生产首页下载区](https://bot.nexorai.com.cn/#platforms)

## CI

发布提交初次运行的静态检查和 Core 主链路通过。Android CI 的 Robolectric 依赖下载遇到 I/O 错误，复跑确认 Maven Central 返回 HTTP 429，已再次重跑 Android 作业。本地同提交的 Android 测试和夹具检查均通过。[发布提交的 CI](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45477690628)
