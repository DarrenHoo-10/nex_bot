# Client updates from the OSS mirror

Installers are mirrored to the private OSS bucket so they download reliably in
China. `scripts/publish-client-update.mjs` runs where the `OSS_*` variables are
set (the Core host), uploads each installer under `nexbot/releases/<tag>/`,
reads every object back and checks its SHA-256, then rewrites
`nexbot/releases/manifest.json`. A release that carries only some platforms
keeps the other platforms' entries. Only installers built from a pushed `main`
commit may be published.

Core (`server/personal-os/client-updates.ts`) reads the manifest every five
minutes, keeping the last good copy through an outage, and accepts only
well-formed entries under `nexbot/releases/`. `GET /api/client/update?platform=
windows|android|mac|ios&version=x.y.z` needs no login and answers with the
newer version, size, SHA-256 and a one-hour signed OSS URL. The public
`/api/client/downloads` prefers the mirror over GitHub links.

OSS refuses to serve `.apk` and `.ipa` from its default domain
(`ApkDownloadForbidden`), so Android and iOS get a Core URL instead:
`/api/client/installer/<android>/<file>` (or `<ios>`) streams the current manifest's
file from OSS and returns 404 for any other file name.

The packaged Windows portable (`electron/nex-client-update.mjs`) checks after
sign-in and every six hours, downloads in the background and discards a file
whose size or digest differs. Only a verified file shows "新版本 x 已就绪 /
立即更新". Updating copies it next to the running portable, quits, and a hidden
PowerShell waits for the old process, starts the new version with the same
`--profile`/`--origin` and removes the old file when it is a NexBot portable.

Android (`android/app/.../update/AppUpdater.kt`) checks after sign-in and every
six hours, downloads the APK into its cache, keeps it only when size and digest
match and the archive is this app's package, then shows the same banner.
Updating opens the system installer through a FileProvider; the first time it
asks for permission to install apps. The installer refuses an APK signed by a
different key.

Mac (`apps/apple/NexBotMac/AppUpdater.swift`) checks the same way and keeps a
verified DMG in Caches. Updating mounts it, requires `NexBot.app` with this
bundle id, the offered version and a valid code signature, quits, and a
detached script waits for the process, copies the new app beside the old one,
swaps them and relaunches. If the copy fails the old app relaunches unchanged.

iOS cannot replace itself: after sign-in it shows "新版本 x 可用" once per
version with a download link.

`设置 → 关于` displays the installed client version and a manual `检查更新`
action on Windows, Android, macOS and iOS. It uses the existing updater and
shows checking, current, downloading/ready, and retryable error states. A
browser identifies itself as `网页版`; it does not show a desktop version or
installer action. Development Windows launches identify themselves as `开发版`
instead of displaying Electron's runtime version. Unsupported installations
keep their version visible without an unusable update control.

Manual checks do not install automatically. Windows, Android and Mac offer
`立即更新` only after download verification; iOS offers `下载更新`. Repeated
checks cannot start concurrent installer downloads. Network errors and malformed
update offers must not be reported as `已是最新版`.

### Settings verification — 2026-10-25 (not published)

This describes the implementation check before release. It subsequently shipped
with [0.9.15 and all-platform packages](settings-updates-release-20261025.md).

- Six isolated `AboutSettings` component tests cover the actual version,
  successful no-update response, checking/download/ready states, explicit install,
  retry after failure, stale initial-state events, and web/unsupported installations.
  Together with the existing input suite, 17 Vitest tests passed.
- Five Windows updater tests passed, including integrity, reuse, retry and
  concurrent-check suppression. Frontend TypeScript and changed-file lint passed.
- The real development Electron client passed all 27 isolated shell-login checks,
  including opening About, comparing the displayed version to the native bridge,
  and checking unsupported-build responses. The first full run reached and passed
  About, then timed out in the existing saved-key model-discovery check; the full
  rerun passed. This is not a test against the user's profile or hosted account.
- Android: `:core:test :app:testDebugUnitTest :app:compileDebugKotlin` passed
  (51 core and 27 app tests). Core tests distinguish invalid/no-update answers
  and verify retry after an HTTP failure. The shared UI assets compiled too.
- On a fresh temporary Mac source tree, 132 NexClientKit tests passed, including
  invalid-offer rejection. macOS Debug and iOS Simulator Debug compiled. The
  temporary tree was removed after saving build logs locally.

Evidence is kept locally under ignored `release/settings-updates/`, including
the Windows About screenshot and Apple build logs. These checks do not install
an update over a user's running client or exercise native About interaction on
a physical iPhone. No new release version, production deploy, GitHub asset or
OSS manifest is part of this settings implementation.

Chat images are not served from OSS URLs. They stay encrypted in OSS and every
client loads them through Core (`/api/attachments/<id>?preview=1`), so no client
receives a storage URL.

## Checks

- `pnpm exec vitest run server/personal-os/client-updates.test.ts`: version
  comparison, manifest validation, OSS query signatures, update answers and the
  public routes without login.
- `node --test electron/nex-client-update.node-test.mjs`: verified download,
  reuse of a verified file, rejection of tampered or truncated downloads, and
  the handoff script's arguments and removal rule.
- `./gradlew :core:test` (`ClientUpdateTest`, `WorkspaceTransportTest`): Android
  offer validation, verified download and Core-only image previews.
- `swift test` in `apps/apple/Packages/NexClientKit` (`ClientUpdateTests`).
- `node scripts/publish-client-update.mjs --dir=<assets> --tag=<tag> --dry-run`
  prints the manifest without uploading.
