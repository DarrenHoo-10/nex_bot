# Feishu connector — 2026-10-24

Status: P1 (connection + conversation) implemented and fixture-verified; not
yet accepted against a real Feishu tenant. Design:
[`docs/plans/2026-10-24-feishu-connector.md`](../plans/2026-10-24-feishu-connector.md).

## What P1 covers

Scan-to-create a self-built Feishu app via the official SDK `registerApp`
(with the full scope manifest plus baseline events and the card callback
pre-filled through `addons`), or paste an existing App ID/Secret. One app
binds to one assistant. Owner binding uses the scanner's `open_id`, or a
6-digit bind code sent by p2p message for pasted apps. Inbound p2p messages
from the owner (and group messages that @ the bot) enter the assistant's
continuous conversation over the SDK `WSClient` long connection; the final
answer or error goes back to the source chat as a markdown card (replied in
threads for groups). Pending approvals for Feishu-originated tasks are posted
as approval cards; only the owner's click decides, and `runtime.decide`
re-checks the argument hash. The stop button cancels the task. Toggling stops
the transport; deleting removes rows and secrets. A second live long
connection for the same app (checked via `event/v1/connection`) is refused
(`busy`). Feishu-originated tasks are authorized by the connection itself
(`identity.channelAuthorize`), so they execute without a live client session;
disconnecting revokes that.

## Isolated fixture

`server/personal-os/testing/fake-feishu.ts` plays the OpenAPI subset
(tenant token, `event/v1/connection`, `bot/v3/info`, message send/reply) on
loopback HTTP and provides an injectable transport (event delivery + captured
card actions) and a fake `registerApp`. The fixture app proxies
`open.feishu.cn`/`accounts.feishu.cn` to the fake origin and injects
`{ registerApp, transport, fetchImpl }` through `AppOptions.feishu` — test-only,
like the identity fixture. No real tenant, account or network is touched.

## Driving it

```sh
pnpm exec vitest run server/personal-os/feishu.test.ts
pnpm test:personal
pnpm typecheck
pnpm lint
```

`feishu.test.ts` (7 cases) covers: register → connect → one p2p turn with an
encrypted secret (state and store bytes never contain the secret); `message_id`
dedupe; stranger and unmentioned-group rejection; group @ handling with a
thread reply; approval card sent for a dangerous `agent.update` from a Feishu
task, stranger click refused, owner click executes; stop button cancels; bind
code flow for a pasted app (code stored hashed); toggle off stops delivery;
delete removes app, mappings and connector; `busy` while another instance is
online, then connects after re-enable.

## Evidence

- `pnpm exec vitest run server/personal-os/feishu.test.ts`: 7 passed.
- `pnpm test:personal`: all suites green (feishu 7, connectors 7+2 variants,
  app/memory/identity/service/workspaces unchanged).
- `pnpm typecheck`, `pnpm lint` clean.

## Real-tenant acceptance (outstanding)

Before shipping: one real scan on a test tenant to confirm the app is created,
events arrive over the long connection, and a p2p round-trip works. The
`addons` pre-fill depends on a platform gray release; if the tenant is not
covered the app still works with default permissions and missing capabilities
surface as runtime errors (per design, no remediation flow in P1).

## Gotchas

- `AbortSignal` has no `abort()` — abort the controller, not the signal.
- The derived table in `MemoryModule.prompt` must project `rowid` for the
  insertion-order tie-break to exist at all (a missing projection fails every
  prompt-rendering test with `no such column: rowid`).
- The `until()` helper accepts async checks; sync-only checks that await inside
  fail esbuild with a misleading parser error.
