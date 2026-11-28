# 并行工具回放、只读飞书调用与群报错通道通知修复 · Core 与 Web UI 部署（2026-11-28）

发布提交 `0960d314b7a0b6ac2051f0e4a83c18f6dd6ec357`（生产目录 `~/nexbot/releases/main-0960d314-20261128`，切换自 `main-18da1e4a-20261128`）。

## 变更摘要

1. **并行工具回放与 Worker 退出状态机（`server/personal-os/runtime.ts`、`index.ts`）**：
   - 重放命中仍在 `executing` 的 `agent.delegate` 时直接重入 `delegate()`；命中在途 `device_calls` 时挂回等待并由 `deliverSettledCall()` 投递结果；命中已中断的可恢复只读工具（`web.fetch`、`feishu_read` 等）自动重置为 `ready` 重跑，不再误落入 `"工具未获批准"`。
   - Worker 退出（`child.once("close")`）时回收该次 run 遗留的 `executing` 工具，防止同批兄弟只读调用永久卡死；并行批次存在活跃兄弟工具时不再被单个 `agent.delegate` 的 60s `wait` 定时器提前强杀。
2. **飞书只读调用、孤儿连接器与群报错「通道通知」（`server/personal-os/feishu/api.ts`、`feishu/module.ts`、`connectors.ts`）**：
   - 仅在真正发出 HTTP 请求且非 `GET` 的写操作上置 `dispatched = true`；只读 `feishu_read`（`GET`）报错不再标为 `unknown` 或锁死会话；修正 `callAs` 刷新失败时 `clearUserToken(String(row.id))` 的列名笔误。
   - 过滤并拦截缺少 `personal_feishu_apps` 记录的孤儿 `kind='feishu'` 连接器，并在 `connector.list` 目录中为飞书连接器附加绑定助手名。
   - 飞书群话题出现 `role='system'` 错误时不再新建独立「通道通知」话题污染主对话，仍拦截公开群外泄并仅在主人已启用 `p2p` 私聊目的地时投递私聊卡片。
3. **设备回包对账守卫与话题副标题对比度（`server/personal-os/devices.ts`、`src/personal/finance-topics.css`）**：
   - 设备结果回传仅在同任务下已无其他 `status='unknown'` 调用时才将 `needs_reconciliation` 改回 `queued`。
   - 修正浅色主题下 `.topic-context small` 继承 `var(--muted)` 导致近白发虚的问题，显式使用 `var(--muted-foreground)`。

## 验收与证据

- **静态检查**：合入 `main` 后 `pnpm lint`（0 warnings / 0 errors）、`pnpm typecheck`、`pnpm i18n:check`、`git diff --check` 全部通过。
- **隔离候选验收（Mac Air）**：
  - 覆盖包 `core-0960d314.tgz`（41,484,287 字节，SHA-256 `f33ea05c8d8b64f656c8063d24c12d97215b049cccc12879f1a3316784b1ca2d`）双端校验一致。
  - 在临时目录运行打包后的候选 Core，验证 `/health`（200）、`/api/state` 与 `/api/cli-agents`（未鉴权 401）、消息分页、WebSocket 鉴权/Origin 拦截、DCP 未授权拒绝、孤儿飞书连接器过滤，以及打包 CSS 包含 `.topic-context small` 对比度修复。
  - 使用 `sqlite3 -readonly .backup` 对 `data/core.db` 及全部 5 个 `data/account-workspaces/*/core.db` 共 6 份数据库做只读复演：`integrity_check=ok`、`foreign_key_check=0`、`schema_migrations=61` 与候选版本一致。
- **生产切换与公网校验**：
  - 无在途任务状态下通过脱离进程 `deploy-core.py` 完成备份（`~/nexbot/backups/main-0960d314-20261128-pre`）、切换 `run-core.py` 并重启 `gui/<uid>/cn.nexorai.nexbot-core`（退出码 `0`）。
  - 6 个工作区核心业务表切换前后 SHA-256 哈希完全一致；本机与公网 `https://bot.nexorai.com.cn` 全部 16 项资源校验通过；从本地复核 `/health` 为 200、`/api/state` 与 `/api/cli-agents` 为 401，首页（SHA-256 前缀 `3a46d6a58ce4`）及全部 3 项引用静态资源（`nexbot-mark-Bf5J3Mcw.svg`、`personal-DD1gl8EC.js`、`personal-sOUcxClC.css`）与本地构建逐字节一致。
- **CI 与验证限制**：
  - [发布提交 CI](https://github.com/DarrenHoo-10/nex_bot/actions/runs/46137732474)：`typecheck + lint` 已通过；`core tests` 在记录写入时仍在运行；`Kotlin tests + Android fixtures` 因 Maven Central 下载 `org.robolectric:nativeruntime-dist-compat:1.0.18` 网络错误失败（与本次无 Android 改动无关）。
  - 本次仅部署 Core 与 Web UI（Web 与 Windows 桌面端自动加载），未重发四端客户端安装包；线上既有孤儿连接器记录 `72f6af97-7f95-47ff-a89f-3700df21f15f` 与历史 4 条「通道通知」话题未直接改库清理（新逻辑已将其从工具目录过滤并阻断后续生成）。
