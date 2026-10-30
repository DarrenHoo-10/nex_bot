# 定时任务独立执行：全平台发布（2026-10-30）

版本：Windows 0.9.20、Android 0.2.19（219）、Mac/iOS 0.2.14（16）。
发布：[nexbot-v0.9.20-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.20-preview.1)。Core、Web 和全部安装包来自已推送的 main 提交 `6f0c94874d727a2c0a83a519b4a629c2d225fcb8`。

## 行为

定时任务在所属助手的独立子会话中执行，主对话接收最终结果。助手之间的执行容量隔离，重复任务最短间隔五分钟，迟到按任务类型处理。用户界面只提供查看任务/执行结果、关闭和删除，创建与修改由助手完成。删除保留已派发执行和历史结果。

详细实现、隔离验证和界面截图见[定时任务验证记录](routine-subagents.md)。数据库迁移 36 增加执行快照与迟到策略，迁移 37 增加软删除标记。

## 源码与检查

- 从 `6e2e3841` 快进合入 main，推送前重新 fetch 确认远端未移动。lint、前后端类型检查和十种语言目录校验通过。
- 最终回归首次运行 75 项通过，一个 suite 因检查期间切换分支/依赖入口发生模块加载失败；固定在已提交 main 后，受影响的 scheduler、Web 和验证文档检查共 46 项通过。前序完整后台回归见实现记录。
- 已提交源码的 Chromium 隔离夹具四组功能全部通过，无 Runtime 异常；退出清理遇到 Windows 文件占用，随后成功删除该夹具的专属临时目录。

## Core 和 Web 部署

- 东京实际构建验收使用合成模型与临时数据：schema 37；独立子任务；主会话只收到一次最终报告；删除取消等待的手动/定时执行；已派发任务正常完成；历史详情仍可读。
- 六个生产 `core.db` 使用只读连接 `VACUUM INTO` 制作副本；仅对副本构造实际构建的 Store，迁移 35 → 37，完整性与外键检查通过。独立计算预期迁移后逐表行哈希与实际结果一致。
- 部署前和停机后均确认所有账号没有活动任务。备份数据、配置和 systemd 后离线迁移生产库，逐表哈希符合预期；其他数据文件（含 runtime.db）与配置哈希保持一致。校验仅排除生成型同步游标、迁移收据及每次打开都会轮换的 desktop-owner 引导令牌/过期字段。
- 第一次切换因验收脚本把动态 `/html-preview.html` 与静态构建文件比较而失败；实际差异来自 esbuild 对生成函数的格式改写。自动回滚恢复旧版本和迁移前数据，回滚记录/文件哈希验证通过。第一次备份保留为 `/data/nexbot/backups/main-6f0c9487-20261030-pre-attempt1`。
- 修正验收脚本，动态预览页与同一构建的合成 Core 响应比较后通过。再次备份并上线 `/data/nexbot/releases/main-6f0c9487-20261030`，使用 32 个 z 前缀的最后排序 drop-in；正式备份 `/data/nexbot/backups/main-6f0c9487-20261030-pre`。
- 本机与公网 health 200、未登录 API 401；公网主页与全部七个构建资源逐字节一致。生产用户会话未发送测试任务。

## 安装包

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.20-x64-Client-Portable.exe | 176201198 | `cc700f9488b890017e5e3f0a0fc330103dcf1a8b3d40b48c377a470c225a6c41` |
| nexbot-0.2.19-debug.apk | 19943919 | `ad85b39d5b0f5a02ac4022f3824e460bf2f932129c224626167ac79895d48e91` |
| NexBot-0.2.14-mac-arm64.dmg | 76534159 | `dcdc356fbc7365b6064cc678218f9141fb2d74f90cd0a740bb87bd97613ef114` |
| NexBot-0.2.14-ios-unsigned.ipa | 11159184 | `4317fa40cdc22c9fd3ce563c966cbc9ad31f03e32f93727de7c67896f2ed097c` |

- Windows：精确发布 EXE 的 ProductVersion/FileVersion 为 0.9.20；隔离登录 20 项、账号工作区 24 项通过。
- Android：53 项 core 测试、29 项 app 测试全部通过；APK 0.2.19 / 219，apksigner 通过，证书与从 GitHub 下载的上一版 0.2.18 相同：`af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`。旧包直连下载超时，使用本机代理下载完整文件后比对通过。
- Apple：Mac 全新 git clone 固定到发布提交；178 项 NexClientKit 测试通过；Mac/iOS 各 11 项渲染测试通过。Release Mac、iOS 模拟器和 iPhone 设备构建通过；版本 0.2.14 / 16、Mac 临时签名与包内容验证通过。DMG/IPA 传回本机后哈希一致；最终 DMG 再次挂载核对签名、版本和内置执行器通过。专用模拟器与克隆目录均已清理。[发布版 iPhone 任务详情截图](images/routine-subagents/ios-release-0.2.14.png)。

## 发布和官网

- GitHub 预发布包含四个安装包、`SHA256SUMS.txt` 和 `SOURCE_COMMIT.txt`，六个文件的大小和 GitHub SHA-256 摘要均与本地一致，标签指向构建提交。首次直连上传停滞后停止该命令，核对草稿中三个已完成文件，通过本机代理补传三个缺失包；未覆盖任何已发布文件。
- OSS 发布先 dry-run，校验 GitHub 标签与摘要并私下保存旧 manifest；再上传不可覆盖的版本路径，逐个读回校验后更新 manifest。旧清单位于正式备份目录，仅用于回滚。
- 更新接口实测：Windows 0.9.19 → 0.9.20，Android 0.2.18 → 0.2.19，Mac/iOS 0.2.13 → 0.2.14；旧版得到新版，当前版得到无更新。每个接口提供的安装包均实际下载，字节数与 SHA-256 匹配清单。
- README 的五个下载链接与已验证发布文件匹配。公网首页用全新只读 Chromium profile 验证：四个平台的显示版本与共享下载清单一致，实际链接指向正确安装包；任务介绍已更新为助手安排、独立执行。见[线上首页截图](images/routine-subagents/homepage-release-0.9.20.png)。
- 最终 systemd 状态 active，工作目录为本次 release，重启后的错误级 journal 无记录。

## 安装限制

Windows 无发布者签名；Android 使用本机调试证书，更新须与既有证书一致；Mac 使用临时签名，未公证；iOS IPA 未签名，需要用户重签后安装。未执行真实手机安装或覆盖用户现有客户端。Apple 渲染使用合成 API，未进行真实账号端到端操作。测试覆盖 Chromium，未覆盖其他浏览器引擎；未做生产并发负载测试。

本地原始证据保存在忽略目录 `release/deployment-routines/`、`release/ship-0.9.20/` 及 release 下各校验日志。
