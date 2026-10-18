# Chat uploads, permission modes and device receipts — 2026-10-18

## Delivered behavior

- Composer `+` opens the grouped menu; **File** opens the file picker. Up to five files, each up to 5 MiB, may be
  attached to a message, including a message with no typed text. Drafts stay with
  their assistant. Sent files appear as downloadable cards.
- `标准权限 / 完全权限` is stored per assistant and survives reload and restart.
  Full access skips all effect approvals for granted tools. Switching to full
  releases valid pending approvals; stale work is cancelled, and unknown or
  cancelled operations are never replayed. Standard restores effect-based checks.
- Device pause, logout, revoked sessions, capability grants and account isolation
  still apply in both modes. Other assistants keep their own permission mode.
- Attachments are encrypted in the workspace database. Upload ownership is
  session-bound; model reads are assistant-bound and require a linked message.
  Privacy-redacted message attachments become inaccessible. Names are not disk
  paths. Text, PDF and PNG/JPEG/WebP are readable by the model; other formats can
  be uploaded/downloaded but are not parsed. PDF extraction is bounded to 50 pages
  and text results to 80,000 characters. Workspace attachment quota is 200 MiB.
- Core pings execution sockets every 15 seconds and terminates missed-heartbeat
  connections. A missing command receipt becomes a reconciliation state instead
  of an indefinite executing label. Receipt requests reuse the call ID and digest;
  they do not execute the command again.

## Diagnosis and limits

Read-only production inspection found a document command with an unknown delivery
result and no matching local executor receipt. Recent model calls were about 8.5
and 9.4 seconds; the task was waiting on device confirmation. The missing heartbeat
was a connection-liveness defect consistent with this evidence, not proof of the
precise network failure. No live task was replayed or user document mutated.

## Isolated verification

All mutations use temporary workspaces, fake identity/model/MCP providers and an
owned executor. No real account, file contents or credentials appear in screenshots.

```powershell
pnpm exec vitest run server/personal-os/chat-composer.test.ts server/personal-os/risk.test.ts server/personal-os/workspaces.test.ts
pnpm exec tsc -b
pnpm exec tsc -p tsconfig.server.json --noEmit
node scripts/build-personal.mjs --core
node scripts/smoke-personal-workspace.mjs
node scripts/smoke-client-device.mjs
```

The composer suite checks real upload → send → worker attachment read → download,
privacy redaction, invalid uploads, persisted mode changes, restored approvals,
capability restrictions and a real half-open WebSocket. The renderer smoke passed
33 checks, including upload-only messages, mode persistence, dark mode and narrow
layouts. The executor smoke passed 10 checks; ordinary document saving measured
1,464 ms with a scripted model and real local file write. This is fixture timing,
not a production latency guarantee.

References: [upload / full access](../../doc/ui/composer-upload-full-access-light.png),
[sent attachment](../../doc/ui/composer-attachment-message-light.png).

## Local client installation — 2026-10-18

The Windows client was rebuilt into `release/personal-client-composer-local/`.
Its actual packaged executable passed all 30 isolated shell checks, including
login restoration, automatic device connection, pause/logout and account isolation.
The local installation was replaced; all 663 shipped files matched the tested
candidate, the saved-login file was unchanged, and the old installation was
retained for rollback. Private installation receipts remain in ignored
`release/local-composer-update/`. The application was reopened normally; no test
messages or file operations were sent through the live account.

## Production deployment — 2026-10-18

The Tokyo Core now runs `composer-20261018` through the existing Seoul HTTPS
relay. The release includes uploads, permission modes, effect-based standard
approvals and device heartbeat/receipt handling. The local client installed above
now has matching server APIs. No user's permission mode was changed by deployment.

Before switching, the exact candidate passed eight Linux fixture checks: real
upload/send/worker-read/download, unauthenticated download rejection, a 5 MiB
upload, full-mode approval release and direct execution, persisted mode after
restart, restored standard approvals, and Linux PDF runtime loading. All fixture
data and model responses were synthetic, in a separate temporary directory.
The existing Linux PDF/canvas dependencies matched the new build versions and
were retained; Windows native modules were not deployed to Linux.

The service was stopped briefly for a complete private data/configuration backup.
The previous release and restricted backup remain on the server. Both workspaces
migrated to schema 13 and passed integrity/foreign-key checks. Vault keys, identity
bindings, model/memory settings and existing record counts were preserved.
Old hashed UI assets remain available to already-open clients. Seoul's 32 MiB
and Tokyo's 20 MiB proxy limits already exceed the upload request requirement;
neither proxy needed a configuration change.

Read-only production verification confirmed public HTTPS health 200, the HTML
entry and all three referenced assets matching the build, unauthenticated API
requests rejected with 401, service active with no automatic restarts, and both
databases at schema 13 with integrity `ok`. Feature mutations were tested only
against the isolated fixture, not the user's live account or documents.
Deployment scripts and receipts are in ignored `release/deployment-composer/`.
