#!/bin/sh
# Package pipi.app, sign it with the Developer ID, wrap it in a DMG, and
# optionally notarize and staple both the .app and the .dmg.
set -e
cd "$(dirname "$0")/.."

OUT=.nsh/out
IDENTITY="${PIPI_SIGN_ID:-30CBB910E4C8CB5124215C07B7973FEBED3FE6FF}" # Developer ID Application: lingxi lu (4Y2GJ2W4YH)
NOTARY_PROFILE="${PIPI_NOTARY_PROFILE:-}"

nsh package --target macos

codesign --force --sign "$IDENTITY" --options runtime --timestamp "$OUT/pipi.app"
codesign --verify --deep --strict "$OUT/pipi.app"

if [ ! -f assets/brand/dmg-background.png ] || [ ! -f assets/brand/dmg-background@2x.png ]; then
  node scripts/render-brand.mjs
fi

# Unmount any stale /Volumes/pipi before building a new DMG.
if [ -d /Volumes/pipi ]; then
  hdiutil detach /Volumes/pipi -force >/dev/null 2>&1 || true
fi

rm -rf "$OUT/dmg-staging" "$OUT/pipi-rw.dmg" "$OUT/pipi.dmg"
mkdir -p "$OUT/dmg-staging/.background"
cp -R "$OUT/pipi.app" "$OUT/dmg-staging/"
ln -s /Applications "$OUT/dmg-staging/Applications"
tiffutil -cathidpicheck assets/brand/dmg-background.png assets/brand/dmg-background@2x.png \
  -out "$OUT/dmg-staging/.background/background.tiff" >/dev/null

hdiutil create -volname pipi -srcfolder "$OUT/dmg-staging" -ov -format UDRW "$OUT/pipi-rw.dmg"
rm -rf "$OUT/dmg-staging"

MOUNT_DIR=$(hdiutil attach -readwrite -noverify -noautoopen "$OUT/pipi-rw.dmg" | awk '/\/Volumes\// {print substr($0, index($0, "/Volumes/"))}')
osascript <<EOF
tell application "Finder"
  tell disk "pipi"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 160, 860, 608}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 104
    set text size of viewOptions to 13
    set background picture of viewOptions to file ".background:background.tiff"
    set position of item "pipi.app" of container window to {162, 204}
    set position of item "Applications" of container window to {468, 206}
    close
    open
    update without registering applications
    delay 1
    close
  end tell
end tell
EOF
chflags hidden "$MOUNT_DIR/.background" 2>/dev/null || true
rm -rf "$MOUNT_DIR/.fseventsd" 2>/dev/null || true
sync
hdiutil detach "$MOUNT_DIR" -force
hdiutil convert "$OUT/pipi-rw.dmg" -format UDZO -imagekey zlib-level=9 -ov -o "$OUT/pipi.dmg"
rm -f "$OUT/pipi-rw.dmg"
codesign --force --sign "$IDENTITY" --timestamp "$OUT/pipi.dmg"

if [ -n "$NOTARY_PROFILE" ]; then
  # Stapling the .app does not re-sign it; the cdhash was already covered
  # by the DMG submission above.
  xcrun notarytool submit "$OUT/pipi.dmg" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUT/pipi.app"
  xcrun stapler staple "$OUT/pipi.dmg"
  xcrun stapler validate "$OUT/pipi.app"
  xcrun stapler validate "$OUT/pipi.dmg"
  spctl --assess -vv --type execute "$OUT/pipi.app"
  spctl --assess -vv --type install "$OUT/pipi.dmg"
  echo "-> $OUT/pipi.dmg (signed + notarized + stapled)"
else
  echo "-> $OUT/pipi.dmg (signed; not notarized — set PIPI_NOTARY_PROFILE to a notarytool keychain profile to notarize)"
fi
