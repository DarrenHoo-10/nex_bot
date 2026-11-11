# 后台任务：全平台发布记录（2026-11-02）

已构建并发布：Windows 0.9.27、Android 0.2.26（226）、Mac/iOS 0.2.20（22）。标签：`nexbot-v0.9.27-preview.1`。

设计与方案：[助手后台任务](../design/assistant-background-jobs.md)、[技术方案](../plans/2026-11-01-background-jobs-implementation.md)。

## 来源

- 功能分支 `claude/background-jobs-04ba11` 经代码审查，10 项问题已修复并各有测试。之后合并 `origin/main`（`9b60e4e2`、`5d7e99b2`）。唯一冲突在 `server/personal-os/tool-fields.ts`，保留了两边的字段。
- 升版本后快进推送 `main`，得到 `1266a370350b02e1e7acbfaccd2290c6add4ce8c`。Core、Web 和四个安装包都来自这个提交。
- README 与官网介绍在其后的 `31b257972942210b0a2da966929c94da6db63c05` 中更新，并再次部署 Core。这次只改了界面文字，没有迁移。

## 测试

- typecheck、lint 通过；网页 128 项全部通过。
- `server/personal-os`：520 项通过，8 项失败，3 项跳过。
  - 其中 7 项在 `origin/main` 上同样失败：compaction-timing 2 项、image-models 1 项、memory-recall 3 项、sender-device 1 项，已在 `9b60e4e2` 的独立检出中复现。
  - 另 1 项是 `server/personal-os/maintenance.test.ts`「clears the pending run when a task comes first」。当时机器同时在打 Windows 和 Android 包，它失败了；单独重跑两次 15/15 通过，合并后第一次完整运行时也通过。
- 隔离验证：`release/deployment-background-jobs/verify.mjs` 用实际构建的 Core 和合成模型逐项验证了以下内容：
  - 主对话派发；
  - 后台任务运行在独立的 Conversation 中；
  - 后台任务运行时主对话立即回答；
  - 回报只发布一次，重复结算或恢复后不重复；
  - 执行过程不进入消息流；
  - 主对话调用 `image.generate` 被拒绝，返回 `useJob`，且不产生审批；
  - 待办作为后台任务进入待验收，第二次验收以 409 拒绝；
  - 停止后不再接受输入；
  - schema 44 和重启后的持久化。

## 部署（东京）

两次部署都执行了同一套保护：

- 部署前确认没有活动任务；
- 停机备份数据、配置和 systemd 设置；
- 新增一个排序在最后的 drop-in，任一检查失败即自动回滚；
- 检查全库逐表记录哈希、非数据库文件哈希和配置哈希；
- 公网 `/health` 返回 200，未认证 API 返回 401，HTML 与全部构建资源逐字节一致。

| 发布 | 运行目录 | 前版 | 备份 | drop-in |
| --- | --- | --- | --- | --- |
| 后台任务 | `main-1266a370-20261102` | `main-9b60e4e2-20261101` | `/data/nexbot/backups/main-1266a370-20261102-pre` | 42 个 `z` |
| 官网文字 | `main-31b25797-20261102` | `main-1266a370-20261102` | `/data/nexbot/backups/main-31b25797-20261102-pre` | 43 个 `z` |

第一次部署之前，先用只读一致副本把六个生产库从 schema 42 迁移到 44。迁移后，逐表记录哈希与独立推算的结果一致：

- `agent_task_links` 重建后行内容不变；
- 新增四张空表；
- `personal_feishu_outbound.job_id` 为空。

迁移只在副本和停机后的生产库上运行，没有在原库上启动运行时。

## 安装包

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.27-x64-Client-Portable.exe | 199602932 | `212d24859b0818fd2c7513e40a9747aa7e80a38d1d10c6ec6fa2071547336468` |
| nexbot-0.2.26-debug.apk | 43838249 | `d6311c8075b38f46978e4f36f3bd6728976efa0046d9e32c5ad349b32af0cb97` |
| NexBot-0.2.20-mac-arm64.dmg | 102222615 | `a929f14a27521eda1c2fea5664266541ff8829fa1fc48ed30e1757023a3e62f1` |
| NexBot-0.2.20-ios-unsigned.ipa | 34822189 | `ffb080ff62fc484955dc9ab96cccd15b0f819a450c499fb1bb79088b75591f2c` |

- **Windows**：用 `smoke-shell-login.mjs --exe` 对这个 EXE 跑了单账号 20 项、多账号 24 项隔离检查，全部通过。
- **Android**：`:core:test`、`:app:testDebugUnitTest` 共 82 项通过。`aapt` 读出 versionName 0.2.26、versionCode 226。签名证书 SHA-256 为 `af012179…cb4b`，与已发布的 0.2.25 相同。
- **Mac/iOS**：在 Mac 上全新 clone 推送后的提交，用一个专用模拟器构建，构建完已删除模拟器和临时目录。
  - NexClientKit 186 项单元测试通过；
  - Mac、iOS 渲染测试各 14 项通过；
  - 三个目标构建成功；
  - DMG 临时签名校验通过，内含执行器；
  - DMG 与 IPA 的版本均为 0.2.20/22。

## 发布与核对

- **GitHub**：预发布 `nexbot-v0.9.27-preview.1` 指向 `1266a370`。六个文件（四个安装包、`SHA256SUMS.txt`、`SOURCE_COMMIT.txt`）在 GitHub 上的大小和 SHA-256 digest 与本地一致。
- **OSS**：上传前先把旧清单私下备份到 `/data/nexbot/deploy/background-jobs-20261102/previous-manifest.json`，dry-run 后再上传。四个文件均上传并读回校验，然后更新共享清单。
- **更新接口**：Core 刷新清单后，旧版本（0.9.26、0.2.25、0.2.19）都收到新版本，当前版本收不到更新。从每个实际提供的下载地址读回的文件，大小和 SHA-256 都与本地安装包一致。
- **README 与官网**：两者同步更新。用隔离的无头 Chrome 访问已部署的官网，核对了 Windows 0.9.27、Android 0.2.26、Mac/iPhone 0.2.20 及实际下载链接，也确认了新的「后台与定时任务」介绍；截图已目视检查。

## 边界

- 没有用真实模型验证助手何时主动派发后台任务，验证中由合成模型直接调用 `job.start`。
- Mac、iOS 应用没有连接线上 Core 实际运行；也没有做真机覆盖安装或生产负载测试。
- 签名：Windows 无发布者签名；Android 为调试签名；Mac 为临时签名，未公证；iPhone IPA 未签名。
- 已知取舍：一轮后台任务被取消时整项后台任务随之停止，包括因登录失效而被取消的情况。
- 所有测试数据均为合成数据，生产账户没有收到测试任务。
- 原始日志、安装包和校验报告保存在本机被忽略的目录 `release/ship-0.9.27/`、`release/deployment-background-jobs/`、`release/deployment-homepage/`，以及东京的 `/data/nexbot/deploy/` 和 staging 目录。
