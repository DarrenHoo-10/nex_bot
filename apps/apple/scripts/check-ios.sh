#!/usr/bin/env bash
# Compile-checks NexClientKit and the iOS app sources against the iOS Simulator SDK without needing
# an installed simulator runtime (xcodebuild refuses iOS destinations when the iOS platform is not installed).
set -euo pipefail
cd "$(dirname "$0")/.."
SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
SCRATCH=${TMPDIR:-/tmp}/nexclientkit-ios
swift build --package-path Packages/NexClientKit --sdk "$SDK" --triple arm64-apple-ios17.0-simulator --scratch-path "$SCRATCH"
xcrun --sdk iphonesimulator swiftc -typecheck -parse-as-library -D DEBUG -target arm64-apple-ios17.0-simulator -swift-version 6 \
  -I "$SCRATCH/arm64-apple-ios-simulator/debug/Modules" NexBotiOS/*.swift
echo "iOS compile check passed"
