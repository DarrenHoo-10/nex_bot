# Flat layout in client windows — release 2026-10-24

The Windows client showed the workspace as a rounded, shadowed card inside the
window's own frame, so the interface looked nested twice. The page now marks
client shells (`window.nex.mode === "client"`, set by the Electron preload and the
Android bridge) with `data-shell="1"` on `.workspace-stage`, and in that mode the
stage has no padding and the workspace has no border, radius or shadow. The browser
keeps the floating card, and layouts up to 1040 px were already flat. Mac and iOS
are native SwiftUI and are not affected.

The fix is `eabd49d0`; the Windows version bump is `64d91101`
(`64d91101811407d667e01165bcb2b10b1ebca167`). Both were pushed to `origin/main`
before anything was deployed or packaged.
[Release nexbot-v0.9.13-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.13-preview.1)
has its tag at that commit.

| Platform | Version | Delivery | SHA-256 |
| --- | --- | --- | --- |
| Web / Core | `64d91101` | Deployed to Tokyo as `main-64d91101-20261024` | — |
| Windows | 0.9.13 | Unsigned x64 portable EXE | `93f564f68c62d66038fcf85de0f270aa5cefff5806f4d3d6551f36c60ca0e958` |
| Android | 0.2.12 | Unchanged, still the 0.9.12 release asset | — |
| macOS / iOS | 0.2.8 | Unchanged, still the 0.9.12 release assets | — |

## Verification

All checks used synthetic data and owned fixtures.

- Rendering (throwaway renderer, web mode against client mode): in client mode the
  stage padding and the workspace's border width, radius and shadow are all 0 and the
  workspace fills the viewport; in web mode every value is unchanged.
- Production: the deploy ran with no active tasks, data and config were backed up
  first, and the data hashes were unchanged afterwards. The public HTML and every
  referenced asset match a fresh build of the release commit byte for byte; health
  200, unauthenticated API 401.
- Windows: the exact EXE passed the shell login smoke (`scripts/smoke-shell-login.mjs
  --exe`), its twelve bundled UI files match the build output, and it is not
  Authenticode-signed.
- GitHub: the EXE and `SHA256SUMS.txt` match the local files by size and SHA-256.
- Update channel: the EXE was uploaded to OSS and read back before the manifest
  changed. After Core re-read it, `/api/client/update?platform=win` offered 0.9.13 to
  0.9.12 and nothing to 0.9.13; downloading the offered installer matched the
  manifest size (174011160 bytes) and digest.

## Not verified

- No visual check in a real Windows window, and no end-to-end replacement of an
  installed client through the updater.
- Android was not rebuilt. Its bundled UI still has the old layout, and the flat rule
  applies to it only through the page served by Core.
- Mac and iOS were not rebuilt because they do not use this layout.

## Process notes

The deployed overlay is a clean build of `main`. It lacks several unreferenced
server files (artifact, offline, export-fonts, recovery) that earlier overlays
carried from a work-in-progress build in another checkout; nothing on `main`
references them, and a throwaway Core started from the release passed its checks.

The previous Tokyo release (`main-7f7a5036-20261024`), the pre-deploy backup
(`/data/nexbot/backups/main-64d91101-20261024-pre`) and the previous update manifest
(ignored `release/ship-0.9.13/manifest.before.json`) are kept for rollback.
