# NexAgent 新建会话页、侧栏与上下文用量：Mac / iPhone 发布 0.2.34（2026-11-22）

Apple-only release that brings the 0.9.42 NexAgent UI to the native apps:
- the new-session page (directory browser with up / down / search / typed path, harness, worktree);
- the sidebar with a pinned, collapsible 进行中 section and state dots;
- worktree sessions grouped under their repository;
- the working row in the conversation;
- the context ring in the composer.

Windows 0.9.42 and Android 0.2.41 were not rebuilt.

## Source

- Commit `853f1a62f742e240cdf87a16a3e63d9107a90bb1` on `main`, pushed before building.
- `apps/apple/project.yml` 0.2.34 (36).
- Release gate: static checks only (oxlint, `tsc -b`, `tsc -p tsconfig.server.json`, locale catalog check), all passed.
- During development:
  - NexClientKit `swift test` passed 267 tests. New coverage: path helpers, context summary, the active list, worktree grouping by `repoRoot`, `cliDirs`, and `cliStart(createDir:)`.
  - The render fixture (`apps/apple/Testing/AgentRenderingTests.swift`) took screenshots of the list beside the new-session page, the folder browser, a running session, and the context rings. These were checked by eye.

## Build

- Built on the Mac from a fresh `git clone` of the pushed commit:
  - `corepack pnpm install --frozen-lockfile`
  - `node scripts/build-nexbot-icons.mjs`
  - `apps/apple/scripts/release-preview.sh`, with a dedicated simulator created via `xcrun simctl create` and passed as `SIM_ID`, then deleted. Render tests were skipped.
- Mac Release, iOS simulator Debug and iOS device Release all compiled.
- Checked in both bundles:
  - `CFBundleShortVersionString` 0.2.34, `CFBundleVersion` 36;
  - Mac `codesign --verify --deep --strict` OK (ad-hoc signature, not notarised);
  - the new view symbols are present;
  - the Mac's built-in executor contains the directory listing.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `NexBot-0.2.34-mac-arm64.dmg` | 109,256,473 | `d07099f6db7c177e2e979ee374bb2e7e77105cbe39836029d1e4b5b4aefb22a4` |
| `NexBot-0.2.34-ios-unsigned.ipa` | 36,875,623 | `c48b6a861a6a002cf6bf36a3fea8375ca9ecd8e3dd65b3dcca9d291ca001e631` |

## Publish

- **GitHub pre-release** [`nexbot-apple-v0.2.34-preview.1`](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-apple-v0.2.34-preview.1):
  - created at the build commit;
  - assets: the DMG, the IPA, `SHA256SUMS.txt` and `SOURCE_COMMIT.txt`;
  - every uploaded size and digest matches the local files.
- **OSS mirror and update manifest:** `scripts/publish-client-update.mjs` on the Core host.
  - The dry run listed mac/ios 0.2.34 and kept windows 0.9.42 and android 0.2.41.
  - The publish read both objects back and checked them.
  - The previous manifest is kept privately at `~/nexbot/backups/apple-0.2.34-20261122-pre/client-manifest.json`.
- **Update endpoint** (`/api/client/update`, public URL):
  - mac and ios at 0.2.33 are offered 0.2.34; at 0.2.34 they are offered nothing;
  - windows 0.9.42 and android 0.2.41 are offered nothing, and older versions are still offered those same builds;
  - every offered download matched the manifest's size and SHA-256, and the Apple files also matched the local build.
- **Homepage** (live, `/#platforms`):
  - the cards show Windows 0.9.42, Android 0.2.41, Mac 0.2.34 and iPhone 0.2.34;
  - each card's link is the `/api/client/downloads` URL;
  - each file's size and digest match the published installer.
- **README:** the Mac and iPhone rows now link the `nexbot-apple-v0.2.34-preview.1` assets, and the text says Mac / iOS 0.2.34.

## Limits

- **Manifest-wide tag and notes.** The update manifest has one `tag` and one `notes` field for the whole manifest. After this Apple-only publish:
  - the homepage link reads "0.9.42 预览版发布说明" but opens the Apple release page, which links on to `nexbot-v0.9.42-preview.1`;
  - an outdated Windows or Android client would be shown the Apple notes.

  Downloads, versions and digests are correct for every platform. Fixing this needs a tag and notes per platform entry in `publish-client-update.mjs` and `client-updates.ts`.
- **Not exercised.** Nothing was run against a real Core and nothing was installed on a physical device. The Claude context window is inferred from settings when the transcript does not state it.
- **No queued messages on Apple.** The Apple apps still have no queued-message UI.
