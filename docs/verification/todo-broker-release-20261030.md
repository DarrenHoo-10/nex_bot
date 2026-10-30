# 模型待办与聊天状态条：全平台发布（2026-10-30）

版本：Windows 0.9.22、Android 0.2.21（221）、Mac/iOS 0.2.16（18）。
标签：`nexbot-v0.9.22-preview.1`。
Core、网页与四个安装包均来自已推送 main 的提交
`39a585051361e0abb72464b76a4bfad49cf591d3`。

## 变更

模型通过 `todo.list`、`todo.save` 直接读写面板待办，复用原有数据与权限；系统提示和工具声明明确区分待办与私有记忆。保存或分配给 AI 不自动执行。更新保留未传字段，要求当前版本；事务内记录调用收据，重复执行不重复创建或修改，删除的待办不会因重放恢复。

网页、Windows、Android、Mac 和 iOS 移除输入框上方的工作、发送和停止状态条，保留消息内进度及停止按钮。README 下载版本和主页功能介绍同步更新；四个平台的主页下载卡片继续读取共享清单。

发布前合入已上线的记忆主题提交 `604a5c47`，保留迁移 39–41，新增待办收据迁移改为 42。此前本地验证见[待办工具记录](todo-broker-20261030.md)。

## 验证

- `server/personal-os/todos.test.ts`、`server/personal-os/policy-defaults.test.ts`、`server/personal-os/topic-tree.test.ts`、`server/personal-os/topic-access.test.ts`、`src/personal/AgentDesktop.input.test.ts`：合并后 75 项通过。
- `src/personal/auth.navigation.test.ts`、`server/personal-os/client-updates.test.ts`：11 项通过。
- 前后端类型检查、全项目 lint、十种语言目录检查通过。Core/Web 生产构建通过，保留已有大 chunk 提示。
- 实际构建的 Core 在 Windows 和 Tokyo 隔离实例中验证模型 Broker 写入后可从面板接口读取、重启持久化、冲突检测、AI 执行防重，以及定时子任务隔离、删除、历史和结果汇报。
- Windows 精确 EXE 版本 0.9.22，通过 20 项单账号和 24 项账号工作区登录检查。
- Android 82 项测试通过；APK 版本 0.2.21 / 221，签名验证通过，与上一版 0.2.20 的证书一致：`af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`。
- Mac 从 GitHub 全新克隆已推送提交，专用 iPhone 模拟器；180 项 NexClientKit 测试通过，Mac/iOS 各 11 项渲染测试通过。Mac Release、iOS Simulator、iPhone Release 构建完成；DMG/IPA 版本 0.2.16 / 18，Mac 签名、包内容及传回文件哈希通过。专用模拟器与克隆目录已清理。

## Core 与数据

部署目录 `/data/nexbot/releases/main-39a58505-20261030`；前一版为 `main-e315cd3a-20261030`。新增最后排序的 systemd drop-in，部署脚本保留自动回滚。

六个生产库先以只读连接生成独立副本，通过实际构建的 Store 验证迁移 41 → 42。部署前和停机后重复确认无活动任务，备份数据、配置与 systemd 到 `/data/nexbot/backups/main-39a58505-20261030-pre`。停机迁移后原有表行哈希、原有迁移记录、数据文件与配置校验一致，新增收据表为空。仅排除生成型同步游标和每次打开会轮换的 desktop-owner 引导令牌/过期字段。

公网 `/health` 200，未登录 Todo 与其他受保护 API 返回 401；首页、七个构建资源及动态 HTML 预览与实际发布构建一致。生产仅做只读验证，没有发送测试任务。

## 安装包与发布

GitHub 预览版已发布，六个上传文件的大小和 SHA-256 均与本地一致。

OSS 已完成 dry-run、私有旧清单备份、四个安装包上传和读回校验。四个平台分别验证：旧版获得新版本、当前版本无更新、实际下载安装包的字节数与 SHA-256 一致。浏览器读取部署后的官网四张下载卡片，版本为 0.9.22 / 0.2.21 / 0.2.16 / 0.2.16，链接文件与发布包及 README 一致。

验证文档检查 7 项通过；同时补全主分支记忆主题记录中两处测试文件的目录路径。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.22-x64-Client-Portable.exe | 176219151 | `508f8d9f375b9d07bae9960cb1f1ac890ab962adb985af1768f65704f948e302` |
| nexbot-0.2.21-debug.apk | 19965419 | `71bd15b53f3b856a96e54b7a096592a54d810890a5fc022e86508253f3ef43c8` |
| NexBot-0.2.16-mac-arm64.dmg | 76865872 | `58029ffe550565fda23d671a7e2d41089aa4b908c97a20e83653eb2dd8b3989e` |
| NexBot-0.2.16-ios-unsigned.ipa | 11295020 | `6447adfa144728c20c2e3eec40480f57fdd993eade45d247bfd76f7eca568ef3` |

## 限制

Windows 无发布者签名；Android 为调试签名；Mac 临时签名、未公证；iOS 未签名，需自行签名安装。未做真实设备覆盖安装、生产负载或真实模型选工具质量测试；Apple 待办未做专门的原生全流程交互测试。私有记忆中的旧笔记不会自动导入待办。

原始构建、安装包、测试和校验日志保存在忽略的 `release/ship-0.9.22/`、`release/todo-broker-apple-evidence/`、`release/deployment-todo-broker/` 及 release 中对应的日志文件。
