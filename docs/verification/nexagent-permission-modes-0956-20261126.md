# NexAgent 新建会话三标签、按 CLI 的权限模式与返回手势 · 0.9.56 四端预览发布

生产 Core 和四端安装包均来自已推送到主分支的提交 `da0b05caee5bea7da598e5b0319e9a2b287c2a71`。功能提交为 `efb94733`，与主分支合并为 `35cc70fa`，`da0b05ca` 只改版本号。[预览版与校验文件](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.56-preview.1)

## 改动

- 新建会话：输入框上方一行三个标签：项目、运行工具、会话选项。会话选项弹出 Worktree 开关、分支名和权限模式。手机上输入框贴底，标签不换行。
- 权限模式按 CLI 适配，电脑端声明 `permissionModes` 后 Core 才转发新模式，旧电脑端只收到完全访问和每次询问：
  - Claude Code：计划模式、每次询问、自动接受编辑、自动审批、完全访问，分别对应 `--permission-mode plan/default/acceptEdits/auto` 和 `--dangerously-skip-permissions`。
  - Codex：只读、默认、完全访问。前两项以 `-c sandbox_mode=read-only|workspace-write -c approval_policy=on-request` 启动，完全访问沿用原参数。
  - Antigravity：每次询问、自动接受编辑、完全访问。自动接受编辑通过 ACP 设为 `auto_edit` 模式，完全访问仍由执行器代答。
- 已有会话可在输入框 + 号切换权限模式。停止的会话和空闲的 Antigravity 会话随下一条消息生效，终端里运行的 CLI 在下次启动时生效。
- 会话目录：同一台电脑上名字相同的项目合为一组。只含一个文件夹的项目保留原有排序与折叠状态。
- 安卓返回手势在 NexAgent 内逐级返回：浮层、侧栏、会话页的工作区面板与编辑、会话回目录、搜索与归档，最后退到后台，不再切到 NexBot。原因是 NexBot 与 NexAgent 的返回处理都挂在 `window` 上，按注册顺序执行，捕获阶段不能抢先。
- Claude 的「[Request interrupted by user for tool use]」显示为「你已中断本次请求」，Web 与 Apple 一致。
- 中断等待中的 Claude 并引导时，若中断后立即发送失败，消息留在队列首位，由队列在会话可输入时发出，页面不再报「引导未送达」。真正未能插入当前一轮时提示「没能插入这一轮，会在这一轮结束后发送」，消息发出后提示自动清除。
- Antigravity 用户消息只保留 `<USER_REQUEST>` 中的原文，只有附加标签的输入不再显示。已处理的审批卡片显示结果 4 秒后离开输入框上方。
- 点 NexAgent 品牌直接切换到 NexBot。输入框图片只显示缩略图，点开查看，关闭按钮在图片右上角。

## 工件和线上验收

| 工件 | 版本 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| Windows x64 Setup | 0.9.56 | 149154998 | `bfef813b1505fbfed924d6918155e7db70ce4d6255ca44330a926c763f0ea439` |
| Android APK | 0.2.55 (255) | 44146716 | `aeaca7e3a8422fbe14ea1392a94a72dc868fcd18647bff9b38a1b8a84fc6bbdf` |
| macOS arm64 DMG | 0.2.48 (50) | 110384549 | `c23dc6079bafe0af7b3c2cf33faff07d9754a05bf149ddf4cdeea460aff60a08` |
| iPhone IPA | 0.2.48 (50) | 37504629 | `87cada690b0eacc5768924189dff1756e0bc61c3ee097a015e56263e97358beb` |

- 发布前在合并后的提交上运行静态检查（lint、类型检查、多语言目录），推送钩子再次通过。
- Windows：GitHub Actions 从发布提交打包，在隔离环境完成安装、覆盖升级和 20 项登录与设备冒烟，日志中的安装包哈希与上表一致。[Windows 构建与验收](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45779499714)
- Android：在 Windows 上从发布提交的干净工作树构建。核对应用版本 0.2.55 (255)，签名证书 SHA-256 `af012179…cb4b` 与 0.2.54 一致。
- Mac 与 iPhone：在 Mac 上从发布提交的干净克隆构建，使用专用临时模拟器，完成后删除。核对 DMG 中应用版本、签名和内嵌执行器，以及 IPA 应用版本和未签名状态。NexClientKit 277 项测试通过。
- 生产 Core：隔离候选 Core 用打包后的 Core 和电脑端执行器验证 Antigravity 会话发现、同 ID 续接、幂等发送、以自动接受编辑新建会话时切到 `auto_edit`、审批卡片与队列顺序。6 个工作区的 SQLite 备份副本通过完整性检查，结构版本仍为 59。切换前后业务数据哈希一致。公网健康检查为 200，匿名 API 为 401，首页及 24 个静态资源与构建逐字节一致。
- GitHub 发布资产的大小和 SHA-256 与本地文件一致。OSS 发布前私有备份旧清单，经 dry-run 后上传并逐一回读校验。
- 更新接口：Windows 0.9.55（安装版）、Android 0.2.54、Mac 与 iPhone 0.2.47 均收到新版本，新版本本身无更新。从更新接口实际下载的 4 个包均匹配字节数和 SHA-256。
- 官网首页实际渲染 Windows 0.9.56、Android 0.2.55、Mac 0.2.48、iPhone 0.2.48，下载链接指向本次发布的文件。[官网四端下载](https://bot.nexorai.com.cn/#platforms)

## 开发验证

- Web：新建会话三标签与选项面板、按 CLI 的权限模式列表、+ 号权限模式与「下次启动时生效」提示在隔离环境中按手机与桌面宽度截图核对。
- 安卓返回顺序用模拟的安卓桥接在隔离环境中逐步核对：工作区面板 → 会话 → 目录，菜单 → 搜索 → 后台，全程不切到 NexBot。
- 单元与集成测试覆盖中断标记、Antigravity 消息原文、审批卡片淡出、中断后引导留在队列并在空闲时发出、各 CLI 的启动参数、Core 只向声明 `permissionModes` 的电脑端转发新模式并拒绝 CLI 没有的模式、Antigravity 切到 `auto_edit`。

## 验证范围

没有在真实的 Claude Code、Codex、Antigravity 会话中实测各权限模式。Codex 的 `-c sandbox_mode`、`-c approval_policy` 覆盖未用真实 Codex 验证。安卓返回手势未在实体手机上验证。Android 与 iPhone 只做了包体验证，Apple 界面没有渲染截图。
