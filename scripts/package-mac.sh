#!/bin/sh
# Package pipi.app, sign it with a Developer ID identity (or ad hoc when none
# is configured), wrap it in a styled DMG, and optionally notarize and staple
# both the .app inside the DMG and the .dmg itself.
set -e
cd "$(dirname "$0")/.."

OUT=.nsh/out
IDENTITY="${PIPI_RELEASE_SIGN_ID:-${PIPI_SIGN_ID:-}}"
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | awk '/Developer ID Application:/ { print $2; exit }')
fi
NOTARY_PROFILE="${PIPI_NOTARY_PROFILE:-${APPLE_NOTARY_PROFILE:-}}"

nsh package --target macos

if [ -n "$IDENTITY" ]; then
  codesign --force --deep --sign "$IDENTITY" --options runtime --timestamp "$OUT/pipi.app"
  codesign --verify --deep --strict "$OUT/pipi.app"
else
  echo "package-mac: no Developer ID identity found; keeping ad hoc signature" >&2
fi

if [ -n "$IDENTITY" ] && [ -n "$NOTARY_PROFILE" ]; then
  ditto -c -k --sequesterRsrc --keepParent "$OUT/pipi.app" "$OUT/pipi-app.zip"
  xcrun notarytool submit "$OUT/pipi-app.zip" --keychain-profile "$NOTARY_PROFILE" --wait
  rm -f "$OUT/pipi-app.zip"
  xcrun stapler staple "$OUT/pipi.app"
  xcrun stapler validate "$OUT/pipi.app"
fi

./scripts/make-dmg.sh "$OUT/pipi.app" "$OUT/pipi.dmg"

if [ -n "$IDENTITY" ]; then
  codesign --force --sign "$IDENTITY" --timestamp "$OUT/pipi.dmg"
fi

if [ -n "$IDENTITY" ] && [ -n "$NOTARY_PROFILE" ]; then
  xcrun notarytool submit "$OUT/pipi.dmg" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUT/pipi.dmg"
  xcrun stapler validate "$OUT/pipi.dmg"
  spctl --assess -vv --type execute "$OUT/pipi.app"
  spctl --assess -vv --type install "$OUT/pipi.dmg"
  echo "-> $OUT/pipi.dmg (signed + notarized + stapled)"
elif [ -n "$IDENTITY" ]; then
  echo "-> $OUT/pipi.dmg (signed; set PIPI_NOTARY_PROFILE or APPLE_NOTARY_PROFILE to notarize)"
else
  echo "-> $OUT/pipi.dmg (ad hoc signed)"
fi
