# Broker 参数修复：Core 发布记录（2026-11-07）

已部署 Tokyo Core，已发布 [nexbot-v0.9.27-preview.2](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.27-preview.2)。
这是服务端更新，**现有客户端无需重装**。

## 来源与范围

- 用户在隔离修复验证结束后明确要求“改完后直接发布部署吧”。
- 修复提交：`6e7d6a8bea3ace5b1595eb8db5710322b3f9ce2c`。
- 推送前重新 fetch 并确认远端 main 是祖先，快进推送到 `main`；`git ls-remote`
  确认远端 `refs/heads/main` 与该提交一致。推送 hook 的全量 lint、前后端 typecheck、
  locale check 均通过。
- 用 `git archive origin/main` 建立新的干净源码快照，从快照执行
  `node scripts/build-personal.mjs --core`；没有从另一项工作面板的未提交改动构建。
- 覆盖包只含 `core / ui / package.json / SOURCE_COMMIT`。服务器复制上一版 release
  的 Linux 依赖后应用覆盖包，不替换用户数据或原有配置。
- 修复详情与归因边界见[本地隔离验证](broker-arguments-20261107.md)。
  没有取得事故上游原始 HTTP，未声称真实 Grok/代理漏参原因已被唯一定位。

## 验证

- 9 个回归文件：138 passed / 1 skipped。跳过项是未提供旧 0.4 bundle 的迁移测试。
- OpenAI-compatible 和 Anthropic 的真实 forked worker、合成 HTTP 模型、临时 Core：
  wire schema 字段完整、原始参数不丢失、缺 title 可诊断、查询和翻页结果不同、派发后
  使用同一助手的独立 Conversation、报告恰好一次。
- 前后端 typecheck、lint、locale check、Core build 通过。构建保留既有 chunk 大小警告。
- 对已推送 main 的实际构建再跑完整后台流程：缺标题后修正、两页目录、精确查询、
  完整 title/sources/note、并行响应、只回报一次、主对话权限、待办验收、停止和重启。
  另有 13 项独立服务 smoke 检查通过。
- Tokyo Linux 候选版本通过相同隔离 verifier；修正目录属主后，还以实际服务账号
  `ec2-user`、空白临时 HOME 和合成 provider 再跑一次，全部通过。
- 6 个账户数据库使用只读连接产生独立副本，候选 Store 只在副本上构造；schema 仍为
  44，逐表规范化记录哈希符合预期。副本验证后移除，没有在原始用户数据上启动测试 runtime。

## Tokyo 部署与一次回滚

| 项目 | 结果 |
| --- | --- |
| 服务 | `nexbot-core`，最终 active / running，ExecMainStatus=0 |
| 上一版 | `/data/nexbot/releases/main-31b25797-20261102` |
| 当前版 | `/data/nexbot/releases/main-6e7d6a8b-20261107` |
| 当前备份 | `/data/nexbot/backups/main-6e7d6a8b-20261107-pre` |
| 首轮回滚备份 | `/data/nexbot/backups/main-6e7d6a8b-20261107-pre-attempt1` |
| 覆盖与验收资料 | `/data/nexbot/deploy/broker-arguments-6e7d6a8b/`、`/data/nexbot/staging/main-6e7d6a8b-20261107/` |
| 配置切换 | 新增排序在全部已有 drop-in 后的 `…-broker-arguments-release.conf` |

两次尝试均在停机前和停机后检查所有账户没有活动任务和运行中的定时任务，再备份
数据、Core/OSS 配置和 systemd 配置。备份档案可读取，权限为 600。

**首次尝试失败并自动回滚。** 模板以 root 运行，候选发布目录是 `root:root / 0700`；
服务使用 `ec2-user`，systemd 报 `200/CHDIR: Permission denied`，新代码未启动。
脚本恢复了先前目录配置和备份数据，恢复后的业务记录及数据文件哈希检查通过；
随后独立确认旧服务 active/running 且健康端点正常。

修正候选目录属主为旧版本相同的服务账号，保持权限不放宽；部署模板同时增加属主继承、
真实服务账号目录访问及 Node 入口语法预检。首轮备份改名保留，再创建全新第二轮备份。
第二次通过全部检查后切换成功。

**数据保护证据的边界：** 部署停机阶段对 6 个库的规范化业务记录、非 core.db 数据文件
和配置做了哈希检查，结果不变。规范化排除生成的 sync_events/schema_migrations
以及 desktop-owner 的启动 token/expiry；schema 与既有迁移另行核查。运行时恢复后，
用户或调度器可以合法追加记录，因此不把运行中的库字节差异当作丢数据，也不声称它们
在提供服务后逐字节恒定。

## 公网与网站

- Tokyo 本机及本 Windows 机器均通过公网检查：`/health` 200，未认证业务 API 401。
- HTML、3 个直接引用资源及全部 7 个构建资源，与本地 main 构建逐字节一致；
  `/privacy.html` 及动态 `/html-preview.html` 也通过相应字节校验。
- README 与网站主页在构建提交中一起更新，明确 Core 参数修复及无需重装客户端。
- 用独立临时 Chrome profile 打开实际公网主页，检查 Core 更新入口，以及四个平台
  展示版本、下载地址与共享 manifest 一致；截图已目视检查。

## GitHub 资产

预发布标签指向修复构建提交，中文标题和说明包含平台版本表、安装方式及验证限制。
上传后的三个文件大小和 GitHub SHA-256 digest 均与本地一致：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `NexBot-Core-6e7d6a8b-Overlay.tar.gz` | 35173826 | `bc5d8d7d7c497869bdf5d813fd97c0509ba22c8aabaeae19624df3f5e5636b47` |
| `SOURCE_COMMIT.txt` | 41 | `945e2ec02db0ec4cbaedabe56c0e12a53a77382d0eaeb6a35d7667df66e5ccec` |
| `SHA256SUMS.txt` | 186 | `812a96197f9a85ee4d5257497ad46c3eb24207dfc190769c2087d1b361e6b46c` |

覆盖包是运维资料，不是客户端安装器，也不含新服务器所需的全部原生依赖。

## 未重发的客户端

| 平台 | 保留版本 | 安装包来源 |
| --- | --- | --- |
| Windows | 0.9.27 | `nexbot-v0.9.27-preview.1` |
| Android | 0.2.26 | 同上 |
| Mac / iPhone | 0.2.20 | 同上 |

本次未改变客户端功能，只有服务端修复和公共网站发布说明；没有重新打包、签名或覆盖
任何客户端资产，没有增加客户端版本号。客户端 OSS 镜像和更新 manifest 均保留原样，
不执行客户端 publisher。核对了 manifest 的文件大小/哈希与原 GitHub 资产一致；
本次没有重新下载这些未改变的安装包或重新执行各平台安装测试。

`/api/client/update` 的八组检查通过：旧版本分别收到既有 0.9.27 / 0.2.26 / 0.2.20，
当前版本均 `available=false`，没有被这次 Core release 误导为一次客户端升级。

## 仍未验证

- 未主动调用真实收费模型进行复测；没有验证真实 Grok 的自主工具选择、参数生成和文章质量。
- 未取得事故原始 HTTP 响应，真实上游模型/代理/流式解析环节的事故归因仍有限。
- 未做客户端真机验收、长期负载测试或人工对话验收；没有向生产会话发送测试消息。

本地完整日志、构建包、SHA、截图及验收 JSON 位于忽略目录
`release/deployment-broker-arguments/` 和 `release/broker-arguments-evidence/`。
