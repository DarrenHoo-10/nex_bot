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
`/api/client/installer/<android|ios>/<file>` streams the current manifest's
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
