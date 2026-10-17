# Account workspaces — Core 0.8.1, 2026-10-17

The user chose independent NexorAI workspaces, preserving the original owner's
data instead of rebinding it. Production now starts with `--account-workspaces`.
The existing Windows 0.8.0 client remains compatible; no client update is needed.

## Behavior and boundaries

- The upstream identity provider validates the password and session before a
  new workspace can be provisioned. The routing identity is issuer plus immutable
  subject, never the email, display name or a caller-supplied workspace path.
- The original Core database, owner binding, public endpoint ID and existing
  sessions stay in place. Other accounts use separate databases and distinct
  HMAC-derived vault keys under the private `account-workspaces/` directory.
- Session token hashes select the workspace. Each selected Core independently
  validates membership, expiry, revocation and upstream identity. Cookies,
  Bearer requests, token restoration and SSE use the same routing boundary.
- Device pairing tokens select only their own gateway. The service-host
  executor is disabled in hosted account mode; accounts can pair independent
  execution nodes. No child Core opens an additional listening port.
- New workspaces start empty. Models, plugin credentials, connectors, grants,
  agents and messages are not copied from the original owner. Memory banks
  retain independently generated provider IDs. This is application-level
  workspace isolation, not OS-container isolation for arbitrary server code.

## Isolated evidence

`server/personal-os/workspaces.test.ts` covers wrong passwords without
provisioning, concurrent first login, legacy sessions, distinct vaults and
internal IDs, restart, upstream revocation, actual model messages, memory,
connectors, foreign object IDs, cookie/SSE routing, cross-origin rejection,
device upgrades, foreign device/session revocation attempts and logout.

Seven personal service regression suites finished with 77 passed and one
existing skipped case after rerunning the connector suite: the initial
connector attempt hit the OS's random Fetch-forbidden port. The focused final
account/connector run passed all 11 tests. Frontend/server TypeScript,
changed-file lint and whitespace checks passed.

The actual portable 0.8.0 EXE passed 15 shell checks against synthetic accounts,
including a second account's empty workspace, restart, switching back to the
original owner and retaining each account's contacts. Command:

```sh
node scripts/smoke-shell-login.mjs --account-workspaces --exe=release/personal-client/NexBot-0.8.0-x64-Client-Portable.exe
```

The built service CLI passed 17 checks on Windows and another 17 from the
extracted Linux archive on the target host. All used disposable temporary data,
synthetic identity/model providers, an actual Pi worker, and independent service
restarts. No real account password or synthetic production mutation was used.

## Production deployment

The Linux archive SHA-256 is
`8f8ee3f9bb7fb805ef200d14c4caa0059ede1a06b0bb3aa70ae27a12434fe18e`.
It includes Linux canvas 1.0.10 and the verified UI/Core bundles, without
credentials or live data. Production runs from its separate 0.8.1 release
directory through a systemd drop-in. The original application and environment
configuration remain intact. A stopped-service private data/config backup was
created before activation, and the original vault and full data directory
remain the backup unit for both existing and additional accounts.

Read-only post-deployment checks verified SQLite integrity, foreign keys,
original Core ID and identity rows, vault checksum, data counts, exact model
configuration and encrypted memory settings. Public `/health` advertises
`accountWorkspaces: true`; JS/CSS hashes match the local build. Operational
scripts and receipts stay under ignored `release/deployment-0.8.1/`.

The first script-preparation command was rejected by automatic review without
a specific reason. The final deployment used a narrower, independent systemd
override, leaving the original environment file and application directory intact.
