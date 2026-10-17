# NexBot 0.8.0 release — 2026-10-17

The Windows portable client and production Core were delivered with the revised
contact sidebar, chat, detail panel, twenty SVG avatars and generic HTTP/SSE MCP
connectors. Existing NexorAI account login remains the authentication boundary.

## Artifacts

- Windows x64 client: `release/personal-client/NexBot-0.8.0-x64-Client-Portable.exe`
  (136770466 bytes). SHA-256:
  `f552073e438bdb3af5d4a039c95f057010b7648bd9839ac724ed7106ad45e749`.
- Linux x64 Core: `release/core/NexBot-Core-0.8.0-linux-x64.tar.gz`
  (25319136 bytes). SHA-256:
  `1f5b0b90833d869fe15a94e28a7f6b6e53ddc3a5546c780b17c3fbd295eb8232`.

The Linux archive uses the same bundled Core/UI bytes verified on Windows,
PDF.js 6.4.299 and canvas 1.0.10 with its Linux x64 GNU binary. The native npm
archive was verified against registry SHA-512 integrity before staging. It
contains no Windows computer runtime, Electron, service data or credentials.
The Windows client ASAR has eight entries: shell files, directories and package
metadata. It contains no Core or local device executor. The portable EXE is
unsigned. No macOS package was built in this Windows delivery.

## Verification

- Actual portable EXE: `smoke-shell-login.mjs --exe=...` passed 11 checks,
  including login, encrypted session storage, restart and upstream revocation.
- Two actual portable EXEs: `smoke-personal-clients.mjs --exe=...` passed 17
  checks, including real worker messaging, approvals, routines, reconnect,
  history, privacy invalidation and independent logout.
- Extracted Linux archive, on the production host with separate disposable
  directories and synthetic providers: `smoke-core-service.mjs --entry=...`
  passed 13 checks. Native canvas loading also passed under Node 24.21.0.
- The prior isolated workspace fixture passed 13 checks covering the new UI,
  avatar persistence, responsive layout and the MCP workflow. See
  [workspace verification](personal-workspace-connectors.md).
- No synthetic account, message, connector or model request was sent to the
  production workspace. Public production probes were read-only.

## Production result

`https://bot.nexorai.com.cn` serves the updated Core and UI. Existing Core ID,
account association, vault key, record counts and encrypted memory-plugin
settings were checked after deployment. SQLite integrity and foreign-key
checks passed; additive schema migration 11 is applied. Unauthenticated state
and connector requests still return 401. Nginx configuration validation passed.

Public JS and CSS bytes match the local build exactly:
`personal-DStUypbu.js` and `personal-vw_agtwx.css`. Cloudflare adds its existing
analytics script to HTML, so verification compares the referenced asset names
and their SHA-256 hashes instead of requiring identical edge HTML bytes.

The service was stopped for a consistent private data/config backup before
switching. Previous application directories and private backups remain on the
server; operational scripts and detailed receipts are in the ignored local
`release/deployment-0.8.0/` directory. Nothing was pushed to GitHub.

The initial directory-symlink switch exited before starting the service and was
automatically rolled back. The final deployment retains the existing physical
application directory. A second rollback came from comparing the randomized
encrypted memory-origin runtime marker; the saved memory settings were unchanged.
The corrected check compares the persisted memory settings, not that marker.
No application change was needed for either deployment adjustment.

## Scope

Avatars persist in this client's local preferences. The client connects to the
existing Core; a thin client does not itself become a Windows execution node.
Real account login and paid-model calls were not used as production tests.
