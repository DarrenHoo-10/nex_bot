# Unified UI and role avatars — release 2026-10-24

The web UI, Core and all four client installers were built from
`7f95aba4edc5e20a399bdaa5f149173d4cdc1184`, after that commit was pushed to
`origin/main`. The accepted UI work was merged from `codex/ui-redesign` without
dropping main's Gmail, interactive HTML or remembered approval changes.

[Release nexbot-v0.9.11-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.11-preview.1)
was published at 2026-10-24 06:46 UTC. Its tag points to the build commit.

| Platform | Version | Delivery |
| --- | --- | --- |
| Web / Core | `7f95aba4` | Production HTTPS deployment |
| Windows | 0.9.11 | Unsigned x64 portable EXE, with the matching bundled UI |
| Android | 0.2.11, build 211 | APK signed with the same debug certificate as 0.2.10 |
| macOS | 0.2.7, build 9 | Apple Silicon DMG; ad-hoc signed, not notarized |
| iOS | 0.2.7, build 9 | Unsigned device IPA; installation requires signing/provisioning |

## Verification

All mutating checks used disposable synthetic accounts and owned fixture data.
The user's installed apps, credentials, conversations and existing simulator
were not used for verification.

- Full lint, frontend/server typechecks and locale checks passed. The avatar
  generator verified twelve roles and three byte-identical original image sheets.
- Seven targeted Vitest suites passed 78 tests; Electron update/local-UI suites
  passed six tests. The merged workspace passed all 45 real renderer scenarios.
- The exact Windows portable EXE passed 30 login, device, account-isolation,
  settings, logout and restart scenarios. All twelve bundled UI files matched
  the build output; private runtime data files were absent.
- Android passed 78 native unit tests and assembled successfully. Its exact
  asset bundle passed 24 workflow scenarios in Electron using a simulated native
  MessagePort bridge. The final APK's non-signature contents matched the tested
  APK and its bundled UI matched the build output. Signing used the original
  Windows-held key without moving that private key to the build host.
- NexClientKit passed 128 tests; NexMarkdown passed 24. Mac Release, iOS
  Simulator Debug and iOS device Release builds passed. Native hosted rendering
  suites passed all five tests on Mac and all five on an owned iOS simulator.
  These include avatars, charts and the interactive HTML runtime.
- Mounting the DMG read-only confirmed its 246 application files matched the
  verified build, and its deep/strict code signature verified. The IPA's version,
  bundle identifier, minimum OS, preview runtime and absence of signing secrets
  were checked.

Two release-time integration issues were corrected: Apple signing inputs now
use LF because the code-signing entitlement parser rejected CRLF, and the Android
renderer fixture follows main's MessagePort handshake. The native HTML test now
waits for both readiness and the first size measurement; these events arrive
independently. This test-only adjustment is recorded in `415559ea`; it does not
change the application inputs or the published build commit.

The Android shared-renderer check is not an Android WebView/device test. Physical
Android and iPhone acceptance, and an end-to-end updater replacement on a user's
device, were not performed in this release. iOS was not submitted to App Store
or TestFlight.

## Production and downloads

The actual Linux candidate passed isolated tests for all twelve avatar IDs,
version conflicts, restart persistence, legacy avatars, native canvas, the
interactive HTML shell and authentication boundaries. Its pure-JavaScript/UI
overlay retained the existing verified Linux native dependencies.

Deployment checked for active work, retained a restricted data/config backup and
the previous release, and switched the service with rollback handling. Database
integrity, identities, vault keys, model configuration, policies and record
preservation passed. Earlier content-addressed assets remain available to open
tabs. Public HTTPS returned the exact new HTML and all six current assets,
including three graphic sheets; health returned 200 and unauthenticated business
requests returned 401.

All four installers were uploaded to the private OSS release mirror and read
back for SHA-256 verification before the update manifest changed. The previous
manifest is retained privately for rollback. Public download and update endpoints
offered all four expected versions; downloading each public installer verified
its full size and digest. Current-version requests correctly returned no update.
The six GitHub release assets (four installers, checksums and source commit)
also matched local sizes and SHA-256 digests before publication.

| Installer | SHA-256 |
| --- | --- |
| Windows 0.9.11 | `687aa6d33cfcb4a7bd9aa401fff3622c48418bcf66b805cdc015e5081d0b43a0` |
| Android 0.2.11 | `28c1dbe43136c3747b17d11226c57a361dae4ae2fa5325dc511e3e29721b7c0f` |
| Mac 0.2.7 | `a0a7bfc0b93330d8d581872fd12a2676cc2fbc12c08345fa5b90d441284e5b76` |
| iOS 0.2.7 | `71e232a9f768f0c248326b64e74df235abf24322fc3445d2af11e71e5321aa6f` |

Operational receipts and build artifacts are under ignored
`release/ui-release-20261024/`. Server backups and credentials remain private;
neither is included in the repository or downloadable installers.
