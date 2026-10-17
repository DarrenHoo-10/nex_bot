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

The built Mac app is `/tmp/nexbot-dd/Build/Products/Debug/NexBot.app`. Builds are ad-hoc signed (`CODE_SIGN_IDENTITY: "-"`),
which is enough for local runs; set your team in Xcode for distribution. The Mac app is not sandboxed in v1.

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
