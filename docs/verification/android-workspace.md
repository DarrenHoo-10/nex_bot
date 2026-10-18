# Android shared workspace — 2026-10-18

Android 0.2.0 bundles the same `src/personal` renderer as Windows, built by
`scripts/build-android-ui.mjs` from Gradle. `Root.kt` sends an authenticated
session to `WorkspaceScreen`, retaining native sign-in, encrypted session
storage, lifecycle renewal and notifications. Legacy Compose chat screens are
not the production workspace and their historical tests alone do not prove
parity.

## Shared features

| Area | Shared controls |
| --- | --- |
| Account | Username initial, settings, light/dark theme, logout confirmation |
| Settings | Account sessions/revoke, model provider/URL/key/list/limits, memory service, MCP connectors/grants, signed-in devices |
| Assistant | Create, pin, archive, inline identity, avatar collection, tool policy, usage |
| Work | Routine create/edit/toggle/run, tool results, previews |
| Chat | Streaming, Markdown tables/code, quote/copy, uploads, approvals, stop, permission menu, per-assistant model selection, export |

The Android adapter supplies document selection and Save As, clipboard,
external links, notification routing and hierarchical Back. Device controls
reflect actual platform capabilities: the phone lists logged-in devices and
can ask registered computers to work; this APK does not add an Android
accessibility/phone executor. Closed-process push and release/store signing
remain separate work.

## Isolation and transport

Only packaged assets load under an account/server-specific HTTPS synthetic
origin. No bearer is placed in that origin, HTML, URL, JavaScript or web storage.
The native transport permits relative `/api/` GET/POST calls, blocks login-token
endpoints, traversal and redirects, and obtains the current native token on
every request. Remote pages open outside the WebView. CSP blocks frames and
remote scripts/connections. Logout destroys the workspace; streams close in
the background and reconnect in the foreground. API error status and body are
preserved for the shared UI, including conflicts and session revocation.

## Repeatable verification

```sh
pnpm exec vitest run src/personal/android-bridge.test.ts scripts/ci-scope.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
cd android
./gradlew --no-daemon :core:test :app:testDebugUnitTest :app:assembleDebug
```

For an emulator, start `scripts/fixture-android-workspace.mjs` using Node's
`--experimental-transform-types --no-warnings`. This creates an isolated Core,
fake identity, model and MCP service. Only its synthetic fixture metadata is
written under ignored `release/android-workspace`. Forward that Core port with
`adb reverse` to the owned emulator, sign into the fixture, and forward that
app's WebView debug socket to local port 9227. Run
`node scripts/smoke-android-workspace.mjs`. It refuses any display name other
than the fixture's and writes its case report to the ignored output folder.
Create `release/android-workspace/stop` to close the fixture services.

The shared UI also fixes assistant creation selecting the old first assistant:
the snapshot is refreshed before selecting the newly created assistant, so
selection reconciliation no longer rejects an ID absent from the old snapshot.

## Conversation model selection

The composer Model command opens a searchable selector; it never navigates to
connection settings. The list uses the saved provider credential server-side.
`POST /api/bots/model` persists the selection for the assistant, provider and
endpoint, checks an optimistic version, and rejects changes during unfinished
work. Other assistants keep their own choices. Returning to Default removes the
effective override. The worker resolves token limits for the selected model.
This requires the accompanying Core update; an older deployed Core does not
implement the new route. No production deployment is performed by this change.

## Recorded results

- TypeScript check passed; 41 scoped Vitest cases passed, including real worker
  model/output selection, persistence, scope separation, conflicts and auth.
- Android Core 47 tests and App 26 tests passed; debug APK assembled and installed
  over the preceding build in the owned API 35 emulator.
- 20 actual APK/WebView checks passed against the synthetic Core: account,
  settings, model limits/list/key reveal, connectors, devices, theme, assistant
  creation/identity/avatar/routines, permission mode, composer menu, model
  selection and Back state, plus narrow layout.
- Synthetic WebView File upload, sent attachment, native event-stream reply,
  Markdown table, foreground restore, styled logout cancel and return to native
  login after logout passed. No live account/data was used.
- The ATD emulator has no system DocumentsUI. Its missing-picker failure is
  handled without crashing, but physical-device document selection and Save As
  remain unverified. This is not a claim of a completed real document-picker
  round trip.
- 14 screenshots in `doc/ui/android-*.png` use the exact bundled renderer at
  412 × 915 with synthetic data in offscreen Electron. They are mobile layout
  references, not screenshots of a physical Android screen.

Artifact: `release/nexbot-0.2.0-debug.apk`, 12,546,925 bytes, debug-signed,
APK v2 verification passed. SHA-256:
`7a33de9b10b3df096ca42e593878127f23e9a810e31709ab071aba6a6f23d89f`.
This local artifact has not replaced the public 0.1.0 release download.
