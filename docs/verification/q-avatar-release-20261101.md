# Five assistant appearances — release verification

Scope: deepseek, claude, gpt, gemini and grok character choices, saved through
the existing versioned account appearance API. Existing saved graphic/classic
avatars retain their appearance. The right inspector uses an unframed character;
small contact/message avatars use a circular head-and-shoulder crop. Action
atlases are calibrated against idle height and a common floor.

Random idle actions are disabled. Task-state poses and idle blinking remain.
`needs_reconciliation` maps to confirmation rather than failure on Web and
Apple. Short image transitions do not constitute continuous skeletal animation.
The adult full-body prototype remains in the original local workspace and is
not included in the product or publication archives.

Published packages: Windows 0.9.25, Android 0.2.24 (224), Mac/iOS 0.2.18 (20).
Release: [nexbot-v0.9.25-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.25-preview.1).
All final artifacts and Core/Web were built from pushed `main` commit
`d24f0aec9e27817d66054237a030dbd536005062` (feature commit `9a26a91e`,
followed by the Android asset packaging fix).

## Implementation verification

- 27 targeted tests passed: isolated Core account/session appearance saving,
  invalid and stale writes, reload/restart persistence; playback, transitions,
  calibration and idle scheduler cancellation.
- Full frontend/server TypeScript, repository lint and locale checks passed
  in the pre-push hook on both source commits.
- A fresh temporary Mac checkout compiled the native Mac application; four
  avatar rendering tests passed, including all five named characters in both
  small and large sizes and six task states. Shared native artwork is bundled,
  not downloaded from user-provided URLs.
- Production Web against an isolated synthetic account: five choices visible,
  claude saved through the API and read back at appearance version 1; unframed
  large character and small portrait verified. Idle gestures remained disabled.
- Final Windows EXE passed all 24 account-workspace shell login, restart,
  logout, encrypted storage, automatic device connection and account isolation
  checks. The earlier feature-commit EXE also passed the 20 single-workspace checks.
- Android: 53 core and 29 app tests passed; final APK contains all nine atlas
  PNGs byte-for-byte. `apksigner` verified the prior signing certificate:
  `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`.
- Fresh Mac checkout: Mac Release, iOS Simulator Debug and iPhoneOS Release
  builds passed. Mac and dedicated iPhone 16/iOS 18.6 simulator rendering suites
  each passed 12 tests, including four avatar tests. NexClientKit passed 183 tests
  on the feature commit; the subsequent change touched Android files only.
  The dedicated simulator and both owned temporary checkouts were removed.
- Exact DMG checksum and mounted app deep/strict signature passed; its version
  is 0.2.18/build 20 and companion resources match source. Exact IPA reports the
  same version/build and contains all nine atlases byte-for-byte. iOS and Mac
  avatar screenshots were visually inspected.

## Publication evidence

Tokyo runs `/data/nexbot/releases/main-d24f0aec-20261101`. Deployment used an
isolated candidate Core and read-only production database copies first; the
service was stopped only after active-task checks, then backed up and checked
again. Schema remains 42. Offline record hashes, data-file hashes and config
hashes were verified, with automatic rollback armed during the switch.
Backup: `/data/nexbot/backups/main-d24f0aec-20261101-pre`; prior releases retained.

Public `/health` returned 200, unauthenticated protected API returned 401;
HTML, all three referenced entry assets and all 16 bundled assets (including
nine avatar PNGs) matched the local build byte-for-byte.

GitHub tag points to the build commit. All six published file sizes and GitHub
SHA-256 digests matched local files. OSS dry-run and guarded publication passed;
the previous manifest is privately backed up alongside the deployment backup.
The four actual offered downloads were streamed and checked against local size
and SHA-256. Old versions 0.9.24 / 0.2.23 / 0.2.17 / 0.2.17 receive the new offer;
current versions receive no offer.

README and homepage are updated together. The deployed homepage was read in
the real browser: Windows 0.9.25, Android 0.2.24, Mac 0.2.18 and iPhone 0.2.18
cards show actual installer URLs matching the shared download manifest.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.25-x64-Client-Portable.exe | 199598778 | `b56443357c4260a66c1f3223bcd3f4232cc797fa63670effad7c3e3cca3a7fa5` |
| nexbot-0.2.24-debug.apk | 44075928 | `3affee3ca79d4a8baa1682eeb93aa463a4b9d89a54869bb47c6fb3878c6d6779` |
| NexBot-0.2.18-mac-arm64.dmg | 101908132 | `2dc6cc62c43ef0462bbee396c073c5d09de297dca4fd810a65862987f1f29e70` |
| NexBot-0.2.18-ios-unsigned.ipa | 34700435 | `4350640cf2b461c741e50509079e9b3f22172e6d2fd8e67c89f469c17ee39ff1` |

## Limits and build corrections

- No Android/iPhone physical-device installation or existing desktop client's
  complete auto-update installation was performed. Windows has no publisher
  signature; Android uses the existing debug signature; Mac uses ad-hoc signing
  without notarization; the IPA is unsigned and requires user signing.
- The initial Android package omitted `/companions` because its Vite build
  disables publicDir. `d24f0aec` explicitly bundles those assets, declares them
  as Gradle inputs and permits local companion PNG requests through the WebView
  interceptor. Only the corrected package was published.
- Android JDK 17 required a short temporary directory to avoid its Unix-domain
  socket `Invalid argument: connect` failure on this Windows machine.
- Apple rendering tests passed; the repeated screenshot export initially hit
  existing manifest files. Prior evidence was preserved, export resumed into
  clean directories, and signature verification and packaging then succeeded.
- Local private evidence: ignored `release/q-avatar/` and
  `release/deployment-q-avatar/` in the release checkout. No account data,
  credentials or private deployment scripts were added to GitHub.
