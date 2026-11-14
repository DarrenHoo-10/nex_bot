# 话题栏固定：本地验证（2026-11-14）

截图对应 `codex/finance-assistant` 工作区。Web 将返回聊天、话题标题和受众信息移到 `.transcript` 外，作为不可收缩的独立布局行；消息从该行下方滚动。手机允许长标题换行。Mac/iOS 的共享 `FinanceTopicsView` 在 `ScrollView` 外显示当前话题标题、受众与返回入口。

## 隔离验证

- `node release/topic-header-smoke.mjs`：真实 AgentDesktop/CSS，60 条合成消息，临时 Chrome 配置和模拟 API，未连接用户 Core 或数据。
- 1440 × 900 和 390 × 900：滚动到 500、2000 和底部（分别 2303、3678 像素），话题栏纵坐标保持 127、119；消息区域位于栏下方，无横向溢出。关闭资料抽屉后以鼠标点击返回按钮，话题栏消失并恢复话题列表。
- `tsc -b --pretty false` 通过。
- Apple 源码由当前提交导出到 Mac 的独立临时目录，仅覆盖本次修改的 Swift 文件，并将 CRLF 转为 LF；使用独立 DerivedData 构建。未使用用户现有 checkout 或启动用户模拟器。
- `xcodebuild` 的 `NexBotMac` Debug（macOS）和 `NexBotiOS` Debug（generic iOS Simulator）均通过，禁用签名；保留现有 WebKit 并发警告。Mac 本地验证构建未包含设备执行器，不用于发布。

本次仅为本地修改，未部署、发布或生成客户端安装包。浏览器行为验证不代表 Android 安装包验收，Apple 编译不代表原生滚动交互验收。
