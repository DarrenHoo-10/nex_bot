# Product Todo tools and composer status — local verification

The Todo panel persisted records, but the model's Broker had no Todo actions or
instructions. A model could claim it recorded a todo after writing private memory,
which never appeared in the user's panel.

`todo.list` and `todo.save` now use the same scoped `TodoModule` as the panel.
New items default to the user, ordinary priority, no due date and not started.
Assignment to an Agent also does not start execution. Updates require the current
version and preserve omitted fields. Existing explicit tool restrictions remain
effective; inherited default policies pick up the new tools.

The Broker schema and runtime prompt describe the product tools and distinguish
them from private memory. They require a successful tool result before claiming
that a todo was saved. Migration 42 stores body-free receipts in the same
transaction as each save, so an interrupted call can replay without creating or
editing twice. A replay cannot revive a deleted todo.

The working/sending/stopping pill above the composer was removed in the shared
Web UI and native macOS/iOS views. Transcript progress, approval controls and the
composer's stop button remain available.

## Evidence

All server mutations used throwaway databases and synthetic model providers.
The model test runs actual Broker calls through a worker, reads the saved item
through the authenticated panel API, restarts Core, replays the receipt and edits
the same item. It checks defaults, retained steps and description, version
conflicts, no automatic task execution, deleted-record replay, owner isolation and
tool restrictions. React composer tests check absence of the pill while sending
and running and retain stop-button behavior.

- Frontend and server TypeScript checks passed.
- Todo, app, chat-composer and client-transport suites: 64 passed, one skipped.
  Policy-default and React input suites: another 16 passed. Changed TypeScript
  files passed lint with warnings denied; the diff whitespace check passed.
- The Core/shared Web UI build passed, with the existing large-chunk warning.
- On `mac-air`, 180 NexClientKit tests and both macOS Debug and iOS Simulator Debug
  builds passed in a fresh `/tmp/nex-todo-broker.*` source directory, signing off.
  No existing checkout or user simulator was used. Logs are in ignored
  `release/todo-broker-evidence/`.

## Limits

These checks verify the model tool contract with a scripted provider, not the
tool-selection quality of a live model. Apple verification is compilation and
unit tests, not native interactive testing or installer validation. Historical
private-memory notes are not automatically imported into product todos.

Per the user's latest instruction, this change is local only: no production
deployment, release, installer publication or update-manifest change was made.
