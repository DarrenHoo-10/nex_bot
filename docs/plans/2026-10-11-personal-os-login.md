# NexBot 账号登录实施方案

日期：2026-10-11。本文以当前实现为准，覆盖早期方案中的可选登录、离线 local owner 和手动配置用户中心地址。

## 已确定的产品行为

- 生产应用内置 `https://user.nexorai.com.cn`，主应用和便携客户端必须登录才可使用。界面不提供修改用户中心域名或跳过登录的入口。
- 在应用内输入邮箱和密码。账号注册、邮箱验证和找回密码由现有 nex_user 账号中心承担；不会假装已经实现它尚未提供的 Native Identity API。
- 首次关联必须从主设备桌面启动的私有 bootstrap 发起。匿名网络客户端不能抢先关联 owner；启动凭据仅用于初始化身份，不是业务登录凭据。
- 一个 Core 对应一个账号，绑定稳定的 `(issuer, subject)`，不按邮箱合并，也不把用户中心管理员角色映射为其他 Core 的访问权限。
- 升级保留既有 owner、workspace、Core ID、Agent、消息、记忆和模型配置。登录关联只新增外部身份；不生成默认 Agent。
- 登录同一账号的其他设备访问同一个 Core。跨设备 Core 地址必须 HTTPS，避免邮箱密码在局域网明文传输；设备能力继续使用独立 DCP 配对令牌。

## 模块化单体中的接口边界

`identity-provider.ts` 是 nex_user 适配器，只调用固定的 `/v1/login`、`/v1/session`、`/v1/logout`。用户中心 Cookie 和 CSRF Token 仅由 Core 持有，AES-GCM 加密保存到现有 secrets；密码只随一次登录请求使用，不落盘、不进入审计或模型上下文。

`identity.ts` 管理账号绑定、一次性登录事务、Core 会话和撤销。公开 Core 接口：

| 接口 | 用途 |
| --- | --- |
| GET /api/client/identity | 协议版本、Core ID、账号登录方式，不返回业务数据 |
| GET /api/auth/status | 检查当前登录及是否允许本机首次关联 |
| POST /api/auth/start | 创建五分钟有效的邮箱密码事务，返回绑定令牌与 step ID |
| POST /api/auth/respond | 单次消费事务，校验 nex_user 身份，签发独立 Core 会话 |
| POST /api/auth/logout | 优先撤销本地访问，再撤销对应用户中心会话 |
| POST /api/session | 恢复并校验保存的 Core 会话；桌面 bootstrap 只能得到初始化 Cookie |
| GET /api/clients | 列出当前 Core 登录设备 |
| POST /api/clients/revoke | 撤销一台设备的登录 |

业务 API、SSE、任务模型请求、工具执行与记忆模型网关均检查账号授权。邀请码登录仅保留在显式隔离的旧协议测试工厂，生产桌面 IPC 不允许关闭账号门禁。

## 数据模型和生命周期

新增 migration 10，新增 `identity_provider` 单例与 `identity_revocations` 撤销队列，复用已有 `external_identities`、`login_transactions`、`user_sessions`、`client_sessions`、`secrets`。迁移不重建 Agent 或记忆表。当前 nex_user 桥接会话使用既有 `native-v1/native_status` 存储约束，provider type 明确为 nex-user；这不代表上游已实现通用 Native Identity API。

Core 会话最长八小时，且不得超过上游 Cookie 的有效期。用户中心状态缓存最长六十秒，同时检查墙钟和单调时钟。重启后缓存为空，必须重新验证；网络失败关闭业务访问，不把失败当作有效身份。登录事务校验绑定令牌、nonce 和 step ID，先消费再调用上游，失败时重新发起，不自动重放密码。

退出和撤销先取消本地会话以及它发起的运行任务、审批和 A2A 子任务；已经执行的危险操作保留不确定结果，不会重放。其他客户端的独立有效会话仍能使用 Core。上游撤销失败时持久化加密引用，最多三次尝试，间隔一分钟；耗尽后删除本地凭据，不能保证网络故障期间上游会话即时撤销。

用户消息保存真实 sender session，Task 保存真实 initiated/authorized session，A2A 子任务继承父任务授权。Core 例行任务需要任一已关联 owner 的有效登录；无有效登录时任务等待，不调用模型或设备。

已配置模型的旧 Core 在验证账号前不启动原生记忆服务。记忆 outbox 在没有有效 owner 登录时保持排队；不提交提取请求、不消耗重试。登录后按原有原文与操作 ID 继续配送。

## 桌面与客户端

`LoginGate` 在加载联系人、消息和记忆之前检查账号状态。失效时卸载业务界面和 SSE，重新展示登录界面。设置中显示账号、退出和设备撤销，不再显示连接码。

主应用将 Core 登录凭据保存为 Windows DPAPI 密文 `account-session.bin`；客户端保存在 DPAPI 密文 `connection.bin`。重启时验证 Core ID 和会话后恢复。退出删除保存的凭据与浏览器数据；邮箱密码不保存。客户端退出同时停止本机 Device Node 并清除配对授权，执行日志继续保留用于核对未确定的结果。

## 验证边界

新增合成 nex_user 服务与独立临时 Core 测试账号门禁、首次绑定、密码错误、账号隔离、一次性挑战、有效期、加密存储、状态缓存、撤销、重启以及任务授权。真实 Electron 测试使用显式临时 profile 和仅回环的模拟用户中心；正常生产启动始终采用内置正式域名，不读取这种测试配置。

正式用户中心的只读 health/session 探测只能证明地址和路由可访问，不能代替真实账号端到端验收。所有自动化修改均在隔离 fixture 中进行。
