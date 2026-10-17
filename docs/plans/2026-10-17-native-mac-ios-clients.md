# Native macOS and iOS clients

Status: design, 2026-10-17. Supersedes nothing yet: the Electron thin shell
(`electron/nex-client-main.mjs`) stays the shipped desktop client until the
native Mac app reaches parity for the v1 scope below.

## Decision

Build both clients as **fully native SwiftUI apps** that talk to Core's
existing HTTP + SSE API (client protocol v1). They do not embed the Core web UI
in a WebView. Core stays the single source of truth for agents, messages,
tasks, approvals, memory and models. Clients keep no database. The only things
they persist are an encrypted login record and UI preferences.

No Core server changes are required for v1. Anything a native client needs and
the API cannot provide is listed under "Later".

## Repository layout

```
apps/apple/
  project.yml                 XcodeGen spec (NexBotMac + NexBotiOS app targets)
  README.md                   build, run, fixture, signing notes
  scripts/generate.sh         xcodegen generate (the .xcodeproj is gitignored)
  Packages/NexClientKit/      SwiftPM package, platforms: macOS 14, iOS 17
    Sources/NexClientKit/
      Protocol/               Codable DTOs for Core v1 responses
      Networking/             CoreClient (URLSession), EventStream (SSE)
      Auth/                   LoginService, CredentialStore (Keychain)
      Sync/                   WorkspaceStore, ConversationStore (@Observable)
      Support/                CoreOrigin validation, errors, Markdown helper
    Tests/NexClientKitTests/  URLProtocol-mocked unit tests
  NexBotMac/                  macOS app target (SwiftUI, AppKit only where needed)
  NexBotiOS/                  iOS app target (SwiftUI)
scripts/fixture-native-client.mjs   isolated Core + fake identity/model for manual runs
docs/verification/native-clients.md recipe and evidence
```

`apps/apple` is not a pnpm workspace package. Bundle IDs are `com.nexbot.mac` and
`com.nexbot.ios`. Deployment targets are macOS 14 and iOS 17, so the apps can
use the Observation framework (`@Observable`) and `NavigationSplitView`.

## Core protocol used (v1)

Every request uses `Authorization: Bearer <token>`. The `URLSession` uses
`.ephemeral` with cookies disabled (`httpShouldSetCookies = false`,
`httpCookieAcceptPolicy = .never`), so tokens never reach a cookie jar on
disk. Redirects are refused, as in Electron (`redirect: "error"`). Native
requests send no `Origin` header, so Core's origin check passes, and the `Host`
header equals the origin authority.

| Flow | Calls |
| --- | --- |
| Discover | `GET /api/client/identity` → require `version == 1`, `coreId`, `loginRequired == true`, `loginMethods ∋ "password"`, `initialized == true` |
| Login | `POST /api/auth/start {account, name}` → `{transactionId, bindingToken, stepId, challenge, expiresAt}`; `POST /api/auth/respond {…transaction, password}` → `{token, coreId, sessionId, expiresAt, …}`; reject if `coreId` changed during login |
| Resume | `POST /api/session {token}` → `{authenticated, coreId, sessionId, expiresAt}`; if origin was re-pointed or is plain HTTP, verify `/api/client/identity` coreId first (same rule as Electron) |
| Logout | `POST /api/auth/logout {}` (best effort), then delete the credential |
| Snapshot | `GET /api/state` → `bots, approvals, tasks, routines, devices, sync{cursor,privacyEpoch,coreId,bootId}, …` |
| Feed | `GET /api/agents/messages?bot=ID` (latest 100), `&before=SEQ` (older 100), `&after=SEQ` (next 200, `hasMore`); each response carries `sync` and `streaming[{taskId,text}]` |
| Events | `GET /api/events` SSE with `Last-Event-ID`; `event: change` data `{cursor,privacyEpoch,coreId,bootId,reset}`; `event: revoked` |
| Act | `POST /api/agents/input {botId,text,clientId}` (UUID idempotency key, 202); `POST /api/agents/read {botId,seq}`; `POST /api/cancel {taskId}`; `POST /api/approvals {id,hash,allow}`; `GET /api/clients`, `POST /api/clients/revoke {sessionId}` |

Field shapes are defined by `server/personal-os/index.ts`, `agents.ts`,
`identity.ts`, `sync.ts` and their mirror in `src/personal/api.ts`. DTOs decode
leniently: unknown fields are ignored, and rows that are open records in TS
keep a `[String: JSONValue]` escape hatch.

**Origin rule** (port of `coreOrigin` in the Electron shell): the address is a
root URL with no user info, query, fragment or path. It must be `https:`, or
`http:` only for localhost, `[::1]`, 127/8, 10/8, 172.16/12 or 192.168/16.
Account login over plain HTTP is allowed only for those private hosts. The
default origin is `https://bot.nexorai.com.cn`. ATS uses
`NSAllowsLocalNetworking` only. No arbitrary-load exception.

## Sync model

The native port follows `reload()` in `src/personal/AgentDesktop.tsx`:

1. `WorkspaceStore` owns the latest `/api/state` snapshot and the `sync`
   identity. `ConversationStore` (one per open bot) owns the loaded message
   window, streaming text, the oldest loaded seq and the draft.
2. An SSE `change` event schedules a refresh, debounced to 150 ms. A refresh
   fetches `/api/state` together with `agents/messages?after=<lastSeq>` for
   the open bot, then keeps draining `after` pages while `hasMore` is true.
   Never assume one page covers a reconnect gap.
3. If `reset == true`, or `privacyEpoch`, `bootId` or `coreId` differs from
   the cached value, drop every cached message, streaming text and draft
   preview, then reload from scratch. Responses from different generations
   are never merged. A stale in-flight response, identified by a request
   serial number, is discarded.
4. A 401, a `code == "identity_unavailable"` or an SSE `revoked` event ends
   the session: clear cached private content, delete the stored credential
   (for 401/403/409) and return to the login screen with a message.
5. Losing the connection clears displayed private content and shows "正在重新同步…".
   The SSE reconnects with exponential backoff (0.5 s → 15 s) and sends
   `Last-Event-ID`. A 10 s fallback refresh timer runs while connected.
6. Read position: after the visible feed reaches seq N while the window is
   key (macOS) or the scene is active (iOS), POST `agents/read` once per new N.
7. iOS only streams in the foreground. On `scenePhase != .active` the store
   closes the SSE, and on return it does a full refresh.

Sending: generate a UUID `clientId`, then POST input. On a network error the
same text can be retried with the **same** `clientId`, so a retry is never a
duplicate. Stop calls `/api/cancel` for the bot's unfinished task. Approvals
send the committed `hash` from the approval row. Only the first decision wins,
and the UI shows Core's error text otherwise.

## Credential storage

`CredentialStore` saves one JSON record
`{origin, name, token, coreId, sessionId, expiresAt}` as a Keychain generic
password. The service is `com.nexbot.client`, the account is `default` or the
profile name, and access is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
On macOS the record goes in the login keychain and needs no entitlement, so
unsigned dev builds work. A `NEXBOT_PROFILE` environment variable or a
`--profile=NAME` launch argument selects an isolated record. Fixtures use this,
like `--profile` in Electron. `NEXBOT_CORE_ORIGIN` / `--origin=` pre-fills and
re-points the origin. The password is never stored, and the field is cleared
after every attempt.

## v1 product scope

Both apps implement the same flows with platform idioms.

- **Login**: origin (under "高级"), device name, email, password. Resume
  happens on launch with a cancellable "正在恢复登录" state and a "改用其他账号登录"
  option. Errors use Core's message text.
- **Contacts**: bot list with avatar initials, name, last message preview,
  unread badge (`unread`/`read_seq` fields of the bot row) and a task status
  phrase (`taskPhrase` equivalent: 排队中/执行中/等你批准/…).
- **Conversation**: paged history (load older on scroll to top), Markdown
  rendering via `AttributedString(markdown:)` with links opened in the system
  browser (http/https only), tool-step rows collapsed to a label from the
  `toolLabels` table, live streaming text, a composer (Return sends on macOS,
  ⇧Return inserts a newline; a send button on iOS), Stop while a task is
  unfinished, and inline approval cards (approve/deny).
- **Approvals inbox**: all pending approvals across agents, with the same
  decision actions.
- **Settings**: account name and Core origin, signed-in sessions with revoke
  (`/api/clients`), disconnect/logout, and the app version.
- **macOS specifics**: a three-column `NavigationSplitView` (contacts / chat /
  inspector with the approvals and task list), a `Settings` scene,
  ⌘N focuses the composer, ⌘. stops, single window with restoration, and a
  menu bar extra that shows the pending-approval count.
- **iOS specifics**: `NavigationStack` contacts → chat. A tab bar has
  会话 / 审批 / 设置. Swipe actions approve/deny. Pull to refresh. Keyboard
  avoidance. Dynamic Type.

Out of v1 (stays in the web/Electron UI for now): model configuration, agent
creation/policy editing, connectors, memory workbench, routines editing,
device pairing and file preview.

## Later (needs Core work)

- **Closed-app notifications**: Core has no APNs relay today, so iOS alerts
  only arrive while the app is foregrounded. This needs a device-token
  registration API plus an APNs sender on Core.
- **Native agent management screens**: these need stable, typed response
  schemas instead of open `RecordRow`s.
- **Distribution**: Developer ID signing/notarization (Mac), App Store
  Connect/TestFlight (iOS) and a Sparkle-style updater.

## Verification

Follow `docs/verification/README.md`. Never use the live account or Core.

1. `swift test` in `Packages/NexClientKit`: origin rules, DTO decoding of
   recorded Core payloads, login/resume/logout sequences, the SSE parser
   (multi-line data, ids, comments, reconnect with `Last-Event-ID`), the sync
   rules (reset, epoch change, `hasMore` drain, stale serial discard) and
   send retry idempotency. All of these use `URLProtocol` stubs.
2. `scripts/fixture-native-client.mjs` builds nothing itself and requires
   `pnpm build:core`. It starts an isolated Core (temp dir, random key), the
   fake nex_user identity and the fake model, links the synthetic owner, seeds
   two agents and prints origin, account and password. It stays attached and
   cleans its temp dir on Ctrl-C. It can trigger a scripted reply and an
   approval-requiring tool call on demand.
3. `xcodebuild` builds both app targets (macOS, and the iOS Simulator SDK).
   The macOS app is launched with `--profile=fixture-<random> --origin=<fixture>`
   against the fixture: login, resume after relaunch, send/stream/read, stop,
   approve, revoke from a second session, and logout, with screenshots as
   evidence. iOS is launched in a simulator only when an iOS runtime is
   installed; otherwise the record states that iOS was compile-verified only.

## Execution plan

- **Wave 1 (parallel)**: (A) `NexClientKit` with tests, `project.yml` with both
  app targets compiling as stubs, README and the generate script.
  (B) the fixture script and the verification recipe.
- **Wave 2 (parallel, after A)**: (C) the macOS app and (D) the iOS app. Both
  consume only the public API of `NexClientKit`. If either needs a kit change,
  it reports the change instead of editing the shared package, and the
  coordinator applies it.
- **Acceptance**: the coordinator runs `swift test`, both `xcodebuild` builds
  and the fixture-driven macOS walkthrough, reviews the diff, then records the
  results in `docs/verification/native-clients.md`.
