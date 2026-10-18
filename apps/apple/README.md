# NexBot native clients (macOS + iOS)

SwiftUI clients for Core's client protocol v1. Design: `docs/plans/2026-10-17-native-mac-ios-clients.md`.

```
Packages/NexClientKit/   SwiftPM library: protocol DTOs, CoreClient, SSE, login, sync stores
NexBotMac/  NexBotiOS/   app targets (SwiftUI)
project.yml              XcodeGen spec; NexBot.xcodeproj is generated and gitignored
```

Requirements: Xcode 16.4+, `brew install xcodegen`. Deployment targets are macOS 14 and iOS 17.

## Build and test

```sh
node scripts/build-mac-executor.mjs                             # stages apps/apple/build/Executor (bundled device executor), see below
swift test --package-path apps/apple/Packages/NexClientKit     # unit tests (URLProtocol stubs)
apps/apple/scripts/generate.sh                                  # writes apps/apple/NexBot.xcodeproj
xcodebuild -project apps/apple/NexBot.xcodeproj -scheme NexBotMac -destination 'platform=macOS' \
  -derivedDataPath /tmp/nexbot-dd build CODE_SIGNING_ALLOWED=NO
xcodebuild -project apps/apple/NexBot.xcodeproj -scheme NexBotiOS \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath /tmp/nexbot-dd-ios build
```

Keep signing on for iOS (the project's ad-hoc identity works in the Simulator): an unsigned iOS build has no
Keychain entitlement and login fails with `钥匙串错误 (-34018)`. Install the runtime with `xcodebuild -downloadPlatform iOS`.

If Xcode reports "iOS 18.5 is not installed" (no iOS platform/simulator runtime on the machine), run
`apps/apple/scripts/check-ios.sh` instead. It builds the package and type-checks the iOS sources against the simulator SDK.

The built Mac app is `/tmp/nexbot-dd/Build/Products/Debug/NexBot.app`. The Mac app is not sandboxed.

### Mac signing

`Config/Mac.xcconfig` signs ad-hoc by default. macOS then treats every rebuild as a new app and asks for the login keychain
password before it can read the saved login. For a stable identity, copy `Config/Signing.local.xcconfig.example` to
`Config/Signing.local.xcconfig` (git-ignored) and set your Apple Development identity and team
(`security find-identity -v -p codesigning`). Developer ID signing and notarization are not set up yet.

## Device executor (macOS)

The Mac app bundles the same device runtime as the Electron client, so a signed-in Mac becomes a Core device that can
read files and run commands (macOS has no window control yet). `LocalDeviceController` (`NexBotMac/LocalDevice.swift`)
spawns `Contents/Resources/Executor/node executor-host.mjs <dataDir>` and talks newline-delimited JSON over stdin/stdout
(protocol in the header of `Executor/executor-host.mjs`). The host reuses `electron/nex-client-device.mjs` and
`dist-personal/client-executor` unchanged.

Run `node scripts/build-mac-executor.mjs` before building (needs `pnpm install` and network the first time). It builds the
client executor (`scripts/build-client-executor.mjs`; `--reuse-executor` skips that), downloads the official Node
binary matching the Node that runs the script, verifies it against `SHASUMS256.txt`, caches it in `apps/apple/build/cache`
and stages `apps/apple/build/Executor` (about 160 MB; git-ignored). Xcode's "Bundle device executor" phase
(`Executor/bundle-executor.sh`) copies it into the app and signs `node` (hardened runtime plus the JIT entitlements in
`Executor/node.entitlements`) and every `.node` library with the target's signing identity. Without the staged directory the
app still builds and reports the executor as unavailable. Test the host protocol with
`node --test apps/apple/Executor/executor-host.node-test.mjs`.

Data lives in `~/Library/Application Support/NexBot/<profile or default>/devices` (0700). Its 32-byte encryption key is a
Keychain item (service `com.nexbot.client`, account `executor-key:<profile>`); remove both when deleting a fixture profile.
The host is stopped without revoking when the app quits (or dies: stdin EOF), and revoked on logout.
The home directory is the read boundary and default working directory of commands; it is not a sandbox.

## Launch options

| Flag | Environment | Effect |
| --- | --- | --- |
| `--profile=NAME` | `NEXBOT_PROFILE` | Keychain account for the login record (default `default`). Use a throwaway name for fixtures. |
| `--origin=URL` | `NEXBOT_CORE_ORIGIN` | Pre-fills the origin and re-points a saved login. Resume then verifies the Core ID before sending the token. |

The origin must be a root URL: `https://…`, or `http://` only for localhost, `[::1]`, 127/8, 10/8, 172.16/12, 192.168/16.
The default is `https://bot.nexorai.com.cn`. The login record lives in the Keychain (service `com.nexbot.client`).
Remove a fixture record with `security delete-generic-password -s com.nexbot.client -a <profile>`.

```sh
open /tmp/nexbot-dd/Build/Products/Debug/NexBot.app --args --profile=fixture-1 --origin=http://127.0.0.1:PORT
```

## Fixture

`scripts/fixture-native-client.mjs` (repo root) starts an isolated Core with a fake identity and model, and prints the
origin, account and password. Point the app at it with the flags above. Never use the live account or Core for verification.

## Model picker and memory (Mac)

`NexBotMac/ModelPicker.swift` is the shared searchable picker (default model, per-assistant chat model from the composer's ＋ menu, memory model). Settings › 模型 includes 显示的模型; Settings › 长期记忆 is the unified account-wide memory page. The sidebar field searches message text across assistants (`ConversationSearch`, `NexBotMac/ConversationSearchResults.swift`); a hit opens the window around it (`WorkspaceStore.openSearchResult`, `ConversationStore.focusedMessageID`), with 返回最新消息 to leave; DEBUG `search <text>`, `searchopen <text>|<n>`, `latest`. DEBUG commands on `$NEXBOT_DEBUG_COMMAND_FILE` (`modelmenu`, `setmodel <id|->`) and `.b` (`mp ...`, `mv ...`, `mm ...`, `md open|scroll`) drive them for screenshots.
