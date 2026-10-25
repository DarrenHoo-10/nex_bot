# Gmail Connect from the connector catalog — release 2026-10-24

The connector list shows **连接** on the Gmail row while no mailbox is linked, so
authorization starts without opening the detail page. Linked rows still show
**已添加** and open the details; an unavailable service shows its previous state.
Opening the details while an attempt is pending abandons it, as leaving the
details already did.

All installers were built from `04409c8701d7214cf41081f56b7ffed3972c0c21`, after
it was pushed to `origin/main`. [Release nexbot-v0.9.12-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.12-preview.1)
was published at 2026-10-24 08:54 UTC with its tag at that commit.

| Platform | Version | Delivery | SHA-256 |
| --- | --- | --- | --- |
| Web / Core | `7f7a5036` | Already in production; the release commit changes no Core or web code | — |
| Windows | 0.9.12 | Unsigned x64 portable EXE | `6bebc0c17dfadc32a3c5aa4c9780bce10c6a9671d3543c920afc675ecd0b631f` |
| Android | 0.2.12, build 212 | Debug-signed APK, same certificate as 0.2.11 | `b6c7fde2ebb116bcc63e4d1c7a8ef9f2fcab5777fa2b640fb43515b0ba05f48e` |
| macOS | 0.2.8, build 10 | Apple Silicon DMG, ad-hoc signed, not notarized | `15e124050b452e82849bcba5c841d17aab94f8372fa2ef05987eb6788f21c711` |
| iOS | 0.2.8, build 10 | Unsigned device IPA | `b1e7b9265c466154c7477360de77a72e303d92fa06199e053173cb7a87bf31be` |

## Verification

All checks used synthetic data and owned fixtures.

- Production: the public JS and CSS match a fresh build of the release commit byte
  for byte; health 200, unauthenticated API 401.
- Web renderer (`scripts/smoke-gmail-connectors.mjs`): eleven groups passed, including
  the direct button, blocked popup, cancellation, 390 px layout, abandoning by opening
  the details, and a full catalog connection that grants no tools.
- Windows: the exact EXE passed 20 login, device, restart and logout scenarios
  (`scripts/smoke-shell-login.mjs --exe`). Its twelve bundled UI files match the build
  output and it is not Authenticode-signed. The same Gmail groups also passed in the
  real client shell (`--shell`, real preload and system-browser path), but that run
  is unreliable: of five runs, three passed and two failed, one at the shell's
  startup wait before any Gmail step; the other failure's cause was not captured.
- Android: 78 native unit tests passed; the APK verifies under signature scheme v2
  with the same certificate as the published 0.2.11 and bundles the new UI.
- Apple, on a Mac (macOS 15.6, Xcode 16.4) from a fresh clone of the release commit:
  Mac Release, iOS Simulator Debug and iOS device Release builds passed; five native
  rendering tests passed on Mac and five on a dedicated iOS simulator. The DMG's
  246 application files pass `codesign --deep --strict`; both packages report
  0.2.8 (build 10), contain the new code and carry no signing material. Earlier, on
  the same sources, `NexClientKit` passed 128 tests and the catalog states
  (connect, authorizing, added, unavailable; light, dark, 390 pt) were rendered.
- GitHub: all six assets match the local files by size and SHA-256.
- Update channel: the four installers were uploaded to OSS and read back before the
  manifest changed. After Core re-read it, `/api/client/update` offered the new version
  to each previous version (Windows 0.9.11, Android 0.2.11, Mac and iOS 0.2.7) and
  none to the new one. Downloading each offered installer matched the manifest size
  and digest. The previous manifest (tag `nexbot-v0.9.11-preview.1`) is retained
  privately under ignored `release/ship-0.9.12/`.

## Not verified

- No physical Android phone, iPhone or real Google account, no native tap-through on
  Apple (the states are static renders), and no end-to-end replacement of an installed
  client through the updater.
- The Mac build step generated its icon file locally because it is not tracked.
- iOS was not submitted to the App Store or TestFlight.

## Process notes

The Apple release script chose the first iPhone simulator, which was the user's
booted one. It now honors a `SIM_ID` override, and this release used a dedicated
simulator that was deleted afterwards. Files copied from a Windows checkout to the
Mac carry CRLF and break its bash scripts, so release builds there use a fresh clone.
