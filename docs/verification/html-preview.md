# Interactive HTML rendering verification

Recorded 2026-10-24 for `codex/html-rendering`, based on `62642521`.
Scope and format are in the [design](../design/interactive-html-rendering.md).
The implementation adds the same explicit `html-preview` message block to Web,
Windows, Android, macOS and iOS. It changes no system prompt, model request,
Agent tool or database schema. The model is not automatically taught this format.

All runtime checks used owned temporary data, synthetic identities and local
fixtures. No live account, production service or published client was changed.
The APK was a local debug build. No release was built or deployed from this branch.

## Results

| Check | Result | Evidence / boundary |
| --- | --- | --- |
| TypeScript frontend and server | Pass | `tsc -b` and `tsc -p tsconfig.server.json` |
| Changed JavaScript/TypeScript modules | Pass | `oxlint --deny-warnings`, generated shell drift check, `git diff --check` |
| Parser, React streaming guard, Android bridge, static HTML and chart regression | 25 tests passed | Four Vitest files listed below |
| Core/UI build | Pass | Local `build-personal.mjs --core`; existing bundle-size warning remains |
| Web/Windows Chromium runtime | 15 cases passed | Real Core headers, real RichText/HtmlPreview, isolated Electron window |
| Android compile and unit/UI component suites | 26 tests passed | `assembleDebug` and `testDebugUnitTest` |
| Android actual WebView | 10 cases passed | Debug APK installed in an owned API 36 emulator; authenticated native port and persisted synthetic reply |
| Shared Swift Markdown package | 24 tests passed | Swift 6.0.3 on Linux, isolated package copy and locally resolved pinned dependencies |
| Modified Swift source syntax | Pass | Swift frontend parsing only; not an Apple SDK typecheck |
| macOS/iOS native build and WebKit runtime | Not run | Windows host has no Xcode; fixture is included for both targets |

The browser report is `release/html-preview/report.json`. Desktop and 390px
screenshots were inspected. Android's report is
`release/html-preview/android/report.json`; its ATD emulator returned black
screen captures, so these captures do **not** establish Android pixel-level
visual acceptance. Android interaction and layout assertions did run in its real
WebView through CDP. Reports/build output are local, ignored artifacts.

## Browser and shared checks

```sh
pnpm exec tsc -b
pnpm exec tsc -p tsconfig.server.json
pnpm exec vitest run shared/html-preview.test.ts src/personal/android-bridge.test.ts src/personal/static-html.test.ts shared/chat-charts.test.ts
node scripts/build-html-preview.mjs --check
node scripts/build-personal.mjs --core
node scripts/smoke-html-preview.mjs --electron=/absolute/path/to/staged/electron.exe
```

The Electron smoke creates a temporary Core and renderer with synthetic content,
then removes its owned profile/data. It verifies:

- Completed fences wait for the final reply; incomplete fences never execute.
- Input changes DOM/SVG/Canvas output, without host application calls.
- Fullscreen and ordinary transcript refresh keep the same runtime/state.
- Rerun resets state; Stop destroys the frame; instances are independent.
- Parent DOM, storage and native bridge access fail; RTC constructors are absent.
- Fetch, image, popup and self-navigation probes produce no fixture leak request.
- Forged host messages are ignored, script errors are visible, and ordinary HTML
  code or forged raw markup cannot opt into script execution.
- Narrow-screen geometry and history-source reloading work.

The shell route is public, constant and contains no model/user data. Windows'
optional local UI override forwards this route to Core. The application CSP
continues to forbid inline script; only the separate sandbox shell permits it.
These checks do not establish OS-level network isolation or CPU/memory quotas.

## Android reproduction

Build in `android/` with a configured JDK and Android SDK:

```sh
./gradlew --no-daemon :app:assembleDebug :app:testDebugUnitTest
```

On the verification Windows host, the JDK's Unix-domain socket setup failed.
A process-local `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=<nonexistent-directory>`
made the JDK use its TCP fallback. No machine-wide JDK or Gradle settings changed.

Start a disposable backend from the repository root:

```sh
node --experimental-transform-types --no-warnings scripts/fixture-html-preview-android.mjs
```

Use a fresh owned emulator, install only the debug APK, and reverse the printed
Core port with `adb -s <owned-emulator> reverse tcp:<port> tcp:<port>`. Log in at
that loopback origin as `owner@example.test`, password ` synthetic password `
(the spaces are intentional). This identity exists only in the local fake.
Open the synthetic `交互示例` agent. Forward the owned app's
`webview_devtools_remote_<pid>` socket to a local port, then run:

```sh
node scripts/smoke-android-html-preview.mjs release/html-preview/android 9229 --adb=/absolute/path/to/adb --serial=emulator-5588
```

The 10 cases cover authenticated main-frame MessagePort transport, the saved
model reply, slider/SVG interaction, fullscreen state and width, Android Back,
content isolation, rerun, runtime error, Stop, and reload/history/bridge recovery.
The existing bridge unit tests also cover HTTP, SSE, files and forged port events.
The APK no longer exposes an `addJavascriptInterface` object to every frame.
Its request interceptor leaves inline `data:` documents to WebView; intercepting
those documents as remote requests previously produced an empty preview.

Stop the fixture with Ctrl-C or its output directory's `stop` file. It removes
only its generated temporary Core directory. Remove the owned adb forwards and
stop the owned emulator. Delete the previous `stop` file before a later run.
The generated `fixture.json` contains a short-lived synthetic token and must stay
in ignored test output.

## Apple checks and remaining acceptance

The NexMarkdown package tests cover explicit and nested fences, partial content,
CRLF and the bundled shell, together with existing static HTML/chart regression.
The Linux run used an isolated copy to point package dependencies at local
checkouts; repository dependency manifests were not rewritten for the host.

`apps/apple/Testing/HTMLPreviewRenderingTests.swift` runs the production
HTMLPreviewModel in a nonpersistent WKWebView. It checks DOM/Canvas, host bridge
and storage isolation, bounded height messages, retained runtime, Stop/rerun,
errors and incomplete content. It is included in both fixture targets but has
not been executed on this host.

On an Apple development machine, generate the fixture and run it in an owned
test environment, then build both full app targets:

```sh
xcodegen generate --spec apps/apple/Testing/project.yml --project apps/apple/Testing
xcodebuild -project apps/apple/Testing/NexRenderFixture.xcodeproj -scheme RenderMac -destination 'platform=macOS' test
xcodebuild -project apps/apple/Testing/NexRenderFixture.xcodeproj -scheme RenderiOS -destination 'platform=iOS Simulator,id=<owned-simulator-id>' test
```

Native fullscreen presentation, SwiftUI disposal during navigation and visual
acceptance on macOS/iOS remain unverified until that run. Syntax parsing and
Linux package tests must not be reported as an Xcode build or native UI pass.
