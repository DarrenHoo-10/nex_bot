# Chat and rendering release — 2026-10-25

Released as [nexbot-v0.9.14-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.14-preview.1).
Core, web and all four installers were built from pushed `main` commit
`1c9922f2eebdea0664d2df0746b2ef5fb82463d4`. This merge includes the upstream
Feishu connector changes (`a765e699`) as well as this task's changes.

## Scope

- [Send stability](chat-send-stability.md): preserve optimistic message identity,
  reduce repeated rich-text rendering, update transcript and task state together,
  and follow the content tail consistently on web and native clients.
- [Tool context](tool-context-budget.md): retain complete results when the total
  input budget permits; progressively reduce context under pressure while keeping
  original results available through paginated retrieval.
- [HTML rendering](html-render-tool.md): expose `html.render` through the broker,
  publish sandboxed previews, and remove conflicting old chart instructions.
- [Windows title bar](windows-client-titlebar.md): integrated window chrome;
  remove the assistant-details heading and close button. The bottom-follow
  control is an accessible circular down arrow on web, macOS and iOS.

## Build and fixture evidence

All mutating checks used isolated data and synthetic providers, not the user's
production conversations or device profile.

- Full lint, TypeScript and translation checks passed at push.
- Nine relevant Vitest suites cover 78 tests. The first run passed 77; one
  image-model fixture failed because its randomly allocated port was rejected
  by fetch. That entire nine-test suite passed on rerun.
- HTML preview fixture: 16 Electron sandbox checks passed, including a rendered
  five-stage funnel. Capability discovery and publishing used a scripted model.
- Windows: `pnpm package:client:win`; the exact portable EXE passed all 26
  `smoke-shell-login.mjs --expect-local-ui` checks, including authentication,
  local UI loading, device lifecycle, restart, logout and revocation.
- Android: JDK 17 / SDK 36, `:core:test :app:testDebugUnitTest :app:assembleDebug`.
  Core tests were rerun with `--rerun-tasks`: 51 core and 27 app tests passed.
  A short `jdk.net.unixdomain.tmpdir` resolved the Windows JVM socket-path issue.
  APK version/code is 0.2.13/213. Both the previously published APK and the new
  APK passed `apksigner`; their signing certificate SHA-256 matches:
  `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`.
- Apple: fresh clone of the pushed commit on the build Mac, frozen dependencies,
  generated icons, 132 NexClientKit tests passed. `release-preview.sh` built
  macOS Release, iOS Simulator Debug and iOS device Release; RenderMac and
  RenderiOS each passed five tests on an isolated simulator/build environment.
  DMG signature, bundled executor, versions and preview runtime verified.
  IPA contents/version verified. Both apps report 0.2.9, build 11.
  The dedicated simulator and temporary clone were removed after verification.

## Core and public deployment

The candidate was first launched with throwaway Core data on the deployment
host. Schema version 25, Feishu tables and HTML rendering capability passed.
With no active tasks, the prior data/config was privately backed up, then Core
was switched to `main-1c9922f2-20261025` with automatic rollback on check failure.
The previous release remains available for rollback.

Post-switch checks passed: health 200, unauthenticated API 401, database integrity
and foreign-key checks, preserved schema and account/configuration fingerprints.
The public HTML and all six bundled assets matched the local build byte for byte.
The dynamically generated HTML preview shell returned 200 with its sandbox CSP.

## Published artifacts

| Platform | Version | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Windows x64 | 0.9.14 | 174020621 | `5448a3bb1b85f5ffe41ea52be7bcc3ccf7345715b89e76a3262c23e95df7144f` |
| Android | 0.2.13 | 17744257 | `2d8cbe95e1d339316e7e227cb54af9ec1246125d848b6018e7bcc013a9ecb9ed` |
| macOS arm64 | 0.2.9 | 75221643 | `b2970c1904b59b4aaf0904ad49bf68f027baab4f1312521249670e7eb0626ccd` |
| iOS | 0.2.9 | 9620614 | `f5b18a7ced8cb372d2b384da1121d6ddcae8da53040469bc5a861668a54f585d` |

GitHub reports matching sizes and SHA-256 digests for all four packages,
`SHA256SUMS.txt` and `SOURCE_COMMIT.txt`. The tag targets the build commit.
The previous OSS manifest was backed up privately. The publisher dry-run passed;
all four uploaded objects were read back and hashed before updating the manifest.

Public update checks passed for Windows 0.9.13, Android 0.2.12 and Mac/iOS 0.2.8:
each receives the version above. Each new version receives no update. Every
offered installer was downloaded through its actual update URL and checked
against the local file's size and SHA-256, including the APK/IPA Core relay.
No credentials, signed URLs, live data or private logs are published in this record.

## Limits

Windows remains unsigned; macOS uses an ad-hoc signature without notarization;
Android uses the existing debug signing key; iOS is unsigned and needs user signing.
No iPhone hardware installation or production-account conversation was used for
acceptance. Scripted-model tests establish tool availability and routing, not
the quality of every model's generated HTML. Feishu real-tenant acceptance remains
the outstanding item documented in [its verification record](feishu-connector.md).
The measured local send improvement is a single fixture sample, not a latency SLA.
