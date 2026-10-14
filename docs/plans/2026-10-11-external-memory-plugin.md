# Superseded desktop topology

The external-memory boundary remains valid. Main-device app packaging and local-only plugin administration are superseded by [Core service and thin shells](2026-10-11-core-service-thin-shell.md).

# External memory plugins and macOS delivery

Accepted direction: Core may run on macOS or Windows, with either platform also
acting as a thin client. Memory infrastructure is an independently operated
service configured through a plugin, never part of the desktop installer.
This supersedes the embedded Hindsight delivery described in earlier plans.

## Boundary

Core owns contacts, messages, tasks, approvals, original memory sources and the
durable delivery/provenance ledger. The external service owns extraction,
vectors, retrieval, synthesis, its model configuration and its database.
Clients connect to Core and do not create another memory service or index.

`memory-plugin.ts` is a registry of reviewed protocol adapters. The initial
adapter is Hindsight HTTP API v1, qualified against the existing 0.10.3 contract.
It supports authenticated HTTPS and loopback/private IPv4 HTTP. Configuration
does not download or execute plugin code. Adding another backend requires an
adapter preserving the ledger's delivery, provenance and retirement semantics.

The production Core no longer imports `ManagedMemoryService`. The historical
Python launcher and native infrastructure fixture remain available for explicit
development tests, outside the desktop build and its lifecycle. Package configs
exclude the Python sidecar and all memory-runtime resources on both platforms.

## Configuration and failure behavior

The local main-device owner can test, enable, configure and disable the plugin
in Settings. A client can view status but cannot change the target. Settings and
the service token are encrypted using Core's existing vault. State responses
contain only the endpoint and whether a token exists. An empty token preserves
the old token only for exactly the same provider and normalized origin.
Redirects are rejected; transport errors do not include service responses.

Saved settings apply at the next Core restart. This avoids changing an active
memory operation's destination or mixing responses from two services. A pending
restart is explicit in the UI. Connection failure leaves Core usable, preserves
the outgoing ledger and retries startup; an established connection's failures
are retried by the existing ledger. Disabled plugins do not start a process or
contact a service. Raw local records remain available without a plugin.

First enablement sends queued valid sources to the configured service. Switching
an already-used endpoint requires the existing bank identities to be present at
the destination, including outstanding retirement identities. This check runs
at save and startup. It is a migration preflight, not a database backup or a
proof of complete data equality. Users must migrate the external database and
retain appropriate backups. Disabling preserves the binding, queued work,
local source records and external data; it does not imply remote deletion.

Core still validates provenance and bank generations before displaying facts,
and uses the adapter's existing operation and retirement protocol. Manual Stop
aborts the task's current outbound memory request. An independently operated
service controls its own model credentials, billing, background tasks and
physical data retention; Core no longer proxies or guarantees termination of
those external model calls. It never stops the service when a desktop exits.

## Distribution

Two Apple Silicon DMGs contain NexBot Core and NexBot Client respectively.
Core includes Pi, the UI and a small PDF runtime. Client includes the connection
UI and Device Node. Neither includes Python, PostgreSQL, Hindsight or ML weights.
The Windows Core installer uses the same exclusion. macOS terminal commands run
in owned process groups so Stop terminates their descendants as well as the shell.
Native window automation remains Windows-only; capability text reflects that.

These are ad-hoc signed local builds, without Developer ID notarization. macOS
fixture profiles use distinct application/keychain names so validation does
not request access to the regular application's encrypted storage.
