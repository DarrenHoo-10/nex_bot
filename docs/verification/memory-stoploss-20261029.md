# Memory background step backoff and budget cap: Core release (2026-10-29)

Commit `bb8e29b1` (pushed `main`), deployed to Tokyo as `main-bb8e29b1-20261029`.
First step of the [memory redesign plan](../plans/memory-recall.md) (section 6).

## Problem

A failed understanding refresh never wrote `profile_at`, so the memory pump retried it about
every minute. Production (read-only): in the 12 hours before this release, one assistant made
241 `understanding` calls (about 4.75M tokens) and no understanding document was ever written;
its `daily_budget` of 10,000,000 did not stop it.

## Behaviour

- Each background memory step (`retain`, `consolidate`, `understanding`) records failures in
  `assistant_memory_steps` (migration 30) and waits 10 min, 1 h, then 6 h; a success deletes the
  record. Steps are independent; cancellation is not a failure; an exhausted budget waits 10 min
  without counting as a failure.
- The pass is next due at the earliest backoff end when every step is waiting, else on the usual
  30 s cadence.
- The enforced daily memory budget is `min(setting, 500,000)`; 0 also means 500,000. Settings
  input is unchanged; the save error now says "0 表示按上限 500000".

## Verification

- `pnpm exec vitest run server/personal-os`: 311 passed, 2 failed, 3 skipped. The failures were
  `server/personal-os/app.test.ts` "reads generic bundled skills…" (fails on `76da59c8` as well) and
  a `server/personal-os/client-transport.test.ts` "bad port" that passed when re-run alone. Memory and continuity
  suites after the wording fix: 51 passed. New tests cover both failure shapes (invalid JSON,
  `finish_reason:'length'`), the 10 min / 1 h / 6 h schedule, reset on success, independent steps,
  `next_attempt`, and the 500,000 cap.
- `pnpm exec tsc -b`, `pnpm exec tsc -p tsconfig.server.json`, `pnpm lint` and `git diff --check` passed.
- Release verifier (built Core, synthetic model; locally and in a throwaway Core on Tokyo): schema 30,
  UI assets, preview sandbox and 401s; a permanently failing understanding step made 1 call across
  60 pump ticks (the old code made one per tick), backed off 10, 60 and 360 minutes, retain kept
  running, a success cleared the record, and a 10,000,000 setting was enforced as 500,000.
- Deployed with no active tasks: backup `/data/nexbot/backups/main-bb8e29b1-20261029-pre`, drop-in
  `zzzzzzzzzzzzzzzzzzzzzzzzzzzzz-memory-stoploss-release.conf`. Post-switch: health 200, six
  workspace databases with unchanged identity/model/secret/policy hashes, vault keys and schema,
  401s, 33 projections present as rows; no errors in the Core journal.
- Public `https://bot.nexorai.com.cn`: HTML and all seven assets byte-identical to the local build,
  `/health` 200, `/api/state` 401, preview CSP sandboxed.

## Limits

- Production call counts after the switch are to be checked once enough time has passed; at the
  switch all enabled assistants were already in "今日记忆维护预算已用完".
- Core only; no client was rebuilt or published, so README and homepage are unchanged.
- The plan's "skip a batch after 3 failures" is not part of this fix; a poison batch is retried
  every 6 h.
