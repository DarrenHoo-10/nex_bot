# html.render 预览卡拓宽与全屏弹窗:本地验证(2026-11-15)

## 行为

- 会话里出现 `html.render` 预览时,整条会话列按聊天区宽度比例加宽
  (`max-width: min(1200px, 100%)`),所有消息(气泡、步骤、预览卡)共享同一左缘;
  预览卡充满加宽后的列,右缘与列右缘对齐。
- 纯预览消息(整条消息只有一个交互内容,html.render 发布的正是这种)去掉气泡
  外壳;混排消息与用户消息保持原气泡样式。
- 窄视口或右侧面板展开导致列宽不足时,iframe 保持 900px 可用下限,
  预览卡内部横向滚动(`overflow-x: auto`),页面本身不产生横向滚动条。
- **工具条精简**:移除「停止」「重新运行」按钮与「预览」标题,只保留状态
  (生成中/加载超时/运行出错/内容过大,正常运行时为空)和「全屏」。
- **全屏改为有界弹窗**:点「全屏」在 body 上弹出居中模态
  (`min(1200px, 100%) × min(780px, 100%)`,深色遮罩),标题行带状态与「关闭」
  按钮,Esc 与 Android 返回键均可关闭;弹窗内是同一源码的独立沙箱实例
  (新运行时),关闭后回到内联实例、其状态保留。600px 以下弹窗占满视口。
- 组件重写:`PreviewFrame` 子组件各持独立消息通道与 uuid;全屏弹窗经
  `createPortal(document.body)` 渲染。

## 验证

改动:`src/personal/components/HtmlPreview.tsx`(重写)、`html-preview.css`、
`src/personal/glass.css`、`AgentDesktop.tsx`(Android 返回级联的选择器指向新弹窗)、
`smoke-personal-tool-steps.mjs`、`html-preview-electron.cjs`、
`smoke-android-html-preview.mjs`、`smoke-html-preview.mjs`。
分支 `feat/html-preview-width`,基线 origin/main 357f930b,最终随部署提交
`169e5021` 推入 main(合并树上的冒烟与钩子检查均已复跑)。

- `pnpm exec vitest run src/personal/AgentDesktop.input.test.ts src/personal/Routines.test.ts`:
  36 项通过;`pnpm exec tsc -b` 与改动文件 oxlint 通过。
- `node scripts/testing/smoke-personal-tool-steps.mjs`(真实 Core + 隐藏 Electron
  渲染进程):4 组全过、零异常——含列宽比例加宽、左缘与胶囊对齐(误差 < 3px)、
  工具条只剩「全屏」、弹窗有界(宽高均小于视口)且可关闭、移动端 iframe ≥ 900px
  且卡内横向滚动、页面无横向滚动;证据
  `output/tool-step-inline-20261115/html-preview-{dialog,wide-desktop,wide-mobile}.png`。
- `node scripts/smoke-html-preview.mjs`:14 组全过——含新弹窗用例
  (弹窗开启后出现第二个独立沙箱帧且内联帧存活、点「关闭」回到内联且状态保留)、
  沙箱隔离、网络/弹窗/自导航拦截、伪造消息忽略、390px 布局、漏斗渲染。
  该冒烟此前在干净 main 上即失败:形象功能引入的 `local-preview.ts` 在 IIFE
  fixture 构建里读 `import.meta.env` 导致页面启动崩溃(暂存本次改动复跑确认与
  本次无关);已在 `smoke-html-preview.mjs` 的 esbuild define 中补
  `import.meta.env: {}` 修复。
- **Android 冒烟未运行**:`smoke-android-html-preview.mjs` 需要模拟器/真机,
  本机没有可用设备;脚本已按新交互更新(弹窗断言、返回键经
  `nex-android-back` 级联点击「关闭全屏预览」),待有设备时验证。

## 部署证据

- 部署提交 `169e50218f291e0a84ebc6d9d525ff9e7b4d4af2`(分支
  `feat/html-preview-width`,合并 origin/main 后推送;推送前 origin/main 移动
  数次均已合并:连接器默认开放、GitHub 设备码流修复、连接流程重部署)。生产
  release `main-169e5021-20261115` 部署到 Mac Air(launchd
  `gui/501/cn.nexorai.nexbot-core`)。
- 暂存:复制运行中 release 后替换 `core/`、`ui/`,覆写 `package.json` 与
  `SOURCE_COMMIT`;`core/`(47 文件)与 `ui/`(29 文件)的 SHA-256 清单与本地
  构建逐字节一致(Windows sha256sum 与 macOS shasum 的 `*` 标记差异已归一化)。
  `node_modules` 复用(依赖无变化)。一次性 Core(独立数据目录、8801 端口)
  `/health` 200、未授权 POST 401。
- 数据:切换前活跃任务 0;sqlite3 backup API 备份 core.db/runtime.db,
  account-workspaces、runtime-env.json、run-core.py 存于
  `~/nexbot/backups/main-169e5021-20261115-pre/`;切换前后
  bots=8 / conversations=54 / transcript=202 / todos=3 完全一致;launcher
  `run-core.py` 指向本 release。
- 公网验证(https://bot.nexorai.com.cn):`/health` 200,未授权 POST 401,
  首页 HTML 与引用的全部资产(nexbot-mark svg、personal CSS、personal JS)
  与本地构建逐字节一致。
- Apple 等价验证(Mac,GitHub 全新 clone `169e5021`,LF 检出):
  `corepack pnpm install --frozen-lockfile` + `build-nexbot-icons.mjs` 通过;
  NexClientKit **254 项测试 0 失败**;`NexBotMac` Debug **BUILD SUCCEEDED**;
  `NexBotiOS` Debug 在专用模拟器(创建后已删除)**BUILD SUCCEEDED**。
- Android 冒烟 `smoke-android-html-preview.mjs` 需要模拟器,本机无设备,
  脚本已按新交互更新但未运行;Android/Windows 安装包本次未重打包
  (沿用最近已验证版本,Web 端即时生效,客户端随下次发版携带)。

## 范围与限制

- 本次部署仅覆盖 Core 与 Web UI;未重打 Windows/Android/Mac/iOS 安装包,
  未发布 GitHub release/OSS 更新(平台保留最近已验证版本)。
- `:has()` 选择器需要 Chromium 105+/Safari 15.4+,现有客户端均满足。
- 1200px 列宽上限、900px iframe 下限、1200×780 弹窗尺寸为当前取值,可按需调整。

