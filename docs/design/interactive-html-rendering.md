# 通用 HTML 交互渲染能力

## 决策与范围

只实现客户端的原子渲染能力。不修改系统提示词、模型请求、Agent 工具、业务协议或数据库。经分报表只是可能的内容之一；宿主不认识指标、渠道、漏斗和筛选条件。

同一个入口接收 HTML 字符串，运行 HTML/CSS/JavaScript、DOM、SVG 和 Canvas。布局和交互全部由内容决定。当前模型不会因本次改动自动获知格式；本文件中的格式说明面向开发和验收，不注入任何提示词。

## 输出契约

使用顶层、明确闭合的 `html-preview` Markdown 围栏（反引号或波浪号，至少三个）。围栏内是自包含的 HTML。普通 `html` 代码块继续显示源码；已有静态 HTML 清洗和 chart 渲染保持兼容。引用、列表、外层代码示例中的围栏不执行。

只有完整回复且围栏闭合后才挂载。流式快照、未闭合片段仅显示状态和源码。多个内容块相互独立。现有消息保存源内容，重开历史从源内容重新执行，不同步页面内存状态。单块上限 500,000 个 UTF-16 单元；内嵌高度 160–900 像素，超出内部滚动。

示例（外层使用四个反引号仅用于展示协议）：

````markdown
```html-preview
<label>数量 <input id="quantity" type="range" min="1" max="100" value="20"></label>
<output id="result"></output>
<script>
const input = document.querySelector('#quantity');
const result = document.querySelector('#result');
input.oninput = () => result.textContent = input.value;
input.oninput();
</script>
```
````

## 通用容器

工具栏只提供预览状态、停止、重新运行、全屏，源码放在折叠区域。内容里的筛选、绘图和联动不经过宿主接口。全屏复用同一个运行实例；重新运行和修改源码才重置。切换会话或退出登录随消息销毁实例。页面脚本报错或加载超时给出简短状态，不影响其他消息。

Web 全屏改变当前容器的布局，不移动 iframe。Apple 全屏移动同一个 WKWebView 到展示容器，不重新加载页面。

## 隔离架构

应用 → 可信外层预览页 → 无同源权限的脚本 iframe。

可信外层只接收父窗口初始化，并只转发对应子窗口的 ready、error、escape 和限幅尺寸。宿主再次检查具体窗口和运行 ID；来源为 null 不作为信任依据。模型源码始终作为字符串传递，不拼接为宿主执行代码。

外层 CSP 的 frame-src 仅允许 data:，约束内容页面自身导航；再次加载时销毁内容框架并显示错误。内容首先加载更严格 CSP，拒绝网络资源、连接、表单提交、子框架、插件和 base URL。iframe 仅允许 scripts，不开放 same-origin、popup、下载或顶层导航。内容只使用内联脚本/样式和自带资源，不加载 CDN。应用主页面仍禁止内联脚本。

沙箱和 CSP 不是操作系统级断网，也没有 CPU/内存硬配额；不能承诺任意恶意脚本绝无网络旁路，或浏览器中死循环必定可由“停止”终止。测试覆盖指定的网络与导航路径，不代表对浏览器所有能力的安全证明。任意脚本也不等于业务正确性验证。首版不提供数据源、文件、账号、工具或业务事件桥。

## 各端接入

| 平台 | 接入路径 |
| --- | --- |
| Web | RichText 拆分明确内容块；Core 提供无用户数据的 /html-preview.html |
| Windows | 复用 Core UI 和相同 iframe；本地 UI 包含预览运行页，可独立于后端上线；保留 Electron 主框架 IPC 校验 |
| Android | 打包同一预览页和 React 组件；原全框架 JavascriptInterface 改为只投递至准确主框架 origin 的 MessagePort |
| macOS | CommonMark 识别同一格式；共享 HTMLPreviewMessage，独立非持久化 WKWebView |
| iOS | 同一解析器和共享 WebKit 组件，适配触控和全屏 |

Apple 只在隔离内容世界提供受限生命周期消息处理器；原生导航代理和内容规则额外拒绝网络导航/资源。不提供文件 base URL、账号存储或业务原生接口。静态 HTML 的 WebKit 配置不启用页面脚本。

共享运行内核位于 shared/html-preview-shell.mjs。构建脚本生成 Apple 资源，并将相同文件放进 Android 资产和客户端 UI，--check 检测资源漂移。Web 通过 Core 提供该内核；Windows 本地 UI 优先使用打包文件，没有本地 UI 时仍由 Core 提供。

## 验证与交付

遵守 docs/verification/README.md，全部使用独立临时目录、合成内容、假账号和本地端口。

1. 解析：不同围栏、每个流式前缀、未闭合和嵌套示例、原始 HTML 伪装、多块混合。
2. 真实浏览器：滑杆、DOM、SVG/Canvas、多实例隔离、全屏保留状态、重置、停止、错误、历史重新加载、390px 窄屏。
3. 隔离：父 DOM、宿主 bridge、存储、fetch、图片、表单、弹窗、自身/顶层导航、伪造和异常尺寸消息。
4. Android：桥传输回归、编译及独立模拟器验收。
5. Apple：Swift 包测试及 macOS/iOS 共用的 WebKit fixture；在 Windows 上不能把 Swift 语法检查当作 Xcode 编译或原生 UI 验收。

实现、本地部署与验证记录另存 docs/verification/html-preview.md。开发位于 codex/html-rendering worktree，线上发布必须先合并并推送 main，再从该提交构建。
