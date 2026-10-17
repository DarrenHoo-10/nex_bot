# Personal UI refresh and MCP connectors

Approved scope: retain NexBot Core, identity, device execution and message semantics. Refresh the contact sidebar, chat and inspector using Rakazo as the reference, reusing isolated presentation code with its license and provenance. Preserve existing uncommitted work and data. No production account or device mutations during verification.

The first connector delivery supports user-configured remote MCP (Streamable HTTP and legacy SSE), optional encrypted bearer credentials, connection testing/tool discovery, explicit per-Agent tool grants, disabling/removal and actual broker execution. No application-specific OAuth/catalog is implied. Connector calls require existing argument-bound approval; cancellation is forwarded and uncertain effects are never replayed. Configuration changes invalidate outstanding calls. Credentials never enter UI state, model context or logs.

Use Rakazo's presentation patterns without importing its authentication, RPC server or database. Maintain one continuous Agent inbox, private/shared memory, folded A2A replies, visible approvals and Stop. Test against owned temporary Core/model/MCP fixtures and inspect desktop/narrow layouts. Existing private data is not migrated.

Hindsight discovery was attempted, but no Hindsight tools were exposed in this session; this file records the accepted scope locally.

Implemented and verified on 2026-10-17. See
[`../verification/personal-workspace-connectors.md`](../verification/personal-workspace-connectors.md)
for the isolated fixtures, evidence and supported connector transports.


User visual correction (2026-10-17): the first screenshot still resembled the old
UI. Reworked the actual conversation structure using Rakazo's reference screenshot,
not only its colors: compact identity, two-sided bubbles, one-row composer with
quick actions, operational inspector and collapsed configuration. Verified as v2.
