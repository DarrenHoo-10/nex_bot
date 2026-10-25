# 飞书连接器技术方案（基础连接）

状态：P1（连接与对话）与 P2（通用工具 + 主人授权）已实现并通过隔离夹具验证，见
[`docs/verification/feishu-connector.md`](../verification/feishu-connector.md)；
真实租户扫码验收未做。
后端为 NexBot Core（`server/personal-os/`），UI 为个人版（`src/personal/`）。

## 1. 目标与范围

提供一个**基础连接**：把 NexBot 里的某个助手（例如"私人秘书"）接入一个飞书自建应用。具体怎么使用由用户和助手决定，连接器本身不预设业务场景。

包含：

1. 扫码一键创建飞书自建应用，并自动申请权限、订阅事件；
2. 主人在飞书私聊或在群里 @ 机器人 → 进入该助手的连续对话 → 回复发回飞书；
3. 需要审批的操作在飞书里弹卡片，主人点击批准或拒绝；
4. 给助手一组通用飞书 API 工具：可切换机器人身份或主人身份，读操作直接执行，写操作走审批；
5. 主人身份授权（user_access_token），用于以主人身份访问文档等资源。

不包含：

- 按会话选模型、工作目录、CLI——都沿用该助手在 NexBot 里的设置；
- 非主人对话、流式卡片、思维链展示、日历/会议等场景化功能；
- 任何非官方接口：不模拟飞书网页客户端，不调用开发者后台内部接口。

与 botmux 的关系：沿用它的交互模式（长连接收消息、去重、主人白名单、卡片交互、设备码授权）；建应用改用官方 SDK 的 `registerApp`；执行交给 NexBot 现有的助手与审批机制，不启动 CLI 进程。

## 2. 依据

- **官方 Node SDK `@larksuiteoapi/node-sdk@1.76.0`**（新增依赖）。以下 API 已在其类型定义中核实：
  - `registerApp(options)`：扫码创建/更新自建应用，返回 `{client_id, client_secret, user_info?{open_id, tenant_brand}}`。
    - `appPreset{name, desc}`：预填名称与描述，支持 `{user}` 占位。
    - `addons{scopes:{tenant,user}, events:{items:{tenant,user}}, callbacks:{items}}`：在扫码确认页预填权限、事件、回调。只增不减；未知名称被静默丢弃；**需平台灰度开启，否则整体被忽略**。
    - `appId`：对已有应用差量再授权；`createOnly`：隐藏"选择已有应用"。
    - `onQRCodeReady({url, expireIn})`、`onStatusChange`、`signal`。
  - `WSClient({appId, appSecret, domain})`：`start({eventDispatcher})` / `close()`；`wsConfig.pingTimeout`、`handshakeTimeoutMs` 可调。
  - `EventDispatcher.register({...})`：处理长连接推送的 v2 事件，含 `im.message.receive_v1` 与卡片回调 `card.action.trigger`。
- **lark-cli 1.0.42**：作为参考实现核对了公开 OpenAPI 的用法——设备码授权端点、应用自检接口、权限申请深链、错误码分类。
- **权限清单** `server/personal-os/feishu/lark-scopes.json`：复制自 botmux（MIT License），225 项 tenant scope、185 项 user scope，作为默认申请清单。

## 3. 总体结构

```
飞书客户端 ──长连接 WebSocket（出站）──► FeishuChannel
                                            │ 消息 / 卡片回调
                                            ▼
┌──────────────────── NexBot Core ─────────────────────────────┐
│ FeishuModule                                                 │
│  ├─ register.ts   registerApp 扫码建应用 / 差量补齐权限          │
│  ├─ api.ts        OpenAPI 客户端：tenant/user token、设备码      │
│  │                授权、错误分类、限流退避                        │
│  ├─ channel.ts    WSClient + EventDispatcher（传输可注入测试）    │
│  ├─ inbound.ts    事件 → AgentModule.send                       │
│  ├─ outbound.ts   回复 / 审批卡片 / 卡片回调 → runtime.decide     │
│  └─ tools.ts      通用飞书 API 工具目录与执行                     │
│                                                              │
│ 复用：ConnectorModule 授权与版本失效、risk.ts 审批判定、           │
│       runtime approvals、CoreStore vault（AES-256-GCM）        │
└──────────────────────────────────────────────────────────────┘
```

- 飞书连接是 `personal_connectors` 的一种 `kind='feishu'`。工具授权（`personal_connector_grants`）、`connectorVersion` 失效检测、参数绑定审批、"结果未知不重放"全部沿用现有连接器机制。
- 一个飞书应用对应一行连接器，绑定一个**接收助手**；同一时间只允许一个注册任务。
- **单实例长连接**：启动前查 `GET /open-apis/event/v1/connection`，`online_instance_cnt > 0` 则不连接，状态显示"已在其他位置连接"，避免重复投递。

## 4. 连接流程

### 4.1 扫码建应用

UI 入口：连接器 → **连接飞书** → 选择接收助手 → 显示二维码。

```ts
registerApp({
  source: "nexbot",
  createOnly: true,
  appPreset: { name: bot.name, desc: "NexBot" },
  addons: {
    scopes: manifest.scopes,                       // lark-scopes.json 全量
    events: { items: { tenant: ["im.message.receive_v1", "im.chat.member.bot.added_v1", "im.chat.member.bot.deleted_v1"] } },
    callbacks: { items: ["card.action.trigger"] },
  },
  onQRCodeReady: ({ url, expireIn }) => job.update({ stage: "qr", url, expiresAt }),
  signal: job.signal,
});
```

1. Core 后台运行注册任务，状态进 `/api/state` 的 `feishu` 块并经 SSE 推送。UI 用 `qrcode.react`（已有依赖）渲染 `url`，旁附"在浏览器打开"。
2. 扫码确认后，SDK 返回凭据。一个事务写入：连接器行（`kind='feishu'`）、`personal_feishu_apps`（`app_secret` 用 vault 加密）、品牌（`tenant_brand`，决定后续域名用 `open.feishu.cn` 还是 `open.larksuite.com`）。
3. **绑定主人**：`user_info.open_id`（扫码人）即主人候选。用新应用 tenant token 调 `GET /open-apis/contact/v3/users/{open_id}?user_id_type=open_id` 校验；校验不通（权限未生效等）则生成 6 位绑定码，主人私聊机器人发送该码完成绑定。open_id 按应用隔离，绝不跨应用复用。
4. 自动把飞书工具目录授权给所选助手（复用 `connectors.grant`）。写操作仍逐次审批，除非该助手开了完全权限。
5. 启动长连接，状态"已连接"。
6. 失败处理：取消/过期/拒绝分别落状态文案；凭据落库前失败不留记录。

### 4.2 权限策略

权限申请只做一次：`addons` 随扫码预填全量清单（§4.1），生效多少算多少。**只保证基础链路**：机器人能力、收发消息、长连接。其余权限（文档、知识库等）不预检、不做补齐流程，没生效的先不管——缺失的能力在使用时以错误呈现（§6.3）。

连接建立后唯一的检查是长连接是否就绪（WSClient 回调），决定状态显示"已连接"还是"连接异常"；机器人 open_id 经 `GET /open-apis/bot/v3/info` 获取并缓存，供群聊识别 @。

管理员审批是企业租户自己的流程（个人租户通常自动通过），弱依赖：不阻断连接建立，由用户自行处理。

### 4.3 使用已有应用（兜底）

用户填 App ID、App Secret、品牌。主人绑定只能用绑定码或主人身份授权时取得。

### 4.4 主人身份授权（user_access_token）

- 设备码流（无需回调地址，云端 Core 可用）：
  - `POST {accounts}/oauth/v1/device_authorization`，头 `Authorization: Basic base64(app_id:app_secret)`，`scope` = 已授 ∪ 清单中 user scope ∪ `offline_access`；
  - 轮询 `POST {open}/open-apis/authen/v2/oauth/token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`）。
  - UI 展示 `verification_uri_complete` 二维码。
- 校验：`GET /open-apis/authen/v1/user_info` 的 open_id 必须等于 `owner_open_id`（未绑定时以它绑定），否则丢弃 token。
- 存储：access/refresh token、过期时间、**实际授予**的 scope（取响应 `scope` 字段，不信任请求值），整体加密存 `user_token` 列；UI 只见"已授权 · 姓名 · 到期时间"。
- 刷新：过期前 5 分钟，同应用串行单飞；`20026/20037/20064/20073` 或 refresh 过期 → 清 token，状态"需重新授权"。
- 增量授权：重新授权永远并入已授 scope，不丢权限。

## 5. 消息通道

### 5.1 入站（`im.message.receive_v1`）

1. 仅处理 `sender_type='user'`；`message_id` 插入 `personal_feishu_messages`，主键冲突即重复投递，丢弃（飞书重推窗口 ≤6h，定时清理 24h 前的行）。
2. **主人判定**：私聊要求 sender open_id == `owner_open_id`；群聊要求 @ 机器人（`message.mentions` 含 bot open_id）且 sender 为主人。非主人消息忽略。
3. 文本：`message_type=text` 取 `content.text`；`post` 取富文本纯文本；群聊把 @ 占位替换成姓名。`image/file` 经 `GET /open-apis/im/v1/messages/{id}/resources/{file_key}` 下载，落为 Core 附件并随消息引用。
4. 进入助手：`agents.send(botId, content, "feishu:" + message_id, store.session)`。`client_message_id` 幂等由现有 `agent_input_receipts` 保证；`agent_task_links.origin` 仍写 `'owner'`（飞书进来的就是主人在说话），飞书侧映射单独记表，不动现有 CHECK 约束。
5. `personal_feishu_messages` 记录 `message_id, chat_id, chat_type, sender_open_id, task_id`，任务创建后回填 `task_id`——出站靠它找到回复目标。

### 5.2 出站

- `agents.onPublished(botId)` 里，若最新任务在 `personal_feishu_messages` 有映射，取该任务的 assistant 消息发回对应 `chat_id`：私聊直发，群聊以 `POST /open-apis/im/v1/messages/{message_id}/reply` 回原消息。正文用 Markdown 卡片（`msg_type=interactive`），超过单卡上限分片。
- **审批**：`changed()` 时扫描 `status='awaiting_approval'` 且任务来自飞书、尚未发过卡片的 approval，发审批卡片（工具名 + 参数摘要 + 同意/拒绝/停止）。`card.action.trigger` 回调校验操作者 open_id == 主人后才调 `runtime.decide(approval.id, argument_hash, allow)`；决定后更新卡片为已处理，防重复点击。
- 任务失败：`onResult` 的 system 消息同样发文本回飞书。
- 限流：`api.ts` 内每应用令牌桶（15 QPS）；`230049/230020/99991400/429` 按 `Retry-After` 退避重试 ≤3 次。

### 5.3 长连接管理

- `WSClient` 配 `pingTimeout` 看门狗；SDK 放弃重连后由模块重启 `start()`。
- 连接器 `toggle/delete`、应用变更、进程退出时 `close()`。
- 与"其他位置已连接"检测（4.2 表）配合，保证一个应用只有一个消费者。

### 5.4 执行授权

**决定：飞书消息照常执行，不要求主人的任何客户端在线。** 服务端 Core 常驻，这正是飞书通道的价值。现有 routine 语义要求的"活的主人 native 会话"约束的是手机/桌面客户端的登录态，不是服务端；飞书通道不沿用这条，改用**连接本身**作为授权锚点：

- `identity` 增加 `channelAuthorize?: (task) => Promise<boolean>` 钩子；native 会话校验失败时调用。
- `FeishuModule` 提供：任务在 `personal_feishu_messages` 有映射 **且** 连接处于 enabled → 允许。
- 撤销方式即断开连接：连接是主人在登录状态下建立的，断开后飞书来源的任务不再获得授权。

## 6. 助手工具

### 6.1 工具目录

内置目录（非远程 `tools/list`），两个通用工具 + 身份切换：

| 工具 | 参数 | 身份 | 审批 |
|---|---|---|---|
| `feishu_read` | `path, params, as?` | 默认 bot，可 user | 只读，直接执行 |
| `feishu_write` | `path, body, as?` | 同上 | 一律审批（`risk=dangerous` 语义） |

约束（`tools.ts` 执行时校验）：

- `path` 必须 `^/open-apis/[\w./{}-]+$`；`feishu_read` 仅 GET，`feishu_write` 仅 POST/PUT；
- body ≤ 64KB；响应截断至 24KB 后返回；
- 域名固定为品牌对应的 open 域，凭证只走 `Authorization: Bearer <token>` 头，不出现在参数与结果里；
- 用法说明放 `server/personal-os/skills/feishu/SKILL.md`：何时用 user 身份、错误码含义、不要重试不确定的写操作。

### 6.2 身份

- bot 身份：tenant token（`api.ts` 缓存，过期前刷新）。
- user 身份：4.4 的 user token；未授权时返回 `missing_scope(layer=user)` 结构化错误。

### 6.3 运行时错误分类（`api.ts`）

| 错误 | 含义 | 动作 |
|---|---|---|
| `99991672` | 应用未开通该权限 | 工具结果返回 `missing_scope(layer=app, scopes)`，提示需在开发者后台开通 |
| `99991679/99991676` | 用户未授权/令牌缺 scope | `missing_scope(layer=user)`；发授权卡片 |
| `99991661/63/68/71/77` | token 失效 | 刷新一次，失败按上一层处理 |
| `20026/20037/20064/20073` | refresh 异常 | 清 token，状态"需重新授权" |
| `230049/230020/99991400/429` | 限流 | gate 内退避，不上抛 |

工具结果对模型只含结构化错误与提示，不含凭据。**有副作用的调用不自动重放。**

## 7. 数据与接口

迁移（`store.ts` 版本 19）：

```sql
ALTER TABLE personal_connectors ADD COLUMN kind TEXT NOT NULL DEFAULT 'mcp';
CREATE TABLE personal_feishu_apps (
  connector_id TEXT PRIMARY KEY REFERENCES personal_connectors(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL UNIQUE, brand TEXT NOT NULL CHECK(brand IN ('feishu','lark')),
  app_secret TEXT NOT NULL,                    -- vault 密文
  owner_open_id TEXT, bind_code TEXT, bind_expires_at INTEGER,
  bot_id TEXT NOT NULL,                        -- 接收助手
  user_token TEXT, user_scopes_json TEXT NOT NULL DEFAULT '[]', user_token_expires_at INTEGER,
  bot_open_id TEXT, connection TEXT NOT NULL DEFAULT 'idle',
  error TEXT, checked_at INTEGER
) STRICT;
CREATE TABLE personal_feishu_messages (
  message_id TEXT PRIMARY KEY, app_id TEXT NOT NULL,
  chat_id TEXT NOT NULL, chat_type TEXT NOT NULL, sender_open_id TEXT NOT NULL,
  task_id TEXT, created_at INTEGER NOT NULL
) STRICT;
```

路由（`server/personal-os/index.ts`，与 connectors 同风格，全部 owner-only）：

- `POST /api/feishu/register/start | cancel`
- `POST /api/feishu/save`（已有应用）
- `POST /api/feishu/user-auth/start | cancel`
- `POST /api/feishu/bot`（改接收助手，走 grant 更新）
- `POST /api/connectors/toggle | delete` 复用；delete 时停连接、清 token，提示应用需在后台删除（给链接）。

状态经 `/api/state` 下发：连接器列表 + `feishu: { job?, apps: [{id, appId, brand, status, ownerBound, userAuth, connection, error}] }`。凭据不出现在任何响应里。

## 8. UI（`ConnectorsPage.tsx`）

- 页头加**"连接飞书"**按钮 → 选助手 → 弹出注册流程（二维码 / 等待确认）。
- 飞书详情卡：状态（未连接 / 等待扫码 / 已连接 / 连接异常 / 需重新授权）、App ID、接收助手、操作按钮：授权文档访问、断开、移除。
- 文案遵守 `AGENTS.md`：只写状态、错误与控件，不加说明段落。

## 9. 分期与验证

| 期 | 内容 | 完成标准 |
|---|---|---|
| P1 连接与对话 | 建应用 + 长连接 + 私聊/群 @ 收发 + 审批卡片 + 断开 | 夹具测试通过；真实租户扫码手动验收 |
| P2 工具 | 通用 `feishu_read/write` + user token 设备码授权 + 错误分类与补救卡片 | 同上 |

验证（按 `docs/verification/README.md`，全部隔离夹具，不碰真实租户）：

- `channel.ts` 抽出 `FeishuTransport` 接口（连接、事件注入、出站收集），测试注入假实现；
- 假 OpenAPI 服务（`server/personal-os/testing/fake-feishu.ts`）：tenant token、im 发送/回复、contact、authen（含设备码流程）、可编程返回错误码；
- 覆盖：注册任务状态机与取消、凭据落库加密、`message_id` 去重、非主人拒绝、群 @ 判定、审批卡片仅主人可点且 decide 校验 hash、断开后停发停收、`99991679` → 授权卡片且不重放、user token 刷新与失效、凭据不出现在 `/api/state` 与日志（redact 断言）；
- 新增 `docs/verification/feishu-connector.md`；命令：`pnpm test:personal`（加入 `feishu.test.ts`）、`pnpm typecheck`、`pnpm lint`。

## 10. 已定

- 飞书任务照常执行，不依赖主人客户端在线，断开连接即撤销（§5.4）。
- 权限随扫码全量预填，只保证基础链路；其余权限不生效的不做补齐流程，缺失能力在使用时以错误呈现（§4.2、§6.3）。
- 管理员审批是企业侧流程、弱依赖，不阻断连接建立（§4.2）。

## 11. 明确不做

- 不调用任何开发者后台内部接口，不模拟网页客户端登录，不保存网页会话。
- 不跳过审批：写入与发送一律走现有参数绑定审批（完全权限模式除外，该模式是用户对助手的显式选择）。
- 不明文存储 app secret / token；凭据不进模型上下文、UI 状态与日志。
- 不申请清单之外的权限。
