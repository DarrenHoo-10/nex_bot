# Native Mac Markdown

The Mac conversation renderer uses `Packages/NexMarkdown`, pinned to
[`swift-cmark` 0.9.0](https://github.com/swiftlang/swift-cmark/tree/0.9.0).
It enables table, task-list, strikethrough and autolink extensions, matching the
web renderer's common GFM features. Nested lists and quotes retain their block
structure, and table cells retain inline formatting. Smart punctuation and
non-GFM table spanning are disabled.

`ChatMarkdownBlocks.swift` renders the resulting tree with native SwiftUI views:

- Tables use a horizontally scrolling Grid with a header, cell borders,
  wrapping text, and per-column left/center/right alignment.
- Tasks show read-only completion marks, including ordered and nested tasks.
  The marks do not edit the assistant's message, matching the web checkboxes.
- Strong/emphasis, strikethrough, inline code, safe links, reference links,
  headings, lists, quotes and fenced code retain their semantic formatting.
- HTML now uses the [shared static HTML renderer](static-html.md). Code examples
  remain literal. Native Markdown link activation retains the existing `Markdown.isOpenable`
  policy. Only recognized inline file paths produce internal preview links.
  Existing attachment rendering/authorization remains outside this parser.

The adapter also corrects cmark's missed task markers behind quote prefixes.
It checks original source bytes at the first paragraph's source position, so
escaped markers and inline code cannot turn into checkboxes.

## Checks performed (2026-10-20)

```sh
swift test --package-path apps/apple/Packages/NexMarkdown
```

11 tests passed using Swift 6.0.3 in an isolated WSL/Linux fixture. Git transport
was unavailable, so that fixture substituted a local dependency path containing
the unmodified official `swift-cmark` 0.9.0 archive. The checked-in package still
uses the pinned official dependency URL. All production parser sources and test
sources were copied unchanged into the fixture. Logs and the fixture runner are
under ignored `release/markdown-fixture/`.

Coverage: aligned tables, escaped pipes, optional outer pipes, ragged rows,
header-only/500-row tables, inline formatting, task states, ordered/nested/quoted
tasks, continuation paragraphs, code fences, malformed/streaming input,
autolinks/reference links, strikethrough, hard/soft breaks, escaped text and HTML.
The two changed SwiftUI files also passed Swift syntax parsing. These checks do
not type-check SwiftUI or prove native layout.

## Required Mac acceptance

Regenerate the Xcode project (`apps/apple/scripts/generate.sh`) so it includes
the new local package, then build NexBotMac using the commands in
`apps/apple/README.md`. No Mac build or installation package has been produced
for this change from the Windows host.

Use the [isolated native client fixture](native-clients.md), never live account
messages. Script a model reply with the sample below, then send a fixture message.
Check both the streaming and committed versions; repeat after narrowing the
window and in dark mode. The table should scroll within the transcript, task
marks should stay read-only, and nested content/column alignment must remain
readable. Confirm text selection/copy, safe links and existing inline file previews.

```markdown
## 发布计划

| 内容 | 状态 | 数量 |
| :--- | :---: | ---: |
| **桌面版** | ~~旧~~ `新` | 12 |
| 含有竖线 a\|b | 待处理 | 3 |

- [x] 表格与列对齐
- [ ] 验收
  - [x] 单元格格式
  - [ ] 窄窗口与深色模式

> - [x] 引用中的任务
> - [ ] 另一个任务

3. [x] 第三步
4. [ ] 第四步

[链接](https://example.com) 与 https://example.com
```

This is common Markdown/GFM feature parity, not a claim of pixel-identical web
and native typography or complete parity for every optional Markdown extension.
