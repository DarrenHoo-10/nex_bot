# Android

## 0.2.1 — blank screen and collapsed dialogs

The Android WebView resolves every vertical viewport unit (`vh`, `dvh`, `svh`,
`lvh`) to 0 px, so the workspace, sized with `100dvh`, collapsed: opening an
assistant showed a blank page, and the account menu and the add-assistant dialog
shrank to a sliver. `scripts/build-android-ui.mjs` now rewrites those units to a
`--nex-vh` variable that the Android entry keeps equal to the visual viewport
height (so it also follows the keyboard). Desktop builds are unchanged.

A render error in the shared UI now shows the message, stack head and component
path with retry, reload and copy actions instead of a blank page, and failures
before React mounts are reported the same way.

## 0.2.0 — shared Windows workspace

After native account sign-in, Android loads the same `src/personal` workspace
as Windows from assets bundled inside the APK. Settings, assistant management,
avatars, routines, tool permissions, Markdown, composer menus and model limits
therefore ship from one implementation. The account avatar uses the first
character of the display name in both the sidebar and account settings.

Android provides the document picker, Save As, clipboard, browser links,
notification navigation and Back handling. Tokens remain in the existing
Keystore-backed store; a restricted native transport adds the current bearer
only to the selected Core. The WebView cannot navigate to remote content, load
frames, or read arbitrary filesystem paths. Web preferences are isolated by
account and server. Remote registered computers remain usable from chat;
Android does not include a phone-control/accessibility executor.

Build with Node 24, `pnpm install --frozen-lockfile`, JDK 17 and Android SDK 36:

```sh
cd android
./gradlew --no-daemon :core:test :app:testDebugUnitTest :app:assembleDebug
```

Gradle builds the shared renderer automatically. Output:
`app/build/outputs/apk/debug/nexbot-0.2.1-debug.apk`. This debug-signed APK updates
the previous debug installation without clearing login data. Release signing
still requires a maintainer-provided key outside the repository.

See [workspace parity verification](../docs/verification/android-workspace.md)
for the current checks. The P1 native screen records below describe 0.1.0;
`AgentsScreen` / `ChatScreen` remain test references and are no longer the
production signed-in entry point.

## Historical 0.1.0 implementation

The phone client for NexBot Personal AI OS. It is a thin client of Core: it
carries no Agent, model credential, memory or business database of its own.

Design: [docs/plans/2026-10-17-android-client.md](../docs/plans/2026-10-17-android-client.md).
The visual reference is [doc/ui/](../doc/ui/README.md): the phone uses the
workspace tokens (near-neutral surfaces, blue companion accent), the blue brand
mark, companion avatars from `shared/personal-appearance.ts`, and the chat
layout from the narrow-screen screenshot — assistant text without a bubble,
right-aligned user bubbles, per-message time/quote/copy, the amber approval
card and the two-row composer (`＋`, per-Agent permission mode, send).

## Modules

| Module | What it is | Needs the Android SDK |
|---|---|---|
| `:core` | Wire models, origin rules, SSE parser, HTTP client, copy and sync rules. Pure Kotlin/JVM. | No |
| `:app` | Compose UI, session store (Keystore), notifications, the live repository. | Yes |

## Build and test

Requires JDK 17 or newer. The wrapper pins Gradle 9.5.0 (the same matrix the
deleted Android app used: AGP 9.3.1, Kotlin 2.2.21). `:app` also needs an
Android SDK with `platforms;android-36` and `build-tools;36.1.0`; point
`ANDROID_HOME` at it or write `local.properties` with `sdk.dir=…`.

```sh
cd android
./gradlew :core:test :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

The debug APK is `app/build/outputs/apk/debug/nexbot-0.1.0-debug.apk`
(application id `com.nexorai.nexbot.debug`); the unsigned release build is
`app/build/outputs/apk/release/nexbot-0.1.0-unsigned.apk`. The version comes
from `versionName` in `app/build.gradle.kts`, so the file name moves with the
release. A release build is unsigned until signing material is supplied from
outside version control; see the design §9.2.

## What the app does (P1)

- Connect to one Core with a NexorAI account; the session is sealed with an
  AES-GCM Android Keystore key and restored on the next launch
  (`/api/session`, with the recorded `coreId` checked).
- Agent list with unread counts, working state and a pending-approval badge.
- Chat: paged history, streaming replies, send with a stable idempotency key,
  stop, load older, inline Markdown, tool steps, approvals with the committed
  argument hash.
- One SSE stream feeds a coalesced tail refresh plus a throttled summary
  snapshot; a revoked session clears the saved connection and returns to login.
- Local notifications for approvals and replies while the process is alive.
  Closed-app push needs Core-side registration and is not part of P1.

Not yet: assistant details (`工作` / `设置`: routines, identity edit), model
parameters, memory editing, QR pairing (needs a pairing entrypoint that does not
exist yet), full block Markdown, release signing and store packaging. The old
`资料` drawer was removed from the Windows client, so it is not on the phone
roadmap.

## Fixtures

Fixtures are captured from a real, disposable Core rather than written by hand.
From the repository root, against the TypeScript source (no Core build needed,
which is also what CI runs):

```sh
node --experimental-transform-types --no-warnings scripts/capture-android-fixtures.mjs --core=server/personal-os/index.ts          # rewrite fixtures
node --experimental-transform-types --no-warnings scripts/capture-android-fixtures.mjs --core=server/personal-os/index.ts --check  # exit 1 on drift
```

`pnpm build:core` also works where the Core build is supported (Windows and
macOS): then the default `--core` (`dist-personal/server/core/index.js`) is
enough and the transform flag is unnecessary.

Volatile values (UUIDs, tokens, timestamps, loopback URLs, the sync cursor) are
normalized, and host-only fields (computer capability, its derived tool list)
are projected out, so the same fixture is written from the source and from a
packaged build. `--check` compares structure and copy rather than one run's
clock. Re-run without `--check` and review the diff when Core legitimately
changes a field.

## What the tests prove

`:core` (44 JVM tests):

- origin acceptance rules (`Origin.kt`), including public-HTTP refusal;
- SSE parsing across CRLF/LF/CR, comments, multi-line data, sticky ids and
  malformed payloads;
- decoding of captured identity, login, state (full and summary), messages and
  live-frame documents, with unknown fields tolerated;
- request shapes and error mapping against a MockWebServer, including the
  attachment upload, send-with-attachments, approval-mode and download calls;
- the timing decisions the stream depends on (coalescing, backoff, staleness,
  refresh lead, snapshot invalidation, typing rule) with plain numbers.

`:app` (26 JVM/Robolectric tests):

- login, resume, the stable send key across a failed retry, approval hash,
  revocation and the public-HTTP refusal, against a fake Core;
- the sealed session round-trip and a corrupt record being dropped;
- inline Markdown spans and links, list markers becoming bullets;
- the companion avatar contract (first Agent soft/teal, the 4×5 hash grid) and
  day/time labels;
- the chat screen mounting with a real approval card, the composer's
  permission label and the `＋` menu (文件 / 导出对话);
- a native-graphics render of the login, agent-list and chat screens that
  asserts the pixels are not blank and writes PNGs to `build/screens`.

An emulator end-to-end run (documented in
[docs/verification/android-client.md](../docs/verification/android-client.md))
also logs in against a disposable Core, opens an Agent, sends a message and
receives a scripted reply, and checks that waking the display resyncs after an
update happened while the phone held no stream.

Still unproven: a physical phone (Keystore on hardware, notifications arriving,
IME behaviour), an approval round-trip through a real tool call, release
signing, and R8. Headless-emulator screenshots are black on this GPU, so the
UI-hierarchy dumps are the readable evidence.
