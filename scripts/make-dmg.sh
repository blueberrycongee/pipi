#!/bin/sh
# Build the styled pipi.dmg around an already-signed .app: staging folder with
# the brand background and an Applications symlink, Finder window layout on a
# read-write image, then a compressed read-only UDZO. Signing, notarization
# and stapling are the caller's job.
#
#   scripts/make-dmg.sh <path/to.app> <output.dmg>
set -e

APP="$1"
DMG="$2"
case "$APP" in /*) ;; *) APP="$PWD/$APP";; esac
case "$DMG" in /*) ;; *) DMG="$PWD/$DMG";; esac
cd "$(dirname "$0")/.."
OUT=.nsh/out
RW_DMG="$OUT/pipi-rw.dmg"

if [ ! -d "$APP" ]; then
  echo "make-dmg: no such app bundle: $APP" >&2
  exit 1
fi

if [ ! -f assets/brand/dmg-background.png ] || [ ! -f assets/brand/dmg-background@2x.png ]; then
  node scripts/render-brand.mjs
fi

# Unmount any stale /Volumes/pipi before building a new DMG.
if [ -d /Volumes/pipi ]; then
  hdiutil detach /Volumes/pipi -force >/dev/null 2>&1 || true
fi

rm -rf "$OUT/dmg-staging" "$RW_DMG" "$DMG"
mkdir -p "$OUT/dmg-staging/.background"
cp -R "$APP" "$OUT/dmg-staging/"
ln -s /Applications "$OUT/dmg-staging/Applications"
tiffutil -cathidpicheck assets/brand/dmg-background.png assets/brand/dmg-background@2x.png \
  -out "$OUT/dmg-staging/.background/background.tiff" >/dev/null

hdiutil create -volname pipi -srcfolder "$OUT/dmg-staging" -ov -format UDRW "$RW_DMG"
rm -rf "$OUT/dmg-staging"

MOUNT_DIR=$(hdiutil attach -readwrite -noverify -noautoopen "$RW_DMG" | awk '/\/Volumes\// {print substr($0, index($0, "/Volumes/"))}')
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
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -ov -o "$DMG"
rm -f "$RW_DMG"
