# Native macOS and iOS clients

Design: [`docs/plans/2026-10-17-native-mac-ios-clients.md`](../plans/2026-10-17-native-mac-ios-clients.md).
Never point a client at the live Core or the live account. Everything below uses
`scripts/fixture-native-client.mjs`: an owned temp directory, a random key, the
synthetic NexorAI identity and a scripted fake model.

## 1. Build Core and start the fixture

```sh
pnpm build:core                      # produces dist-personal/server/core and dist-personal/server/ui
node --experimental-strip-types scripts/fixture-native-client.mjs --port=47911
```

Run it directly (not through `pnpm`) so Ctrl-C reaches it. Without `--port` Core
picks a free port. The launcher refuses to run when `dist-personal/server/core/index.js`
is missing. It prints a block like:

```
Core origin : http://127.0.0.1:47911
Account     : owner@example.test
Password    : " synthetic password "   (leading and trailing spaces are intentional)
Temp dir    : /var/folders/.../nex-native-fixture-XXXXXX
PID         : 12345
```

The password includes a leading and a trailing space; type it exactly.
`other@example.test` uses the same password but this Core is bound to the owner
identity (no `accountWorkspaces` mode), so Core answers
`此账号未获准访问这个 Core` at login. Use it to check the error text is shown.

Seeded state: agents 工作助手 and 研究伙伴, each with one user/assistant exchange.

### Driving the fixture

The fixture reads commands from stdin. For an automated verifier, feed it from a file:

```sh
touch /tmp/fx.in
tail -f /tmp/fx.in | node --experimental-strip-types scripts/fixture-native-client.mjs --port=47911 > /tmp/fx.out 2>&1 &
echo "status" >> /tmp/fx.in
```

| Command | Effect |
| --- | --- |
| `reply <text>` (a literal `\n` becomes a line break) | The next model reply streams `<text>` in about 12 deltas, 450 ms apart, so streaming UI is observable. |
| `approval` | The next model turn calls `device.exec` (risk `dangerous`) on the host device, which creates a pending approval; after the decision the model replies with a short text. |
| `devices` | Prints `state.devices` with `bound`/`revoked` status and whether each is online. |
| `device-exec <deviceName\|"device name"> <command>` | Like `approval`, but the next model turn runs `device.exec` (risk `dangerous`, needs approval) on the bound device with that name. Use harmless commands such as `echo`. |
| `send <agent> <text>` | Posts a user message as the fixture's own session (agent by name or id). Combine with `reply` or `approval` to trigger the scripted turn. The client sees new messages via SSE. |
| `history <agent> <n>` | Adds `n` (at most 200) exchanges to one agent, for older-history paging (pages are 100 messages). |
| `revoke-others` | Revokes every client session except the fixture's own. |
| `forget <agent>` | Prints the memory forget preview only. It does not mutate. |
| `memory <agent> <title> \| <content>` | Creates a private long-term memory for the agent (`POST /api/memory`). Agent is a single token (name or id). |
| `routine <agent> <name>` | Creates a daily 09:00 routine in the machine's time zone for the agent. |
| `peer` | The next model turn makes 工作助手 delegate to 研究伙伴 (`agent.delegate`), then replies `已联系研究伙伴。`. Follow with `send 工作助手 <text>`; `state.delegations` then holds the hand-off. |
| `status` | Prints agents, pending approvals (id, hash), sessions and sync cursor. |
| `quit` | Stops Core and the fake services and removes the temp dir. Ctrl-C and SIGTERM do the same. |

The banner also prints `Fake MCP`, the synthetic MCP server (`server/personal-os/testing/fake-mcp.ts`, tools `echo` and
`private_tool`). Add `<origin>/mcp` (Streamable HTTP) or `<origin>/sse` (SSE) as a connector, test it, then grant tools to an
agent. The model is already configured, so `state.config` is present.

Any model request without a scripted reply gets a default text reply, so ordinary
sends from the app also work. Closing stdin does not stop the fixture.

## 2. Build and launch the macOS app

See `apps/apple/README.md` for the XcodeGen and `xcodebuild` steps. Pick a random profile so the
Keychain record is isolated, then launch with it:

```sh
PROFILE=fixture-$(openssl rand -hex 4)
<built NexBotMac.app>/Contents/MacOS/NexBotMac --profile=$PROFILE --origin=http://127.0.0.1:47911
```

## 3. Walkthrough checklist

Record a screenshot or log excerpt for each item.

1. Login: the origin is pre-filled, sign in as `owner@example.test` with the exact password. A wrong password
   and `other@example.test` both show Core's message and store nothing.
2. Resume: quit and relaunch with the same `--profile`. The app resumes without asking for a password.
   Relaunch with a different profile and confirm it shows the login screen.
3. Send and stream: run `reply <long text>` in the fixture, send a message to 工作助手 in the app. The text grows
   in several steps, then becomes one committed assistant message with no duplicate.
4. Inbound: `send 研究伙伴 来自夹具的消息` shows the message in the open or unread agent without a manual refresh,
   with an unread badge when it is not the open agent.
5. Read state: opening the agent clears the unread badge. Confirm with `status` or `GET /api/state`.
6. Older history: `history 工作助手 60` (about 120 messages), reopen the agent, scroll to the top, and confirm the
   older page loads once without gaps or duplicates.
7. Stop: `reply` a long text, send, press Stop (or Cmd-.) while it streams. The task ends and the draft is not stuck.
8. Approve: `approval`, then send. An approval card appears in the chat and the inbox. Approve, then confirm the
   follow-up reply appears. Repeat with Deny and confirm the command does not run. A second decision on the same
   approval shows Core's error text.
9. Revocation: with the app signed in, run `revoke-others`. The app returns to login with a message and the
   Keychain record is gone (the next launch shows the login screen).
10. Logout: sign in again, then Settings, sign out. The session no longer appears in `GET /api/clients`.
11. Disconnect: stop the fixture (`quit`) while the app is open. The app shows the resync state and clears
    private content. Restart the fixture on the same port: it is a new Core (new `coreId`), so the app must not
    resume the old record.

### Mac device executor

The Mac app registers itself as a device and runs the bundled executor (see `apps/apple/README.md`). Build with
`node scripts/build-mac-executor.mjs` first, otherwise the app reports no executor. DEBUG builds read extra commands from
`$NEXBOT_DEBUG_COMMAND_FILE.d` (results in `.d.log`): `devicestate`, `devicepause on|off`, `devicekill` (host must restart),
`devicequit` (normal quit path), `devicelogout` (`AppModel.logout()`). Walkthrough on a fixture profile:

1. After login, fixture `devices` lists the Mac as `bound`, `online: true`.
2. `device-exec "<Mac name>" echo nexbot-mac-ok`, then app `select 工作助手` and `send <text>`, then `approve`. The
   tool step of `/api/agents/messages` is `device.exec` `succeeded` with stdout `nexbot-mac-ok`.
3. `devicepause on` makes it offline and `off` brings it back. `devicekill` restarts the host with the same device id.
4. `devicequit` leaves no `Executor/node` process and the device stays `bound` but offline. Relaunch resumes the same device id.
5. `devicelogout` leaves the device `revoked` and the Keychain login item gone.
6. Cleanup: delete both Keychain items (`<profile>` and `executor-key:<profile>`) and `~/Library/Application Support/NexBot/<profile>`.

Logout revokes the device with a request started synchronously when `AppModel.logout()` begins (it must go out before
Core ends the session). If that request loses the race the device stays bound until revoked from another client.
Window control is not implemented on macOS.

## 4. iOS

Build with the iOS Simulator SDK. Launch in a simulator only when an iOS runtime is installed
(`xcrun simctl list runtimes`). Use `--origin=http://127.0.0.1:47911` (the simulator shares the host loopback). Otherwise
record that iOS was compile-verified only. The same checklist applies, with the foreground-only SSE rule:
background the app, send from the fixture, foreground it, and confirm a full refresh shows the message.

## 5. Cleanup

```sh
echo quit >> /tmp/fx.in            # or Ctrl-C in the fixture terminal
security delete-generic-password -s com.nexbot.client -a $PROFILE
rm -f /tmp/fx.in /tmp/fx.out
```

The fixture removes only its own `nex-native-fixture-*` directory under the system temp dir.

## Evidence

Run on 2026-10-17 against base `c2b66241` with uncommitted changes, on macOS 15 (arm64), Xcode 16.4.

- `swift test` (NexClientKit): 41 tests, 0 failures (the 41st covers revoking an issued session when the Keychain save fails). They cover origin rules, DTOs, login/resume/logout, SSE parse/reconnect with `Last-Event-ID`, reset/epoch/boot/core invalidation, stale-response discard, `hasMore` drain, `loadOlder`, read receipts, send retry with the same `clientId`, stop, approvals and sessions.
- `xcodebuild` macOS (`NexBotMac`, Debug, `CODE_SIGNING_ALLOWED=NO`): BUILD SUCCEEDED.
- `xcodebuild` iOS Simulator (`NexBotiOS`, Debug, ad-hoc signed, iPhone 16 Pro, iOS 18.6 runtime): BUILD SUCCEEDED. `scripts/check-ios.sh` (now type-checking with `-D DEBUG`) also passes.
- Fixture: two runs. The agent run used `http://127.0.0.1:61310`, and the coordinator run used `http://127.0.0.1:61751`. Each used a throwaway `fixture-*` Keychain profile, deleted afterwards. The DEBUG-only hooks `NEXBOT_FIXTURE_AUTOLOGIN_*` and `NEXBOT_DEBUG_COMMAND_FILE` drove the app, because System Events/AppleScript is blocked on this machine.
- Login / resume: auto-login connected and listed both agents. After quitting and relaunching with the same profile and no password, the app resumed straight into the workspace.
- Send + streaming: "正在回复…", the partial text and 停止 are visible while streaming. The reply then committed once, with no duplicate (`a1-streaming.png`, `a2-committed.png`).
- Read state: the unread badge stays while the window is not key (99+). Once the app was activated it cleared (`a3-active-read.png`). Selecting another agent also cleared its badge (`09-read-cleared.png`).
- Older history paging: 300 seeded messages (`history 工作助手 150`) loaded the newest window and drained the follow-up pages through SSE. Scroll-to-top `loadOlder` was **not** driven in the UI; it is covered only by `testLoadOlder`.
- Stop: the button is shown during an unfinished task. A real press was **not** exercised; the logic is covered only by `testStopCancelsUnfinishedTask`.
- Approve / deny: an inline card and an inspector card appeared. Approving produced the `执行终端命令` tool row and the follow-up reply (`06-approval.png`, `07-approved.png`). Deny was not exercised at runtime.
- Revocation: after `revoke-others` the app returned to login with "此设备的登录已过期或被撤销，请重新连接。", and the Keychain item was gone (`10-revoked.png`).
- Logout: covered only by `testLogoutBestEffortDeletes` and `testAppModelFlow`. It was not clicked in the UI.
- Not exercised: the Settings window, the menu bar extra, keyboard shortcuts (⌘N/⌘./⌘R, Return/⇧Return), and dark mode.
- iOS runtime available: yes (iOS 18.6 Simulator, installed for this run).

### iOS Simulator walkthrough (fixture `http://127.0.0.1:50621`, profile `fixture-ios1`)

The iOS DEBUG-only hooks have the same environment names as the Mac ones. Values are passed with the `SIMCTL_CHILD_` prefix. The commands are `tab`, `open`, `back`, `send`, `approve`, `deny`, `stop`, `revoke`, and `logout`. `simctl` cannot tap, so these hooks drove the app. Screenshots are in `release/native-ios-acceptance/` (git-ignored).

- **Found and fixed: Keychain.** The first launch came from an unsigned build (`CODE_SIGNING_ALLOWED=NO`), and login failed with `钥匙串错误 (-34018)` (no Keychain entitlement). Core had already issued that session, which became an orphan. The fixes:
  - The README now keeps ad-hoc signing on for iOS.
  - `LoginService.login` now logs out an issued session when the credential cannot be saved, with a unit test.
  - The orphaned fixture session was then revoked from the app's 设置 (`i16`).
- **Found and fixed: tool status.** After a denial, both tool rows looked identical. A collapsed tool row on iOS now shows its status, for example `执行终端命令 · 已拒绝` in red (`i13`, `i17`). Core confirmed the two calls as `succeeded` and `rejected`.
- **Found and fixed: approval expiry.** The 审批 expiry showed only the time, and the 24 h expiry looked like "now". It now includes the date (`i14`).
- Login: auto-login connected and listed both agents with unread badges (`i02`).
- Resume: after relaunching without credentials, the app went straight to 会话 (`i12`).
- Send + streaming: partial text, a spinner and the red Stop button appeared, then the reply committed (`i03`, `i04`).
- Approve: an inline card with arguments appeared (`i05`). The 审批 tab badged 1 (`i06`). Approving gave tool status `succeeded`.
- Deny: Core recorded tool status `rejected` (`i09`).
- Stop: Core recorded the task as `cancelled` with "用户取消" (`i10`).
- Read state: the badge cleared after the conversation was opened (`i11`).
- Background → foreground: a message arriving while in Settings.app appeared on return, with the badge going from 1 to 2 (`i18`).
- Dark mode + accessibility-medium Dynamic Type: the layout holds (`i17`, `i18`).
- Revocation: after `revoke-others` the app returned to login with "此设备的登录已过期或被撤销，请重新连接。" (`i19`).
- Logout: the server-side session was removed (Core's session list kept only the fixture controller). Relaunching stayed on login (`i21`, `i22`).
- Cleanup: the app was uninstalled, the Simulator keychain reset and the Simulator shut down. The fixture quit and removed its temp dir.
- Not exercised on iOS: scroll-to-top paging, the keyboard/composer interplay on a real keyboard, and a physical device.
- Screenshots (git-ignored): `release/native-mac-verification/` and `release/native-mac-acceptance/`.

## Web parity and the 0.9.x alignment (2026-10-17)

Base: `main` at `54218891` merged. The kit is at 60 unit tests. `NexBotMac` and `NexBotiOS` build
with signing on and no warnings, and `check-ios.sh` passes. Every UI run used an isolated fixture,
the synthetic account and the fake MCP and model, with throwaway Keychain profiles that were deleted
afterwards.

- **Mac and iOS feature areas.** These were exercised against fixtures, mostly through the DEBUG
  command files, because UI scripting is unavailable on this machine:
  - agent create, identity, avatar, pin, permissions and archive;
  - routines, including create/edit, the switch and 现在执行 in the editor;
  - memory save and forget, plus file and tool previews;
  - quote, copy and @mention;
  - A2A markers;
  - connectors: add the fake MCP, test it, grant a tool, then disable and remove it;
  - devices: pair, revoke and the node root;
  - model save and discovery (`/api/models/list` lists fixture-model and fixture-reasoning);
  - the memory-service test error;
  - logout confirmation.
- **0.9.x alignment.** It follows `doc/ui/README.md`:
  - the inspector has only 工作 / 设置, and the 资料 implementation stays unreferenced, as on the web;
  - routines are a compact list;
  - clicking the avatar opens the picker, and 关于 → bot身份信息 opens the identity editor;
  - the account menu has only 设置, the theme toggle and logout;
  - settings have five categories, with connectors and devices moved inside;
  - 系统信息 and the advanced request address are removed;
  - the simplified login has the `/register/nexbot` link;
  - logout uses an in-app confirmation;
  - avatar motion is state-driven, and the sidebar moves only while thinking or working.
- **Not exercised.**
  - Real memory-engine recall facts and reflect answers, because the fixture has no Hindsight.
  - Escape on the Mac logout dialog, because keystrokes can't be scripted here.
  - Physical devices.
- **Screenshots** (git-ignored):
  - `release/native-mac-parityA`, `-parityB`, `-align`, `native-mac-acceptance2`
  - `release/native-ios-parityA`, `-parityB`, `-align`

## Composer menus, uploads, permission modes and model limits (2026-10-18)

Base: `main` at `b992ddf8`, merged. The kit has 90 tests, which cover:
- uploads and downloads, and pending attachments that are retried with the same `clientId` and ids;
- per-agent `standard`/`full` mode;
- tri-state model limits;
- paginated Markdown export with privacy checks;
- `?view=summary` polling;
- bearer rotation 30 minutes before expiry, which is persisted and restarts SSE.

Mac and iOS were exercised against isolated fixtures (`release/native-mac-composer`, `release/native-ios-composer`, `release/native-mac-acceptance3`):
- **Attachments.** A file was attached and sent, and the message carries the `/api/attachments/<id>` link. Downloading the file gave the same bytes. A message with only an attachment also sends. A 6 MB file is rejected inline.
- **Full access.** With 完全权限, the tool ran with no approval card. Back on 标准权限, the approval card returned.
- **Export.** It uses the `### 我 · M/D HH:mm` + `---` format.
- **Model limits.** The fields start on automatic (256,000 / 32,000). A manual 100000 / 128000 survives a relaunch, and clearing the fields returns them to automatic.
- **Account avatar.** It shows the initial of the account name.

**Not exercised:**
- The real file and save panels, and drag-and-drop. Debug commands drove the same code paths instead.
- The 联网识别 online lookup, because the fixture is offline.
- Session refresh at a real 8-hour boundary. Unit tests cover the policy.

## Mac alignment with unified memory and the searchable model picker (2026-10-18)

Kit (`NexClientKit`): `Bot.selectedModel` / `modelSelectionVersion`, `WorkspaceState.modelVisibility`,
`WorkspaceStore.setAgentModel(botID:model:)` (`""` follows the default), `saveModelVisibility(models:version:)`
(`nil` = show all, explicit `null` on the wire), `memorySummary()`, `saveMemorySettings(enabled:model:version:)`.
`/api/models/list` has no client paging (Core follows provider cursors), so `listModels` returns `{models, hasMore}`.
Existing APIs are unchanged; iOS compiles without edits.

Mac: one shared searchable picker (`ModelPicker.swift`) for the default model, the assistant's chat model (＋ › 模型,
anchored to ＋) and the memory model; the composer no longer has a permission pill (＋ › 权限 opens the permission menu).
设置 › 模型 gained 显示的模型; 设置 › 长期记忆 replaces the Hindsight page (one switch, memory model, 总 Token).
The header and inspector show the assistant's own model.

Verified against `scripts/fixture-native-client.mjs` with the debug build: setting 工作助手 to `fixture-reasoning`
persists (`selected_model`), 研究伙伴 still follows the default; switching during a running task shows
"请等待当前任务结束或停止任务后切换模型" inline; saving a shortlist updates `state.modelVisibility` and the picker then lists
only the shortlist plus the current (hidden) model and the follow-default row; the memory switch and model save
through `/api/memory/settings`. Screenshots: `release/native-mac-align3/`.

## iOS alignment and conversation search (2026-10-18)

iOS gets the same model and memory changes as Mac (`ModelPicker.swift`, `SettingsModelVisibility.swift`, ＋ › 模型 sheet,
设置 › 长期记忆, the assistant's own model in the chat header) and the sidebar conversation search of the web client
(`ConversationSearchRows.swift`). On both native clients a hit opens the window around the message (`/api/agents/messages?around=`),
outlines it, shows 返回最新消息 and leaves that view on sending, on choosing another contact, or on the explicit return.
Kit: `ConversationSearch`, `WorkspaceStore.openSearchResult(_:)` / `showLatest(botID:)`, `ConversationStore.focusedMessageID`.
`select(_:)` keeps the view of the open conversation (iOS selects it when the chat appears) and leaves any other.

Verified against `scripts/fixture-native-client.mjs` (synthetic history, 120+ messages) with the Debug Mac build and the iOS 18.6
simulator (iPhone 16 Pro, throwaway profile, auto-login): searching 三国演义 lists both assistants newest first; opening the old
hit shows messages from the start of the chat, the outlined message and 返回最新消息; returning loads the latest page scrolled to the
bottom; the ＋ › 模型 sheet lists the default row and the shortlist; 长期记忆 shows the switch, memory model and total tokens.
Not covered: tapping rows by hand (DEBUG commands `search`, `searchopen`, `latest` drive the same paths), literal `%`/`_` matching on
native clients, and release/TestFlight builds. The fixtures, simulator app and profiles were removed afterwards.
