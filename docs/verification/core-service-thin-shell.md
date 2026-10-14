# Core service / thin shell verification — 2026-10-11

GitHub `main` was fast-forwarded to `89cdec3a`, which provides NexorAI account
login. The retained local external-memory changes were reconciled with it.
This delivery supersedes the earlier main-device desktop application.

## Artifacts

| Role | Artifact | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Standalone backend | `release/core/NexBot-Core-0.7.0-darwin-arm64.tar.gz` | 24529659 | `41b15a93b7c88d34e3d1e28c88b41c68e8a0c0b1322c46695000726278b9459e` |
| Thin Mac client | `release/personal-client-mac/NexBot-Client-0.7.0-macOS-arm64.dmg` | 110601570 | `44d97267b5d7123094cbdc4f2a560d1560e38f4220b30c9fe64406f74510ee5c` |

The backend requires Node 24+, with no Electron dependency at runtime. Its
archive is extracted and run through `core/service.js init` / `start` as
described in [the deployment guide](../../deploy/core/README.md). The client
DMG contains an Applications shortcut and the sandboxed login/browser shell.
The earlier 0.5.0 DMGs and staged main application were moved into the ignored
`release/archive/obsolete-desktop/` directory.

## Checks passed

- Seven source regression suites: 82 passed, two skipped. Skips are the absent
  legacy 0.3.3 / 0.4 migration fixtures, not new service or login behavior.
- Extracted service archive: 13 checks, including local owner initialization,
  password/log redaction, stable vault, mandatory account login, actual Pi worker
  task completion, one writer per data directory, fixed-port collision failure,
  preserved account/data across restart, logout and graceful signal shutdown.
- Two actual packaged thin clients: 17 checks covering independent account
  login, messages, approvals, routines, reconnect/history/privacy invalidation,
  independent revocation/logout and closing shells without stopping Core.
- Actual packaged shell login/restart fixture: 11 checks, including wrong
  password clearing, encrypted credentials, restart restoration, backend plugin
  settings, local/upstream logout, invalid-session cleanup and preserved data.
- Plugin tests preserve delivery/provenance/private banks, outage behavior,
  explicit migration and encrypted configuration. Async saves recheck the
  owner's authorization immediately before committing.
- Server/frontend TypeScript, changed-file lint and whitespace checks pass.
- The Mac client's signature passes `codesign --verify --deep --strict` and
  its DMG passes `hdiutil verify`. Read-only mounted ASAR bytes match the
  exact application exercised by the fixtures.
- ASAR inventory has eight entries: shell main/preload, connection assets,
  directories and package metadata. Resources contain only the application
  ASAR, Electron's default ASAR, icon and license/notice files. No Core, Pi,
  local database, client-node, canvas/PDF runtime, CUA or memory resources ship.
  Shell main contains no backend process launcher or device executor.
- The backend archive was inventoried, unpacked and compared with the build;
  its actual extracted CLI completed the service fixture. It contains Core,
  worker, CLI, UI, native PDF dependency and licenses, with no Electron,
  memory runtime, service data, credentials or live profile copied into it.

All mutations used explicitly owned temporary directories and synthetic
loopback identity/model services. No live account, profile, paid model provider
or remote server was changed. Test logs and screenshots remain under ignored
`release/core/`, `release/personal-mac/` and `release/personal-client-mac/`.

## Limits

The Mac package is ad-hoc signed, without Developer ID notarization. The
Windows client config is also shell-only, and the backend can be built natively
on Windows; no Windows artifact or physical cross-platform network was tested
on this Mac. The tarball's PDF binary is specific to macOS arm64.

The real user-center issuer is built in, but account behavior was verified with
the strict isolated nex_user fixture; a real human account was not used.
The external memory service was not provisioned or migrated. Existing desktop
profiles require an explicit original-key/data migration after stopping the
old app. Other computers require independent execution nodes; the client
shell deliberately provides no local device capabilities.
