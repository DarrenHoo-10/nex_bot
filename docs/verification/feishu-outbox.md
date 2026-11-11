# Feishu outbox recovery and reconciliation

The official [create](https://open.feishu.cn/document/server-docs/im-v1/message/create.md) and [reply](https://open.feishu.cn/document/server-docs/im-v1/message/reply.md) contracts guarantee at most one successful message for the same UUID within **one hour**. A durable UUID alone cannot prevent a duplicate after that window.

Each outgoing POST now persists `first_post_at` immediately before the actual provider fetch. The same timestamp and UUID cover SDK retries and process recovery. Every fetch checks the original deadline again after rate-limit/token waits. At or after one hour, or after a clock rollback before the original timestamp, unknown results enter `needs_reconciliation`. Existing attempted POST records without a trustworthy timestamp also enter that state. New records interrupted before any actual POST remain safe to recover. Later parts of that source wait for a confirmed sent predecessor; unrelated topics continue.

PATCH updates the original message and remains retryable without the POST UUID deadline. Frequency limits and ambiguous PATCH errors never turn into a new message. A definitively unavailable message (`230011`) can fall back to a newly tracked POST. Disabling current rules after an unknown POST preserves its reconciliation requirement instead of treating it as proven unsent.

Authenticated owner settings expose `GET /api/feishu/deliveries` returning `{parts}`. Each part includes its state, original App/chat/topic, content, part number, attempt count, first POST time, deadline and reconciliation audit. No status diagnostic is sent to the group or exposed as a model tool. The shared Web/Windows/Android settings show this below the existing Feishu channel-transfer and subscription controls.

`POST /api/feishu/deliveries/reconcile` accepts:

- `{id, action:"delivered", messageId, evidence}`: reads the supplied message using the original application's credentials and `card_msg_content_type=user_card_content`. The documented [message lookup](https://open.feishu.cn/document/server-docs/im-v1/message/get.md) returns the original card JSON and application sender ID. Core requires the original App, chat, application sender, message type, complete canonical card content and reply root to match. A revoked/deleted message or conflicting existing topic alias cannot be registered. Sent state, receipt, topic alias and audit commit atomically.
- `{id, action:"not_delivered", evidence, confirmedNotDelivered:true}`: explicit human attestation of verified non-delivery permits a fresh UUID and resets the POST start time. Core rechecks current destination/subscription rules before accepting this action, then repeats live channel/actor/rule checks before sending. Missing evidence or attestation fails. Session validity and owner/destination authority are checked again after provider lookup.

All evidence is local to the account workspace. Repeating a completed reconciliation does not create a second retry; settings must reload the current part state.

Local verification uses disposable Core/SQLite fixtures, a fake SDK/OpenAPI boundary and rendered React settings, with no real Feishu sends:

```powershell
node_modules/.bin/vitest.cmd run server/personal-os/feishu/outbox.test.ts server/personal-os/feishu/outbox-http.test.ts server/personal-os/feishu/delivery.test.ts server/personal-os/feishu/workspace-router.test.ts server/personal-os/feishu.test.ts src/personal/FeishuOutboxSettings.test.ts
node_modules/.bin/tsc.cmd -p tsconfig.server.json --noEmit
node_modules/.bin/tsc.cmd --noEmit
```

The 52 tests cover exact expiry, fetch-time expiry during retry, crash recovery, old attempted rows and reconstructed report roots, safe PATCH behavior, blocked segments, unrelated delivery, forged/mismatched receipts, authenticated HTTP access, audited alias registration, explicit retry and current rules, synchronous/asynchronous ownership failures, existing delivery/router behavior, and private settings interaction. Both typechecks and focused lint pass. The personal.html Vite production build passes; headless Chrome renders the actual settings components with synthetic responses at desktop and 390px widths, with inspected screenshots kept outside the repository and no horizontal overflow. Native Apple settings and packaged client builds are not covered by this change. No deployment was performed.

Schema changes are additive. Rollback must retain the delivery ledger and audit tables, and must pause outgoing delivery before starting older Core code: older versions do not understand the UUID deadline and must not automatically retry unknown attempts. Do not restore a stale database or reset these records to pending.
