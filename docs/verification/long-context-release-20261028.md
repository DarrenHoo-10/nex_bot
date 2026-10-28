# Long conversations: all-platform release (2026-10-28)

Release: [nexbot-v0.9.17-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.17-preview.1).
Core, web UI, Windows 0.9.17, Android 0.2.16 (216) and Mac/iOS 0.2.11 (13) were
built from pushed main commit `74931a69c543e3fcc317cc4031a75ae91be56721`.
Behaviour and test evidence: [Long conversations: context and memory](long-context-memory.md).

## Source

The long-context branch (`037b6006`…`1b41a16c`), the Android “新话题” commit
`c2a6af83` and the version bump were merged and pushed as a fast-forward of
`origin/main` (`dd45eb9f`). The merged tree passed `pnpm exec tsc -b`,
`pnpm exec tsc -p tsconfig.server.json`, `pnpm lint` and `git diff --check`; the
pre-push hook's checks passed.

## Core and web UI → Tokyo

- Overlay SHA-256 `ab9b980fda37fc983ba334f3c4d5db7f7d5c4ae61e07f396b3059e2379e26d08`,
  staged as `/data/nexbot/releases/main-74931a69-20261028` from `main-253829a6-20261027`.
- Throwaway Core on Tokyo (synthetic model, real workers): schema 29, UI assets,
  preview sandbox, 401s, and the long-context run: stable system message, 3 background
  maintenance runs, calibration from receipts, **0** summarizer calls in the following
  turn (35,747-token request under the 64k budget), one prompt-bearing system entry,
  an episode archive found by `episode:<id>`, Core-written working note.
- Projection migration dry-run on copies of all 6 production `runtime.db` files:
  33 of 33 projections migrated, each loaded back identical to its legacy blob.
- Deployed with no active tasks: backup `/data/nexbot/backups/main-74931a69-20261028-pre`,
  drop-in `zzzzzzzzzzzzzzzzzzzzzzzzzzz-long-context-release.conf`. Post-switch:
  health 200, 6 workspace databases with unchanged identity/model/secret/policy hashes,
  vault keys and schema, 401s, and 33 projections present as entry rows.
- Public `https://bot.nexorai.com.cn`: HTML and all six assets byte-identical to the
  local build, `/health` 200, `/api/state` 401, preview CSP sandboxed. No errors in
  the Core journal after the switch.

## Packages

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.17-x64-Client-Portable.exe | 174022117 | `205b612c54ce2717f655664d2c80c7d40172667a0caeee9480893c4c103890d0` |
| nexbot-0.2.16-debug.apk | 17762345 | `2e52204dd77a50a60058f7442599b23436bdfb9467194adc2d320924f18b3433` |
| NexBot-0.2.11-mac-arm64.dmg | 74685405 | `4779d2d4d5acb710042f2110447e346a87a45c5fcf043c84c5e7b1f4b6668fef` |
| NexBot-0.2.11-ios-unsigned.ipa | 9639821 | `f6f4465e765d736ce1f741c1be7520dda78ca3e288c5833db9168fc88a092eb8` |

- Windows: ProductVersion and FileVersion 0.9.17; `scripts/smoke-shell-login.mjs`
  on the exact EXE passed 20 single-workspace and 24 account-workspace cases.
- Android: JDK 17 / SDK 36 `:core:test` 53, `:app:testDebugUnitTest` 29, 0 failures;
  APK reports 0.2.16 / 216; apksigner certificate SHA-256
  `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`, the same as
  the published 0.2.15.
- Mac/iOS: on the Mac from a fresh `git clone` at the commit, with a dedicated
  simulator: NexClientKit 137 tests passed, macOS and iOS render suites passed
  (5 each), app version 0.2.11 / 13, ad-hoc signature verified, IPA checked by
  `verify-apple-release.py` (no signing material, arm64, iOS 17.0 minimum). The clone
  and the simulator were deleted; the user's checkout and simulator were not used.

## Publication

- GitHub pre-release at the build commit with the four installers,
  `SHA256SUMS.txt` and `SOURCE_COMMIT.txt`; all six uploaded sizes and digests
  matched the local files, and `SHA256SUMS.txt` downloaded through the API was
  byte-identical.
- The previous update manifest was backed up privately to the release backup
  directory; the publisher dry-run listed all four platforms. Installers were
  uploaded to immutable OSS keys and read back before the manifest changed.
- Public `/api/client/update`: Windows 0.9.16, Android 0.2.15 and Mac/iOS 0.2.10 are
  offered the new versions and the new versions get no offer; every offered
  installer was downloaded and matched its manifest size and SHA-256.
- README links point to `nexbot-v0.9.17-preview.1`; every linked file name is an asset
  of that published release. The live homepage, loaded in a fresh read-only browser,
  shows Windows 0.9.17, Android 0.2.16, Mac and iPhone 0.2.11 and the 2026-10-28
  date, each card linking to the download API's file.

## Limits

- No real model provider was called; cache hit rate and summary quality are
  measured only after users' conversations run on this release.
- No visual check of “工作上下文” or “新话题” on Web, Windows, Mac, iOS or Android,
  and no installation on a physical phone.
- `github.com` page and download URLs timed out from this machine during the
  release (the GitHub API did not); README links were checked against the release's
  asset list and one asset was downloaded through the API.
- Windows remains unsigned, Android uses the debug certificate, Mac is ad-hoc signed
  without notarization, iOS needs user signing.

Raw reports are under the ignored `release/deployment-long-context-74931a69/` and
`release/ship-0.9.17/`.
