# Glass workspace and secretary portraits: all-platform release (2026-10-28)

Release: [nexbot-v0.9.18-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.18-preview.1).
Core, web UI, Windows 0.9.18, Android 0.2.17 (217) and Mac/iOS 0.2.12 (14) were
built from pushed main commit `03b034970cd05024e7969252655243136f7d6097`.

## Scope

- Web (also loaded by Windows and bundled in Android): the atmosphere shows through
  in every shell; the sidebar, companion panel and composer are floating glass panels.
  The left rail collapses to an avatar dock (`nexbot.rail`); the header is a centred
  capsule shown while the panel is closed. Messages are card bubbles grouped within
  five minutes; replies with headings or more than about 12 lines become a document
  card with outline chips (`src/personal/long-reply.ts`); tool activity is a pill with
  a failure count. Layout rules live in `src/personal/glass.css`.
- Windows shell (`electron/client/window-chrome.css`): the free space and the header
  are the drag area, controls stay clear of the native caption buttons, and the panel
  close button is visible again.
- macOS/iOS: the same layout in SwiftUI. The document-card, grouping and tool-capsule
  rules are in NexClientKit (`ReplyLayout`, `ChatPresentation`) with tests ported from
  the web. Outline chips expand the card but do not scroll to the heading.
- Avatars: three secretary portraits (`secretary-01`…`03`, one 1536×512 sheet generated
  with GPT Image 2.5) join the graphic catalog on every platform. The first Agent now
  defaults to `secretary-01`; saved choices are unchanged. Design notes and the
  standalone mockup are in `docs/design/`.

## Source

The branch was merged with `origin/main` (`2b97a9bd`, the 0.9.17 long-context release),
versions were bumped, `origin/main` was rechecked and the result pushed as a
fast-forward. On the merged tree: lint, both TypeScript projects, the locale check,
`git diff --check` and `sync-graphic-avatars.mjs --check` passed; Vitest `src/personal`
plus the appearance suite passed 67 tests. `server/personal-os` ran 311 tests with 3
failures: the bundled-skills test fails identically on `origin/main` without this
change, and the two others (`chat-composer` "bad port", a random fixture port
rejected by fetch) are environment flakes unrelated to the UI.

## Fixtures

All mutating checks used temporary Core data, synthetic identity/model services and
isolated profiles.

- `scripts/smoke-personal-workspace.mjs` (real hidden Electron renderer): all 45 cases
  passed, including the 15-avatar picker, chat, uploads, approvals, MCP, settings,
  light/dark and mobile.
- Windows title bar (`release/glass-shell/verify.mjs`, dev shell with window control):
  rail open/collapsed × panel open/closed, dark, 900px and 760px, maximize/restore and
  logout. Every visible header control is non-draggable, hit-testable and clear of
  the caption buttons; the transcript is not a drag region; no horizontal overflow.
- Apple (on the build Mac, before release): 16 screenshots of macOS and iOS in light
  and dark, sidebar and inspector states, a document card, a grouped reply and a
  `3 项操作 · 1 项失败` capsule.

## Core and web UI → Tokyo

- Overlay SHA-256 `f66be1810f734b80c23b3e2e4ef44c43b4018859977799758a21f0deba478a30`,
  staged as `/data/nexbot/releases/main-03b03497-20261028` from `main-74931a69-20261028`.
- Throwaway Core on Tokyo from the staged release: schema 29, 401s, exact UI assets,
  the glass bundle markers, the secretary sheet served, all three secretary ids
  accepted and an unknown id rejected.
- Deployed with no active tasks: backup `/data/nexbot/backups/main-03b03497-20261028-pre`,
  drop-in `zzzzzzzzzzzzzzzzzzzzzzzzzzzz-glass-release.conf`. Post-switch: health 200,
  6 workspace databases with unchanged identity/model/secret/policy hashes, vault keys
  and schema, 33 projections present, 401s. No errors in the Core journal afterwards.
- Public `https://bot.nexorai.com.cn`: HTML and all 7 assets byte-identical to the
  local build, `/health` 200, `/api/state` 401, preview CSP sandboxed.

## Packages

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.18-x64-Client-Portable.exe | 176196790 | `414cdaa9206beee0d7bf85e19dce82eae4a372c9db1ad7e6462bd61f7a1b400c` |
| nexbot-0.2.17-debug.apk | 19938627 | `022ce7ac6560bee34c754db6720f2d7f7c726f8a272aab9f25004113d311d310` |
| NexBot-0.2.12-mac-arm64.dmg | 76084794 | `0abb83fe03e0fffb7ad772ab1ee9035b854b38174c5ed51e81b5e8ed7ad5c1d5` |
| NexBot-0.2.12-ios-unsigned.ipa | 10989189 | `28b553975d6d77603b5f57f4c82c85bb31d06396038208a45d00fb88428fd9b3` |

- Windows: ProductVersion and FileVersion 0.9.18; `scripts/smoke-shell-login.mjs` on the
  exact EXE passed 20 single-workspace and 24 account-workspace cases. The title-bar
  geometry check also passed on the exact EXE at its own window size (rail/panel
  combinations and dark); the packaged shell has no resize hook, so widths were
  covered by the dev-shell run above.
- Android: JDK 17 / SDK 36 `:core:test` 53, `:app:testDebugUnitTest` 29, 0 failures;
  APK reports 0.2.17 / 217 and bundles the secretary sheet; apksigner certificate
  SHA-256 `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`, the same
  as the published builds.
- Mac/iOS: on the Mac from a fresh `git clone` at the commit with a dedicated simulator:
  NexClientKit 151 tests passed; RenderMac and RenderiOS 5 each passed; DMG app 0.2.12 /
  14, ad-hoc signature verified with `codesign --verify --deep --strict`; IPA checked by
  `verify-apple-release.py` (0.2.12 / 14, arm64, iOS 17.0 minimum, no signing material).
  The clone and simulator were deleted; the user's checkout and simulator were not used.

## Publication

- GitHub pre-release at the build commit with the four installers, `SHA256SUMS.txt` and
  `SOURCE_COMMIT.txt`; all six uploaded sizes and digests matched the local files.
- The previous update manifest was backed up privately to the release backup directory;
  the publisher dry-run listed all four platforms; installers were uploaded to immutable
  OSS keys and read back before the manifest changed.
- Public `/api/client/update`: Windows 0.9.17, Android 0.2.16 and Mac/iOS 0.2.11 are
  offered the new versions, the new versions get no offer, and every offered installer
  was downloaded and matched its manifest size and SHA-256.
- README links point to `nexbot-v0.9.18-preview.1` and every linked file is an asset of
  that release. The live homepage in a fresh read-only browser shows Windows 0.9.18,
  Android 0.2.17, Mac and iPhone 0.2.12 and the 2026-10-28 date, each card linking to
  the download API's file.

## Limits

- No production-account conversation and no physical phone installation; Android's
  new layout was not screenshotted (it shares the verified web bundle).
- Reduce Transparency, Reduce Motion and Dynamic Type were not exercised on Apple.
- Windows remains unsigned, Android uses the debug certificate, Mac is ad-hoc signed
  without notarization, iOS needs user signing.

Raw reports are under the ignored `release/deployment-glass/`, `release/glass-shell/`,
`release/glass-shell-exe/`, `release/apple-glass/` and `release/ship-0.9.18/`.
