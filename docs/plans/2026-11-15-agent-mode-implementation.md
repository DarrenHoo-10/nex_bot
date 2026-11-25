# Agent 模式技术方案

设计依据：[Agent 模式](../design/agent-mode.md)，2026-11-15 已确认。本文写到文件、函数、表、消息和测试这一级，按第 9 节的顺序实现即可。行号以提交 `eb535ffe` 为准。

本文对第 1 期（MVP）写到实现细节。第 2–4 期只写接口和数据结构，开工前再细化。凡是标了“第 0 期确认”的地方，按实测结论回填。

## 1. 改动总览

| 面 | 新文件 | 修改的现有文件 |
| --- | --- | --- |
| 电脑端 | `server/personal-os/cli-agents-node/` 下：`hc.ts`、`hc-frames.ts`、`claude.ts`、`codex.ts`、`liveness.ts`、`items.ts`、`reader.ts`、`launch.ts`、`streams.ts`、`bridge.ts`、`local-store.ts` | `server/personal-os/node.ts`、`server/personal-os/client-node.ts`、`electron/nex-client-device.mjs`、`electron/nex-client-main.mjs`、`electron/nex-client-preload.cjs` |
| 打包 | `scripts/prepare-herdr-core.mjs` | `scripts/build-client-executor.mjs`、`package.json` |
| Core | `server/personal-os/cli-agents/` 下：`schema.ts`、`hub.ts`、`routes.ts`、`stream.ts`、`frames.ts`；另加 `server/personal-os/upgrade.ts` | `server/personal-os/devices.ts`、`server/personal-os/workspaces.ts`、`server/personal-os/index.ts`、`server/personal-os/store.ts` |
| 网页 | `src/personal/cli-agents/` 下的组件和模块（第 6.2 节） | `src/personal/AgentDesktop.tsx`、`src/personal/components/ContactSidebar.tsx`、`src/personal/api.ts`、`src/personal/panels.tsx`（只加 Windows 客户端里的开关） |
| 测试 | 见第 8 节 | `electron/nex-client-device.node-test.mjs` |
| 文档 | `docs/verification/agent-mode-spike-<日期>.md`、`docs/verification/agent-mode-mvp-<日期>.md` | `docs/verification/README.md`；发布时还要改 README 和官网首页 |

## 2. 命名与常量

代码里统一叫 `cli-agent`，文件、表、路由、消息和工具都用这个名字。原因是现有代码里的“Agent”指的是助手联系人：`agents.ts`、`/api/agents/*`，以及以 `agent.` 开头的工具动作。

| 名称 | 值 |
| --- | --- |
| herdr-core 版本 | 0.1.21（协议 generation 1） |
| `HC_SESSION` | `nexbot-<hash8>`；`hash8` 为 `sha256(coreOrigin + "\n" + workspaceId)` 的前 8 位十六进制 |
| `HC_SOCKET` | Windows：`\\.\pipe\nexbot-hc-<hash8>`；macOS：`<数据目录>/hc/<hash8>.sock`，路径超过 100 字节时改用 `$TMPDIR/nexbot-hc-<hash8>.sock` |
| 会话 key | `<deviceId>:<engine>:<nativeId>` |
| 扫描 | 运行中的会话每 2 s 一次，历史每 15 s 一次；只看最近 14 天；单台电脑最多 300 个会话 |
| 会话记录 | 每页 40 条；工具结果最多 64 KB；参数摘要和思考摘要各最多 2 KB；Core 每个会话最多缓存 300 条 |
| 终端 | 默认 120×36；cols 取 20–500，rows 取 5–200；history 2000 行 |
| 流控 | 每个流初始额度 256 KiB；Core 每个流最多缓冲 1 MiB；二进制帧负载最多 64 KiB |
| 浏览器 WebSocket | Core 每 20 s ping 一次，45 s 收不到 pong 就断开；客户端重连间隔 1–30 s，指数退避加抖动 |
| 发送 | 文本最多 32 KB；电脑前有人正在输入时最多等 60 s（herdr-core 的 draft_wait） |

## 3. 电脑端

### 3.1 打包 herdr-core（`scripts/prepare-herdr-core.mjs`）

做法照搬 [prepare-cloudflared.mjs](../../scripts/prepare-cloudflared.mjs)：

- **常量**：`VERSION = "0.1.21"`，以及 `TARGETS`：
  - `win32-x64`：`herdr-core-windows-x86_64.zip`，二进制 `herdr-core.exe`
  - `darwin-arm64`：`herdr-core-macos-aarch64.tar.gz`
  - `darwin-x64`：`herdr-core-macos-x86_64.tar.gz`
  每个目标都写死压缩包和二进制的 sha256。sha256 在定版本时从 `https://releases.herdr.dev/core/0.1.21/manifest.json` 读出并人工核对；脚本运行时不信任远端的 manifest。
- **下载**：`https://releases.herdr.dev/core/0.1.21/<asset>`，重试 3 次，每次超时 120 s。设置 `NEX_HERDR_CORE_ARCHIVE_DIR` 时改用离线缓存。
- **校验**：
  - 在新的临时目录里解压，Windows 用 `tar.exe`，和官方安装脚本一致。
  - 检查可执行文件头（PE 或 Mach-O）与目标架构一致，再核对二进制的 sha256。
  - 运行 `--version`，输出必须是 `hc 0.1.21`。
- **落盘**：原子写入 `dist-native/herdr-core/<platform-arch>/`，包括：
  - `herdr-core(.exe)`；Windows 还有 `conpty/`
  - `LICENSE`
  - `THIRD-PARTY-NOTICES.txt`，内容是 `herdr-core --licenses` 的输出
  - `manifest.json`，记录版本和哈希
  目录已存在且校验通过时直接复用。参数 `--current`（只准备当前平台）和 `--root`。
- **构建入口**：`package.json` 增加 `build:herdr-core`，在 `build:client` 之前运行。
- **进安装包**：[build-client-executor.mjs](../../scripts/build-client-executor.mjs) 把 `dist-native/herdr-core/win32-x64/` 复制到 `client-executor/herdr-core/`，和现有的 `computer-runtime` 一样随 `client-executor` 进入安装包。`electron-builder.client.yml` 已经把 `client-executor` 列为 extraResources，不用加新条目。
- **运行时定位**（`hc.ts` 的 `locateHerdrCore()`），按顺序查找：
  1. 环境变量 `NEX_HERDR_CORE_PATH`
  2. 执行器包同级的 `../herdr-core/`，用 `import.meta.url` 定位，和 [computer.ts](../../server/personal-os/computer.ts) 找 `computer-runtime` 的方式相同
  3. 开发环境的 `dist-native/herdr-core/<platform-arch>/`
  都找不到时，Agent 桥报告 `hc_unavailable`，其他设备能力不受影响。
- **Mac（第 3 期）**：[build-mac-executor.mjs](../../scripts/build-mac-executor.mjs) 把 darwin 版放进 `apps/apple/build/Executor/herdr-core/`。`bundle-executor.sh` 现在给每个 Mach-O 都加 `node.entitlements`，要改成只给 node 加，herdr-core 用普通签名。

### 3.2 herdr-core 客户端（`hc.ts`、`hc-frames.ts`）

`class HerdrCore`，构造参数为 `{ binary, session, socket, log }`。

**环境变量**：传给 herdr-core 的是 `{ ...process.env, HC_SESSION, HC_SOCKET }`。

- 不改 `XDG_STATE_HOME` 和 `XDG_CONFIG_HOME`。终端里的程序会继承这些变量（例如 git、gh 都会读 `XDG_CONFIG_HOME`），改了会影响 Agent 的正常工作。
- 后果一：herdr-core 的状态目录落在 `%LOCALAPPDATA%\herdr-core\nexbot-<hash8>\`（Unix 是 `~/.local/state/herdr-core/nexbot-<hash8>/`），删除设备时一并删掉。
- 后果二：配置文件与用户自己的 herdr-core 共用。它只影响 shell、draft_wait 这类设置；nex_bot 用参数列表启动程序，不受 shell 设置影响。

**`ensureStarted()`**：

1. 连接 `HC_SOCKET`。连上就发 `hello`。
2. 连不上时，以分离方式运行一次 herdr-core 命令来拉起后台核心：`spawn(binary, [<拉起命令>], { env, detached: true, stdio: "ignore", windowsHide: true }).unref()`。拉起命令由第 0 期确认。之后每 200 ms 重连一次，最多等 10 s。
3. 核心进程不能进入 DeviceNode 自己管理的进程树。暂停时，`DeviceNode.close()` 会结束它管理的所有进程（[node.ts:291-296](../../server/personal-os/node.ts#L291)）。

**`hello`**：

- 参数：`{ framed: true, generation: 1, features: ["resize_notifications"] }`。
- 要求 `version === "0.1.21"`、`generation === 1`，并且 `methods` 里包含下面用到的全部方法；否则报 `hc_version`。

**连接**：

- Windows 用 `net.connect("\\\\.\\pipe\\nexbot-hc-<hash8>")`，Unix 用 `net.connect(path)`。
- 只开一个 framed 连接：通道 0 跑 JSON-RPC，其他通道是 attach 流。

**`hc-frames.ts`**：

- 帧格式为 `[u32 LE channel][u8 kind][u32 LE len][payload]`。kind：DATA=0、CREDIT=1、CLOSE=2、RESIZE=3、FOCUS=4、FACTS=5、AUTOMATIC_INPUT=6。
- 提供 `encodeFrame()` 和 `FrameDecoder`；`FrameDecoder` 处理分片，单帧上限 16 MiB。
- 都是纯函数，单独测试。

**调用**：

- `call(method, params, { timeoutMs })`：id 自增；错误统一转成 `HcError { kind, hint }`，kind 取自 `data.kind`。
- 只封装这些方法：`run`、`list`、`get`、`attach`、`send`、`keys`、`interrupt`、`read`、`subscribe`。
- 不封装 `machine.*`、`file.*`、`templates.*`、`server.stop`、`doc.set`。

**事件**：调用 `events.subscribe({ labels: { nexbot: "1" } })`，先拿到快照，再接收后续变化（created、lost、restarted、finished、removed、status、title、size），交给 Agent 桥。

**断线**：

- 所有 attach 流以 `hc_disconnected` 结束。
- 从 1 s 开始指数退避重连，最长间隔 30 s，当前状态写进 `state()`。
- 重连后重新订阅，并用 `terminal.list` 和本地的终端表对账。

### 3.3 会话发现（`claude.ts`、`codex.ts`、`liveness.ts`）

扫描结果统一成下面这个结构。`transcript` 是会话文件在电脑上的路径，只在电脑端使用，不上传到 Core：

```ts
type SessionRow = {
  engine: "claude" | "codex"; nativeId: string; configDir: string; cwd: string;
  title: string; gitBranch?: string; state: "running" | "waiting" | "idle" | "stopped";
  waitingFor?: string; liveIn?: "nexbot" | "terminal" | "desktop" | "background";
  terminal?: string; model?: string; cliVersion?: string; lastActivityAt: number;
  transcript: string;
};
```

#### Claude（`claude.ts`）

**配置目录**：`~/.claude`；执行器环境里设了 `CLAUDE_CONFIG_DIR` 时，把它也加进来。

**`scanLive(dir)`**，每 2 s 一次，读 `sessions/*.json`：

- 跳过 `*.key` 文件。那是会话收件箱的令牌，一律不读。
- 读取的字段：`pid`、`sessionId`、`cwd`、`kind`、`entrypoint`、`status`、`waitingFor`、`name`、`nameSource`、`version`、`procStart`、`updatedAt`。
- **进程是否存活**：先用 `process.kill(pid, 0)`。新出现的 pid 再用 `liveness.processStart(pids)` 核对一次启动时间：Windows 一次 PowerShell CIM 查询批量取 `CreationDate`，macOS 用 `ps -o lstart= -p`。和 `procStart` 不一致，就当作 pid 被别的进程复用了。查询失败时按存活处理，并标记为 `unverified`。
- **`liveIn`**：
  - sessionId 在本地终端表里 → `nexbot`
  - `entrypoint` 为 `cli` → `terminal`
  - `entrypoint` 以 `claude-desktop` 开头 → `desktop`
  - 后台会话 → `background`
- **状态**：busy → running；waiting → waiting（带上 `waitingFor`）；idle 和 shell → idle。

**`scanHistory(dir)`**，每 15 s 一次，读 `projects/*/*.jsonl`：

- 只取 14 天内修改过的，最多 300 个；不进入 `<sessionId>/subagents/`。
- 按 `(size, mtimeMs)` 缓存，文件变了才重读：
  - 读头部 64 KB：从第一条带 `cwd` 的记录取 `cwd`、`gitBranch`、`entrypoint`、`version`；第一条非 `isMeta` 的用户文字作为备选标题。
  - 读尾部 64 KB：取最后一条 `custom-title.customTitle`、`agent-name.agentName`、`mode.mode`，以及最后一条记录的 `timestamp`，作为最近活动时间。
- 标题按这个顺序取第一个有值的：
  1. `customTitle`
  2. 运行中会话文件里的 `name`（`nameSource` 不是 `derived` 时）
  3. `agentName`
  4. 第一条用户文字的前 60 个字

运行中的会话和历史按 sessionId 合并；找不到活进程的标为 stopped。

#### Codex（`codex.ts`）

**目录**：`~/.codex`；设了环境变量 `CODEX_HOME` 时，把它也加进来。

**会话名**：增量读 `session_index.jsonl`，从 `id` 取 `thread_name`、`updated_at`。

**rollout 扫描**：

- 按目录名只遍历最近 14 天的 `sessions/YYYY/MM/DD/`，再按 mtime 过滤。
- 每个文件只解析第一行 `session_meta`，取 `id`、`cwd`、`originator`、`source`、`thread_source`、`git`、`cli_version`。
- **跳过**：
  - `thread_source === "subagent"`
  - `source.subagent`（包括 Guardian）
  - `source === "exec"`
  - `originator` 为 `codex_exec` 或以 `codex_sdk_` 开头
- **续写文件**：文件名在线程 ID 后面多了 `_<段 UUID>` 的，按 `session_meta.payload.id` 合并，取最新一段。
- **`liveIn`**：
  - 本地终端表 → `nexbot`
  - `originator` 为 `Codex Desktop` 或 `codex_work_desktop` → `desktop`
  - CLI → `terminal`
- **状态**：
  - 文件尾部最后一个 `task_started` 之后没有 `task_complete` 或 `turn_aborted`，并且文件 60 s 内有写入 → running。
  - 否则是 idle 或 stopped，由 `liveness.codexWriter()` 判断有没有活的写入方，规则在第 0 期确认。判断不了时标为 unknown，界面显示“可能在电脑上打开”。

只存在于 Codex App 数据库里的会话，放到第 4 期。

#### 合并与上报

Agent 桥每一轮把 Claude 和 Codex 的结果合并，和上一轮比较，只把新增、字段变化和移除的部分发给 Core。上报至少间隔 500 ms，期间的变化合并成一次。

### 3.4 会话记录解析（`items.ts`、`reader.ts`）

```ts
type CliItem =
  | { kind: "user"; id: string; ts: number; text: string; images?: string[]; queued?: boolean }
  | { kind: "assistant"; id: string; ts: number; text: string }
  | { kind: "thinking"; id: string; ts: number; text: string }
  | { kind: "tool"; id: string; ts: number; name: string; input: string;
      status: "running" | "ok" | "error"; output?: string }
  | { kind: "notice"; id: string; ts: number; level: "info" | "error"; text: string }
  | { kind: "turn"; id: string; ts: number; phase: "started" | "ended" | "aborted" };
```

**Claude 的记录怎么映射**

| 记录 | 条目 |
| --- | --- |
| `user`，`message.content` 是字符串或 text 块 | user；跳过 `isMeta` |
| `user` 里的 `image` 块 | user.images：只记本机路径，不传图片本身 |
| `user` 里的 `tool_result` 块 | 补全 `tool_use_id` 对应的 tool：output 取其中的文字，`is_error` 为真时状态记 error |
| `assistant` 里的 `text`、`thinking`、`tool_use` 块 | 分别对应 assistant、thinking、tool（running）；id 为 `<uuid>:<块序号>` |
| 带 `isCompactSummary` 的记录 | notice“上下文已压缩”，不显示摘要正文 |
| `system` 的 `api_error`、`compact_boundary`、`local_command` | notice |
| `attachment` 的 `queued_command` | user，标记 queued |
| 带 `isSidechain` 的记录 | 跳过，这是子 Agent 的记录 |
| `custom-title`、`agent-name`、`mode`、`pr-link` | 不生成条目，只更新会话行 |
| 其他（`queue-operation`、`last-prompt`、`file-history-*`、`api-request*`、`cost-state`、`tools-used`、`atis-latch` 等） | 忽略 |

**Codex 的记录怎么映射**

- 文件里只要出现过 `event_msg/item_completed`，就只用它（v2 ThreadItem）：
  - `UserMessage` → user；`AgentMessage` → assistant；`Reasoning` → thinking
  - `CommandExecution`、`McpToolCall`、`FileChange`、`ImageView`、`Extension` → tool，状态取 `completed` 或 `failed`
  - `ContextCompaction`、`SubAgentActivity` → notice
- 没有 `item_completed` 时，改用 `response_item`：
  - `message`（role 为 user 或 assistant）
  - `reasoning`（取摘要）
  - `function_call`、`custom_tool_call` 及对应的 `_output`
  - `web_search_call`
  - 这时忽略 `event_msg` 里的 `agent_message` 和 `user_message`，它们和 response_item 重复。
- 两种情况都这样处理：
  - `task_started`、`task_complete`、`turn_aborted` 生成 turn 条目。
  - `compacted`、`context_compacted` 生成 notice。
  - `token_count`、`world_state`、`turn_context` 不生成条目；`turn_context.model` 用来更新会话行。
- **条目 id**：记录自带 id 就用它；没有的用 `<文件段>:<字节偏移>`。文件只会追加，所以偏移不会变。

**增量读取（`reader.ts`）**

- 只为已订阅的会话打开文件，记住 `{ path, offset, partial }`。
- 用 `fs.watch` 监听变化，另外每秒 `stat` 一次作为兜底。每次从 `offset` 读到文件末尾；最后一行不完整时留到下次再读。
- 文件变短了（被截断或替换），从头重置，重新读最后一页，并发一个 `reset`。
- **向前翻页**：第一次需要时，异步扫描整个文件，建立每行起点的索引。每次读 1 MB，块与块之间让出事件循环。之后按条目数取页，16 MB 的记录也只需扫描一次。
- 解析失败的行跳过并计数，不中断读取。

### 3.5 启动与继续（`launch.ts`）

**找到 CLI：`resolveCli(engine)`**

- 按 `PATH` 和 `PATHEXT` 的顺序查找 `claude` 或 `codex`，规则和 `where.exe` 一致。结果缓存，启动失败时重新查找。
- 本机实测：`claude` 找到的是 npm 安装的 `D:\npm-global\claude.cmd`；`codex` 先找到的是 `...\OpenAI\Codex\bin\codex.exe`。
- 版本号用 `<cli> --version` 读取，超时 5 s。`.cmd` 和 `.bat` 必须经 `cmd.exe /d /s /c` 运行，因为 Node 不允许不经过 shell 直接启动它们。

**拼启动参数：`buildArgv(engine, mode, ids)`**

| | 新建 | 继续 |
| --- | --- | --- |
| Claude | `[claude, "--session-id", uuid]` | `[claude, "--resume", nativeId]` |
| Codex | `[codex]` | `[codex, "resume", nativeId]` |

- 找到的是 `.cmd` 或 `.bat` 时，整体包成 `["cmd.exe", "/d", "/s", "/c", <拼好的命令行>]`。是否必须包，由第 0 期确认。
- 只拼 nex_bot 自己生成的参数，每个参数都必须匹配 `^[A-Za-z0-9._:/=-]+$`，不接受客户端传来的任意参数。
- MVP 不传模型和权限参数，沿用用户 CLI 自己的设置。

**工作目录与配置目录**

- `cwd` 必须是绝对路径、确实存在、并且是目录。继续会话时用会话行里记录的 `cwd`。
- 配置目录不是默认值时，在 `env` 里带上 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME`。

**`terminal.run` 的参数**

`{ argv, cwd, env, name: "cli-<engine>-<短 id>", labels: { nexbot: "1", "nexbot.engine": engine, "nexbot.native": nativeId 或 "pending" }, size, keep: false }`

**继续之前，检查有没有别的写入方**（启动前一刻要再查一次）：

- **Claude**：`sessions/*.json` 里有活进程持有这个 `sessionId`，就返回 `open_elsewhere`，并附上 `liveIn`。
- **Codex**：
  - `liveness.codexWriter()` 判断有写入方，就返回 `open_elsewhere`。
  - 判断不了时照常启动，靠 Codex 自己拒绝：如果终端 5 s 内就退出，并且屏幕上显示的是“已有写入方”这类报错，就返回 `open_elsewhere`。

**新建的 Codex 会话怎么和终端对上**：方案由第 0 期确认。备选做法：启动后 60 s 内，取第一个同时满足以下条件的 rollout——同一个 `cwd`、`originator` 是 CLI、创建时间晚于启动时间、还没被其他 nex_bot 终端认领。

### 3.6 终端流（`streams.ts`）

**打开**：`open({ sid, key, cols, rows, observe })`

- 会话必须在 nex_bot 终端里。
- 调用 `hc.attach({ terminal, cols, rows, history: 2000, observe, resize_notifications: observe })`，记下 sid 与 herdr-core 通道号的对应关系。
- 所有流共用一条 framed 连接。

**输出**：herdr-core 的 DATA 转成 DCP 二进制帧 `0x01`（第 4.3 节）。负载超过 64 KiB 就拆开发；同一个流在 16 ms 内的小块合并后再发。

**额度**：Core 发来 `cli.term.credit` 时，原样转成 herdr-core 的 CREDIT。所以最终的推送速度由浏览器决定。

**输入**：DCP 二进制帧 `0x02` 转成 herdr-core 的 DATA。以下情况丢弃输入，并回 `cli.term.error {code: "read_only"}`：只看的流、暂停中、开关已关闭。

**尺寸**：

- `cli.term.resize` 转成 RESIZE。
- 只看的流收到 herdr-core 的 RESIZE 时，转成 `cli.term.size` 发给 Core。

**结束**：

- 任何一方都可以发 CLOSE。
- 程序退出时，herdr-core 发来 `{reason: "exited", exit_code}`，转成 `cli.term.closed`，同时在本地终端表写入 `ended_at`。

**暂停**：关闭所有流（`reason: "paused"`），拒绝新的打开请求和输入。终端本身继续运行。

### 3.7 发送、中断、在电脑上打开

**发送：`send({ key, text })`**

- 会话必须在 nex_bot 终端里，文本不超过 32 KB。
- 调用 `hc.send({ terminal, text, timeout: 65 })`，返回 `{ started, turn }`。
- 电脑前有人正在输入时，herdr-core 会等他发出或清空输入，最多等 60 s。

**中断：`interrupt({ key })`**

调用 `hc.interrupt({ terminal, timeout: 5 })`，返回 herdr-core 观察到的结果。

**在电脑上打开：`openLocal({ key })`**

在电脑上弹出一个接入同一终端的窗口。只能由客户端用户发起，Agent 的工具不能调用。

- **Windows**：
  1. 在数据目录写一个 `attach-<地址>.cmd`：先设置 `HC_SESSION`、`HC_SOCKET`，再运行 `"<herdr-core.exe>" attach <地址>`。
  2. 有 `wt.exe` 就用 `wt.exe -w new` 打开；没有就用 `cmd.exe /c start`。
- **macOS**（第 3 期）：写一个 `.command` 脚本，再用 `open -a Terminal` 打开。

### 3.8 本地存储（`local-store.ts`）

新建 SQLite 文件 `<数据目录>/node/cli-agents.db`，不动 `node.db` 和它的迁移。使用 `node:sqlite`，开启 WAL。

```sql
CREATE TABLE scan_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  engine TEXT NOT NULL, native_id TEXT NOT NULL, head_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE terminals (address TEXT PRIMARY KEY, engine TEXT NOT NULL, native_id TEXT NOT NULL,
  cwd TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER) STRICT;
CREATE TABLE ops (op_id TEXT PRIMARY KEY, op TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  result_json TEXT, created_at INTEGER NOT NULL) STRICT;
```

`ops` 表只保留 7 天。断线后 Core 重发同一个 `opId` 时，直接返回上次的结果，不重复执行。

### 3.9 接入 DeviceNode 与客户端

**`node.ts`**

- **配置**：增加 `cliAgents: boolean`，默认 true。这个值变化时要提升 `policyVersion`，做法和 exec、computer 一样（[node.ts:98-104](../../server/personal-os/node.ts#L98)）。
- **`hello`**：增加 `cliAgents: bridge.capability()`，并在 `identity.supported` 里加入 `"cli.agents"`（[node.ts:80](../../server/personal-os/node.ts#L80)、[node.ts:113](../../server/personal-os/node.ts#L113)）。
- **收消息**（[node.ts:114](../../server/personal-os/node.ts#L114)、[121-160](../../server/personal-os/node.ts#L121)）：
  - 二进制帧交给 `bridge.binary()`。
  - `type` 以 `cli.` 开头的 JSON 消息交给 `bridge.handle()`。
  - 其他消息照旧处理。
- **`close()`**：先调用 `bridge.detach()`，关闭所有流、停止扫描、断开 herdr-core 连接。herdr-core 和终端不在 DeviceNode 管理的进程树里，所以不会被结束。
- **断线重连后**：调用 `bridge.resync()`，重新发全量会话列表。

**其他客户端文件**

- **`client-node.ts`**：`cliAgents` 随 node-config 一起保存。
- **`electron/nex-client-device.mjs`**：
  - `configure` 传入 `cliAgents`，取自保存的偏好，默认 true（[nex-client-device.mjs:110-113](../../electron/nex-client-device.mjs#L110)）。
  - `state()` 增加 `cliAgents: { available, enabled, hc, engines }`：`hc` 取 `"starting"`、`"ready"` 或 `"error"`；`engines` 为 `[{ engine, version }]`。
- **`electron/nex-client-preload.cjs` 与 `nex-client-main.mjs`**：新增 `setCliAgentsEnabled(enabled)`。和 `setDevicePaused` 一样，只接受来自 Core 页面主框架的调用。
- **`src/personal/panels.tsx` 的设备页**：在本设备那一行加一个“Agent 会话”开关，只在 Windows 客户端里显示（[panels.tsx:105-154](../../src/personal/panels.tsx#L105)）。

## 4. 设备协议扩展

### 4.1 能力声明

- **设备端**：`hello.cliAgents = { version: 1, engines: ["claude", "codex"], terminal: { name: "herdr-core", version: "0.1.21", ready: true } }`。
- **Core 端**：在 [devices.ts:73-75](../../server/personal-os/devices.ts#L73) 的能力白名单和作用域里加上 `cli.agents`。只有声明了 `cliAgents.version === 1` 的设备才会收到 `cli.*` 消息。

### 4.2 JSON 消息

**设备 → Core**

| type | 字段 | 说明 |
| --- | --- | --- |
| `cli.sessions` | `full`、`upserts`、`removes`、`seq` | `upserts` 里的会话行不含电脑上的文件路径。`full` 为 true 时以这一份为准，Core 删除其中没有出现的行 |
| `cli.items` | `key`、`items`、`reset?`、`more?` | 已订阅会话的新增条目 |
| `cli.reply` | `opId`、`ok`、`result?`、`error?: {code, message}` | 操作的结果 |
| `cli.term.opened` | `sid`、`cols`、`rows`、`observe` | 终端流已打开 |
| `cli.term.size` | `sid`、`cols`、`rows` | 终端尺寸变了 |
| `cli.term.closed` | `sid`、`reason`、`exitCode?` | 终端流已关闭 |
| `cli.term.error` | `sid`、`code` | 终端流出错 |

**Core → 设备**

| type | 字段 |
| --- | --- |
| `cli.op` | `opId`；`op` 取 read、watch、unwatch、start、continue、send、interrupt、open_local 之一；`args`；`deadlineMs` |
| `cli.term.open` | `sid`、`key`、`cols`、`rows`、`observe` |
| `cli.term.resize` | `sid`、`cols`、`rows` |
| `cli.term.credit` | `sid`、`bytes` |
| `cli.term.close` | `sid` |
| `cli.resync` | 没有字段，要求设备重发全量会话列表 |

### 4.3 二进制帧

- **格式**：`[u8 类型][u32 LE sid][负载]`，负载最多 64 KiB。
  - `0x01`：终端输出，方向为设备 → Core → 浏览器。
  - `0x02`：终端输入，方向为浏览器 → Core → 设备。
- **Core 与浏览器之间**：用同样的格式，Core 只换掉 sid。浏览器那边的 sid 和设备那边的 sid 由 Core 负责对应。
- **现状**：DCP 两端现在把每条消息都当 JSON 解析，失败就以 1008 关闭连接（[node.ts:114](../../server/personal-os/node.ts#L114)、[devices.ts:68](../../server/personal-os/devices.ts#L68)）。
- **改法**：先判断 `isBinary`。只有双方都声明了 `cliAgents` 之后才接受二进制帧；没声明时收到二进制帧，仍按协议错误关闭。

### 4.4 操作、超时与幂等

**不走现有的设备调用。** 现有的 `device_calls` / `node_calls` 每台设备只允许一个进行中的调用，租约不超过 30 s（[schema.sql:481](../../server/personal-os/schema.sql#L481)、[486](../../server/personal-os/schema.sql#L486)），承载不了并发的流和耗时长的操作。

**超时**：每个操作都带 `opId`（UUID），各操作的超时如下：

| 操作 | 超时 |
| --- | --- |
| read | 15 s |
| watch | 5 s |
| start / continue | 30 s |
| send | 70 s |
| interrupt | 10 s |
| open_local | 10 s |

**超时或断线时**：

- Core 把每个操作记进 `cli_agent_ops`。超时或断线时标为 unknown，界面显示“结果未知”。
- 会改变状态的操作（start、continue、send、interrupt）不自动重发。只读操作（read、watch）可以重发。
- 设备用本地的 `ops` 表去重：同一个 `opId` 再次到达时，直接返回上次的结果。

### 4.5 流控

- 浏览器每往 xterm 写入 32 KB（以 `write` 回调为准），回一次 `credit`。Core 原样转给设备，设备再转成 herdr-core 的 CREDIT。初始额度 256 KiB，和 herdr-core 的默认值一致。
- Core 每个流最多缓冲 1 MiB。超出时丢掉缓冲、关闭这个流，让浏览器带 `history: 2000` 重新打开，拿到一屏新的画面，不补发积压的内容。
- herdr-core 自己在落后 4 MiB 时也会重绘。

### 4.6 错误码

| 错误码 | 含义 |
| --- | --- |
| `disabled` | Agent 会话开关已关闭 |
| `paused` | 本机控制已暂停 |
| `hc_unavailable` | 找不到或无法启动 herdr-core |
| `hc_version` | herdr-core 版本或协议不匹配 |
| `cli_missing` | 找不到 claude / codex |
| `cwd_missing` | 工作目录不存在 |
| `not_found` | 会话不存在 |
| `not_in_terminal` | 会话不在 nex_bot 终端里 |
| `stopped` | 会话已停止 |
| `open_elsewhere` | 会话正在别处运行 |
| `read_only` | 只看的流不接受输入 |
| `too_large` | 内容超出上限 |
| `invalid` | 参数不合法 |
| `busy` | 同一会话的上一个操作还没完成 |
| `device_offline` | 电脑离线（由 Core 生成） |
| `unknown` | 结果未知（由 Core 生成） |

每个错误码在网页上对应一句简短的状态文字。

## 5. Core

### 5.1 迁移 50、51（`cli-agents/schema.ts`）

- **写法**：仿照 [todo-schema.ts](../../server/personal-os/todo-schema.ts)，把 SQL 写成 TS 字符串。不用 `.sql` 文件，因为构建只复制固定的几个 `.sql` 文件（[build-personal.mjs:54](../../scripts/build-personal.mjs#L54)）。
- **登记**：在 [store.ts](../../server/personal-os/store.ts) 的迁移序列里登记。写本文时最大编号是 47；合并 main 时 main 已用掉 48、49（助手重置和删除），因此 Agent 模式改用 50（会话表）和 51（请求与监督表）。

```sql
CREATE TABLE cli_agent_sessions (
  key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('claude','codex')),
  native_id TEXT NOT NULL,
  config_dir TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  git_branch TEXT,
  state TEXT NOT NULL CHECK (state IN ('running','waiting','idle','stopped')),
  waiting_for TEXT,
  live_in TEXT CHECK (live_in IN ('nexbot','terminal','desktop','background')),
  terminal TEXT,
  model TEXT,
  cli_version TEXT,
  last_activity_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cli_agent_sessions_recent ON cli_agent_sessions(device_id, last_activity_at DESC);

CREATE TABLE cli_agent_items (
  session_key TEXT NOT NULL REFERENCES cli_agent_sessions(key) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (session_key, item_id)
) STRICT;
CREATE INDEX cli_agent_items_ts ON cli_agent_items(session_key, ts);

CREATE TABLE cli_agent_ops (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  session_key TEXT,
  op TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','succeeded','failed','unknown')),
  error_code TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
```

- **几个字段的约定**：
  - `key` 是 `deviceId:engine:nativeId`。
  - `body` 用 `store.encrypt()` 加密后保存。
  - `args_json` 不存发送的正文，只记长度。
  - `created_by` 是 `user_sessions.id`。
- **设备撤销时**：由 hub 删除这台设备的会话行，会话记录随外键一起删掉。
- **不加 `sync_events` 触发器**：这几张表变化频繁，加了触发器会让所有客户端一遍遍重新拉取全部状态（[store.ts:150-152](../../server/personal-os/store.ts#L150)）。

### 5.2 `CliAgentHub`（`cli-agents/hub.ts`）

每个工作区一个实例，在 `createPersonalApp` 里创建，注入 `store`、`gateway`、`changed`。

| 函数 | 作用 |
| --- | --- |
| `fromDevice(deviceId, msg)` | 处理第 4.2 节的设备消息，见下 |
| `fromDeviceBinary(deviceId, frame)` | 按设备那边的 sid 找到对应的浏览器流，转发过去 |
| `deviceOnline(deviceId, capability)`、`deviceOffline(deviceId)` | 设备上线、下线。下线时，这台设备的流都以 `device_offline` 结束，进行中的操作标为 unknown；会话行保留，列表里显示“电脑离线” |
| `list()`、`items(key, before)` | 设备在线时向它 `read`，离线时读缓存 |
| `op(session, target, op, args)` | 校验后写入 `cli_agent_ops`，发出 `cli.op`，等 `cli.reply` 或超时；写审计 |
| `summary()` | 返回 `{ waiting, running }`；只有数字变了才调用 `changed()` |

`fromDevice` 对各类消息的处理：

- `cli.sessions`：在一个事务里完成新增、更新和删除。
- `cli.items`：写入缓存，每个会话最多 300 条，超出时按 `ts` 删掉最早的；同时推给订阅者。
- `cli.reply`：结束对应的等待中的操作。
- `cli.term.*`：转给对应的浏览器流。

设备被撤销时（[devices.ts:180-189](../../server/personal-os/devices.ts#L180)），删除这台设备的会话和缓存。

### 5.3 `DeviceGateway` 改动（`devices.ts`）

- **收消息**（[devices.ts:65-111](../../server/personal-os/devices.ts#L65)）：
  - 二进制帧和 `cli.*` 消息交给 hub。
  - `hello` 里的 `cliAgents` 交给 `hub.deviceOnline`。
  - 连接关闭时调用 `hub.deviceOffline`。
- **能力**：在白名单和作用域里加上 `cli.agents`（[devices.ts:73-75](../../server/personal-os/devices.ts#L73)）。
- **发送**：新增 `sendCli(deviceId, message)` 和 `sendCliBinary(deviceId, frame)`；设备不在线时抛出 `device_offline`。
- **WebSocket 升级**：处理逻辑从这里（[devices.ts:36-48](../../server/personal-os/devices.ts#L36)）移到 `upgrade.ts`，见第 5.5 节。

### 5.4 HTTP 接口

- **接入位置**：在 [index.ts](../../server/personal-os/index.ts) 的 `route()` 里加两处转发，都转给 `cli-agents/routes.ts`。一处在 GET 段（371-488），一处在修改段（492-673）。
- **约束**：只接受本人的会话。修改请求沿用现有的 Origin 检查。请求体上限沿用 256 KB。

| 方法与路径 | 请求 | 回答 |
| --- | --- | --- |
| `GET /api/cli-agents` | — | `{ devices: [{ id, name, online, cliAgents }], sessions }` |
| `GET /api/cli-agents/items?key=&before=` | — | `{ items, more }` |
| `POST /api/cli-agents/start` | `{ deviceId, engine, cwd }` | `{ key }` |
| `POST /api/cli-agents/continue` | `{ key }` | `{ key }` |
| `POST /api/cli-agents/send` | `{ key, text }` | `{ turn }` |
| `POST /api/cli-agents/interrupt` | `{ key }` | `{ outcome }` |
| `POST /api/cli-agents/open-local` | `{ key }` | `{ ok }` |
| `POST /api/cli-agents/hide` | `{ key, hidden }` | `{ ok }` |

出错时沿用 `{ error }` 格式，另外带上 `code`（取值见第 4.6 节）。

### 5.5 客户端 WebSocket（`upgrade.ts`、`cli-agents/stream.ts`）

**路径分发（`upgrade.ts`）**

只注册一个 `server.on("upgrade")`，按路径分发：

- `/dcp/v1/connect` → `DeviceGateway`
- `/api/cli-agents/stream` → `CliAgentStream`
- 其他路径直接 `socket.destroy()`

多账号模式下，在 [workspaces.ts:101-109](../../server/personal-os/workspaces.ts#L101) 的路由里加一个分支：按 `nex` Cookie 对应的会话找到工作区。查找方式和 HTTP 路由相同（[workspaces.ts:92-99](../../server/personal-os/workspaces.ts#L92)）。

**鉴权与连接限制**

- `nex` Cookie 必须对应一个有效的本人会话。
- Host 必须在允许列表里，Origin 必须等于公开地址，用来防跨站 WebSocket 劫持。
- 不满足时返回 401 或 403，然后关闭连接。
- 用 `ws` 库，`noServer` 模式，`maxPayload` 1 MiB。每个会话最多 8 条连接。

**消息**

| 方向 | 消息 |
| --- | --- |
| 浏览器 → Core | `sub.list`、`sub.session {key}`、`unsub.session {key}`、`term.open {key, cols, rows, observe}`、`term.resize {sid, cols, rows}`、`term.credit {sid, bytes}`、`term.close {sid}`，以及二进制帧 `0x02` |
| Core → 浏览器 | `list {devices, sessions}`、`list.delta {upserts, removes}`、`items {key, items, reset?}`、`term.opened {sid, cols, rows, observe}`、`term.size`、`term.closed {sid, reason}`、`error {code}`，以及二进制帧 `0x01` |

**心跳与关闭**

- Core 每 20 s ping 一次，45 s 收不到 pong 就断开。流量要经过 Cloudflare 和 nginx 中转，空闲的连接会被它们切断。
- 用户退出登录或会话被撤销时，以 4401 关闭连接。

**CSP**：现在是 `connect-src 'self'`（[index.ts:246](../../server/personal-os/index.ts#L246)）。现代浏览器会把同源的 `wss:` 算在 `'self'` 里。第 0 期在 Chrome、Edge、Safari 上确认；必要时显式加上 `wss://<公开主机>`。

### 5.6 状态摘要

`/api/state` 增加 `cliAgents: { waiting, running }`，给侧栏角标用。只有这两个数字变化时才调用 `changed()`。

### 5.7 审计与日志

- 用 `store.audit()` 记录以下操作：
  - `cli.start`、`cli.continue`、`cli.interrupt`、`cli.open_local`
  - `cli.send`：只记长度
  - `cli.term.control`：打开可操作的流
- 日志里不写终端字节、会话记录正文和发送的内容。

## 6. 网页

### 6.1 入口

- **页面**：`AgentDesktop.tsx` 的 `page`（[AgentDesktop.tsx:110](../../src/personal/AgentDesktop.tsx#L110)）增加 `"cli"`。
  - 像 [TodoWorkspace](../../src/personal/todo/TodoWorkspace.tsx) 一样整页渲染 `CliAgentsWorkspace`，接收 `sidebar`、`collapsed`、`onNavigation`、`overlay`。
  - 同时修改 `onPage`（[647](../../src/personal/AgentDesktop.tsx#L647)、[651](../../src/personal/AgentDesktop.tsx#L651)）和页面标题（[662](../../src/personal/AgentDesktop.tsx#L662)）。
- **侧栏**：在 [ContactSidebar.tsx](../../src/personal/components/ContactSidebar.tsx#L49) 的“待办”下面加入口，角标显示等你处理的会话数（`state.cliAgents.waiting`）。
- **可见范围**：MVP 只在浏览器里显示，条件是 `!desktop`，其中 `desktop = window.nex`（[api.ts:102](../../src/personal/api.ts#L102)）。

### 6.2 文件（`src/personal/cli-agents/`）

| 文件 | 作用 |
| --- | --- |
| `CliAgentsWorkspace.tsx` | 两栏布局：左栏是电脑 → 目录 → 会话，右栏是会话页。窄屏时改成单栏切换 |
| `SessionList.tsx` | 分组、状态标签、隐藏、新建 |
| `SessionPane.tsx` | 标题栏（标题、目录、状态、操作）、视图切换、输入框 |
| `TerminalView.tsx` | xterm.js 终端，按需加载 |
| `TranscriptView.tsx` | 会话记录，复用 `RichText`（[AgentDesktop.tsx:101](../../src/personal/AgentDesktop.tsx#L101)）和 [ToolActivityDisclosure](../../src/personal/vendor/rakazo/ToolActivityDisclosure.tsx) |
| `Composer.tsx` | 发送和中断。回车发送不能打断输入法组字，做法同 [AgentDesktop.tsx:772-777](../../src/personal/AgentDesktop.tsx#L772) |
| `NewSessionDialog.tsx` | 选电脑、目录（最近用过的目录，也可手动输入）、Claude 或 Codex |
| `api.ts` | 第 5.4 节的 HTTP 接口 |
| `stream.ts` | WebSocket：订阅、重连（1–30 s 退避加抖动）、二进制帧、心跳 |
| `terminal-session.ts` | 终端流的状态机：未连接、只看、操作、重连、结束。写成纯函数，方便测试 |
| `transcript.ts` | 合并条目：把工具结果并入对应的调用，相邻的工具调用折叠在一起。写成纯函数 |
| `cli-agents.css` | 样式，放在 `.rk-workspace` 作用域下 |

### 6.3 终端视图

- **依赖**：`@xterm/xterm` 6.0.0、`@xterm/addon-fit` 0.11.0、`@xterm/addon-unicode11` 0.9.0，都是 MIT 许可，版本固定。用 `import()` 按需加载，不打进主包；现在的主包是一个约 745 KB 的单文件。
- **模式**：默认只看。点“操作”后以可输入模式重新打开流，并写一条 `cli.term.control` 审计；点“只看”切回。
- **尺寸**：
  - 操作模式：fit 插件按容器大小算出 cols 和 rows，防抖 100 ms 后发 `term.resize`。
  - 只看模式：按终端的实际尺寸渲染；容器太窄时缩放到合适宽度，390 px 宽也能看全一屏。
- **输入**：`onData` 收到的内容作为二进制帧发出。粘贴和输入法组字由 xterm 处理。
- **额度**：`write(data, callback)` 回调累计满 32 KB 时，发一次 `term.credit`。
- **断线**：显示“正在重新连接”，恢复后重新打开流，拿到当前画面。

### 6.4 对话视图

- 打开会话时发 `sub.session`，先显示缓存或第一页，再接收新增的条目。
- “加载更早的记录”按 `before` 翻页。
- 有新内容时自动滚到底部，复用 [bottom-follow.ts](../../src/lib/bottom-follow.ts)。
- 工具调用默认折叠，只显示名称和摘要，展开后看输出；思考过程默认也折叠。

### 6.5 输入框与操作

| 会话状态 | 输入框与操作 |
| --- | --- |
| 在 nex_bot 终端里 | 可以发送；正在运行时显示“中断” |
| 在别处运行 | 输入框不可用，显示“在电脑上运行”；Claude 桌面应用里的会话显示“在 Claude 桌面应用中打开” |
| 已停止 | 显示“继续”。点击后先确认会话没有在别处运行（Core 转给设备检查），再启动终端，切到终端视图 |

“在电脑上打开”只在会话属于 nex_bot 终端时显示。

### 6.6 通知

- 页面标题栏放一个铃铛开关。用户点了它，才请求浏览器的通知权限。
- 开启后，如果页面不在前台时有会话变成“等你处理”，就发一条通知：标题是会话标题，正文是“等你处理”。点通知跳到这个会话。

### 6.7 文案

NexBot 的界面不走 i18n，直接写中文，保持简短：

- 状态：运行中、等你处理、空闲、已停止、电脑离线。
- 按钮：新建、继续、中断、操作、只看、在电脑上打开。
- 错误：按第 4.6 节，一个错误码对应一句话。例如 `open_elsewhere` 显示“这个会话正在电脑上运行”。

不加说明段落。

## 7. 第 2 期及以后的接口

### 7.1 Claude 钩子与审批卡

**插件**

- 插件目录随执行器分发：`cli-agents-plugin/.claude-plugin/plugin.json`（`name: "nexbot"`）和 `hooks/hooks.json`。
- nex_bot 启动 Claude 会话时加上 `--plugin-dir <插件目录>`，插件只作用于这个会话。
- 用到三个事件：
  - `PermissionRequest`：所有工具，`timeout: 1800`。
  - `PostToolUse`：问题已经在终端里答过时，撤回卡片。
  - `Stop`：作为一轮结束的信号。

**钩子命令**

- Windows 上 Claude Code 用 sh 运行钩子命令。本机的官方插件 `claude-security` 就写成 `sh "${CLAUDE_PLUGIN_ROOT}/hooks/hooks.sh"`。
- nex_bot 的钩子是一个脚本，用执行器自带的 Node 运行：Windows 上是 `ELECTRON_RUN_AS_NODE=1 "<NexBot.exe>"`，Mac 上是应用内置的 `node`。
- 需要的路径通过 `terminal.run` 的 `env` 传进去：`NEXBOT_HOOK_NODE`、`NEXBOT_HOOK_PIPE`，以及每个终端各自的 `NEXBOT_HOOK_TOKEN`。

**一次审批的流程**

1. 钩子从 stdin 读入 `hook_event_name`、`session_id`、`cwd`、`tool_name`、`tool_input`、`tool_use_id`。
2. 通过本机管道交给 Agent 桥，等待回答。
3. 按回答输出：
   - **拒绝**：`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"…"}}}`，格式与本机官方插件相同。
   - **允许**：`behavior: "allow"`。如果是 AskUserQuestion，还要带上 `updatedInput`，即原来的 `questions` 加上 `answers`；具体形状由第 0 期确认。
   - **超时、nex_bot 不在线或管道不通**：不输出任何决定，直接退出，交回终端处理。

**Core 端**

- 新表：`cli_agent_requests(id, session_key, tool, summary_json, options_json, status, decided_by, created_at, expires_at)`。
- 新接口：`POST /api/cli-agents/answer {id, decision, answers?}`。
- 新设备消息：`cli.request`、`cli.request.resolved`。

### 7.2 助手工具

在 broker 里新增 `cli.list`、`cli.read`、`cli.start`、`cli.send`、`cli.interrupt`。不能用 `agent.` 前缀，它已经被占用（[runtime.ts:799-801](../../server/personal-os/runtime.ts#L799)）。

要改的地方：

| 改什么 | 位置 |
| --- | --- |
| 动作列表 | [policy.ts:12](../../server/personal-os/policy.ts#L12) |
| 主对话禁用名单（这些工具只能在后台任务里调用） | [policy.ts:28](../../server/personal-os/policy.ts#L28) |
| 参数 | [tool-fields.ts](../../server/personal-os/tool-fields.ts) |
| 工具目录 | [tool-catalog.ts](../../server/personal-os/tool-catalog.ts) |
| 分发 | [runtime.ts:806-922](../../server/personal-os/runtime.ts#L806) |

- `target_kind` 设为 `device`。
- `start`、`send`、`interrupt` 算危险动作，需要审批（[risk.ts:58-66](../../server/personal-os/risk.ts#L58)）。

### 7.3 监督

- **一轮结束的信号**：设备新增消息 `cli.turn {key, turn, ended_at, reason}`。Claude 的来源是 `Stop` 钩子或会话文件里的状态；Codex 的来源是 `task_complete`。
- **执行**：Core 新增 `CliAgentSupervisor`，按开关执行以下动作：临时错误后继续、额度重置后继续、唤醒、生成卡片。安全边界见设计文档第 9 节。
- 每次执行前重读会话；状态和预期不一致就放弃这次执行。
- 开关保存在设置里，默认全部关闭。

### 7.4 分叉成话题

1. 纯函数 `summarizeForTopic(items)` 生成摘要：只取用户消息、助手文字和工具名，从最新往前取，总长不超过 8000 字。
2. 调用 `agents.createTopic(botId, {title, sourceContext})`（[agents.ts:212-220](../../server/personal-os/agents.ts#L212)）建话题。
3. 用 `agents.send` 发出第一条消息。

### 7.5 其他端

- **Mac 电脑端**：把 herdr-core 打进 Mac 应用。Mac 执行器只传 PATH、HOME 和 TMPDIR 三个环境变量（[LocalDevice.swift:190-197](../../apps/apple/NexBotMac/LocalDevice.swift#L190)），所以启动 herdr-core 之前，要先取得用户登录 shell 的环境变量。
- **Android**：WebView 的 CSP 是 `connect-src 'none'`，需要一条原生的 WebSocket 通道，用一次性票据代替 Cookie 鉴权。
- **Mac / iOS**：SwiftUI 界面。

### 7.6 nex_bot 终端之外的会话

- **Claude 收件箱**：
  - 接口是一个命名管道，令牌在 `sessions/<pid>.<hash>.key`，消息格式见 Persona 的 `claude-integration.md`。
  - 按 CLI 版本逐个开放；令牌只在电脑端读取，不离开电脑。
- **Codex**：加入共享的守护进程里正在运行的线程。
- **Codex App**：只存在于它的数据库里的会话。

## 8. 测试与验证

### 8.1 单元测试

用 vitest，范围是 `server/**/*.test.ts` 和 `src/**/*.test.ts`。

| 文件 | 覆盖 |
| --- | --- |
| `server/personal-os/cli-agents-node/hc-frames.test.ts` | 帧编码、分片、单帧上限 |
| `server/personal-os/cli-agents-node/hc.test.ts` | 用本地管道上的假 JSON-RPC 服务代替 herdr-core：hello 版本检查、调用、错误、断线重连 |
| `server/personal-os/cli-agents-node/claude.test.ts` | 在临时配置目录里放合成的 `sessions/*.json` 和会话记录：活进程判断、pid 复用、标题优先级、跳过子 Agent、14 天窗口 |
| `server/personal-os/cli-agents-node/codex.test.ts` | 合成的 rollout：排除规则、续写段合并、状态判断、会话名 |
| `server/personal-os/cli-agents-node/items.test.ts` | 逐条核对 Claude 和 Codex 的映射表；截断；忽略未知类型 |
| `server/personal-os/cli-agents-node/reader.test.ts` | 增量读取、不完整的行、文件截断后重置、向前翻页 |
| `server/personal-os/cli-agents-node/launch.test.ts` | argv、`.cmd` 包装、参数白名单、cwd 校验、会话在别处运行时拒绝继续 |
| `server/personal-os/cli-agents-node/bridge.test.ts` | 假 herdr-core 加假 DCP：操作、去重、流、额度；暂停只断开流，不结束终端 |
| `server/personal-os/cli-agents/hub.test.ts` | `createPersonalApp` 加一个用 `ws` 模拟的设备（做法同 [sender-device.test.ts](../../server/personal-os/sender-device.test.ts)）：能力声明、全量与增量列表、缓存上限、操作超时变为 unknown、设备离线 |
| `server/personal-os/cli-agents/stream.test.ts` | Cookie 鉴权、拒绝错误的 Origin、拒绝没有 Cookie 的连接、多账号路由、二进制转发、缓冲上限、心跳 |
| `src/personal/cli-agents/terminal-session.test.ts` | 终端流状态机 |
| `src/personal/cli-agents/transcript.test.ts` | 条目合并 |
| `src/personal/cli-agents/CliAgentsWorkspace.test.ts` | 用 happy-dom，`vi.mock` 模拟接口：列表、状态文字、按钮是否可用 |
| `electron/nex-client-device.node-test.mjs`（追加用例） | `cliAgents` 开关和 `state()` 里的新字段 |

测试数据全部是合成的，不用真实的会话记录。

### 8.2 集成与冒烟

**`scripts/smoke-cli-agents.mjs`**（在 Windows 上运行）：

1. 运行 `build-personal.mjs --core` 和 `build:client`。
2. 在临时目录里启动 fixture Core。
3. 启动执行器包：
   - 用真实的 herdr-core，配独立的 `HC_SESSION`；
   - 用临时的 `CLAUDE_CONFIG_DIR` 和 `CODEX_HOME`；
   - 终端里运行假的交互程序 `scripts/testing/fake-tui.mjs`。它会回显输入、切换等待状态、写合成的会话记录。
4. 用 CDP 驱动无头 Chrome，依次走一遍：打开列表、打开终端、打字并看到回显、切到对话视图、中断、继续。
5. 在 1440 和 390 两种宽度下截图，存到 `release/`。

**打包后的 Windows 客户端**：

1. 运行 `node scripts/smoke-shell-login.mjs --exe=<exe>`。
2. 检查安装包里有 `client-executor/herdr-core/herdr-core.exe`。
3. 运行它的 `--version`，确认是 0.1.21。

### 8.3 真实 CLI 验收

- 在独立的 Windows 用户或虚拟机里进行，用测试账号登录 Claude Code 和 Codex，不碰日常用的会话和配置。
- 要覆盖的场景：
  - 新建 Claude 会话和 Codex 会话；
  - 远程打字；
  - 在电脑上打开同一个终端，两边同时输入；
  - 用 `--resume` 继续会话；
  - 会话在别处运行时，拒绝继续；
  - 暂停后终端还在；
  - 客户端重启后能重新接上。

### 8.4 合并前必须通过

- `pnpm typecheck`
- `pnpm lint`
- 受影响的 vitest 用例
- `node --test "electron/*.node-test.mjs"`
- `scripts/smoke-cli-agents.mjs`
- 打包冒烟

已经失败的用例，要在基线提交上复跑，确认不是这次改动引入的。

### 8.5 验证记录

- 写 `docs/verification/agent-mode-mvp-<日期>.md`。引用测试文件时写完整的目录路径。
- 在 `docs/verification/README.md` 里加上链接。
- 发布时另写一份发布记录，并按 AGENTS.md 同时更新 README 和官网首页。

## 9. 交付拆分

按顺序做，每一面单独提交。估算按一人全职计算，只供排期参考。

| 步 | 内容 | 主要文件 | 估算 |
| --- | --- | --- | --- |
| 0 | 第 0 期实测（第 11 节），结论写进验证记录，并回填到本文 | `release/` 下的临时脚本 | 3–4 天 |
| 1 | 打包 herdr-core | `scripts/prepare-herdr-core.mjs`、`build-client-executor.mjs` | 1–2 天 |
| 2 | herdr-core 客户端 | `hc.ts`、`hc-frames.ts` 及测试 | 2–3 天 |
| 3 | 会话发现与解析 | `claude.ts`、`codex.ts`、`liveness.ts`、`items.ts`、`reader.ts` 及测试 | 4–5 天 |
| 4 | Agent 桥与接线 | `launch.ts`、`streams.ts`、`bridge.ts`、`local-store.ts`、`node.ts`、`nex-client-*`、开关 | 3–4 天 |
| 5 | Core | 迁移、`hub.ts`、`devices.ts`、`routes.ts`、`upgrade.ts`、`stream.ts`、`workspaces.ts` 及测试 | 4–5 天 |
| 6 | 网页 | `src/personal/cli-agents/*`、`AgentDesktop.tsx`、`ContactSidebar.tsx` | 5–7 天 |
| 7 | 冒烟、验证、发布 | `smoke-cli-agents.mjs`、`fake-tui.mjs`、验证记录；部署 Core，发布 Windows 客户端 | 3–4 天 |

MVP 合计约 25–34 天。第 2 期约 10–15 天，第 3 期约 10–20 天，第 4 期按 CLI 版本另外估算。

**发布顺序**：

1. 先部署 Core。这时还没有设备声明这项能力，页面显示“没有可用的电脑”。
2. 再发布 Windows 客户端，版本号相应提升。
3. Android 和 Apple 这次不重新打包。

## 10. 风险与对策

| 风险 | 影响 | 对策 | 何时确认 |
| --- | --- | --- | --- |
| ConPTY 会请求 win32-input-mode，xterm.js 不支持 | 远程按键异常 | 实测普通 VT 输入：中文、粘贴、方向键、Esc、Ctrl+C。不行的话，在 Windows 终端视图里把按键转成 win32-input-mode 序列 | 第 0 期 |
| herdr-core 协议还是 0.x | 升级后不兼容 | 固定版本；`hello` 时检查版本；每次升级前跑第 8.1、8.2 节的测试 | 每次升级 |
| herdr-core 的 Windows 版可能没有签名 | 被 SmartScreen 或杀毒软件拦截 | 实测打包后能否运行；被拦截时报 `hc_unavailable` 并说明原因 | 第 0 期 |
| Claude 和 Codex 的会话文件格式没有公开文档 | 升级后解析出错 | 容错解析，跳过不认识的类型；每个 CLI 版本保留一份样本；解析失败的次数显示在设备状态里 | 持续 |
| Codex 没有等待信号 | Codex 会话不会提示“等你处理” | 实测三种来源：herdr-core 状态、读屏、Codex 钩子。找到之前只显示“运行中” | 第 0 期 |
| 新建的 Codex 会话和终端对不上 | 列表里显示错误的会话 | 第 0 期定方案，备选做法见第 3.5 节 | 第 0 期 |
| nex_bot 终端在运行时，用户又在桌面应用里打开同一个会话 | 两个进程同时写入 | 继续之前检查；界面上提示；实测 Claude 桌面应用遇到这种情况会怎样 | 第 0 期 |
| 经过中转的延迟和带宽 | 打字有延迟 | 用二进制帧，合并小块；实测往返延迟和每秒字节数 | 第 0 期 |
| 远程终端等于远程 shell | 安全风险 | 只允许本人；校验 Origin；写审计；暂停时转为只看；设备上有开关 | 设计时 |
| 要扫描大量会话记录 | 占用电脑资源 | 增量扫描，只读文件头尾，限制数量；实测 CPU 和内存占用 | 第 0 期 |
| herdr-core 里启动的程序拿到的环境变量和用户终端不同 | CLI 读不到代理设置或密钥 | 实测 Claude 和 Codex 在 herdr-core 里能否正常登录、联网 | 第 0 期 |
| 迁移编号和并行开发的分支冲突 | 合并冲突 | 合并时取下一个空闲编号 | 合并时 |

## 11. 第 0 期实测清单

在隔离环境里逐项验证：独立的 Windows 用户或虚拟机，或者临时的 `HC_SESSION` 加临时配置目录。结论写进 `docs/verification/agent-mode-spike-<日期>.md`。

1. **拉起与常驻**：用哪个命令拉起 herdr-core 的核心最合适？客户端退出、暂停、重启之后，终端还在不在？
2. **启动 CLI**：
   - herdr-core 能否直接运行 `claude.cmd`，还是必须包一层 `cmd.exe /d /s /c`？
   - `codex.exe` 能否直接运行？
   - 交互模式下 `--session-id` 是否生效？
3. **输入**：用 xterm.js 经 Core 中转打字，在 Claude 和 Codex 的交互界面里，中文、粘贴、方向键、Esc、Ctrl+C 是否都正常？
4. **发送**：电脑前有人正在输入时，`terminal.send` 会不会等他输完？
5. **继续**：
   - `claude --resume` 能否接着另一个进程里已停止的会话（包括桌面应用的会话）？新的回合能否在桌面应用里看到？
   - 已有写入方时，`codex resume` 报的是什么错？
6. **运行中检测**：
   - Claude：用 `sessions/*.json` 加 `procStart` 判断进程是否存活，是否可靠？
   - Codex：写锁文件和进程检查，能否判断出有没有写入方？
7. **Codex 的等待信号与新会话**：
   - herdr-core 状态、读屏、钩子这三种等待信号，哪种可用？
   - 新建的会话怎么和终端对上？
8. **钩子**（为第 2 期准备）：
   - 用 `--plugin-dir` 加 `PermissionRequest` 时，允许和拒绝的输出格式是什么？
   - AskUserQuestion 的 `updatedInput.answers` 是什么形状？
   - `timeout: 1800` 能否让钩子长时间等待？超时后会不会回到终端里提示？
9. **环境变量**：在 herdr-core 里启动的 CLI，能否读到用户的代理和网关配置？
10. **性能**：
    - 经 Cloudflare → 首尔 → 东京中转，打字的往返延迟是多少？
    - Claude 交互界面每秒输出多少字节？
    - 扫描 300 个会话时 CPU 和内存占用多少？
11. **CSP**：在 Chrome、Edge、Safari 上，`connect-src 'self'` 是否放行同源的 `wss:`？
