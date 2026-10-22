#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/release
VERSION=$(sed -n 's/^ *MARKETING_VERSION: "\(.*\)"$/\1/p' project.yml | head -1)
test -n "$VERSION"
# Stage the device executor from this checkout; Xcode only copies apps/apple/build/Executor as it is.
if [ "${RENDER_ONLY:-false}" != true ]; then node ../../scripts/build-mac-executor.mjs; fi
xcodegen generate
xcodegen generate --spec Testing/project.yml --project Testing
SIM_ID=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(x["udid"] for k,v in d["devices"].items() if "iOS" in k for x in v if "iPhone" in x["name"]))')
failures=0
check() { if "$@"; then return 0; else failures=$((failures + 1)); fi; }
if [ "${RENDER_ONLY:-false}" != true ]; then
  check xcodebuild -project NexBot.xcodeproj -scheme NexBotMac -configuration Release -derivedDataPath build/native -destination 'platform=macOS' build CODE_SIGN_IDENTITY=-
  check xcodebuild -project NexBot.xcodeproj -scheme NexBotiOS -configuration Debug -derivedDataPath build/native -destination "platform=iOS Simulator,id=$SIM_ID" build CODE_SIGN_IDENTITY=-
  check xcodebuild -project NexBot.xcodeproj -scheme NexBotiOS -configuration Release -derivedDataPath build/native -sdk iphoneos -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO
fi
check xcodebuild -project Testing/NexRenderFixture.xcodeproj -scheme RenderMac -derivedDataPath build/render -destination 'platform=macOS' -parallel-testing-enabled NO -resultBundlePath build/mac-render.xcresult test CODE_SIGN_IDENTITY=-
xcrun simctl boot "$SIM_ID" || true
check xcrun simctl bootstatus "$SIM_ID" -b
check xcodebuild -project Testing/NexRenderFixture.xcodeproj -scheme RenderiOS -derivedDataPath build/render -destination "platform=iOS Simulator,id=$SIM_ID" -parallel-testing-enabled NO -resultBundlePath build/ios-render.xcresult test CODE_SIGN_IDENTITY=-
for platform in mac ios; do
  if [ -d "build/$platform-render.xcresult" ]; then
    mkdir -p "build/release/$platform-screenshots"
    check xcrun xcresulttool export attachments --path "build/$platform-render.xcresult" --output-path "build/release/$platform-screenshots"
    check xcrun xcresulttool get test-results summary --path "build/$platform-render.xcresult" > "build/release/$platform-tests.json"
  fi
done
test "$failures" -eq 0
if [ "${RENDER_ONLY:-false}" = true ]; then exit 0; fi
MAC_APP=build/native/Build/Products/Release/NexBot.app
test -x "$MAC_APP/Contents/Resources/Executor/node"
codesign --verify --deep --strict "$MAC_APP"
# Start from empty staging folders, so files from an earlier run never end up in these packages.
rm -rf build/dmg build/ipa
mkdir -p build/dmg build/ipa/Payload
ditto "$MAC_APP" build/dmg/NexBot.app
ln -s /Applications build/dmg/Applications
hdiutil create -volname NexBot -srcfolder build/dmg -ov -format UDZO build/release/NexBot-$VERSION-mac-arm64.dmg
ditto build/native/Build/Products/Release-iphoneos/NexBot.app build/ipa/Payload/NexBot.app
(cd build/ipa && zip -qry ../release/NexBot-$VERSION-ios-unsigned.ipa Payload)
(cd build/release && shasum -a 256 *.dmg > SHA256SUMS-mac.txt && shasum -a 256 *.ipa > SHA256SUMS-ios.txt)
