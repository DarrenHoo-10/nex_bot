# Continuous context and personal assistant memory

Implementation review, 2026-10-18. This is a local implementation and isolated
verification record; it is not a deployment record.

## Behavior

Each assistant keeps one direct-user conversation across completed execution
tasks. A change of subject does not split or clear it. No topic classifier or
JEV routing participates. Task cancellation, tool approvals and delegated work
retain their own execution boundaries.

The worker checks its projected input before every model call, including tool
continuations. At 80% of the configured window it summarizes older complete
turns. A smaller effective threshold applies when necessary to reserve the
configured output allowance. The target after compression is approximately
60%, with a recent-history ceiling of 20,000 estimated tokens; retaining the
latest complete turn takes priority over that target. A single turn that still
cannot fit fails visibly instead of silently dropping user input.

Raw messages and runtime entries remain available through `message:<id>` and
`entry:<id>`. Summaries include deterministic source boundaries and can refer to
older summaries. Compaction persists the original snapshot before replacing
the projection. Incomplete or failed summary responses do not replace it.
Old system prompt patches are normalized so tool definitions and repeated
identities do not accumulate in the input estimate.

The main model can update a short, versioned working note at a changed decision
or stage boundary using `memory.write(scope="context")`. This note accompanies
future requests and works with long-term memory disabled. It is model-maintained,
not a separate manager-model call on every turn. Explicit source references
are loaded where they fit; historical-language queries also retrieve relevant
original messages. Larger originals remain available through the history tool.

## Assistant-owned memory

The built-in implementation borrows the retain / consolidate / understanding /
reflect pattern. It does not require a Hindsight deployment. The previous
external-memory integration remains available as a compatibility option.

- One assistant is one private bank. Sources are scoped to its messages.
- Facts retain user/peer statements; assistant-origin material is classified
  as experience. Observations and understanding are explicitly synthesized.
- Source IDs and content hashes are checked before every commit and recall.
  Invented references reject the whole candidate batch.
- Observations update with version history. Updating an observation immediately
  withdraws dependent stale understanding until it is rebuilt.
- Understanding uses three evidence-backed documents: preferences, important
  decisions and working experience.
- Retrieval uses indexed lexical matching, including Chinese bigrams, relevance
  ranking and a token budget. This version does **not** implement embedding
  search, entity graphs or claim parity with Hindsight's retrieval quality.
- Explicit deep queries use the selected memory model and return source links.
- Forgetting removes selected raw sources, causal replies, dependent native
  records and their versions/search entries. It cancels affected work, clears
  working/context projections and rejects stale background results. Unrelated
  native memory records remain.

## Defaults

| Setting | Initial value / behavior |
| --- | --- |
| Long-term memory | Off; one account/workspace switch covers existing and future assistants |
| Memory model | One shared model for all assistants; empty selection follows the account default model, independently of each assistant chat model |
| Background daily budget | 100,000 input + output tokens; 0 means unlimited |
| Background scheduling | Poll every 5 seconds, at least 30 seconds between successful batches; yields to active chats |
| Extraction batch | At most 20 messages and 12,000 estimated source tokens, reduced for small model windows |
| Understanding update | At most once per 30 minutes after new evidence; stale documents stop being recalled immediately |
| Automatic recalled memory | At most 2,000 estimated tokens, reduced to 5% of small model windows |
| Model maintenance output | Up to 4,096 tokens, limited by the chosen model's configured limits |
| Failures | Preserve input cursor; retry no earlier than 60 seconds |
| Older history | No automatic import; user selects a date range |
| Disable / enable | Preserve stored records, stop requests and recall; skip messages from the disabled interval unless explicitly imported |

Budget admission reserves the estimated request plus maximum output before
calling the provider. Actual reported usage replaces that reservation. Unknown
usage stays unknown and retains its reservation; it is never displayed as zero.
Cache tokens are included in provider total input exactly once. Compaction is
reported separately and does not consume the optional background-memory budget.
Token estimation is conservative and offline; provider receipts are the usage
authority, not an exact tokenizer for arbitrary third-party models.

## User interface

Settings → Long-term memory shows one immediate-save switch, one shared memory
model picker and total memory tokens. There is no assistant selector, budget form,
detailed monitoring, import/source browser or external-service panel. Stored
memory remains isolated per assistant; this changes control scope, not ownership.

The total sums lifetime reported input and output tokens for native memory
operations across the account's assistants, including archived assistants.
Compaction and memory injected into chat are excluded; cache tokens are already
part of reported input and are not counted again. Missing provider receipts show
`≥` before the known total rather than presenting incomplete usage as exact.
Disabling memory stops maintenance and recall and retains both records and usage.

Schema 16 stores the workspace switch and new assistants inherit it immediately.
Upgrading mixed legacy switches defaults the unified control to off to avoid
silently enabling previously disabled assistants. Previously saved model and
budget settings are preserved. Schema 17 adds the shared model selection: a
single existing nonempty memory model is retained; differing legacy selections
fall back to the account default until explicitly configured. Model changes
abort pending memory requests, invalidate stale results and preserve extraction
cursors. Both new and existing assistants use the shared choice. Concurrent
changes use a version check. Old
clients attempting per-assistant switch writes receive an update-required error.
The previous detailed backend APIs remain available for compatibility/read access.

Verification after the shared-model change: 16 continuity/memory tests passed
(15 in the suite, then the corrected shared-model fixture), type checking and
lint passed, and the real renderer passed seven isolated checks covering global opt-in, future assistants,
combined usage, shared-model routing and persistence, disabling without deleting records and mobile
layout. The backend synthetic provider processed both assistants separately.

## Reproduce in disposable fixtures

```powershell
pnpm typecheck
pnpm exec vitest run server/personal-os/app.test.ts server/personal-os/continuity.test.ts server/personal-os/memory.test.ts server/personal-os/memory-native.test.ts server/personal-os/memory-plugin.test.ts server/personal-os/risk.test.ts server/personal-os/agent-model.test.ts server/personal-os/model-limits.test.ts server/personal-os/chat-composer.test.ts
pnpm build:core
node --experimental-strip-types scripts/smoke-continuous-memory.mjs
```

The fixtures use temporary databases and synthetic loopback identity/model
providers. The desktop smoke launches a hidden Electron profile, exercises the
real renderer and HTTP routes, and captures desktop and 390px mobile layouts.
Screenshots and its machine-readable report are written to
`release/personal-memory-verification/` (ignored release output).

Coverage includes fifteen full chat rounds, repeated compression, source
expansion, tool-result pairing after compression, working notes with memory off,
selected-model use, budget admission, disabling in flight, explicit history
import, user corrections, malformed/incomplete responses, cache accounting,
source isolation and forgetting.

These are deterministic functional tests. They establish continuity, boundaries,
persistence and accounting, not a real model's factual extraction accuracy or
months-long production performance. Model-quality evaluation should replay
synthetic long histories with annotated constraints, corrections and expected
citations, comparing task success, unsupported claims, old-information recall,
tokens and latency against uncompressed and rolling-summary baselines.
