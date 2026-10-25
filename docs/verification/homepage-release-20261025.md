# Homepage navigation and downloads — 2026-10-25

Release: [nexbot-v0.9.16-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.16-preview.1).
Core, web UI, Windows 0.9.16 and Android 0.2.15 (code 215) were built from
pushed main commit `56c4c19b60c06274dd03065cc047e54a3b551100`.

## Behaviour and scope

- In the browser, clicking the top-left NexBot brand opens the public homepage.
  The account stays signed in. Entering the workspace again restores the same
  mounted conversation and its unsent draft. Browser back and refreshing the
  homepage preserve the route; session expiry still returns to login.
- The homepage has separate Windows, Android, Mac, iPhone and web cards. All
  four installer cards use `/api/client/downloads`, including its version and
  direct download URL. Missing entries fall back to GitHub releases, never to
  source build instructions. Signed-in web actions enter the workspace.
- AGENTS.md now requires every release to update both README and homepage,
  checking actual public versions/download links against the published files.
- Native Mac/iOS navigation and code were not changed. Their existing verified
  0.2.10 installers remain current, with their original GitHub release links and
  OSS manifest entries. They were not rebuilt or republished under new names.

## Verification

- TypeScript, lint and translation checks passed before pushing main.
- 21 tests passed across auth.navigation, AgentDesktop.input and AboutSettings.
  They cover authenticated home/workspace navigation, draft retention, expiry,
  route restoration, client shell behaviour and all four manifest download links.
- `node scripts/smoke-home-navigation.mjs` launched an isolated Core and hidden
  real Electron browser with synthetic identity/model services. Eight checks
  passed: brand click, authenticated home, five cards, mobile width, retained
  draft, browser back, refresh, and returning to the workspace. Desktop/mobile
  screenshots were inspected. No live account data was changed.
- Exact Windows portable 0.9.16 passed 20 single-workspace and 24 account-workspace
  shell checks, including authentication, logout, restart and account isolation.
  The artifact's ProductVersion and FileVersion both report 0.9.16.
- Android core/app tests and assembleDebug passed on JDK 17 / SDK 36. Results:
  51 core tests (unchanged outputs reused), 27 app tests, zero errors/failures.
  The APK reports 0.2.15/code 215. apksigner verified it and the prior APK;
  both use certificate SHA-256
  `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`.
  A local Java socket error was resolved using the dedicated short temporary
  directory for this build process; no global Java configuration was changed.

## Deployment and downloads

The Linux candidate passed throwaway Core checks before the switch. With no
active tasks, production data/config was backed up privately, and Core switched
from main-477f1277-20261025 to main-56c4c19b-20261025 with automatic rollback
on failed checks. Health returned 200, unauthenticated APIs returned 401,
all six databases passed integrity checks, and stored identity/configuration
fingerprints and vault-key hashes were preserved. Public HTML and all six
assets matched the local build byte for byte.

GitHub's four release assets matched local sizes and SHA-256 digests before
publishing the pre-release. The old update manifest was backed up privately;
publisher dry-run passed. New installers were mirrored to immutable OSS keys,
read back and hashed before the manifest changed. Windows 0.9.15 and Android
0.2.14 receive the new offers; current versions receive none. Mac/iOS retain
0.2.10. All four actual offered installers were downloaded and matched their
manifest sizes/digests.

A fresh read-only browser loaded the live homepage. Its four installer card
versions and URL destinations matched the public download API: Windows 0.9.16,
Android 0.2.15, Mac/iPhone 0.2.10. The screenshot was inspected. All six README
installer/checksum links resolve to uploaded assets in published releases.

| New artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.16-x64-Client-Portable.exe | 174021878 | `dc1225bdd31f6bd7fa7b7cbca660fad919222b89293038e3a1e7a17ccfec3619` |
| nexbot-0.2.15-debug.apk | 17762013 | `d89aafa020bd5186dccf79bab4aadcfa87702e93865557c9578a3a75f6d0d87f` |

## Limits and retained evidence

Windows remains unsigned, Android uses the existing debug certificate, Mac is
ad-hoc signed without notarization, and iOS requires user signing. No physical
phone installation or replacement of a user's running client was performed.
Raw reports and screenshots are under ignored `release/deployment-home-20261025/`.
Automatic approval policy blocked removal of an owned temporary browser fixture;
that directory was retained. No secrets, signed URLs or live data are published.
