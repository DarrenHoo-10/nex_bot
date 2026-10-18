# Desktop client with a local device executor

Updated 2026-10-18. This supersedes the **no local executor** aspect of the
[thin-shell recipe](core-service-thin-shell.md). Core, Agent workers, model
credentials and memory remain on the server. The desktop now includes a DCP
device runtime and the matching UI; it does not run another Agent or Core.

## User flow

- Login automatically registers this computer and enables files, commands and
  supported computer control. There is no first-use authorization dialog.
  Old declined grants migrate to enabled control; an explicit Pause is retained.
- Settings → Devices is one list of signed-in devices, with online/offline
  status and a small current-device marker. Only the current row has Pause/Resume.
  It reads `/api/clients`, not legacy execution-node records, so server nodes and
  old executor bindings do not appear as duplicate login devices. Other devices'
  presence is based on a recent login heartbeat (90 seconds), not an instantaneous
  socket signal. Revoked/expired logins are omitted by the existing server API.
- Settings headings and fields have no redundant descriptive subtitles. Necessary
  loading, error, save feedback and interrupted-operation recovery remain.
- Commands run as the current OS user. The user's home directory is the read-tool
  boundary and default command working directory, **not a command sandbox**. Commands
  can access anything that OS user can access. Core uses [effect-based approvals](effect-approvals.md):
  ordinary reads and document saves are automatic; dangerous effects need approval.
- Restarting with the same login restores the device identity. Pause stops the
  runtime and is retained across restart/login until Resume is chosen. A new
  login creates a fresh device binding while preserving that workspace's pause
  preference. Switching accounts does not inherit another workspace's pause.
- Quitting closes the socket and stops owned commands. Logging out additionally
  revokes the device. Remote device revocation never silently creates a
  replacement; sign in again to establish a new binding.
- A main-process session check runs every 15 seconds independently of the UI.
  Failure closes the executor; a later successful check can reconnect it.
  Network requests time out after 15 seconds, so remote login revocation is not
  instantaneous. Explicit local logout stops execution immediately.

## Architecture and platform contract

`electron/nex-client-device.mjs` owns lifecycle and session checks. Its storage
binding scope hashes origin, Core ID and session ID. The separate local-control preference scope
uses the authenticated snapshot's persistent **per-workspace** `sync.coreId`,
not the shared public service ID or a display name/email. Older servers without
this workspace identity fall back to session-scoped preferences. Binding metadata,
control preferences and the local database encryption key use Electron
safeStorage. Device credentials never enter the renderer bridge. The executor
has its own encrypted secrets database and durable DCP journal; interrupted
operations are not automatically replayed.

`server/personal-os/client-node.ts` wraps the existing DeviceNode. Deferred
connection lets the controller verify the account before opening DCP. Restoring
a saved node no longer forcibly enables commands or computer control. Policy
versions survive restarts.

`scripts/build-client-executor.mjs` bundles the executor, PDF dependencies and
matching UI. Windows also receives the pinned native CUA SDK. Both desktop
builder configurations include these resources. Agent/model execution stays
remote; the server executor only operates the server's own files and windows.

| Capability | Windows | macOS / Linux implementation |
| --- | --- | --- |
| DCP, file listing and reading | Included | Shared Node implementation |
| Commands and file writes | PowerShell | `/bin/sh` |
| Window screenshots and input | Bundled native CUA SDK | Not implemented in this adapter |

Mac must build on a Mac so Electron and canvas match its architecture. Run
`pnpm package:client:mac`; Windows runs `pnpm package:client:win`. This delivery
was executed on Windows; Mac has not been hardware-validated. Linux has shared
executor code but no desktop packaging path in `build-personal.mjs`.

## Isolated verification

Never run these mutations against live profiles or accounts. Each script below
creates its own temporary profile, fake identity/model and disposable Core.

```powershell
pnpm build:core
pnpm build:client
node --test electron/nex-client-device.node-test.mjs
node scripts/smoke-client-device.mjs
pnpm exec vitest run server/personal-os/computer.test.ts server/personal-os/client-transport.test.ts
node scripts/smoke-shell-login.mjs --account-workspaces --expect-local-ui
node scripts/smoke-personal-computer.mjs --resources=dist-personal/server --client-executor --screenshots-only
```

Observed results:

- Lifecycle fixture: 10 cases, including automatic login control, migration of old declined grants, control restored
  after fresh login, pause persisted across restart, real authorized file reads, packaged
  PDF worker/native canvas loading, traversal
  rejection, an ordinary command that saves a document without approval,
  process-tree termination on logout, no resurrection after revocation and
  account isolation/background expiry.
- Registration race: a pairing response arriving after logout is revoked and
  never starts an executor.
- Computer/transport unit tests: 9 passed.
- Packaged Electron shell: 30 checks passed, covering first-login automatic connection without any seeded grant,
  pause/resume, removed device controls, login restoration, local UI, settings, logout and workspace
  isolation.
  The fixture starts with a fresh, empty profile and does not seed authorization
  or bypass any production dialog. It also checks three login-device rows,
  heartbeat presence, the single current-device marker and minimal settings copy.
- Source and packaged native executor: 9 cases passed each using its real DCP connection, window
  screenshot/restore, native Unicode input, risk approval and durable receipts.
  The fixture only operates its own synthetic window. UIA tree reads were
  intermittently unresponsive on this machine; the successful run used
  screenshots without the optional accessibility tree. This does not establish
  reliable UIA-tree support for every Windows application.

Packaged-shell regression uses `--exe="<unpacked>/NexBot Client.exe"` on the
shell script. To test the shipped native payload, add
`--executor-resources="<unpacked>/resources/client-executor"` to the computer
script. Screenshots contain synthetic identities only; the device screenshot
is recorded in `doc/ui/devices-local-light.png`.

Windows packaging explicitly copies the executor's `node_modules` as a separate
resource set; otherwise electron-builder filters out the PDF dependencies.
The packaged lifecycle fixture was also run under Electron's Node 22.22.1.
The final portable package is 161.31 MiB; the unpacked client is 421.84 MiB,
95.45 MiB larger than the previously installed thin client. These figures
include native window control and PDF/canvas dependencies.

The existing server DCP and account APIs support this client without a protocol
migration. Updated built-in device/computer skill wording in source explains
the new permission flow; it takes effect on servers when their next Core build
is deployed.

## 2026-10-18 local update

The final package uses `release/personal-client-login-control-final/` (a fresh
output directory after Windows held the previous fixture executable). Its
30-case packaged shell run passed, including the `NexBot` window title. An
intermediate run timed out waiting for the fixture process to quit; the final
clean package completed all exit and logout checks. The local application was
replaced with 663 file hashes verified and the saved-login file unchanged.
The previous application directory was retained for rollback. Updated account,
model, memory and device screenshots in `doc/ui/` use synthetic data only.
