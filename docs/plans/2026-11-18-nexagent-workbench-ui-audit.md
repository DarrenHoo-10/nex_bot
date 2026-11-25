# NexAgent 工作台上线后排查 — 2026-11-18

对象：生产 release `main-f43ca09d-20261116`（分支 `codex/nexagent-project-ui-review`）。依据：用户 5 张截图；生产 `core.db` 只读查询（`sqlite3 -readonly`，未写入）；本机 Claude 转录文件；隔离夹具 `node scripts/smoke-cli-agents.mjs --workbench --serve=18829` 以**正式入口**（非 `workspace=nexagent-review`）用无头 Chrome 复现。夹具已停止，临时目录已删除。

## 结论

上线的是“评审夹具里好看、正式数据下退化”的版本：大部分定稿交互用 `review &&` 包着，正式入口拿不到；树、Git 卡、归档都依赖惰性创建的工作台行或尚未升级的设备执行器。另有两个与数据无关的硬 bug（树行居中、设备端 git 找不到可执行文件）。

## 问题与根因

| # | 现象 | 根因（已证实） | 证据 |
| --- | --- | --- | --- |
| 1 | 很多莫名其妙的目录 | 按会话原始 `cwd` 分组。生产 92 个会话分布在约 45 个 cwd：`.claude\worktrees\<随机名>` 每个成一个目录；`\\?\D:\…` 与 `D:\…` 不归一，`nex_stock`、`TokenDance` 各出现两次；Codex 无项目对话落在 `Documents\Codex\<日期>\new-chat` 等，出现多个 `new-chat`；`.persona\assistant` 内部会话也进树 | `SessionList.tsx` `checkout(s).project = s.cwd`；生产 `GROUP BY cwd` |
| 2 | 应已归档的会话还在 | ① 正式入口没有「已归档」入口（`{review ? … 已归档 : null}`）；② 归档/删除/改名只在已有工作台行时执行，生产只有 9 行（92 个会话），其余**静默无操作**并关闭对话框；③ 83/92 是 `stopped` 历史（14 天内最多 300 条），无折叠；④ 旧的「隐藏」与新的「归档」并存 | `SessionList.submit/saveName` 的 `if(own && own.id …)`；`CliAgentsWorkspace.runWorkbenchAction` 无 id 时 `return {}` |
| 3 | 缩进莫名其妙 | 全局 `button{display:inline-flex;justify-content:center}`（personal.css）命中 `.cli-row-main`；`workbench.css` 只覆盖了 `display:flex`。标题越短越往右，与层级无关（生产 `parent_id` 全空）。定稿截图本身也有此偏移 | 夹具实测 `justify-content: center`，同层图标 x 从 52 到 90 |
| 4 | “侧聊”出现在目录 | 正式入口根本建不了侧聊（`use-side-chats.open` 无 review 直接 return）。树里成对同名的是 **Claude 桌面端的分叉/续接会话**：例如 zen-kilby 的 `4f936f2e` 与 `4ecdd375` 共享 987/991 条消息 uuid，被当成两个独立根会话 | 本机转录 uuid 交集；`A股放量回踩波段策略`、`助手问题排查`、`New session greeting` 等成对出现 |
| 5 | 输入框与设计稿不符 | 「＋」(文件/目标)、`/` 技能、模型与推理强度、上下文圈、完整占位文案全部 `review &&`。运行中出现整行原生 `<select>`（排队/引导），停止按钮是 `Square` 线框图标＋“停止”，看起来就是复选框 | `Composer.tsx` 221、248–256 行；夹具截图与用户截图 3 一致 |
| 6 | 发消息不可用 | 链路其实通了：22:47:58 continue→send，设备 4 秒内确认，`hi` 写入转录；之后 25 秒没有任何回复也没有进度展示，22:48:31 发生停止（很可能误点了“像复选框的停止”），队列被暂停，**队列为空也常驻**「队列已暂停（已停止）继续队列」横幅。转录区运行中无“正在处理”行，只有标题旁小芯片 | 生产 `cli_agent_ops` / `audit_records` / `cli_agent_items`；`Composer.tsx` 199 行无条件渲染横幅 |
| 7 | 工作区卡片信息不全 | 生产设备执行器未升级（部署记录 Limits），旧设备不认 `git` op，回 `invalid` → Core 返回 400 →「Git 状态读取失败」；工作树只取自 git 结果 →「未上报」。（更正：初稿称 `device-git` 缺 `PATH` 必然失败，复核为误判——Windows 上 Node 用父进程 PATH 解析 `git`；夹具里的 `source:"none"` 是夹具设备 PATH 刻意不含 git 所致。残留小问题：git 不存在时被吞成“没有 Git 信息”而非“找不到 git”。） | 旧 bridge `perform()` 的 `default: throw OpFailure("invalid")`；夹具 `deviceEnv.PATH` |

## 其他与定稿不符（排查中发现）

- **Fork 不继承上下文**：`branchSession` 后 `startSession` 在同目录开一个空白新会话，只是挂了父关系和“（fork）”名。定稿要求真实分叉。
- **默认中文**：正式入口显示英文原文＋「翻译成中文」，定稿是中文优先、可看原文。
- **注释**仍在 sessionStorage，**侧聊**正式入口不可用（见 #4）。
- **夹具清理**：同一 herdr-core 路径下残留多个旧夹具的 `herdr-core serve` 进程（本次只清理了本次运行的进程树）。

## 优化方案

### 第一批：纯前端/小改，可一起发 Core（只影响 Web 与 Windows“从 Core 加载”）

1. **树行对齐**：`.na-stage .cli-app .cli-row .cli-row-main{flex:1;justify-content:flex-start}`，同时检查 `.na-folder`、设备行等所有 `button` 容器。加一条 DOM 断言：同层行图标 x 相同。
2. **工作台行不再惰性**：Core 在会话入库/快照时为每个会话 `ensureSession`（或 rename/archive/delete 路由接受 `key` 并就地建行）。前端无 id 时报错而不是静默关闭。
3. **归档统一**：正式入口显示「已归档」列表；把旧 `hidden` 并入 archived（一次性迁移或读取时映射），菜单去掉“隐藏”。
4. **输入框按定稿**：解除 `review` 门控——「＋」文件/目标模式与占位文案直接启用；模型、推理强度、技能、上下文按设备上报能力显示，未上报时如实显示“未提供”而非整块消失。运行中改为输入框内的「排队 | 引导」分段切换；停止用独立的实心方块圆钮（与发送钮同尺寸）；暂停横幅仅在有待发条目时显示，否则用一行轻提示。
5. **运行反馈**：发送后在转录尾部显示“已送达 · 正在处理”占位行（直到首个助手 item 或轮次结束），续接旧会话时提示“正在恢复会话”；长时间无输出给出“打开远程终端查看”入口。
6. **Git 卡降级**：设备不支持 `git` op 时显示“电脑端版本过旧，升级后可查看更改”；分支用 `session.gitBranch`，工作树从 cwd 推断（`.claude\worktrees\<名>` → 名称，否则“主工作树”），不再出现“未上报”。

### 第二批：设备执行器（需要发 Windows 客户端，按 AGENTS 发布链路走）

7. **`device-git` 区分“找不到 git”**：spawn 失败（ENOENT）返回 `failed`，而不是 `none`。
8. **项目归属由设备上报**：每个会话附带 `repoRoot`（`git rev-parse --path-format=absolute --git-common-dir` 的上级）与 worktree 名；Core/前端按 `deviceId + 规范化 repoRoot` 分组，非 Git 目录按规范化路径（去 `\\?\`、Windows 不区分大小写、统一分隔符）。Codex 的 `Documents\Codex\<日期>\*` 归入一个“未关联项目”组；`.persona\assistant` 等内部会话不上报。
9. **分叉/续接去重**：Claude 转录按首批消息 uuid 判断前缀关系——历史是另一会话前缀的那条作为父，新会话挂为子（或标记 superseded 折叠）。Codex 同理核对 fork 来源字段。这样“侧聊/分叉”不再以根会话混在目录里。
10. **历史范围**：默认展示运行中＋近 7 天，其余折叠到“更早”；尊重原生归档（Codex 已过滤 app db 的 archived；Claude 桌面端的归档状态需查其存储后接入）。
11. **真实 Fork**：Claude 用 `--resume <id> --fork-session`，Codex 走 app-server fork；未支持的 Harness 禁用菜单项而不是开空白会话。

### 第三批：定稿剩余

12. 侧聊正式实现（`kind=side` 行 + 首发创建，不进左树）；注释持久化；中文优先展示。
13. P0 原生通道矩阵与 P8 双端验收仍未做，ZCode 写通道依赖它。

## 验证建议

每批用隔离夹具的**正式入口**验收（不要只看 `/review`），并补：同层图标对齐断言、无工作台行时归档/改名生效、运行中停止钮与分段控件可见、真实 git 仓库的 Git 卡、同名分叉会话嵌套。生产部署后再只读核对 `cli_agent_workbench` 行数≈会话数。
