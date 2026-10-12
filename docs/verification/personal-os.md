# Personal AI OS Windows delivery verification

## Mandatory account login (2026-10-12)

Production 0.6.0 uses the built-in `https://user.nexorai.com.cn` nex_user
bridge. It requires account login in desktop, thin client, Core APIs, SSE,
runtime requests/tools and memory model transport. A private local bootstrap
can associate the first account; it cannot access business APIs. Invite login
and local-owner access are confined to explicit legacy protocol test factories.
Desktop IPC does not allow disabling the identity gate.

Use disposable fixtures only:

```powershell
pnpm test:personal
pnpm build:personal
node scripts/smoke-personal-login.mjs
node scripts/smoke-personal.mjs
node scripts/smoke-personal-clients.mjs
# Repeat with --exe=<qualified unpacked/installed EXE> for delivery.
# Full native memory qualification:
node scripts/smoke-personal-memory.mjs --exe=<qualified NexBot.exe>
```

The login fixture supplies a loopback-only synthetic nex_user service through
an explicit disposable `--profile`. Normal startup always uses the built-in
issuer. No real password, account mutation or live profile is used in tests.
Ignored `login-result.json`, `two-client-result.json` and screenshots are
evidence, not source-controlled user data. The login fixture covers actual
form failure/success, native IPC gating, DPAPI persistence, restart restoration,
logout and upstream revocation on restart. HTTP tests also cover independent
client sessions, transaction replay, encrypted upstream credentials, the
sixty-second status bound, fail-closed outage, delayed uploaded mutations and
cancellation of the actual signed-in actor's task.

The final 0.6.0 installed desktop passes **17 login cases**. The final thin
client portable passes **18 two-client cases**, including logout clearing its
DPAPI credential and Node grant, stopping its gateway connection, and keeping
the other account session usable. The regular desktop fixture passes **28
cases** with login enabled, covering contacts, A2A, message feedback, manual
Stop, routines, settings and tray behavior.

Memory outbox work stays queued before account authentication, without
extraction requests or consuming retries. A configured Core also defers native
memory startup until authentication. The final identity/memory unit run passes
**24 tests with one explicit historical-bundle skip**; TypeScript and lint
pass. The final four-suite protocol run passes **64 tests with two explicit
historical-bundle skips** (66 cases total).

The installed executable, app.asar, and all 23 Core/UI bundle files match the
qualified unpacked build. After graceful shutdown and a private backup outside
the checkout, read-only comparison confirms **1,294 unchanged profile files**
with no additions. The desktop shortcut targets the installed 0.6.0 executable
with no fixture arguments. Functional checks use their own disposable profiles,
not the user's live data. This does not claim a real production account login
has been performed.

The installed native-memory fixture also passes default Chinese extraction,
private isolation, synthesis with original-source expansion, confirmed
forgetting, normal Core shutdown and stopping its owned PostgreSQL. It makes
four synthetic model requests. The first installed run hit the deliberate
renderer invalidation when native extraction finished before its Core delivery
receipt; the fixture now waits for pending delivery to settle before driving
source expansion. The repeated installed workflow passes without changing the
application's privacy behavior or extending its timeouts. Its original isolated
fixture was retained when automatic approval review rejected cleanup with
`blocked by policy`; it is outside release resources and the live profile.

The installed memory-runtime gate verifies **45,161 file hashes and 213 exact
dependencies**, Python 3.12.10, Hindsight 0.10.3 and the previously qualified
100-query Chinese Recall@10 = 0.96. This gate checks the actual installed bytes;
it does not rerun the labelled retrieval experiment.

Final 0.6.0 artifacts:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.6.0-x64-Setup.exe | 1,641,549,268 | `28C7A3C252B97FDC7A84AFBEBEDF07876C0C56C1EB42EA7C2EE4BB01A2012960` |
| NexBot-0.6.0-x64-Client-Portable.exe | 169,292,184 | `5E768ACC52FF0A0DAF315A416CD810C34D31A07B4809A6B25E1749B69DEED2EC` |

The older local-owner and invitation instructions below are historical and
do not describe 0.6.0 account access. Two migration tests require separately
provided genuine older bundles and otherwise skip explicitly.

## Unlimited cumulative tasks and manual Stop (2026-10-11)

The latest user decision supersedes the 400,000-token, 24-model, 40-tool and
thirty-minute task limits below. Schema v9 renames the frozen v1 limit columns
to legacy fields without rebuilding task relations or altering old receipts.
New and existing tasks no longer consult cumulative token/call/time limits.
Task reflection is accounted separately from capped automatic background
maintenance. The Agent composer exposes a real Stop button, including while
waiting for approval or a peer.

Stop atomically fences the whole A2A subtree before killing its workers,
aborts associated memory-model transport, and cancels owned terminal processes
over digest-checked DCP. Interrupted native input and unconfirmed device effects
remain unknown. Recovery cannot restart a persisted manual stop. Offline devices
receive cancellation again at reconnect; results completing on an old socket
are delivered through the current socket only for the same authenticated binding.
A late device failure cannot replace cancelling with needs_reconciliation or
queue another model request.

The ten-suite regression passes **86 tests, no failures or skips**. After the
final reconnect receipt correction, the four affected suites pass **61 tests,
no failures or skips**, including the added disconnected-device case (87 distinct
cases across the two runs). A real Pi SDK fixture completes **26 model requests,
42 tools and more than 400,000 accounted tokens** with its old thirty-minute
deadline in the past. Owned terminal stop is checked both online and after
disconnect, with no late command output, no follow-up model call and no restart.
Memory transport cancellation, native input unknown completion, A2A stop and
persisted cancelling recovery also pass. Evidence is ignored
`manual-task-control-result.json` and `manual-task-control-final-bundles-result.json`.

Final installed resources are compared by hash with the qualified Core/UI build.
Before update, **1,292 profile files** are copied to an external private backup
and all hashes match; the closed profile still matches that backup after the
final resource copy. All **27 Core/UI program files** match. Neither credentials
nor messages, memories or private backup contents enter release archives or Git.
The isolated installed desktop passes all **28 checks**, including an actual
composer Stop click and disappearance of the processing dots. Final installed
native Windows tests pass **nine checks** when run sequentially with other
visible desktop fixtures. The final Client portable EXE passes all **15
two-client checks**, including message/approval/privacy/reconnect synchronization
and independent logout without shutting down Core. All fixture model requests
use synthetic loopback services; this does not claim a paid-provider browser
workflow or a two-physical-machine network test.

After normal application relaunch, read-only checks confirm Schema **9**, quick
check **ok**, zero foreign-key violations and enabled primary-device terminal/
computer capabilities. The desktop shortcut still targets the installed NexBot
EXE with no arguments. Server/frontend TypeScript, changed-file lint and diff
checks pass. Detailed private backup/program evidence remains ignored.

Both final packaging commands exit 0. The delivery guide and SHA256SUMS.txt
are updated. These final hashes supersede earlier 0.5.0 artifacts below.
The installed update copies qualified program resources; it does not repeat
the full NSIS installation or replace the user's profile.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Core Setup | 1,614,298,188 | `67280F4122D1474334B202C636D5AB349DC77E3FC8E49F57A114E5FCBA56159B` |
| Client Portable | 169,425,617 | `711EF6B499D384234EAF0A30F9B24C1E08B8FBBF018DFADB5643BFA23E2F6D5A` |

## Model-request boundaries and window restoration (2026-10-11)

The reported browser task reached working device tools. Read-only scalar
diagnostics showed seven model completions in the Pi projection and a Core
100,000-token task limit; accumulated usage plus the next 16,384-token
reservation exceeded it. Core rejected the next request before transport.
The provider SDK flattened that rejection to `Connection error.` and its
error event reused the previous invocation ID, overwriting the successful
invoice. Window restoration had also failed twice because enumeration was
incorrectly required to be preceded by a screenshot of a minimized window.
No user transcript, window title, endpoint, credential or private memory is
copied into this verification record.

New tasks have a 400,000-token cumulative budget with the original 24-model,
40-tool and thirty-minute bounds. Existing tasks and daily background-memory
limits are unchanged. Cache input tokens count toward task usage. Core
rejections retain their actual cause and do not overwrite an earlier receipt.
Actual dropped connections report bounded transport codes/address without
request secrets or automatic retries. A genuinely enumerated window can be
restored; input still requires a fresh successful screenshot observation.

The qualified Core/client bundles pass **84 tests, zero failures or skips**
across ten suites, including token/call rejection through the real SDK,
unchanged successful usage, cache-input accounting, a new subsequent task
without effect replay, dropped transport, memory, A2A, approvals and recovery.
Evidence: `release/personal-os/model-boundary-result.json` (ignored).

The unpacked and updated installed EXEs each pass all **28 desktop checks**
and **nine native computer checks**. The native fixture now minimizes its own
Electron window, restores it through DCP/Pi without a shell or approval, then
verifies fresh observation, ordinary Unicode input, explicit dangerous-input
approval and durable receipts. The newly packaged Client portable EXE passes
all **15 two-client checks**. These are disposable profiles and synthetic
loopback model requests, not mutations against the user's application or
verification of a paid provider/browser search. Server TypeScript, changed-file
lint and diff checks pass.

The closed live profile is backed up outside the checkout: all **1,291 files**
match their backup hashes. All **25 Core/UI program files** match the qualified
unpacked resources after copying; live profile hashes are unchanged before
normal relaunch. This is a program-resource update of the installed application,
not another full NSIS installation. Private backup paths and detailed program
hashes are in ignored `model-boundary-install-verification.json`.

After normal relaunch, the desktop shortcut still targets the installed EXE
with no arguments. Read-only integrity is `ok`, foreign-key violations are zero,
and the primary device's active terminal/computer grants are both enabled.
Both packaging commands exit 0; delivery hashes and sizes supersede previous
0.5.0 artifacts below. `SHA256SUMS.txt` and the delivery guide are refreshed.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Core Setup | 1,614,168,207 | `E66E97E8733689FED79FE237C09F077CDB74BCAB64E932178B0FFC97811DFC31` |
| Client Portable | 169,291,309 | `BF9E3DEC936AF33FACD165658C32FD7ECB85D8E0659ECFEEEA996D44957DF06B` |

## 0.5 Core and thin-client qualification

`electron-builder.personal.yml` builds the primary Core installer.
`electron-builder.client.yml` builds a separate portable client, without Pi
workers, Core schema, Hindsight, Python or memory models. Client profiles only
hold Windows-encrypted login/device grants and the DCP execution journal.

```powershell
node scripts/build-personal.mjs --release
node scripts/package-personal.mjs
node scripts/package-personal.mjs --client
$env:NEX_TEST_BUNDLE = "$PWD/release/personal-os/win-unpacked/resources/core/index.js"
$env:NEX_TEST_CLIENT_BUNDLE = "$PWD/release/personal-client/win-unpacked/resources/client-node/client-node.js"
$env:NEX_TEST_LEGACY_BUNDLE = "$PWD/release/personal-os/legacy-0.3.3-fixture/core/index.js"
$env:NEX_TEST_LEGACY_04_BUNDLE = "$PWD/release/personal-os/legacy-0.4.0-fixture/core/index.js"
node node_modules/vitest/vitest.mjs run server/personal-os/app.test.ts server/personal-os/memory.test.ts server/runtime/pi/p0/recovery-store.test.ts server/runtime/pi/p0/p0.test.ts server/runtime/pi/p0/guards.test.ts
node scripts/smoke-personal-clients.mjs --exe=release/personal-client/NexBot-0.5.0-x64-Client-Portable.exe --core=release/personal-os/win-unpacked/resources/core/index.js --ui=release/personal-os/win-unpacked/resources/ui
node scripts/smoke-personal.mjs --exe=release/personal-os/win-unpacked/NexBot.exe
node scripts/smoke-personal-memory.mjs --exe=release/personal-os/win-unpacked/NexBot.exe
```

The new fixtures cover generic chat scheduling, persistent call receipts,
source-aware cancellation/redaction of task-derived routine plans, old Core
migrations without default Agent seeding, per-client login/revocation/restart,
separate client/device credentials, body-free event cursors, 450-message gaps,
privacy generations, actual deciding-session attribution and the standalone
thin Device Node reading its own directory and awaiting terminal approval.

The two-client smoke launches the real client executable twice with separate
disposable profiles. Both log into one isolated Core through the real login
form, share SDK replies, chat-created proactive work, approvals and forgetting.
It also checks offline private-cache clearing, history pagination, independent
revocation and client exit preserving Core. Browser/native desktop permissions
are not exercised against the user's applications or filesystem. Physical
two-machine networking and external identity providers remain separate
deployment acceptance; the implemented login adapter is local-owner mode.

HTTPS reverse-proxy deployments use `--public-origin=https://core.example`
alongside the listening interface/port. This pins allowed Host and browser
Origin to an explicit public address; arbitrary DNS Host headers are rejected.

### Installed 0.5.0 qualification (2026-10-11)

The final Core/Node/Pi workflow suite passes 63 tests, including both transport
tests. The transport tests also pass after the final session-cookie correction:
client cookie lifetime follows the persisted session expiry, and the primary
desktop credential does not inherit a remote client's thirty-day limit.

The final installer exits 0. Installed Core, worker, SQL schemas, UI assets and
app.asar match all 17 qualified program-resource files. The desktop shortcut
targets the installed 0.5.0 EXE with no arguments. Read-only comparisons confirm
the live Core tables and encrypted vault are unchanged; a full profile comparison
also matches all 1,275 backed-up files. Verification never opens the live profile.

The installed runtime passes all 45,161 file hashes and 213 dependency pins.
Python is 3.12.10, Hindsight is 0.10.3, and the pinned Chinese retrieval gate is
Recall@10 = 0.96. The installed EXE passes genuine native extraction, observation
provenance, private-bank isolation, GUI synthesis/source expansion/forgetting,
normal Core exit and owned PostgreSQL shutdown against a disposable profile.
An initial memory smoke run alongside the full resource inventory exceeds its
180-second startup bound. A separate rerun passes with the same bound and no
runtime or test changes. The retained failed fixture is outside release resources.

Initial 0.5.0 artifact sizes and SHA-256 (both superseded below):

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.5.0-x64-Setup.exe | 1,604,555,098 | `27B5ACDCC19CA3BE6729D00ACF348890CFB59AA55C8908FC7AC83628A4B213F7` |
| NexBot-0.5.0-x64-Client-Portable.exe | 160,371,832 | `97435D35F7CD0A447E68E47421C352DBA580EAB02D5E3AC66CC975EDEEC061F0` |

Artifacts and SHA256SUMS.txt are delivered in the owner's local Downloads /
NexBot-Releases / 0.5.0 directory. The thin client was qualified as two real
portable EXE instances using separate disposable profiles and one Core; physical
two-machine networking has not been exercised. No release contains user history,
vault contents or API keys.

### Processing indicator follow-up (2026-10-11)

The Agent feed now shows three staggered bouncing dots immediately on submit,
before the input acknowledgement and while queued/running with no reply text.
Reply text replaces the placeholder; rejected inputs and cancelled work clear
it. Another contact does not inherit the indicator. Reduced-motion preferences
keep the three dots visible without animation. The indicator is transient UI
state and is never written into messages or memory.

The real desktop fixture passes both qualified unpacked and installed EXEs.
It gates the input request and model reply separately, switches contacts while
waiting, exercises a real rejected input and cancelled Task, and checks reduced
motion. It also retains all existing chat/A2A/background-work/shutdown checks.
The cancellation fixture selects the public Task status rather than an omitted
`ended_at` column, and waits for contacts to render after saving configuration.
The screenshot is `release/personal-os/desktop-processing-smoke.png` (ignored).

Only built UI resources are replaced in the installed application, after a
graceful exit and with the prior UI backed up outside the checkout. Installed UI
hashes match the fixture build; Core/worker/memory runtime bytes are unchanged.
The ordinary user application is reopened after isolated verification. The
refreshed installer is built from that qualified prepackaged directory; the
original NSIS installation was qualified above, and the UI update avoids
reinstalling the unchanged native runtime.

The processing-indicator Setup was 1,604,688,823 bytes, SHA-256
`BF14497FD8EB6EAA874B27727258624959FA8E829A1384BC3FF539819875FF63`.
It replaces the same delivery filename; SHA256SUMS.txt is updated. The thin
client executable was unchanged for that UI update because it loads the UI from Core.

### Device awareness, Windows computer use and built-in skills (2026-10-11)

The primary Core now registers its own stable device identity automatically.
Initial registration grants only system metadata; filesystem, terminal and
screen permissions stay disabled. Agents receive a current device directory
with separate online, supported and granted fields, and can retrieve actual OS
information through DCP. Older file-only Nodes are not advertised as supporting
system information. Existing external Node configuration is preserved.

Five first-party generic skills ship with Core: devices, computer, memory,
collaboration and routines. The broker reads fixed allowlisted files, filters
the catalog by the Agent's policy and grants no authority through skill text.
Unedited known default policies migrate; user-edited restrictions remain intact.
No Agent is created or given special logic according to its name.

Windows Core and client packages include the pinned CUA Driver SDK 0.28.2 and
native libraries. Screen access requires a local grant; each native input action
requires approval in the executing Agent's contact. Exact window observations
expire after two minutes and are consumed by input, including interrupted or
unknown completion. Background refusal permits a separately approved foreground
attempt only after a fresh observation. Unknown input is durably reconciled,
not replayed. Screenshots reach Pi as image content rather than base64 JSON text.

The packaged Core/Node/Pi suite passes 70 tests, none skipped, including native
boundary checks, legacy migrations and unknown-call recovery across seven
workflow suites. A real native fixture discovers its own Electron window,
captures a window image through DCP/Pi to a synthetic vision API, and verifies
Unicode input only after approval. Its seven cases also check foreground escalation
and durable receipts. Native interaction never targets the user's applications.

Native qualification runs in the pinned Electron executable's Node mode, matching
the shipped Core's Windows manifest. A standalone node.exe fixture virtualizes
coordinates at 150% scaling and produces a clipped 640x400 capture. The product
host captures the full 940x589 surface of the 942x591 DWM window, including its
input field; the remaining two pixels are the window border. The fixture now
checks actual PNG dimensions against bounded physical window dimensions. The
target retains its BrowserWindow explicitly to prevent garbage collection from
closing it between observations. Process DPI contexts are described by
[Microsoft's Windows documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext).

The real unpacked and installed desktop fixtures pass 28 cases, including primary
device registration, metadata-only grants, optional directory selection and the
screen toggle, plus prior animated-dots/A2A/memory/routine/shutdown checks. The
refreshed portable client EXE passes the 15-case two-instance synchronization
fixture with independent profiles and an isolated Core. Physical two-machine
networking and macOS/Linux native computer control are not qualified here.
Two portable bootstrap attempts time out at the unchanged 180-second bound
during overlapping desktop work. The unpacked client and a separate portable
rerun both pass; startup failure reports now include fixture bootstrap, DevTools
readiness and child diagnostics. This record does not infer a specific cause
from a timeout or silently increase the portable acceptance bound.

Reproduce the additional gates after the normal build and setting the bundle
environment variables above:

```powershell
node node_modules/vitest/vitest.mjs run server/personal-os/computer.test.ts server/personal-os/app.test.ts server/personal-os/client-transport.test.ts server/personal-os/memory.test.ts server/runtime/pi/p0/recovery-store.test.ts server/runtime/pi/p0/p0.test.ts server/runtime/pi/p0/guards.test.ts
node scripts/smoke-personal-computer.mjs --resources=release/personal-os/win-unpacked/resources
node scripts/smoke-personal.mjs --exe=release/personal-os/win-unpacked/NexBot.exe
```

Before the program update, all 1,283 profile files are backed up and hash-checked
outside the checkout. The installed application receives the qualified Core,
UI and computer runtime, with 29 program resource hashes compared. The native
memory runtime is unchanged from its earlier complete resource qualification.
Installed desktop and native computer fixtures use disposable profiles. Normal
user startup occurs separately after verification; its normal schema migration
and device registration are expected to update the live profile.

Both EXEs are refreshed from the qualified prepackaged directories. The installer
is rebuilt; this program-resource update does not repeat the original complete
NSIS installation. Delivery instructions and SHA256SUMS.txt are updated alongside
the artifacts. Previous artifact sizes and SHA-256 (superseded below):

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.5.0-x64-Setup.exe | 1,614,035,719 | `1249CE70C5E02FF8678A14ED76B77FB65442E8D1673C185A4B415C58DCBF41FF` |
| NexBot-0.5.0-x64-Client-Portable.exe | 169,291,325 | `6161AD1CE5F620A283B9D64DBDD5063200B02AD2AB04647DC8AE21B68568DFAB` |

### Default local capabilities and effect-specific approval (2026-10-11)

Terminal and installed Windows computer use are available at startup on the
primary device and after device pairing on a thin client. The two enablement
checkboxes and native enablement dialogs are removed. The remaining save button
only saves a shared folder / client connection; an empty folder never prevents
terminal or computer use. With no shared folder, terminal cwd is the user home.
No default Agents or name-dependent behavior are introduced.

Ordinary window observations and inputs run automatically. Dangerous GUI effects
must carry `risk="dangerous"` and `riskReason`, and approval remains in the executing
Agent's contact. Static known read-only shell commands run automatically; shell
composition, scripts and unknown effects await confirmation. A `standard` marker
cannot override shell classification. GUI classification relies on the Agent's
understanding of the task and observed UI, not a complete security sandbox.
Window targeting, fresh observations, self-approval prevention, durable DCP
receipts and uncertain-effect reconciliation remain enforced.

Migration 8 adds terminal capability to untouched prior defaults, preserving
user-edited policies and the migration 7 checksum. A legacy pending static
terminal query resumes using the same call ID once; an unclassified legacy GUI
input remains pending. Rejected, cancelled and possibly executed calls are not
replayed by this default change.

Final qualified results:

- 77 tests pass, zero failures / pending, against the shipped Core and client
  bundles plus real 0.3.3 / 0.4 migration fixtures. The result is
  `default-capabilities-result.json` in the ignored release directory.
- Installed desktop fixture: all 28 assertions pass, including actual defaults,
  absence of enablement controls and normal shutdown, using a disposable profile.
- Installed native computer fixture: eight assertions pass, including full
  high-DPI screenshot, actual ordinary Unicode input with zero approvals, and an
  explicit dangerous input withheld until approval in the executing Agent feed.
- Refreshed portable client: all 15 two-client synchronization assertions pass.
- Frontend/server TypeScript, changed-code lint and whitespace checks pass.

During regression, two different tests initially fail with a synthetic model
`Connection error`; individual reruns pass. This Windows host's dynamic TCP
range is 1024–15000, including fetch-blocked ports. A controlled own-server probe
on port 6000 reproduces `fetch failed / bad port` with zero HTTP requests. The
fixture now probes its own unaccounted health route before returning and
reselects only a fetch-blocked ephemeral port. Health uses the host fixture
fetch, outside model accounting gates; it consumes no model script and adds no
model retry. The dedicated regression and full P0 accounting tests pass. The
original failure ports were not captured, so this identifies and fixes a
reproduced failure mode rather than proving their exact assigned ports.

Before updating installed program resources, 1,288 profile files are backed up
and hash-verified outside the checkout. All 21 updated Core/UI resource files
match the qualified build. Hindsight native resources and the main Electron
program are unchanged from prior qualification. Normal user startup after
isolated verification reaches schema version 8 with both terminal/computer
capabilities active; read-only quick_check is `ok`, foreign-key violations zero.
The existing shortcut still targets the installed EXE without fixture arguments.

Both EXEs are rebuilt from qualified prepackaged payloads. The installed program
resource update is verified separately; the original full NSIS installation is
not repeated. Latest delivery files and checksums:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.5.0-x64-Setup.exe | 1,614,166,693 | `02D4F0FC650721FEEF16A4B96002C4DED526C29A2CCA7786BF77F3D5D68796CA` |
| NexBot-0.5.0-x64-Client-Portable.exe | 169,291,003 | `575E3D653A812BCB1379DEDF98E9C3C4D826AA9B62C0AF40A49699E5B607AAE7` |

Historical 0.4 evidence below describes the older full-Core portable package,
which is not the new thin-client portable distribution.

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

## 0.4.0 production memory, 2026-10-11

This release bundles Python 3.12.10, real Hindsight 0.10.3, native pg0 /
PostgreSQL, and pinned multilingual CPU embedding and cross-encoder models.
All fixtures use disposable profiles and loopback synthetic providers.
No test calls the user's configured model or mutates their installed profile.

Reproduce the build-time resources and gates on Windows x64:

```powershell
uv run --python 3.12 --no-project --isolated --with-requirements scripts/memory-runtime-requirements.txt python scripts/prepare-memory-runtime.py
dist-personal/memory-runtime/python/python.exe -I scripts/verify-memory-chinese.py
node scripts/build-personal.mjs --release
$env:NEX_TEST_BUNDLE="$PWD/dist-personal/core/index.js"
$env:NEX_TEST_LEGACY_BUNDLE="$PWD/release/personal-os/legacy-0.3.3-fixture/core/index.js"
node node_modules/vitest/vitest.mjs run server/personal-os/app.test.ts server/personal-os/memory.test.ts server/runtime/pi/p0/p0.test.ts server/runtime/pi/p0/guards.test.ts server/runtime/pi/p0/recovery-store.test.ts
$env:NEX_HINDSIGHT_NATIVE='1'
$env:NEX_HINDSIGHT_PRODUCTION='1'
node node_modules/vitest/vitest.mjs run server/personal-os/memory-native.test.ts
$env:ELECTRON_BUILDER_COMPRESSION_LEVEL='1'
node scripts/package-personal.mjs
node scripts/verify-personal-resources.mjs --resources=release/personal-os/win-unpacked/resources/memory-runtime --compare
node scripts/smoke-personal.mjs --exe=release/personal-os/NexBot-0.4.0-x64-Portable.exe
node scripts/smoke-personal-memory.mjs --exe=release/personal-os/NexBot-0.4.0-x64-Portable.exe
```

The optional legacy bundle is copied from a genuine 0.3.3 package before
replacing `win-unpacked`; it is not generated by the new migration code.
Without that fixture, Vitest explicitly skips the historical-version test.
If only the renderer changes, rebuild `dist-personal/ui`, copy it into the
verified unpacked resources, and package with `--prepackaged`; confirm that
the Core and worker hashes still match the tested bundles.

Passed before installer qualification: 55 Core/memory/Pi tests, frontend and
server TypeScript, changed-code lint and 65 existing schema contract checks.
The memory suite covers complete provenance for observations, incomplete
provenance rejection, entire two-bank read snapshot invalidation, explicit
shared copies, causal A2A copies, Pi context cleanup, late-result rejection,
identical-text tombstones and replay after restoring an older Core DB while
preserving the encrypted privacy journal.

The genuine native production fixture passes retain HTTP attribution,
authentication, positive retrieval, private-bank isolation, real reflect
tool calls and citations, actual bank retirement, 410 rejection of late
writes and automatic recovery after killing the owned Python service.
Retirement remains enforced after that restart. It uses the bundled CPU
models, not synthetic embeddings or a developer UV overlay.

The labelled Chinese gate contains 100 separate source documents and 100
questions, and passes Recall@10 = 0.96 versus exact-question LIKE = 0.00.
It exercises real native hybrid recall with the shipped models, using
verbatim ingestion. This is a synthetic retrieval qualification, not a
claim about arbitrary real-world questions or paid-provider extraction.

The production EXE memory smoke uses neither `--memory-fixture-disabled` nor
fixture ML. It configures a loopback model, runs default native extraction,
checks private isolation, clicks the actual workbench's synthesis and source
controls, previews and confirms forgetting, waits for retirement / rebuild,
and verifies no recalled forgotten data. The regular desktop smoke separately
checks empty initialization, generic contacts, optional identity, silent
directory refresh, automatic A2A, compact markers, folded peer replies,
background work, tray restore and graceful Quit.

A diagnostic desktop run during packaging timed out at the original 10-second
CDP bound. The fixture now uses a 30-second command bound and reports the
expression that timed out. The packaged desktop workflow passes this bound.
A legacy temporary fixture was retained when automatic review denied cleanup;
it is not included in release resources or the user's application profile.

Forget is logical deletion of registered originals / causal copies and native
derived banks. It does not wipe SSDs, user files, remote model logs or unknown
external backups. A whole old-profile restore that overwrites the privacy
journal cannot preserve later tombstones. Topic matching is an explicit raw
substring preview; untracked paraphrases require an additional selection.
Long-lived editable knowledge pages are outside this release.

### Final packaging qualification

The initial 7z portable launcher fails cold-start qualification: two attempts
exceed five minutes and a single-launch retry exceeds fifteen minutes while
still copying resources, before an Electron renderer or fixture profile is
created. No blocking window is observed. Inspection of the pinned builder's
`extractUsing7za` template shows extraction into a staging directory followed
by `CopyFiles` of the entire runtime. The revised installer uses ZIP direct
extraction (`useZip: true`, `differentialPackage: false`); portable uses the
builder's direct per-file zlib expansion while retaining per-launch directories.
The first revised installer exits 0 after 185.73 seconds. The stalled initial
installer is stopped by its verified PID/path/start time before that upgrade.

Direct portable compilation exceeds builder-util's fixed four-minute timeout.
`package-personal.mjs` applies a process-local fifteen-minute bound exclusively
to the pinned builder's makensis invocation; its templates, compiler-output
validation and artifact-size checks remain intact. It uses an explicit personal
config file, preventing inheritance of the legacy desktop's publish/protocol
settings. The normal package command runs the production resource gate first.

An installed desktop run reaches all functional assertions but exceeds the
original forty-second exit bound. Unconsumed Core/worker diagnostic pipes are
removed: structured results and errors use IPC. The fixture now independently
requires a normal Core exit, and fails if the desktop's 45-second force-exit
fallback runs; merely extending its wait cannot turn that fallback into a pass.
The revised unpacked desktop passes this stronger shutdown check. Final packaged
and installed results are recorded below after qualification.

Final installer SHA-256:
`DFF565F7A2521FEB7222A84801B03E54FEBBA01608C485A967F7EBE76D730901`.
The unpacked and tested Core / worker hashes are respectively
`7638D98EAF4874B7EBC4F4E68B12E029127F206C54249A05F698E5E12294B11D`
and `AE49C9D28A359FCEF0F87725F70743ACD536F4182BAD1DE4875826240DC17C93`.

The final direct-expansion installer exits 0 after 606.9 seconds while the
portable build / extraction is also active. The installed 0.4.0 desktop
passes the regular renderer smoke and the production native-memory smoke,
including GUI synthesis / source expansion / confirmed forgetting, normal
Core shutdown and removal of the owned PostgreSQL `postmaster.pid`. These
tests use disposable profiles and a synthetic loopback model transport.

The installed runtime independently passes all 45,161 resource hashes and
213 exact dependency pins. Installed Core, worker and app.asar bytes match
the qualified unpacked build. Read-only comparison against the pre-upgrade
backup confirms every live Core table and the encrypted vault are unchanged;
integrity is `ok` and foreign-key violations are zero. The desktop shortcut
targets the installed 0.4.0 EXE with no fixture flags.

The final portable distribution also passes the regular renderer smoke,
including a second launch restoring the existing hidden window, automatic
A2A and normal Core shutdown. Each launcher expands its own temporary
runtime, so portable start / restore / cleanup take longer than the installed
application. Daily use is recommended through the installed shortcut.

Final portable SHA-256:
`D35C76D6907A822EBDF896AD23F8C21CF9D6F9FABCBF267CA05376A603D56EBF`.
The final Setup / Portable sizes are 1,583,015,755 / 1,536,272,871 bytes.

The portable production-memory smoke also exits 0 with all native extraction,
observation provenance, private isolation, GUI synthesis / source expansion,
confirmed forgetting and normal Core / owned PostgreSQL shutdown assertions
passing. The launcher finishes removing its temporary runtime. Separate native
memory reports are `installed-memory-result.json` and
`portable-memory-result.json` in the ignored release directory. Neither smoke
uses the user's live data or a paid model provider.
