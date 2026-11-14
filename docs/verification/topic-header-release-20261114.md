# 话题栏固定：全平台发布（2026-11-14）

发布：[nexbot-v0.9.33-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.33-preview.1)。Windows 0.9.33、Android 0.2.32（232）、Mac/iOS 0.2.26（28），构建提交为已推送 main 的 `0b7d815f3a1bf81afd1da13affe0dcde4ed7cbb1`。

## 改动与验收

- Web/Windows/Android：返回聊天、话题标题、受众栏移到消息滚动区域外；手机长标题可换行。Mac/iOS 共享话题界面同步提供固定的当前标题、受众和返回入口。
- main 合并后重新执行 60 条合成消息的隔离浏览器验收：1440、390 像素宽度，滚动至顶部、中间、底部时话题栏位置不变，返回按钮恢复主聊天列表。使用临时 Chrome 配置、合成 API，无用户数据。
- 推送钩子 lint、前后端 typecheck、十种语言目录检查通过。
- Windows：精确发布 EXE 的 20 项隔离登录验收通过；文件版本为 0.9.33。
- Android：53 项 Core、29 项 app 单元测试全部通过；APK 内 6 个 UI 资源与本地构建逐字节一致。APK 通过签名检查，证书 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b` 与上一发布版相同（上一 APK 文件也与 GitHub digest 一致）。
- Apple：Mac 上从推送提交全新克隆；189 项 NexClientKit 测试通过，macOS Release、iOS Simulator Debug、iOS Release 三个目标构建通过，Mac/iOS 各 15 项渲染测试通过。独立创建并删除专用模拟器。实际 DMG 挂载后验证版本 0.2.26/build 28、深度签名及内含执行器；IPA 验证版本、可执行文件与未签名状态。

## Core 与网页

- Tokyo 从 `main-58812683-20261111` 切换至 `main-0b7d815f-20261114`。候选 Core 通过隔离模型、后台任务和 UI 资源检查；6 个生产库的只读独立副本通过 schema 47 和全表记录哈希校验，无新迁移。
- 切换前后确认无活动任务，私密备份在 `/data/nexbot/backups/main-0b7d815f-20261114-pre`。新 systemd drop-in 排在所有已有配置之后，失败自动回滚。
- 停机后核对全表记录、非数据库数据文件与配置哈希；重启后本地和公网 `/health` 200，未登录 API 401，HTML 与 7 个构建资源逐字节一致。本机另独立复核公网资源通过。
- README 与网站主页同时更新；主页继续从共享下载清单读取四个平台。

## 镜像发布

- 旧清单私密保存为备份目录下的 `client-manifest.json`；dry-run 后上传至 OSS。第一次发布进程在大文件读回时被系统 OOM 终止，尚未切换清单，Core 保持正常。
- 仅在忽略的部署脚本副本中改为每次读取一个安装包、流式计算下载摘要，并主动释放上传缓冲区；重新 dry-run 后完成四个文件读回校验和清单更新，已有同名对象均验证字节一致后复用。未修改产品源码或覆盖已发布安装包。

- 四个平台的更新 API 均通过：0.9.32/0.2.31/0.2.25 旧版本获推新版，当前版本无更新；实际下载每个安装包，字节数和 SHA-256 与发布文件一致。
- 无头 Electron 打开线上主页，验证四个平台显示版本、实际链接、大小和 SHA-256 与发布文件一致，发布链接指向本次标签。README 四个安装包链接同步。
- Apple 临时源码目录与专用模拟器均已清理；构建、渲染测试摘要与部署/下载证据保存在忽略的本地 `release/` 目录。

## 安装包

GitHub 六个上传文件（四个安装包和两个校验/提交文件）的大小、digest 与本地一致。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.2.26-ios-unsigned.ipa | 34998239 | `745b7f55bd16e18ac145b097946252fee845d20fa5cc694071afad8658e944cb` |
| NexBot-0.2.26-mac-arm64.dmg | 102698435 | `14296593e2c9acc32973d9384a954d43392289e8bab08853b9c66ad83d18c01f` |
| nexbot-0.2.32-debug.apk | 43851553 | `3745df1e6e49214452102df1417c4be8a113430c4d481e4d5af2f279a89dd844` |
| NexBot-0.9.33-x64-Client-Portable.exe | 199613557 | `1314fc64229bcfdfca1cde3f5bcab33203a6bb729e5646311e014d3c7e31ce88` |

## 限制

没有在实体手机上安装此次更新，也没有手动验收原生话题页滚动。Apple 渲染套件通过不代表新增话题栏已有专门的原生交互测试。Windows 未签名、Mac 临时签名未公证、Android 调试签名、IPA 未签名。
