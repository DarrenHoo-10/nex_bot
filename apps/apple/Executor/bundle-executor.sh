#!/bin/sh
# NexBotMac build phase: copies apps/apple/build/Executor (made by `node scripts/build-mac-executor.mjs`) into
# NexBot.app/Contents/Resources/Executor and signs every nested Mach-O file. The app's own signature is applied
# afterwards by Xcode and seals these files. Without the staged directory the app still builds; the executor is then
# reported as unavailable at run time.
set -eu
SOURCE="$SRCROOT/build/Executor"
DEST="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Resources/Executor"
rm -rf "$DEST"
if [ ! -d "$SOURCE" ]; then
  echo "warning: $SOURCE is missing; run 'node scripts/build-mac-executor.mjs'. Building without the device executor."
  exit 0
fi
mkdir -p "$(dirname "$DEST")"
ditto "$SOURCE" "$DEST"
IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY:--}"
[ -n "$IDENTITY" ] || IDENTITY="-"
STAMP="--timestamp=none"
[ "$CONFIGURATION" = "Release" ] && [ "$IDENTITY" != "-" ] && STAMP="--timestamp"
ENTITLEMENTS="$SRCROOT/Executor/node.entitlements"
find "$DEST" -type f ! -name '*.mjs' ! -name '*.js' ! -name '*.json' ! -name '*.txt' ! -name '*.sql' | while IFS= read -r file; do
  case "$(file -b "$file")" in
    *Mach-O*executable*) codesign --force --sign "$IDENTITY" --options runtime $STAMP --entitlements "$ENTITLEMENTS" "$file" ;;
    *Mach-O*) codesign --force --sign "$IDENTITY" --options runtime $STAMP "$file" ;;
  esac
done
echo "Bundled device executor into $DEST"
