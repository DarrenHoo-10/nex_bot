# Static HTML messages — 2026-10-20

## Scope

The current browser/Windows workspace and Android's bundled workspace share
`src/personal/AgentDesktop.tsx`. Raw HTML now goes through `rehype-raw` followed
by `static-html.ts` before React renders it. Mac and iOS use the same
`NexMarkdown/StaticHTML.swift` policy and `Shared/StaticHTMLMessage.swift` view.
Only real HTML nodes select the native HTML view; fenced and inline code stay
code. CommonMark/GFM is rendered first, so HTML and Markdown can be mixed.

Supported static elements include paragraphs/divisions, headings, breaks,
emphasis, inline code, quotes, lists, definition lists, tables/captions/cells
(including bounded row/column spans), and HTTP(S) links. Inline styles allow
color/background-color, text alignment, font weight/style, text decoration,
10–32 px font sizes, whitespace and border collapsing. Unknown layout CSS,
stylesheet tags, classes/IDs and event attributes are removed. Task checkboxes
are read-only. No arbitrary HTML stylesheet or application embedding is supported.

Scripts, forms, frames, SVG/MathML, objects, media and resource-loading tags
are removed with their subtrees. CSS URLs and positioning are not allowed.
External images become alt text; the web renderer preserves only authenticated
`/api/attachments/<id>` images. Native attachment downloads/previews remain in
the existing attachment UI, outside the isolated HTML view.

Mac/iOS use a transient WKWebView with content JavaScript disabled, no app bridge,
no file base URL, and a CSP denying scripts/network/images/frames/forms. Only
the app's initial HTML document may navigate there. User-clicked safe HTTP(S)
links go through the existing external URL handler. App-owned sizing runs in
WebKit's isolated client content world; width changes remeasure the document.
Height is capped at 8192 points, with WebKit scrolling retained for taller content.

## Verified

- `pnpm exec vitest run src/personal/static-html.test.ts src/personal/android-bridge.test.ts`:
  11 passed, including mixed HTML/Markdown, tables/spans, tasks, literal code,
  incomplete streams, event/script/resource filtering and URL/CSS allowlists.
- `pnpm exec tsc --noEmit -p tsconfig.json`: passed.
- `pnpm build:core`: passed.
- `node scripts/smoke-image-models.mjs`: 10 workflows passed in an owned temporary
  Core + hidden Electron fixture with synthetic identity/model/image providers.
  The HTML workflow checked real DOM/table content, computed text color,
  filtering of active content, no attempted probe requests, and desktop/mobile
  layout. Screenshots were inspected and the checkbox/link styles corrected.
  One preceding run failed model discovery before HTML checks; the clean retry
  passed. No live messages/accounts were used.
- Native package: 18 tests passed with Swift 6.0.3 in WSL, using unmodified official
  archives of `swift-cmark` 0.9.0 and SwiftSoup 2.14.3 as local fixture dependencies.
  The repository manifests pin those exact official versions. Swift syntax
  parsing also passed for the changed SwiftUI/WebKit sources.
- Android `:app:assembleDebug`: passed using the documented Java Unix-domain
  socket workaround. APK v2 signature verified; package/version metadata verified;
  all five bundled renderer assets match the just-built files byte for byte.

Android artifact: `android/app/build/outputs/apk/debug/nexbot-0.2.5-debug.apk`,
12,387,771 bytes; SHA-256
`3a9ba2e51a2839ae7e66b2e22faec137ef996d6aa3858905b69423b65665b261`.
It remains a local debug-signed test package, not a published store/GitHub release.

## Deployment and remaining native acceptance

The web UI was deployed atomically to the active OSS-enabled Core release.
Existing assets remain available and the prior HTML entry was backed up. HTTPS
HTML/JS/CSS/mark bytes match the local build; health is 200 and authenticated
APIs still reject anonymous calls with 401. No Core restart, data migration or
user-message mutation was needed. Windows clients receive the UI from Core;
Android requires installing the new APK because its renderer is bundled.

Evidence is under ignored `release/deployment-static-html/`,
`release/markdown-fixture/html-result.log` and
`release/image-models-verification/static-html-{desktop,mobile}.png`.

Mac/iOS builds and WebKit UI acceptance remain pending on a Mac. Regenerate the
Xcode project to include NexMarkdown in both targets. Use the
[isolated native client fixture](native-clients.md) to verify inline/block HTML,
long tables, width/dark-mode changes, streaming height updates, link opening and
copying. Verify blocked content makes no requests and no script executes. Native
package tests and Swift syntax checks do not prove WebKit sizing or Xcode builds.
This run did not install or exercise the Android APK on a device/emulator.
