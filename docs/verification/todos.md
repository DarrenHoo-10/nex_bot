# Unified Todo panel — local verification (2026-10-30)

Implementation on `codex/todo-panel-design`, based on `origin/main` at
`6e2e38410e6d659b64a890c53802669ed79e85e5`. This is a local implementation;
the checks below record the initial local phase. The user subsequently authorized
commit, push and deployment; see [the release record](todos-release-20261030.md).

## Behavior and persistence

- One Todo entry in the existing contact rail, with day/week/month views and
  All / In progress / Not started / Completed filters. Awaiting review belongs
  to In progress, and remains explicitly labelled in the list and detail.
- Title, requirements, owner, due date, priority, steps and status are stored in
  Core SQLite through additive migration 38 (after merging the routine migrations 36–37). Production UI has no seeded todos
  or localStorage Todo store. Unscheduled items remain accessible in all views.
- Personal work can begin, pause, complete and reopen. Assigning an AI does not
  automatically run it: the explicit execution action uses the existing agent
  runtime, permissions and approvals. Successful work waits for user acceptance.
  Stop/failure preserves the Todo; persisted cancellation is recovered on restart.
- Version checks reject stale writes. AI starts have a durable request receipt;
  a repeated request does not spawn a second task. Busy agents reject another
  assignment. Running AI work must stop before editing, deleting or completing.
- Task results are read from the existing task record, not copied into a second
  content store. Forgotten task results are suppressed. Sync events contain no
  Todo text. Reassignment removes the old task from the current assignment.
- Native macOS/iOS use the same endpoints and version fields, with the same
  calendar/filter, editor, execution and acceptance actions.

## Checks performed

All mutations used temporary databases and synthetic accounts/model providers.
No live user application or data was used.

- Frontend and server TypeScript checks passed.
- Core and shared Web UI production build passed (`node scripts/build-personal.mjs --core`).
- Changed TypeScript/React files passed oxlint with warnings denied.
- `server/personal-os/todos.test.ts`, `src/personal/todo/calendar-model.test.ts` and `server/personal-os/client-transport.test.ts`: 13 tests
  passed. Covers restart persistence, completed and personal in-progress work,
  step data, version conflicts, validation, owner-only access, actual worker
  delivery with a synthetic model, repeated execution, busy-agent protection,
  cancellation/recovery, month ends, leap years and week/year boundaries.
- Browser verification against the built UI and an isolated Core: created and
  edited items, assigned AI and received review output, confirmed completion,
  refreshed and reloaded persisted items, began personal work, and used a second
  client to complete a task while the first had a stale edit form. The old form
  showed the conflict and did not overwrite the completed task.
- Desktop and 390 × 844 browser layouts inspected, including week/month views,
  navigation, custom owner/date controls and modal focus. No horizontal overflow
  at the phone viewport.
- In a fresh `/tmp/nex-todo-verify.*` directory on `mac-air`, Xcode 16.4 successfully
  built both Mac Debug and iOS Simulator Debug from the edited sources with signing
  disabled. Two NexClientKit Todo tests passed (calendar boundaries and DTO/action
  serialization). No existing checkout or user simulator was used.

## Limits and existing failures

A broader `server/personal-os/app.test.ts` run completed with 43 passing, one skipped and one failing
case. The failing `reads generic bundled skills ... keeps edited restrictions`
assertion expects a policy without `html.render`. The identical failure was
reproduced from a clean archive of the base commit, without the Todo changes.
The transport suite also hit its random-port `fetch: bad port` once; its separate
rerun passed. The production build retains its existing large-chunk warning.

Apple verification here is compilation plus protocol/calendar tests, not a native
interactive smoke run or a signed installer check. Windows and Android consume the
shared Web UI; installer/APK packaging was not part of this local task. Synthetic
browser AI output verifies the execution wiring, not a live provider's quality.

## Reproduce the local preview

Build Core/UI, then run `node scripts/testing/todo-core-preview.mjs` in the checkout.
The process prints its loopback URL and owned temporary data directory. It uses
synthetic identity and model endpoints, disables the host device and memory runtime,
and starts with an empty Todo list. The earlier standalone design fixture remains
under `scripts/testing/todo-design/` only as a design reference.
