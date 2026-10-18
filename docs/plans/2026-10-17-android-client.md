# Android 客户端技术方案（NexBot Personal AI OS）

状态：设计草案，2026-10-17；P0（两个 Core 端点）与 P1（`:core` 协议层、`:app` 可用闭环、CI job）
已完成，并通过 JVM/Robolectric 测试与一次模拟器端到端（见 §11 的 P0 / P1 实现记录与
`docs/verification/android-client.md`）。下一步 P2。
范围：在 `nex_bot` 仓库新增 `android/` 原生客户端。协议契约以当前
`server/personal-os/` 实现为准，不另起一套后端。

## 1. 结论

1. **原生 Compose 瘦客户端**，与桌面薄壳（`electron/nex-client-main.mjs`）同一角色：
   只负责连接、登录、展示与写入，Agent、模型凭据、消息、记忆、例行任务全部留在 Core。
2. **两个 Gradle 模块**：`:core`（纯 Kotlin/JVM，协议、SSE、状态机、纯规则，可在 JVM 上跑全部测试）
   与 `:app`（Compose UI、Keystore、通知、分享入口）。`android/` 独立构建，不并入 pnpm。
3. **复用 Core 现有 HTTP + SSE 契约**，不新增手机专用协议；`/api/state` + `/api/events` +
   `/api/agents/*` 已经覆盖 v1 需要的全部能力。
4. **建议补两个 Core 端点**（都是小改动、向后兼容，详见 §11 的 P0）：
   `GET /api/state?view=summary`（手机轮询只取摘要）与 `POST /api/auth/refresh`
   （8 小时会话内免密续期）。这两个端点已于 2026-10-17 实现。
5. **不移植** 2026-10-06 删除的旧 Android 应用（`0d6708c5`）。它说的是旧 companion sidecar
   协议（`companion/src/routes.ts` 白名单、`/api/bots`、`/api/threads`、`/api/companion/*`），
   与 Core 的 `/api/agents/*`、Bearer 会话、`state`/`events` 不是一回事；只回收其中的纯模块思路
   与已经调好的版本矩阵。

## 2. 现状与约束

### 2.1 可以依赖的现状

| 事实 | 证据 |
|---|---|
| Core 是唯一的业务后端 | `server/personal-os/index.ts`（`createPersonalApp`，33 张表） |
| 桌面客户端已经是薄壳：连接页 + `nex` cookie + 远程 UI | `electron/nex-client-main.mjs` |
| 客户端身份 v1：发现、密码登录事务、会话、注销 | `index.ts:134`、`:139-150`、`:161-172`、`identity.ts` |
| 一次登录创建独立、可撤销的会话 | `identity.ts:98-128` |
| 实时同步 = SSE 变更游标 + HTTP 回拉正文 | `index.ts:176-190`、`runtime.ts:205` |
| 手机可用的只读快照 | `index.ts:182`（`/api/state`） |
| 发送幂等 | `agents.ts:93-127`（`clientId` → `agent_input_receipts`） |
| 审批绑定参数哈希，先到先得 | `runtime.ts:280-304` |
| 旧 Android 构建/CI/版本矩阵仍可从历史取用 | `git show 0d6708c5^:android/app/build.gradle.kts`、`.github/workflows/ci.yml` |

### 2.2 硬约束

| 约束 | 影响 |
|---|---|
| 会话最长 8 小时（`identity.ts:101`），界面文案明写「每台设备的登录最长八小时，到期后重新登录」（`panels.tsx:115`） | 手机需要免密续期（已提供 `auth/refresh`）；见 §5.3 |
| 只有 NexorAI 账号密码登录（`/api/auth/start`+`respond`），没有配对码 | 冷启动必须能复用已保存的 token，`POST /api/session` 复验 |
| 远端账号登录要求 HTTPS 或私网来源（`index.ts:140`、`nex-client-main.mjs:57`）；桌面客户端只接受 https 或私网 http 根地址（`nex-client-main.mjs:22-27`） | 连接页在本地先做同样的地址校验（另加 tailnet 名字，见 §5.1），错误文案对齐 |
| LAN 直连需要 Core 以 `--host=0.0.0.0` 启动，且 `Host` 必须是本机地址之一（`index.ts:112-115`、`service.ts:14`） | 连接失败要能区分「网络不通」与「Core 未开放 LAN」 |
| `/api/state` 每次返回全部记忆正文、100 条日志、200 条任务（`store.ts:306-318`） | 手机不能照抄桌面「每 150ms 全量刷新」（`AgentDesktop.tsx:115-127`）；`?view=summary` 已提供 |
| SSE 帧只带游标，不带正文增量 | 正文必须按 `seq` 回拉；渲染节流要做在客户端 |
| Core 个人版没有附件/图片管线 | v1 聊天只有文本、Markdown、工具预览 |
| Core 个人版没有实时语音/TTS 路由 | 语音留到 P4，且要先有 Core 能力 |

## 3. 目标与非目标

### 3.1 v1 目标（可用即交付）

- 一台 Android 手机连上**你自己的 Core**：地址 + NexorAI 账号登录，重启后自动恢复。
- 首页 Agent 列表：未读、最近一句、正在工作状态、待审批数量。
- 聊天：分页历史、流式回复、发送（幂等重试）、停止、恢复、加载更早、Markdown、工具步骤。
- 审批：在聊天里看到 Agent 正在等什么，查看参数、批准/拒绝。
- 例行任务：查看、启用/停用、立即执行（新建/编辑放 P2）。
- 账号：当前会话信息、登录设备列表、撤销、退出。
- 前台 + 短时后台的本地通知（新回复、待审批）；明确不承诺后台可靠推送。

### 3.2 非目标

- 本地 Agent/本地模型/本地数据库副本；离线读写。
- 模型 API Key、记忆插件、连接器授权、设备节点、归档等主机级配置（留在桌面）。
- 推送（FCM）、语音、Live Call、浏览器控制、云电脑、分享图片。
- 把 Core 的 Web UI 塞进 WebView（见 §12 被否决方案）。
- 页面与桌面逐像素对齐；只保证**文案与状态语义**一致。

## 4. 总体架构

```text
┌──────────────────────────── Android 进程 ────────────────────────────┐
│ :app  Compose UI ── ViewModel ── SyncController ── Notifications      │
│                                        │                              │
│ :core  CoreClient (OkHttp, Bearer)     │  EventStream (SSE, 游标)     │
│        SessionStore (接口)             │  SyncEngine (纯状态机)        │
│        Wire models (@Serializable)     │  Copy/规则 (纯函数)           │
└───────────────┬────────────────────────────────┬─────────────────────┘
                │ HTTPS（或私网 http / tailnet）   │
                ▼                                 ▼
        Core  /api/*（Bearer 或 nex cookie）   /api/events（SSE, Last-Event-ID）
                │
        SQLite + Agent worker + 记忆 + 模型凭据（全部在 Core）
```

分层规则：

- `:core` 不允许 import Android 类（除测试内的 OkHttp/MockWebServer）。所有业务规则在这里，
  可以只用 JVM 测试证明。
- `:app` 只做生命周期、输入、渲染、系统集成，不放协议判断。
- 与桌面的差异只允许出现在「呈现方式」，不允许出现在「什么时候算忙、什么时候能发」这类语义上。

| 模块 | 职责 | 依赖 |
|---|---|---|
| `Wire` | `/api/state`、messages、approval、routine 的 `@Serializable` 模型；`ignoreUnknownKeys` + 未知枚举降级 | kotlinx.serialization |
| `CoreClient` | 每个端点一个 suspend 函数；15s 超时；Bearer；错误映射为 `CoreError(status, message, code)` | OkHttp |
| `EventStream` | 原始字节 SSE 解析（`id`/`event`/`data`、多行 data、CRLF、注释、`revoked`）；`Flow<SyncFrame>`；指数退避 + 游标 | OkHttp |
| `SyncEngine` | 快照 + 尾部回拉的合并；节流；`reset` / `privacyEpoch` / `bootId` 处理；暴露不可变 UI 状态 | 纯 Kotlin |
| `SessionStore` | 连接与 token 的读取/写入接口（Android 实现走 Keystore） | 接口 |
| `Copy` | 状态、工具、审批的中文文案表（与桌面同源，见 §8.4） | 纯 Kotlin |
| `Markdown` | 块级 + 行内解析为中间结构（不依赖 Compose） | 纯 Kotlin |
| `TurnRules` | `processing` 判定、合并去重、未读清零时机 | 纯 Kotlin |

### 4.1 端点清单

全部走现有 Core 路由（`server/personal-os/index.ts`）。登录前的
`/api/client/identity`、`/api/session`、`/api/auth/start|respond` 不需要 Bearer；
其余业务请求都要 `Authorization: Bearer <token>`；POST 必须 `Content-Type: application/json`。

| 方法 | 路径 | 请求 | 响应要点 | 用途 |
|---|---|---|---|---|
| GET | `/api/client/identity` | — | `{version:1, coreId, loginRequired, initialized, loginMethods:["password"]}` | 连接页发现与校验 |
| POST | `/api/auth/start` | `{account, name}` | `{transactionId, bindingToken, stepId, challenge, expiresAt}` | 登录第 1 步 |
| POST | `/api/auth/respond` | `{transactionId, bindingToken, stepId, password}` | `{token, sessionId, coreId, expiresAt, protocol, version}` | 登录第 2 步 |
| POST | `/api/session` | `{token}` | `{authenticated, protocol, sessionId, coreId, expiresAt}` | 冷启动复验 |
| POST | `/api/auth/logout` | `{}` | `{ok:true}` | 退出（撤销本会话） |
| GET | `/api/state` | — | 见 §4.2 | 首页、抽屉、兜底刷新 |
| GET | `/api/events` | `Last-Event-ID` 头或 `?after=` | SSE：`change` / `revoked` | 实时通知 |
| GET | `/api/agents/messages` | `?bot=&after=` 或 `?before=` | `{messages, streaming, hasMore, sync}` | 历史、尾部、流式正文 |
| POST | `/api/agents/input` | `{botId, text, clientId}` | 202 `{taskId}` | 发送 |
| POST | `/api/agents/read` | `{botId, seq}` | `{ok:true}` | 已读（owner-wide） |
| POST | `/api/approvals` | `{id, hash, allow}` | `{ok:true}` | 批准/拒绝 |
| POST | `/api/cancel` / `/api/resume` | `{taskId}` | `{ok:true}` | 停止 / 继续 |
| GET | `/api/preview` | `?callId=` 或 `?path=` | `{kind, title, content, …}` | 工具与文件预览（只读） |
| GET | `/api/clients` | — | `{sessions, currentSessionId}` | 登录设备 |
| POST | `/api/clients/revoke` | `{sessionId}` | `{ok:true}` | 撤销某台设备 |
| POST | `/api/routines/toggle` | `{id, version, enabled}` | `{ok:true}` | 启用/停用 |
| POST | `/api/routines/run` | `{id, clientId}` | `{ok:true}` | 立即执行 |
| POST | `/api/routines` | `{botId,name,prompt,scheduleKind,timeZone,localTime/intervalMinutes/runAt,id?,version?}` | `{id}` | 新建/编辑（P2） |
| GET | `/health` | — | `{app, backend, runtime, accountWorkspaces?}` | 探活，无鉴权 |
| GET | `/api/state?view=summary` | — | 摘要 + `"view":"summary"` | 已实现，见 §11 的 P0 实现记录 |
| POST | `/api/auth/refresh` | `{}` | 同 `auth/respond` | 已实现，见 §11 的 P0 实现记录 |

### 4.2 `/api/state` 字段速查

| 字段 | 内容 | 手机用法 |
|---|---|---|
| `sync` | `{cursor, privacyEpoch, coreId, bootId}` | 缓存分区（`coreId`）与失效判断 |
| `bots` | 联系人 + `unread_count`、`last_message`、`last_message_at`、`version`、`policy_*`、`expertise_json` | 首页列表、能力标签 |
| `tasks` | 最近 200 条任务（含 `active_tool`、`status`、`objective`） | 工作指示、停止、助手详情的工作页 |
| `approvals` | 待处理审批（含 `argument_hash`、`arguments_json`、`bot_id`、`task_id`） | 审批卡与角标 |
| `routines` / `occurrences` | 例行任务与最近 100 次执行 | 助手详情 → 工作 |
| `memories` | 记忆文档**含正文** | 手机不展示记忆正文；摘要视图可省正文 |
| `delegations` | 最近 100 条 A2A 关系 | 同伴消息标记 |
| `devices` / `onlineDevices` | 设备目录与在线集合 | 暂不展示（P3 设备页） |
| `journal` | 最近 100 条完成记录 | 工作页「最近执行」 |
| `connectors` / `usage` / `config` / `memoryEngine` / `memoryPlugin` / `node` | 主机配置与用量 | 概览只读展示 |

## 5. 身份、会话与安全

### 5.1 连接（Connection）

```kotlin
data class Connection(
  val origin: String,        // 规范化后的 http(s) 根地址
  val publicCoreId: String,  // /api/client/identity 的 coreId，用于识别「同一台 Core」
  val workspaceCoreId: String?, // /api/state 的 sync.coreId，用于缓存分区
  val name: String,          // 用户可见的备注名
  val account: String?,      // 登录时输入的邮箱，仅用于回填
  val token: String,         // 43 字符 base64url
  val sessionId: String,
  val expiresAt: Long,
)
```

- 地址规范化与桌面一致（`nex-client-main.mjs:22-27`）：必须是根地址，不能带 path/query/fragment/凭据；
  `https` 任意；`http` 只允许 loopback、`127/8`、`10/8`、`172.16/12`、`192.168/16`。
  对 `*.ts.net` 额外允许 `http`：tailnet 内由 WireGuard 加密（iOS 用 ATS 例外覆盖同一场景，
  `docs/ios-companion.md:177-180`），但 UI 仍显示「本地明文连接」提示。`.local` 不放行
  （Bonjour 名字同样只是局域网明文，v1 也没做 NSD 发现），用户改填 IP。
- **tailnet 的一个已知限制**：Core 只允许私网来源或 HTTPS 发起账号登录（`index.ts:140`），
  而 Tailscale 地址是 `100.64/10`，不在 Core 的私网判断里。所以首次登录必须走 HTTPS 的 Core
  （公网地址或 Tailscale Serve），已完成登录的设备之后可以继续用 `http://…ts.net` 恢复会话
  （`POST /api/session` 没有这条限制）。客户端在登录收到 426 时按这句话提示，不要误导成「网络不通」。
- 多账号：同一 origin 可能对应多个 NexorAI 账号的独立工作区（`workspaces.ts`，服务端按 token 哈希路由）。
  因此**缓存分区键必须是 `origin + sync.coreId`**；`publicCoreId` 只能用来判断「是不是同一台服务器」。
- v1 保存多条连接、同时只有一条活跃；切换连接 = 换 token + 清空内存状态（`sync` 不同就重建）。
  同一 origin 重新登录另一个账号时，旧账号的 token 与缓存必须一起清除。

### 5.2 登录与恢复时序

```text
冷启动
  ├─ 有 token → POST /api/session {token}
  │     ├─ 200 {authenticated:true, coreId, sessionId, expiresAt} → GET /api/state → SSE
  │     └─ 401（或返回的 coreId 与保存值不一致）→ 清除 token → 登录页（回填地址与账号）
  └─ 无 token → 连接页
登录
  1) GET  /api/client/identity
     校验 version==1 && coreId 非空 && loginRequired==true && loginMethods 含 "password"
     initialized==false → 「后端尚未关联账号，请先在服务器运行 init」
  2) 地址检查：https，或私网 IP 的 http 才继续；`http` + `*.ts.net` 允许尝试，
     但服务端可能 426（§5.1 的 tailnet 限制），按 426 文案处理
  3) POST /api/auth/start {account, name}   → {transactionId, bindingToken, stepId, expiresAt}
  4) POST /api/auth/respond {transactionId, bindingToken, stepId, password}
     → {token, sessionId, expiresAt, coreId, protocol, version}
  5) 校验返回 coreId == identity.coreId，保存 Connection，进入主界面
```

请求细节（必须与桌面一致，否则会被 Core 拒绝）：

- `Content-Type: application/json`：`/api/auth/*` 的 POST 强制要求（`index.ts:133`）。
- 所有业务请求带 `Authorization: Bearer <token>`；不依赖 cookie。
- 15 秒超时；跟随重定向要关闭（避免 token 被带去别的主机）。
- `name`（登录设备名）用 `Build.MODEL + " · Android"`，在桌面「登录设备」里可辨认。

### 5.3 8 小时会话的三种做法

| 方案 | 做法 | 代价 |
|---|---|---|
| A 重新登录 | 401/到期 → 登录页，账号回填，密码可用 Google 自动填充 | 每天至少一次手动登录 |
| B 免密续期（已实现） | `POST /api/auth/refresh`（Bearer）→ 复用 `identity.verify()` 的上游校验，轮换本地 token，`expiresAt=min(上游, now+8h)`；写 `identity.refresh` 审计 | 手机在前台且剩余寿命 < 30 分钟时静默续期 |
| C 直接把 8 小时改成 30 天 | 仅改 `identity.ts:101` | 安全面变大，且与现有产品文案冲突，不推荐 |

已实现的取舍，客户端要照着做：

- 续期**不受**登录那条「私网或 HTTPS」限制：它携带的是已有的 Bearer，不是密码，所以在
  tailnet/LAN 的 http 上也能续（§5.1 的 tailnet 限制只卡首次登录）。
- 续期与登录共用同一个尝试预算（20 次/分钟/地址）；正常手机每几小时才调一次，不受影响。
- 令牌会被轮换，旧令牌立刻失效；并发续期时未抢到的那次返回 **409**，客户端应直接使用它已经
  收到的新令牌重试，不要重新登录。
- 续期写一条 `identity.refresh` 审计记录，`expiresAt` 仍然是 `min(上游过期, now + 8h)`。
- 会话一旦过期或撤销就无法再续，只能重新登录——续期凭证就是现有 token，这是有意的边界。

### 5.4 传输与地址安全

- 生产默认 origin：`https://bot.nexorai.com.cn`（与桌面 `defaultOrigin` 一致）。
- 明文 HTTP 只发生在私网/tailnet，和桌面、iOS 文档的口径一致：**信任该网络**。UI 上给一条
  常驻小字提示「当前为本地明文连接」，不把它说成加密。
- Android 的 `networkSecurityConfig` 无法表达 IP 段，因此**平台层允许 cleartext，规则由应用层强制**
  （连接页 + `CoreClient` 双重校验），并在验收里覆盖「公网 http 被拒」。
- 不引入 WebView、不引入证书固定；生产走标准 TLS。

### 5.5 凭据存储

- token 用 Android Keystore 里的 AES-GCM 密钥加密后写入私有 DataStore（`androidx.datastore`），
  密钥不可导出；文件与 DataStore 全部排除备份（`allowBackup=false`、`dataExtractionRules` 排除）。
- 密码永不落盘、永不进日志；登录表单用 `password` 输入类型以启用自动填充。
- 退出登录 = 先 `POST /api/auth/logout`（失败也继续）→ 删 token → 清内存 → 回连接页。
- 日志（含 OkHttp logging，如开启）不得输出 `Authorization` 与 `/api/auth/respond` 的 body。
- 桌面端「登录设备」列表会显示手机这次登录；撤销后，SSE 会收到 `event: revoked`，客户端必须
  立刻清屏并回登录页（`index.ts:39`、`:95`）。

## 6. 本地数据

v1 **不引入 Room、不缓存消息正文**：Core 是唯一事实来源，重新连接本来就要拉最新页；
手机离线时读旧消息不属于 v1 目标。这样少一个 schema、少一次隐私清理面。

| 数据 | 位置 | 说明 |
|---|---|---|
| 连接列表与 token | Keystore 加密 + DataStore | 不含密码 |
| 当前选中 Agent | DataStore | 冷启动恢复 |
| 草稿 | DataStore（每 Agent 一条，上限 100 条/2KB） | 发送成功即删 |
| 主题、通知开关 | DataStore | |
| 内存状态 | ViewModel `StateFlow` | 进程结束即丢 |

发送幂等：每条消息生成一次 `clientId`（UUID），**重试复用同一个**；Core 用
`agent_input_receipts` 去重（`agents.ts:93-127`），所以「点两次发送」和「网络失败后重试」都不会重复。

隐私：`sync.privacyEpoch` 或 `sync.bootId` 变化、收到 `reset`、收到 `revoked`、退出登录时，
一律清空内存中的消息、审批、记忆与工具预览。

## 7. 同步引擎

### 7.1 SSE 语义（Core 现状）

```text
GET /api/events            Authorization: Bearer …   （也接受 Last-Event-ID / ?after=）
id: <cursor>
event: change
data: {"cursor":123,"privacyEpoch":4,"coreId":"…","bootId":"…","reset":false}

（每 15 秒心跳会主动发一帧 change，index.ts:86-103）
event: revoked
data: {}
```

- `change` 只说明「有变化」与最新游标，**不说明变了什么**。
- `reset:true` 表示游标已经不可续（保留窗口 10,000 条，`sync.ts:14`），客户端必须重取快照。
- 心跳 15 秒，所以 45 秒无帧即判定连接假死，主动断开重连。
- 重连用 `Last-Event-ID: <最后处理的 cursor>`，新连接用 `?after=<cursor>`。

### 7.2 两层刷新（与桌面的关键差异）

| 层 | 触发 | 请求 | 节流 |
|---|---|---|---|
| Tail（便宜） | 任意 `change`，且当前打开了聊天 | `GET /api/agents/messages?bot=<id>&after=<最后 seq>`（≤200 行，通常 0 行） | 120ms 合并；无正在执行的任务时降到 1s |
| Snapshot（贵） | 连接成功、`reset`、epoch/boot 变化、自己写过之后、回到前台、每 10s 一次兜底 | `GET /api/state?view=summary` | 最短 2s 间隔；后台时停止 |

- 若 Core 不认识 `view=summary`（老版本），响应里没有 `"view":"summary"`；客户端按完整
  `/api/state` 处理，并把兜底间隔从 10s 放宽到 15s，不报错。
- `after` 一页最多 200 条，满 200 时 `hasMore` 为真，要一直拉到不满为止（桌面的循环写法，
  `AgentDesktop.tsx:95-101`）；`before` 一页 100 条，用于「加载更早」。
- **绝不在每个 token 帧上重取 `/api/state`**（桌面 150ms 全量刷新的做法在蜂窝网络上是不可接受的）。
- 流式正文：`change` → Tail 取到 `streaming[].text` → 替换气泡文本。Markdown 解析按
  「文本变化 + 至少 120ms 间隔」触发，长回复不至于每 token 解析一次。

### 7.3 重连与失败

| 情况 | 处理 |
|---|---|
| 网络断开 / 45s 无帧 | 关闭流，退避重连：0.5s → 1s → 2s → 4s → 8s（上限 10s，±20% 抖动） |
| `reset:true` | 清空已加载消息 → 全量 `/api/state` → 重新拉当前聊天最新页 → 用新游标继续 |
| `revoked` 或 401 | 停止所有请求，清空敏感状态，回登录页（文案：登录已过期或被撤销） |
| 400（业务拒绝，如「审批已失效」「例行任务已修改，请刷新」） | 立即 Snapshot，让界面按服务器状态重画；不重试同一请求 |
| 429 | 保留输入，提示稍后重试；登录页限流 20 次/分钟/地址 |
| 426 | 「在 tailnet/远端首次登录需要 HTTPS 地址」，不重试（见 §5.1） |

### 7.4 前后台

- 前台：SSE 常开 + Snapshot 兜底。
- 退到后台：保留 60 秒宽限（够切个应用），然后关闭 SSE；**不承诺后台实时消息**（与 iOS 文档同样的
  诚实口径）。
- 回到前台：立刻 Snapshot + 从最后游标重连；若失败按 7.3 处理。
- 通知：进程存活期间收到非当前 Agent 的新回复、新审批时发本地通知；Android 13+ 请求
  `POST_NOTIFICATIONS`。点击通知进入对应 Agent / 审批。
- P3 才评估 FCM（需要 Core 侧设备推送注册、token 表与隐私说明）与「保持连接」前台服务（耗电、合规）。

## 8. 界面与信息架构

### 8.1 屏幕

| 屏幕 | 内容 | 数据来源 |
|---|---|---|
| 连接 / 登录 | 地址、账号、密码、记住连接、错误 | `/api/client/identity`、`auth/start`、`auth/respond`、`session` |
| Agent 列表（首页） | 头像、名字、最近一句、未读、工作指示、待审批角标；搜索；新建 Agent（P2） | `state.bots`（`agents.contacts()` 已含 unread/last） |
| 聊天 | 历史、流式、工具步骤、A2A 标记、审批卡、处理中、发送/停止/引用/复制 | `agents/messages`、`state.approvals`、`state.tasks`、`state.delegations` |
| 助手详情（二级页，`工作` / `设置`） | 工作：任务、最近执行、例行任务列表/开关/立即执行/编辑；设置：基础信息、身份编辑；`资料` 页已从 Windows 移除，手机不做 | `state.tasks`、`state.routines`、`bots.instructions` |
| 例行任务 | 助手详情 → 工作内的列表、开关、立即执行、下次时间；新建/编辑（P2） | `state.routines`、`state.occurrences` |
| 账号与连接 | 当前账号、过期时间、登录设备列表、撤销、退出、其他已保存 Core | `auth/status`、`clients` |
| 工具/文件预览 | 工具调用的参数与结果、文件内容（只读） | `/api/preview?callId=` / `?path=` |

单 Activity + 手写导航状态（旧应用的做法，少一个依赖）；返回键统一走返回栈。

### 8.2 聊天细节

- 行类型：自己 / Agent / 系统 / 同伴（`role` + `kind` + `a2a_direction`）；日期分隔。
- Markdown 范围对齐 `docs/ios-companion.md` 的实现边界：段落、标题、列表、任务列表、引用、分隔线、
  围栏代码、顶层表格（横向滚动）；行内粗体/斜体/删除线/代码/链接。表格在列表或引用内保持纯文本。
  链接用 Custom Tabs 打开；行内代码若是文件路径，点击调 `/api/preview?path=`。
- 工具步骤：每条助手消息附可折叠的步骤列表，点开预览；图片类结果只显示「已生成图片」占位（Core 未给附件）。
- 审批卡：贴在输入框上方，显示工具中文名、参数 JSON（可折叠）、批准/拒绝并排；成功后本帧消失并
  Snapshot；失败按 7.3 处理。批准必须带 `argument_hash`，不做「替用户决定」的默认操作。
- 处理中：与桌面同一条规则（`AgentDesktop.tsx:145-146`）——
  `connected && streaming.isEmpty() && (刚发送 || 存在 queued/running/cancelling 任务)` 才显示三点；
  有 `streaming` 时显示正文气泡。房间/多 Agent 的旧 TurnTail 规则不适用（个人版没有房间）。
- 输入框：多行自增高、Enter 发送（物理键盘）、@ 提及同伴、停止按钮、引用回复。
- 已读：页面可见、位于底部且拿到新消息时，`POST /api/agents/read {botId, seq}`；该位置是
  owner-wide 的，桌面会同步清除未读——这是期望行为，不是 bug。

### 8.3 主题与无障碍

- 主题取桌面 Personal UI 的 token（`src/personal/personal.css`、`workspace.css` 的配色与圆角），
  Material 3 + 深色模式。
- 触控目标 ≥48dp；`contentDescription` 覆盖发送、停止、批准、拒绝、返回；TalkBack 读「<bot> 正在输入」。
- 字体缩放不截断审批卡与按钮；文案尽量与桌面逐字一致，减少两个端的认知差。

### 8.4 与桌面的一致性清单

| 概念 | 取值/规则 | 来源 |
|---|---|---|
| 任务状态 | queued/running/awaiting_approval/paused/needs_reconciliation/cancelling/succeeded/failed/cancelled/rejected | `src/personal/api.ts:40` |
| 工具中文名 | `toolLabels` | 同上 `:41` |
| 任务短语 | `toolPhrases` + `taskPhrase()` | 同上 `:42-44` |
| 审批工具说明 | 桌面审批卡内的中文映射 | `AgentDesktop.tsx:266` |
| 登录设备文案 | 「每台设备的登录最长八小时」 | `panels.tsx:115` |

文案表在 `:core` 里复制一份并加注释指向源文件；未知工具名回退为原始 `tool_name`（桌面也是这么做的），
所以即使文案漂移也不会崩。

## 9. 工程与构建

### 9.1 目录

```text
android/
  settings.gradle.kts        rootProject "nexbot-android"; include(":core", ":app")
  build.gradle.kts           Gradle 9.5.0 / AGP 9.3.1 / Kotlin 2.2.21（沿用旧应用已验证的矩阵）
  gradle/ gradlew gradlew.bat
  core/                      kotlin("jvm") + serialization；okhttp；无 Android 依赖
    src/main/kotlin/com/nexorai/nexbot/core/…   Origin/Wire/Sse/CoreClient/Copy/SyncPolicy
    src/test/kotlin/…        JVM 测试 + resources/fixtures/*.json
  app/                       com.android.application + compose（AGP 内建 Kotlin）
    src/main/kotlin/com/nexorai/nexbot/…        MainActivity/NexBotApp/data/sync/ui
    src/test/kotlin/…        JVM + Robolectric（仓库、会话存储、Markdown、聊天界面）
```

- 包名 `com.nexorai.nexbot`，debug 变体加 `.debug` 后缀（`applicationId` 一旦上架不可改，见 §13 待决 1）。
- `minSdk 26`、`compileSdk = targetSdk = 36`；Java/Kotlin 目标 17。旧应用用 37，但本 SDK 渠道里
  37 的包名是 `platforms;android-37.0`，所以先落在 36。
- 依赖（全部是旧应用验证过的版本）：Compose BOM 2025.10.01、material3、material-icons-core、
  activity-compose 1.11.0、lifecycle 2.9.4、datastore-preferences 1.1.7、
  kotlinx-coroutines 1.10.2、kotlinx-serialization-json 1.9.0、OkHttp 4.12.0、
  androidx.browser（Custom Tabs，打开链接）。
- 暂不加 CameraX/ML Kit 与 Room：二维码配对需要账号中心或桌面先提供配对入口，不是 Windows 已有能力，
  推迟到 P3；Room 用于离线阅读，P2/P3 再评估。

### 9.2 签名与版本

沿用旧仓库的规则（`0d6708c5^:android/app/build.gradle.kts`）：

- 签名材料只从环境变量或 `android/keystore.properties`（gitignored）读取；三者缺一即报错，
  全缺则产出**未签名** release。产物按版本命名：debug 为 `nexbot-<version>-debug.apk`，
  未签名 release 为 `nexbot-<version>-unsigned.apk`，签名接上后为 `nexbot-<version>.apk`
  （由 `androidComponents` 的 `outputFileName` 设置，版本取 `versionName`）。
- `versionName` 为 `MAJOR.MINOR.PATCH`，`versionCode = MAJOR*10000 + MINOR*100 + PATCH`；
  首个版本 `0.1.0` → `100`，上 Play 前再定。
- 启用 v2/v3 签名；v1 关闭（minSdk 26）。
- v1 **不开 R8**：`:core` 的 `@Serializable` 靠反射取 serializer，旧应用记录过「release 能装能开、
  第一次收帧就 SerializationException」的失败。要开就先把 keep 规则和「release APK 真机跑通一次」
  写进验收（§10），否则保持关闭——代价只是包体不压缩（旧应用带 WebRTC 约 34MB；本项目没有，会小很多）。

### 9.3 CI

已实现 `android-core` job（`.github/workflows/ci.yml`），选择逻辑在 `scripts/ci-scope.mjs`：

| 变化 | runtime | android | 结果 |
|---|---|---|---|
| 根 `.md`、`docs/**`、`.github/FUNDING.yml` | false | false | 只有 static |
| `android/**` | false | true | static + `android-core` |
| `scripts/capture-android-fixtures.mjs`、`scripts/ci-*`、`.github/workflows/**` | true | true | 两边都跑 |
| 其他源码 | true | false | 只跑 runtime |
| 主分支推送 / merge queue / 手动 / 无法读取的 diff | true | true | 全跑 |

job 的关键点：

- `runs-on: ubuntu-24.04`、`setup-java` temurin 17 + Gradle 缓存、Node 24 + pnpm 缓存；
- `sdkmanager` 安装 `platforms;android-36` 与 `build-tools;36.1.0`（runner 自带 Android SDK）；
- `chmod +x android/gradlew`（Windows 检出没有可执行位）后跑
  `:core:test :app:testDebugUnitTest :app:assembleDebug`；
- fixture 漂移门直接对 TypeScript 源跑：`node --experimental-transform-types
  scripts/capture-android-fixtures.mjs --core=server/personal-os/index.ts --check`
  ——因为 `pnpm build:core` 只在 Windows/macOS 支持，Linux runner 不能用构建产物；
- 先不进入 `gate` 的必需集合，作为 advisory job 观察。

`pnpm typecheck/test/build` 不包含 Android；`pnpm` 与 Gradle 互不调用，避免桌面流水线被拖慢。

## 10. 测试与验证

### 10.1 层次

| 层 | 内容 | 工具 |
|---|---|---|
| 协议解码 | 用**真实 fixture Core** 抓的 JSON 解 `/api/state`、messages、approvals、SSE 帧；未知字段/未知枚举不崩 | `:core` JUnit + `resources/fixtures` |
| 纯规则 | 地址校验、登录状态机、游标合并/去重、`reset`/epoch 处理、节流时序、`taskPhrase`、Markdown 解析 | `:core` JUnit（协程 test + 虚拟时间） |
| 网络 | MockWebServer：400/401/403/409/426/429 映射、超时、重试不重复发送（同 `clientId`）、`revoked` 后停流 | `:core` junit + mockwebserver |
| 界面语义 | 审批卡按钮顺序与无障碍顺序、通知映射、处理中规则 | `:app` Robolectric + compose test |
| 端到端 | 真机/模拟器对**一次性 fixture Core**：登录 → 发消息 → 流式回复 → 审批 → 停止 → 杀进程恢复 | adb reverse + fixture |

### 10.2 fixture 与证据（遵守 AGENTS.md）

- 一律使用隔离 fixture，绝不对线上 `bot.nexorai.com.cn` 或用户真实 Core 做写入验证。
- 复用现成的 fixture 装配：`createPersonalApp` + `server/personal-os/testing/fake-identity.ts` +
  `server/runtime/pi/p0/fake-model.ts`，与 `scripts/smoke-personal-clients.mjs` 相同方式起一个
  临时数据目录、随机端口、合成账号与合成模型。
- 模拟器/真机通过 `adb reverse tcp:<port> tcp:<port>` 访问 `http://127.0.0.1:<port>`，
  因此不需要改 Core 的监听地址，也不暴露到局域网。
- 抓 fixture：`scripts/capture-android-fixtures.mjs`（已实现，模式对齐 `capture-companion-fixtures.mjs`）
  从一次性 Core 抓 `identity.json`、`login-start.json`、`login-respond.json`、`state-full.json`、
  `state-summary.json`、`messages.json`、`events.txt` 到 `android/core/src/test/resources/fixtures/`。
  易变值（UUID、令牌、时间戳、loopback 地址、同步游标）先归一化，`--check` 因此比较的是结构而非
  某一次运行的时钟。审批卡的 fixture 需要一次真实工具调用，随 `:app` 的审批测试一起补。
- 验收记录写到 `docs/verification/android-client.md`：命令、fixture 路径、截图、`logcat` 片段、
  Core 数据目录里可核对的状态（消息 seq、审批记录）。只写证据，不写「应该没问题」。
- 合并门（与既有约定一致）：`cd android && ./gradlew :core:test :app:testDebugUnitTest :app:assembleDebug`
  + 一次模拟器端到端；改动了 Core 或共享脚本时，另跑 `pnpm typecheck && pnpm test`。

## 11. 阶段计划

规模记号：S ≈ 1–2 人日，M ≈ 3–5，L ≈ 6+；按单人顺序开发估算，不含评审等待。

### P0 — 前置（服务端两个小改动 + 抓取工具，S+M）

| # | 内容 | 状态 |
|---|---|---|
| P0-1 | `GET /api/state?view=summary`：省略 `memories[].content` 与 `journal`，保留其余字段并加 `"view":"summary"`；默认行为不变 | **已完成 2026-10-17** |
| P0-2 | `POST /api/auth/refresh`：见 §5.3 方案 B | **已完成 2026-10-17** |
| P0-3 | 抓取脚本 + fixtures | **已完成 2026-10-17**（随 P1） |

P0-1/P0-2/P0-3 已就绪，Android 端不需要再等 Core 改动。

### P0 实现记录与证据（2026-10-17）

改动：

| 文件 | 内容 |
|---|---|
| `server/personal-os/identity.ts` | `CoreIdentity.refresh(token)`：复用 `authenticate()` 的上游校验，轮换 token 哈希，`expiresAt = min(上游, now+8h)`，写 `identity.refresh` 审计；并发轮换返回 409 |
| `server/personal-os/index.ts` | `stateBody(view, origin)` 统一 `/api/state` 响应；`?view=summary` 去掉记忆正文与 journal；新增 `POST /api/auth/refresh` 路由；登录尝试预算抽成 `throttleLogin()` 并让续期共用 |
| `server/personal-os/identity.test.ts` | 两个新用例：免密续期 + 轮换 + 审计；注销/上游撤销/上游 503/过期四种拒绝路径 |
| `server/personal-os/app.test.ts` | 新用例：full 与 summary 的字段差异、未知 `view` 回退默认 |

验证（全部在临时数据目录与合成身份服务上完成，未接触真实账号或线上 Core）：

```sh
pnpm exec vitest run server/personal-os/identity.test.ts      # 16 passed（含 2 个新用例）
pnpm exec vitest run server/personal-os/app.test.ts -t "summary state"   # 1 passed
pnpm typecheck                                                # 通过
pnpm exec oxlint --deny-warnings server/personal-os/index.ts server/personal-os/identity.ts server/personal-os/identity.test.ts server/personal-os/app.test.ts   # 0 warnings, 0 errors
pnpm build:core                                               # 通过
```

构建产物上的手工端到端（`dist-personal/server/core/index.js` + `startFakeIdentity`，
一次性数据目录；登录 → 写一条记忆 → 取两种视图 → 续期 → 再用新旧令牌取状态）：

```json
{ "login": 200, "refresh": 200, "sameSession": true, "rotatedToken": true,
  "oldTokenAfterRefresh": 401, "newTokenAfterRefresh": 200,
  "summaryView": "summary", "fullHasJournal": true, "summaryHasJournal": false,
  "fullMemoryHasBody": true, "summaryMemoryHasBody": false,
  "audit": "identity.refresh", "expiresInHours": 8 }
```

这条记录不证明的事：没有 Android 客户端、没有真实 NexorAI 账号、没有生产 Core 改动；
`view=summary` 的流量收益也尚未测量（P1 用合成 300 条记忆的 fixture 记录字节数）。

### P1 — 骨架与可用闭环（L）

Gradle 工程 + `:core` 协议层 + 连接/登录 + 首页 + 聊天（读、发、流式、停止、加载更早） +
审批 + 未读 + 会话恢复 + 基础错误页。
验收：隔离 fixture 上完成「登录 → 发一条 → 看到流式回复 → 批准一次工具调用 → 停止一次任务 →
杀进程重启后仍在原对话」，并有 JVM 测试覆盖全部状态分支。

### P1 实现记录与证据（2026-10-17）

已落地 `:core`（纯 Kotlin/JVM，无 Android 依赖）：

| 文件 | 内容 |
|---|---|
| `android/core/src/main/kotlin/.../Origin.kt` | 地址规则：https 任意、http 仅私网/loopback/tailnet，拒绝凭据与非根路径 |
| `android/core/src/main/kotlin/.../Wire.kt` | 身份、登录、`CoreState`、消息、审批、例行任务的 `@Serializable` 模型；未知字段忽略、状态保持字符串 |
| `android/core/src/main/kotlin/.../Sse.kt` | 逐字节 SSE 解析（CRLF/LF/CR、注释、多行 data、粘性 id），`change`/`revoked`/未知帧 |
| `android/core/src/main/kotlin/.../CoreClient.kt` | OkHttp 客户端：登录两步、`/api/session` 复验、`state(summary)`、消息分页、发送幂等键、审批、停止、例行任务、`/api/events` Flow；15s 超时、不跟随重定向、Bearer 轮换 |
| `android/core/src/main/kotlin/.../Copy.kt` | 桌面同源中文文案（状态、工具、任务短语、审批说明），未知项回退原名 |
| `android/core/src/main/kotlin/.../SyncPolicy.kt` | 合并窗口、退避、45s 假死、续期提前量、快照失效判定、桌面同款「处理中」规则 |
| `android/` Gradle | wrapper 9.5.0、AGP 9.3.1（内建 Kotlin 2.2.21）、`jvmTarget 17`；`settings.gradle.kts` 含 `:core` 与 `:app` |
| `android/app/src/main/kotlin/.../data/` | `ConnectionStore`（SharedPreferences）+ `KeystoreSecretBox`（AES-GCM，Android Keystore） |
| `android/app/src/main/kotlin/.../sync/Repository.kt` | 一个 SSE 流、尾部合并 + 摘要快照、轮换续期、屏幕唤醒重同步、本地通知、登录/发送/审批/停止/加载更早 |
| `android/app/src/main/kotlin/.../ui/` | Compose：连接页、Agent 列表、聊天（流式、审批卡、composer）、Markdown、主题 |
| `android/app/src/main/kotlin/.../MainActivity.kt` | 单 Activity、通知权限、深链（通知点开 Agent）、前台/屏幕唤醒生命周期 |

验证（本机 JDK 21；Android SDK platform 36、build-tools 36.1.0、`aosp_atd` x86_64 模拟器）：

```sh
cd android && ./gradlew --no-daemon :core:test :app:testDebugUnitTest :app:assembleDebug
# :core 44 tests / 6 classes；:app 26 tests / 7 classes；debug APK 12,275,408 bytes（nexbot-0.1.0-debug.apk）
node --experimental-transform-types --no-warnings scripts/capture-android-fixtures.mjs --core=server/personal-os/index.ts --check  # 7 个 fixture 与一次性 Core 一致
pnpm exec vitest run scripts/ci-scope.test.ts scripts/ci-workflow.test.ts   # 51 passed（CI 选择与 job 形状）
pnpm typecheck                                      # 通过
```

模拟器端到端（一次性 Core + 合成身份 + 合成模型，`adb reverse` 连接 loopback，未开 LAN 端口）：
登录 → Agent 列表 → 打开 Agent 看到种子消息 → 输入 `hello` → 收到脚本模型回复
`收到，这是合成回复。`。另外验证了熄屏后由第二个客户端发起消息、点亮屏幕后自动重同步。
UI 层级（可读文本）证据在 `release/android-e2e/*.xml`；headless 模拟器的截图是黑屏，
不作为证据。完整记录见 `docs/verification/android-client.md`。

测试覆盖：地址规则、SSE 分帧与坏帧、真实 fixture 解码（full/summary 的记忆正文差异）、
MockWebServer 上的请求形状与错误映射（含流请求的 Bearer）、令牌轮换、流恢复头、合并/退避/
快照规则；`:app` 侧覆盖登录、恢复、失败重试复用同一 `clientId`、审批哈希、撤销后清空连接、
公网 http 拒绝、会话封存往返、Markdown（含列表转圆点）、头像契约与日期分隔、聊天界面
（Robolectric + Compose）以及三屏渲染冒烟。
实现过程中确认的契约事实：例行任务的 `enabled` 是 SQLite 的 `0/1` 而不是 JSON 布尔；
每帧的 `id:` 与 `data.cursor` 同值，SSE 的 id 需要在无 id 帧上沿用；MockWebServer 默认用机器
主机名，测试必须显式换成 `127.0.0.1` 才符合手机端的地址规则。

### 按 2026-10-17 设计稿对齐

`doc/ui/` 的截图和说明是这一轮的视觉基准（登录卡、联系人侧栏、聊天气泡/输入条、审批卡）。
实现改成中性底色 + 蓝色伙伴强调色，而不是 Material 默认的绿色：浅色 `#fafaf8` / 卡片
`#ffffff` / 次级 `#f0f0ed` / 用户气泡 `#e2e2dc`，深色 `#0b0c0e` / `#141518` / `#18191e` /
`#22242b`，强调色 `#4d6bfe`，品牌渐变 `#5285ff → #2859dc`。头像按
`shared/personal-appearance.ts`：第一个 Agent 是 soft/teal，其余按 id 哈希到 4 种形状 × 5 种颜色
（teal/ink/blue/clay/plum），带状态点；经典肖像头像暂不渲染。

三个页面照参考重排：登录（56dp 品牌标、`登录 NexBot` 标题、两个带标签的 44dp 输入框、
整宽蓝色按钮、`没有账号？ 去注册`；和设计稿一样没有 eyebrow、副标题与服务器输入框，自建
Core 的地址收在卡片下方那行 `服务器：…` 里）、联系人（品牌行、搜索、`对话` 计数、
44dp 头像/预览/时间/未读圆点、底部账号行，退出前有 `退出当前账号？` 确认）、
聊天（65dp 头部与状态、居中日期分隔、右对齐浅色用户气泡、无气泡的助手正文、每条消息的
时间/引用/复制、带状态点/工具名/等宽摘要的执行记录、琥珀边框审批卡、`Agent 正在工作…` +
停止任务）。输入区按 2026-10-18 的 Windows 版：上方输入，底部 `＋` / 权限 / 发送；`＋` 分
`添加`（文件）与 `指令`（权限、导出对话），权限按 Agent 保存标准/完全两档，附件每条消息最多
5 个、单个 5 MiB，发送后可下载，导出对话走系统分享。桌面版的「模型设置」入口要等手机有设置页
（P2），本轮不画死入口。`ScreenRenderTest` 用 Robolectric native graphics
把三屏画成 PNG（`build/screens`，断言不是空白），因此布局回归不会只靠肉眼。

这轮还发现并修掉一个真 bug：`GET /api/events` 请求没带 `Authorization`，Core 回 401，而
`expire()` 先 `stopLive()` 取消了正在运行的流协程，导致登录页没切过去、聊天停在旧状态，只靠
10s 轮询兜底。现在流请求带 Bearer（fixture 测试断言该头），并且先改状态再停协程。模拟器
复跑时流一次连上、无 401，回复即时到达。

CI 也已接上（2026-10-17）：`scripts/ci-scope.mjs` 增加 `android` 输出（`android/**` 只选 Android，
fixture 脚本 / CI 配置 / 无法判断的 diff 两边都选），`ci.yml` 增加 advisory 的 `android-core`
job：安装 `platforms;android-36` 与 `build-tools;36.1.0`，temurin 17 跑
`:core:test :app:testDebugUnitTest :app:assembleDebug`，再以 `--experimental-transform-types`
直接对 TypeScript 源跑 fixture `--check`（`build:core` 只支持 Windows/macOS）。
`scripts/ci-scope.test.ts` 与 `scripts/ci-workflow.test.ts` 已同步，51 个用例通过。

尚未完成（下一步）：审批卡的端到端工具调用、物理设备上的 Keystore/通知/输入法验证、
release 签名与 R8、把 `android-core` 提升为 gate 的必需 job；P2 的助手详情（工作/设置）、
模型设置（模型参数与上下文/输出上限）、完整块级 Markdown、经典肖像头像、头部共享/详情入口；
二维码连接需要配对入口，属新能力。

### P2 — 日常可用（M）

对齐 Windows 的「助手详情」两个页签（`src/personal/AgentDesktop.tsx`：`工作` / `设置`；`资料` 页已移除，
不做）：工作页的例行任务列表/开关/立即执行/编辑、当前工作与最近执行；设置页的基础信息与身份编辑。
手机上「工作」和「设置」落到二级页，工具/文件预览也在这里打开；设置页补上模型参数与
上下文/输出上限（输入区「模型设置」入口等它落地后再显示）。另加前台通知、引用/复制/搜索、草稿、
分享文本给某个 Agent。
二维码连接不是 Windows 已有能力：它需要账号中心或桌面新增配对入口（生成 `nexbot://connect?origin=…&coreId=…`），
手机侧扫码填入地址，单列为新能力（P3 / 需 Core 配合），不算对 Windows 的对齐项。
验收：Robolectric 语义测试 + 模拟器上逐项点通并截图。

### P3 — 分发与稳定（M）

release 签名与 APK 流水线、版本策略、Play 上架材料（数据安全表、隐私说明）、
release-mode 冒烟（若开 R8 则在此完成 keep 规则与真机验证）、崩溃日志与最小诊断信息。

### P4 — 需要 Core 一起做的能力（各自独立决策）

- **FCM 推送**：Core 增加设备推送注册表 + 发送路径；手机侧只做接收与深链。
- **保持连接前台服务**：常驻通知、开机恢复、耗电与合规评估。
- **语音/听写**：依赖 Core 的实时语音路由，当前个人版没有。
- **手机作为设备节点（Device Node）**：把通知、联系人、相机等作为受审批工具暴露给 Agent。
  安全边界必须先写清（只读优先、逐次审批、可随时撤销、不做 shell），不放进 v1。
- **例行任务新建/编辑**：表单与时间选择器（P2 可提前）。

## 12. 风险与取舍

| 风险 | 影响 | 处理 |
|---|---|---|
| 每 token 触发一次回拉 | 流量/耗电 | Tail 120ms 合并、无任务时 1s；Snapshot 2s 下限 + summary |
| 8 小时登录 | 高频重登挫败感 | 已提供免密续期；续不上再登录，文案提前说明 |
| 私网明文 HTTP | 局域网内可被观测 | 明确「仅受信任网络」、UI 提示、公网强制 HTTPS |
| 后台收不到推送 | 用户以为「断了」 | 产品文案写清；P4 FCM |
| 两份中文文案 | 漂移 | 未知项回退原名；源文件注释；P2 可选做生成器 |
| Compose 流式渲染 | 长回复掉帧 | 节流更新 + 只重组当前气泡；性能基准放 P2 验收 |
| R8 与序列化 | release-only 崩溃 | v1 不开；开启前必须有 release 真机验证 |

**被否决的方案**

| 方案 | 否决理由 |
|---|---|
| WebView 包一层 Core 远程 UI | 桌面三栏布局不适合手机；通知/分享/自动填充/Keystore 都得另做；token 注入 WebView 反而多一条泄漏面。可作为一周内的临时演示，不作为产品 |
| PWA / 浏览器书签 | 无可靠后台、无系统分享/通知体验、无法进入应用商店 |
| 移植旧 Android 应用 | 协议不同（companion allowlist + 旧 harness API），改造成本高于重写；其 UI 层大量绑定旧领域模型 |
| Kotlin Multiplatform 共享桌面逻辑 | 桌面是 React/Electron，没有可共享的业务代码；共享的只有 JSON 契约 |
| Flutter / React Native | 仓库已有成熟 Compose 经验与旧版本矩阵；系统集成（Keystore、通知、自动填充）原生更直接 |

## 13. 待决事项

1. **包名与应用名**：建议 `com.nexorai.nexbot` / 「NexBot」。上架后不可更改。
2. **客户端何时用续期**：建议前台且剩余寿命 < 30 分钟时续一次；是否也允许后台续期待定。
3. **v1 是否包含例行任务新建/编辑**：建议放 P2，先只做开关与立即执行。
4. **分发方式**：先 APK 侧载 + CI artifact，还是一步到 Google Play（决定签名托管、隐私材料、targetSdk 节奏）。
5. **后台策略**：v1 接受「仅前台可靠」吗？还是直接排 FCM（需要 Core 改动）。

## 14. 代码索引

| 主题 | 路径 |
|---|---|
| Core 路由与鉴权 | `server/personal-os/index.ts:108-294` |
| 身份与会话 | `server/personal-os/identity.ts`、`clients.ts`、`identity-provider.ts` |
| 多账号工作区路由 | `server/personal-os/workspaces.ts` |
| 客户端快照 | `server/personal-os/sync.ts`、`store.ts:306-318` |
| 消息 / 联系人 / 发送 | `server/personal-os/agents.ts:93-127`、`:212-219`、`:272-274` |
| 任务、审批、流式 | `server/personal-os/runtime.ts:205`、`:263-304` |
| 例行任务 | `server/personal-os/routines.ts:58-110` |
| 桌面薄壳连接/登录实现 | `electron/nex-client-main.mjs` |
| 桌面 Personal UI（交互参照） | `src/personal/AgentDesktop.tsx`、`panels.tsx`、`api.ts` |
| 旧 Android 应用（只读参考） | `git show 0d6708c5^:android/…` |
| 一次性 fixture 装配 | `scripts/smoke-personal-clients.mjs`、`server/personal-os/testing/fake-identity.ts` |
| Markdown 范围先例 | `docs/ios-companion.md:69-83` |
| 验证规则 | `docs/verification/README.md`、`AGENTS.md` |


