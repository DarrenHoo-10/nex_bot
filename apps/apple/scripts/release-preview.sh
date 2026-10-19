#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/release
xcodegen generate
xcodegen generate --spec Testing/project.yml --project build/RenderFixture
xcodebuild -project build/RenderFixture/NexRenderFixture.xcodeproj -scheme RenderMac -destination 'platform=macOS' -resultBundlePath build/mac-render.xcresult test CODE_SIGN_IDENTITY=-
SIM_ID=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(x["udid"] for k,v in d["devices"].items() if "iOS" in k for x in v if "iPhone" in x["name"]))')
xcodebuild -project build/RenderFixture/NexRenderFixture.xcodeproj -scheme RenderiOS -destination "platform=iOS Simulator,id=$SIM_ID" -resultBundlePath build/ios-render.xcresult test CODE_SIGN_IDENTITY=-
mkdir -p build/release/mac-screenshots build/release/ios-screenshots
xcrun xcresulttool export attachments --path build/mac-render.xcresult --output-path build/release/mac-screenshots
xcrun xcresulttool export attachments --path build/ios-render.xcresult --output-path build/release/ios-screenshots
xcrun xcresulttool get test-results summary --path build/mac-render.xcresult > build/release/mac-tests.json
xcrun xcresulttool get test-results summary --path build/ios-render.xcresult > build/release/ios-tests.json
xcodebuild -project NexBot.xcodeproj -scheme NexBotMac -configuration Release -derivedDataPath build/mac -destination 'platform=macOS' build CODE_SIGN_IDENTITY=-
xcodebuild -project NexBot.xcodeproj -scheme NexBotiOS -configuration Debug -derivedDataPath build/ios-simulator -destination "platform=iOS Simulator,id=$SIM_ID" build CODE_SIGN_IDENTITY=-
xcodebuild -project NexBot.xcodeproj -scheme NexBotiOS -configuration Release -derivedDataPath build/ios -sdk iphoneos -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO
MAC_APP=build/mac/Build/Products/Release/NexBot.app
test -x "$MAC_APP/Contents/Resources/Executor/node"
codesign --verify --deep --strict "$MAC_APP"
mkdir -p build/dmg build/ipa/Payload
ditto "$MAC_APP" build/dmg/NexBot.app
ln -s /Applications build/dmg/Applications
hdiutil create -volname NexBot -srcfolder build/dmg -ov -format UDZO build/release/NexBot-0.2.1-mac-arm64.dmg
ditto build/ios/Build/Products/Release-iphoneos/NexBot.app build/ipa/Payload/NexBot.app
(cd build/ipa && zip -qry ../release/NexBot-0.2.1-ios-unsigned.ipa Payload)
(cd build/release && shasum -a 256 *.dmg > SHA256SUMS-mac.txt && shasum -a 256 *.ipa > SHA256SUMS-ios.txt)
