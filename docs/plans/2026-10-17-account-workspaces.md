# Independent NexorAI workspaces

User approved keeping the existing workspace with its original account and
giving every other authenticated NexorAI account its own workspace. Do not
rebind the existing owner or relax its subject check.

Keep the per-workspace Core authorization boundary and databases. A service
router resolves verified upstream issuer/subject to a private workspace with
its own database, vault, agents, messages, models, memory and MCP grants.
Only successful upstream authentication may provision a workspace. Incoming
requests route by an existing session's token hash, never an email, path or
caller-supplied account ID. Device upgrades route by their scoped pairing
credential. The endpoint's stable public Core ID preserves thin-client login
compatibility; internal workspace Core IDs remain distinct.

Hosted service mode does not expose its own host executor to account users.
Each account may pair its own independent execution device. Existing data,
identity binding and encrypted configuration remain in place. New workspaces
start empty and do not copy another account's credentials.

Verify two synthetic accounts, wrong passwords, forged cross-account IDs,
cross-account session/device revocation, memory and connector isolation,
concurrent first login, restart, legacy session compatibility and browser/SSE
routing in isolated fixtures before production deployment. Preserve private
server backups and never run synthetic mutations in production.

Hindsight tools were not exposed in this session's tool inventory, so no
memory search/capture result is claimed.
