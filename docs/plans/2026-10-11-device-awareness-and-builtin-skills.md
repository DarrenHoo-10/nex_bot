# 主设备识别、Windows computer use 与通用技能

Agent 是用户创建的长期联系人，不设默认 Agent，不按名字或职业选择实现。

## 设备事实与权限

主 Core 启动时自动注册自己的 Device Node，稳定 device_id 与设备令牌分别保存在 Core 表和加密 vault。登记只提供系统元信息，默认不授权文件目录、终端或屏幕。登录凭证不能代替设备令牌。原来已配置的外部 Node 连接保留，不擅自改绑。

`device.inventory` 在 Core 返回实时在线设备目录；`device.info(deviceId)` 经 DCP 获取目标节点实际 hostname、系统版本、架构、安装能力和本机授权。系统版本不等于硬件型号，未知型号不编造。主机与客户端分别标注，不把 Core 系统当成客户端系统。

目录区分 online、supported、granted。模型请求末端刷新目录和身份，历史中的「没有设备/不能操作」不能覆盖最新事实。目录不表示可读取任意文件。文件 path 相对用户在目标机器选择的目录，终端仍单独按 Agent 授权并逐次批准。

未编辑的标准策略通过 migration 7 增加设备信息、已授权读取、computer use 和技能入口；新 Agent 默认包含这些能力，但不默认允许 device.exec。已有终端权限保留。审计中出现用户策略修改的实例原样保留，需要用户在工具权限中自行启用新能力。

## Windows computer use

Windows x64 发行版随包提供 CUA Driver SDK 0.28.2、对应 native DLL/N-API 和开源声明，复用项目已有依赖，不依赖 Codex/ChatGPT 插件、额外安装的 CLI 或共享 daemon。运行在目标 Device Node，首次调用才初始化，退出时 orderly shutdown。

本机「屏幕控制」是独立权限。客户端在本机原生对话框授权，远程 Core 登录不能代替该授权。截图会进入用户配置的模型，需要支持图片的模型。不开启时 Agent 应说明已支持、在哪里启用，不能说此功能不存在。

Broker `device.computer(deviceId,operation,parameters)`：

- `tools` 返回实际 Native SDK schema。
- `list_apps/list_windows/get_window_state` 已获本机权限后自动执行。
- `bring_to_front/click/type_text/press_key/scroll/drag` 在实际执行 Agent 的联系人中逐次批准。

仅接受观察过的明确窗口 pid/window_id；观察两分钟有效，动作后必须重新观察。优先后台输入；只有执行器明确返回 background_unavailable，才允许重新观察并单独批准前台输入。不自动重试副作用。不接受全局桌面输入、任意 session/连接、截图文件输出、剪贴板、脚本、kill_app 或浏览器凭证接管。不能操作本进程及父 NexBot 进程窗口来批准自己或修改本机权限。

结果复用 DCP 原始 canonical envelope、调用摘要、本机策略版本、租约、持久日志、ack 和恢复协议。Native 输入中断/完成未知进入 unknown；目标设备人工核对前不会重放。改变本机授权使旧批准失效；单纯 Core 端口变化/同配置保存不改变权限版本。

截图以 Pi 工具 image content 发送给视觉模型，不塞进 JSON 文本，恢复投影也采用同一转换。限制窗口图像与可访问性树大小。图像只进入已有本地工具/Pi记录，不显式复制进长期记忆。

本次桌面 computer use 只交付 Windows。macOS/Linux 的系统识别、已有文件与终端通道保留；原生电脑操作另行接入各平台授权和执行器，不能由 Windows 验收推断。

## 内置技能

先内置五项第一方、通用、无脚本技能：设备识别、电脑窗口操作、记忆维护、同伴协作、定时汇报。`skill.list/skill.read(skillId)` 按当前 Agent 工具策略过滤，从固定随包文件读说明；skillId 不能成为任意路径。

技能是流程知识，不是权限。执行仍需 Broker、设备本机授权和危险动作审批。不开放第三方技能自动下载、脚本自动运行或默认联系人。后续可添加文件整理、网页资料收集、文档处理，前提是先完成真实执行工具和针对性验证。

## 验收

业务 fixture 覆盖默认无 Agent、主机元信息与重启稳定 ID、最小本机授权、用户策略不扩权、技能读取、截图图像送达模型、批准前不输入、拒绝不输入、修改授权使旧批准失效。

`scripts/smoke-personal-computer.mjs` 启动独立合成 Electron 窗口，原生发现该 HWND，截取该窗口，经真实 DCP/Pi 传给合成视觉接口，再逐次批准原生 Unicode 输入并读取合成文本框验证。拒绝后台输入后的前台操作另需观察与批准。所有数据和输入目标均为临时 fixture，不针对用户真实应用。

Windows 验收使用随包 Electron 的 Node 模式，与 Core EXE 的 DPI manifest 一致；不能以普通 node.exe 的虚拟化坐标冒充桌面环境。150% 缩放下另校验 PNG 实际尺寸与窗口物理边界，确认完整窗口而非局部截图。独立 Windows Node CLI 的原生屏幕操作不在这次交付的验收范围。
