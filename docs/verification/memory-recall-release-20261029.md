# Memory recall redesign: all-platform release (2026-10-29)

Release: [nexbot-v0.9.19-preview.1](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.19-preview.1).
Core, web UI, Windows 0.9.19, Android 0.2.18 (218) and Mac/iOS 0.2.13 (15) were built from pushed
main commit `374cae869745b662c174f291a001c789ced59489`. Plan: [memory-recall](../plans/memory-recall.md);
first step released separately: [memory stop-loss](memory-stoploss-20261029.md).

## Behaviour

- **Core memory** (≤ 1500 tokens) in the stable prompt: long-term facts about the user and a topic index;
  `memory.core.update` and an owner editor on Web, Mac and iOS.
- **Recall once per task** from the current input only, cached for continuations; skipped for inputs under 4
  characters; ≤ 2000 tokens (1000 without rerank), ≤ 400 per item.
- **Hybrid retrieval**: FTS5 trigram BM25 + vectors (cosine) → RRF → rerank; every provider failure degrades
  to what remains. "记忆检索" settings for embedding and rerank, each custom → server default → off; keys
  encrypted, never returned.
- **Topic memory**: new facts merge into the closest topic (cosine ≥ 0.75, else BM25 containment ≥ 0.5) or
  create one; stricter extraction (no assistant narration or one-off details); the observation and understanding
  layers are retired. A background, resumable migration triages existing memories into topics.
- **Working notes per conversation**, ≤ 1000 tokens; over-cap Core notes are compressed, never truncated.
- Removed from prompts: the 15-document dump, other conversations' recent messages, keyword history recall,
  episode recall, per-request recall and forced understanding documents.

## Source

- The memory branch merged `origin/main` (compaction timing) as `b3501fe5`. Production had applied main's
  migration 31 (`compaction_failures`), so the memory migrations are 32 (trigram), 33 (vectors),
  34 (core memory, recall cache, conversation notes) and 35 (topics). Six tests whose thresholds were tuned to
  the previous prompt sizes were adjusted; no production code changed in the merge fix.
- `pnpm exec vitest run server/personal-os src/personal scripts/testing/verification-docs.test.ts`: 491 passed,
  3 failed, 3 skipped. Failures: `server/personal-os/app.test.ts` "reads generic bundled skills…" (fails on
  earlier main too) and two `FETCH_BAD_PORT` random-port failures, each passing 3 of 3 when run alone.
  `pnpm exec tsc -b`, `pnpm exec tsc -p tsconfig.server.json`, `pnpm lint` and `git diff --check` passed.

## Core and web UI → Tokyo

- Migration dry run on `VACUUM INTO` copies of all six production `core.db` files with this release's
  `CoreStore`: 31 → 35 in under 40 ms each, `integrity_check` ok, no foreign-key errors, no row-count changes;
  FTS rows equal the 191 active memories; every working note moved to its conversation.
- Throwaway Core on Tokyo with synthetic chat, embedding and rerank servers: schema 35; retrieval defaults
  effective without exposing URL or key; three messages produced two topics, narration ("进程号 13800") not
  recorded; core memory in the stable prompt; "好的" made no recall and no retrieval call; a task with three
  model requests recalled once with a byte-identical 117-token block containing the relevant topic and not the
  unrelated one; removed blocks absent.
- `/etc/nexbot/core.env` backed up to `core.env.bak-20261029-memory-recall`, then given `NEX_EMBEDDINGS_*`
  (SiliconFlow `Qwen/Qwen3-Embedding-8B`, 1024) and `NEX_RERANK_*` (`cohere`, `Qwen/Qwen3-Reranker-8B`); the key
  was copied on the server from the Hindsight configuration and never printed.
- Deployed with no active tasks: backup `/data/nexbot/backups/main-374cae86-20261029-pre`, drop-in with 31 `z`.
  Post-switch: health 200, six databases with unchanged identity/model/secret/policy hashes and vault keys,
  33 projections, 401s, no journal errors. Public HTML and all seven assets byte-identical.
- In production after the switch: 8 embedding calls succeeded (20,363 tokens) and 192 vectors exist
  (`Qwen/Qwen3-Embedding-8B`, 1024). The topic migration started and waits on the day's memory budget
  ("今日记忆维护预算已用完") for the four assistants with memories.

## Packages

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.9.19-x64-Client-Portable.exe | 176198925 | `c2808cad9e7f966f8826ed227888f66f41c71e0a9bc33e42cc42542a037477d3` |
| nexbot-0.2.18-debug.apk | 19940875 | `7b6578ed51cb7411b19ffeca6e2d1c02deae3652a4737b96e61d7921f2fc482f` |
| NexBot-0.2.13-mac-arm64.dmg | 76348995 | `d96b869f6a8513ad8f2f47bb1ba23988f19ab25f802b40720d2ccc2530ed0a1d` |
| NexBot-0.2.13-ios-unsigned.ipa | 11101040 | `d624186480d50c8562bf679a6287cd80e3d9b9a4138698314609ee5047b8b9df` |

- Windows: ProductVersion/FileVersion 0.9.19; `scripts/smoke-shell-login.mjs` on the exact EXE passed 20
  single-workspace and 24 account-workspace cases.
- Android: `:core:test` 53 and `:app:testDebugUnitTest` 29, 0 failures; APK 0.2.18 / 218; certificate SHA-256
  `af012179efbcda655934c0a2400ad76a8ac32ac81598b4f4f3bd633b9073cb4b`, as published before.
- Mac/iOS: on the Mac from a fresh `git clone` at the commit with a dedicated simulator: NexClientKit 170 tests,
  macOS and iOS render suites 5 each, version 0.2.13 / 15, ad-hoc signature verified, IPA checked by the release
  verifier. Clone and simulator deleted; the user's checkout and simulator were not used.

## Publication

- GitHub pre-release with the four installers, `SHA256SUMS.txt` and `SOURCE_COMMIT.txt`; all six sizes and
  digests match the local files.
- Previous update manifest backed up privately; publisher dry run listed all four platforms; installers
  uploaded to immutable OSS keys and read back; manifest updated.
- `/api/client/update`: Windows 0.9.18, Android 0.2.17 and Mac/iOS 0.2.12 are offered the new versions and the
  new versions get none; every offered installer downloaded and matched its manifest size and SHA-256.
- README links point to `nexbot-v0.9.19-preview.1`; all five linked files are assets of that release. The live
  homepage in a fresh read-only browser shows Windows 0.9.19, Android 0.2.18, Mac and iPhone 0.2.13 dated
  2026-10-29, each card linking to the download API's file.

## Limits

- No real chat model was used to judge recall relevance or topic quality; the 0.75 / 0.5 merge thresholds and
  the 0.3 rerank threshold are untuned.
- The production topic migration has not run yet (daily budget); its outcome is to be checked after the reset.
- New settings screens (记忆检索, 核心记忆) were not visually checked on any device.
- Windows remains unsigned, Android uses the debug certificate, Mac is ad-hoc signed without notarization,
  iOS needs user signing.

Raw reports are under the ignored `release/deployment-memory-recall/` and `release/ship-0.9.19/`.
