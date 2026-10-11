# Personal AI OS Windows delivery verification

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
