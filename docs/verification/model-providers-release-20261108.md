# 多供应商、思考强度与子代理对话：全平台发布记录（2026-11-08）

已发布 [nexbot-v0.9.28-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.28-preview.1)：Windows 0.9.28、Android 0.2.27（227）、Mac / iOS 0.2.21（23）。Tokyo Core 已部署两次：第一次是功能和 schema 45，第二次只更新主页文字。

本地开发与隔离验证见 [多供应商与推理强度：本地隔离验证](model-providers-20261108.md)，方案见 [技术方案](../plans/2026-11-08-model-providers.md)。

## 来源

- 用户确认后发布（「ok发布吧」）。
- 功能分支三个提交：后台任务子代理对话 `38718c0d`、显示模型全选 `dcead93e`、多供应商与推理强度 `3af3bade`。随后一个版本号提交 `4b2dd43e`。推送前确认远端 `main` 仍是 `bc2a9ed4`、是本分支的祖先，快进推送到 `main`。推送 hook 的 lint、typecheck、locale check 全部通过。
- README 和主页文字在 `f79179fe` 中更新；推送前再次确认远端 `main` 是 `4b2dd43e`。
- 所有构建都来自对应提交的 `git archive` 干净快照，不是工作区。注意：`git archive` 必须在仓库根目录执行，在子目录执行只会打包那个子目录。

## Core 部署（Tokyo）

| 项目 | 功能发布 | 主页发布 |
| --- | --- | --- |
| 提交 | `4b2dd43e1bd8573ab09b4d3a3d393795c46ae5eb` | `f79179feb11ec70416624190c99d8cb06086042d` |
| 当前版 | `/data/nexbot/releases/main-4b2dd43e-20261108` | `/data/nexbot/releases/main-f79179fe-20261108`（现行） |
| 上一版 | `main-6e7d6a8b-20261107` | `main-4b2dd43e-20261108` |
| 备份 | `/data/nexbot/backups/main-4b2dd43e-20261108-pre` | `/data/nexbot/backups/main-f79179fe-20261108-pre` |
| 覆盖包 SHA-256 | `4d37ae78…68f4` | `825c05d5…838e` |
| drop-in | `…-providers-release.conf`（45 个 `z`） | `…-homepage-0928-release.conf`（46 个 `z`） |

- **prepare（两次都通过，服务未受影响）**
  - 候选版在 Tokyo Linux 上通过 `verify.mjs`。脚本在上次的后台任务全流程之外新增了供应商检查：
    - 原连接是默认供应商；
    - 第二供应商用自己的 Key 和地址；
    - 选「高」的模型收到 `reasoning_effort: "high"`，默认供应商的请求不带推理参数；
    - `task_runs` 记录实际使用的供应商；
    - 旧客户端的 `bots/model` 仍可用；
    - 默认供应商不能删除，删除第二供应商后助手回到默认；
    - 状态里不出现 Key；
    - schema 45，重开后数据持久。
  - 6 个账户库以只读方式 `VACUUM INTO` 出副本，只在副本上迁移到 schema 45。逐表规范化记录哈希与独立推算的结果一致，推算内容只有：`model_connections` 新增 `enabled=1`、`sort_order=0`，`is_default` 仅 `id='default'` 为 1；`agent_model_settings` 新增 `reasoning=NULL`；新增空表 `model_options`。
- **deploy（两次都一次通过）**
  - 停机前后两次确认所有账户没有活动任务和运行中的定时任务。
  - 停机后备份数据、`core.env`、`oss.env` 和 systemd 配置。
  - 离线迁移后，6 个库的记录哈希与预期一致，非数据库文件哈希和配置哈希都不变。
  - 新的 drop-in 排在所有已有 drop-in 之后。
  - 本机和公网：`/health` 返回 200，未认证 API 返回 401，HTML 和 3 个引用资源、7 个打包资源逐字节一致。
  - 本机另用 `verify-public.mjs` 对公网复核，通过。

## 客户端

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.28-x64-Client-Portable.exe | 199609499 | `419782914be6082fb6fcbe5555b551cd6ea0495415c8bc53ee945503967a57f4` |
| nexbot-0.2.27-debug.apk | 43846597 | `51c319dc7078c7f2de141b593b841ed248eaaca415adfcb6b411833c82a10978` |
| NexBot-0.2.21-mac-arm64.dmg | 102587675 | `3785b85497aa861488c4bfc45642e7d3d99ce3e2d906f8750205027cb0ce404f` |
| NexBot-0.2.21-ios-unsigned.ipa | 34956456 | `1fc9c74532afc4cb3192fcbfcffe4e6c50c556829856756d4ba17ccafc5017d4` |

- **Windows**：精确 EXE 的 `smoke-shell-login.mjs` 通过，单账号 20 项，账户工作区模式 24 项。打包时 `pnpm package:client:win` 内部调用的 pnpm 因 corepack 版本检查失败，改为直接运行 `build-personal.mjs --shell` 和 `package-personal.mjs --client`，产物相同。
- **Android**：`:core:test :app:testDebugUnitTest :app:assembleDebug` 通过，单元测试 82 项、0 失败。`apksigner` 显示证书 SHA-256 `af012179…cb4b`，与已发布的 0.2.26 相同，可以覆盖安装。
- **Mac / iOS**：在 Mac 上 `git clone` 已推送提交，`pnpm install --frozen-lockfile`，生成图标，用专用模拟器运行 `release-preview.sh`。
  - `NexClientKit` 单元测试 186 项通过；Mac Release、iOS 模拟器、iOS 真机三个构建成功；渲染测试 Mac、iOS 各 16 项通过。
  - DMG 签名、内置 executor、版本 0.2.21/23 校验通过；IPA 版本与可执行文件校验通过。
  - 完成后删除模拟器和临时目录。

## 发布

- **GitHub 预发布**：`nexbot-v0.9.28-preview.1`，目标提交 `4b2dd43e`，附 4 个安装包、`SHA256SUMS.txt`、`SOURCE_COMMIT.txt`。6 个资源的大小和 digest 都与本地文件一致。
- **OSS 与更新清单**：上传前先把旧清单（Windows 0.9.27、Android 0.2.26、Mac / iOS 0.2.20）私密备份到 `/data/nexbot/backups/main-4b2dd43e-20261108-pre/previous-manifest.json`（权限 600）。dry-run 后在 Tokyo 后台发布，4 个对象都上传并校验，清单已更新。
- **更新检查**：Core 刷新清单后，`/api/client/update` 对旧版本（0.9.27 / 0.2.26 / 0.2.20）提供新版本，对新版本不再提供更新。下载 4 个安装包，大小和 SHA-256 都与清单、本地文件一致；`/api/client/downloads` 显示新版本。
- **主页与 README**：README 的下载表与说明更新到 0.9.28。主页功能介绍加入多供应商、思考强度和子代理对话，发布链接改为 0.9.28。用无头 Chrome 打开公网主页：4 个平台的版本与链接正确，每张卡片的链接与 `/api/client/downloads` 一致，大小和哈希与已发布安装包一致。

## 未验证与限制

- Mac / iOS 的新模型设置页和模型菜单只经过编译和数据层测试，没有截图，也没有手动操作。
- 推理参数只对模拟模型验证了请求体，没有接真实服务。
- 没有真机覆盖安装测试，也没有生产负载测试。
- Windows EXE 没有发布者签名；Android 是调试证书测试包；Mac 是临时签名，未公证；iPhone IPA 未签名。
