# NexBot web UI vs Core HTTP API: feature-parity inventory

All paths are relative to `/Users/darrenhoo/orca/workspaces/nex_bot/feat-init-mac-and-ios`. Abbreviations: AD = `src/personal/AgentDesktop.tsx`, CS = `src/personal/components/ContactSidebar.tsx`, P = `src/personal/panels.tsx`, CP = `src/personal/ConnectorsPage.tsx`, MW = `src/personal/MemoryWorkbench.tsx`, AP = `src/personal/components/AvatarPicker.tsx`, AV = `src/personal/avatars/appearance.ts`, SRV = `server/personal-os`.

## 0. Cross-cutting API facts

**Transport**
- Base path is `/api/<path>`. The web `api()` helper (`api.ts:34-39`) sends a POST with `Content-Type: application/json` only when a body is given. Otherwise it sends a GET. Any non-2xx throws `Error(result.error ?? "连接失败")`.
- Auth is `Authorization: Bearer <token>` or the `nex` cookie (`index.ts:124`).
- A 401, or a body with `code:"identity_unavailable"`, makes the web dispatch `nex-session-expired`.
- Mutating requests carrying an `Origin` header must equal the request origin, otherwise `403 {"error":"Invalid origin"}`.
- Request bodies are capped at 256,000 bytes (`请求过大`) and must be a JSON object (`Invalid request`).
- After auth, every mutation re-authenticates. On failure it returns `401 登录已失效，请重新登录`.
- Handler exceptions return `400 {error: message}`. Non-GET unknown paths return `404 {"error":"Not found"}`.

**Validators (`store.ts:13-21`)**
- `text(v, max=32000)` requires a string, trims it, and rejects empty or over-length values with `请输入有效内容（长度超出限制或为空）`.
- `optionalText(v, max=32000)` treats undefined/null as `""`. Non-string or over-length values throw `请输入有效内容（长度超出限制或类型不正确）`.

**Realtime and reload (AD:77-132)**
- `GET /api/state` is the single view model. The web calls it on mount, on each SSE `change` event (debounced 150 ms), on window focus, and every 10 s.
- `GET /api/events` is SSE with `event: change` carrying `{cursor, privacyEpoch, coreId, bootId, reset?}`, plus `event: revoked`. It accepts `Last-Event-ID` or `?after=`.
- The selected agent's messages are fetched alongside the state through `GET /api/agents/messages?bot=<id>[&after=<seq>|&before=<seq>]`.
- A change in `privacyEpoch` or `bootId` clears all caches and reloads.

**`/api/state` top-level fields** (`index.ts:182`, `store.ts:313`)
- `config`: `{id, provider_id, endpoint, default_model, configured}`. It is `undefined` when no model is configured.
- `bots`: `agents.contacts()` rows plus policy and profile fields.
  - Columns: `id, name, instructions, version, read_seq, appearance_json, appearance_version, unread_count, last_message, last_message_at`.
  - Joined columns: `policy_version, policy_json` (`{"tools":[...]}`) and `expertise_json` (a JSON array of strings).
  - Order is by `created_at`, active bots only.
- `conversations`, `approvals`, `delegations`.
  - `approvals` rows: `id, argument_hash, expires_at, tool_name, arguments_json, authorization_snapshot_json, bot_id, conversation_id, task_id, call_id`.
  - `delegations` are `a2a_messages` rows: `id, call_id, parent_task_id, sender_bot_id, receiver_bot_id, child_conversation_id, child_task_id, root_task_id, depth, status, payload, result, created_at, finished_at`. Limit 100.
- `memories`: `id, scope('bot'|'workspace'), bot_id, title, version, updated_at, content`, active only, ordered by `updated_at` desc.
- `devices`: `id, name, status('bound'|'revoked'), capabilities_json`. There is no platform or online column.
- `tasks`: `id, conversation_id, bot_id, objective, status, result_summary, created_at, ended_at, active_tool`. Limit 200, active first.
- `usage`: `bot_id, calls, input_tokens, output_tokens`.
- `connectors`: `ConnectorView[]` (see section 9).
- `sync`: `{cursor, privacyEpoch, coreId, bootId}`.
- `hostDeviceId`.
- `memoryEngine`: `{provider:"hindsight", release, status:"not_installed"|"unavailable"|"connected", revision, forgetting, pending, failed, quarantined, error, service}`. `service` is the memory plugin's `status`.
- `memoryPlugin`: `{providers:[{id,name,protocol}], provider, enabled, endpoint, hasToken, restartRequired, status:"disabled"|"connecting"|"ready"|"unavailable", error}`.
- `directory`: an array of `{id, bot_id, name, instructions, description, version, expertise[], capabilities[], availability:"busy"|"ready", profile_version, capability_version, directory_version}`. The web UI does not read it.
- `routines`: all `agent_routines` rows, `created_at` desc. Columns: `id, bot_id, name, prompt, schedule_kind('once'|'interval'|'daily'), interval_ms, local_time, time_zone, enabled(0|1), next_due_at, version, created_at`.
- `occurrences`: `routine_occurrences` columns `id, routine_id, routine_version, scheduled_at, status('pending'|'running'|'succeeded'|'failed'|'cancelled'), task_id, created_at`, plus `bot_id, name`. Limit 100.
- `journal`: `agent_journal` rows `task_id, bot_id, objective, result, created_at`, `created_at` desc, limit 100.
- `onlineDevices`: an array of device ids that currently have an open socket.
- `node`: `{status, origin, root, exec, computer, computerSupported, deviceId, connected, unknownCalls:[{call_id, capability, arguments_json, version}], hosted}`. `hosted` is true when the server runs with `hostDevice:false`.
- `dataDir`, `runtime:"Pi 1.0.4"`, `address` (the request origin), `lanEnabled`.

**Web-only localStorage keys**

| Key | Meaning |
|---|---|
| `nexbot.selectedAgent` | Last selected bot id. |
| `nexbot.pinnedAgents` | JSON array of bot ids; pinned contacts. |
| `nexbot.dark` | `"1"` or `"0"`; sets `document.documentElement.dataset.dark` and the `data-dark` attribute. |
| `nexbot.motion` | `"0"` disables animation; the default is on. |
| `nexbot.avatarPortraits.v1` | Legacy `{botId: portraitId}` map. It is read only as a fallback in `appearanceOf`. `avatars/preferences.ts` (`avatarForBot`, `saveAvatar`) is not used anywhere. |
| `nexbot.botLooks` | `{botId: {shape, ink}}`, read by `characters.tsx` `lookOf` for decorative badge and author-name ink colors. `saveBotCustomLook` is never called. |

- Per-bot composer drafts live in memory only (`drafts` ref) and are not persisted.

**Web endpoints unused by the web UI**
- `POST /api/conversations`, `POST /api/input`, `GET /api/messages`.
- `POST /api/memory/publish`.
- `POST /api/clients/invite`: 410 `请在其他设备使用同一账号登录` when identity is enabled.
- `POST /api/client/logout`.
- `GET /api/clients` is used only by the settings session list (already implemented natively).

## 1. Create agent ("+")

**UI**
- Entry points:
  - Sidebar brand-row `+` button with `aria-label="添加 Agent"` (CS:40).
  - Empty-sidebar link `创建第一个 Agent` (CS:49).
  - Welcome screen button `创建 Agent` (AD:238-243).
- The welcome screen shows when there are no bots: `创建你的第一个 Agent` / `给它一个名字，身份与职责可以之后补充。消息、记忆和工作会持续保留。`
- The dialog (`editBot`, AD:180, using `Editor` from P:6) is titled `添加 Agent`.
  - Field `名字` (`name`, required).
  - Field `补充身份、职责与沟通方式（选填）` (`instructions`, multiline, 6 rows, hint `名字也是身份的一部分，留空也可以。修改后，其他 Agent 会自动获取最新资料。`).
  - Buttons `保存` (disabled while pending) and `取消`; the close icon has `aria-label="关闭"`.
  - There is no inline error display in this dialog. Failures show in the top error banner (`role=alert`, close `aria-label="关闭错误"`).
  - Escape closes the dialog.
- After success the dialog closes, the new bot is selected, the page switches to `agent`, and the state reloads.

**API**
- `POST /api/bots` with `{name: string (required, trimmed, ≤80), instructions?: string (≤32000)}`.
  - The web actually sends `{name, instructions, id: undefined, version: undefined}`.
  - Response is `{id}`.
- Server behavior (`store.ts:252`, `index.ts:258`):
  - Inserts the bot with `status=active` and `model_connection_id='default'` if a config exists.
  - Creates the `bot_policies` row with `policy_json={"tools": <all 25 actions>}` and `approval_mode=allow_scoped`.
  - Creates the inbox and the bot's memory-bank binding.
  - Creates the `bot_public_profiles` row.
- Errors:
  - `请输入有效内容（长度超出限制或为空）`.
  - `请输入有效内容（长度超出限制或类型不正确）`.
  - `Agent 不存在`.

**Client state**
- No version is needed on create.

## 2. Edit identity

**UI**
- Entry points: inspector `编辑身份` text link (AD:320) and the `助手详情` drawer.
- The dialog is titled `Agent 身份`, with the same two fields prefilled (`名字`, `补充身份、职责与沟通方式（选填）`).

**API**
- `POST /api/bots/update` with `{id, name (required, ≤80), instructions? (≤32000), version (required integer ≥1, equals bots row .version), expertise?: string[]}`.
  - Response is `{ok:true}`.
- Errors:
  - `Agent 已被更新，请刷新` (version conflict, or bot not active).
  - `专长标签无效` (expertise is not an array, has more than 20 entries, or any entry is empty, non-string, or over 80 characters).
  - `Agent 不存在`.
- The web never sends `expertise`. It is read from the bots row field `expertise_json` and not displayed in the UI.
- The bot `version` must be echoed. After success the web reloads the state.

## 3. Avatar picker (appearance)

**UI** (AP, AV)
- Entry points: inspector `更换头像` (the palette icon button with `title="更换头像"` in AD:310, and the text link in AD:322).
- Heading is `属于 {bot.name} 的形象`, with eyebrow `NEXBOT COMPANIONS`. Close has `aria-label="关闭头像选择"`.
- Preview panel (104 px avatar plus name):
  - Caption line is `companionLabels[previewState]`.
  - State buttons (aria-label `预览状态`): 待命(idle), 思考(thinking), 执行(working), 待确认(approval), 完成(done), 断线(offline).
  - Footnote: `预览动效，不会启动任务`.
- Mode toggle (aria-label `头像类型`): `角色` (companion) and `经典图库` (portrait).
- Companion mode has three groups:
  - `轮廓`: shapes `soft` 软方, `bean` 豆荚, `pebble` 卵石, `bud` 新芽.
  - `专属颜色`: colors teal 松青 `#23756d`, ink 墨色 `#414853`, blue 雾蓝 `#426dac`, clay 陶红 `#b26351`, plum 灰紫 `#7c608f`.
  - `20 个搭配`: the 4×5 grid, each with `aria-label` `{色名}{形名}`.
  - Shape border-radius values are soft `27% 35% 27% 35%`, bean `50% 50% 35% 50%`, pebble `52% 40% 48% 28%`, bud `52% 12% 52% 12%`.
- Portrait mode (aria-label `经典头像`) has 20 options, each with `aria-label` `选择{name}头像`. IDs with names:

| ID | Name | ID | Name |
|---|---|---|---|
| fox | 赤狐 | tiger | 橘山 |
| owl | 知更 | deer | 林间 |
| cat | 芝麻 | penguin | 南极 |
| bear | 麦芽 | seal | 海盐 |
| rabbit | 棉朵 | otter | 栗子 |
| dog | 吐司 | octopus | 墨墨 |
| panda | 竹白 | frog | 青禾 |
| koala | 尤加 | robot | 小钛 |
| astronaut | 阿波罗 | star | 星芒 |
| cloud | 云团 | sprout | 芽芽 |
| | | koala | 尤加 |

  - The SVG assets live in `src/personal/avatars/*.svg`.
- Footer text is `应用后同步到此账号的其他设备`. Buttons are `取消` and `应用形象` (`保存中…` while saving). Errors show in an `role=alert` paragraph.
- Tab focus is trapped in the dialog. Escape is swallowed while saving.
- Avatar state ring and badge, `companionState(task, approval, connected)`:
  - `!connected` gives `offline`.
  - An approval, or task status `awaiting_approval`, gives `approval`.
  - Task status `failed` or `needs_reconciliation` gives `failed`.
  - Task status `paused`, `cancelled` or `rejected` gives `paused`.
  - Task status `succeeded` gives `done`.
  - Task status `queued`, or `running` with no `active_tool`, gives `thinking`.
  - Any other task gives `working`; no task gives `idle`.
- `companionLabels`: idle 准备好了, thinking 正在思考, working 正在执行, approval 等你确认, done 已完成, failed 执行未完成, offline 正在重新连接, paused 已暂停.
- In the web UI, `done` or `failed` is shown for 2.4 s after a task ends, then returns to idle.

**Default appearance when `appearance_json` is absent** (`appearanceOf`)
- First fall back to the legacy localStorage portrait.
- Otherwise, if the bot is the first in `state.bots` (the earliest by `created_at`) or has no id, the default is `{kind:"companion", shape:"soft", color:"teal"}`.
- Otherwise compute `seed` by folding the characters of `bot.id`, starting from 0 and applying `seed = (seed*31 + charCode) >>> 0` for each character.
  - shape = `["soft","bean","pebble","bud"][seed % 4]`.
  - color = `["teal","ink","blue","clay","plum"][floor(seed/4) % 5]`.
- Invalid or unparseable `appearance_json` falls through to these defaults.

**API**
- `POST /api/bots/appearance` with `{id, appearance, version}`.
  - `appearance` is either `{"kind":"companion","shape":"soft|bean|pebble|bud","color":"teal|ink|blue|clay|plum"}` or `{"kind":"portrait","id":"<one of the 20 ids>"}`.
  - `version` is `Number(bot.appearance_version ?? 0)`; the bots row exposes `appearance_version`, which is 0 when no row exists.
  - Response is `{ok:true}`.
- Errors:
  - `头像配置无效` (not an object).
  - `请选择有效的头像形状与颜色`.
  - `Agent 已归档`.
  - `头像已在其他设备更新，请关闭后重新打开` (version mismatch).
  - `Agent 不存在`.

## 4. Pin / unpin contacts and the 置顶 section

**UI**
- The pin button is in the inspector top-right (AD:311). Its title is `置顶联系人` when unpinned and `取消置顶` when pinned, and it has a `selected` style when pinned.
- Sidebar groups (CS:36):
  - Section `置顶` shows pinned bots matching the search.
  - Section `我的 Agent` shows the rest.
  - Empty groups are not rendered, and the title is only a label.
- Other sidebar strings:
  - Label row `对话` plus the total count `state.bots.length`.
  - Search placeholder `搜索联系人` (`aria-label="搜索 Agent"`), clear button `aria-label="清空搜索"`.
  - Empty state: `没有找到联系人` (when searching) or `你的 Agent 会出现在这里`.
- Contact row:
  - Avatar (40 px) with the companion state.
  - Name and a time. The time is `HH:mm` if today, otherwise `M/D`, from `last_message_at`.
  - Preview line: `taskPhrase(task)` when a task is active (class `is-working`), else `last_message`, else `instructions`, else `开始一段对话`.
  - Unread badge: `unread_count` is shown only if >0, capped as `99+`.
  - The "active task" is the first `state.tasks` row for the bot with status not in succeeded/failed/cancelled/rejected.

**API**
- None. Pinning is purely local (`nexbot.pinnedAgents`). Ordering within a group is server order (`created_at`).

**Search**
- Case-insensitive `includes` on `` `${name} ${instructions ?? ""}` ``.
- There is no message or global search. The connectors page has its own name filter (section 9).

## 5. Archive agent

**UI**
- Inspector `设置` tab, button `归档 Agent` (class `danger-link`, AD:397).
- The confirm dialog is titled `归档这个 Agent？` with detail `保留消息与记忆，停用例行任务。` and buttons `确认` (danger) and `取消` (autofocus).

**API**
- `POST /api/bots/archive` with `{id, version (bot.version)}`. Response is `{ok:true}`.
- Server behavior: sets `status=archived`, bumps the version, and disables all of that bot's `agent_routines` (`enabled=0`).
- Errors:
  - `请先停止并核对该 Agent 的未结束工作` (any task with `ended_at IS NULL`).
  - `Agent 已变化，请刷新`.
  - `Agent 不存在`.
- After success, `bots` no longer contains the bot and the web auto-selects the first remaining bot (or shows the welcome screen).

## 6. Agent permissions / policy editor

**UI**
- Entry point: inspector `设置` tab, row `工具权限` (shield icon), button text `已授权 {n} 项 · 配置`.
  - `n` is the length of the parsed `bot.policy_json.tools` array, unfiltered.
- The dialog title is `{bot.name} 的工具权限`, with a close button `aria-label="关闭"`.
- It shows a checkbox grid. Label, action id, and order below match the Chinese label map in `AgentPolicyEditor` (AD:36):

| Action | Label |
|---|---|
| memory.search | 检索自身与共享记忆 |
| memory.reflect | 综合记忆并引用来源 |
| memory.read | 读取自身与共享记忆 |
| memory.write | 维护自身私有记忆 |
| memory.delete | 撤回自身私有记忆（需批准） |
| memory.forget | 彻底遗忘相关原文与副本（需批准） |
| routine.list | 查看自己的计划 |
| routine.save | 安排或修改自己的计划 |
| routine.toggle | 暂停或恢复自己的计划 |
| routine.run | 立即运行自己的计划 |
| agent.directory | 读取 Agent 公开目录 |
| agent.delegate | 联系同伴 |
| agent.create | 按指示招募新同伴 |
| agent.update | 按指示更新同伴资料 |
| device.list | 查看已授权设备目录 |
| device.read | 读取已授权设备文件 |
| device.exec | 执行设备终端命令 |
| device.inventory | 识别设备与在线状态 |
| device.info | 读取设备系统信息 |
| device.computer | 使用获准的电脑窗口 |
| connector.list | 查看已授权连接器 |
| connector.tools | 查看连接器工具 |
| connector.call | 调用连接器工具（需批准） |
| skill.list | 查看通用技能目录 |
| skill.read | 阅读通用技能说明 |

- Footer note: `设备还须在本机授权。终端命令由这个 Agent 逐次申请批准；联系同伴和普通记忆操作自动执行。`
- Buttons are `保存` (primary) and `取消`.

**API**
- `POST /api/bots/policy` with `{id, version (bot.policy_version), tools: string[]}`. Response is `{ok:true}`.
- The server `actions` list (`policy.ts:8`) is the same 25 ids, in the order: memory.search, memory.reflect, memory.read, memory.write, memory.delete, memory.forget, agent.directory, agent.delegate, agent.create, agent.update, routine.list, routine.save, routine.toggle, routine.run, device.inventory, device.info, device.list, device.read, device.exec, device.computer, skill.list, skill.read, connector.list, connector.tools, connector.call.
- Server behavior: sets `policy_json={"tools": dedup(tools)}`, sets `approval_mode='allow_scoped'`, and bumps the version.
- Errors:
  - `工具清单无效` (not an array, or any unknown id).
  - `权限已变化，请刷新` (version mismatch or `version<1`).
  - `Agent 不存在`.
- Side effects elsewhere:
  - `connectors/grant` adds `connector.list/tools/call` to the policy and bumps the version, even for an empty grant.
  - A new agent created through `agent.create` is capped to the creator's tools.

**Approval-mode semantics and the approval card text** (AD:288, defined in section 15)
- Per-action approval labels shown in the approval card:

| Action | Approval-card label |
|---|---|
| agent.delegate | 联系其他 Agent |
| agent.create | 创建新的 Agent |
| agent.update | 修改 Agent 的名字和身份说明 |
| memory.write | 写入长期记忆 |
| memory.forget | 彻底遗忘原文与相关副本（相关工作会停止） |
| device.read | 读取设备文件 |
| device.list | 查看设备目录 |
| device.exec | 执行终端命令 |
| device.computer | 操作电脑窗口 |
| connector.call | 调用连接器工具 |

- Any other `tool_name` is shown raw.
- Tool step labels (`toolLabels`, `api.ts:41`; `toolPhrases` are the in-progress forms at `api.ts:42`):

| Action | Label | In-progress phrase |
|---|---|---|
| connector.list | 查看连接器 | 正在查看连接器 |
| connector.tools | 读取工具目录 | 正在读取工具目录 |
| connector.call | 调用连接器工具 | 正在调用连接器工具 |
| agent.delegate | 联系同伴 | 正在联系同伴 |
| agent.directory | 查看同伴目录 | 正在查看同伴目录 |
| agent.create | 招募新同伴 | 正在创建新同伴 |
| agent.update | 更新同伴资料 | 正在更新同伴资料 |
| memory.search | 检索记忆 | 正在检索记忆 |
| memory.read | 读取记忆 | 正在读取记忆 |
| memory.reflect | 综合记忆 | 正在综合记忆 |
| memory.write | 写入长期记忆 | 正在记录长期记忆 |
| memory.delete | 撤回记忆 | 正在整理记忆 |
| memory.forget | 清理记忆 | 正在清理记忆 |
| routine.list | 查看计划 | 正在查看计划 |
| routine.save | 保存例行任务 | 正在安排例行任务 |
| routine.toggle | 切换计划状态 | 正在调整计划 |
| routine.run | 立即运行计划 | 正在执行例行任务 |
| device.list | 查看设备目录 | 正在查看设备目录 |
| device.read | 读取设备文件 | 正在读取设备文件 |
| device.exec | 执行终端命令 | 正在执行终端命令 |
| device.inventory | 检查设备目录 | 正在检查设备状态 |
| device.info | 读取设备信息 | 正在读取设备信息 |
| device.computer | 操作电脑窗口 | 正在操作电脑窗口 |
| skill.list | 查看技能目录 | 正在查看技能目录 |
| skill.read | 阅读技能说明 | 正在阅读技能说明 |

- `statuses` map (`api.ts:40`):

| Status | Label |
|---|---|
| queued | 排队中 |
| running | 执行中 |
| awaiting_approval | 等你批准 |
| paused | 已暂停 |
| needs_reconciliation | 需核对结果 |
| cancelling | 取消中 |
| succeeded | 已完成 |
| failed | 失败 |
| cancelled | 已取消 |
| rejected | 已拒绝 |
| bound | 已配对 |
| revoked | 已撤销 |
| pending | 待执行 |

- `taskPhrase(task)`: `cancelling` gives `正在停止…`, `awaiting_approval` gives `等你批准`, otherwise `toolPhrases[active_tool]`, then `statuses[status]`, then `执行中`.

## 7. Inspector (`助手详情`) layout

- The drawer (AD:307) has a heading `助手详情` and a close button `aria-label="收起资料"`.
- It is open by default when `window.innerWidth > 1040`. It is toggled by:
  - the header info button (`aria-label="Agent 资料"`);
  - clicking the header contact block (`title="点击展开或收起 Agent 资料"`).
- Profile block:
  - Avatar 64 px.
  - Name.
  - Static badge `个人 Agent`.
  - Quick links `编辑身份` · `更换头像`.
- Tabs (state variable `tab`): `工作` (profile, default), `资料` (memory), `设置`.
- Selecting another agent or opening a preview/memory pill changes `tab`.

### 7a. 工作 tab (AD:334-354)

- **Activity card**
  - Title is `taskPhrase(tasks[0])` or `准备就绪`.
  - Subtext is the first 90 characters of `tasks[0].objective`, or `发一条消息，开始新的工作。`.
- **`正在处理`** (only if tasks exist)
  - One card per active task: a tag with `taskPhrase(t)`, a paragraph with `t.objective || "Agent 工作"`, a `继续` button only when `status==="paused"` (resume), and a `停止` button (cancel).
  - Resume is `POST /api/resume {taskId}`, response `{ok:true}`. Error `该任务不可继续` (task not in `paused`).
  - Cancel is `POST /api/cancel {taskId}`. It always returns `{ok:true}`, even when the task is missing or already cancelling.
- **`最近执行`** (only if the bot has occurrences)
  - Up to 10 rows for the bot: `{o.name}` plus `{statuses[o.status]} · {formatTime(o.scheduled_at)}`.
  - `formatTime` is zh-CN `M/D HH:mm`.
- **`连接器`** header with a `+` button (`aria-label="管理连接器"`). Behavior:
  - It lists the connectors that are enabled and have a grant for this bot with `tools.length > 0`.
  - Each row is a button showing the name and `{n} 项工具`.
  - A final link reads `连接工具与管理授权 →`. All of these open the connectors page.
- **`可用设备`**
  - Rows for `state.devices` where `status==="bound"`: the name plus a green `在线` or `离线` label based on `onlineDevices`.
  - A final link reads `管理设备网络 →`.
- **`例行任务`** (section 8 for the editor)
  - Header `+` with `aria-label="添加例行任务"`.
  - Each routine row:
    - Name.
    - A switch (aria-label `暂停{name}` or `启用{name}`).
    - A schedule label (`routineLabel`).
    - Buttons `编辑` and `现在执行`.
    - `下次 {formatTime(next_due_at)}` if `enabled` and `next_due_at`.
  - Empty state: `安排一项例行任务，Agent 会按计划工作并给你汇报。` with a button `添加例行任务`.

### 7b. 设置 tab (AD:355-399)

- Checkbox `轻量动效` with small text `仅当前助手`. It is local (`nexbot.motion`), and in the code it applies globally to `data-motion` on the app root.
- Section `助手设置`:
  - Group `关于`: shows the `instructions` text, or `尚未补充职责说明，点击上方“编辑身份”即可设置。`.
    - If longer than 140 characters it is clamped, with a toggle `展开全部` or `收起说明`.
  - Group `能力`:
    - Row `驱动模型`: a pill with `state.config.default_model` or `未连接模型`; clicking goes to the Settings page.
    - Row `工具权限`: the policy editor (section 6).
    - Row `工作目录`: code text `state.node.root || "未限定主机目录"`, with tooltip `state.node.root || "默认沙箱目录"`.
  - Group `用量` (from `state.usage` for the bot; all are 0 if there is no row):
    - `累计调用` as `{calls} 次`.
    - `输入 Token` (`toLocaleString`).
    - `输出 Token` (`toLocaleString`).
- Footer actions:
  - `导出记录` / `已复制记录` (only if messages are loaded). This is the same as the share button in section 15.
  - `归档 Agent` (section 5).

### 7c. 资料 tab (AD:401-410)

- **Preview card**: shown at the top when a preview is set (section 12).
- **Long-term memory** (section 10).
- **Work records** (section 10).
- **MemoryWorkbench** (section 11).

## 8. Routines

**UI**
- Entry points:
  - 工作 tab `+` and `添加例行任务`.
  - Welcome chip `安排例行任务` (clock icon).
  - Composer `+` menu `安排例行任务`.
  - Row `编辑`.
- The editor dialog (`RoutineEditor`, AD:447) is titled `添加例行任务` or `编辑例行任务`.
  - `名称` (`name`, required, placeholder `例如：每日工作计划`).
  - `让 Agent 做什么` (`prompt`, textarea, 4 rows, required, placeholder `描述目标、需要参考的资料和汇报方式`).
  - `执行计划` select with `每天` (daily), `固定间隔` (interval), and `指定时间执行一次` (once).
    - The default for a new routine is `daily`; for an existing routine it keeps the stored kind.
  - Conditional field by kind:
    - daily: `每天的时间`, `<input type=time>`, required, default `existing.local_time` or `09:00`.
    - interval: `间隔（分钟）`, number, `min=1`, `max=525600`, required, default is `interval_ms/60000` or 60.
    - once: `执行时间（本机时间）`, `datetime-local`, required. It is not prefilled when editing.
  - `时区` (`timeZone`, required, default is the stored `time_zone` or the browser's resolved IANA zone).
  - Hint: `按计划唤醒 Agent 会调用你配置的模型。需要批准的工具操作仍会等待你处理。`
  - Buttons are `保存` (disabled while pending) and `取消`.
- `routineLabel(row)`:
  - daily: `每天 {local_time} · {time_zone}`.
  - interval: `每 {interval_ms/60000} 分钟`.
  - once: `一次性任务`.
- Toggle switch aria-labels are `暂停{name}` and `启用{name}`.

**API**
- `POST /api/routines` (save)
  - Body: `{botId (required), name (required, ≤100), prompt (required, ≤16000), scheduleKind: "daily"|"interval"|"once", timeZone (IANA; defaults to server zone if absent), localTime ("HH:mm"; daily only), intervalMinutes (interval only), runAt (epoch ms, once only), id? (existing routine; omit to create), version? (required with id)}`.
  - The web also posts the raw `FormData` fields. `runAt` is computed client-side as `new Date(datetimeLocalString).getTime()` and is `undefined` for other kinds.
  - Response is `{id}`.
  - Validation errors:
    - `每日时间须为 HH:mm`.
    - `间隔须为 1 分钟至 365 天`.
    - `执行时间须在未来`.
    - `不支持的执行计划`.
    - `无法计算下一次每日执行时间`.
    - `例行任务已修改，请刷新` (version mismatch, or the routine belongs to another bot).
    - `Agent 不存在`.
    - A bad time zone throws the raw Intl `RangeError` ("Invalid time zone specified: …").
  - Behavior on save:
    - A created routine starts `enabled=1`.
    - An edit forces `enabled=1`, recomputes `next_due_at`, bumps the version, and cancels pending occurrences.
    - Next-due logic: daily uses `nextDaily(localTime, zone)`; interval is now + interval; once is `runAt`.
- `POST /api/routines/toggle` with `{id, version (routine.version), enabled: boolean}`. Response is `{ok:true}`.
  - Errors: `启用状态无效` (a non-boolean `enabled`), `例行任务已修改，请刷新`, `一次性任务已到期，请重新设置执行时间`.
  - Enabling recomputes `next_due_at` if it is null or past; disabling cancels pending occurrences.
- `POST /api/routines/run` with `{id, clientId (generated crypto.randomUUID(), idempotency token, text ≤100)}`. Response is `{ok:true}`.
  - Error: `例行任务不存在`. There is no version check here.
  - It inserts occurrence `manual:{routineId}:{clientId}`, so a retry with the same `clientId` is idempotent.
- Execution:
  - The scheduler ticks every 5 s.
  - It only starts runs if a model is configured.
  - It starts a task with objective `按用户配置的例行任务执行：{name}\n{prompt}`, and a system message `开始例行任务：{name}`.
  - After a `once` routine fires, `enabled=0` and `next_due_at=NULL`.
  - Direct user input preempts a running routine (system message `例行任务已让路给用户新消息`).

**Client state**
- The routine `version` must be echoed on edit and toggle.

## 9. Connectors page

**Navigation**
- Account-menu item `连接器` (a trailing count of enabled connectors, or empty). The page header title is `连接器`.
- Also reachable from the inspector 工作 tab `+`/links and the composer `+` menu `管理连接器`.

**Page strings** (CP:43-62)
- Eyebrow `扩展 Agent 的能力`, h1 `连接你的工具`, sub `接入 MCP 服务，让 Agent 在对话中使用获准的工具。`, button `添加连接器`.
- Empty state (no connectors):
  - h2 `把常用工具带进对话`.
  - Text `添加 MCP 服务地址，测试连接后，为需要的 Agent 选择工具。`.
  - Button `添加第一个连接器`.
  - Small text `支持 Streamable HTTP 与 SSE，可使用 Bearer Token 认证。`.
- List (aria `连接器列表`):
  - Search input `搜索连接器` (case-insensitive substring on `name`).
  - Each item shows the name and a subtitle: `已停用` if disabled, else `需要检查` if `error`, else `{tools.length} 个工具` if `checkedAt`, else `尚未测试`.
  - The first item is selected by default.
- Detail (aria `连接器详情`):
  - Name, a status chip, and an `编辑` button.
  - Status chip: `已停用` / `连接异常` (when `error`) / `连接测试通过` (`checkedAt` and no error) / `等待测试`.
  - Metadata rows:
    - `服务地址`.
    - `认证`: `Bearer Token · 已加密保存` if `hasToken`, else `无需令牌`.
    - `传输方式`: `SSE` or `Streamable HTTP`.
  - Action buttons: `测试连接` (shows a spinner while running) and `停用`/`启用`.
  - Section `工具目录` with a count.
    - Each tool is a disclosure with the `name`, `description || "服务未提供工具说明"`, and pretty-printed `inputSchema`.
    - Empty text: `测试连接后，工具会显示在这里。`.
  - Section `Agent 授权` with help text `只开放选中的工具。实际调用会在该 Agent 的对话中请求批准。`
    - A row per bot with the name and `{n} 项工具已授权`, and a `管理授权` button (disabled unless the connector has `checkedAt`).
    - Empty: `创建 Agent 后，可以在这里授权。`.
    - The grant editor shows `为 {bot} 选择工具`, one checkbox per tool name, and buttons `保存授权` / `取消`.
  - Remove area: `移除连接器` → `移除连接器及全部工具授权？` with `确认移除` / `取消`.
  - A banner with the server error is shown if the row's `error` is set.
- Feedback strings:
  - Save: `已保存。点击“测试连接”获取工具目录。`.
  - Test: `连接成功，工具目录已更新。`.
  - Grant: `工具授权已更新。`.
  - Operation errors fall back to `操作失败，请重试`. After any failed action the page reloads the state.
- Modal editor (`添加连接器` / `编辑连接器`, close `aria-label="关闭连接器编辑"`):
  - `名称` (`name`, required, maxLength 80, placeholder `例如：团队知识库`).
  - `MCP 服务地址` (`url`, type url, required, placeholder `https://example.com/mcp`).
  - `传输方式` select: `http` = Streamable HTTP, `sse` = SSE.
  - `Bearer Token（选填）` (`token`, password, placeholder `服务无需认证时留空`, or `留空保留原令牌；更换地址时需重新填写` when editing a connector that has a token).
  - Checkbox `清除已保存的令牌` (`clearToken`), shown only when editing a connector with a token.
  - Note: `地址由后端 Core 访问。本机地址指后端所在的电脑。`
  - Buttons `保存连接器` (`保存中…`) and `取消`.
  - Escape closes the modal unless busy.

**API**
- `POST /api/connectors/save`
  - Body: `{id? (edit), version? (edit; must equal the row version exactly), name (≤80, required), url (≤2048), transport: "http"|"sse" (anything else becomes http), token? (string ≤4096, no CR/LF/NUL), clearToken?: boolean, enabled?: boolean (false → disabled)}`.
  - The web sends `enabled: previous?.enabled ?? true` and `token:""` when blank.
  - Response is `{id}`.
  - Credential rule:
    - A non-empty token replaces the credential.
    - Otherwise `clearToken:true` clears it.
    - Otherwise the credential is kept only if the URL and transport are unchanged. A changed URL or transport drops the stored credential.
  - An edit resets `tools_json=[]`, `checked_at=NULL` and `error=NULL`, and bumps the version. A changed URL or transport deletes all grants.
  - URL rules (`connectorUrl`): https, or http only for localhost/127.x/10.x/192.168.x/172.16-31.x/::1. No credentials, query or hash.
  - Errors:
    - `请使用 HTTPS 地址；本机或私有网络可使用 HTTP。令牌请填写在独立字段。`
    - `不能连接未指定地址或链路本地地址`
    - `令牌格式无效`
    - `连接器已被修改，请刷新后重试`
    - `连接器不存在`
    - `请输入有效内容（…）`
    - An unparseable URL throws the raw `Invalid URL`.
- `POST /api/connectors/test` with `{id, version}`.
  - Response is `{ok:true, count}`.
  - Behavior: contacts the MCP server (timeout 15 s), paginates `tools/list` (max 10 pages, 200 tools), validates names (`/^[\w.:-]{1,200}$/`) and `inputSchema.type==="object"`, redacts the token, stores the tools and `checked_at`, and bumps the version.
  - Errors:
    - `连接器已变化，请刷新后测试`
    - `连接器已变化，请重新测试`
    - `连接失败（HTTP {status}），请检查地址与认证信息。`
    - `连接失败，请检查服务地址、认证信息及 MCP 工具目录。`
    - The test error is also stored in the row `error` field.
    - Internal messages such as `工具目录无效`, `工具名称重复`, `工具目录过大` and `工具目录分页无效` are replaced by the generic failure text.
- `POST /api/connectors/grant` with `{id, version, botId, tools: string[]}`.
  - Response is `{ok:true}`.
  - `tools` must be names from the connector's catalog; an empty array revokes.
  - Side effects: bumps the connector `version`, and adds `connector.list/tools/call` to the bot policy and bumps `policy_version`.
  - Errors:
    - `连接器已变化，请刷新后授权`
    - `Agent 不存在`
    - `请选择工具目录中的工具`
- `POST /api/connectors/toggle` with `{id, version, enabled: boolean}`. Response is `{ok:true}`. Error: `连接器已变化，请刷新后重试`.
- `POST /api/connectors/delete` with `{id, version}`. Response is `{ok:true}`. Error: `连接器已变化，请刷新后重试`.
- The version (`connectors[].version`) is echoed on every mutation. Almost every mutation, including test and grant, bumps it, so the web reloads state after each.

**State**
- `state.connectors[]`: `{id, name, url, transport, enabled, version, hasToken, tools:[{name, description, inputSchema}], checkedAt (ms|null), error (string|null), grants:[{botId, tools[]}]}`.
- The token is never returned.

## 10. Inspector 资料 tab: long-term memory and work records

**Long-term memory** (AD:401-405)
- Header `长期记忆` with a `+` button (`aria-label="添加记忆"`).
- The list is `state.memories` where `scope==="workspace" || bot_id===selectedBotId`.
- Scope pills appear only when there is more than one memory: `全部 ({count})`, `仅当前 Agent`, `共享`.
- Each card shows:
  - The title.
  - A small line: `所有 Agent 共享` or `仅当前 Agent`, plus ` · {formatShortTime(updated_at)}`.
  - The content.
  - Buttons: `编辑`, and a trash icon (`aria-label="撤回{title}"`).
- Footer paragraph: `消息与工作记录自动保存。长期记忆可在这里维护，也可以让 Agent 帮你记住。`
- Memory notice pill in the header: `已更新记忆：{title}` (sparkles icon).
  - It appears when, after the first load, a memory visible to the bot (workspace, or this bot's) has a changed `version:updated_at` signature.
  - Clicking it opens the 资料 tab and clears the pill.
  - The signature map resets when the selected agent changes, via the `memoryNotice` reset.
- Editor dialog titled `添加记忆` or `编辑记忆`:
  - `标题` (required).
  - `记忆内容` (multiline, required).
  - `可见范围` select: `仅 {bot.name}` (value `bot`) and `与所有 Agent 共享` (value `workspace`). It defaults to the existing scope, or `bot`.
- Delete confirm: title `撤回这条记忆？`, detail `撤回后不再用于长期记忆检索，原始消息和工作记录保留。如需一起清理，请使用下方的彻底遗忘。`.
- Work records: heading `已有工作记录`. The first 8 `state.journal` rows for the bot are shown as `<details>`.
  - The summary is `objective.slice(0,100)`.
  - The body is `result` plus `formatTime(created_at)`.

**API**
- `POST /api/memory` (save)
  - Body: `{botId, title (≤200), content (≤20000), scope: "bot"|"workspace" (anything else → bot), documentId? (edit; omit to create), expectedVersion (default 0; edit passes the row version)}`.
  - The web sends `botId = existing?.bot_id ?? current botId`. For workspace memories `bot_id` is null, so the current bot is used.
  - Response is `{documentId, version, saved:true}`.
  - Errors:
    - `记忆版本无效`
    - `禁止修改其他 Agent 的记忆或更换记忆范围`
    - `记忆已被更新，请重新读取后提交`
    - The generic `请输入有效内容…` message.
  - Note: the scope cannot be changed on an existing memory, although the web edit dialog still shows the select.
- `POST /api/memory/delete` with `{id, version}`. Response is `{ok:true}`. Error: `记忆版本已变化`. It marks the document as `deleted` and retracts it from the memory index.
- A memory row's `version` must be echoed on edit and delete.
- `POST /api/memory/publish` with `{botId, ref, sourceHash, intent (≤200)}` promotes a private source to a workspace-shared memory titled `用户共享的记忆`. Response is `{documentId, version, saved:true}`. Errors: `来源已变化，请重新查看`, `来源已撤回或不可见`, `来源已变化`. The web UI has no control for it.

## 11. Memory workbench (资料 tab, below the list)

- It renders only if `state.memoryEngine` exists, and is keyed by `botId + memoryEngine.revision + sync.bootId + sync.privacyEpoch`, so it resets on any change.
- **Find and synthesize** (h2 `查找与综合`):
  - Field `问题或主题` (required, maxLength 200, placeholder `例如：我之前确定了哪些项目约束？`).
  - Buttons `查找` and `综合记忆` (disabled when the query is empty).
  - Note: `只检索当前 Agent 的私有记忆与共享记忆。综合会调用你配置的模型。`
- Status text under it (`role=status`):
  - After find: `检索完成` (`status==="available"`), `记忆正在同步` (`pending`), otherwise `语义记忆暂不可用`.
  - After synthesize: `综合完成` or `没有足够的记忆证据`.
  - After forget: `遗忘已完成`, or `原文已清理，正在清理引擎派生记忆。完成前旧 bank 不可读取。`
  - Errors: `memory` operation errors are shown through the same status line, falling back to `记忆操作失败`.
- Fact cards (`facts`):
  - A small line: `共享` (scope `workspace`) or `私有`, then ` · `, then a source-class label:
    - `user_stated` 用户陈述
    - `peer_reported` 同伴转述
    - `agent_inferred` Agent 推断
    - `synthesized` 综合观察
    - any other value is shown raw.
  - The text.
  - Per `refs[]`, a button `查看原文`, or `原文来源 {n}` when there are multiple refs. Clicking calls expand and reveals the content inline.
- Synthesized answers:
  - A small line `共享记忆综合` or `私有记忆综合`.
  - The text.
  - Per ref, a button `来源 {n}` with inline expand.
- Forget section (h2 `彻底遗忘`):
  - Text: `按上面输入的主题预览清理范围。相关原文、已记录的同伴副本和综合结果一起清理，受影响的工作会停止。`
  - Button `预览遗忘范围` (disabled when the query is empty).
  - The confirm dialog title is `确认遗忘这些记录？`; the detail is `` `将清理 ${documents.length} 条记忆、${messages.length} 条消息，并停止及清理 ${tasks.length} 项相关工作。受影响的 Agent：${names joined by "、" | "无"}。混合多个来源的回复会整条清理。` ``.
    - Bot names are looked up in the current bots list; a missing bot is shown as `已归档 Agent`.
  - Buttons are `确认` and `取消`.
- Engine footnote under the workbench (`role=status`), made of two parts. The first part is chosen by:
  - `service==="starting"`: `正在启动语义记忆服务。`
  - `status==="connected"`: `Hindsight 语义记忆已连接。`
  - `status==="not_installed"`: `未启用记忆插件，可在主设备设置中连接外部服务；目前使用原始记录检索。`
  - otherwise: `语义记忆暂不可用，目前使用原始记录检索。`
- Then append:
  - ` {pending} 项待同步。` if `pending` > 0.
  - ` 部分记忆正在清理或更新，旧的派生结果已暂停读取。` if `quarantined` > 0.

**API**
- `POST /api/memory/recall` with `{botId, query (≤200)}`.
  - Response is `{status:"available"|"pending"|"unavailable"|"disabled", facts:[{ref, refs[], scope:"bot"|"workspace", text (≤1400), sourceClass}]}`.
  - At most 12 facts. `disabled` means the bot lacks `memory.search`, or is not active.
- `POST /api/memory/reflect` with `{botId, query (≤1000)}`.
  - Response is `{answers:[{scope, text, refs[]}], status:"available"|"no_evidence"}`.
  - Errors:
    - `该 Agent 无权综合记忆`
    - `语义记忆服务尚未就绪`
    - `记忆或权限已变化，请重新检索`
    - `综合结果缺少有效来源`
  - It calls the configured model through the memory plugin and can take up to 120 s.
- `POST /api/memory/expand` with `{botId, ref}`. Response is `{ref, sourceClass, content, contentHash}`. Errors: `来源已撤回或不可见`, `来源已变化`.
- `POST /api/memory/forget-preview` with `{botId, query}`. The selector also accepts `documentId` instead of `query`; the query is ≤200 and matches NFKC lowercase substrings.
  - Response is `{sources[], documents[], messages[], tasks[], banks[], bots[], hashes[], selectorHash, revision}`.
  - Errors: `Agent 不存在`, `记忆不属于当前范围`.
- `POST /api/memory/forget` with `{botId, query, revision}` where `revision` is the preview's `revision` and must still match.
  - Response is `{id, status:"completed"|"cleaning", documents, messages}`.
  - Error: `清理范围已变化，请重新预览`.
  - It cancels the affected tasks and redacts content with `[已遗忘]`. Message and journal text show `[已遗忘]` afterwards.
- The privacy epoch bump forces clients to clear their caches.

## 12. File and tool preview

**Triggers**
- A `` `code` `` span in message text matching `^(?:[\w.-]+[\\/])*[\w.-]+\.(md|txt|json|csv|yaml|yml|ts|tsx|js|jsx|mjs|py|sql|log|html|css|sh|ps1|toml|xml)$` (case-insensitive) is rendered as a chip button with a file icon and tooltip `在右侧面板预览 {path}`. Clicking calls `GET /api/preview?path=<encoded>`.
- A tool step row in the message's tool-activity disclosure has the tooltip `点击在右侧面板查看详情`.
  - If the step's `tool_name==="device.read"` and `summary` is non-empty, it opens the file preview for `summary`.
  - Otherwise it calls `GET /api/preview?callId=<step.id>`.
  - If that fails, it falls back to a local card `{kind:"tool", id, title: label, status, content: step.preview || "暂无输出内容", createdAt}`.
- A preview opens the 资料 tab and the drawer.

**Card UI** (aria `内容预览`)
- File: title is the basename. A subtitle shows `{path}` and, if present, ` · {size} B`.
- Tool: title is `toolLabels[title] ?? title`. A subtitle shows `{statuses[status]}` and, if present, ` · {formatTime(createdAt)}`.
- Buttons: `复制` (becomes `已复制` for 1.8 s) and a close icon (`aria-label="关闭预览"`).
- `<details><summary>调用参数</summary><pre>{arguments}</pre></details>` appears if `arguments` is present. The body is `<pre>{content || "暂无内容"}</pre>`.

**API**
- `GET /api/preview?callId=<id>` returns `{kind:"tool", id, title:<tool_name>, status, arguments:<arguments_json string>, content:<pretty JSON of result minus images, ≤24000 chars>, createdAt}`.
  - Error: `操作记录不存在或已遗忘`. `callId` is ≤100.
- `GET /api/preview?path=<p>` (≤1024) returns `{kind:"file", path, title, exists, size?, updatedAt?, content}`.
  - Lookup order:
    1. A file under `node.config.root` (path-resolved and must stay inside the root). Content is UTF-8, ≤24000 chars.
    2. One of the last 30 successful `device.read` tool calls matching the path or basename (content from `result.content ?? result.text`).
    3. Not found: `{exists:false, content:"未在当前授权共享目录或最近读取记录中找到该文件。可在「设备网络」中配置后端允许读取的目录或让 Agent 调用 device.read 读取。"}`.
- `messages[].tool_steps[]` rows (on assistant `kind:"message"` rows with a `task_id`) are `{id, tool_name, status, summary, preview (≤1600 chars), created_at}`.
  - `summary` is derived server-side per tool in `agents.ts` `projectMessages`.
  - The web UI shows a `ToolActivityDisclosure`: summary `执行记录 · {n} 项操作` (or `正在执行 · {n} 项操作`, which is not used in practice).
  - Each step row has a status dot, the label from `toolLabels` (or the raw tool name), the `summary` in code style, and `statuses[status]`.

## 13. Devices page (`设备网络`)

**Navigation**
- Account-menu item `设备` (with the count of online devices). The page title is `设备网络`.
- The Devices page strings and behavior are in this section; the node (host device) card is described under the host-device bullets below.

**Page strings** (P:137-146)
- Eyebrow `PERSONAL AI OS · DEVICES`, h1 `设备网络`, sub `设备执行节点独立连接后端。客户端只显示和管理后端已注册的设备。`, primary button `生成配对令牌`.
- The pair dialog is titled `添加设备` with field `设备名称` (required).
- After pairing, a card `在设备执行节点完成配对` is shown.
  - Text `后端地址：{state.address}`.
  - Read-only field `设备令牌（仅显示本次）`.
  - Button `已复制，关闭`.
  - Only the `token` is displayed in the web UI, although the response also contains `deviceId`.
- Device list: each section shows the name, with ` · 后端主机` appended when `id===hostDeviceId`.
  - Status text: `已撤销` if `status==="revoked"`, else `在线` if the id is in `onlineDevices`, else `离线`.
  - A red `撤销` button appears if the device is not revoked and is not the host.
- Card A, shown when `node.hosted` is true: `你的设备` / `此工作区只连接你配对的设备。添加设备后，Agent 可以使用该设备授权的能力。`
- Card B, shown otherwise: `后端主机能力`.
  - Sub `这些能力作用于运行后端服务的主机。客户端不运行本地终端或设备执行节点。`
  - Badge `状态：{state.node.status}`.
  - Line `连接状态：{node.status} · 终端{可用|不可用} · 窗口控制{可用|暂不支持}`. Terminal availability uses `node.exec`; window control uses `node.computerSupported`.
  - For each `node.unknownCalls` entry a card:
    - Title `需要核对设备执行结果`.
    - A `<pre>` with `arguments_json`.
    - Text `上次执行中断，这个调用不会重放。请检查后端主机上的进程和操作结果，再确认已停止。`
    - Button `已核实停止`. It opens a confirm titled `确认该调用已停止？` with detail `请先检查设备实际执行结果。确认后不会重试原操作。`.
  - Form: field `后端允许读取的目录（可留空）` (placeholder `填写后端主机上的目录路径`, initially `state.node.root`) and button `保存后端文件目录`.
  - Note: `危险操作会在执行 Agent 的消息中请求批准。`
- Card C (always): `后端连接` with code `{state.address}` and text `监听地址、HTTPS 与端口由后端服务的部署配置管理。`

**API**
- `POST /api/devices` with `{name (required, ≤80)}`.
  - Response is `{deviceId, token}`.
  - Behavior: inserts a device with `platform="windows"` hard-coded, `status='bound'`, and an access token valid for 365 days.
  - The token is a random 32-byte base64url string, shown only once.
  - Errors: the generic `请输入有效内容…`.
- `POST /api/devices/revoke` with `{id}`. Response is `{ok:true}`.
  - Error: `主设备无需撤销配对；可在 Agent 工具权限中限制能力` (when the id is the host device).
  - Behavior: sets `status='revoked'`, revokes credentials and grants, and closes the socket.
- `POST /api/node` with `{root: string}` (the web sends only `root`). The server merges `{...node.config, ...data}`. Other accepted keys:
  - `origin`.
  - `token`.
  - `exec` (default true unless `=== false`).
  - `computer`.
  - Response is `node.publicState()`.
  - Authorization: `options.hostDevice !== false` AND the request comes from loopback AND (identity enabled, or session is the local owner). Otherwise `403 此账号没有配置后端设备能力的权限`.
  - Validation errors:
    - `设备执行中，请等调用结束再更改授权`
    - `Core 地址须为 HTTPS 或私有网络 HTTP`
    - `请选择一个文件夹`
    - `本机 computer use 运行时不可用`
    - `请输入 Core 生成的设备配对令牌`
    - A nonexistent root throws a raw filesystem error (ENOENT).
  - Changing root, token, exec, or computer bumps the node `policyVersion`.
- `POST /api/node/reconcile` with `{callId, version}`. Response is `{ok:true}`. Authorization is the same as above. Errors: `仍有调用在执行中`, `调用状态已变化`.
- Remote (non-loopback) clients get 403 on the two node endpoints. The unknown-call card is thus effectively usable only from a loopback browser.

**Host-device registration at startup** (`index.ts:310-317`)
- The server registers a host device named `os.hostname()` and binds a local node to it.
- That device appears in `state.devices` with `status='bound'` and its id is `hostDeviceId`.
- It is online whenever the node socket is connected.

## 14. Settings page (`设置`)

- Header title is `设置`. The page h1 is `设置` with sub `管理你的账号和助手偏好。`.
- Left nav (aria `设置分类`): `账号与登录设备`, `模型`, `记忆服务`, `系统信息`. The default category is `account`.

### 14a. 账号与登录设备
- Panel heading `账号与登录设备` / `管理个人身份，以及可以访问这个工作区的登录设备。` The session list is already implemented natively.
- Account block: name fallback `NexorAI 用户`, `NexorAI 账号 · 已认证`, button `退出登录` (error `退出未完成，请重试`), facts `工作区: 个人工作空间` and `本次登录有效期` (`expiresAt`, zh-CN `M/D HH:mm`).
- 登录设备: heading `登录设备`, `{n} 个有效登录`, `移除不再使用的登录，即可撤销该设备对工作区的访问。`, `正在加载登录设备…`, `登录设备暂时无法加载，请稍后重新打开设置。`, `暂无其他有效登录。`, the pill `当前设备`, `到期时间：{M/D HH:mm}`, button `撤销登录`.
  - `GET /api/clients` returns `{sessions, currentSessionId}`; rows are filtered client-side by `!revoked_at && expires_at > now`.
  - Revoke is `POST /api/clients/revoke {sessionId}` and errors `客户端会话不存在`.
  - This section is already implemented natively.

### 14b. 模型
- Heading `模型` / `选择助手使用的模型，并连接你的服务商。` Section `模型连接`, status chip `已配置` (config present) or `待配置`.
- Fields:
  - `API 协议` select: `openai` = `OpenAI 兼容`, `anthropic` = `Anthropic`. Initial value is `config.provider_id` or `openai`.
  - `模型 ID` (`model`, required, placeholder `服务商提供的模型 ID`, initial `config.default_model`).
  - `API 基础地址` (`endpoint`, type url, required, initial `config.endpoint` or `https://api.openai.com/v1`).
    - Hint openai: `通常以 /v1 结尾，不包含 /chat/completions。`
    - Hint anthropic: `填写服务根地址，不包含 /v1/messages。`
  - `API Key` (`apiKey`, password, required only when `!state.config`). Placeholder is `输入 API Key` or, if configured, `留空保留已保存的 Key`. Small text: `密钥由后端加密保存。`
- Switching the protocol swaps the endpoint to the matching default only when the current endpoint equals one of the two defaults: `https://api.openai.com/v1` or `https://api.anthropic.com`.
- Advanced disclosure `高级设置`: `实际请求地址` shows the computed URL, or the fallback text `请输入有效的 API 基础地址`.
  - The computed URL is `origin + pathname minus trailing slash` followed by `/chat/completions` (openai) or `/v1/messages` (anthropic).
  - It is shown only if the URL has no username, password, query or hash.
  - It is followed by `使用 Chat Completions 协议。` or `使用 Anthropic Messages 协议。`.
- Button `保存配置` (`保存中…`), then a green `已保存` check on success. The API Key field is cleared after saving. Editing any field hides the `已保存` marker.

**API**
- `POST /api/config` with `{provider: "openai"|"anthropic" (≤30), model (≤200), endpoint (≤2048), apiKey? (≤8192)}`. Response is `{ok:true}`.
- Blocked while any worker runs: `请先等待模型请求结束再修改模型`. This check is `runtime.workers.size`, i.e. any running agent task.
- The extra form field names are exactly `provider`, `model`, `endpoint` and `apiKey`.
- Errors:
  - `API 地址须为 HTTPS；本地模型可使用 HTTP localhost` (http is allowed for hostnames 127.0.0.1/localhost/[::1] only; credentials, query and hash are rejected).
  - `不支持的协议`.
  - `请配置 API Key` (no key supplied and none stored).
  - An unparseable endpoint throws the raw `Invalid URL`.
- Behavior: the trailing slash of the endpoint is stripped; a blank `apiKey` keeps the stored one.
- Until a config exists, `state.config` is undefined. The web then disables the send button and shows a banner (section 15). The Settings page is exempt from that banner.
- `/api/agents/input` without a config fails with `请先在设置中配置 API Key 和模型`.

### 14c. 记忆服务
- Heading `记忆服务` / `让助手在后续对话中找回与你有关的信息。` If `state.memoryPlugin` is missing: `当前后端未提供记忆服务配置。`
- Section `Hindsight` with a status chip: `未启用` (disabled), `连接中` (connecting), `已连接` (ready), `连接异常` (unavailable), or `状态未知`.
- Warning when `unavailable`: `暂时无法连接记忆服务。聊天仍可使用，请检查服务地址或查看诊断详情。`
- Controls:
  - Switch `启用长期记忆` with sub `将记忆来源同步到配置的服务，供后续检索使用。`
  - `服务地址` (type url, placeholder `https://memory.example.com`, required when enabled). Hint: `填写后端能够访问的 Hindsight 服务地址。`
  - `访问令牌` (password, placeholder `地址不变时，留空保留已有令牌` if `hasToken`, else `输入服务访问令牌`).
    - It is required when enabled unless `hasToken` and the endpoint, with a trailing `/` removed, equals `plugin.endpoint`.
  - Text: `模型调用与费用由该服务管理。停用不会删除外部数据。`
  - Disclosure `诊断详情`: `服务协议` (the provider `protocol`, e.g. "HTTP API v1 · 0.10.3"), `连接状态`, and `错误详情` (`plugin.error`, shown if present), plus `模型与认证在外部 Hindsight 服务配置；修改本页配置后需重启后端服务。`
  - Buttons: `保存插件配置` (`处理中…`) and `测试连接` (disabled when the endpoint is empty).
- Feedback line (`role=status`):
  - After save: `配置已加密保存，重启后端服务后生效。`
  - After test: `连接测试通过，尚未更改配置。`
  - Otherwise, if `plugin.restartRequired`: `配置已变更，重启后端服务后生效。`
- Feedback clears on any input change.

**API**
- `POST /api/plugins/memory` (save) and `POST /api/plugins/memory/test`.
  - Body: `{provider:"hindsight", enabled: boolean (required boolean), endpoint?: string (≤2000), token?: string (≤8192)}`.
  - Save response is the `MemoryPluginState` (same shape as `state.memoryPlugin`). Test response is `{ok:true, provider}`.
  - Test forces `enabled:true` internally.
- Authorization: `session.user_id` must equal the workspace owner, otherwise `403 此账号没有配置记忆插件的权限`. A post-save recheck can throw `401 登录已失效，请重新登录`.
- Validation errors:
  - `插件启用状态无效`
  - `不支持的记忆插件`
  - `记忆服务须为 HTTPS 或本机/私有网络 HTTP 根地址，不能包含凭据或路径` (the endpoint must be a root URL, no path)
  - `请填写记忆服务地址和访问令牌` (enabled but missing endpoint or token)
  - `正在保存记忆插件配置`
  - `Core 正在关闭`
- Test error: `记忆插件连接失败，请检查地址、令牌和 Hindsight API 版本`.
- Save-time migration error (only when enabling): `原记忆索引尚未迁移到此服务。请先迁移 Hindsight 数据库，或继续连接原服务；本地记录不会删除。`
- Token reuse: an empty token reuses the stored token only if the provider and the normalized endpoint (URL origin) are unchanged.
- `restartRequired` is true when the saved settings differ from the settings active since Core start. The new config applies only after the Core restarts, so the native app must show the restart-required notice.
- The service state is retried every 30 s on failure (`记忆服务无法连接，或原索引尚未迁移`).

### 14d. 系统信息
- Heading `系统信息` / `查看当前连接和数据存储方式。`
- Section `服务连接`:
  - `当前访问地址`: `location.origin`.
  - `客户端类型`: `桌面客户端` if `desktop.mode==="client"`, else `浏览器`.
- Section `数据与隐私`: `聊天、任务与配置保存在后端。桌面客户端只保存加密的登录资料；启用记忆服务后，记忆来源会同步到该服务。`
- Disclosure `技术详情`:
  - `后端监听地址`: `state.address`.
  - `后端数据目录`: `state.dataDir`.
  - `运行环境`: the hard-coded string `Pi 1.0.4 · SQLite`.

## 15. Chat extras (beyond what native already has)

**Header** (AD:214-233)
- Contact heading with a 40 px avatar, the name, a model pill (`state.config.default_model` or `未连接模型`), and a subtitle.
  - The subtitle is `taskPhrase(tasks[0])` plus ` · {n} 项工作正在进行` when more than one task is active, otherwise `companionLabels[avatarState]`.
- Mobile-only button `aria-label="展开联系人列表"`.
- Memory pill `已更新记忆：{title}` (section 10).
- Share button (`title="复制对话记录"`, share icon, shown when messages exist):
  - Copies to the clipboard a string built from all loaded messages as `[{formatTime(created_at)}] {sender}: {content}` joined by a blank line.
  - Sender is `我` (user), `系统` (system), the peer name or `同伴 Agent` (peer), or the bot name or `Agent`.
  - The icon becomes a check for 1.8 s.
  - `formatTime` is zh-CN `M/D HH:mm`.
- Info button (`aria-label="Agent 资料"`) toggles the inspector.
- The page title for non-agent pages is `设备网络`, `设置`, `连接器`, or `你的 Agent`.

**Banners**
- Error banner: `role=alert` with close `aria-label="关闭错误"`.
- No model: `连接模型后，Agent 就能开始工作。` + button `配置 API Key`. Shown when `!state.config` and the page is not settings.
- Offline: `Core 连接中断，正在重新同步…`; the account footer shows `正在重新连接…`.
- Session expired: `此设备的登录已过期或被撤销，请重新连接。`.
- Boot screen: `正在连接你的 Agent…`.

**Welcome (empty history)**
- While loading: `正在载入历史会话…`.
- When the bot has no messages:
  - Large avatar.
  - Badge `长期陪伴，随时开始`.
  - The bot name.
  - Paragraph is `instructions`, or the fallback `我是你的专属智能同伴。你可以直接向我提问、安排定时任务，或输入 @ 让我与团队其他成员协作。`
  - Small text `直接发消息，或为我安排一项例行任务。`
  - Chips:
    - `安排例行任务`.
    - `添加长期记忆`.
    - `让 {firstPeer.name} 协作`, which prefills the draft with `@{name} `.

**Transcript**
- Button `加载更早的消息` is shown if `messages[0].seq > 1`. It calls `agents/messages?bot=&before=<first seq>`.
  - The first page is the latest 100; `after=` pages are 200 with `hasMore`.
  - Data fetched is as already implemented natively.
- Day dividers: `今天`, `昨天`, otherwise a long date (`M月D日`).
- A floating `回到底部` pill is shown when scrolled away from the bottom and there are more than 3 messages (nearBottom threshold 90 px).
- A streaming reply is rendered from the `streaming:[{taskId,text}]` array returned by `GET /api/agents/messages`.
  - It shows `正在回复…`.
  - For an agent-to-agent child task it uses the folded reply form with `正在回复给{peer}`.
  - Otherwise there is a three-dot indicator `正在处理消息` (`aria-label` is `{name} 正在处理消息`), and a caption of `taskPhrase(tasks[0])`.

**Messages** (AgentMessage, AD:430-445)
- Markdown with GFM is rendered via `react-markdown` + `remark-gfm`.
  - Images are replaced by their alt text or `图片`.
  - `http(s)` links are intercepted and opened externally (default prevented).
  - Inline `code` matching the file-path pattern becomes a chip (section 12).
- Under each message: the short time and action links for roles user, assistant, peer.
  - `引用` (reply icon, tooltip `引用回复`): puts the message into the composer quote bar.
  - `复制` (tooltip `复制内容`): copies the content; it shows `已复制` for 1.8 s.
- Quote bar: `引用 {author}` + text; cancel `aria-label="取消引用"`. On send it prepends `> {author}：{text with whitespace collapsed, first 140 chars}\n\n` to the message text.
- Peer-role messages show the author line `{peer.name} · 发来任务` (`kind==="request"`) or `{peer.name} · 返回结果`, with a 22 px avatar. The peer is resolved from `a2a_peer_id ?? sender_bot_id`.
- **A2A projections** (`a2a_direction` on the message row, `a2a_peer_id`):
  - `sent` and `returned`: a marker line `已发消息给` + a clickable peer chip.
  - `received`: a marker line `消息来自` + a peer chip. Clicking selects that peer's conversation. The time has the full timestamp as tooltip.
  - `replied` with `role==="assistant"`: an assistant card with the bot name and a folded block `已回复给{peer}` · `展开`/`收起`.
  - A `replied` row with `role==="system"` renders as a normal message.
  - Message `kind` values seen: message, error, activity, request, result.
- Tool steps disclosure (section 12) is present on assistant messages that have `tool_steps`.

**Approvals** (AD:288, outstanding approvals for the selected bot)
- Card title `{bot.name} 需要你的批准`.
- Subtext is the action label (section 6 approval-label table).
- `<details><summary>查看具体操作</summary>` with pretty JSON of `arguments_json`. For `memory.forget` it adds the key `清理范围` with `authorization_snapshot_json.forgetCounts`.
- Buttons `批准` and `拒绝`. They call `POST /api/approvals {id, hash: argument_hash, allow: bool}`. Response is `{ok:true}`.
- Errors: `审批已失效`, `设备授权已变化，请发送新的要求重新审批`, `任务、权限或审批已变化`.
- For tasks reachable from this bot's active tasks through up to 3 levels of `delegations`, a status line `{peer or "同伴"} 等待你的批准` + button `前往处理` (selects that peer).

**Task status bar**
- When tasks exist: `Agent 正在工作 · {taskPhrase(tasks[0])}` or `正在停止…` (when any task is `cancelling`).
- Button `停止任务` (`aria-label="停止任务"`, disabled when busy, offline, or all tasks are already cancelling). It POSTs `/api/cancel {taskId}` once per active task.

**Composer**
- Textarea `aria-label="发送给 Agent 的消息"`, placeholder `给 {bot.name} 发消息…`. Its height grows up to 160 px and rows up to 5.
  - Enter sends. Shift+Enter inserts a newline. Enter is ignored while IME composing (`isComposing`).
- Send button `aria-label="发送消息"`, disabled when busy, the draft is blank, `!state.config`, or no bot.
- `+` button (`aria-label="打开快捷操作"`) opens the `快捷操作` menu (the dismiss overlay has `aria-label="关闭快捷操作"`), with three items:
  - `提及同伴` (appends ` @` to the draft).
  - `安排例行任务` (opens the routine editor).
  - `管理连接器` (goes to the connectors page).
- @-mention popup (`aria-label="提及同伴 Agent"`), triggered by the regex `/(?:^|\s)@([^\s@]*)$/` at the end of the draft.
  - The candidates are the other bots whose name contains the typed text, case-insensitive.
  - Each row shows `@{name}` and the `instructions` text, or `同伴 Agent` as fallback.
  - Keys: ArrowDown/ArrowUp move; Tab inserts `@name ` (replacing the typed fragment); Escape dismisses. Mouse selection is also supported.
  - The mention is plain text; the request carries no structured mention data.
- Send flow (`send()`):
  - It builds `content = quotePrefix + trimmed draft`.
  - `POST /api/agents/input {botId, text, clientId}`, returning HTTP 202 `{taskId}`.
  - `clientId` is a `crypto.randomUUID()` reused for retries of identical content for the same bot (idempotent).
  - The server's `text` limit is 32000.
  - Errors: `同一消息 ID 的内容不同`, `请先在设置中配置 API Key 和模型`, `该任务须先处理不确定结果或取消`.
  - The sending state shows a "thinking" avatar until the task appears in state.
- Read receipt (`agents/read`) behavior is already implemented natively.

**Sidebar account footer**
- Name button `aria-label="{userName}，账号菜单"` with `aria-haspopup="menu"`. Text: name (`accountStatus.account.displayName` or `个人账号`) and sub `个人工作空间` (or `正在重新连接…` when offline). It has an online/offline dot.
- Menu (`aria-label="账号菜单"`, role menu):

| Item | Behavior |
|---|---|
| `连接器` | Goes to the connectors page; trailing count of enabled connectors (blank when 0). |
| `设备` | Goes to the devices page; trailing count `onlineDevices.length`. |
| `设置` | Goes to the settings page. |
| `切换深色模式` / `切换浅色模式` | Local theme toggle (`nexbot.dark`). |
| separator | |
| `退出当前账号` | `window.confirm("退出当前账号？此设备的登录将被撤销。")`, then `POST /api/auth/logout {}`. On failure the banner shows `退出登录未完成，请重试`. |

- Mobile sidebar: scrim `aria-label="关闭联系人列表"`, collapse button `aria-label="收起联系人列表"`. The brand row shows `NexBot` and the mark.

**Keyboard shortcuts**
- There are no global shortcuts and no search shortcut.
- Composer: Enter, Shift+Enter, and the @-popup keys above.
- Dialogs: Escape closes the generic dialog (AD:414) and the connector modal. The avatar picker traps Tab and swallows Escape while saving.
- Account menu:
  - ArrowDown/ArrowUp on the account button opens the menu.
  - Within the menu ArrowDown/ArrowUp/Home/End move focus.
  - Escape closes it and refocuses the account button.
  - Blur and pointer-down outside also close it.

## 16. Native-side gap notes

These are not in the web UI, or are server behaviors worth knowing.

- No web UI exists for the following:
  - Editing agent `expertise` (the API accepts it).
  - `memory/publish`.
  - Conversation creation.
  - Client-session invites (410 when identity is enabled).
  - Memory-scoped `forget` with `documentId`.
- The web's inspector `工作` tab lists devices and connectors read-only; per-device grants are not exposed in the web UI.
- Node and host-device configuration requires loopback; a remote native app will receive 403 on `POST /api/node` and `POST /api/node/reconcile`.
- `/api/state` carries both `directory` (unused in the web) and the full `connectors` list, so no separate connectors GET exists.
- Version fields that every mutation must echo:

| Resource | Version source | Endpoint(s) |
|---|---|---|
| Bot | `bots[].version` | `bots/update`, `bots/archive` |
| Bot policy | `bots[].policy_version` | `bots/policy` |
| Bot appearance | `bots[].appearance_version` | `bots/appearance` |
| Routine | `routines[].version` | `routines`, `routines/toggle` |
| Connector | `connectors[].version` | save, test, grant, toggle, delete |
| Memory | `memories[].version` (as `expectedVersion` on save) | `memory`, `memory/delete` |
| Unknown node call | `node.unknownCalls[].version` | `node/reconcile` |
| Approval | `approvals[].argument_hash` | `approvals` |

- The `routines/run` and `agents/input` calls carry client-generated idempotency ids (`clientId`).
- Time formatting: zh-CN locale. `formatShortTime` and the contact-list time are `HH:mm` if today, else `M/D`. `formatTime` is `M/D HH:mm`.
- The login screen is not described here. Note only that its help button opens `https://user.nexorai.com.cn/login`, and the login-screen strings are in `auth.tsx` lines 61-72.
