# 待办删除与工具按需查询：全平台发布（2026-10-31）

版本：Windows 0.9.23、Android 0.2.22（222）、Mac/iOS 0.2.17（19）。
标签：`nexbot-v0.9.23-preview.1`。
Core、网页和四个客户端安装包均从已推送 main 的
`9dd23fe0d325798c565c8df988584e15b7287a30` 构建。

## 变更

- 模型可用 `todo.delete` 删除用户指定的面板事项，复用权限、版本冲突、执行中保护和软删除；同事务收据保证重放不会重复操作。
- 默认日视角，未安排事项自动展开；只有未安排事项时不保留空白日列表，计数包含这些事项。Apple 同步默认日视角和展开状态。
- 常用工具（含待办）精简常驻，低频能力通过 `tool.search` 按当前权限查询说明和参数结构。查询不授予额外权限，worker 保留参数类型校验。Web/Apple 同步工具目录和标签。
- README 下载版本、发布链接和官网待办介绍一起更新；官网四个平台的下载入口继续读取共享清单。

本地设计和回归详见[工具发现](tool-discovery-20261030.md)、[待办删除](todo-delete-20261030.md)和[待办交互](todos.md)。

## 验证

- 本地回归：`server/personal-os/tool-catalog.test.ts` 5 项，`server/personal-os/todos.test.ts`、`server/personal-os/html-render.test.ts`、`server/personal-os/policy-defaults.test.ts` 共 17 项，`server/personal-os/topic-access.test.ts` 19 项，`server/personal-os/app.test.ts` 44 项通过、1 项既有跳过。覆盖 OpenAI/Anthropic 查询后调用、授权变化、非法参数、删除收据重放、冲突和事务回滚。
- 发布前主分支类型检查、全项目 lint、十种语言目录检查通过。`src/personal/auth.navigation.test.ts` 和 `server/personal-os/client-updates.test.ts` 11 项通过；`scripts/testing/verification-docs.test.ts` 7 项通过。
- 实际 Core 构建在 Windows 和 Tokyo 隔离实例验证模型创建待办、查询删除工具、调用删除、重启持久化、版本冲突、AI 执行防重及定时子任务隔离。所有测试身份、消息和模型为合成数据。
- Windows 精确 EXE 通过 20 项单账号、24 项账号工作区检查。首次重新登录和账号切换分别出现 30 秒超时、页面为空；未修改产品或测试，分别单独复跑完整用例通过。保留首次失败和复跑日志。
- Android 82 项测试通过；APK 0.2.22 / 222，签名与上一版一致：`af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`。本机 Java Unix-domain 临时通信目录异常，通过仅构建进程设置 `jdk.net.unixdomain.tmpdir` 解决，未更改系统配置或产品代码。
- Apple 从 GitHub 全新克隆构建提交，专用 iPhone 模拟器；180 项 NexClientKit 单元测试、Mac/iOS 各 11 项渲染测试通过。Mac Release、iOS Simulator、iPhone Release 构建成功；挂载精确 DMG 验证版本、签名与 executor，IPA 版本和内容检查通过，传回文件哈希与 Mac 一致。专用模拟器和克隆目录已清理。

## Core 与数据

部署目录 `/data/nexbot/releases/main-9dd23fe0-20261031`，前一版 `main-39a58505-20261030`。
上线前和停机后重复确认没有活动任务；新增排序最后的 systemd drop-in，自动失败回滚保留。
数据和配置备份在 `/data/nexbot/backups/main-9dd23fe0-20261031-pre`。

六个生产库先以只读连接建立独立副本，使用候选 Store 打开核验。schema 保持 42，无新增迁移。
停机核验所有用户表行哈希、既有迁移记录、数据文件和配置一致；仅排除生成型同步游标，以及每次 Store 打开轮换的 desktop-owner 引导令牌和过期字段。

公网 `/health` 返回 200，未认证受保护 API 返回 401；HTML、三个入口引用资源、全部七个构建资源及动态 HTML 预览与发布构建逐字节一致。
生产仅做只读校验，没有向真实账户发送测试任务。

## 安装包和发布

GitHub 预览版六个文件的大小、SHA-256 和标签提交已与本地核对。
OSS 已完成 dry-run、私有旧清单备份、四个安装包上传及读回校验。四个平台均确认旧版获得新版更新提示、当前版不重复提示，实际下载字节数和 SHA-256 与本地一致。

官网发布的 HTML/JS 与本地构建逐字节一致，下载接口提供 0.9.23 / 0.2.22 / 0.2.17 / 0.2.17，对应文件名与 README 和 GitHub 发布一致。浏览器自动化在创建或读取标签页时连续超时（IAB、Chrome），未完成这一版官网实际渲染卡片的浏览器复核；不把接口核对等同于浏览器视觉核验。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.2.17-ios-unsigned.ipa | 11295678 | `94e93ae1e3aea6002b53f58461b8b024d63e5b1bcb920c4c87b1d8fd76784193` |
| NexBot-0.2.17-mac-arm64.dmg | 76869142 | `6241ba6d82c96cf2c61fc76827a61ecd583d391ae707613044a65395114202c6` |
| nexbot-0.2.22-debug.apk | 19965551 | `1046e62217515515ea3d16b9c8b39dd9924d6a63a527a94dbfb12c94cd6ae18c` |
| NexBot-0.9.23-x64-Client-Portable.exe | 176219298 | `36c775f338ab0024416d203a56209ae5d0abf580809bd59f73fbae472bf8a063` |

## 限制与证据

Windows 无发布者签名，Android 调试签名，Mac 临时签名且未公证，iOS 未签名需自行签名安装。
未进行真实设备覆盖安装、生产负载或真实模型选工具质量测试；Apple 待办未做专门的原生全流程交互测试。
Windows 两个首次失败遗留的隔离测试目录因自动审批阻止清理而保留，相关测试进程已停止，不影响用户数据和发布。

原始日志、安装包和安全校验报告保存在忽略的 `release/ship-0.9.23/`、`release/tool-discovery-apple-evidence/`、`release/deployment-discovery/` 及 `release/discovery-*`。
