# OpenMausBot agent notes

When release verification exercises a server or conversation change, follow
[`docs/verification/README.md`](docs/verification/README.md). Verify mutations
only in an isolated fixture.

More specific `AGENTS.md` files override this note within their directories
except for the commit, push, and release rules below.

## Commits, pushes, and release checks

- 提交和推送代码时只做静态检查，运行 pre-push 的 lint、类型检查和多语言校验。
  严禁在此阶段构建、打包或手动运行测试。推送后由 CI 自动运行核心链路测试。
- 构建、打包和手动测试只在用户明确要求的发布准备阶段执行，该阶段无需另行审批。
  此规则也适用于在 Mac 上直接执行或通过 SSH 执行的命令。严禁在日常开发或提交推送时自行发起 Mac 构建或测试。

## Production deploys and releases

Deploy production (Core, web UI) and build published client packages only from
a commit on `main` that has been pushed to `origin`. Never deploy or publish from
any other branch, a worktree branch, or uncommitted files. Merge the change into
`main` first. This rule is not overridden by subdirectory `AGENTS.md` files.

项目必须用主分支（`main`）部署线上，严禁用非主分支或未提交的代码部署线上或打包发布。

## Shipping a change

For a user-requested release, follow the steps below and report any verification
limits.

1. **Source.** Merge into `main` and push. Re-check `origin/main` right before
   pushing. If it moved, integrate it without rewriting pushed history, then
   rerun the static checks on the merged tree. Build release artifacts from the
   pushed commit. If GitHub is unreachable, use the machine's proxy on git/`gh`
   commands only (`git -c http.proxy=…`, `HTTPS_PROXY=… gh`). Never change global
   config.
   Use the static-only pre-push hook (lint, typecheck, locale catalogs). CI runs
   the core-path tests in `server/personal-os`, `src/personal`, and `shared` after
   the push. Check that run afterwards and fix what it finds. The release does
   not wait for CI. Perform artifact checks during release preparation as
   described below.
2. **Core and web UI → Mac Air** (`ssh mac-air`; root `~/nexbot`). Since
   2026-11-14 production Core runs there; Tokyo's Core is retired, so never
   deploy to it. The launchd job `gui/<uid>/cn.nexorai.nexbot-core` runs
   `~/nexbot/run-core.py`, which names the active release. Core listens only on
   `127.0.0.1:8799`, and public traffic reaches it through Cloudflare and the
   Seoul relay. Build with `node scripts/build-personal.mjs --core`, package
   `core`, `ui`, `package.json` and `SOURCE_COMMIT` as an overlay, and stage a new
   `~/nexbot/releases/main-<sha8>-<date>` copied from the current release. Before
   deploying, rehearse any new migrations on SQLite `.backup` copies of every
   workspace database (`data/core.db` and `data/account-workspaces/*`), then
   verify the candidate in a throwaway Core. Deploy only with no active tasks,
   from a detached (`nohup`) process on the Mac so a dropped SSH session cannot
   interrupt it: back up data and config to `~/nexbot/backups/<release>-pre`,
   switch by pointing `run-core.py` at the new release and restarting the launchd
   job, roll back automatically on any failed check, and confirm data hashes are
   unchanged. Reuse the newest `release/deployment-mac-air-*/` scripts in the main
   checkout as the template. Verify over the public URL: the HTML and every
   referenced asset match the local build byte for byte, `/health` is 200 and
   unauthenticated API calls are 401.
3. **Every client the change touches.** Web UI code is shared by Web, Windows
   (loaded from Core, and bundled in the installer) and Android (bundled in the
   APK). macOS and iOS are native SwiftUI in `apps/apple`: when a UI behaviour
   changes, update its Apple equivalent in the same task. During release
   preparation, use `ssh mac-air` for Apple builds and tests. Copy sources into a
   fresh temporary directory there, convert CRLF to LF (a Windows checkout
   breaks bash scripts), and never touch the user's existing checkouts.
   Release builds come from a fresh `git clone` of the pushed
   commit on the Mac (it reaches GitHub directly): run
   `corepack pnpm install --frozen-lockfile` and `node scripts/build-nexbot-icons.mjs`
   (the icon files are generated, not tracked), create a dedicated simulator with
   `xcrun simctl create` and pass it as `SIM_ID` to `release-preview.sh`, so the
   user's booted simulator is never used. Delete the simulator and directory afterwards.
4. **Packages.** Build every platform the change reaches from the pushed commit:
   Windows `pnpm package:client:win`; Android
   `./gradlew --no-daemon :app:assembleDebug`
   in `android/` (JDK 17, Android SDK 36, the machine's debug key, so updates only
   install over builds signed with it); Mac/iOS `apps/apple/scripts/release-preview.sh`
   on the Mac (it skips its render tests unless `RENDER_TESTS=true`). Clients update by comparing version numbers, so bump the version
   (`electron-builder.client.yml`, `android/app/build.gradle.kts`,
   `apps/apple/project.yml`) for every platform you ship, and never replace the
   bytes of an already published version or asset name. Check each exact artifact,
   not only the source: Windows with `node scripts/smoke-shell-login.mjs --exe=<exe>`,
   Android's version and `apksigner` (same certificate as the published build),
   Mac/iOS version, signature and bundle contents.
5. **Publish.** Create a GitHub pre-release tagged `nexbot-v<windows>-preview.N`
   (Apple-only: `nexbot-apple-v<version>-preview.N`) at the build commit, with a
   Chinese title and notes (platform/version table, install notes, what was and
   was not verified), the installers, `SHA256SUMS.txt` and `SOURCE_COMMIT.txt`.
   Check uploaded sizes and digests against the local files. Then mirror to OSS
   and update the in-app update manifest with `scripts/publish-client-update.mjs`
   on the Core host (`--dry-run` first; see
   [`docs/verification/client-updates.md`](docs/verification/client-updates.md)).
   Keep the previous manifest privately for rollback. Then verify the result: GitHub
   asset digests match the local files; `/api/client/update?platform=<p>&version=<old>`
   offers the new version (Core re-reads the manifest every five minutes) while the
   current version gets none; downloading each offered installer matches the
   manifest size and SHA-256. A finished background command is not success: read
   its result before moving on.
6. **README, homepage and records.** Every release must update both the README
   and the public website homepage together. Keep each platform's displayed
   version, download entry, release link and installation note consistent with
   its latest published installer; platforms not rebuilt retain their latest
   verified release. The homepage must consume the shared download manifest for
   every published platform, including Mac and iPhone, rather than link to source
   build instructions. Verify the deployed homepage's actual download links and
   versions against the published files; updating only the README or only the
   release page is incomplete. Add a `docs/verification/<topic>.md` record with
   the evidence and limits, and link it from `docs/verification/README.md`.

   只要有发版，README 和网站主页必须一起更新，并核对线上实际版本号与下载链接；
   不能只更新发布页或其中一处。未重发的平台保留其最新已验证版本。

## Product UI copy

Keep product screens concise. Do not add explanatory paragraphs, implementation
notes, permission tutorials or redundant subtitles unless the user requests them.
Use labels, actual status, necessary errors and direct controls. Device login
starts local control automatically; retain Pause/Resume and stop on logout.
