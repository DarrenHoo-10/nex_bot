# Chat charts — 2026-10-20

Messages support fenced `chart` blocks containing JSON data. The backend tells
every assistant how to emit them. The renderer supports grouped bar charts,
histograms computed from raw samples, line charts with null gaps, and pie charts.
Titles, axis labels and units are optional. Charts have mouse, touch and keyboard
value inspection and an expandable data table. Regular JSON/code fences remain
code. Invalid or streaming JSON has a bounded source fallback, never execution.

## Shared format

```chart
{"type":"bar","title":"示例数据 · 订单量","labels":["周一","周二","周三"],"series":[{"name":"本周","values":[12,18,15]},{"name":"上周","values":[10,14,13]}],"unit":"单"}
```

```chart
{"type":"histogram","title":"示例数据 · 响应时长","values":[0,1,2,3,4,5,6,7,8,9,10],"bins":5,"xLabel":"响应时长","unit":"秒"}
```

```chart
{"type":"line","title":"示例数据 · 收入","labels":["一月","二月","三月"],"series":[{"name":"收入","values":[200,null,480]}],"unit":"元"}
```

```chart
{"type":"pie","title":"示例数据 · 渠道占比","labels":["自然访问","社交媒体","推广"],"values":[50,30,20],"unit":"次"}
```

Limits: JSON source 200,000 characters; text 120 characters; six series and 200
categories (24 slices for pies); up to 10,000 raw histogram samples and 1–50
equal-width bins. Histogram intervals are left-closed/right-open except the last,
which includes the maximum. Constant samples get a nonzero surrounding interval.
Pie values must be nonnegative with positive total. Finite numbers only, magnitude
at most 1e12. Missing bar/line values use null. No callback/HTML/URL options exist.
The assistant must distinguish example data from verified statistics.

## Cross-platform implementation

`shared/chat-charts.ts` owns validation, bins, SVG, labels, table, CSS and event
handling. Web/Windows/Android use it through the React Markdown pre renderer.
Apple uses the same code bundled by `scripts/build-chat-charts.mjs` into the
NexMarkdown package's `Resources/chat-charts.js`. Regenerate this file after
renderer changes; `--check` detects stale resources. Core builds regenerate it.

Mac/iOS route actual chart fences (including mixed Markdown/HTML) through the
existing isolated WebKit view. Only the app-bundled renderer is evaluated in
`.defaultClient`; model strings are escaped or parsed with JSON.parse. Page JS,
network, file base URLs and navigation remain blocked. A height-only handler in
that isolated world accepts bounded numeric measurements to resize expanded data
tables. It has no application action/account/file capabilities and is removed at
teardown. Original SVG/script HTML remains disallowed by the HTML sanitizer.

## Verification

- Eight shared-renderer tests: negative/grouped bars, missing/zero/singleton line
  data, histogram boundaries/constants/10,000 samples, pie percentages/single
  slice, invalid/oversized input, escaping, every partial JSON prefix, and the
  Apple bundled renderer producing exactly the same output.
- Seven static HTML regression tests remain green.
- Isolated real Core + Electron fixture (`scripts/smoke-image-models.mjs`): all
  eleven workflows pass, including four chart types, actual model prompt delivery,
  hover and click values, histogram count sum, desktop/390px layouts and history
  reload. Screenshots: `release/image-models-verification/chart-*-{desktop,mobile}.png`.
- Frontend/server TypeScript, changed-module lint and Core/UI build passed.
- Swift 6.0.3 package tests in WSL: 21 passed, including chart routing, literal
  non-chart code, mixed/partial safe HTML, and resource inclusion.
- Android 0.2.6 (206) debug APK built, v2 signature and metadata verified; all five
  embedded UI files match the generated renderer. SHA-256:
  `550cd2055d6bb9c38b1fbacc5e8f528f644e00b515f347e2d68cfe49827bc7de`.

Mac/iOS still need Xcode compilation and WebKit UI acceptance on a Mac. WSL tests
do not prove native layout or WebKit callbacks. Android emulator acceptance and
preview publication were completed in the follow-up below; no physical-device
or app-store release was done. Native
acceptance should check all four charts, touch/keyboard inspection, expanding
data/height, dark mode, streaming, history, and rotation/window resizing against
an isolated fixture, without live user messages.

## Deployment

Deployment artifacts stay in ignored `release/deployment-charts/`. The candidate
inherits the active OSS release and changes only the UI and the chart-format
system prompt in the two Core bundles; reverse-transform checks prove no other
backend edits are included. A disposable Linux fixture exercises the candidate's
real worker, prompt delivery, persisted chart reply and authentication. Switching
requires no active tasks and retains a private server-side data/config backup
and the previous executable for rollback. No schema change is required.

Production is now `chat-charts-20261020`. Its Linux candidate fixture passed and
the service is active, OSS remains enabled, and every workspace remains on schema
21. The previous `oss-attachments-20261019` executable and private backup remain
available. The shared UI includes the prior inspector model-picker changes.

## Preview publication — 2026-10-20

Published `nexbot-v0.9.6-preview.1` with Android 0.2.6 and `SHA256SUMS.txt` only.
The exact APK was installed in a fresh read-only `nexbot-test` emulator instance
against a disposable Core, synthetic identity and fake model. Six checks passed:
login and four-chart delivery, each chart's viewport/tap/data-table behavior,
histogram sum, pie percentages, and history reload. The owned emulator and
fixture were stopped afterward. Evidence: `release/public-charts-20261020/`.

Package inventory and private environment-value scans passed. GitHub asset sizes
and SHA-256 digests match the verified local files. The published release is a
prerelease, not a draft; the live homepage download API returns Android 0.2.6 and
retains the existing Windows 0.9.4 download. Mac/iOS binaries were not published.
Only the APK and checksum were uploaded, not local source changes, credentials,
databases or fixture logs. Release notes explicitly distinguish this binary
distribution from GitHub's automatic source archive.
