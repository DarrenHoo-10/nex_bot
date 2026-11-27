# Codex 手机原生队列 · 0.9.60 发布验收

构建提交：已推送到 `main` 的 `27bd7b79219bd22243856e52183da882d4764946`。[GitHub 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.60-preview.1) · [官网下载](https://bot.nexorai.com.cn/#platforms) · [验收条件](codex-native-phone-queue.md)

这里验证手机聊天输入框的普通发送，不是远程终端键盘输入。电脑执行器对已确认支持该能力的 Codex 运行时，按受管终端的可执行文件、原生 thread UUID 及 `CODEX_HOME` 调用队列命令，不传 `--resume`。队列收件不等于开始推理，真正的审批仍然有效。旧失败条目不会自动重放。

## 在真实 Codex 终端完成收发往返

独立临时用户目录、隔离 Core、本机回环模型服务与真实 Windows Codex CLI 0.172.0（ConPTY）。先用 0.9.59 安装包的执行器启动 `--no-daemon` 会话并结束一轮，再换成实际 0.9.60 安装包内的执行器；旧终端、草稿和 thread ID 不换。没有使用用户的账号、草稿、模型服务或生产会话。以下每例都有手机侧读到的回复、同一线程新增的用户消息数，以及回环模型调用计数。

| 场景 | 结果 |
| --- | --- |
| 旧终端留有不同的本地草稿；手机发中文多行并重放同一请求 ID | 约 7.1 秒收到回复，原线程只有一条该消息、一次模型调用，草稿保持原样。 |
| 手机文本恰好与电脑草稿相同 | 约 10.0 秒收到回复；只处理一次，电脑草稿仍然保留。 |
| 打开 Codex 警告详情页并保留草稿 | 约 10.0 秒收到回复；原线程只处理一次，警告详情页和草稿均保持原样。 |
| 新会话首条手机消息 | 约 10.4 秒在新建的同一线程收到一次回复，无额外线程。 |

四例的首次回执都是 `nativeQueued: true, started: false`，而非模拟一个已执行的回合。耗时为本机回环夹具观测，不代表线上模型响应速度。

**从 APK 的真实界面点击发送**：另取本次 APK 中未修改的工作区 JS/CSS，在 412×892 的触屏 Chromium 中点一次「发送」，通过模拟的 Android 原生 MessagePort 访问真实隔离 Core 和设备。只发出一次 `/send`，同一旧会话新增一条用户消息、一次模型调用；回复出现在这个界面，控制台无错误。Codex 的警告详情页仍打开，原始草稿未变。这里没有在实体安卓手机上安装实测，不能把该项记为物理设备验收。

## 构建与回归

- [主分支 CI](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45980658293) 全部通过：类型/lint、核心链路、Kotlin 测试与 Android 协议夹具。推送前按约定仅做 lint、TypeScript、10 个语言目录静态检查。隔离配置下的六组队列、设备、Core、协议与 Web/Android UI 用例共 252 项通过。
- [Windows 安装包](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45980778008)：隔离 Windows VM 检查实际 Setup 安装、非空目录拒绝、重装保留配置、快捷方式、单实例及安装后 20 项登录冒烟。Setup 内设备执行器 SHA-256 为 `5882eba63920d902369284ba5b9121945665b4d5171a66ea2f1bf21436602e75`。
- Apple 使用独立临时克隆及专用 iOS 模拟器，Mac 与 iPhone 均为 `0.2.52 (54)`。挂载实际 DMG 验证 `codesign --verify --deep --strict`、版本、包 ID 和执行器；实际 IPA 版本、未签名状态与回执代码均已核对。278 项 XCTest 和 1 项 Swift Testing 通过。没有启用 UI 渲染测试，也没有在实体 iPhone 安装。
- Android 实际 APK 包名 `com.nexorai.nexbot.debug`，`0.2.58 (258)`，`apksigner` 校验通过；证书 SHA-256 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b` 与上一版一致。已在 APK 的工作区 JS 中查到原生队列收件状态。

## 安装包

| 安装包 | 字节 | SHA-256 |
| --- | ---: | --- |
| `NexBot-0.9.60-x64-Client-Setup.exe` | 149211945 | `46709d1e24361998f280a6739888724083b2615f276f284c930ab37cad1d6bbf` |
| `nexbot-0.2.58-debug.apk` | 44152644 | `b6e8f2640107df0bafb73724ad4d76778837a8b63bbe4719b9f7aa80d4fbbdb3` |
| `NexBot-0.2.52-mac-arm64.dmg` | 112119072 | `39b10e0bf07b7e14b130c42b94cacf70852306edd1cf2df34c41cc657886263d` |
| `NexBot-0.2.52-ios-unsigned.ipa` | 37611583 | `db819b28587f981bad6688190527b63166bfb923c9f8ba9b8cdd95d7822d76f2` |

## 生产与分发

- Mac Air 在全部 6 个工作区的 SQLite `.backup` 副本上检查完整性、外键和最大迁移版本 61；无新增迁移。隔离候选 Core 通过后，待真实 Codex 收发门槛满足、无活动任务时，由 `nohup` 独立进程备份配置和全部数据、切换到 `main-27bd7b79-20261127` 并核对业务数据哈希（包含 outbox）。部署退出码 0，无回滚。公网 `/health` 为 200，匿名状态、CLI 列表、WS 流均为 401。首页与 12 个静态资源均同构建一致。
- GitHub 草稿、公开预览版的四个安装包与两份证明文件大小和 SHA-256 均与本地文件一致；标签指向构建提交。私有备份旧 OSS 更新清单，先 dry-run，再上传读回核验每个安装包。实际写入的清单与 dry-run 一致。
- 从实际公网更新接口分别用 Windows `0.9.59`（NSIS）、Android `0.2.57`、Mac `0.2.51`、iOS `0.2.50` 获取更新；当前版本均无更新。完整下载四份返回的安装包，字节数与 SHA-256 同表中记录。无头浏览器核对了官网真实渲染的各版本与链接，并与 README 和 GitHub 文件逐项比对。
- 本机 Windows 从 `0.9.59` 覆盖安装到 `0.9.60` 并正常重启。新进程的主窗口响应、文件版本和注册版本一致，安装后的执行器哈希与上述真实收发验收使用的包体一致。未往用户生产会话写入消息。

