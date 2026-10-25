# Avatar and atmosphere parity — 2026-10-24

The accepted twelve graphic roles now work in the browser, Windows, Android,
native macOS and native iOS. The Apple apps use the same original PNG sheets,
crop rectangles and character motion parameters as the web renderer. All roles
share one picker, with no visible gender headings, avatar names or numbers.
Saved classic portraits, twenty companion combinations and stable defaults
remain supported. Applying uses the existing version-checked appearance API;
canceling leaves the saved appearance intact.

Apple surfaces now follow the silver-blue light/dark palette. The Mac has the
inset rounded workspace frame; the phone uses full-width native navigation.
Graphic motion operates on the original artwork as a whole. Idle contacts and
thumbnails stay still. System reduced motion, the app preference, scene activity
and view visibility gate animation. Completion moves once, then settles; an
active new task takes precedence over a recent completion.

`shared/personal-graphic-avatars.ts` is the metadata source. After changing it,
run `node scripts/sync-graphic-avatars.mjs`; `--check` verifies the generated
Swift catalog and byte-identical native image resources. Existing avatar IDs
and the backend appearance schema did not change in this adaptation.

## Recorded checks

Every account, session, bot mutation and screenshot used a disposable synthetic
Core. Apple builds ran in an owned temporary checkout and a newly created iOS
18.6 simulator. The Mac fixture used a separate bundle identifier, profile and
the existing DEBUG in-memory credential option because its login Keychain was
locked. The user's installed clients, profiles and simulator were not used.

| Surface | Evidence |
| --- | --- |
| Web / Windows | Frontend and backend TypeScript checks; development Core/UI build; all 45 hidden Electron workspace checks passed after the metadata extraction. |
| Android | Actual debug APK assembled with the newly built workspace assets; 77 Gradle Core/App tests passed; 34 bridge/CI Vitest tests passed. The exact packaged renderer passed 24 workflow checks in hidden Electron with a synthetic native bridge. |
| macOS | Debug app built with Xcode 16.4; all 113 NexClientKit tests passed; 3 native avatar rendering/behavior tests passed. The real SwiftUI picker loaded the iOS choice, canceled a new choice without saving, then applied another choice through Core. |
| iOS | Ad-hoc-signed simulator app built; 3 native avatar rendering/behavior tests passed. The real picker selected/applied a graphic, reopened it, canceled another choice and displayed the later Mac selection in dark mode. |

The native tests cover all twelve artwork resources, validated saved appearance
parsing, legacy portrait preservation, distinct motion states, one-shot completion,
and narrow light/dark picker rendering. Visual review caught and corrected a
nested grid that rendered only the first row of original companions. Compilation
also exposed a missing `AgentMessage.botID` accessor used by iOS attachments;
the accessor now reads the existing protocol field. Native shell build scripts
and generated avatar files are pinned to LF for Windows-to-Mac builds.

Cross-client check: iOS applied `female-06` and Mac reopened it selected; Mac
canceled `male-04` (Core still held `female-06`), then applied `male-04` and iOS
reopened it selected. The other existing bot's appearance stayed unchanged.

Screenshots: [Mac picker](../../doc/ui/graphic-avatar-native-mac.png),
[Mac dark workspace](../../doc/ui/graphic-avatar-native-mac-dark.png),
[iPhone picker](../../doc/ui/graphic-avatar-native-ios.png),
[iPhone dark picker after Mac save](../../doc/ui/graphic-avatar-native-ios-dark.png),
[Android asset bundle](../../doc/ui/graphic-avatar-android-bundle.png).

## Reproduction

```sh
node scripts/sync-graphic-avatars.mjs --check
node node_modules/typescript/bin/tsc -b
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node node_modules/vitest/vitest.mjs run src/personal/android-bridge.test.ts scripts/ci-scope.test.ts
node scripts/build-personal.mjs --core
node scripts/smoke-personal-workspace.mjs
node scripts/build-android-ui.mjs
```

Start `scripts/fixture-android-workspace.mjs release/avatar-parity-fixture`, then
run `node scripts/smoke-android-renderer.mjs release/avatar-parity-fixture` from a
second terminal. Close the owned Core by creating its `stop` file. For an actual
Android emulator, use the existing [Android recipe](android-workspace.md) and
`smoke-android-workspace.mjs` with its explicitly forwarded debug socket.

With JDK 17 and SDK 36, run Gradle `:core:test :app:testDebugUnitTest
:app:assembleDebug`. The recorded remote build transferred the exact locally
built `android/app/build/generated/workspaceAssets` and excluded only
`:app:buildWorkspaceUi` to avoid rebuilding that asset bundle on a second host.

On macOS, generate `apps/apple/project.yml` and `apps/apple/Testing/project.yml`
with XcodeGen. Build `NexBotMac` and `NexBotiOS` in Debug. Run `swift test` in
`apps/apple/Packages/NexClientKit`, then the `AvatarRenderingTests` suite in the
`RenderMac` and `RenderiOS` test schemes. Use a newly created simulator and the
[native fixture](native-clients.md) for interactive picker verification.

No physical Android/iPhone run or actual Android WebView session was performed
in this pass. The Electron Android adapter test does not prove device lifecycle,
native file pickers or WebView rendering. This work is on the UI worktree and
has not been merged, deployed or published. Release builds must follow the root
`AGENTS.md` rule: a commit on `main` already pushed to `origin`.
