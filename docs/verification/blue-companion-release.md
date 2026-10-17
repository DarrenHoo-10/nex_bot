# Blue companion and account menu — 0.9.1, 2026-10-17

The Windows thin client and hosted UI use the approved blue companion mark.
The account avatar is blue, the left-aligned account row opens a menu, and
connectors, devices, settings, theme and logout live in that menu. The account
row has no white background. Preview fixtures explicitly say “演示账号”.

## Release boundary

The release snapshot starts at `885910ae` and overlays only the identity assets,
account menu, client version metadata, and corresponding fixture adaptations.
Unreleased Android, identity-refresh and CI changes in the working tree were
excluded. The original 0.9.0 backend executable remains running.

Only hosted UI resources were deployed. Content-addressed assets were added
before atomically replacing the HTML entry. Previous assets remain available
to open clients. The service PID did not change, and account data, vault keys,
configuration and databases were not modified. The previous UI archive is
retained privately on the backend host for rollback.

## Verification

- The exact release snapshot passed all 19 isolated real-renderer workspace
  checks, including account-menu navigation, light/dark themes, narrow layouts,
  appearance persistence, task animations and MCP approval/calls.
- The actual portable 0.9.1 executable passed all 15 isolated shell login and
  account-workspace checks, including encrypted login storage, restoration,
  logout, revocation, account switching and workspace isolation.
- The ASAR contains only the thin shell, login assets and package metadata.
  Its seven application files match the staged source byte for byte.
- All seven published UI files match the release manifest over public HTTPS.
  Health returns 200; unauthenticated business API access remains 401.
- All 78 installed runtime files match the tested unpacked package. The saved
  encrypted login file was unchanged during replacement. Desktop and Start
  menu shortcuts point to the installed 0.9.1 executable and blue icon.

All mutating checks used disposable accounts and directories. No verification
messages were sent through a real account. After replacement, the normal
installed application was opened for the user.

The Windows portable executable SHA-256 is
`bd6fb2a553d85de5b1befaeedaa1452ecf8a548e7b1f0b2b27e77f314d8efe08`.
Evidence and artifacts are under ignored `release/deployment-0.9.1/` and
`release/personal-client/`. macOS icon resources and version metadata are
updated, but a new macOS executable was not built on this Windows machine.
