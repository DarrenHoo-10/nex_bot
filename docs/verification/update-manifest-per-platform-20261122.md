# Release tag and notes per platform in the update manifest: Core deploy (2026-11-22)

## Problem

The update manifest had a single `tag` and a single `notes` field. The Apple-only 0.2.34 publish overwrote both for every platform, which broke two things:

- the homepage link "0.9.42 预览版发布说明" opened the Apple release page;
- outdated Windows and Android clients would have been offered their update with the Apple notes.

## Change (`749e2900`)

**Manifest entries.** Each entry now carries its own `tag`, `notes` and `publishedAt`, and `/api/client/update` and `/api/client/downloads` return the entry's values.

**Entries written before this change.** Core takes the tag from the OSS key (`nexbot/releases/<tag>/…`). It uses the manifest's notes and date only when the entry belongs to the manifest's own release; otherwise it returns them empty.

**`scripts/publish-client-update.mjs`:**
- stamps the three fields on new entries and on entries carried over from an earlier release;
- `--published-at=<ISO time>` keeps a release's original date when re-stamping;
- a later commit stops a forbidden-overwrite upload from crashing. OSS answers 409 and closes the connection while the body is still going out, and the late EPIPE was unhandled. The object is still read back and its digest checked.

**Development tests.** `server/personal-os/client-updates.test.ts` gained a partial-release case: a legacy entry, a stamped entry, a foreign-tag entry, and a malformed tag that falls back to the key's tag. The client-updates and client-downloads tests passed, 12 in total.

## Deploy

**Gate.** Static checks only (oxlint, `tsc -b`, `tsc -p tsconfig.server.json`, the locale catalogs), on the pushed `main` commit `749e29004f5301e1027c852743194ac09ab2bd46`.

**Build and staging.**
- Built with `node scripts/build-personal.mjs --core`.
- Staged on the Mac Air as `~/nexbot/releases/main-749e2900-20261122`, copied from `main-3cb740a6-20261122` plus the Core/UI overlay.
- The staging script checks for the new manifest code in `core/service.js`; the previous build lacks it.
- No migrations, so there was nothing to rehearse.

**Candidate.** The throwaway Core on synthetic data passed all of the 0.9.42 checks.

**Switch.**
- Run from a detached `deploy.py`.
- Data and config were backed up to `~/nexbot/backups/main-749e2900-20261122-pre` and the backup verified.
- Business-data hashes are unchanged across 6 workspaces.
- Local and public assets were verified (13 each).

**Public check.**
- The HTML and all 13 assets match the local build byte for byte.
- `/health` returns 200; unauthenticated API calls return 401.

## Manifest re-stamp

**Backups.** The manifest before the re-stamp is saved privately at `~/nexbot/backups/main-749e2900-20261122-pre/client-manifest-before-restamp.json`. The 0.9.42 manifest stays at `~/nexbot/backups/apple-0.2.34-20261122-pre/client-manifest.json`.

**Run.** The Windows and Android entries were re-published under `nexbot-v0.9.42-preview.1` with their original notes and `publishedAt` (`2026-11-22T09:18:17.249Z`).
- The dry run showed Mac/iPhone carried over with the Apple tag, notes and date, and every file and digest unchanged.
- Both installers already existed in OSS: nothing was overwritten, and both were read back and matched.
- The first run updated the manifest, then exited 1 on the late EPIPE described above.
- The identical second run, with the fix, exited 0.

**Result.**

| Platform | Version | Tag | `publishedAt` |
| --- | --- | --- | --- |
| windows | 0.9.42 | `nexbot-v0.9.42-preview.1` | 2026-11-22T09:18:17.249Z |
| android | 0.2.41 | `nexbot-v0.9.42-preview.1` | 2026-11-22T09:18:17.249Z |
| mac | 0.2.34 | `nexbot-apple-v0.2.34-preview.1` | 2026-11-22T10:42:18.665Z |
| ios | 0.2.34 | `nexbot-apple-v0.2.34-preview.1` | 2026-11-22T10:42:18.665Z |

## Verification (public URL)

**`/api/client/update`:**
- mac and ios at 0.2.33 are offered 0.2.34 with the Apple tag and notes; at 0.2.34 they get nothing;
- windows 0.9.41 and android 0.2.40 are offered 0.9.42 / 0.2.41 with the 0.9.42 tag, notes and date; their current versions get nothing;
- every offered download matched the manifest's size and SHA-256 and the local release files.

**Homepage:**
- the cards show Windows 0.9.42, Android 0.2.41, Mac 0.2.34 and iPhone 0.2.34, with download links equal to `/api/client/downloads`;
- "0.9.42 预览版发布说明" now opens `releases/tag/nexbot-v0.9.42-preview.1`.

**Clients.** No client was rebuilt. The clients read `notes` and `tag` from the same API response, whose fields are unchanged.
