# Compaction timing and failure handling (2026-10-28)

Implements [the compaction timing plan](../plans/compaction-timing.md) on branch
`claude/compaction-timing`, on top of the long-context work
([record](long-context-memory.md)). Not merged, deployed or packaged.

## Behaviour

- **Lines.** H is the input budget (`modelInputBudget`, unchanged). S is the
  compaction threshold: the `context_budget` setting, default 256k, never above 80% of
  the window nor above H minus 2k (`workingContextBudget` in
  `server/personal-os/model-limits.ts`). T is 0.4 × S. Calibrated estimates decide S
  and T; the raw estimate decides H, and the raw 90%-of-window net still counts as over H.
- **At or below S** nothing is summarized, digested or edited, and no maintenance is
  scheduled: the request prefix stays byte-stable. The unconditional turn-start digest
  of old tool results is gone, and so is "old digest candidates exist" as a maintenance
  trigger.
- **Between S and H** the turn does nothing. Background maintenance
  (`MAINTAIN_IDLE_MS`, 55 min) starts only when the context is above S and the
  conversation has been idle that long since its last model request ended
  (`model_invocations.finished_at`, else the last task time). New input stops it.
- **Above H** the turn reduces synchronously to T. Order inside one reduction, all
  edits before the next request: (1) paging of results too large for the input budget,
  (2) individual digests of tool results over 4000 tokens in turns older than the latest
  completed one, largest first, (3) if still above T, the turn-boundary history fold
  (batched, carrying the previous summary), (4) old images become
  `[图片 attachment:<id>]` markers as part of that reduction, (5) only if the request
  still does not fit, results of earlier tool calls of the current turn.
- **After a restart** `scheduleStartupMaintenance` arms every conversation above S by its
  last request time (at least 15 s after start, so a restart does not launch them all).
- **Failures never fail the turn.** Digests, history folds, episode archives and the
  paging stage log nothing user-visible, skip, and keep the originals. Only a request
  that still does not fit H after all of that reports the existing capacity error.
  Cancellation still propagates.
- **Single-result digest** has its own instruction (only this result, 300 characters,
  paths, IDs, numbers and errors verbatim, no working note) and keeps
  `summaryMaxTokens: 1024`. A reply cut off at the cap is kept when it is at most 30% of
  the original, with “（摘要不完整，原文 entry:<id>）”; otherwise it is a failure.
  `assistantCompletion` returns `{ text, truncated }` for callers that pass
  `allowTruncated`; others still get an error (`TruncatedOutput`). Usage is booked as
  before.
- **History batches** get an output cap of `min(8192, max(2048, 10% of the batch input))`
  (still bounded by the tidy-up model's own maximum). A cut-off batch is split in half
  and retried once; if that fails too the whole fold fails and nothing partial is
  installed.
- **Failure records.** `compaction_failures(runtime_id, target, attempts, next_at,
  last_error, updated_at)` (migration 30, `server/personal-os/compaction-failures.ts`);
  `target` is `entry:<id>` or `range:<first>..<last>`. Backoff 30 min after the first
  failure, 6 h after the second, never from the third. Maintenance skips targets in
  backoff and is not scheduled when every candidate is blocked; two failed runs in a row
  (a run whose every summary failed counts as failed) pause the conversation's
  maintenance for 6 h. Only a request above H tries a blocked target again, once per
  worker. A success deletes the record; so do forgetting an assistant, clearing a
  runtime (`forgetFence`) and a compaction that folds the target away. The 500k tokens a
  day per conversation cap is unchanged.
- **Cache.** The Anthropic `system` keeps the array the SDK built and only its text is
  replaced, so `cache_control` stays on it (`server/personal-os/request-prompt.ts`). For
  Anthropic-protocol requests the worker wraps the agent's `streamFunction` and passes
  `cacheRetention: "long"`, the SDK's own option, so `cache_control` carries
  `ttl: "1h"` on the system prompt, the conversation breakpoint and (when supported)
  the tools. No environment variable is used; the model connection and protocol are
  untouched.
- **Setting label.** “工作上下文（Token）” is now “压缩阈值（Token）” in Web and the
  Mac and iOS settings, and in the validation message on Core and in
  `NexClientKit`. Android has no model-limit settings.

## Verification

Isolated fixtures only (temp data, synthetic model servers, real worker processes). No
production host, SSH, Mac or real provider was touched.

- New: `server/personal-os/compaction-timing.test.ts` (backoff, give-up, repro of
  `finish_reason=length` on a single-result digest, accepted-if-short rule, run pause,
  synchronous reduction order, failing fold with a request that fits, batch split and
  no-partial-install, record cleanup, startup scheduling),
  `server/personal-os/cache-retention.test.ts` (real worker, Anthropic and OpenAI
  request bodies: `cache_control` with `ttl: "1h"` on the system prompt and the
  conversation, none on OpenAI).
- Rewritten for the new rules: `server/personal-os/maintenance.test.ts` (nothing below
  S, 55 minutes of idle with an injected clock, one run that digests before folding and
  ends below T, digests alone suffice, abort on input, slot, daily cap, shutdown),
  `server/personal-os/continuity.test.ts` (≤ S multi-turn: zero summarizer calls and a
  byte-stable prefix; > H: reduces to T; capacity error only when every reduction failed
  and the request still does not fit; migration 30; images stay below S),
  `server/personal-os/model-limits.test.ts` (S, the 256k default and caps),
  `server/personal-os/request-prompt.test.ts` (cache marker kept),
  `server/personal-os/episodes.test.ts` (turns that need a reduction are now bulky
  enough to exceed H instead of relying on a tiny threshold; digest instruction),
  `server/personal-os/app.test.ts` (Anthropic `system` is an array with the marker).

### Commands and results

- `pnpm exec vitest run server/personal-os src/personal scripts/testing/verification-docs.test.ts`
  (run in the background, about 13 minutes): 394 passed, 2 failed, 3 skipped (49 files).
  The two failures: `server/personal-os/app.test.ts` “reads generic bundled skills…”
  (the accepted pre-existing one) and `server/personal-os/image-models.test.ts`
  “does not publish an image when stopped during object storage upload”, a 25 s timeout
  under load that passes alone (9 of 9). The earlier full run had the known
  `server/personal-os/gmail-connectors.test.ts` “bad port” flake instead.
- After a last small change to the episode-archive skip rule: `server/personal-os/episodes.test.ts`,
  `server/personal-os/compaction-timing.test.ts`, `server/personal-os/maintenance.test.ts`
  and `scripts/testing/verification-docs.test.ts` together: 64 passed.
- `pnpm exec tsc -b`, `pnpm exec tsc -p tsconfig.server.json`, `pnpm lint` and
  `git diff --check`: no findings.
- Mutation check: with the worker's `cacheRetention` set to `"short"` the
  `server/personal-os/cache-retention.test.ts` ttl assertion fails.

## Limits

- No real provider was called: cache hit rates, the 1 h tier's acceptance by a gateway,
  real digest quality and how often a digest is cut off are unmeasured. The `ttl: "1h"`
  marker is sent to any Anthropic-protocol endpoint, including gateways that may reject it.
- OpenAI-compatible endpoints (including Claude through one) get no cache marker; their
  caching is the provider's.
- Web, Mac and iOS labels were not looked at; the Apple files were edited as text and
  not built here.
- The idle clock is the end of the last model request, not the last user message; a
  conversation with a long answer counts from the end of that answer.
