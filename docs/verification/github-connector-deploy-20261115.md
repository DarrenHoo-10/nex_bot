# GitHub 连接器部署 — 2026-11-15

Production Core/UI release `main-3a1fedf0-20261115`, commit
[`3a1fedf0`](https://github.com/DarrenHoo-10/nex_bot/commit/3a1fedf004444765f2c344bf951a3780370025cd)
（feature/github-connector 快进合并到 `main` 后推送；推送前已把当时新进的
html-preview-width 提交并入功能分支并在合并树上重跑 typecheck 与 40 个连接器测试）。

设计与两期验证：[github-connector-phase1.md](github-connector-phase1.md)、
[github-connector-phase2.md](github-connector-phase2.md)。

## 部署证据（Mac Core，bot.nexorai.com.cn）

- Staged `/Users/darrenhoo/nexbot/releases/main-3a1fedf0-20261115`：复制当前运行的
  `main-1604d56d-20261115`，**替换**（非叠压）`core/`、`ui/`、`package.json`、`SOURCE_COMMIT`；
  `node_modules` 沿用上一版本（本次提交零依赖变更，package.json/pnpm-lock 与上一提交无 diff）。
  `core/`+`ui/`+`package.json`+`SOURCE_COMMIT` 共 59 个文件的 SHA-256 清单与本地构建逐字节一致
  （首次 diff 只是 Windows shasum 分隔符格式差异，规范化后 MANIFEST-MATCH）。
- 丢弃 Core（staged 版本 + 全新数据目录，端口 18999）：`/health` 200、`/personal.html` 200、
  schema_migrations 到 54、webhook 探针对未知监视 id 正确返回 404。第一次启动用错端口
  （runtime-env 的 8799 与生产冲突 EADDRINUSE）属测试脚本问题，改端口后干净通过。
- 活跃任务检查：生产 running-tasks 0、pending-approvals 0。
- 备份 `/Users/darrenhoo/nexbot/backups/main-3a1fedf0-20261115-pre/`：core.db/runtime.db
  （sqlite3 backup API）、vault-key.bin、core.env、core.plist、runtime-env.json、旧 run-core.py。
- 基线计数（切换前后一致）：users 1 / bots 8 / conversations 54 / agent_messages 247 /
  personal_connectors 3 / todos 3。切换后 schema max **54**（迁移 53 重建 personal_connectors、
  54 建监视表，均在重启时应用），`personal_connector_monitors` 表已存在，连接器行无变化。
- `run-core.py` 指向新版本后 `launchctl kickstart -k` 重启 `cn.nexorai.nexbot-core`；
  进程运行 `releases/main-3a1fedf0-20261115/core/service.js`；三个 NEX_GOOGLE_* 变量仍在。
- 公网验证（https://bot.nexorai.com.cn）：`/health` 200；未鉴权 `POST /api/agents/input` 401；
  `POST /hooks/github/probe`（未知监视）→ 404 `{"accepted":false,"reason":"unknown monitor"}`
  ——webhook 入口经公网反代可达且按设计拒绝；`/personal.html` 与本地构建逐字节一致；
  引用资源 `personal-CfBWmr4t.css`、`personal-BGT7MaLQ.js` 哈希一致（JS 首次取回空属瞬时
  网络抖动，重取 899912 字节后哈希一致）。

## Limits

- 全部连接器/监视测试走隔离 fake-github fixture；**真实 GitHub 的连接（设备码/PAT）与
  webhook 投递需在界面上人工完成**——创建监视后按 UI 提示把 URL/密钥配到仓库 Webhooks。
- webhook 路由只在主应用可达；账号工作区模式未做按工作区分发（设计文档边界已记）。
- 未重发任何客户端安装包：Web UI 由 Core 直接提供；Windows/Android 打包与 Apple 发布留待
  下次客户端发版（Apple 侧代码已在 mac-air 上验证 swift test 254/254 与双端构建）。

## 追加部署：连接流程体验修复（main-ae2b329f-20261115）

用户实测反馈两点：设备码流点击连接后只展示代码、预开标签页又自动关闭（观感是"回到
NexBot 页面"），且图标不是 GitHub 官方样式。修复并二次部署
[`ae2b329f`](https://github.com/DarrenHoo-10/nex_bot/commit/ae2b329f5b8b96fa157c6774f82aeac041c1ecb3)：

- 设备码流点击连接即把预开标签页导航到 github.com/login/device；授权完成后轮询把该
  标签页导航回 NexBot 并聚焦（桌面客户端走系统浏览器，无跳回）。保留代码展示、复制
  按钮与"重新打开设备页"兜底（弹窗被拦截时）。
- 图标换官方 GitHub 标记：web 为 primer octicons mark-github-16（MIT，以 data-URI 内联
  进构建产物），Apple 为官方 GitHub-Mark.png 加入 `Shared/Assets.xcassets/GitHub.imageset`。

部署流程同上：staging 替换 core/ui、manifest 与本地构建一致（UI 变更，core 代码不变）、
备份 `backups/main-ae2b329f-20261115-pre/`、切换重启后 schema 54、基线计数不变
（personal_connectors 3→4 为用户当日连接 GitHub 所致）、公网 `/health` 200、
新 `personal.html` 与 `personal-D1JJgoIe.js` 哈希一致、图标以内联 SVG 随构建下发、
webhook 探针 404 正常。Apple 侧 swift test 未受 UI/资源改动影响，双端构建通过。
