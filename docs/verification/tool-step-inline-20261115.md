# 工具步骤就地展开:本地验证(2026-11-15)

## 行为

- 聊天里点击「N 项操作」中的某个操作(如「写入长期记忆」),不再打开右侧面板的
  「调用参数」原始 JSON,而是在该行下方就地展开,并按工具类型给出人读得懂的渲染:
  - `memory.write`:显示「记忆标题」与「写入内容」正文文本;成功时的
    `{saved:true,version:N}` 应答不再展示(状态点已表达成功)。
  - `memory.core.update`:patch 展开为「新增/更新/移除」逐行文本 + 用户原话。
  - `memory.search`:检索内容;`device.exec`:执行命令(等宽)+ 执行输出;
    `device.read`:读取路径;`image.generate`:生图提示词。
  - 其余工具:调用参数(格式化 JSON)+ 执行结果(优先取结果中的文本字段)。
  - 失败的调用始终展示结果文本,便于看到错误。
- 第二次点击同一行收起详情。`device.read` 有文件路径时仍打开右侧文件预览(非 JSON)。
- 例行任务/后台任务的「查看过程」步骤详情(`RunTranscript`)同样从底部 JSON 卡片
  改为行内展开,复用同一渲染组件 `ToolStepDetail`。
- 右侧面板仍保留给文件预览等场景;`device.read` 的文件预览行为不变。

## 验证

改动落在 `feat/tool-step-inline` 分支,基线为 origin/main(bf64179a,0.9.35 与
Gmail 目录修复之后)。全部验证均使用自有临时 Core 数据、合成身份/模型提供方与
隔离 Chromium/Electron 渲染进程;未使用用户线上应用、账号或生产数据。

- `pnpm exec vitest run src/personal/Routines.test.ts src/personal/AgentDesktop.input.test.ts`:
  36 项通过。新增用例:写入长期记忆的步骤点击后就地展开、显示记忆正文文本、
  不出现 `saved` 原始应答、不渲染 `.preview-card`、右侧面板保持关闭、再次点击收起。
  `src/personal/Routines.test.ts` 原断言(期待原始 JSON `"command":"test"`)更新为断言
  「执行命令/执行输出」文本渲染且不含原始 JSON。
- 新增 `node scripts/testing/smoke-personal-tool-steps.mjs`(一次性 fixture:
  vite/esbuild 构建 + 真实 Core + 隐藏 Electron 渲染进程 + 合成模型):
  真实聊天里模型调用 `memory.write` 并批准后,步骤行点击就地展开「写入内容」正文、
  无 `saved` 应答、无 `.preview-card`、再次点击收起、390px 无横向溢出,
  零渲染异常。证据:桌面与移动端截图 + result.json(`output/tool-step-inline-20261115/`)。
- `pnpm exec tsc -b` 与改动文件 oxlint `--deny-warnings` 通过。
- `scripts/testing/smoke-personal-routines.mjs` 中的工具详情段已同步改为行内展开
  断言;但该冒烟当前在干净 main 上即无法通过:main 首次启动会种子「金融助手」
  默认 Agent,而冒烟在创建第二个 Agent 后直接等待其 `.routine-summary`,
  UI 默认选中第一个 Agent,该等待超时(用临时探针核实:渲染进程已登录、
  工作区正常、侧栏显示「暂无定时任务」)。此失败先于本次改动、与本次无关,
  已用组件测试覆盖例行详情的行内展开行为。

## 范围与限制

- 这是本地分支改动,本次仅提交并推送代码,未部署 Core、未打安装包、未发版;
  Windows、Android 客户端共用该 Web 渲染器,但未做安装包与真机验证。
- Apple 等价实现尚未跟进:macOS/iOS 侧聊天工具行(ConversationView ToolSteps)
  点击后仍走 `AgentUI.preview` → `PreviewCard`(「调用参数」JSON 折叠块,
  InspectorMemoryTab.swift)。发版前需在同一任务内改齐并验证。
- 本次未推送此前会话在 `feat/fix-expand-operate-detail` 分支上积累的其他在途
  工作(快照提交 00b69385:发送队列、大屏伴生、形象资产、助手生命周期等),
  其中大部分与 main 已重合,其余与 main 的对应文件存在双向演化,需要单独
  一次合并裁决任务,不应随本任务直接落主分支。
