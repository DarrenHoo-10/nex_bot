# Core service and thin shells

This decision supersedes the earlier main-device Electron application. A main
device is now a backend deployment, whether its host is Mac or Windows. Every
desktop package is the same thin-client role.

## Responsibilities

- Core: fixed nex_user login adapter, account association, session validation,
  contacts, messages, Pi workers, routines, approvals, model configuration,
  persistence, host device execution and external memory plugins.
- Client shell: backend address, transient login form, OS-encrypted Core session,
  sandboxed remote UI, window lifecycle and opening approved external links.
- External services: nex_user owns account credentials/status; memory providers
  own their retrieval databases, models and deployment lifecycle. Independent
  device nodes provide execution on other machines.

The shell has no Core/worker/UI business bundle, local database, canvas/PDF
runtime, CUA SDK or Device Node. Its package contains only Electron, the
connection page, main/preload and license files. Remote UI is served by Core.
Closing the shell cannot kill Core because it has no owned backend process.

## User-center integration

GitHub commit `89cdec3a` supplies the nex_user bridge and identity migration.
Production always uses `https://user.nexorai.com.cn`. Existing users/workspaces
and their Core ID remain stable. Core still validates the account at business,
task and tool boundaries, fails closed on user-center failure and revokes
session-owned work without affecting other independently valid clients.

Headless `service.js init` replaces the desktop's private bootstrap. The local
operator enters the account via a masked terminal prompt or private stdin.
The command performs the existing one-use transaction, associates the owner,
revokes its temporary session and closes. No bootstrap token is printed, and
no public first-user takeover path is added. Shells cannot initialize Core.

## Lifecycle and storage

`service.js start` runs under standalone Node 24+, with a persistent private
vault key from a protected file or environment. An atomic PID/nonce lock keeps
one writer per data directory. Graceful signals stop owned workers and sockets
and release the lock. The program directory is separate from data; deployment
is managed externally by launchd/systemd/a Windows service wrapper.

Memory outbox dispatch continues to require a valid account session. Plugin
configuration is available through authenticated shells for the linked owner.
Async plugin saves recheck authorization immediately before committing, so a
logout during migration probing cannot save a new destination. Configuration
changes apply on backend restart. Backend-host directory grants are explicit
server paths; shell-local filesystem/execution bridges have been removed.

## Deliverables and limits

`build:core` creates the backend distribution without downloading Electron.
`package:core` creates a platform-specific service archive. `build:client` stages
only Electron, and the Mac/Windows client configs include no backend resources.
The old personal desktop entry is a compatibility alias to the thin shell;
the old main-device installer configs are removed. Earlier DMGs are archived.

Mac artifacts are built and verified here. Native Windows packaging is defined
but must run on Windows; a Windows runtime or physical cross-platform network
has not been qualified by this Mac run. Existing desktop data/key migration is
explicit and does not mutate a live profile during verification.
