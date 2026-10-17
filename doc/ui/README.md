# NexBot UI 截图参考

更新：2026-10-17。供 Mac agent 对照当前 Windows 上的真实渲染效果。

所有截图来自独立演示环境：演示账号、演示设备、合成聊天、本机模型与 MCP 服务。
不包含真实账号、密码、API Key 或正式服务数据。页面中的 localhost 地址、模型名、时间和数量仅为演示值，请勿写死到产品中。

## 页面索引

桌面默认尺寸为 **1440 × 960**。截图是当前工作区代码的界面，不代表已发布到正式服务。

| 页面 / 状态 | 截图 | 入口或说明 |
| --- | --- | --- |
| 登录 | [login-light.png](login-light.png) | Web 登录页；与桌面入口共用样式 |
| 桌面登录 | [login-desktop-light.png](login-desktop-light.png) | 打包客户端的独立登录入口；启动、退出、登录失效后统一使用 |
| 邀请码注册 | [register-light.png](register-light.png) | 注册入口；空表单截图，无真实账号或邀请码 |
| 退出确认 | [logout-confirm-light.png](logout-confirm-light.png) | 账号菜单和设置共用的应用内弹窗 |
| 聊天与右侧工作详情 | [workspace-light.png](workspace-light.png) | 点击联系人，展开助手详情 → 工作 |
| 聊天深色模式 | [workspace-dark.png](workspace-dark.png) | 账号菜单 → 切换深色模式 |
| 超宽聊天 | [workspace-wide.png](workspace-wide.png) | 2560 × 1440；阅读列保持限宽 |
| 右侧例行任务 | [inspector-routines-light.png](inspector-routines-light.png) | 助手详情 → 工作；紧凑列表、开关和标题旁的添加按钮 |
| 右侧助手设置 | [inspector-settings-light.png](inspector-settings-light.png) | 助手详情 → 设置；区别于全局设置 |
| 账号菜单 | [account-menu-light.png](account-menu-light.png) | 左下头像或账号；设置、主题切换与退出 |
| 助手形象选择 | [avatar-picker.png](avatar-picker.png) | 点击右侧助手头像；形状、颜色和状态预览 |
| 经典头像图库 | [avatar-collection.png](avatar-collection.png) | 1200 × 1160；20 张经典头像的独立总览，并非产品页面 |
| MCP 连接器 | [connectors-light.png](connectors-light.png) | 账号菜单 → 设置 → 连接器；工具与 Agent 授权 |
| 添加连接器 | [connector-add-light.png](connector-add-light.png) | 连接器 → 添加连接器 |
| 连接器工具授权 | [connector-grant-light.png](connector-grant-light.png) | 连接器详情 → Agent 授权编辑 |
| 工具调用审批 | [connector-approval.png](connector-approval.png) | 聊天中真实演示工具调用产生的审批 |
| 连接器空状态 | [connectors-empty-light.png](connectors-empty-light.png) | 未添加连接器时 |
| 设备网络 | [devices-light.png](devices-light.png) | 账号菜单 → 设置 → 设备；此图为带后端主机的演示模式 |
| 设置：账号与登录设备 | [settings-account-light.png](settings-account-light.png) | 账号菜单 → 设置，默认分类 |
| 设置：模型 | [settings-model-light.png](settings-model-light.png) | 设置 → 模型；从列表选择，也可手动输入；截图含保存成功反馈 |
| 设置：记忆服务 | [settings-memory-light.png](settings-memory-light.png) | 设置 → 记忆服务 |
| 设置：记忆服务（深色） | [settings-memory-dark.png](settings-memory-dark.png) | 深色模式对照 |

## 窄屏参考

以下尺寸均为 **390 × 844**，是同一 Web UI 的响应式视口截图，不是原生 Android/iOS 页面。
需要滚动的页面只截取首屏。

| 页面 / 状态 | 截图 |
| --- | --- |
| 聊天（深色） | [workspace-mobile.png](workspace-mobile.png) |
| 右侧工作详情（深色） | [inspector-routines-mobile-dark.png](inspector-routines-mobile-dark.png) |
| 账号抽屉菜单（深色） | [account-menu-mobile-dark.png](account-menu-mobile-dark.png) |
| 连接器（深色） | [connectors-mobile.png](connectors-mobile.png) |
| 设置分类与模型表单（深色） | [settings-mobile-dark.png](settings-mobile-dark.png) |

## 给 Mac agent 的实现说明

- **右侧详情已精简为“工作 / 设置”两个页面。** “资料”页面暂时移除，记忆数据、自动记忆和后台检索不受影响。右侧不再显示准备就绪卡片、连接器和设备管理区、例行任务空状态说明、工作目录或动效设置。
- 例行任务以单个圆角列表展示：左侧名称和计划摘要，右侧蓝色开关；点击任务打开编辑弹窗，“现在执行”也在弹窗内。空列表只保留标题与“＋”。任务开关与编辑相互独立，提交期间禁用开关。
- 点击右侧头像直接更换形象；助手设置 → 关于 → **bot身份信息** 打开身份编辑。顶部“编辑身份 / 更换头像”文字和调色板图标已移除。
- 文件和工具结果预览显示在“工作”页。当前工作及最近执行记录保留；不再通过已移除的“资料”页打开预览。
- 动效由任务状态驱动，并遵守系统“减少动态效果”；历史本机关闭动效的偏好仍然有效。旧“轻量动效”其实是本机全局开关，“仅当前助手”的标注不准确，本轮已移除入口。
- **全局设置继续按分类组织。** 五个分类（账号与登录设备、模型、记忆服务、连接器、设备）一次只显示一个，切换时保留未保存的表单内容。系统信息与高级请求地址已移除；记忆服务的诊断信息默认折叠。
- 全局设置以 `src/personal/panels.tsx`、`src/personal/auth.tsx` 和 `src/personal/settings.css` 为准；入口在 `src/personal/components/ContactSidebar.tsx`。
- 聊天和右侧详情在 `src/personal/AgentDesktop.tsx`；公共布局在 `workspace.css`、`identity.css`；连接器在 `ConnectorsPage.tsx`。
- 连接器和设备已收进设置分类，账号菜单不再提供单独入口；聊天区的管理快捷入口会定位到相应设置分类。设备页沿用原有功能并适配设置页布局。多账号正式服务的设备页可能不显示后端主机能力。
- 蓝色应用图标使用 `src/personal/assets/nexbot-mark.svg`；角色头像可选多种颜色，截图中的青色或紫色角色不是应用强调色。
- 头像选择器的状态按钮用于预览。聊天中的思考、执行、待确认和完成表情由真实任务状态驱动；左侧联系人在思考、执行工具时也播放对应动画，空闲及等待确认时静止；静态截图不能证明动效，应结合演示验收脚本。
- 拉取 `main` 后，以本目录截图和源码为准。默认薄客户端仍加载服务端页面，拉取源码本身不会更新正式站点；本机 Windows 使用可选的本地 UI 包。Mac 对照可运行下面的独立验收脚本，正式客户端构建与发布另行处理。
- Mac 端沿用同一 Web UI；原生标题栏、字体渲染、系统权限和桌面连接页需在 macOS 单独验收。不要据此复制 Windows 系统装饰。
- 登录页共用 `electron/client/style.css`，去掉英文标语和说明段落，桌面自动提供设备名。注册入口已接入账号中心 `/register/nexbot`，需要邀请码与邮箱验证码；注册实现位于 `nex_user` 项目。
- 退出确认在 `src/personal/auth.tsx` 中统一处理，用应用内 dialog 替代系统确认框；桌面退出和失效时直接返回独立登录页，避免先出现 Web 登录表单。

## 重新生成

在仓库根目录运行（需要准备好项目依赖和 Electron runtime）：

```sh
node scripts/build-personal.mjs --core
node scripts/smoke-personal-workspace.mjs
```

脚本仅运行隔离的测试数据，完成后截图输出到 `release/workspace-verification-avatars/`。
本目录保存 27 张有效参考图（其中包含打包客户端登录和注册空表单截图），不收录调试用的 `failure.png`。
刷新时按本索引的文件名复制，并先确认验收通过、截图无真实隐私信息。

本次脚本的 31 项验收通过，另有打包客户端的 25 项检查通过；这里提供页面及关键状态参考，不穷举所有弹窗和错误状态。

本机专用客户端支持输入 Base URL 和 API Key 后直接获取模型列表；正式后端尚未部署新模型列表接口，留空 Key 时本机版会提示填写。服务端代码支持同地址、同协议下复用已保存的 Key，不会把 Key 回传到客户端。
