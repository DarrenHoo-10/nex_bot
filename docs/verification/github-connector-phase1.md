# GitHub 连接器第 1 期（连接与工具）验证记录

日期：2026-11-15。分支 `feature/github-connector`（基于 origin/main e07562b5）。设计见 [docs/design/github-connector.md](../design/github-connector.md)。

## 交付内容

- **认证三轨**：OAuth App（`NEX_GITHUB_CLIENT_ID/SECRET`，回调 `/api/connectors/oauth/github/callback`）、设备码流（GitHub CLI 公开 client id，零服务端配置）、PAT 手填（连接器表单令牌字段，`test` 时发现账号）。
- **工具 15 个**：读 11（me/repos/pr.list/pr/pr.checks/issues.list/issue/notifications/actions.runs/actions.log/search）+ 写 4（comment/review/merge/issue.create），写不标只读，走既有 risk 确认层。
- **凭据**：加密存 `personal_connectors.credential`；GitHub 凭据兼容两种形态（OAuth JSON 凭据、PAT 裸串）；错误与结果经 accessToken 替换 + token 形态正则双保险脱敏。
- **迁移 53**：重建 `personal_connectors`，provider CHECK 放宽为 `('mcp','gmail','github')`，保留 kind/account 列与唯一索引。
- **Web UI**：目录 GitHub 行、详情页（账户/重新授权/PAT 入口/工具列表）、`GithubConnect` 组件（OAuth 与设备码双形态，设备码显示用户码）。
- **Apple**：NexClientKit（Attempt 可选字段、provider 参数、`GithubTools` 校验、`saveGithubToken`）、`Shared/GithubConnectorView.swift`（设备码 + PAT）、iOS/Mac 目录接入。

## 自动验证

| 验证 | 命令/位置 | 结果 |
| --- | --- | --- |
| 连接器测试（GitHub 5 + Gmail 15 + MCP 13） | `pnpm vitest run server/personal-os/github-connectors.test.ts server/personal-os/gmail-connectors.test.ts server/personal-os/connectors.test.ts` | 33/33 通过 |
| 更广回归（app/service/feishu/stock-finance/broker-tool） | `pnpm vitest run …` | 全部通过 |
| typecheck（前端 + server） | `pnpm typecheck` | 0 错误 |
| NexClientKit 测试（含 GithubConnectorTests 7 项） | mac-air 临时目录 `swift test` | 252/252 通过，0 失败（245 既有 + 7 新增） |
| 双端 Xcode 构建 | mac-air `xcodegen generate` + Mac Release / iOS Debug（generic simulator 目标） | 两次 BUILD SUCCEEDED |

mac-air 验证在独立临时目录（/tmp/nexbot-github-connector，验证后已删除）完成，未触碰用户既有检出。已知与本次无关的既有失败（均用裸 origin/main 基线复现）：workspaces.test 的 404≠400（见 connector-default-open 记录的清单），以及 src 前端套件中 ApprovalCard.test 与 memory.test 的 2 例（stash 全部改动后基线同样失败）。

## 测试覆盖的关键行为

- 设备码流：begin 返回用户码与验证页、后台轮询至 connected、重启存活；伪造验证页地址被拒。
- OAuth Web 流：PKCE/state 绑定、回调一次、重放拒绝、拒绝授权报错、重复账号拒绝、换账号重连拒绝。
- PAT：save 即建行并展示工具目录、test 发现账号（account 写回）、401 后凭据清空并提示重连。
- 工具调用：checks 快照（失败项/指纹/日志尾部 16KB）、列表分页、写工具走网关；`repo` 格式与参数校验；token 脱敏（含 ghp_ 形态正则）。
- 断开：本地删除立即生效；设备码/PAT 连接提示无法远程撤销（警告文案）。

## 明确未验证 / 未包含

- 真实 GitHub（github.com）全链路：测试全部走 `testing/fake-github.ts`（隔离本机 fixture），未对真实 GitHub 发起任何调用。生产连真实 GitHub 属部署后人工验证。
- 率限退避、PR 列表 diff、checks 指纹去重、投递管道：第 2 期（监视器）内容，本期未实现。
- `check-ios.sh` 的完整 iOS 检查链与打包：本期只做了双端 Debug/Release 构建验证。
- macOS/iOS 渲染 fixture（`Testing/`）未跑——Gmail 样板同样不覆盖其渲染 fixture。

## 已知边界

- 复用了既有 `personal_connectors` 表与 connector.call 网关；`provider=github` 的行对工作区全部助手开放（连接器默认开放模型，a61a84d7）。
- OAuth App 模式需要回调地址与 Core 公网地址同源（`requestOrigin` 只认配置的 Host，与 Gmail 相同）。
