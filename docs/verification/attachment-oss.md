# Private OSS attachment storage

NexBot Core can store chat attachments (including generated images) as encrypted
private OSS objects. Set `NEX_ATTACHMENT_STORAGE=oss` with `OSS_ENDPOINT`,
`OSS_BUCKET`, `OSS_ACCESS_KEY_ID`, and `OSS_ACCESS_KEY_SECRET` in the service's
private environment file. Tests and ordinary local instances do not read cloud
credentials automatically; `AppOptions.attachmentObjects` injects their storage.

Objects use `nexbot/attachments/v1/<hashed-core-id>/<attachment-id>.enc`.
The existing workspace vault encrypts their contents. Requests use OSS header
signatures, private object ACL, upload checksums, no-overwrite semantics and
bounded response reads. Neither credentials nor OSS URLs are returned to clients.
The signing contract follows Alibaba Cloud's official documentation:
https://www.alibabacloud.com/help/zh/oss/developer-reference/include-signatures-in-the-authorization-header

Schema 21 adds `attachment_objects`, preserving attachment IDs and message links.
Uploads first stage encrypted bytes locally, write OSS, read the object back and
verify its SHA-256. Only then does a transaction replace local ciphertext with
object metadata. Failures retain the local copy. Existing bound attachments migrate
in batches of 20 at startup and every minute, without changing conversation text.

Preview/download still use the authenticated Core endpoint. It rechecks message
references after remote reads and session validity before returning bytes. Agent
attachment reads stay scoped to their own bot. Generated images are not published
until storage succeeds, and cancellation, identity, selection and policy are
rechecked after the cloud boundary. The normal 5 MB per-file and 200 MB workspace
limits remain. Unbound failed/cancelled uploads remain inaccessible; historical
backups and encrypted orphan OSS objects are retained, not silently deleted.

Verification uses isolated fixtures only:

```powershell
pnpm typecheck
pnpm exec vitest run server/personal-os/attachment-objects.test.ts server/personal-os/chat-composer.test.ts server/personal-os/image-models.test.ts
pnpm build:core
node scripts/smoke-image-models.mjs
```

The storage suite checks encrypted migration, clearing local bytes only after
verification, same-account second-device downloads, revoked/unauthenticated access,
wrong-bot access, corrupt objects, network failures, idempotent retries, redaction
during a remote read, private ACL and request signatures. Image tests also stop an
in-flight cloud upload and verify that no late message is published. The Linux
candidate uses an owned temporary workspace and synthetic model/image servers with
real private OSS, checking migration from the previous executable, generated-image
storage, restart, access control and byte-for-byte downloads. Synthetic OSS test
objects contain no user data and use isolated IDs.

Deployment uses a private server backup before switching. A read-only verification
compares migrated object hashes against the original encrypted attachment hashes,
checks unchanged metadata and references, and checks that no bound attachment
payload remains in the live database. Rollback first hydrates ciphertext from OSS
into the database before starting the old executable, preserving new records.
Private deployment scripts/receipts stay in ignored `release/deployment-oss/`.

Production result, 2026-10-19: `oss-attachments-20261019` is active with OSS enabled.
All five workspaces upgraded to schema 21; identity, vaults, settings, policies,
attachment metadata and conversation records passed preservation checks. The one
existing bound attachment (2,165,730 bytes) was migrated, then downloaded from OSS
and its encrypted-content hash compared with the pre-migration snapshot. Pending
bound attachments: zero. Public health and exact UI asset checks passed. Original
private server backups remain available; no user attachment was downloaded locally.
