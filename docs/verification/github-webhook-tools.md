# GitHub 仓库监视与 Webhook 原子工具

这些操作通过 GitHub 连接器的 `connector.tools` 发现，并用 `connector.call` 独立调用。Core 在启动时更新既有 GitHub 连接器的工具目录。

| 操作 | 输入 | 结果 |
| --- | --- | --- |
| monitor.list | 可选 repo、botId | 当前账号工作区及连接器的监视 |
| monitor.create | repo，可选 botId、delivery | monitorId，默认通知当前助手 |
| monitor.deliveries | monitorId | 最近 50 条接收或投递记录 |
| github.webhook.list | repo，可选 page | hookId、启用状态、事件及可识别的 monitorId |
| github.webhook.create | repo、monitorId、events | GitHub 创建的 hookId |
| github.webhook.ping | repo、hookId | GitHub 已接受 ping 请求 |

回调地址使用 Core 配置的公网 HTTPS 地址。密钥在服务端解析。创建仓库回调需要 GitHub 凭证有目标仓库的 Webhook 写权限。工具沿用连接器的审批设置。签名 ping 的接收记录可与 GitHub 请求结果分别核实。

## 隔离验证

运行 `pnpm vitest run server/personal-os/{workspaces,github-monitor,github-connectors,tool-catalog}.test.ts` 对应的四个测试文件，26 项通过。独立账号工作区 fixture 调用六个操作，核对仓库绑定、密钥未返回、拒绝错误签名、签名 ping 可查、PR 重放只生成一条消息、主工作区没有该消息。GitHub 请求使用本机模拟服务，本次验证没有修改真实仓库 Webhook。

## Core 部署（2026-11-23）

已从推送到 main 的 `350bff0a` 构建 Core，部署到 Mac Air。核对了 59 个构建文件的 SHA-256。候选 Core 在临时数据库中验证六个操作的目录、监视创建及投递查询，并在全部 6 个工作区的 SQLite 备份副本上演练了旧连接器目录升级。

切换前检查空闲并备份数据和配置。切换后生产进程运行新提交，公网与本机健康检查成功，匿名访问 API 返回 401，首页及 13 个静态资源逐字节一致，6 个工作区的业务数据哈希与部署前一致。此次交付为 Core 更新；真实仓库侧的授权和投递取决于用户所连接的 GitHub 账号，验证未在真实仓库创建监视或 Webhook。
