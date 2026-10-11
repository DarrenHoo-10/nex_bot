# Personal AI OS Windows delivery verification

The Personal OS desktop is a separate product entry (`electron/nex-main.mjs`),
with the embedded Pi SDK and Core in `server/personal-os`. The legacy desktop
and its data remain available through the original commands. The Personal OS
build does not read legacy history or run a legacy CLI harness.

## Always use disposable fixtures

`server/personal-os/app.test.ts` creates Core and Device Node workspaces under
the OS temp directory, with synthetic owner tokens, encryption keys and a
loopback model provider. Real workers, SQLite transactions, SDK calls and DCP
WebSockets run against those fixtures. Cleanup only removes owned directories.

```powershell
node scripts/build-personal.mjs
node node_modules/vitest/vitest.mjs run server/personal-os/app.test.ts
node scripts/smoke-personal.mjs
```

The Electron smoke uses an explicit `--profile` and `--port=0`. It drives the
real renderer through its fixture-only DevTools connection: save model
settings, send an Agent message, read the reply, switch contacts, display
persisted memory, and verify layout. It hides the native window, observes a
scheduled task finish in the background, restores the window through a second
instance, and quits through the production shutdown path. Its
credential-bearing bootstrap file stays in that disposable profile, never in
release output. The released app does not enable DevTools by default.

## Test the shipped bytes

```powershell
node node_modules/electron-builder/cli.js --config electron-builder.personal.yml --win --publish never
$env:NEX_TEST_BUNDLE = "$PWD/release/personal-os/win-unpacked/resources/core/index.js"
node node_modules/vitest/vitest.mjs run server/personal-os/app.test.ts server/runtime/pi/p0/recovery-store.test.ts server/runtime/pi/p0/p0.test.ts server/runtime/pi/p0/guards.test.ts
Remove-Item Env:NEX_TEST_BUNDLE
node scripts/smoke-personal.mjs --exe=release/personal-os/NexBot-0.3.3-x64-Portable.exe
```

This runs the same workflow suite against the packaged Core and worker bundles,
including the shipped PDF.js/native canvas dependencies. It is stronger than
only running the checkout's TypeScript entry. The suite verifies:

- fixed Pi runtime with OpenAI-compatible and Anthropic API protocols;
- prefixed OpenAI base URLs, an exact request-address preview in Settings,
  and actionable 404 diagnostics with key redaction and no automatic replay;
- Agent inbox continuity across separate goals and restart, per-Agent history
  isolation, durable unread positions and exactly-once input receipts;
- routine wakeup without a new user message, occurrence deduplication across
  restart, queueing behind approval, pause cancellation and DST wall times;
- peer requests/results in both participating inboxes and one-time legacy
  transcript import without changing task/session identifiers;
- compact A2A send/receive markers in the initiating contact, a self-authored
  collapsed reply in the recipient contact, expandable full content, clickable
  peer navigation, and read-only projection of earlier system reply records;
- name-only Agent creation, optional/clearable supplementary identity, optimistic
  profile edits during work, current self/peer identity in each model request,
  no unsolicited messages or model calls on editing, and private memory isolation;
- durable input receipt, retry deduplication, final Core acknowledgement,
  model error classification and secret redaction;
- pending approval surviving restart, exactly one committed memory write,
  private versus shared recall and optimistic memory versions;
- persistent A2A parent/child/result routing, restart recovery and recursive
  cancellation, without copying the parent's private memory to the child;
- outbound Device Node pairing, directory confinement, immutable raw envelope
  hash, local permission version checks and disabled-by-default terminal;
- actual PDF extraction, an explicitly authorized terminal side effect and
  delivery retry without a second execution;
- long context compaction with preserved business input history and separately
  classified model invocation.

## Evidence limits

Device acceptance uses two isolated workspaces on Windows. A physical Mac Core
to Windows Node connection is not exercised. Provider protocols use synthetic
loopback APIs, not a customer's paid account. The NSIS installer and standalone
portable executable are built. Installer upgrades are performed only when the
user requests local installation; functional checks still launch the installed
executable with a disposable `--profile`, never the user's live data. The desktop
smoke additionally uses `--background-fixture`: closing the real window hides it
while Core executes a due routine. A second instance restores the same window,
then the authenticated desktop Quit action performs graceful shutdown. The
fixture disables system notifications and never changes Windows startup entries.

The initial release uses local owner identity. Native Identity API v1 and OIDC
remain the public design contracts for a later adapter, not implemented login
choices. A2A currently means the durable intra-Core protocol implemented here;
it is not a claim of compliance with an external A2A specification. Device
Node implements DCP v1 file/list/PDF and approved terminal operations; browser,
phone, camera and other roadmap capabilities are outside this release.

Unsigned Windows executables have no publisher certificate. Public distribution
signing requires a maintainer-owned certificate and is not performed by the
local package command. All package commands use `--publish never`.

## Generic Agent / Hindsight implementation fixture, 2026-10-11

The new implementation starts with zero Agents and creates arbitrary instances
explicitly. A2A and ordinary private writes/authorized reads are automatic;
dangerous terminal/document cleanup approvals belong to the executing contact.
Older release evidence below describes the behavior of those earlier bytes.

```powershell
node scripts/build-personal.mjs
$env:NEX_TEST_BUNDLE = "$PWD/dist-personal/core/index.js"
$env:NEX_TEST_LEGACY_BUNDLE = "$PWD/release/personal-os/win-unpacked/resources/core/index.js"
node node_modules/vitest/vitest.mjs run server/personal-os/app.test.ts server/personal-os/memory.test.ts server/runtime/pi/p0/recovery-store.test.ts server/runtime/pi/p0/p0.test.ts server/runtime/pi/p0/guards.test.ts
$env:NEX_HINDSIGHT_NATIVE = '1'
node node_modules/vitest/vitest.mjs run server/personal-os/memory-native.test.ts
Remove-Item Env:NEX_HINDSIGHT_NATIVE
Remove-Item Env:NEX_TEST_LEGACY_BUNDLE
Remove-Item Env:NEX_TEST_BUNDLE
node scripts/smoke-personal.mjs
```

Set NEX_TEST_LEGACY_BUNDLE only to the retained 0.3.3 fixture bundle; the
migration case is otherwise skipped. Never point it at a user's running data.
The native test requires UV and a cached isolated `hindsight-all==0.10.3`
environment. Prepare that cache with an explicit dependency bootstrap:

```powershell
uv run --no-project --isolated --with hindsight-all==0.10.3 python -c "import importlib.metadata; print(importlib.metadata.version('hindsight-api-slim'))"
```

The regular suite has 49 passing cases including migration; the explicit native
gate adds one. It starts real Windows PostgreSQL/Hindsight, proves service auth,
deferred retain transport attribution/accounting, committed delivery receipt
and clean managed-process exit. It uses synthetic ML and a loopback fake model.
It is not Chinese semantic-quality, complete derived-data forgetting or
production-runtime packaging acceptance. The existing installed executable and
user profile remain untouched. See the
[implementation record](../plans/2026-10-11-personal-agent-memory-implementation.md)
for implemented behavior and remaining release gates.

## 0.3.0 evidence, 2026-10-11

The bundled Core workflow suite (18 cases) and Pi suite (20 cases) pass: 38
tests in four files. Packaged `core/index.js` and `core/worker.js` match the
tested build by SHA-256. Frontend/server TypeScript and lint on the new code
pass. Both development Electron and `NexBot-0.3.0-x64-Portable.exe` pass the
desktop workflow above, including scheduled work while the window is hidden.
The screenshot is `release/personal-os/desktop-smoke.png`; fixture data and
credentials are not part of release output.

The NSIS installer exits successfully and installs product version `0.3.0.0`.
The installed `NexBot.exe` passes the same disposable-profile desktop smoke,
including background routine, hide/restore and graceful Quit. The existing
desktop shortcut still points to that executable. Private user data was backed
up outside the checkout before the authorized local upgrade.

## 0.3.1 identity regression, 2026-10-11

The bundled Core workflow suite now has 20 passing cases; together with 20 Pi
cases, all 40 tests in four files pass. Packaged Core and worker SHA-256 values
match that tested build. Frontend/server TypeScript and product-code lint pass.
The new API fixtures prove omitted/blank supplementary identity, stale-edit
rejection, editing the identity of a worker awaiting approval, current self/peer
identity on its next actual model request, unchanged permission approvals,
no inbox messages or model requests caused by profile editing, private memory
isolation, and persistence of the same Agent IDs across restart. Both provider
protocols send the current identity; internal compaction retains its own SDK
summarization instructions.

The desktop smoke additionally saves a blank identity via the real form and
creates an Agent using only a name. Its first model request includes the new
self identity and contact, without a profile edit triggering a model call.
`NexBot-0.3.1-x64-Portable.exe` passes this smoke, including background work
after hiding the window, second-instance restore and graceful Quit.
The NSIS upgrade exits with code 0 and installs `0.3.1.0`. The installed
executable passes the same disposable-profile smoke; the existing desktop
shortcut still targets it. Local databases and vault were backed up privately
before the upgrade; no real-user task or model call was used for testing.

## 0.3.2 A2A presentation regression, 2026-10-11

All 40 bundled Core/Pi tests in four files pass. Frontend/server TypeScript
and lint on the changed code pass. Packaged Core and worker SHA-256 values
match the tested bundles. The peer workflow additionally simulates an earlier
receiver-side system record, restarts Core, and proves that its read projection
becomes a self-authored reply without changing the persisted ID, sequence,
original text, or model request count.

Both `NexBot-0.3.2-x64-Portable.exe` and the installed `NexBot.exe` pass the
real-renderer smoke with isolated profiles and a synthetic provider. The
fixture sends a delegation through the composer, approves through the real
button, and verifies compact send/receive markers without duplicate result
body in the initiator's feed. Clicking the peer name opens the recipient;
the reply is authored by Writer, collapsed to an ellipsis by default, and
can be expanded and collapsed. An SSE refresh retains an expanded reply.
The screenshots are `desktop-smoke.png` and `desktop-a2a-smoke.png` in the
local release folder, using synthetic fixture content only.

The extended portable smoke caught a packaging defect after tray restore:
the second launcher shared and removed the first launcher's resource folder,
so a subsequent worker could not start. The portable build now uses a separate
NSIS plugin directory for each launch. In the pinned builder 26.15.3 code,
`unpackDirName: true` omits `UNPACK_DIR_NAME` and activates this behavior;
its type documentation incorrectly describes `false`. The shipped portable
passes the same A2A workflow *after* second-instance tray restore.

The NSIS upgrade exits with code 0 and installs `0.3.2.0`. The desktop shortcut
still targets the installed executable. A private backup was created outside
the checkout after graceful Quit. Read-only before/after comparisons confirm
unchanged Agent profiles, inbox messages, memory metadata/content, canonical
A2A records, model connections, encrypted secrets and vault bytes, with no
foreign-key violations. Functional verification does not send messages or
call models against the live user's profile.

## 0.3.3 A2A display follow-up, 2026-10-11

Incoming peer messages now show only the sender marker; the task card and
its expand control are removed. A recipient's own successful reply remains
collapsed, with `已回复给{peer name} · 展开` in the summary. Expanding shows
the full reply and a collapse control. Streaming replies use `正在回复给`
until a completed reply is published.

Frontend TypeScript and lint pass. Development Electron, the 0.3.3 portable
executable, and the installed executable all pass the isolated desktop smoke.
The renderer assertions additionally verify the absence of the task card,
the recipient-aware summary, expansion/collapse and retention across refresh.
Core and worker bytes remain identical to the 0.3.2 bundles that passed the
40-case business/runtime suite; this display-only change does not repeat that
unchanged suite. Packaged and installed bundle hashes match those bytes.

The installer exits with code 0 and product version `0.3.3.0`. Read-only
comparisons against the private pre-upgrade backup confirm unchanged profiles,
messages, memory, canonical A2A records, model configuration, encrypted secrets
and vault bytes, with no foreign-key violations. The desktop shortcut targets
the installed executable. Functional checks use disposable profiles, never
the user's live messages or paid model account.
