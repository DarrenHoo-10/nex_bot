# NexBot · Personal AI OS

以持久 Agent 联系人为入口的个人 AI 系统。每个 Agent 拥有自己的名字、身份、连续消息记录与记忆，可以安排例行工作、向其他 Agent 求助，并通过主设备 Core 操作已连接的电脑。

本项目基于 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 演进，保留上游提交历史、[Apache-2.0 授权](LICENSE)、第三方授权记录与[原版 README](docs/upstream/OpenMausBot-README.md)。仓库也保留上游功能；以下内容介绍 NexBot Personal OS。

## 当前能力

- 用户自行创建 Agent，初始化不提供默认角色，也不按名字设置特殊逻辑。补充身份说明可选，修改后同伴目录自动更新。
- 固定嵌入 Pi 运行时，用户配置模型 API Key、协议、地址与模型。
- Agent 通过 A2A 自动求助；危险操作在实际执行 Agent 的消息中申请批准。
- Hindsight 与 PostgreSQL 在主设备运行。Agent 查询自己的私有 bank 与工作空间共享 bank，同伴职责由实时目录提供。
- 定时工作、持续消息、审批与记忆状态由同一个 Core 管理，其他客户端连接 Core 并同步。
- Windows 主设备自动登记，提供终端与窗口操作；共享文件目录单独配置。
- 任务不设累计 Token、模型次数、工具次数或运行时长上限。用户可在输入框旁停止任务，联动取消 A2A 子任务、模型请求和设备执行。

当前交付与真实原生电脑操作验收以 **Windows x64** 为准。跨设备同步已在同机两个独立客户端进程中验证；其他物理设备及网络环境仍需专项验收。停止任务保留已完成结果，结果未知的电脑输入操作不会自动重放。

## 架构与代码

Core 是模块化单体；Pi worker 是运行时隔离进程，Device Node 是设备执行端。

```text
持久 Agent 联系人 / 远程客户端
              |
        主设备 Agent Core
       /        |        \
 Pi worker   Hindsight   Device Gateway
               +              |
          PostgreSQL     Device Node
```

| 路径 | 用途 |
| --- | --- |
| `server/personal-os/` | Core、领域数据、A2A、记忆、任务控制、Device Node |
| `src/personal/` | Agent 联系人桌面界面 |
| `electron/nex-main.mjs` | NexBot 桌面与 Core/Client 启动入口 |
| `scripts/build-personal.mjs` | 固定运行时与前后端构建 |
| `electron-builder.personal.yml` | 主设备安装器 |
| `electron-builder.client.yml` | 轻量客户端 / Device Node |

技术设计：[模块化单体与领域模型](docs/plans/2026-10-07-personal-ai-os-domain-model.md)、[主设备记忆与协作](docs/plans/2026-10-11-personal-agent-memory-hindsight.md)、[任务控制](docs/plans/2026-10-11-manual-task-control.md)。旧方案的被替代约束，以文档顶部的后续决定为准。

## 开发与 Windows 构建

依赖版本见 `package.json`、`pnpm-lock.yaml` 和记忆运行时锁文件。

```powershell
pnpm install --frozen-lockfile
pnpm build:personal
pnpm test:personal
```

主设备安装包需要先准备完整记忆运行时。准备命令与固定依赖见 `scripts/prepare-memory-runtime.py` 开头；准备完成后执行：

```powershell
pnpm package:personal:win
```

轻量客户端构建与打包：

```powershell
pnpm build:personal
node scripts/package-personal.mjs --client
```

客户端依赖已运行的主设备 Core，本地不部署第二套记忆服务。发布前执行[隔离验收流程](docs/verification/README.md)，已验证范围与安装器构建条件见 [Windows 交付记录](docs/verification/personal-os.md)。

## 数据与发布文件

Git 保存源码、设计与资源锁定记录。API Key、个人消息、记忆数据库、本机配置、模型权重与安装包不进入源码仓库。`node_modules/`、`dist-personal/` 和 `release/` 已忽略；EXE 通过单独的发布附件分发。

本次源码推送不包含 GitHub Release 附件。应用使用用户配置的模型服务；第三方运行时及权重的授权信息在构建时保留，并随应用分发。
