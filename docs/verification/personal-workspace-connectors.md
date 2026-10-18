# Personal workspace and MCP connectors — 2026-10-17

Current approval behavior (2026-10-18) is documented in
[effect-based approvals](effect-approvals.md). Granted read-only queries no longer
always require approval. The release and UI evidence below is historical.

## Production release 0.9.0 — 2026-10-17

The companion identity update is now deployed through the existing Seoul HTTPS
entry to Tokyo Core, and the Windows x64 portable client is packaged:
`release/personal-client/NexBot-0.9.0-x64-Client-Portable.exe` (136407936 bytes;
SHA-256 `6c250254ac657c75008223e6f480ac457368d570b7af411e4dab1b48533ecf7e`).
The client is unsigned. Its ten-entry ASAR contains only the shell, login assets,
new icons and package metadata; packaged bytes match the frozen release source.

Core archive: `release/core/NexBot-Core-0.9.0-linux-x64.tar.gz` (25417551 bytes;
SHA-256 `97895fdfb48a80745694c8c63dabdf5000f2a97a08c2f5b30437982a51bd055c`).
The release was built from the previous main commit plus the desktop appearance
changes, with a source manifest retained under ignored `release/deployment-0.9.0`.
In-progress Android summary-state and session-refresh extensions were excluded.

Release checks passed: 31 integration tests across six suites; 19 actual
renderer cases; 15 login/account-isolation checks on the portable EXE; 17
two-client checks on that EXE; and 17 standalone service checks on the extracted
Linux candidate in a disposable Tokyo environment. TypeScript and explicit-path
lint passed. All account/message mutations used isolated synthetic fixtures.
The first two-client run reached its report write but lacked the output directory;
after creating that directory, the complete run passed.

Deployment stopped Core for a private backup of all account data and service
configuration, then selected the new release through a separate systemd override.
Both existing workspaces retained their identity, vault, message/Agent records,
model configuration and encrypted memory settings. Database integrity checks
passed. Root migration 12 is applied; other account databases apply the additive
migration when their workspace opens. The previous release and backup remain on
the server for rollback.

Public HTTPS health returned 200, unauthenticated business APIs returned 401,
and the SVG, JS and CSS hashes matched the release bytes. No real user's account
was used for production tests. No macOS installer was produced in this release.

## Companion identity update — 2026-10-17

The current workspace uses an original NexBot `n` mark and four procedural
companion silhouettes in five colors. The existing 20 vector portraits remain
available in the classic gallery. Shape/color selections are draft-only until
applied; additive schema migration 12 stores versioned appearance metadata in
the account's Core database. Existing chat, identity and permission data remain
unchanged by that migration.

The chat has an 800px reading column and an auto-growing composer. The inspector
uses Work / Materials / Settings, with active work before tools and device links.
Selected companions follow actual thinking, executing, approval and completion
states. Contacts remain static, completion settles once, and both the local
motion preference and OS reduced-motion setting suppress animations.

Current verification:

- `pnpm typecheck`, `pnpm lint` and `pnpm build:core` passed.
- Appearance and account-workspace integration suites: 5 tests passed, including
  separate sessions, stale-version rejection, invalid/foreign/unauthenticated
  mutations and persistence through a service restart.
- `node scripts/smoke-personal-workspace.mjs`: 19 grouped renderer cases passed,
  including the actual delayed worker thinking/completion cycle, MCP approval
  and execution motion, motion preferences, 2560px reading width, 390px mobile
  layout, classic gallery, draft cancellation, server-backed appearance and the
  existing connector lifecycle. Evidence remains ignored under
  `release/workspace-verification-avatars/`.
- `node scripts/build-nexbot-icons.mjs` generates ICO/ICNS/PNG from the original
  SVG. Client packaging configurations and the window/login surfaces reference
  the new assets. A new production installer or macOS package was not built in
  this design pass.

For a visible interactive preview, run `node scripts/preview-personal-design.mjs`
after the Core build and client runtime preparation. This launches the real UI
against a disposable Core with synthetic login, model and MCP services, and no
host device. Model replies are deliberately scripted. Closing that window stops
the fixture and removes only its own temporary profile. Production data and
installed client profiles are not used by the preview.

The older evidence below describes the previous layout and release checks.

The Personal UI retains NexBot Core and NexorAI login. It now has a contact
sidebar, conversation column and detail inspector, plus generic remote MCP
management. Rakazo reuse and licensing are recorded in `third_party/rakazo`.

## Reproduce

```sh
node scripts/build-personal.mjs --core
node node_modules/vitest/vitest.mjs run server/personal-os/connectors.test.ts
node scripts/smoke-personal-workspace.mjs
node scripts/smoke-core-service.mjs
```

The workspace fixture runs the actual built Core and UI in a hidden Electron
renderer. It creates a dedicated temporary profile, synthetic NexorAI identity,
model and loopback MCP server. No real account or computer actions are used.
A staged Electron runtime from the desktop build is preferred. Screenshots and
result JSON go to ignored `release/workspace-verification-v2/`.

## Verified

- Seven connector integration cases: HTTP/SSE discovery and approved Pi worker
  calls; credential encryption/redaction; per-Agent allowlists; stale configuration
  rejection; clearing grants/credentials on target changes; cancellation with an
  unknown result and no replay after restart; persisted grants/credentials;
  authorization rechecks after handshake and before discovery commit; redirect
  rejection and URL validation, including credential redaction inside structured
  JSON with escaped characters.
- Twelve renderer checks: synthetic NexorAI login, three-column layout, actual
  worker conversation, contact search/pinning, per-Agent drafts, compact composer menu and collapsed
  Agent settings, connector
  creation/discovery/grants, approved calls, Stop, light/dark themes, mobile
  drawer/geometry, and disabling/enabling/deleting connectors. Some checks group
  related actions in one case.
- Thirteen standalone service checks including init/login, actual worker,
  account/data persistence, logout and service shutdown.
- Existing Personal OS, identity, client transport, service, memory and plugin
  suites: 78 passed and two existing migration-fixture skips. One initial test
  received an OS-assigned port rejected by fetch (`bad port`); the affected
  primary-computer test passed when rerun alone.
- Frontend/backend TypeScript, changed-file lint and whitespace checks.

Desktop evidence: `workspace-light.png`, `workspace-dark.png`,
`connectors-light.png`, `connector-approval.png`. Narrow-screen evidence:
`workspace-mobile.png`, `connectors-mobile.png` (390 × 844).

## Use and limits

**连接器 → 添加连接器 → 测试连接 → 管理授权**. The address is reached from Core,
so `localhost` refers to the Core host. HTTPS is supported; HTTP is allowed for
explicit loopback/private addresses. Credentials belong in the separate Bearer
Token field. UI state only receives `hasToken`. Changing the destination clears
old credentials and grants. Test again after editing before granting tools.

Agents read authorized tools through `connector.tools`, then use the existing
broker to call them. Every call requires argument-bound approval. Tool annotations
cannot bypass approval. Configuration/grant changes invalidate outstanding calls.
Stopping cannot undo an external side effect; dispatched interrupted calls are
marked unknown and never automatically replayed.

This delivery supports remote Streamable HTTP/SSE and optional Bearer
authentication. It does not launch stdio processes or implement OAuth/app
catalogs. These synthetic checks do not certify an individual third-party MCP
service. No live Core deployment or installer release is implied.


## Visual revision after review

The first delivery retained too much of the old profile-oriented interface.
The revised renderer follows the cached Rakazo reference screenshot more closely:
compact flat default avatars, two-sided message bubbles without repeated sender
headings, a single-row composer with a working quick-action menu, and an inspector
that leads with activity, connectors, devices and routines. Detailed Agent settings
are collapsed. Explicitly chosen custom character avatars remain available.
The v2 screenshots were inspected at 1440 × 960 and 390 × 844. All twelve renderer
checks passed after this revision; frontend types and the Core build also passed.

The subsequent 20-portrait collection replaces the flat default faces and the
legacy text-only shape controls with an illustrated grid picker. The fixture now
also checks all 20 images loading, applying a choice across sidebar/header/details,
and persistence through reload (13 checks total). Current screenshots are in
`release/workspace-verification-avatars/`; the earlier v2 screenshots remain for
comparison. The original SVGs and their manifest are in `src/personal/avatars/`.
