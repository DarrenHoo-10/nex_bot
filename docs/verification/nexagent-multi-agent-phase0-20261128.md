# NexAgent 多 Agent 协作：第 0 期 Windows 隔离实测记录（2026-11-28）

本记录对应设计文档 [`docs/design/nexagent-multi-agent.md`](../design/nexagent-multi-agent.md) 第 12 节的第 0 期实测清单，验证三种 CLI 在本机 Windows 环境下作为主控/工人接入 `nex` 协作链路的可行性、安全边界与投递路径，并把实测结论回写到第 1 期实施方案中。

## 1. 实测环境与隔离边界

- **主机**：Windows 11（x64），Node.js `v24.18.0`，PowerShell 5.1，Git Bash（`D:\DevelopTools\Git\bin\bash.exe` / `usr\bin\bash.exe`）。
- **被测组件版本**：
  - Claude Code：`2.1.332`（`D:\npm-global\claude.cmd`）
  - Codex CLI：`0.172.0`（`C:\Users\Administrator\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`）
  - Antigravity CLI（`agy`）：`1.5.18`（`C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Links\agy.exe`）
  - `herdr-core`：`0.1.21`（`%LOCALAPPDATA%\NexBotClient\runtime\herdr-core\0.1.21-c1ff3660c31d\herdr-core.exe`）
- **隔离措施**：
  - AGY：使用全新临时 `ANTIGRAVITY_CLI_CONFIG_DIR` 与临时 git 仓库目录。
  - Claude：短测使用 `--no-session-persistence` 与临时 `--plugin-dir`；`herdr-core` 交互测使用独立临时 `CLAUDE_CONFIG_DIR`（仅复制认证/基础配置副本），不写入真实 `~/.claude` 与 `~/.claude.json`。
  - Codex：沙箱与交互测使用独立临时 `CODEX_HOME`（仅复制 `auth.json` + 精简 3 行 `config.toml`）与 `--ephemeral`；`elevated` 沙箱对照使用 `--ephemeral --ignore-user-config`，不修改 `~/.codex/config.toml`、不写入真实会话历史。
  - 终端宿主：所有 `herdr-core` 测试使用独立 `HC_SESSION` 与独立命名管道 `HC_SOCKET`，测试后调用 `herdr-core server stop` 仅停掉该隔离实例，并清理全部 `%TEMP%\nex-p0-*` 临时目录。

## 2. 实测总览矩阵

| 实测项 | 引擎 / 通道 | 结果 | 关键结论 |
| --- | --- | --- | --- |
| `nex` 发现与命名管道连通 | Claude（Git Bash & PowerShell） | **通过** | Windows Claude 同时具备并动态选用 `Bash` 与 `PowerShell` 两个工具；`PATH` 注入 `nex` + `nex.cmd` 后两者均可执行并连上 `\\.\pipe\...` |
| `nex` 发现与命名管道连通 | Codex（`full`） | **通过** | `--dangerously-bypass-approvals-and-sandbox` 下 PowerShell 正常调用 `nex.cmd` 并连上 `\\.\pipe\...` |
| `nex` 发现与沙箱管道连通 | Codex（`unelevated` + `read-only`） | **部分受阻 → 已找到解法** | `nex.cmd`（目录在 workspace 外/内）均可执行且 `NEX_*` 完整保留，但受限令牌连默认 DACL 命名管道报 **`EPERM`**；同环境下 **回环 HTTP（`127.0.0.1` + Bearer）`200 OK`**，且单次启动 **`-c mcp_servers.nex=...`** 运行在沙箱外可直接连命名管道 |
| `nex` 发现与沙箱管道连通 | Codex（`unelevated` + `workspace-write`） | **受阻** | Codex `0.172.0` 报 `UnsupportedOperation("windows unelevated restricted-token sandbox cannot enforce split writable root sets directly")` |
| `nex` 发现与沙箱管道连通 | Codex（`elevated` + `workspace-write`/`read-only`） | **未通过（超时）** | 即使加 `--ignore-user-config`，无头 `codex exec` 在 40s 超时未返回命令输出 |
| `nex` 发现与命名管道连通 | AGY（ACP `1.5.18`） | **通过** | ACP 子进程的 `PATH`、`NEX_PIPE`、`NEX_SESSION` 完整透传到 shell 工具，中文参数与命名管道均正常 |
| 环境变量是否被剥离 | 三端全部 | **通过** | `NEX_PIPE` 与 `NEX_SESSION` 在 Claude（Bash/PowerShell）、Codex（`full` / `unelevated read-only`）、AGY ACP 中均**未被剥离** |
| 父进程链兜底耗时 | Windows 11 | **过慢（不可作主路径）** | `wmic.exe` 已移除（`ENOENT`）；`Get-CimInstance Win32_Process` 逐 PID 查约 **3,153–3,232 ms**，单次快照约 **1,066–1,119 ms** |
| Windows `.cmd` 参数与 `--file` UTF-8 | `cmd.exe` / PowerShell 5.1 / Git Bash | **`--file` 完美；`.cmd` 行内有坑** | `--file` 在三类 shell 下 100% 字节级一致读取中文、引号、符号与 emoji；但经 `nex.cmd` 传行内参数时，**即便 PowerShell 用单引号**，`cmd.exe` 仍会展开 `%USERNAME%`/`%PATH%` 并吃掉内嵌 `"`（Git Bash 走 POSIX `nex` 无此问题） |
| 主控说明通道（不改全局配置） | Claude `--plugin-dir` | **通过** | 临时目录 `skills/nex/SKILL.md` 正常加载并命中秘密标记 `[P0-CLAUDE-SKILL-OK-42]` |
| 主控说明通道（不改全局配置） | AGY ACP `systemPrompt.append` | **通过** | `initialize` 明确声明 `_meta.antigravity.systemPrompt.append: true`；`[P0-AGY-SYS-OK]` 首轮生效，且**跨进程重启 `session/resume` 后依然保持** |
| 主控说明通道（不改全局配置） | Codex `-c developer_instructions=...` | **通过** | 单次启动传入 `-c developer_instructions="..."` 生效（命中 `[P0-CODEX-DEV-OK]`），无需改 `~/.codex/config.toml` 或 `AGENTS.md` |
| `ask` 模式纯 `nex` 放行并拒拼接 | Claude（`--allowedTools` vs `PreToolUse`） | **重要安全发现** | **`--allowedTools "Bash(nex *)"` 可被 `&&` 绕过**（`nex status && echo P0_ALLOWED_LEAK` 整条放行）；改用 **`PreToolUse` 钩子（匹配 `Bash|PowerShell`）** 精确放行纯 `nex` 并成功拦住 `&&` 拼接 |
| `ask` 模式纯 `nex` 放行并拒拼接 | AGY ACP `session/request_permission` | **通过** | `default` 模式下检查 `toolCall.rawInput.CommandLine`，纯 `nex` 自动回复 `allow_once`，`nex status && echo P0_BAD` 拒绝自动放行（管道增量 0） |
| `ask` 模式纯 `nex` 放行并拒拼接 | Codex（`execpolicy` 规则 vs `-c mcp_servers.nex`） | **找到更优解** | `rules/*.rules` 的 `prefix_rule(pattern=["nex"], decision="allow")` 在 `on-request` 交互 TUI 中可无弹窗放行纯 `nex status`，但无法靠单次 `-c` 指定独立规则文件；而单次启动 **`-c mcp_servers.nex=...` + `-c mcp_servers.nex.tools.<name>.approval_mode="approve"`** 无需改全局文件、无 shell 拼接面且同时绕过 Windows 沙箱管道 `EPERM` |
| 投递：终端 1 行唤醒提示 | Claude & Codex（`herdr-core`） | **通过（Codex 有时序 caveat）** | Claude 经 `hc.sendGuarded` 稳定提交并运行 `nex inbox`；Codex 空闲时稳定提交，但紧接上一轮结束做 PTY 粘贴可能留在输入框未提交（印证 Codex 必须优先走 `codex queue`） |
| 投递：`codex.exe queue` 8 KB 多行 | Codex `0.172.0`（`--no-daemon`） | **通过** | `tryManagedCodexQueue` 投递 **8,232 字节（53 行）中文 + 特殊字符**消息成功；完整尾部写入转录，模型准确回显末尾口令 `P0_CODEX_QUEUE_8KB_TAIL_OK_54321` |
| 投递：AGY 退出后重连唤醒 | AGY ACP `1.5.18` | **通过** | 杀掉首个 `agy acp`（PID 15632）后重启新进程（PID 11404），经 `session/resume`（协议同时支持 `loadSession: true`）接回原会话并收到后续 prompt、执行 `nex inbox` |
| 投递：Claude 原生收件箱 | `herdr-core` 托管的 Claude `2.1.332` | **通过** | `herdr-core` 启动的 Claude 在 `sessions/<pid>.json` 暴露 `messagingSocketPath` 与 `peerProtocol: 1`；`sendToInbox()` 直投 **2,726 字节**多行中文消息获 `delivery: "confirmed"`，Claude 直接回显尾部口令，无需再调 `nex inbox` |
| 额外发现：新 worktree 信任弹窗 | Claude & Codex（`herdr-core`） | **高优先级避坑** | 新建未信任目录会阻断工人启动：Claude 弹窗默认光标在 **`> No, exit`**（须 `down + enter`）；Codex 弹 **`Folder access`**（`-c projects.<path>.trust_level` 无法绕过、且仅认规范长路径不认 `ADMINI~1` 短路径，同时 `codexEmptyComposer()` 误把 `› 1. Trust and continue` 判成空输入框） |

## 3. 详细实测证据

### 3.1 Windows `.cmd` 参数、UTF-8 `--file` 与父进程链耗时

使用临时 `bin/`（`nex.cmd` + POSIX `nex` + `nex.mjs`）和本机命名管道 `\\.\pipe\nex-p0-...` 对 `cmd.exe`、PowerShell 5.1、Git Bash 实测：

- **`--file` UTF-8 样本（97 字符，含中文、换行、`%PATH%`、`^caret^`、双引号、单引号、`!bang!`、`$HOME`、`& | ;`、反引号、`$(sub)`、`<in>out`、`✅⚠️`）**：
  - `cmd.exe /d /c nex report --file "<utf8-path>"`：`exit=0`，`fileMatch: true`，`len: 97`。
  - `powershell.exe -NoProfile -Command "nex report --file '<utf8-path>'"`：`exit=0`，`fileMatch: true`，`len: 97`。
  - `Git Bash`（POSIX `/c/...` 与 Windows `C:\...` 路径各测一次）：均 `exit=0`，`fileMatch: true`，`len: 97`。
- **行内参数经 `nex.cmd` 传递的实测缺陷**：
  - PowerShell 单引号传 `'中文总结 100% %USERNAME% ^caret^ $HOME & | ;'` → `nex.mjs` 收到 `"中文总结 100% Administrator ^caret^ $HOME & | ;"`（`%USERNAME%` 仍被 `cmd.exe` 的 `%*` 展开）。
  - PowerShell 单引号传 `'说 "你好" %PATH% ^x^'` → `nex.mjs` 收到 `"说 你好 <整个 PATH> ^x^"`（内嵌 `"` 丢失且 `%PATH%` 整段展开）。
  - Git Bash 走无扩展名 POSIX `nex` 脚本传相同内容 → 100% 原样保留：`"中文总结 100% %USERNAME% ^caret^ $HOME & | ; \"quotes\""`。
- **Windows 父进程链查询耗时（3 次连续实测）**：
  - `powershell.exe` + 逐 PID `Get-CimInstance Win32_Process -Filter "ProcessId=..."`：`3153 ms, 3185 ms, 3232 ms`。
  - `powershell.exe` + 单次快照 `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name`：`1107 ms, 1119 ms, 1066 ms`。
  - `wmic.exe`：本机 Windows 11 已移除（`ENOENT`）。

### 3.2 AGY ACP（`1.5.18`）全链路实测

在临时 `ANTIGRAVITY_CLI_CONFIG_DIR` 下直接通过仓库 `server/personal-os/cli-agents-node/agy-acp.ts` 的 `AgyAcp` 驱动 `agy.exe acp`：

- `initialize` 返回能力：`loadSession: true`、`sessionCapabilities.resume: {}`、`sessionCapabilities.load: {}`、`_meta.antigravity.systemPrompt.append: true`。
- `session/new` 传入 `_meta.antigravity.systemPrompt.append` 注入 `[P0-AGY-SYS-OK]` 前缀规则，并切到 `default`（`ask`）模式。
- **第 1 轮（纯 `nex` + 环境透传 + 中文参数）**：`session/request_permission` 收到 `toolCall.rawInput = { CommandLine: "nex status --check 中文测试", ... }`、`options = [allow_once, reject_once]`；执行器校验为纯单条 `nex` 后回复 `allow_once` → 命名管道收到 `args: ["status","--check","中文测试"]`、`NEX_PIPE`、`NEX_SESSION`，回复包含 `[P0-AGY-SYS-OK]`。
- **第 2 轮（`ask` 模式拒绝拼接）**：要求执行 `nex status && echo P0_BAD` → `session/request_permission` 收到 `CommandLine: "nex status && echo P0_BAD"`，纯命令校验判为 `false` 并回复 `reject_once` → 管道增量 `0`。
- **第 3 轮（进程退出 + 重连）**：关闭原 `agy acp`（PID 15632），新建 `AgyAcp`（PID 11404），调用 `session/resume` 接回同一 `sessionId`，发 prompt 让其运行 `nex inbox` → 管道收到 `["inbox"]`，回复 `[P0-AGY-SYS-OK] Message from worker-1: P0_INBOX_DELIVERED`。

### 3.3 Claude Code（`2.1.332`）技能、环境变量、`ask` 模式与 `herdr-core` 原生收件箱

- **技能加载与环境透传**：`--plugin-dir <tempPlugin>`（含 `.claude-plugin/plugin.json`、`skills/nex/SKILL.md`、`hooks/hooks.json`）在 `--no-session-persistence` 下成功加载 `skills/nex/SKILL.md` 并输出 `[P0-CLAUDE-SKILL-OK-42]`；`Bash` 工具（Git Bash `D:\DevelopTools\Git\usr\bin\bash.exe`）与 `PowerShell` 工具均能找到 `nex` 并透传 `NEX_PIPE`/`NEX_SESSION` 连上命名管道。
- **`--allowedTools` 安全缺陷实测**（`--permission-mode manual --permission-prompts none --allowedTools "Bash(nex *)" "PowerShell(nex *)"`）：
  - 纯命令 `nex status --check allowed-pure`：放行（`permission_denials: []`，管道增量 `1`）。
  - 拼接命令 `nex status && echo P0_ALLOWED_LEAK`：**被直接放行并执行了 `echo P0_ALLOWED_LEAK`**（`permission_denials: []`，管道增量 `1`）。
- **`PreToolUse` 钩子精确放行实测**（`--permission-mode manual --permission-prompts none --plugin-dir <tempPlugin>`，不传 `--allowedTools`，钩子 `matcher: "Bash|PowerShell"`）：
  - 纯命令 `nex status --check hook-pure`（Claude 实际调用了 `PowerShell` 工具）：钩子判定 `pureNex: true` 返回 `permissionDecision: "allow"` → `permission_denials: []`，管道增量 `1`。
  - 拼接命令 `nex status && echo P0_HOOK_LEAK`（Claude 调用了 `Bash` 工具）：钩子判定 `pureNex: false` 不放行 → `permission_denials: [Bash]`，管道增量 `0`。
- **`herdr-core` 托管终端 1 行唤醒 + 原生收件箱实测**（独立 `CLAUDE_CONFIG_DIR` + `--permission-mode bypassPermissions`）：
  - 启动后在 `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` 观测到 `messagingSocketPath: "\\.\pipe\LOCAL\cc-msg-..."`、`peerProtocol: 1`。
  - 1 行唤醒经 `hc.sendGuarded` 成功提交（`started: true`），Claude 调用 `nex inbox` 并回显 `P0_WAKEUP_INBOX_OK`。
  - 随后直接调用 `sendToInbox()` 投递 **2,726 字节**多行中文协作汇报 → 返回 `{"delivery":"confirmed","waiting":false}`，Claude 在同一会话中直接读完并回复末尾口令 `P0_CLAUDE_INBOX_TAIL_OK_9876`，全程未再调用 `nex inbox`。

### 3.4 Codex CLI（`0.172.0`）指令注入、Windows 沙箱、规则放行与 `codex queue`

- **单次启动指令通道**：`codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox -c developer_instructions="..."` 在不碰 `~/.codex/config.toml` 的前提下准确生效（回复带 `[P0-CODEX-DEV-OK]`），同时 PowerShell 调用 `nex status --mode full` 完整保留 `NEX_PIPE`、`NEX_SESSION` 并连通命名管道。
- **Windows 沙箱通道对比**：
  - `unelevated` + `read-only`（`nex.cmd` 放于 workspace 外或内结果一致）：PowerShell 成功执行 `nex.cmd`，`NEX_PIPE` 与 `NEX_SESSION` 均保留，但 `net.connect(\\.\pipe\...)` 报 **`EPERM`**；同一次命令中连接 **`http://127.0.0.1:<port>`（带 `Authorization: Bearer <NEX_SESSION>`）返回 `200 OK`**。
  - `unelevated` + `workspace-write`：Codex `0.172.0` 直接报错 `UnsupportedOperation("windows unelevated restricted-token sandbox cannot enforce split writable root sets directly; refusing to run unsandboxed")`。
  - `elevated` + `workspace-write` / `read-only`（使用 `--ephemeral --ignore-user-config` 排除用户插件/MCP 干扰）：无头 `codex exec` 在 40s 超时。
  - **单次启动 MCP 通道**（`codex exec --ephemeral -s read-only -c mcp_servers.nex.command=<node> -c mcp_servers.nex.args=[<bridge>] -c mcp_servers.nex.tools.nex_status.approval_mode="approve"`）：**17s 内成功完成**，MCP 桥运行在沙箱外并直连 `\\.\pipe\...`（`pipeHits: 1`），无需任何全局配置修改，也无需审批弹窗。
- **`ask` 模式规则与投递实测**（独立 `CODEX_HOME` + `herdr-core` `--no-daemon` 终端）：
  - 1 行唤醒（`hc.sendGuarded`）：在目录已预信任（规范长路径）且空闲时提交成功，回显 `OK_2A`；紧接前一轮结束立即粘贴时曾出现文本留在输入框未提交的现象。
  - **`codex.exe queue` 8 KB 多行 UTF-8**：调用 `tryManagedCodexQueue` 投递 **8,232 字节（53 行）**中文+特殊字符消息返回 `true`，完整尾部进入转录且模型回显末尾口令 `P0_CODEX_QUEUE_8KB_TAIL_OK_54321`。
  - **`rules/nex.rules` 放行**：`prefix_rule(pattern=["nex"], decision="allow")` 在 `approval_policy="on-request"` 下无弹窗放行纯 `nex status --check ask-pure`（管道增量 `1`），`codex execpolicy check` 确认原始 shell 拼接（`powershell.exe -Command "nex status; echo bad"`、`bash -lc "nex status && echo bad"`）不匹配规则；但 `.rules` 路径不能通过单次 `-c` 指定，故对 Codex 沙箱/`ask` 会话优先采用 `-c mcp_servers.nex=...` + `approval_mode="approve"`。
- **新目录信任弹窗与 `codexEmptyComposer` 细节**：
  - 未信任的临时目录会弹出 `Folder access / Trust this folder?`；通过 `-c projects."<path>".trust_level="trusted"` 命令行覆盖**无法跳过**，必须持久化在 `config.toml` 且路径须为 Windows 规范长路径（`fs.realpathSync.native`，`ADMINI~1` 短路径不匹配）。
  - 现有 `codexEmptyComposer()` 会把弹窗里的 `› 1. Trust and continue` 误判为空输入框，第 1 期启动新 worktree 工人时需一并修复该判定或配合工作树信任处理。

## 4. 回写第 1 期设计的具体调整

1. **Claude `ask` 模式放行改为 `PreToolUse` 钩子，禁用 `--allowedTools "Bash(nex *)"`**：钩子必须同时匹配 `Bash|PowerShell`，严格拒绝含 `&&`、`||`、`;`、`|`、`` ` ``、`$(`、`>`、`<` 及换行的命令。
2. **Codex 主控说明采用 `-c developer_instructions=...`**：无需改全局 `~/.codex` 配置，也不再需要用户口头补一句“用 nex”。
3. **Codex Windows 沙箱（`readonly` / `ask`）提前启用单次 `-c mcp_servers.nex=...` 轻桥接**（第 1 期即可支持，不拖到第 2 期）：同时解决 Windows 受限令牌访问命名管道 `EPERM` 问题与 `ask` 模式免审批、零命令拼接风险问题；若走 CLI 通道，本机管道服务也可同时暴露随机回环端口（`127.0.0.1` + 每会话 HMAC Bearer）供沙箱内 `nex` 自动回退。
4. **Claude 托管终端优先用原生收件箱直投整条消息**：`herdr-core` 启动的 `full` 模式 Claude 会话已实测暴露 `messagingSocketPath`，8 KB 内协作消息可直接经 `sendToInbox()` 投递，减少主控多跑一次 `nex inbox`；收件箱不可用或 `ask` 模式需确认时再退回终端 1 行唤醒提示。
5. **Windows `nex.cmd` 严守 `--file` UTF-8 规则**：不在命令行参数里传正文或可能含 `%`、`"` 的文本。
6. **新 worktree 信任弹窗处理**：第 1 期启动新 worktree 工人时，必须考虑 Claude（默认光标在 `> No, exit`）和 Codex（`Folder access` 及 `codexEmptyComposer` 误判）的首次目录信任问题。

## 5. 验证局限（未覆盖项）

- **macOS（zsh、Seatbelt 沙箱、`codex` macOS 沙箱管道连通性）**：本次在 Windows 11 本机执行，未在 Mac 上实测（按仓库规则，非发布准备阶段不自行发起 Mac SSH 测试），需在 Mac 联调/发布准备前补测。
- **Claude `ask`（`manual`）模式下的原生收件箱**：本次原生收件箱直投在 `bypassPermissions` 下通过，未单独验证 `manual` 模式下 `inbox.ts` 是否需要终端确认；第 1 期实现时先仅对 `full`（bypass）模式的托管 Claude 启用收件箱直投，其余走 1 行唤醒。
- **Codex Windows `elevated` 沙箱**：本机无头 `codex exec` 下 `elevated` 模式两次 40s 超时，未观察到其内部管道/回环行为；采用 `-c mcp_servers.nex=...` 后该模式同样在沙箱外通信，不受影响。
