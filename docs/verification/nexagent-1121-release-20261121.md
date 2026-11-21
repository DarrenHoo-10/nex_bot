# NexAgent 排序、搜索、模型与图片 · 发布记录 — 2026-11-21

发布 `nexbot-v0.9.39-preview.1`，源码 `main` 的
[`143a8b17`](https://github.com/DarrenHoo-10/nex_bot/commit/143a8b1718355a112dae19f25178249811e7ff72)
（`claude/ecstatic-mcnulty-9ba668` 合并当时的 `main`，即 0.9.38 飞书多应用发布之上；pre-push 的 lint、typecheck、
locale 检查通过）。之后的 [`6fa0bec6`](https://github.com/DarrenHoo-10/nex_bot/commit/6fa0bec6) 只修改 Apple 包测试，
未改应用代码，安装包仍来自 `143a8b17`。上一版见 [0.9.38 发布记录](feishu-multi-app-release-20261121.md)。

| 平台 | 版本 | 本次 |
| --- | --- | --- |
| Core / 网页 | `main-143a8b17-20261121` | 部署到 Mac Air，无数据迁移 |
| Windows x64 | 0.9.39 | 新发布（含电脑端执行器的新操作） |
| Android | 0.2.38 (238) | 新发布（随包网页界面） |
| Mac / iPhone | 0.2.30 (32) | 新发布（对话记录加载修复） |

## 改动

1. **项目顺序**：从未见过的项目排在最前，其余保持已保存的顺序（不再随活动时间跳动）；拖动项目行调整顺序，
   按电脑保存在浏览器 `localStorage`（`nexagent.projectOrder`），刷新后保留；「未关联项目」始终在最后。
2. **按时间**：顶栏时钟按钮（开启时变绿），只列会话，按最近活动排序，不分电脑、项目和分支层级；
   原「最近活动 / 按 Harness」排序菜单移除。入口用时钟图标而非参考图的铃铛。
3. **搜索**：放大镜展开搜索框；标题、项目、路径、Harness、分支在本地匹配，会话内容由设备新操作 `search`
   搜索（Core 的 cli-agents 搜索接口 `search?q=`，各在线设备并行，失败的设备忽略）。规则：空白分词、全部命中、
   不分大小写；只看用户和助手消息文字，不看工具输出；命中句显示在会话下方。
4. **输入框**：模型与推理强度选择（Claude：fable/opus/sonnet/haiku，effort low…max；Codex：gpt-6.x，
   effort low…ultra；留空沿用 CLI 默认）。已停止的会话继续时带上 `--model/--effort`（Codex `-m`、
   `-c model_reasoning_effort=`）；在 NexBot 终端里运行的 Claude 先发送 `/model`、`/effort` 再发消息；
   其他运行方式在下次继续时生效。图片：粘贴或从「+ → 图片」选择，缩略图用 `data:` URL（页面 CSP 不允许 `blob:`），
   单个 ≤ 8 MB，经 `POST /api/cli-agents/attach` 与设备新操作 `attach` 写到
   `<tmp>/nexbot-attachments/<engine>-<nativeId>/`，消息中写「图片：名称」和路径。设备的 WebSocket 帧上限
   从 8 MiB 提到 12 MiB。设备在 `cliAgents.features` 声明 `search`、`launchOptions`、`attach`；旧执行器被
   Core 拒绝并提示「电脑端版本过旧，升级后可用」。
5. **项目「+」**：项目行悬停出现，打开新建会话并带入项目目录。
6. **子代理**：工具摘要优先取 Claude Agent 的 `description`、Codex `spawn_agent` 的 `task_name`，不再显示整段任务。
7. **连续对话只剩当前问答**：原因是一页仅 40 项，一轮多工具调用即可占满；且每次重发最新页（重连、Codex App
   对话变化）都整表替换，读者已加载的更早记录丢失。现在重发页从已显示的项开始时保留前面的记录；首屏自动补到
   至少 3 轮用户消息（最多 6 页）；滚动到顶部附近自动加载。Mac/iPhone 同样修复。

## 证据

- **自动化**：`shared`、`cli-agents`、`cli-agents-node`、`src/personal/cli-agents` 75 个文件 1282 项通过；
  全量 vitest 另有 19 项失败（提示缓存、Grok 配置、外观同步、文档引用、剪贴板守卫、区域格式等 12 个文件），
  在干净的 `a535a184` 上同样 19 项失败，与本次无关。Apple：`NexClientKit` 255 项通过（首次运行发现旧测试按
  整表替换断言，已在 `6fa0bec6` 改为新行为并补充 reset 用例），Mac 与 iOS 界面测试各 15 项通过。
  Android 单元测试 94 项 0 失败。
- **隔离环境**（`scripts/smoke-cli-agents.mjs --workbench --serve`：假身份、合成会话、真实 herdr-core 与设备进程）：
  内容搜索「forks PARENT」命中助手回复并显示命中句；拖动 beta 到 alpha 之前，刷新后保留；「+」带入
  `…\work\beta`；时钟按钮变绿（`rgb(23,102,67)`）并平铺列表；已停止会话以
  `claude --resume … --model opus --effort high` 继续（进程命令行核对）；粘贴的 PNG 写入设备临时目录（文件头
  `89 50 4E 47`），消息包含路径；运行中会话改选 Sonnet 后先发送 `/model sonnet`；继续后之前的轮次仍在。
  无控制台错误。默认 smoke 的浏览器步骤仍按 0.9.35 的旧列表结构查找元素，0.9.36 起即不适用，未作为本次依据。
- **Core**：候选版本在 Mac 上隔离 Core（合成数据）通过，新增检查：search/attach 需登录、无设备时搜索为空、
  未知会话的 attach 与带模型参数的 start 被拒。部署时无进行中任务，备份
  `~/nexbot/backups/main-143a8b17-20261121-pre`，6 个工作区业务哈希一致；本机与公网 13 个资源逐字节一致；
  从本机独立复核 `/health` 200、未鉴权 401、经中继的流 401；7.8 MB 上传经中继到达 Core（401）。
- **Windows**：`NexBot-0.9.39-x64-Client-Portable.exe`（203,719,133 B，SHA-256 `7e62d436…6c6beb`，
  ProductVersion 0.9.39）在临时用户目录（USERPROFILE/LOCALAPPDATA/APPDATA 均指向临时目录）通过登录冒烟，
  残留 herdr-core 已结束。
- **Android**：`nexbot-0.2.38-debug.apk`（44,058,205 B，SHA-256 `f9cef79d…42334c`，versionCode 238），
  与已发布版本同一调试证书（`af012179…cb4b`）。
- **Mac / iPhone**：从推送提交全新克隆构建，专用模拟器用后删除；`NexBot-0.2.30-mac-arm64.dmg`
  （108,676,124 B，`0a11a104…a37aec`，0.2.30 (32)，临时签名校验通过）、`NexBot-0.2.30-ios-unsigned.ipa`
  （36,615,440 B，`2c677581…f0d226`，0.2.30 (32)）。
- **发布**：GitHub 6 个资产大小与摘要和本地一致；OSS 上传回读校验；旧清单私存于部署备份目录；
  `/api/client/update` 对 0.9.38、0.2.37、0.2.29 提供新版，对新版本不再提供，下载字节与清单一致。
- **主页与 README**：线上主页四张下载卡版本、链接、大小、SHA-256 与发布文件一致，发布说明链接指向
  `nexbot-v0.9.39-preview.1`；README 同步。

## 限制

- 内容搜索、模型参数和图片需要电脑上的 Windows 客户端升级到 0.9.39；未在真实的 Claude / Codex 会话上验收
  模型切换与图片读取；Codex App 与 ZCode 对话的内容搜索只在测试数据上验证；Codex `-m`/`-c` 参数位置按
  0.163 的 `resume --help`/`fork --help` 核对，未实际运行。
- 发往终端的多行消息在测试用 TUI 中按行拆开显示，真实 CLI 的表现未核对（此前已有的行为）。
- 翻译仍使用浏览器内置 Translator，不是模型；Apple 原生客户端未提供排序、按时间、搜索、模型选择与图片；
  均未在实体手机上安装测试。
