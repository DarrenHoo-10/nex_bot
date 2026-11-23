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
