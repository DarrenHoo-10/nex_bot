# Composer / model chooser / message interactions

Verification date: 2026-10-20. Worktree branch:
`fix/composer-image-ime-model-copy`.

The branch already existed at the start, with a clean worktree and the same
commit as `main`: `96636897783fc031ed0f1300df8c8773de083271`.
No live service, account, conversation or user profile was used.

## Client audit

| Client | Changes and existing behavior retained |
| --- | --- |
| Web, legacy renderer | Removed model image-capability gates from selection, paste, send and failed-send retry. Image controls are always enabled. Removed the obsolete translated rejection message. Composer and inline message-edit resends guard IME confirmation and the first 150 ms after composition. Shift+Enter remains a newline. Message action trays stay expanded across the parent message and toolbar and delay closing. Group messages already keep their action buttons within the hovered message parent. Plain and Markdown message bodies explicitly allow text selection. |
| Web, Personal renderer | Exported and reused the existing `ModelSettings` form in the no-model notice; the button toggles it without navigating or losing the draft. The existing per-agent `bots/model` selector is unchanged. Added the same IME guard. Toolbars delay fading, stay visible while the message/controls are hovered or focused, and remain visible on touch devices. Message Markdown explicitly permits selection. This renderer already accepted images without inspecting model capabilities. No global CSS prohibition on selecting its message body was found; the added styles make that behavior explicit. |
| Electron | Both renderers above are shared with Electron. `electron/client` is a connection screen; no separate conversation composer/list required changes. |
| Native macOS | Replaced the composer key interception with an AppKit text editor that lets marked text reach the input method, timestamps composition commit and guards Enter for 150 ms. Retained mentions, focus, Shift+Enter and explicit send controls. Reused `SettingsModelPane` in the conversation's model notice. Added a contiguous rectangular hover region and cancellable 200 ms hiding delay around message plus actions. Image attachments already have no model capability gate; Markdown already enables native text selection. |
| Native iOS | Reused `SettingsModelView` and its form state inline in the conversation's no-model banner. The multiline composer has no Return-to-send handler, so IME Return cannot submit. Images already have no model-capability gate. Quote/Copy use a persistent context menu, not a hover toolbar. Message Markdown already enables text selection. |
| Android | Current `NexBotRoot` opens `WorkspaceScreen`, whose WebView bundles the shared Personal renderer: it receives all shared fixes. The retained independent Kotlin chat screen now keeps `TextFieldValue` composition state and guards `ImeAction.Send` for 150 ms after commit; multiline hardware Shift+Enter remains native. Its message bodies lacked selection containers: both user text and Markdown now use `SelectionContainer`, preserving link callbacks. Quote/Copy are already persistent buttons. The Kotlin screen has no independent model-configuration navigation and no image-capability gate. |
| companion / enterprise | Inspected: companion is a transport/sidecar and enterprise supplies server modules. Neither has a separate composer or message list. |

## Passing checks

The installed `pnpm` launcher could not verify/download the pinned package
manager through the restricted network. The repository's installed tools were
therefore invoked directly, with the same arguments as its scripts.

- Type checks: `node_modules/.bin/tsc -b` and
  `node_modules/.bin/tsc -p tsconfig.server.json`.
- Lint: `node_modules/.bin/oxlint --deny-warnings .`.
- Translation catalogs: `node scripts/generate-locale.mjs --check`.
- Removed gates: `rg -n 'composer[.]error[.]noImages|engineSupports[I]mages' .`
  returns no matches.
- Web build: `node_modules/.bin/vite build`.
- Core plus Personal renderer build: `node scripts/build-personal.mjs --core`.
- Android bundled renderer: `node scripts/build-android-ui.mjs`.
- Companion build: `node_modules/.bin/tsc -p tsconfig.companion.build.json`.
- Focused frontend tests: **13 files, 180 tests passed**:

  ```sh
  node_modules/.bin/vitest run \
    src/components/Composer.input.test.ts \
    src/components/MessageActions.test.ts \
    src/personal/AgentDesktop.input.test.ts \
    src/components/ComposerQueuedMessages.test.ts \
    src/lib/composer-attachments.test.ts src/lib/drafts.test.ts \
    src/lib/group-routing.test.ts src/components/ChatView.follow.test.ts \
    src/components/ChatView.controls.test.ts src/components/ChatView.rows.test.ts \
    src/personal/android-bridge.test.ts src/personal/android-viewport.test.ts \
    src/personal/error-report.test.ts
  ```

  New tests exercise the actual React handlers and mounted Personal page:
  composition Enter, the 149/150 ms boundary, Shift+Enter with a picker,
  image selection/paste/send/retry without model capabilities, preservation of
  the real clipboard-read error, and inline model settings with draft retention.
- Focused Electron checks: **18 passed**:

  ```sh
  node --test electron/paste-menu-item.node-test.mjs \
    electron/desktop-workspace.node-test.mjs electron/local-origin.node-test.mjs
  ```

- Swift shared package: **103 tests passed** using a temporary scratch/module
  cache and `swift test --disable-sandbox`. The latter disables SwiftPM's
  nested build sandbox; the session filesystem restrictions still apply.
- macOS and iOS: **all application sources type-checked and compiled/linked**
  using Swift 6.1.2 and the installed Xcode 16.4 SDKs, the temporary
  `NexClientKit` build objects, and `swiftc -disable-sandbox`.
  Outputs were `/tmp/nex-fix-mac` and `/tmp/nex-fix-ios-app`.
  These are compile/link checks, not signed `.app`/IPA delivery or device runs.
- AppKit composer: **4 behavior checks passed**:

  ```sh
  CLANG_MODULE_CACHE_PATH=/tmp/nex-fix-clang xcrun swiftc \
    -disable-sandbox -parse-as-library -swift-version 6 \
    apps/apple/NexBotMac/ComposerTextEditor.swift \
    apps/apple/Tests/ComposerTextEditorChecks.swift \
    -o /tmp/nex-fix-editor-check
  /tmp/nex-fix-editor-check
  ```

  Covers plain Return, Shift+Return, immediate IME-commit Return, and delayed
  keypad Return. It uses no window, account or server.

## Blocked or incomplete verification

- The repository Core/Electron workspace smoke was attempted with its isolated
  fixture, but opening `127.0.0.1` listeners fails with `listen EPERM`.
- Added `node scripts/testing/composer-renderer-smoke.mjs`: a separate
  synthetic renderer fixture using a temporary Chrome profile, file assets,
  in-memory API responses and a clipboard stub. It checks inline model layout,
  the real mouse path from message to buttons, Quote/Copy handlers and drag
  selection. It needs no server or live data. This machine's Chrome aborted
  with `SIGABRT` before the checks, so **visual/pointer behavior is not proven
  here**. Run with `CHROME_BIN` if Chrome lives elsewhere.
- Full Electron Node suite: 635 tests; 580 passed, 51 failed, 1 cancelled,
  3 skipped. Failures include prohibited loopback listeners,
  `uv_uptime EPERM`, and the missing installed Electron executable.
  Its updater test did not settle before the blocked run was interrupted.
- The wider companion suite hit prohibited sockets and was stopped rather
  than used as a passing result. A narrower enterprise-license / companion
  wire / companion-origin run had 26 passes and 2 origin-socket failures
  (`listen EPERM`), not product assertion regressions established by this run.
- Xcode project generation succeeded; `xcodebuild` could not resolve its local
  package build because its temporary/cache writes were denied. The direct
  Swift type checks and links above succeeded instead.
- Gradle was attempted with:

  ```sh
  cd android
  GRADLE_USER_HOME=/tmp/nex-fix-gradle bash ./gradlew --no-daemon \
    :core:test :app:testDebugUnitTest :app:assembleDebug
  ```

  It stopped downloading Gradle 9.5.0 with
  `UnknownHostException: services.gradle.org`. Kotlin compilation, Android
  tests and APK assembly therefore remain unverified.

Logs from this run are in `/tmp/nex-fix-*.log`. Build warnings about bundle
sizes were nonfatal.

## Commit status

`git add` failed with:

```text
fatal: Unable to create '/Users/darrenhoo/projects/nex_bot/.git/index.lock': Operation not permitted
```

The session exposes `.git` read-only and does not permit privilege escalation.
Changes remain uncommitted in the named branch's worktree. No main reference
was modified and nothing was pushed.

## Changed files

- `android/app/src/main/kotlin/com/nexorai/nexbot/ui/ChatScreen.kt`
- `android/app/src/main/kotlin/com/nexorai/nexbot/ui/Markdown.kt`
- `apps/apple/NexBotMac/Composer.swift`
- `apps/apple/NexBotMac/ComposerTextEditor.swift`
- `apps/apple/NexBotMac/ConversationView.swift`
- `apps/apple/NexBotiOS/ChatView.swift`
- `apps/apple/Tests/ComposerTextEditorChecks.swift`
- `docs/verification/composer-image-ime-model-copy.md`
- `scripts/testing/composer-renderer-smoke.mjs`
- `src/components/ChatView.tsx`
- `src/components/Composer.input.test.ts`
- `src/components/Composer.tsx`
- `src/components/MessageActions.test.ts`
- `src/components/MessageActions.tsx`
- `src/locales/de.json`
- `src/locales/en.json`
- `src/locales/es.json`
- `src/locales/fr.json`
- `src/locales/hi.json`
- `src/locales/ja.json`
- `src/locales/pt-br.json`
- `src/locales/source-hashes.json`
- `src/locales/uk.json`
- `src/locales/zh-tw.json`
- `src/locales/zh.json`
- `src/personal/AgentDesktop.input.test.ts`
- `src/personal/AgentDesktop.tsx`
- `src/personal/agent.css`
- `src/personal/panels.tsx`
- `src/styles.css`

## PR #7 CI follow-up, round 2

Work began at `203a2e6b` on the same branch on 2026-10-20.

The Device Node Windows launch passed only PATH, SystemRoot and TEMP.
`-NoProfile`, `-NonInteractive` and closed stdin were already present.
The failing Convert-Path, Set-Content and Add-Content commands are complete
PowerShell statements; the working directory is passed as `spawn.cwd`,
not interpolated into their source. Both output pipes already have data
listeners that continue draining after the capture limits.

The fix retains a case-insensitive allowlist of Windows installation,
profile, application-data and temporary paths. It keeps Core/provider
credentials out of the child environment and does not inherit a PowerShell 7
PSModulePath into Windows PowerShell 5.1. Missing ProgramFiles/profile
environment is a documented PowerShell startup defect:
[PowerShell issue 3545](https://github.com/PowerShell/PowerShell/issues/3545).
The module-path distinction is documented in
[about_PSModulePath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath).
This is the leading explanation for the CI hang, not a Windows reproduction:
Windows CI must confirm it. No shell flags, execution deadlines, POSIX launch
behavior or test selection were changed.

`server/personal-os/node-command.test.ts` now exercises EOF, the same marker/counter/working-directory
commands as the failing integration tests, output beyond both capture limits,
and environment preservation/filtering. All **6 tests pass locally on macOS**.
`tsc -p tsconfig.server.json`, focused oxlint and `git diff --check` pass.

The Boat test's exact count of two resumes was timing-dependent: its final
sleep is clipped to a wall-clock deadline and can wake early enough for one
more poll. It now requires at least two resumes, while still requiring the
final null result that proves a later accepted resume cleared the old error.
The HTTP integration checks cannot be certified in this sandbox.

The Android capture was attempted exactly as requested:

```sh
node --experimental-transform-types --no-warnings scripts/capture-android-fixtures.mjs --core=server/personal-os/index.ts
```

It fails while opening the isolated fake identity server with
`listen EPERM: operation not permitted 127.0.0.1`, before writing any fixture.
No Android fixture diff was accepted, and `--check` is not verified.
The script does not execute Device Node commands. Its state projection
retains `device.name`, populated by `gateway.pair(os.hostname())`; the checked-in
state files contain `darren-win-1`. That host-dependent value is a separate
concrete drift source requiring normalization, not a stdio contract change.

macOS smokes **need CI re-run**. `node scripts/smoke-packaged-server.mjs`
against the existing build exits at sandbox-denied `uv_uptime` before serving
health. `node scripts/smoke-app-permissions.mjs` cannot acquire its missing
Electron binary because its download fails. Approval-mode and phone-relay
smokes share that unavailable Electron runtime.

Local commit was attempted, but `git add` cannot create `.git/index.lock`
(`Operation not permitted`). This session mounts `.git` read-only and
disallows escalation. The changes remain uncommitted; nothing was pushed.
