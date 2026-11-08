# 任一 OpenAI 兼容供应商都可生图：全平台发布记录（2026-11-08）

已发布 [nexbot-v0.9.30-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.30-preview.1)：Windows 0.9.30、Android 0.2.29（229）、Mac / iOS 0.2.22 → 0.2.23（25）。Core 和主页在同一次部署中上线。

## 问题

用户的默认供应商是 Anthropic 格式（`darren-cpa`），另外加了一个 OpenAI 兼容的 `cpa`，「生图模型」仍然显示「当前模型连接不支持生图」。

原因：生图调用的是 OpenAI 的 `/images/generations` 接口。原实现只认默认供应商，而且要求它是 OpenAI 格式（`store.ts` 的 `saveImageModelSelection`、`image-models.ts` 的 `list()`）。非默认的供应商不会被考虑。

## 修复

- 所有已启用、已配置的 OpenAI 兼容供应商，都提供各自勾选的生图模型，默认供应商排在最前。两个供应商勾了同名模型时显示为「模型@供应商」。
- 生成时使用该模型所在供应商的地址和 Key，生成前后的版本检查也针对这个供应商。
- `models/images` 可以带 `connectionId`。不带时（旧客户端）仍按默认供应商处理。`/api/state` 中每个 OpenAI 供应商都带 `imageModels`。
- 不需要迁移：生图选择原本就按「格式 + 地址」存储，schema 仍为 46。
- Web、Mac、iOS 的「生图模型」：先选供应商，再勾选它的模型。

提交：功能 `7d74d831`，版本号 `d024e4f2`，README 与主页 `3a524f51`。全部构建都来自 `3a524f51`。

## 验证

- **Core**：Core 测试 538 项通过；另有 4 项失败，与之前相同，在改动前的提交上同样失败。新增测试：默认供应商为 Anthropic 时，旧版按默认供应商保存会被拒绝；用 `connectionId` 给非默认的 OpenAI 供应商保存可以成功；状态里只有 OpenAI 供应商带 `imageModels`；`list()` 标出所属供应商；生成时请求带该供应商的 Key；停用后不再提供。
- **Web**：网页测试 3727 项通过；另有 2 项依赖机器语言设置的失败。新增「生图模型」组件测试（非默认 OpenAI 供应商，以及没有 OpenAI 供应商时的提示）。lint 和 typecheck 通过。
- **Apple**：发布前在 Mac 上构建并运行渲染测试，`imageModels` 解析测试通过。正式包从干净克隆构建：186 项单元测试、三个目标构建、渲染测试通过；DMG 和 IPA 的版本与签名检查通过。
- **Core 部署（Tokyo）**：
  - `main-3a524f51-20261108`，上一版 `main-1ab14150-20261108`，备份 `/data/nexbot/backups/main-3a524f51-20261108-pre`，drop-in `…-image-providers-release.conf`（49 个 `z`）。
  - 候选版通过 `verify.mjs`，新增按供应商保存生图模型的检查。6 个账户库只读副本校验通过（无迁移）。
  - 停机部署后，记录哈希、配置哈希、`/health`、401、HTML 和资源逐字节比对全部通过；本机另对公网复核，通过。
- **Windows**：精确 EXE 隔离检查 20+24 项。
- **Android**：82 项单元测试，证书与已发布版本相同。
- **GitHub**：6 个资源的大小和 digest 与本地一致。
- **OSS 与更新**：旧清单（0.9.29 / 0.2.28 / 0.2.22）私密备份到 `/data/nexbot/backups/main-3a524f51-20261108-pre/previous-manifest.json`。上传并更新清单后，旧版本客户端会收到新版本，新版本不再提示更新；4 个下载与本地文件一致。
- **主页**：无头 Chrome 打开公网主页，0.9.30 发布链接存在；4 个平台的版本、链接、大小和哈希都与已发布安装包一致。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.30-x64-Client-Portable.exe | 199609912 | `701255848dbeca442ce8804cc218e7fe827fd60660b79507b050505f915f64fb` |
| nexbot-0.2.29-debug.apk | 43846977 | `5b4ce0afd2d9ed0a921bca1cc704a6ee7db0048f843a68303796e1c9cf428694` |
| NexBot-0.2.23-mac-arm64.dmg | 101731999 | `002209936dc6f7b78eb2785ad35f9a28d6361fef336fd52cd924d8c654b311d5` |
| NexBot-0.2.23-ios-unsigned.ipa | 34965799 | `5571d57bb481c78397fba9450d5deb8e9985ec5993757eb782f030fe2ac43352` |

## 限制

- 没有对用户真实的生图服务做端到端生成：那会产生费用并写入用户数据。生成路径只在模拟服务上验证过。
- Mac / iOS 界面未截图，也未手动操作。
