# Feishu connector — 2026-10-24

Status: P1 (connection + conversation) and P2 (generic tools + owner user
authorization) implemented and fixture-verified; not yet accepted against a
real Feishu tenant. Design:
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

## What P2 adds

The connector row is created with a built-in two-tool catalog
(`server/personal-os/feishu/tools.ts`): `feishu_read` (GET only,
`readOnlyHint`) and `feishu_write` (POST/PUT only, `destructiveHint` — always
approval). The catalog is auto-granted to the receiving assistant through the
standard connector grant flow; execution goes through `runtime.connectorExecutor`
dispatch on `kind='feishu'` and reuses `connectorAccess` (grant, version),
post-call re-authorization, and the unknown-effect rule (transport failure
after dispatch marks the call unknown and never replays). Parameters are
validated server-side: path must match `/open-apis/…`, body ≤ 64KB, query
string comes from `params`, responses truncate at 24KB. Scope errors return
structured results: `missing_scope(layer=app|user, scopes)` parsed from
`permission_violations`; user-token-invalid codes refresh once and retry.
Owner user authorization uses the OAuth device flow (`device_authorization` +
token polling with `authorization_pending`/`slow_down` handling), verifies the
authorized open_id equals the app owner (or binds the owner when unbound, and
discards the token otherwise), stores the encrypted grant (access + refresh +
actual scopes) in the vault columns, refreshes 5 minutes before expiry with
per-app serialization, and clears the token on refresh-failure codes. A
usage skill ships at `skills/feishu/SKILL.md`.

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

`server/personal-os/feishu.test.ts` (12 cases) covers: register → connect → one p2p turn with an
encrypted secret (state and store bytes never contain the secret); `message_id`
dedupe; stranger and unmentioned-group rejection; group @ handling with a
thread reply; approval card sent for a dangerous `agent.update` from a Feishu
task, stranger click refused, owner click executes; stop button cancels; bind
code flow for a pasted app (code stored hashed); toggle off stops delivery;
delete removes app, mappings and connector; `busy` while another instance is
online, then connects after re-enable. P2: tools auto-granted, read executes
without approval against the fake API (correct method and bearer);
malformed paths rejected without touching the API; write held for approval
(card only from the owner's click, then POST observed with the body); device
flow authorizes the owner (pending polls honored, token stored encrypted) and
user-identity reads carry the user bearer; authorization from a different
account is discarded; an expired access token refreshes exactly once.

## Evidence

- `pnpm exec vitest run server/personal-os/feishu.test.ts`: 12 passed
  (`server/personal-os/feishu.test.ts`; Swift: `apps/apple/Packages/NexClientKit/Tests/NexClientKitTests/FeishuTests.swift`).
- `pnpm test:personal`: all suites green (feishu 12, connectors, app/memory/
  identity/service/workspaces unchanged).
- `pnpm typecheck`, `pnpm lint`, `pnpm build:core` clean.

## Apple native clients

Mac and iOS settings' 连接器 now show a Feishu card/section (scan-to-create
QR, paste-existing sheet, bind code, owner device-flow authorization with QR,
enable/disable, remove); feishu connector rows are hidden from the generic MCP
editor and list. Kit additions (`NexClientKit`): `ConnectorView.kind`,
`FeishuState`/`FeishuAppView`/`FeishuJob` parsed from the `feishu` snapshot
block, and `feishu*` endpoints/actions; jobs are polled (1.5 s) while
`needsPolling`. QR codes render via CoreImage `CIQRCodeGenerator`.

- `swift test --package-path apps/apple/Packages/NexClientKit`: 106 passed
  (3 new FeishuTests: state decoding incl. `kind`, endpoint paths/bodies,
  no-app guards; register-while-connected refuses as on Core).
- `xcodegen generate` + `xcodebuild -scheme NexBotMac -destination
  'platform=macOS' build` and `-scheme NexBotiOS -destination
  'generic/platform=iOS Simulator' build`: both succeeded.
- Not yet covered: pixel-level rendering acceptance for the new panes
  (follows the repo's Apple preview flow on a real run).

## Production deployment — 2026-10-25

Current release: `/data/nexbot/releases/feishu-merged-20261025` (archive
`NexBot-Core-feishu-merged-20261025-linux-x64.tar.gz`, SHA-256
`a75cf24af6218d1eeadfae64d2a1ff1424f3dc5f8f6198c961a4f156f27e2d33`, verified on
the server; canvas `@napi-rs/canvas-linux-x64-gnu@1.0.10`). This is the merged
build (main's Gmail/image work + Feishu at migration 25). Data dir backed up to
`backups/pre-feishu-merged-20261025.tar.gz` first. After the drop-in switch and
restart: unit active, ready JSON with the stable Core ID, health 200 locally and
on `https://bot.nexorai.com.cn`, and all five databases (main + 4 account
workspaces) show max migration 25 with `personal_feishu_apps` present, zero
errors in the journal.

Incident note: the first deploy (`feishu-connector-20261025`, built from this
branch before the main merge) placed the Feishu tables at migration 19. Its
process ran without applying anything (19 was already main's image_models on
production, checksums matched main), so `personal_feishu_apps` never existed
and the UI surfaced "no such table: personal_feishu_apps". The merged build
renumbers Feishu to 25 and applies cleanly on top of production's 24. Rollback:
re-point the drop-in at any earlier release directory and restart.

Outstanding: real-tenant scan acceptance.

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
- `tool_calls.tool_name` stores the broker action (`connector.call`), not the
  inner tool name — assertions must select by result content or status.
- `connectorAccess` returns the connector row; the Feishu `app_secret` lives on
  the app row and must be fetched separately before decrypting credentials.
- The fake OpenAPI server must tolerate non-JSON bodies: the device
  authorization request is form-encoded and crashed a JSON-only parser.
