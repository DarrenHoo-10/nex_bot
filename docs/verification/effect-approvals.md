# Effect-based approvals — 2026-10-18

NexBot Core now distinguishes ordinary work from dangerous effects instead of
asking for every terminal write or MCP call. This changes server-side policy and
worker instructions; the device executor continues validating the same immutable
call envelope, device grant, policy version and lease.

## Standard-mode behavior

The composer now offers a persisted, per-assistant **Full access** mode. It skips
effect approvals, including dangerous operations, and releases that assistant's
still-valid pending approvals. Switching back to Standard restores this table.
Capability grants, account isolation, pause/logout and cancellation remain enforced.
See [chat uploads and permission modes](chat-composer.md).

| Effect | Approval |
| --- | --- |
| File reading, ordinary file creation/save/append | Automatic |
| Known read-only commands and pipelines; common save commands | Automatic |
| Complex ordinary scripts | Agent assesses effects and supplies `risk=standard` |
| Granted MCP read-only queries | Automatic with the versioned catalog's boolean `readOnlyHint` |
| Unannotated MCP queries / ordinary document saves | Agent assesses the actual tool and parameters and supplies `risk=standard` |
| Deletion, important-file replacement, external sending, payment, installation, security changes | Approval |
| Agent authority changes and memory deletion | Existing approval remains |

`risk=dangerous` always requests approval for terminal, GUI and MCP effects.
Recognized destructive command/tool patterns cannot be overridden with
`risk=standard`. MCP metadata is persisted from discovery, scoped to the granted
tool, and checked with the connector version; caller-supplied annotations are not
used. Conflicting destructive hints, sending/payment/deletion verbs and recognized
destructive parameters take precedence over read-only hints. Search text mentioning
deletion and queries about payments are not themselves destructive operations.

Important-file checks include credentials, databases and common system/project
configuration paths. The Agent must also identify user-important originals and
context-dependent overwrites by inspecting the target before writing. Shell
classification is a heuristic, **not a sandbox or a complete language parser**;
indirect scripts, GUI effects and unannotated MCP tools rely on the executing
Agent's assessment. Unknown effects without that assessment still require approval.
Neither an MCP server's claims nor external content may override user instructions.

Existing capability grants, workspace isolation, stale-version rejection, exact
approval digest binding, cancellation and no-replay behavior remain enforced.
The existing restart migration re-evaluates pending approvals under current policy;
it does not turn previously rejected/cancelled calls into executable work.

## Default capability inheritance — 2026-10-24

Default Agents now inherit the current capability registry. A stored snapshot no
longer silently prevents them from using capabilities introduced after creation.
Schema 22 repairs exact, frozen historical default sets only when there is no
user policy-edit audit and no Agent-created peer audit. Unknown custom sets and
creator-limited peers retain their restrictions. Upgrades increment the policy
version once; restarting again does not change it.

The observed legacy default lacked `attachment.read`, `connector.list`,
`connector.tools`, `connector.call`, `agent.create` and `agent.update`. Uploaded
images could display in the authenticated UI while the Agent's tool call was
denied before file access. The repair restores all default capabilities rather
than patching images alone. Image generation was already universally available.

New user-created Agents inherit defaults. New Agent-created peers inherit that
mode only from a default-mode creator; a restricted creator still passes only
its granted capabilities. Saving an explicit tool list through `bots/policy`
opts out of default inheritance, including after restart.

This does not select Full access automatically. Standard mode keeps ordinary
reads, document saves, assessed ordinary scripts and authorized connector queries
automatic. Dangerous effects, Agent authority changes and memory deletion retain
their existing approvals. Full access skips those effect approvals, while device
binding, attachment ownership, connector grants, account scope and revocation
continue to be enforced.

Focused verification (temporary databases and synthetic services only):

```powershell
pnpm exec vitest run server/personal-os/policy-defaults.test.ts server/personal-os/risk.test.ts server/personal-os/chat-composer.test.ts server/personal-os/connectors.test.ts server/personal-os/image-models.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

The composer fixture repeats upload → send → real worker attachment read →
authenticated download after upgrading a synthetic legacy default. It also checks
cross-Agent denial, redacted-reference denial and explicit user restrictions.
The migration fixture covers idempotence, custom/edited/creator-limited policies,
standard versus Full access and archived/unbound-resource rejection.

Verification result: policy-defaults, composer, connectors and the Core app suite
passed 62 cases; one pre-existing optional legacy-binary case was skipped because
its fixture bundle was not supplied. Risk and image-model suites also passed.
Server TypeScript checks and focused lint passed. The initial connector run hit
temporary loopback port errors; the complete connector rerun passed all nine
cases. No production configuration was changed by this verification.

## Remembered approval rules — 2026-10-24

Approval cards offer Allow once, Always allow and Deny. Always allow records a
rule only after validating the authenticated user's pending approval, exact
argument digest, expiry, task state and current policy/resource authorization.
It approves the current call and remembers the selected class of future effects.
No model tool can create these rules.

Rules are limited to the executing Agent. Terminal commands are scoped to the
device; computer actions to the device and operation; connector calls to the
connector and exact tool name; Agent updates to the target Agent. Other actions
are scoped to the action within the current Agent. Parameters may differ on
later calls. The approval card displays the scope, and the composer permission
menu lists saved rules with a direct Revoke control and an expired-state label.

Schema 23 persists rules and sync events. Agent policy or resource version
changes invalidate previous rules, and device/connector grants and account scope
are still checked before matching. Always allow does not select Full access.
Revocation restores approval for future matching effects. Already-approved or
executed individual calls are not undone or replayed.

```powershell
pnpm exec vitest run server/personal-os/approval-rules.test.ts server/personal-os/chat-composer.test.ts server/personal-os/connectors.test.ts src/personal/AgentDesktop.input.test.ts
```

The real-worker fixture exercises one-time approval, remembered approval,
automatic subsequent calls with different parameters, persistence across restart,
and revocation. Invalid sessions, digests, decision types and repeated decisions
cannot save grants. Scope fixtures cover different Agents/devices/tools, changed
policy/resource versions and revoked resources. Isolated Chrome rendering checks
the actual Always allow request, saved-rule menu at 1440px and 390px, and revoke
request using synthetic API responses and a disposable browser profile.

## Client parity follow-up — 2026-10-24

The worktree now includes native macOS and iOS controls as well as the shared
Web/Windows/Android renderer:

- `NexClientKit` decodes `remember_label` and `approvalRules`, sends the explicit
  `remember` choice with the approval digest, and revokes by rule id and Agent id.
  Older Cores without these fields still decode; native cards only offer Always
  allow when the Core supplies its scope.
- Both native chat cards and the iOS approval inbox offer Allow once / Always
  allow / Deny. The composer permission menu shows only the current Agent's
  rules, including invalidated rules, with a Revoke action.
- The native policy catalog includes all 28 current actions, including
  `attachment.read`, `image.models` and `image.generate`. Saving preserves
  unknown grants rather than discarding capabilities added by a newer Core.
- Native draft images have a 96-point contained preview with a direct corner X,
  including uploading and failed images. Removing an upload cancels its request
  and ignores its late result; sending protects the attached files from removal.
- Both native transcripts observe a persistent send revision, so even a fast
  send jumps to the bottom immediately. Sending leaves a search-history view
  before waiting for the server; failed sends retain the draft. Streaming only
  follows while the reader is at the bottom.

Android's authenticated entry is `Root.kt` -> `WorkspaceScreen`; Gradle builds
`src/personal/android-entry.ts` into its packaged WebView assets. The retained
legacy Compose `ChatScreen` is not the production chat. No new native bridge
endpoint is required: the existing relative JSON transport forwards approval
and revoke requests unchanged.

Checks run on the Windows development host for this follow-up:

```powershell
pnpm exec vitest run src/personal/android-bridge.test.ts src/personal/AgentDesktop.input.test.ts server/personal-os/approval-rules.test.ts
pnpm exec tsc -b
node scripts/build-android-ui.mjs
git diff --check
```

Observed: 17 tests passed, TypeScript passed, and Android workspace assets built
successfully. The bridge test verifies both the remembered approval payload and
Agent-scoped revocation. These are not an APK/emulator or native Apple UI result.

Added XCTest coverage for rule decoding/scoping, old-Core compatibility,
decision/revoke payloads, refresh and error propagation, sending from history
before the response, retry identity, and removal during image upload. Run on Mac:

```sh
swift test --package-path apps/apple/Packages/NexClientKit
```

This host has no Swift/Xcode or Android SDK. The new XCTest cases, macOS/iOS
compilation and native UI walkthrough still require a Mac and isolated fixture
using [native-clients.md](native-clients.md); Android APK/emulator validation uses
[android-workspace.md](android-workspace.md). No production deployment or client
publication was performed for this worktree.

## Isolated verification

Only disposable data, loopback fake model/MCP/identity providers and owned device
runtimes are used. No live account or user files are mutated.

```powershell
pnpm exec vitest run server/personal-os/risk.test.ts server/personal-os/connectors.test.ts server/personal-os/app.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
node scripts/build-personal.mjs --core
node scripts/smoke-client-device.mjs
```

Observed: 54 tests passed, one existing test skipped. Following
additional classifier edge cases, risk/connector suites passed again (14 tests).
The lifecycle smoke passed all 10 cases against the rebuilt Core and existing
packaged executor: ordinary document saving without any approval, pause/resume,
logout terminating an in-flight command, revocation and account/session isolation.
The real thin-node integration creates a file without approval, then proves a
delete marked `standard` does not remove it until the exact call is approved.
Both HTTP and SSE integrations execute read-only MCP calls without approvals and
hold a misleadingly read-only-labelled send tool until approval. Existing grant,
version, cancellation and credential-redaction checks pass. Type checking,
targeted lint and the Core build pass.

The checks above were isolated. The rebuilt Core and worker instructions were
subsequently deployed with the composer release on 2026-10-18; the local client
was also updated. See the [deployment record](chat-composer.md#production-deployment-2026-10-18).
