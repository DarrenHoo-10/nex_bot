# Codex 输入框识别与发送保护 · Windows 0.9.59 / Mac 0.2.51

构建基线为已推送的 `main` 提交 `42f163a3fd1be5735eef19ae00a2b8caf7a9dbc3`。[GitHub 桌面预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.59-preview.1) · [官网下载](https://bot.nexorai.com.cn/#platforms)

修复位于电脑执行器，不涉及 Core、数据库、网页或手机端代码。此前 Codex 输入框下方的模型状态、快捷键与警告分成两行时，NexAgent 会把已经就绪的会话误判为不可写；此次保留终端身份、连续两次稳定读屏、草稿和收件确认检查，没有增加自动重发。要让手机或网页继续向 Codex 发消息，需要更新运行 Codex 的 Windows / Mac 客户端。

## 回归与包体验证

- 主分支推送前完成 lint、TypeScript 检查和 10 种语言的目录校验。推送后的发布准备在独立临时配置与模拟终端中运行输入框和会话映射回归：2 个文件，所选 23 项全部通过，筛选外 69 项未运行。覆盖了快捷键和警告同行、状态换行、已有草稿、审批弹窗与工作中终端。不使用用户真实配置或会话验证写入。
- [Windows 安装包工作流](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45937152532) 在独立 Windows VM 从指定 SHA 构建 NSIS。对实际安装包验证了非空目录保护、自选目录、重装保留配置、快捷方式、已安装应用登记、单实例恢复及安装后 20 项登录冒烟。Windows 未做发布者数字签名。
- 在最终 Windows Setup 内读回 `client-executor/client-node/client-node.js`，确认包含更新后的输入框识别及调用逻辑，安装包摘要与构建机打印的一致。
- Mac 在 Mac Air 用全新克隆及独立临时模拟器构建；只读挂载 DMG 核验 `com.nexbot.mac`、版本 `0.2.51 (53)`、`codesign --verify --deep --strict` 和内置执行器。实际包内解析器可识别本次布局，拒绝单行草稿、多行草稿和选择菜单。临时模拟器、挂载和克隆已清理。包为临时签名、未公证，未运行 UI 渲染测试。
- [构建提交的主分支 CI](https://github.com/DarrenHoo-10/nex_bot/actions/runs/45937109725) 已通过：类型检查、lint、Kotlin 测试、Android 协议夹具及核心链路测试全部成功。
- Android 继续使用 0.2.57，iPhone 继续使用 0.2.50；均来自 [0.9.58 预览版](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.58-preview.1)。没有发布新手机包、部署 Core 或重启生产服务。

## 线上交付

| GitHub 与 OSS 安装包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `NexBot-0.9.59-x64-Client-Setup.exe` | 149210972 | `0c5b14c26a53ea542c24949583f55828169e88e641432e04dd9751170ed4abb4` |
| `NexBot-0.2.51-mac-arm64.dmg` | 112146922 | `eacfea89acc9f08df1ef5cb063c247438132a2ce00b0f06a931cfbcf78edca1f` |

- GitHub 先上传草稿，核对两个安装包和 `SHA256SUMS.txt`、`SOURCE_COMMIT.txt` 的字节数与摘要，公开预览版后再次核对，标签指向构建提交。
- Core 主机已私有备份旧清单；先 dry-run，确认只改变 Windows Setup 与 Mac 条目，再镜像安装包并读回。实际写入的清单与 dry-run 相同，其余平台条目不变。
- 通过公网更新接口验证 Windows 0.9.58（NSIS）与 Mac 0.2.50 可得到新版，当前版本均无更新。Android 及 iPhone 保留上一版；从四个平台返回的更新链接分别完整下载，大小、SHA-256 均与 GitHub 对应安装包相同。
- 无头浏览器验证了官网实际渲染的四张下载卡，版本和下载目标与共享清单一致，并逐项核对 README 与 GitHub 下载链接。公网健康检查为 200，未登录的状态接口与会话列表、会话流仍为 401；首页 HTML 及 12 个静态资源与原 Core 发布构建一致。未在实体手机上手动操作。
