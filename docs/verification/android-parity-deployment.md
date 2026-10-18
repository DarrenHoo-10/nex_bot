# Android parity and conversation model selection — deployment 2026-10-18

The shared workspace changes and mobile reference screenshots were committed in
`4d1669cd`, then merged with the existing native Apple clients on remote main.
No Apple client work was overwritten. The final follow-up also corrects a test
annotation and updates release documentation.

## Verification

- 41 targeted Vitest cases passed; frontend and backend TypeScript checks passed.
- Android Core 47 and App 26 tests passed. The debug-signed 0.2.0 APK passed v2
  signature verification and 20 actual APK/WebView fixture checks.
- The exact Windows unpacked package passed 24 isolated shell checks, including
  login restoration, automatic device connection, pause/logout and account
  isolation.
- The Linux candidate passed eight isolated checks: per-assistant model selection,
  authentication, real worker model/output limits, attachment upload/send/download,
  permission mode, restart persistence and restoration of the default model.

All feature mutations used synthetic identities and owned temporary data. The
Android document picker / Save As still needs physical-device verification;
see [Android workspace evidence](android-workspace.md).

## Production

The Core is running `android-parity-20261018`. Both existing workspaces had no
active work before the change. A restricted server-side data/configuration backup
and the previous executable were retained before the service was switched.
Post-deployment checks confirmed preserved vaults, identity bindings, model and
memory settings, record counts and database integrity. Old hashed assets remain
available for already-open clients.

Public HTTPS health returned 200. The HTML and all three referenced assets
matched the candidate byte for byte; unauthenticated API requests returned 401.
Production checks were read-only; no live conversation was used for testing.

## Local installation and downloads

The Windows installation was replaced with the verified candidate and reopened.
All 664 shipped files matched their source hashes. The encrypted saved-login file
was unchanged during replacement; the preceding installation is retained for
rollback. Private operational receipts stay under ignored `release/` directories.

`nexbot-v0.9.1-preview.2` contains the Windows 0.9.1 portable EXE, Android 0.2.0
APK and checksums. Windows remains unsigned; Android remains debug-signed.
The Windows version stays 0.9.1; the release tag distinguishes this preview.
