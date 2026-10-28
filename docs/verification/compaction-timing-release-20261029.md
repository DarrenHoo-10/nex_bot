# Compaction timing: Core release (2026-10-29)

Core and web UI built from pushed main commit `7e8896013eb59ec209a366fcad595e5d3682f3b0`.
Behaviour and test evidence: [Compaction timing and failure handling](compaction-timing.md);
plan: [compaction timing](../plans/compaction-timing.md).

## Source

Branch `claude/compaction-timing` (from `76da59c8`) merged `origin/main` (`fa0f1601`, the memory
stop-loss release). Both had added migration 30; main's `assistant_memory_steps` keeps 30 and
`compaction_failures` became 31. The merged tree passed `pnpm exec tsc -b`,
`pnpm exec tsc -p tsconfig.server.json`, `pnpm lint`, `git diff --check` and
`pnpm exec vitest run server/personal-os src/personal scripts/testing/verification-docs.test.ts`
(406 passed, 1 pre-existing failure). The Mac and iOS apps were built on the Mac in a
temporary directory with a dedicated simulator (both removed); NexClientKit 151 tests passed.

## Deployment

- Overlay SHA-256 `62be703f52b5962cb315b06bf1749b70eb8325810a8dc23596278428dca15d40`, staged as
  `/data/nexbot/releases/main-7e889601-20261029` from `main-bb8e29b1-20261029`.
- Throwaway Core on Tokyo (synthetic model, real workers, 64k window, threshold S = 51,200):
  schema 31; UI assets, preview sandbox and 401s; three turns with ~6k-token results made **0**
  summarizer calls; the conversation grew past S over 9 turns with **0** summarizer calls in any
  turn; at 10 minutes idle maintenance was still ~45 minutes away; at 56 minutes it was armed and
  ran; with every summary cut off (`finish_reason=length`, the production failure) the run failed
  and recorded 10 targets with a ~30-minute backoff, nothing was scheduled during the backoff,
  and the next turn succeeded with **0** summarizer calls.
- Deployed with no active tasks: backup `/data/nexbot/backups/main-7e889601-20261029-pre`, drop-in
  `zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-compaction-release.conf`. Post-switch: health 200, six
  workspace databases at schema 31 with unchanged identity/model/secret/policy hashes and vault
  keys, 33 projections present as entry rows, 401s, no errors in the Core journal.
- Public `https://bot.nexorai.com.cn`: HTML and all seven assets byte-identical to the local
  build, `/health` 200, `/api/state` 401, preview CSP sandboxed.

## Not done

- No client was packaged. The “压缩阈值” label is live in the web UI (and the Windows client,
  which loads it from Core); Mac/iOS show it from their next release. Android has no such field.
- No real model provider was called: cache hit rates, the 1 h Anthropic cache tier through the
  user's gateway, and real digest quality are measured only once real conversations run.
- The user's Claude connection still uses the OpenAI-compatible protocol; the Anthropic cache
  changes apply once the user switches it.
