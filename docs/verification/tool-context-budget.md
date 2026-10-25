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
   as summary input. Tool-call/result pairs are never split.
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

## Limits and delivery

The fake provider validates request boundaries and persistence, not real-model
summary quality. Token counts remain estimates, particularly for images; model
usage receipts are authoritative. Current-turn summaries target at most 1024
output tokens and skip already edited, protected, or under-2048-token bodies;
many small results can therefore still produce an explicit capacity error.

Local source and build only. The running Core was not replaced, no client was
packaged, and GitHub/OSS publication was skipped. This Core policy applies to all
clients without changes to their native presentation code.
