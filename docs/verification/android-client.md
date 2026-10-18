# Android client — 2026-10-17

The phone client's P1 loop and its alignment with the current workspace design
(`doc/ui/`, updated 2026-10-17). Design: [Android client
plan](../plans/2026-10-17-android-client.md). Module notes:
[android/README.md](../../android/README.md). UI references:
[doc/ui/README.md](../../doc/ui/README.md).

## Toolchain

| | |
|---|---|
| JDK | JetBrains Runtime 21.0.6 (`C:\Program Files\JetBrains\IntelliJ IDEA 2025.1\jbr`) |
| Gradle | 9.5.0 (wrapper, `distributionUrl` in `android/gradle/wrapper/gradle-wrapper.properties`) |
| AGP / Kotlin | 9.3.1 / 2.2.21 (AGP's built-in Kotlin) |
| Android SDK | platform 36, build-tools 36.1.0, platform-tools |
| Emulator | `aosp_atd` android-36 x86_64, WHPX acceleration, 1080×2400, display kept awake |

No Android SDK package was installed on this machine before this run; the
toolchain, SDK and AVD are all outside the repository.

## Automated checks

```sh
cd android
./gradlew --no-daemon :core:test :app:testDebugUnitTest :app:assembleDebug
```

Result: `:core` **44 tests / 6 classes**, `:app` **26 tests / 7 classes**, 0
failures. The debug APK is
`android/app/build/outputs/apk/debug/nexbot-0.1.0-debug.apk`,
**12,275,408 bytes**, SHA-256
`C002B4A9888C2CC9B14B1CF164C27D3F66D3FF3A4514D70A09471D3B79B4776F`. The
unsigned release build is `nexbot-0.1.0-unsigned.apk`; both names come from
`versionName` in `android/app/build.gradle.kts`.

Fixtures are compared against a disposable Core rather than trusted as
checked-in bytes:

```sh
node --experimental-transform-types --no-warnings scripts/capture-android-fixtures.mjs --core=server/personal-os/index.ts --check
```

Result: 7 fixtures match; the same capture from the TypeScript source and from a
packaged Core build is byte-identical.

## UI against the design references

The phone follows `doc/ui/` rather than Material defaults:

- **Tokens.** Light `#fafaf8` page / `#ffffff` card / `#f0f0ed` secondary /
  `#e2e2dc` user bubble / `#1a1a1a` ink / `#6c6c70` muted / `#2563eb` link;
  dark `#0b0c0e` page / `#141518` card / `#18191e` secondary / `#22242b` user
  bubble / `#ececee` ink / `#85858a` muted / `#3b82f6` link. The account and
  send accent is the blue companion (`#4d6bfe`, mark gradient
  `#5285ff → #2859dc`), not green.
- **Brand.** `NexMark` draws the same path as
  `src/personal/assets/nexbot-mark.svg`; the launcher icon uses that path and
  the status bar gets a monochrome silhouette.
- **Avatars.** The contract in `shared/personal-appearance.ts`: first Agent
  soft/teal, every other Agent hashed into 4 shapes × 5 colours
  (teal/ink/blue/clay/plum). The phone draws the rounded body, two eyes and the
  state dot; portraits are not rendered yet.
- **Login.** 420dp card on the tinted background, 22dp radius, 56dp mark,
  24dp `登录 NexBot` title, two labelled 44dp fields (`输入你的邮箱` /
  `输入密码`), full-width blue button and the `没有账号？ 去注册` line — the
  card from the 2026-10-17 `login-light.png` (no eyebrow, no subtitle). The
  Core address is not a field (the web gets it from the desktop shell); it
  sits behind the small `服务器：…` line under the card, which defaults to the
  hosted origin and opens a dialog for a self-hosted Core.
- **Agent list.** Brand row, filled search field, `对话` count, 44dp avatars,
  preview and time, black unread disc, and the account row with the blue person
  disc pinned at the bottom.
- **Chat.** 65dp header (back, avatar, name, state label), centered day divider,
  right-aligned `#f0f0ed`/`#22242b` user bubbles with an 18/18/5/18 radius,
  transparent assistant text, per-message time plus 引用/复制, collapsible
  `执行记录` with a status dot, tool label, monospace summary and status,
  amber-bordered approval card with 批准/拒绝, `Agent 正在工作…` row with
  停止任务, and the composer from the 2026-10-18 reference: text on top,
  `＋` / 权限 / send below.
- **Composer.** `＋` groups `添加` (文件) and `指令` (权限, 导出对话); the
  desktop-only 模型设置 entry is omitted until the phone has a settings page.
  The 权限 button shows the per-Agent mode (`标准权限` / `完全权限`) and saves it
  with the bot version. Attachments are limited to five files of 5 MiB each,
  upload one at a time and appear as removable chips; sent attachment links
  download with the bearer into Downloads (Q+) or the app's own files folder
  (26–28). 导出对话 shares the whole transcript as Markdown.
- **Logout.** The account row opens the menu; 退出登录 opens the confirmation
  from `logout-confirm-light.png` (`退出当前账号？` / `退出后需要重新登录。你的聊天和助手会保留。`)
  before the session is cleared.

The three screens are rendered to PNGs by `ScreenRenderTest` (Robolectric
native graphics) under `build/screens/`; copies are in
`release/android-e2e/ui-connect.png`, `ui-agents.png`, `ui-chat.png`. That test
also asserts the pixels are not blank, so a broken layout cannot pass silently.

Copy follows the repo's product-copy rule (AGENTS.md): labels, real status and
necessary errors only. The server dialog is a title plus one field, empty
screens are a single line, and there are no explanatory paragraphs or
redundant subtitles.

Deliberately not built in P1: the header share/info actions, portrait avatars,
the settings/connectors/devices and identity pages, and the 模型设置 entry
(it needs the settings page that P2 adds). The desktop device executor (auto
local control, Pause/Resume, stop on logout) is a Windows/Mac client concern;
a phone client has no local device to control in this version.

## Emulator end-to-end

Fixture: one disposable Core started through `server/personal-os/index.ts`
with `server/personal-os/testing/fake-identity.ts` as the account provider and
`server/runtime/pi/p0/fake-model.ts` as the model. It associated a synthetic
owner the way `init` does, seeded one Agent (`艾达`) with one assistant message,
and printed its origin. The phone reached it through `adb reverse`, so no LAN
listener was opened and the address stayed a loopback URL.

Steps, driven through the real UI with `uiautomator` taps and text input:

1. install the debug APK (`com.nexorai.nexbot.debug`), launch, allow
   notifications;
2. fill server address, account and password, tap 登录;
3. the Agent list appears with the seeded name, last message and unread badge;
4. tap the Agent, the seeded transcript renders;
5. queue one scripted model reply, type `hello`, tap 发送;
6. the reply `收到，这是合成回复。` appears in the transcript and the header
   turns to `已完成`.

Driver result:

```json
{
  "steps": ["login -> agent list", "agent chat -> seeded transcript", "sent hello", "streamed synthetic reply"],
  "modelRequests": 1
}
```

UI hierarchy dumps (accessibility text, one per step) are under
`release/android-e2e/`: `connect.xml`, `agents.xml`, `chat.xml`, `reply.xml`.
They are the readable record of the emulator run; this headless emulator's
screenshots come back black, so the rendered PNGs above are the visual
evidence.

## A bug this pass found and fixed

The live-events request was built without its Bearer token. Core answered 401,
and the expiry path cancelled the stream job before it could show the login
screen — the app stayed on a stale chat and only the ten-second poll refreshed
it. The request now carries `Authorization`, the fixture test asserts the
header, and expiry changes state before stopping the jobs. A fresh emulator run
shows the stream connecting once with no refusal and the reply arriving without
a poll.

## What this does not prove

- No physical phone: Keystore on real hardware, notification delivery, IME
  behaviour and touch targets are untested.
- No approval round-trip from the phone: the approval card is covered by the
  Robolectric chat-screen test and the rendered screen, not by an end-to-end
  tool call.
- The attachment flow is covered at the request layer (upload body, send with
  attachment ids, bearer download) and by the composer's Robolectric test; the
  system file picker, the upload of a real file and the save-to-Downloads step
  are not driven end-to-end. 导出对话 is covered only at the request layer; the
  share sheet is not automated.
- The phone has no model settings; the desktop-only 模型设置 menu entry is not
  rendered rather than shown as a dead control.
- Portrait avatars fall back to the companion body; the 20 classic portraits
  are not shipped.
- Release signing, R8/minified builds and store packaging are not exercised.
- The emulator's own screenshots are black on this headless GPU; the rendered
  PNGs are the visual record.
- The CI job that runs these suites has not executed on GitHub Actions yet; it
  is advisory and is not in the merge gate.
- The Android SDK here is platform 36 because the repository's `compileSdk`
  was reduced from the deleted app's 37, whose package name on this SDK
  channel is `platforms;android-37.0`.
