# Model Todo deletion — local verification

The panel already supported deletion, but the model only had `todo.list` and
`todo.save`. Broker now exposes `todo.delete(todoId,expectedVersion)` and tells
the model to identify the user-requested item and current version before deleting,
then confirm only after the tool succeeds.

The tool shares the panel's scoped soft-deletion path. Stale versions, missing
items, other owners' items and running AI work are rejected. Existing explicit
tool restrictions still apply. A deletion and its body-free receipt commit in
one transaction using the existing receipt table; no schema migration is needed.
Replaying the same call after restart returns success without another mutation
or audit record. Receipt failure rolls the deletion back. Web and native Apple
capability catalogs and tool labels include the new action.

## Evidence

- `server/personal-os/todos.test.ts` and
  `server/personal-os/policy-defaults.test.ts`: 14 passed. The scripted model
  executes the actual Broker worker; authenticated panel reads verify removal,
  and a Core restart verifies persistence and receipt replay. All mutations use
  temporary databases and synthetic providers. The first run timed out in the
  pre-existing create/edit scenario; rerunning with a 60-second test ceiling
  completed the entire suite in 16 seconds.
- Frontend and server TypeScript checks passed. Changed TypeScript files passed
  lint with warnings denied; the diff whitespace check passed.
- On `mac-air`, all 180 NexClientKit tests passed in a fresh temporary source
  directory. That directory was removed; no user checkout or simulator was used.
  The local log is in ignored `release/todo-delete-evidence/swift-test.log`.

## Limits

The scripted model verifies the tool contract, not live model selection quality.
No installer or native UI interaction was tested for this addition. This change
is local only at the user's request: no push, deployment, GitHub/OSS publication
or update-manifest change. The online model does not gain this tool until release.
