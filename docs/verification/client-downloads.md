# Downloadable client preview — 2026-10-18

Release tag: `nexbot-v0.9.1-preview.1`.

The GitHub prerelease distributes Windows 0.9.1 portable x64, Android 0.1.0
debug APK, and `SHA256SUMS.txt`. The product README links directly to the assets
and describes installation, upgrades and the current platform differences.
Only distributable binaries and their checksums are release assets; profiles,
credentials, signing keys, test logs and databases are excluded.

## Exact artifact checks

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `NexBot-0.9.1-x64-Client-Portable.exe` | 169150248 | `8ed6a070b1595318269c86240b6bb1a8b266f9d3e2dceca9aeff3c6b43db65bb` |
| `nexbot-0.1.0-debug.apk` | 12275192 | `d88d0b26dac524d131eef7eb8a5865efe3c1b754c20b5e5ba838480c1dfb1819` |

The actual portable EXE passed 30 isolated shell checks, including login,
restoration, automatic local control, pause/logout and account isolation. The
fixture used a disposable Core, synthetic identity/model and separate profile.
The bundled UI includes composer menus, username-initial avatars and independent
model limits with 256,000 / 32,000 fallback values.

Android was rebuilt from the current source. All 44 core tests and 26 app tests
passed. `apksigner verify` confirmed the v2 signature; package metadata confirmed
`com.nexorai.nexbot.debug`, version 0.1.0 / code 100, minimum SDK 26. The exact APK
was installed in a read-only temporary emulator instance and its main activity
launched successfully. The instance was stopped after verification. No physical
phone or production account was used.

Windows has no publisher Authenticode signature. Android uses the existing debug
signing key and is explicitly offered as a test build, not a store release. The
key remains outside the repository and release. Preserve the signing identity
for subsequent test APK updates.

Build evidence and release notes remain under ignored
`release/public-preview-20261018/`. On this host, Java's Unix-domain pipe failed;
setting `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=D:/TMP/nexbot-no-uds` to a
nonexistent directory let Java use its TCP loopback fallback for the build.
This is a build-process-only workaround, not an application setting.
