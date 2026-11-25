# NexAgent 权限确认卡与默认完全访问：开发验证（2026-11-24）

只做了开发期验证，没有发版、没有部署 Core。

## 问题链路

电脑端 Claude 的确认来自 nex_bot 插件的 `PermissionRequest` hook（`server/personal-os/cli-agents-node/plugin`）：hook → 本机管道 → `HookServer` 发 `cli.request` → Core 存 `cli_agent_requests` 并推给网页、安卓、Windows、Apple → 卡片答复经 `answer` 回到 hook。Core 和各端卡片本身工作正常。断在电脑端：

1. Windows 上 Claude Code 2.1.33x 找不到 Git Bash 时用 PowerShell 跑 hook，原来的 POSIX 写法（`[ -z … ] || …`）解析失败。这时 PermissionRequest 不仅没有卡片，还会**直接拒绝**这次调用（实测报错 “blocking because Git Bash wasn't found”）。
2. 和 Core 的连接断开（或调用时恰好没连上）时，hook 立刻回 `pass`，确认只留在电脑终端。重连后没有补发，所以手机上只看到 `waiting`，没有卡片。
3. hook 没覆盖的会话没有任何卡片：Codex TUI 跑在 nex_bot 终端里（它没有 hook），以及 hook 没装上的 Claude 终端。

用户报的那次（会话 `ee828bea…`，`auto` 模式，Read 临时目录图片）在 02:48 进入等待，04:36 在终端被拒。那台机器找得到 Git Bash，hook 能跑，所以最可能是第 2 条。隔离环境里没能复现那次具体的停顿。

## 改动

- 电脑端：Windows 终端改用数据目录里的插件副本，hook 写成 `shell: "powershell"`，始终 `exit 0`（`platformPlugin`/`windowsHooksJson`）。连接断开时确认保持等待，重连后补发（`HookServer.relink`）。卡片附带完整参数（`detail`）。Claude 给出 `permission_suggestions` 时可以“本会话总是允许”（hook.mjs 把建议改为 `destination: "session"` 写进 `updatedPermissions`）。Codex 守护进程的审批用 `acceptForSession` / `scope: "session"`。
- 电脑端兜底：nex_bot 终端里 herdr 显示 `blocked`（或 Claude 状态为 `waiting`），且 4 秒内（Codex 1 秒）没有 hook 或守护进程报告时，从屏幕读出确认框生成卡片，用确认框自己的按键答复。只有屏幕上还是同一个确认框才会按键（`screen-prompts.ts`）。
- 默认权限：新会话（新建、分叉）默认完全访问，Claude 用 `--dangerously-skip-permissions`，Codex 用 `--dangerously-bypass-approvals-and-sandbox`。继续已有会话默认沿用 CLI 自己的设置。执行器声明 `permissions` 能力，Core 只把选择发给声明了的执行器。
- 网页（Windows、安卓同一份）与 Mac/iPhone：卡片显示参数和“本会话总是允许”，新建会话有“完全访问 / 每次询问”切换。

## 验证

- 实测（Windows 11，Claude Code 2.1.331，隔离的 `claude -p` 和独立的 herdr-core 会话，探针监听，不碰用户的客户端和会话）：
  - 原 POSIX hook 找不到 Git Bash 时报错并拒绝，找得到时正常。
  - PowerShell 版在有、无 Git Bash 两种情况下，permission/post/stop 三个 hook 都到达，允许后读取成功。以已安装客户端的 `NexBot Client.exe` 作为 hook 运行时也通过。没有 nex_bot 变量时 hook 不起作用，不报错。
  - hook 等待期间终端照样显示 Claude 的确认框，在终端答复后 hook 连接关闭，并收到 PostToolUse。
  - 用“总是允许”答复后，同一会话里第二次读同一路径不再触发确认。
  - herdr 终端里抓到的 Claude Read / Bash 确认框原文写进了 `screen-prompts.test.ts`，数字键能直接选中。
- 单测：`server/personal-os/cli-agents-node`、`server/personal-os/cli-agents`、`shared`、`src/personal/cli-agents` 全部通过。`discovery.test.ts` 的上下文窗口用例除外：它在这台机器上未改动的 `main`（6c4e1623）同样失败，与本改动无关。
- Mac（`ssh mac-air`，临时目录）：NexClientKit 270 个测试通过，NexBotMac 和 NexBotiOS（模拟器）构建成功。

## 未验证

- 没有真机验证安卓、Windows 客户端、iPhone、Mac 上的卡片和新建会话切换。
- Codex TUI 确认框的屏幕识别按 Codex 的文案写成，测试机上的 Codex 连不上模型，没抓到真实画面。Codex 守护进程的 `acceptForSession` 按协议实现，没有实测。
- `--dangerously-skip-permissions` 在从没接受过的电脑上会先弹一次 Claude 自己的确认，需要在电脑或远程终端里接受一次。测试机已经接受过，没能实测这个首次提示。
