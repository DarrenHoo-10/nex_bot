# 待办默认当天、模型完成与输入框修复：发布记录

已构建并发布：Windows 0.9.26、Android 0.2.25（225）、Mac/iOS 0.2.19（21）。
标签：`nexbot-v0.9.26-preview.1`。

- 未指定日期的待办默认当天，并进入日、周、月日历；旧空日期读取时映射当天，未改变其存储与版本。新事项保存明确日期，之后不会自动顺延。
- 模型用 `todo.save(status=done|todo)` 完成或重新打开已有待办，保留版本、作用域、执行中保护及重放收据。
- 聊天输入框不再出现内层粗聚焦边框；Web/Windows/Android 与 Apple 同步。
- 保留最新主分支的五个头像、任务状态动作及 Android 资源修复。

本地实现证据：[待办日期与输入框](todo-default-date-20261101.md)、[模型完成](todo-completion-20261101.md)。

发布准备的隔离回归：待办、工具目录、日历、更新接口、主页导航与文档引用共 42 项通过。
文档引用检查首次发现一处测试路径缺少目录，修正文档后 7 项复跑通过。

## 来源与部署

源码提交 `9b60e4e205c3cbdce0a931671e8d3c7f21cdc032` 已合入并推送 `main`；Core、Web 和所有安装包均来自此提交。推送前全项目 lint、前后端 TypeScript、十种语言目录校验通过。

东京运行目录 `/data/nexbot/releases/main-9b60e4e2-20261101`，前版 `main-d24f0aec-20261101`。部署前用候选实际 Core 和合成模型验证默认当天、标完成、删除、版本冲突、防重复执行及重启持久化。六个生产库先作只读一致副本并验证 schema 42 和逐表行哈希；未对原库启动测试运行时。

切换前后均确认无活动任务。停机备份数据、配置及 systemd 设置，新增排序最后的 drop-in，保留自动回滚。全库记录哈希、非数据库文件哈希和配置哈希检查通过；备份保留于 `/data/nexbot/backups/main-9b60e4e2-20261101-pre`。公网 `/health` 200、未认证 API 401，HTML、三个入口资源及全部七个构建资源逐字节一致。

## 安装包

- Windows 精确 EXE：20 项单工作区及 24 项账号工作区检查通过，均使用隔离合成账户。
- Android：53 Core + 29 App 单元测试通过；APK 0.2.25 / 225，`apksigner` 验证证书与前版一致：`af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`。初次构建进程使用了机器默认 Java 8，改用现有 JDK 17 后成功；未改变系统设置。
- Apple：从 GitHub 全新克隆已推送提交，184 NexClientKit 测试通过；Mac Release、iOS Simulator Debug 和 iPhone Release 构建成功，Mac/iOS 渲染各 12 项通过。使用独立 iPhone 16 / iOS 18.6 模拟器；克隆与模拟器已删除。
- 精确 DMG 挂载验证 0.2.19 / 21、深度严格签名和内置 executor；IPA 版本、构建号及 bundle 检查通过，传回字节的哈希与 Mac 一致。

## 发布与边界

GitHub 预览标签 `nexbot-v0.9.26-preview.1` 指向构建提交。六个文件（四平台安装包、校验文件、来源提交）的大小和 GitHub SHA-256 digest 与本地一致。OSS 先私下保存旧清单，dry-run 后上传并读回四个平台文件，再更新共享清单。

README 和官网待办介绍同步更新；官网四个平台的下载仍消费同一份共享清单。Core 清单刷新后，旧版均获得新版本，当前版均无更新；从每个实际提供的下载 URL 读回文件，大小与 SHA-256 全部符合本地安装包。隔离 Chrome 访问已部署官网，确认 Windows 0.9.26、Android 0.2.25、Mac/iPhone 0.2.19 及实际下载链接一致，截图已目视检查。浏览器首次因旧清单和较短加载等待超时；清单刷新后延长页面加载等待复跑通过，未修改产品或重启服务。

Windows 无发布者签名；Android 调试签名；Mac 临时签名且未公证；iPhone IPA 未签名，需用户自行签名。未进行真机覆盖安装、原生待办完整交互、生产负载或真实模型工具选择质量测试。所有测试修改使用合成数据；生产账户没有收到测试任务。

原始日志、安装包与安全校验报告在本机忽略目录 `release/ship-0.9.26/` 和东京私有 staging/deploy 目录。


| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.2.19-ios-unsigned.ipa | 34699430 | `5f9042aeb09bba852768b1c3ea07c30c3f4bd8455dce964a6a343d3cff974cb5` |
| NexBot-0.2.19-mac-arm64.dmg | 101905811 | `f09ae6516db1b5567e90d91e07687c9b984cf3236b4280a73482a3b067b21b46` |
| nexbot-0.2.25-debug.apk | 43834285 | `f5215ef5d23e1946f3ed06a364a02f7b3d56cf391adabc7f6b5b10cf547cab64` |
| NexBot-0.9.26-x64-Client-Portable.exe | 199598825 | `429dbe81d3386a0c474871d05ff5f695154ecda1b5e0cb9058011ab09bdef2ad` |
