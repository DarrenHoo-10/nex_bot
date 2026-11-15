# html.render 预览卡拓宽:本地验证(2026-11-15)

## 行为

- `html.render` 发布的纯预览消息(整条消息只有一个交互内容)去掉气泡外壳,
  预览卡横向突破 700px 文字列,居中铺到 `min(1040px, 视口-480px)`;
  右侧资料面板展开时改为 `视口-880px`,任何宽度下都不产生横向滚动。
  移动端(390px)回落到列内全宽,与原有表现一致。
- 混排消息(文字 + 预览)与用户消息保持原气泡样式,不受影响。

## 验证

改动为 `src/personal/glass.css` 纯 CSS(`:has(.markdown > .html-preview:only-child)` 作用域),
落在 `feat/html-preview-width` 分支(基线 origin/main 348a0dbf)。

- 扩展 `scripts/testing/smoke-personal-tool-steps.mjs`:真实 Core + 隐藏 Electron
  渲染进程 + 合成模型,真实聊天里 `html.render` 发布看板消息——
  桌面(1440,右面板收起)预览卡 offsetWidth ≥ 900(实测 ~960)、
  所在气泡 padding 0、无横向滚动;移动端(390)卡宽 ≤ 视口、无横向滚动。
  4 组用例全过、零渲染异常;证据截图
  `output/tool-step-inline-20261115/html-preview-wide-{desktop,mobile}.png`。
- `pnpm lint`、`pnpm typecheck`、`pnpm i18n:check` 通过(pre-push 钩子三项)。
- 组件测试无需变更:渲染路径(RichText → HtmlPreview)未改,仅样式。

## 范围与限制

- 本次仅提交推送源码,未部署 Core、未打安装包、未发版;Web/Windows/Android
  共用该样式,安装包与真机未验证。
- macOS/iOS 原生会话页不是该 CSS 的作用面;原生端的等价宽度表现未在本次处理。
- `:has()` 选择器需要 Chromium 105+/Safari 15.4+,现有客户端均满足。
