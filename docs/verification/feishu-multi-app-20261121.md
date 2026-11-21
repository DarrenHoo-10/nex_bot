# 飞书多应用与按群回复设置：本地验证（2026-11-21）

## 改动

- 一个工作区可以接入多个飞书应用。去掉了“已连接飞书应用，请先移除”的单应用限制；同一 App ID 不能重复添加（“该应用已添加”）。
- 连接成功后从 `/open-apis/bot/v3/info` 读取机器人名称和头像地址，状态里的每个应用带 `name`、`avatarUrl`、`groupCount`。Web 的内容安全策略不允许外部图片，Web 用名称首字作头像；Apple 端同样用首字。
- 新表 `feishu_group_settings`（`delivery.ts` 中以可重复执行的加法迁移创建），同时给 `feishu_delivery_parts`、`personal_feishu_messages` 增加 `inline`，给 `personal_feishu_apps` 增加 `bot_name`、`bot_avatar`。
- `GET /api/feishu/groups?id=` 列出机器人所在的群（飞书 `im/v1/chats` 与 `im/v1/chats/:id`，10 分钟内不重复拉详情）；`POST /api/feishu/groups/save` 保存一个群的设置，带版本号；未接入的群由已绑定的主人保存时自动认领。
- 每个群的回复模式，参考 botmux：
  - 触发方式：`always` 必须 @；`topic` 话题内免 @（默认，与改动前行为一致）；`ambient` 默认应答，有人 @ 别人时不插话；`never` 全部回复。
  - 会话方式（普通群）：`new-topic` 每次 @ 开新话题（默认，与改动前一致）；`chat-topic` 群里直接发的消息共用该群的话题，飞书话题各自独立；`chat` 整群一个话题。共用的群话题以引用回复回到群里，不开飞书话题。话题群固定为每个话题一个会话。
  - 群的系统上下文由 `runtime.ts` 在话题任务的系统提示中实时读取，修改后对进行中的话题生效。
- 飞书话题对应 NexBot 话题：群的共用话题以群名为标题，`sourceContext.chatName` 记录群名。Web 中凡是接收飞书应用的助手都按金融助手的方式显示话题卡片（“飞书 · 群名”），主聊天仍是连续会话；从主聊天发出的消息不会新建话题。
- 设置界面：连接器列表中的飞书合成一行（应用数、异常数）；飞书页列出应用，每行的“⋯”菜单放绑定主人、授权文档、停用/启用、移除；点开应用只管理每个群的回复模式与系统上下文。投递对账区只在有待人工对账的分段时出现。
- Mac/iOS：`SettingsFeishuCard`、`FeishuView` 改为应用列表加应用详情，群设置共用 `Shared/FeishuGroupsView.swift`；NexClientKit 的飞书操作改为按应用 ID。

## 验证

- `server/personal-os/feishu.test.ts` 新增 4 个用例：两次扫码接入两个应用并显示机器人身份、拒绝重复 App ID；列出群（普通群、话题群、人数）、过期版本被拒、保存后认领；`chat` + `never` 下非主人的不带 @ 消息进入同一个群话题、引用回复不带 `reply_in_thread`、系统提示含群上下文、话题标题为群名；`chat-topic` + `ambient` 下顶层消息共用话题、有人 @ 别人时忽略、飞书话题独立并续接；`always` 下话题内不带 @ 的追问被忽略。飞书相关 5 个测试文件共 54 个用例通过。
- `src/personal/FeishuCard.test.ts` 新增应用列表、群摘要、话题来源标签用例；`tsc -b` 与 `tsc -p tsconfig.server.json` 通过。
- 隔离夹具：临时目录中的 Core（源码运行）+ 假身份、假模型、假飞书，两个合成应用、三个合成群。在浏览器中验证了连接器行、应用列表、“⋯”菜单、应用详情、未接入群的“接入并保存”、话题群不显示会话方式、助手聊天中的两张飞书话题卡片和话题打开后的消息；390 宽度无横向溢出，控制台无错误。未连接用户的 Core 或数据。
- Apple：源码复制到 Mac 的独立临时目录并转换 CRLF。NexClientKit `swift test` 255 个用例通过（含新增的多应用与群设置用例）；`NexBotMac`、`NexBotiOS` Debug 构建通过（禁用签名，独立 DerivedData）。临时目录已删除。

## 未验证与限制

- 没有连接真实飞书：`im/v1/chats` 的字段（`chat_mode`、`group_message_type`、`user_count`）按开放平台文档实现，假飞书按同样字段返回。
- Apple 端未运行界面，只验证了编译和 NexClientKit 测试。Apple 端的助手聊天仍只在金融助手中显示话题卡片，其他接收飞书的助手尚未按 Web 的方式显示飞书话题。
- 共享的金融助手应用（账号路由）不在“我的应用”中，仍在飞书页下方的“账号与投递”中管理，暂不支持按群设置。
- 打包 Core 的构建脚本在本工作区找不到 `node_modules/@larksuiteoapi`，夹具改为从源码启动 Core；未构建任何安装包，未部署。
