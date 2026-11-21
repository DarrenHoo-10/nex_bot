# CI

Since 2026-11-21 the repository keeps only core-path tests: NexBot Core with
Agent mode (`server/personal-os`), its web UI (`src/personal`) and the contracts
they share (`shared`), 156 files. The 1,037 other test files (the old OpenMausBot
desktop server, its UI components and libraries, Electron, scripts, companion,
enterprise, evals and Cloudflare workers) were deleted, with the CI jobs, smokes,
evals and shard balancing that ran them. None of the 200 main runs from
2026-10-20 to 2026-11-21 had passed: the static job failed first, so the test
shards never ran, and releases ran the whole suite locally instead, more than an
hour one file at a time.

Deploys and releases do not run tests (AGENTS.md, "Shipping a change"): only the
static checks below. CI runs the core tests after a push; a failure there is
fixed afterwards and never holds a deploy.

## Jobs

- **`typecheck + lint`** (`static`): CI selection, locale catalogs, typecheck,
  lint, the Electron syntax check and the production UI build.
- **`core tests`**: `pnpm exec vitest run` on Ubuntu, one file at a time
  (`vite.config.ts` keeps `fileParallelism: false`: the Core tests start real
  servers and fake CLIs).
- **`Kotlin tests + Android fixtures`** (`android-core`): advisory, only when
  the change selects it. Runs the Kotlin and app suites, builds the debug APK
  and compares the captured fixtures against a disposable Core.
- **`CI`** (`gate`): passes when `static` and `core tests` passed, or when the
  selection chose the docs-only path and `core tests` was skipped.

## Selection

`scripts/ci-scope.mjs` decides what runs:

- Root Markdown files, Markdown under `docs/`, and `.github/FUNDING.yml` alone
  do not run the core tests or the Android job.
- Any other change runs the core tests.
- A change under `android/` runs the Android job instead.
- A change to the fixture capture, to CI selection itself, or to a workflow
  runs both.
- Main pushes, merge groups and manual runs always run everything. Empty or
  unreadable PR diffs also fall back to everything.

## Concurrency

A new PR push supersedes that PR's older checks. Main keeps one run going and
one waiting, so a burst of merges costs two runs instead of one per merge. A
PR's group is named by its number, never by `github.ref`: a merged PR's closed
event reports the base branch as `github.ref`, which made every merge cancel
main's CI (fixed Oct 3 2026). `ci-stop-closed.yml` cancels a PR's run when the
PR is merged or closed.

## Required check

The `main-ci-gate` ruleset requires the single `CI` check (it replaced the
three legacy `typecheck + test (<os>)` names in September 2026). Renaming the
`gate` job needs the ruleset updated first, or every PR waits forever.
