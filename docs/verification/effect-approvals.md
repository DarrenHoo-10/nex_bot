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
was also updated. See the [deployment record](chat-composer.md#production-deployment--2026-10-18).
