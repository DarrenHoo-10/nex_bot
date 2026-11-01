# Model Todo completion — local verification (2026-11-01)

The reported conversation could read the panel but could not mark its entries
complete. Inspection confirmed that the panel's `complete` action existed while
the model catalog exposed only list, save and delete, with no status field.

`todo.save` now accepts `status=done` to complete an existing item and
`status=todo` to reopen a completed item. Calls must include `todoId` and the
current `expectedVersion` obtained from `todo.list`. This reuses the panel's
transition logic, ownership checks, active-AI guard and durable tool receipts.
Status-only changes preserve all other fields and increment the version once.
Metadata and status updates share a transaction. No new action or grant is
introduced. Common help and queried schemas describe the new argument.

Missing title on creation now gives specific guidance about title versus an
existing todo ID/version, rather than the generic empty-content error.

## Evidence

All mutations used temporary Core databases and local scripted providers in
`server/personal-os/todos.test.ts` and `server/personal-os/tool-catalog.test.ts`: 19 tests passed.
The OpenAI and Anthropic worker journeys each completed three synthetic panel
items, checked the real HTTP list, restarted Core, checked persisted state and
replayed receipts without changing versions again. Guards cover stale/missing
versions, active AI execution, cross-owner access, invalid states, reopening,
unchanged metadata and absence of unintended Todo execution runs. Existing
discovery tests also transmitted a query and created a routine with arguments
through both provider protocols. Server TypeScript, changed-file oxlint and diff
whitespace checks passed.

## Limits

The screenshot's suggestion that all parameters except `action` were lost was
not reproduced by these worker fixtures. No production call trace or live
provider was inspected; these checks cannot establish why that particular
conversation sent invalid save/search arguments. No client UI behavior changed.
No production deployment, package, commit, push, release or user Todo mutation
was performed.
