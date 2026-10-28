# Long conversations: context and memory (2026-10-28)

Implements [the long-context plan](../plans/long-context-and-memory.md); released on 2026-10-28 ([release record](long-context-release-20261028.md)). Originally on branch
`claude/stoic-rubin-0b1920` (`037b6006`…`c76dcd5f`).

## Behaviour

- **Stable request prefix.** The system message carries only the stable prompt;
  time, devices, peer availability, history index, recalled memory and related
  episodes are a per-request `<system-reminder>` placed after the history and never
  persisted. A system entry is written to the projection only when the stable prompt
  changes; stale ones are dropped on load.
- **Projection rows.** The Pi projection is stored one row per entry and saves
  write from the first difference only. Legacy blobs are copied once and verified;
  the legacy table is kept untouched for rollback.
- **Calibration.** Each model keeps an EMA of provider input tokens / estimate
  (0.3–1.5). It only decides when reduction starts; hard window checks stay raw, and
  a raw estimate ≥ 90% of the window always starts reduction.
- **Working budget.** Default `min(64000, input budget)`, set per model as
  “工作上下文”. Reduction starts at the budget and runs to half of it. A request is
  refused only when it cannot fit the input budget.
- **Turn-start digests.** Tool results over 1500 tokens in turns older than the
  latest completed one are summarized individually; images there become
  `[图片 attachment:<id>]`. Originals remain retrievable with `entry:<id>`.
- **Background maintenance.** 10 s after a turn, an idle conversation with work runs a
  maintenance worker (`maintenance_runs`) that applies the same reduction without
  calling the chat model. Input stops it at once; it never takes the last worker slot;
  500k tokens per conversation per day; separate from the memory budget.
- **Episodes.** A ≥ 6 h gap or “新话题” closes the previous episode at the next
  input: a ≤ 300-token brief starts the new context and a structured archive is
  searchable (`episode:<id>` and text), feeds long-term memory with hash-verified
  sources, and is recalled into the reminder. Invalid archives keep the episode open.
- **Working note** is updated by Core from `{workingNote, history}` compaction output,
  version-checked against notes the model writes.
- **Tidy-up model.** All summaries use the assistant's memory model, else the chat
  model, with that model's own window for batching.

## Verification

Isolated fixtures only (temp data, synthetic model servers, real worker processes).

- Unit and integration tests: `server/personal-os/request-prompt.test.ts`,
  `server/personal-os/projection.test.ts`, `server/personal-os/calibration.test.ts`,
  `server/personal-os/maintenance.test.ts`, `server/personal-os/episodes.test.ts`,
  additions to `server/personal-os/continuity.test.ts`,
  `server/personal-os/model-limits.test.ts` and `server/personal-os/app.test.ts`.
- `pnpm exec vitest run server/personal-os src/personal scripts/testing/verification-docs.test.ts`:
  374 passed, 1 failed, 3 skipped (46 files). The device-image test in
  `server/personal-os/app.test.ts` failed once in an earlier run and passed alone
  twice and in this run. The one failure is `server/personal-os/app.test.ts` “reads generic bundled skills…”, which also
  fails on `dd45eb9f`. Eight other repository-wide failures (Grok profile, lending
  timing, date locale, ApprovalCard) fail identically on `dd45eb9f`.
- `pnpm exec tsc -b`, `pnpm exec tsc -p tsconfig.server.json`, changed-file oxlint
  and `git diff --check` pass.
- End-to-end on the built Core (`node scripts/build-personal.mjs --core`, then the
  untracked `release/verify-long-context/verify.mjs`): four turns each reading a
  20,000-character attachment at a 200k window, synthetic usage at 60% of the
  estimate. Result: identical system message on every request; 3 maintenance runs,
  all ended, 3 `maintain` usage rows without a task; calibration 0.54 after 8
  receipts; the following turn made **0** summarizer calls with a 35,750-token request
  (below the 64k budget); projection rows equal entries; one prompt-bearing system
  entry; digested originals retrievable; “新话题” then a message produced an episode
  archive found by `episode:<id>`; the working note was written by Core.
- Apple: NexClientKit `swift test` 137 passed; macOS and iOS-simulator
  `xcodebuild` succeeded on the Mac in a temporary directory with a dedicated
  simulator, both removed afterwards.

## Limits

- No real provider was called: cache hit rate, real summary quality and strict
  gateways' acceptance of a user message after tool results are unmeasured.
- No visual check of the new “工作上下文” field or “新话题” item on Web, Mac or iOS.
  Android has neither yet.
- Maintenance is scheduled only after a turn ends (not after a Core restart), and
  does not close episodes; a failed digest may be retried once per turn within the
  daily cap.
