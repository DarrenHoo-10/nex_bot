# NexBot UI 截图参考

更新：2026-10-17。供 Mac agent 对照当前 Windows 上的真实渲染效果。

所有截图来自独立演示环境：演示账号、演示设备、合成聊天、本机模型与 MCP 服务。
不包含真实账号、密码、API Key 或正式服务数据。页面中的 localhost 地址、模型名、时间和数量仅为演示值，请勿写死到产品中。

## 页面索引

桌面默认尺寸为 **1440 × 960**。截图是当前工作区代码的界面，不代表已发布到正式服务。

| 页面 / 状态 | 截图 | 入口或说明 |
| --- | --- | --- |
| 登录 | [login-light.png](login-light.png) | Web 登录页；桌面壳的连接设置页不同 |
| 聊天与右侧工作详情 | [workspace-light.png](workspace-light.png) | 点击联系人，展开助手详情 → 工作 |
| 聊天深色模式 | [workspace-dark.png](workspace-dark.png) | 账号菜单 → 切换深色模式 |
| 超宽聊天 | [workspace-wide.png](workspace-wide.png) | 2560 × 1440；阅读列保持限宽 |
| 右侧资料 | [inspector-memory-light.png](inspector-memory-light.png) | 助手详情 → 资料；记忆与工作记录 |
| 右侧助手设置 | [inspector-settings-light.png](inspector-settings-light.png) | 助手详情 → 设置；区别于全局设置 |
| 账号菜单 | [account-menu-light.png](account-menu-light.png) | 左下头像或账号；连接器、设备、设置与退出 |
| 助手形象选择 | [avatar-picker.png](avatar-picker.png) | 更换头像；形状、颜色和状态预览 |
| 经典头像图库 | [avatar-collection.png](avatar-collection.png) | 1200 × 1160；20 张经典头像的独立总览，并非产品页面 |
| MCP 连接器 | [connectors-light.png](connectors-light.png) | 账号菜单 → 连接器；工具与 Agent 授权 |
| 添加连接器 | [connector-add-light.png](connector-add-light.png) | 连接器 → 添加连接器 |
| 连接器工具授权 | [connector-grant-light.png](connector-grant-light.png) | 连接器详情 → Agent 授权编辑 |
| 工具调用审批 | [connector-approval.png](connector-approval.png) | 聊天中真实演示工具调用产生的审批 |
| 连接器空状态 | [connectors-empty-light.png](connectors-empty-light.png) | 未添加连接器时 |
| 设备网络 | [devices-light.png](devices-light.png) | 账号菜单 → 设备；此图为带后端主机的演示模式 |
| 设置：账号与登录设备 | [settings-account-light.png](settings-account-light.png) | 账号菜单 → 设置，默认分类 |
| 设置：模型 | [settings-model-light.png](settings-model-light.png) | 设置 → 模型；截图含保存成功反馈 |
| 设置：记忆服务 | [settings-memory-light.png](settings-memory-light.png) | 设置 → 记忆服务 |
| 设置：系统信息 | [settings-system-light.png](settings-system-light.png) | 设置 → 系统信息 |
| 设置：记忆服务（深色） | [settings-memory-dark.png](settings-memory-dark.png) | 深色模式对照 |

## 窄屏参考

以下尺寸均为 **390 × 844**，是同一 Web UI 的响应式视口截图，不是原生 Android/iOS 页面。
需要滚动的页面只截取首屏。

| 页面 / 状态 | 截图 |
| --- | --- |
| 聊天（深色） | [workspace-mobile.png](workspace-mobile.png) |
| 账号抽屉菜单（深色） | [account-menu-mobile-dark.png](account-menu-mobile-dark.png) |
| 连接器（深色） | [connectors-mobile.png](connectors-mobile.png) |
| 设置分类与模型表单（深色） | [settings-mobile-dark.png](settings-mobile-dark.png) |

## 给 Mac agent 的实现说明

- **本轮完成的是全局设置分类重构。** 四个分类一次只显示一个，切换时保留未保存的表单内容。高级请求地址与诊断信息默认折叠。
- 全局设置以 `src/personal/panels.tsx`、`src/personal/auth.tsx` 和 `src/personal/settings.css` 为准；入口在 `src/personal/components/ContactSidebar.tsx`。
- 聊天和右侧详情在 `src/personal/AgentDesktop.tsx`；公共布局在 `workspace.css`、`identity.css`；连接器在 `ConnectorsPage.tsx`。
- **设备网络页仍保留原来的大卡片样式**，这里记录当前实现，不表示它已完成同样的设置样式重构。多账号正式服务的设备页可能不显示后端主机能力。
- 蓝色应用图标使用 `src/personal/assets/nexbot-mark.svg`；角色头像可选多种颜色，截图中的青色或紫色角色不是应用强调色。
- 头像选择器的状态按钮用于预览。聊天中的思考、执行、待确认和完成表情由真实任务状态驱动；静态截图不能证明动效，应结合演示验收脚本。
- Mac 端沿用同一 Web UI；原生标题栏、字体渲染、系统权限和桌面连接页需在 macOS 单独验收。不要据此复制 Windows 系统装饰。

## 重新生成

在仓库根目录运行（需要准备好项目依赖和 Electron runtime）：

```sh
node scripts/build-personal.mjs --core
node scripts/smoke-personal-workspace.mjs
```

脚本仅运行隔离的测试数据，完成后截图输出到 `release/workspace-verification-avatars/`。
本目录保存其中 24 张有效参考图，不收录调试用的 `failure.png`。
刷新时按本索引的文件名复制，并先确认验收通过、截图无真实隐私信息。

本次脚本的 23 项验收通过；这里提供页面及关键状态参考，不穷举所有弹窗和错误状态。
