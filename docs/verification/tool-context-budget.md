# Tool context follows total capacity — 2026-10-25

## Behaviour

Tool results no longer disappear merely because they exceed 1500 estimated tokens,
fall outside the last six messages, or exceed 40% of the input budget in the
current turn. When the whole request fits, its projected results stay complete,
including across a new user turn. UI execution-detail disclosure is independent.

At every model boundary, including tool continuations, the worker counts the
current system prompt, tool schema, projected conversation and a 2500-token
overhead. The existing model input budget is unchanged:

```text
reserve = min(maxOutputTokens, 21000, floor(contextWindow / 4))
inputBudget = max(1, floor(min(contextWindow * 0.8,
  contextWindow - reserve - min(2048, contextWindow * 0.05))))
```

When the estimate reaches that budget:

1. An individual result that cannot fit with the required request overhead gets
   an explicit first page, original `entry:<id>` reference and continuation
   offset. This also prevents sending an individually oversized result to the
   summarizer.
2. Older complete turns are summarized at user-turn boundaries, retaining source
   references. Previously summarized or paged results use their projected bodies
   as summary input. Tool-call/result pairs are never split. Before that, each
   older tool result above an eighth of the window gets its own short summary.
   The turn summary is then sent in batches of at most half the window, each
   carrying the running summary forward; a single item too large for a batch is
   cut with its `entry:<id>` reference. A backlog far larger than the window —
   history accepted while the 1500-token folding still hid old results — no
   longer fails with “待整理内容超出模型窗口”.
3. If still over budget, older substantial tool-result bodies receive short
   summaries preserving operation status, key data, errors and pending issues.
   User inputs, the newest tool-call group and originals explicitly retrieved
   during the current turn are protected. Candidates are processed oldest first;
   this version does not infer which results semantically supersede others.
4. If the protected material still cannot fit, the task reports the capacity
   problem explicitly instead of silently removing it.

All reductions append projection edits or compaction records; raw transcript
entries remain intact. An incomplete summary does not install a replacement.
`memory.search` with `query="entry:<id>"`, `offset` and `limit` reads the stored
original without rerunning its tool, scoped to the same assistant. Offsets refer
to the serialized text's JavaScript string positions; default page size is 12000,
maximum 100000. Follow `page.nextOffset` until null. Image bytes are excluded from
text retrieval, with a marker directing the model to reread the original image
source. Stored image parts remain intact and retain the image-aware estimate.

## Verification

All checks used disposable Core data, synthetic providers and actual worker
processes; no verification mutations targeted the running user app.

- `pnpm exec vitest run server/personal-os/continuity.test.ts server/personal-os/token-estimate.test.ts server/personal-os/model-limits.test.ts`
  — 27 passed. Covers long results and images across continuations and turns,
  pressure-only reduction, exact user inputs and recent results, paired calls,
  pagination and original retrieval without re-execution, cross-assistant denial,
  invalid page parameters, incomplete-summary preservation, repeated historical
  compaction, image estimation and model limits.
- The continuity fixture's migration rewind now resets only migrations 16–23,
  whose schemas it removes, keeping already-applied connector migration 24.
- Server TypeScript check, changed-file lint and `git diff --check` passed.
- `node scripts/build-personal.mjs --core` passed. Vite reported its existing
  large-chunk advisory.

### Backlog compaction — 2026-10-27

Production conversation `b9568ec9` (about 1.47M estimated non-system tokens, ten
`broker` results of 90k–190k each, never compacted) failed its first turn after
the folding removal: the whole older history went to the 500k-window summarizer
in one request.

- Two new `continuity.test.ts` cases build history under a 400k window, then
  send a turn at 64k: one with five dominant tool results, one with five long
  replies. Both failed on the previous worker with the production error and pass
  now; every summarizer request stays below the window, and the long-reply case
  uses at least two batches with the carried summary.
- `pnpm exec vitest run server/personal-os/continuity.test.ts server/personal-os/token-estimate.test.ts server/personal-os/model-limits.test.ts`
  — 29 passed. The full `server/personal-os` run has one failure,
  `app.test.ts` “reads generic bundled skills…”, which fails identically
  without this change.
- A throwaway production-scale check (isolated Core, synthetic provider, real
  worker): ten attachment results totalling 1,072,575 estimated tokens, then a
  turn at 500k / 128k output. It completed in 2.7 s with 11 summarizer calls
  (largest 121,340 tokens), a final request of 4,852 tokens, ten context edits
  and one compaction; originals stayed retrievable by `entry:<id>`.
- Server typecheck, changed-file oxlint and `git diff --check` passed.

Deployed to Tokyo on 2026-10-27; see the
[release record](backlog-compaction-release-20261027.md).

## Limits and delivery

The fake provider validates request boundaries and persistence, not real-model
summary quality. Token counts remain estimates, particularly for images; model
usage receipts are authoritative. Current-turn summaries target at most 1024
output tokens and skip already edited, protected, or under-2048-token bodies;
many small results can therefore still produce an explicit capacity error.

Local source and build only. The running Core was not replaced, no client was
packaged, and GitHub/OSS publication was skipped. This Core policy applies to all
clients without changes to their native presentation code.
