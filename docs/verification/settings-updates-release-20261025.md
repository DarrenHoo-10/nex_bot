# About, updates and preview controls — 2026-10-25

Release: [nexbot-v0.9.15-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.15-preview.1).
All production assets and installers were built from pushed `main` commit
`477f12775c29f31493aed2a8e6a4091d427fb372`.

## Behaviour

- Windows, Android, macOS and iOS expose `设置 → 关于`, the actual installed
  version, and `检查更新`. Checking, current, download/ready, error and retry
  states use the existing update channel. Installation still requires a click.
  iOS offers a download link because it cannot replace its own installation.
- Browsers identify themselves as `网页版`. Unsupported Windows installations
  display their version without a broken update button; development launches
  identify themselves as `开发版`, not Electron's runtime version.
- HTML previews on web and native Apple clients no longer expose the `源码`
  disclosure. Fullscreen, stop, rerun and the sandbox remain available.
- Existing Feishu, chat, context-budget and HTML rendering functionality remains
  included from the previous main release.

## Source and fixture checks

- Pushed main passed lint, TypeScript and translation catalog checks.
- 22 Vitest tests passed across AboutSettings, chat input and HTML parsing;
  five Windows updater tests passed, covering integrity, reuse, retries and
  concurrent-check suppression.
- The Electron HTML fixture passed all 16 checks against the final sources,
  including sandbox isolation, blocked requests, state preservation, fullscreen,
  stop/rerun, history reload and the vertical funnel. No remote shell was fetched.
- The exact Windows 0.9.15 portable passed all 27 isolated shell-login checks.
  The About screenshot shows version 0.9.15, `检查更新` and `已是最新版`.
  All fixture accounts, profiles, providers and Core data were disposable.
- Android `:core:test :app:testDebugUnitTest :app:assembleDebug` passed with
  JDK 17 / SDK 36: 51 core and 27 app tests. Unchanged core test outputs were
  reused from the implementation check; app tests ran during this release build.
  APK version/code is 0.2.14/214. `apksigner` verified both old and new APKs;
  their certificate SHA-256 is identical:
  `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`.
- Apple builds used a fresh clone of the exact pushed commit on the build Mac.
  Frozen dependencies, generated icons, 132 NexClientKit tests, macOS Release,
  iOS Simulator Debug and iOS device Release all passed. RenderMac and RenderiOS
  each passed five tests using a dedicated simulator. DMG signature, executor,
  versions, preview runtime and IPA contents were checked. Apps report 0.2.10
  build 12. The temporary clone and dedicated simulator were removed.

## Deployment and distribution

The candidate Core was launched with throwaway data and passed authentication,
schema, Feishu, HTML sandbox and final UI bundle checks. The final JS includes
the version/update labels and no `html-preview-source` disclosure markup.
With no active tasks, production data/config was backed up privately, then
Core switched from `main-1c9922f2-20261025` to `main-477f1277-20261025`, retaining
the previous release and automatic rollback on failed checks.

Post-deploy verification passed: health 200, unauthenticated API 401, integrity
and foreign-key checks, preserved account/configuration fingerprints and vault
key hashes. Public HTML and all six bundled assets matched the local build
byte for byte; the preview shell returned its sandbox CSP.

GitHub release target, asset sizes and SHA-256 digests were checked against the
local files. The previous OSS manifest was privately backed up; publisher
dry-run passed, each upload was read back and hashed, then the manifest changed.
The first upload attempt timed out before changing the manifest. Remaining
objects were transferred through a second path with immutable object names;
the unchanged Core publisher then read back all four and verified their hashes
before publishing the new manifest. No storage secret was copied or logged.
Public update checks offer the new version to Windows 0.9.14, Android 0.2.13 and
Mac/iOS 0.2.9, and offer nothing to the new versions. Each offered installer was
downloaded through its actual update URL and its size/digest matched locally.

## Artifacts

| Platform | Version | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Windows x64 | 0.9.15 | 174021460 | `29a4c773a47fee9a1f194edf778a7f3e79213f43d3adbecb9e739319b00d63e5` |
| Android | 0.2.14 | 17761513 | `e3b3f19638d4e7ce0af48a69c9a9b5498a499cc9dd4d7f9917dee886f2312a82` |
| macOS arm64 | 0.2.10 | 74484134 | `8cdd07e2a94ca8dd9422a80611c6b4f5f3f135ce5b56ccf4ef8a349a42d52ef9` |
| iOS | 0.2.10 | 9631501 | `e271cf6b5637196c2b8da08b87aa7623678044f02d8073088ba3578f0dd33bfe` |

Raw logs, sanitized verification results and fixture screenshots are kept locally
under ignored `release/deployment-updates-20261025/`. No credentials, signed
download URLs or live user data are published in this record.

## Limits

Windows remains unsigned; macOS uses an ad-hoc signature without notarization;
Android uses the existing debug key; iOS is unsigned and needs user signing.
No running user installation was replaced during verification, and no physical
iPhone installation was tested. The existing Feishu real-tenant acceptance
limitation remains in [its record](feishu-connector.md).
