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

./scripts/make-dmg.sh "$OUT/pipi.app" "$OUT/pipi.dmg"
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
