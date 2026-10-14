# NexBot · Personal AI OS

以持久 Agent 联系人为入口的个人 AI 系统。每个 Agent 拥有自己的名字、身份、连续消息记录与记忆，可以安排例行工作、向其他 Agent 求助，并通过主设备 Core 操作已连接的电脑。

本项目基于 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 演进，保留上游提交历史、[Apache-2.0 授权](LICENSE)、第三方授权记录与[原版 README](docs/upstream/OpenMausBot-README.md)。仓库也保留上游功能；以下内容介绍 NexBot Personal OS。

## 当前部署方式

- **Core 是独立后端服务**，运行在 Mac 或 Windows 主机上，统一管理 Agent、消息、任务、审批、模型配置和记忆来源。
- **客户端只有壳子**：连接后端、使用 NexorAI 账号登录、显示后端提供的界面。客户端不带 Core、Pi、数据库、PDF 引擎或设备执行节点，关闭客户端不会停止服务。
- 用户中心固定为 `https://user.nexorai.com.cn`。首次账号关联在后端命令行完成；其他设备使用同一账号登录，不按邮箱隐式合并身份。
- 记忆通过外部 Hindsight 插件配置。Python、PostgreSQL、模型权重和记忆服务均不随后端或客户端分发。
- 后端注册自己的主机设备。终端、文件访问和可用的电脑操作作用于后端或独立设备执行节点，不作用于客户端壳。
- Agent 保持连续消息与记忆，支持 A2A、例行工作、审批和用户手动停止任务。

## 构建

需要 Node 24+ 和 pnpm。依赖锁定在 `package.json` / `pnpm-lock.yaml`。

```sh
pnpm install --frozen-lockfile
pnpm package:core
```

后端输出到 `release/core/`，按构建主机的 OS/CPU 命名；PDF 原生依赖要求使用目标平台构建。
解压后运行：

```sh
node core/service.js init --data-dir=/your/private/nexbot-data
node core/service.js start --data-dir=/your/private/nexbot-data
```

`init` 在终端提示输入邮箱和密码，密码不保存。Windows 使用相应的 Windows 目录路径。
默认仅监听 `127.0.0.1:8799`；远程客户端通过 HTTPS 反向代理连接。
服务管理、保险库、迁移与配置详见 [Core 部署说明](deploy/core/README.md)。

Mac Apple Silicon 客户端 DMG：

```sh
pnpm package:client:mac
```

Windows 客户端（在 Windows 上构建）：

```powershell
pnpm package:client:win
```

客户端输出到 `release/personal-client-mac/` 或 `release/personal-client/`。
Mac 使用 ad-hoc 签名，尚未做 Developer ID 分发签名与 Apple 公证。
`package:personal:mac` / `package:personal:win` 仅为后端服务打包命令的兼容别名，不生成主设备应用。

## 用户中心与记忆插件

客户端填写后端地址并使用与该 Core 关联的 NexorAI 账号登录。各客户端会话独立，支持撤销与退出。
登录失效或用户中心无法验证时暂停业务访问与任务执行；不会降级为匿名或本地免登录模式。

登录后在「设置 → 记忆插件」填写外部 Hindsight 根地址和令牌，测试连接、启用并保存。
令牌存于后端加密保险库；配置在后端重启后生效。支持后端可访问的本机/私有网络 HTTP 和 HTTPS。
外部服务独立管理模型、数据库、认证、计费与备份。未连接时仍可使用本地原始记录，待同步来源保留。
更换已有记忆的服务前先迁移 Hindsight 数据库；停用插件不会删除外部数据。

## 代码与验证

| 路径 | 用途 |
| --- | --- |
| `server/personal-os/service.ts` | 后端启动、私有保险库、单实例锁和账号初始化 |
| `server/personal-os/identity*.ts` | nex_user 适配、身份绑定、登录与会话撤销 |
| `server/personal-os/` | Agent Core、Pi worker、A2A、记忆账本和设备协议 |
| `server/personal-os/memory-plugin.ts` | 外部记忆插件注册与连接配置 |
| `src/personal/` | 由后端提供的界面 |
| `electron/nex-client-main.mjs` | 所有桌面客户端的薄壳 |
| `scripts/build-personal.mjs` | 分开构建后端与客户端 |
| `electron-builder.client*.yml` | 仅客户端安装包 |

设计：[Core 服务与薄壳](docs/plans/2026-10-11-core-service-thin-shell.md)。
发布前遵循 [隔离验证规范](docs/verification/README.md)；当前交付记录见
[后端与客户端验收](docs/verification/core-service-thin-shell.md)。

API Key、账号凭据、消息、保险库密钥、数据库与安装包均不进入源码 Git。
`dist-personal/`、`release/` 和临时构建数据已忽略。历史桌面 profile 不会自动删除或迁移。
