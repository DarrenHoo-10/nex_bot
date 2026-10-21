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

The packaged Windows portable (`electron/nex-client-update.mjs`) checks after
sign-in and every six hours, downloads in the background and discards a file
whose size or digest differs. Only a verified file shows "新版本 x 已就绪 /
立即更新". Updating copies it next to the running portable, quits, and a hidden
PowerShell waits for the old process, starts the new version with the same
`--profile`/`--origin` and removes the old file when it is a NexBot portable.

Android, Mac and iOS clients do not check for updates yet.

## Checks

- `pnpm exec vitest run server/personal-os/client-updates.test.ts`: version
  comparison, manifest validation, OSS query signatures, update answers and the
  public routes without login.
- `node --test electron/nex-client-update.node-test.mjs`: verified download,
  reuse of a verified file, rejection of tampered or truncated downloads, and
  the handoff script's arguments and removal rule.
- `node scripts/publish-client-update.mjs --dir=<assets> --tag=<tag> --dry-run`
  prints the manifest without uploading.
