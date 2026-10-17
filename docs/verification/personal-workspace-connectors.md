# Personal workspace and MCP connectors — 2026-10-17

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
