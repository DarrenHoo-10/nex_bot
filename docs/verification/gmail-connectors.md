# Gmail connectors — 2026-10-24

This worktree adds a native Gmail provider to Personal Core's connector registry.
The first version supports `gmail.search`, `gmail.read` and `gmail.thread` through
the existing Agent broker and explicit per-Agent tool grants. Only
`https://www.googleapis.com/auth/gmail.readonly` is requested. Connecting does not
automatically grant any Agent access. No sending, drafts, label changes,
background synchronization or attachment downloads are implemented.

## Configure a real Google application

1. Enable the Gmail API in the operator's Google Cloud project and configure its
   OAuth consent screen. Use a **Web application** OAuth client because Core
   exchanges codes and stores refresh tokens on the backend.
2. Register the exact redirect URI
   `https://YOUR-CORE-HOST/api/connectors/oauth/google/callback`.
   Local development permits an explicit loopback HTTP URI with a fixed port.
3. Supply these environment variables privately to the Core service process:

   | Variable | Value |
   | --- | --- |
   | `NEX_GOOGLE_CLIENT_ID` | Google OAuth client ID |
   | `NEX_GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
   | `NEX_GOOGLE_REDIRECT_URI` | The exact registered URI above |

4. Restart the service from an approved release. The callback origin must match
   the Core address used by clients. Keep credentials in the service account's
   environment or private secret manager, outside the checkout and archives.
   Configure reverse-proxy access logs to omit query strings on this callback;
   authorization codes and state must not enter logs.
5. Open **设置 → 连接器 → 连接 Gmail**, complete consent in Google, return to NexBot,
   and select the allowed tools under **Agent 授权**. To add another mailbox, use
   **添加邮箱**. **重新授权** must select the existing mailbox.

All three variables are required together. An unconfigured service reports the
provider unavailable and disables Connect; it never displays a fake connection.
`fixtureOrigin` is a code-only option for disposable loopback tests and is not
configurable through the production environment or HTTP API.

Google classifies `gmail.readonly` as restricted. Production use must satisfy
Google's applicable OAuth verification and security assessment requirements.
An external consent screen in Testing normally yields refresh tokens lasting
seven days for Gmail scopes. These provider conditions are not certified by the
synthetic tests. See [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
and [refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Architecture and lifecycle

- `shared/personal-connectors.ts`: shared provider, tool, connection and OAuth
  status contracts. Existing HTTP/SSE MCP connections remain supported.
- `gmail-provider.ts`: fixed Google endpoints, web OAuth + PKCE, bounded REST
  reads, MIME body selection and attachment metadata. No arbitrary HTTP tool.
- `connector-oauth.ts`: ten-minute state, initiating session binding, account
  linking, encrypted tokens, serialized refresh and cancellation.
- `connectors.ts`: one registry, one Agent grant model and one broker path for
  both native providers and MCP. Schema migration 22 adds provider/account fields
  without rewriting existing credentials or grants.
- `GmailConnect.tsx`: native external-browser handoff, reserved browser popup,
  blocked-popup fallback, cancellation and authenticated completion polling.

Callback routing uses the pending, unguessable state to choose a workspace;
cookies from another account cannot redirect the connection. State is single use,
and the initiating session is rechecked before and after network requests.
Pending authorization is intentionally memory-only: after a Core restart, retry
Connect. Existing linked mailboxes and grants persist encrypted at rest.

Credentials never appear in the public connector snapshot, model tool directory,
audit details or error responses. Revoked refresh tokens clear local credentials
and show **需要重新授权**. Disconnect clears local credentials and grants before
attempting Google's revocation. A failed revocation produces a visible warning
without restoring local access. Google revokes the account's project-wide grant,
which can also affect other connections using that same Google account/project.
See [Google token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

Search returns up to 20 summaries plus the next-page token. A message body is
limited to 24,000 characters; a thread returns up to 20 messages and a bounded
payload with explicit truncation. Responses are limited to 2 MB each. Plain text
is preferred; HTML-only messages remain inert tool-result strings. Email text is
untrusted source content. Reads and summaries enter the existing conversation
history and normal memory pipeline; this is not a separate mail archive.

## Reproduce

```sh
node node_modules/vitest/vitest.mjs run server/personal-os/gmail-connectors.test.ts server/personal-os/connectors.test.ts server/personal-os/workspaces.test.ts server/personal-os/service.test.ts
pnpm typecheck
node scripts/build-personal.mjs --core
node scripts/smoke-gmail-connectors.mjs
node scripts/smoke-personal-workspace.mjs
```

Every fixture owns a temporary database, a synthetic Google service and synthetic
NexorAI/model services where needed. The renderer smoke launches hidden Electron
with its own profile. It never opens the installed app or uses a real mailbox.
Evidence is ignored under `release/gmail-verification/`, including `result.json`,
catalog/consent/grant/connected/chat screenshots and mobile/dark-mode captures.
Owned children are stopped and temporary profiles removed during cleanup.

The backend tests cover PKCE, callback replay and expiry, denied/partial consent,
encrypted persistence, account/workspace isolation, duplicate/mismatched mailbox
rejection, per-Agent grants, real worker reads without approval, single refresh,
revoked credentials, cancellation during exchange/read/refresh, disconnect,
redaction, malformed responses, redirect rejection, bounded email results and
upgrade from schema 21. UI checks cover blocked popups, cancellation, denial and
retry, actual broker reads, grants, enable/disable, reauthorization and disconnect.

## Verified results — 2026-10-24

- Backend regression: 35 tests passed across the Gmail, MCP, workspace and service
  suites.
- Gmail renderer: all nine scenario groups passed; evidence is in
  `release/gmail-verification/result.json` and the adjacent screenshots.
- Full workspace renderer: all 36 scenarios passed, including existing MCP
  approval/execution, attachments, model settings, themes and mobile layouts.
  Evidence is in `release/workspace-verification-avatars/result.json`.
- Client and server TypeScript checks, changed-file lint and `git diff --check`
  passed. The local Core/UI build passed with the existing large-bundle warning.

The workspace smoke selectors were updated to match the existing attachment
container, model picker and login card. No production behavior in those features
was changed. These results use only isolated synthetic accounts and services.

## Reference-based settings redesign

The Gmail catalog now uses a single service row with its brand icon and actual
added state. Selecting it opens an account, tools, application and information
detail page. Multiple mailboxes share the same service detail while preserving
independent credentials and assistant grants. Account actions expand on demand;
the tool disclosure shows the three implemented read-only capabilities.

The nine Gmail renderer groups also verify catalog search, loaded branding,
keyboard focus on return, cancellation when leaving an active authorization,
two-mailbox grouping and targeted disconnect without changing the other mailbox.
Desktop light/dark and 390-pixel mobile captures include a long synthetic email
address. No personal email addresses from the visual references are stored in
source or fixture data.

The Gmail icon is bundled locally from
[Google's product asset](https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png).
The interface does not fetch third-party images at runtime.

## Cross-platform compatibility — 2026-10-24

| Client | Implementation and evidence |
| --- | --- |
| Web | Shared catalog/detail, safe Google URLs, popup fallback, cancellation and foreground refresh. Nine fixture groups passed at desktop and 390-pixel widths. |
| Windows | Real `nex-client-main.mjs`, preload, authenticated login and IPC. Ten groups passed, including failed system-browser handoff, retry, callback, reauthorization and mailbox isolation. Only the final OS browser opener is replaced by a fixture that refuses non-fixture destinations. |
| Android | Same bundled UI, native bearer transport, external browser intent and hierarchical Back. Browser failures now reject to the UI instead of silently succeeding. Six JavaScript bridge tests and 78 Kotlin/Robolectric tests passed; debug APK compiled successfully. |
| macOS | Native Gmail catalog and shared SwiftUI account/tools/grants detail; OAuth coordinator opens the system browser and resumes polling on foreground. Xcode Debug application build passed. |
| iOS/iPadOS | Native catalog/navigation and shared SwiftUI detail, with platform-specific menus/sheet presentation. Xcode Debug simulator build passed for the universal iPhone/iPad target. |

NexClientKit's complete suite passed 122 tests, including 11 new OAuth cases:
legacy MCP decoding, current reconnect versions, strict Google URL validation,
expiry, denial, success, cancellation of late starts/polls, browser retry and
disconnect warnings. Gmail is excluded from native MCP credential editing.
The iOS build also exposed an existing missing `AgentMessage.botID` accessor;
it now reads `bot_id` for the attachment conversation lookup.

Repeat the renderer and Windows checks with:

```sh
node --experimental-transform-types --no-warnings scripts/smoke-gmail-connectors.mjs
node --experimental-transform-types --no-warnings scripts/smoke-gmail-connectors.mjs --shell
```

Apple checks use `swift test` in `apps/apple/Packages/NexClientKit` and XcodeGen's
`NexBotMac` / `NexBotiOS` schemes with isolated DerivedData. The optional
`node scripts/smoke-apple-gmail.mjs` renders the actual shared SwiftUI page against
an in-memory URLProtocol fixture, including two synthetic mailbox addresses.
It never launches the user's installed app or contacts an external service.
Three native macOS renders were inspected: light, dark and 390-point narrow
layout with long mailbox names. They compile the real asset catalog into a
temporary bundle and capture an offscreen NSHostingView. The account menu is
kept at its intrinsic width so it does not squeeze the address. These captures
verify the shared page's layout; they are not iOS simulator interaction tests.

Android checks use `:core:test :app:testDebugUnitTest :app:assembleDebug`.
For this run, the shared Android assets were built on Windows and copied to an
isolated macOS source directory; Gradle skipped only `:app:buildWorkspaceUi`
and compiled/tested the actual Kotlin sources. Windows Java could not create its
Gradle loopback connection, and the existing macOS dependency checkout lacked
`rehype-raw`. No shared dependency checkout was modified. The later Windows full
TypeScript/Core rebuild was also blocked by missing shared `zod` / Anthropic SDK
dependencies; the changed shared renderer built successfully and both renderer
smokes ran against the already verified, unchanged Core bundle. Earlier full
TypeScript/backend build results above predate that dependency breakage.

Evidence is ignored under `release/gmail-cross-platform/`: Windows result JSON,
Apple build/test logs, Android build log and native rendering output. The Windows
shell run remains hidden and does not capture screenshots; visual evidence comes
from the isolated renderer and native render fixture.

No production deployment, published installer, physical-device browser handoff,
live Google consent verification or real-account acceptance is claimed here.
Google OAuth configuration and the matching Core update are required before
connecting a real mailbox. Older Core instances show Gmail as unavailable.
