# 显示供应商提供的模型名称：全平台发布记录（2026-11-08）

已发布 [nexbot-v0.9.29-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.29-preview.1)：Windows 0.9.29、Android 0.2.28（228）、Mac / iOS 0.2.22（24）。Tokyo Core 部署了两次：先是功能和 schema 46，再是只改主页文字的更新。

## 问题与原因

用户反馈：模型列表里显示的不是模型自己的名字。

在 Tokyo 用只读脚本取得这个供应商的模型列表，只输出 `id` 和 `display_name`，不输出 Key。

- 该账号用 Anthropic 格式连接 `https://api.nexorai.com.cn/cpa`。这个代理把非 Claude 模型的 `id` 改写成 `claude-fable-5-dd-<倒写的名称>`，真实名称放在 `display_name` 里，例如 `claude-fable-5-dd-6.4-korg` 对应 `Grok 4.6`。44 个模型都带 `display_name`。
- 同一个服务的 OpenAI 格式地址（`/cpa/v1`）直接返回真实 ID，不带 `display_name`。
- NexBot 原来只读取 `id`，把 `display_name` 丢掉了（`shared/model-catalog.mjs`）。

## 修复

- 读取模型列表时保留 `display_name`，只记录与 `id` 不同、且长度在 200 以内的名称。
- 迁移 v46 新增空表 `model_display_names`，按 API 格式和地址存储（和启用列表的键一致）：
  - 只有已保存的供应商获取列表时才写入；
  - 完整列表会替换旧名称，部分列表只增补；
  - `/api/state` 随每个供应商返回 `names`。
- Web、Mac、iOS：设置页的模型列表显示名称，下面一行小字是 ID，搜索两者都匹配；聊天模型菜单和当前模型标签显示名称。请求仍发原始 ID。
- 线上已配置的供应商，打开设置 → 模型时会自动获取列表并保存名称，点「获取模型」也会更新。

提交：功能 `56ef4f9c`，版本号 `4ee0e51a`，README 与主页 `1ab14150`。

## 验证

- **Core**：Core 测试 536 项通过；另有 4 项失败，与上次相同，在改动前的提交上同样失败。
  - 发布前全量运行时多出一项失败：`server/personal-os/model-catalog.test.ts` 用完全相等比较返回值，新增的 `names` 字段让它不再相等。已改为期望 `names: {}`，修复后连同供应商测试共 10 项全部通过。
  - 新增测试覆盖：保存名称、刷新替换、请求仍用原 ID、没有供应商使用的地址不保存名称、从 v44 升级到 v46。
- **模型列表解析**：`shared/model-catalog.node-test.mjs` 6 项通过。
- **Web**：网页测试 3725 项通过；另有 2 项依赖机器语言设置的失败，与本次无关。lint 和 typecheck 通过。
- **实际 Core 隔离验证**：`verify.mjs` 新增检查，合成模型的列表名称要随供应商出现在状态里。Tokyo 上的候选版通过。
- **东京生产库**：6 个账户库的只读副本迁移到 schema 46 后，逐表记录哈希与预期一致（只多一张空表）。停机部署后，记录哈希、配置哈希、公网 `/health` 200、未认证 API 401、HTML 和资源逐字节比对全部通过。
- **Windows**：精确 EXE 隔离检查 20+24 项。
- **Android**：82 项单元测试，证书 SHA-256 `af012179…cb4b`，与已发布版本相同。
- **Apple**：在 Mac 上从干净克隆构建，186 项单元测试、三个目标构建、Mac / iOS 渲染测试（含名称测试）通过；DMG 和 IPA 版本、签名检查通过。
- **GitHub**：6 个资源的大小和 digest 与本地一致。
- **OSS 与更新**：旧清单（0.9.28 / 0.2.27 / 0.2.21）私密备份到 `/data/nexbot/backups/main-4ee0e51a-20261108-pre/previous-manifest.json`，然后上传 4 个安装包并更新清单。旧版本客户端会收到新版本，新版本不再提示更新；4 个下载与本地文件一致。
- **主页**：无头 Chrome 打开公网主页，4 个平台的版本、链接、大小和哈希都与已发布安装包一致，0.9.29 发布链接存在。

| 部署 | 运行目录 | 上一版 | 备份 | drop-in |
| --- | --- | --- | --- | --- |
| 模型名称 | `main-4ee0e51a-20261108` | `main-f79179fe-20261108` | `/data/nexbot/backups/main-4ee0e51a-20261108-pre` | 47 个 `z` |
| 主页 | `main-1ab14150-20261108`（现行） | `main-4ee0e51a-20261108` | `/data/nexbot/backups/main-1ab14150-20261108-pre` | 48 个 `z` |

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.29-x64-Client-Portable.exe | 199609793 | `f3f28d681b62bb27f8adf6f2dc867f90532939182061e8cfeb88736068420496` |
| nexbot-0.2.28-debug.apk | 43846837 | `37fdf8ccf800934b1782ccdf49415ec1c73804fddaccd90665f87056f5fccbf3` |
| NexBot-0.2.22-mac-arm64.dmg | 102597999 | `52c935c5bbd94fb69f1de33acfd9874f145aa03843d51044f5ea22ea91d97347` |
| NexBot-0.2.22-ios-unsigned.ipa | 34959033 | `42de6b91f6589b8160653580a2521db05262d8efbddc18d0d117b03e7662cf8d` |

## 限制

- 部署后没有在线上账户上实际触发一次列表获取：那会写入用户数据，所以留给用户打开设置页时完成。
- Mac / iOS 界面未截图，也未手动操作。
- 本次 ZeroTier 地址 SSH 超时，部署和发布改用公网地址 `43.207.215.225`。
