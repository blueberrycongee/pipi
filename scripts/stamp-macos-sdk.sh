#!/bin/sh
# Restamp the packaged app's linked SDK (`LC_BUILD_VERSION`'s `sdk`): the
# marker macOS reads to pick a window's chrome generation. A binary linked
# against a pre-26 SDK keeps the legacy traffic lights even on macOS 27;
# linked for 26 or later it draws the Liquid Glass ones. The nsh runtime is
# stamped for an older SDK, so lift every architecture to
# $PIPI_MACOS_SDK_STAMP (default 27.0) between `nsh package` and signing.
# The rewrite voids the signature, so the app is re-signed ad hoc here and
# the caller's own signing overwrites it.
set -e
cd "$(dirname "$0")/.."

APP="${1:-.nsh/out/pipi.app}"
TARGET="${PIPI_MACOS_SDK_STAMP:-27.0}"
EXE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
BIN="$APP/Contents/MacOS/$EXE"

archs=$(lipo -archs "$BIN" 2>/dev/null || true)
[ -n "$archs" ] || archs=$(uname -m)

work=$(mktemp -d -t pipi-sdk-stamp)
trap 'rm -rf "$work"' EXIT
changed=0
slices=""
for arch in $archs; do
  if [ "$(printf '%s' "$archs" | wc -w)" -gt 1 ]; then
    vtool -arch "$arch" -show-build-version "$BIN" >"$work/$arch.info"
    slice="$work/$arch.bin"
  else
    vtool -show-build-version "$BIN" >"$work/$arch.info"
    slice="$work/$arch.bin"
  fi
  sdk=$(awk '$1 == "sdk" { print $2; exit }' "$work/$arch.info")
  minos=$(awk '$1 == "minos" { print $2; exit }' "$work/$arch.info")
  ldver=$(awk '$1 == "tool" && $2 == "LD" { getline; if ($1 == "version") { print $2; exit } }' "$work/$arch.info")
  if [ -n "$sdk" ] && [ "${sdk%%.*}" -ge "${TARGET%%.*}" ] 2>/dev/null; then
    echo "stamp-macos-sdk: $arch already linked for sdk $sdk"
    if [ "$(printf '%s' "$archs" | wc -w)" -gt 1 ]; then
      lipo -thin "$arch" -output "$slice" "$BIN"
    else
      cp "$BIN" "$slice"
    fi
  else
    echo "stamp-macos-sdk: $arch sdk ${sdk:-unknown} -> $TARGET (minos ${minos:-11.0})"
    if [ "$(printf '%s' "$archs" | wc -w)" -gt 1 ]; then
      vtool -arch "$arch" -set-build-version macos "${minos:-11.0}" "$TARGET" \
        ${ldver:+-tool ld "$ldver"} -output "$slice" "$BIN"
    else
      vtool -set-build-version macos "${minos:-11.0}" "$TARGET" \
        ${ldver:+-tool ld "$ldver"} -output "$slice" "$BIN"
    fi
    changed=1
  fi
  slices="$slices $slice"
done

if [ "$changed" = 0 ]; then
  exit 0
fi
# shellcheck disable=SC2086
lipo -create $slices -output "$BIN" 2>/dev/null || cp $slices "$BIN"
codesign --force --sign - "$APP"
echo "stamp-macos-sdk: re-signed ad hoc (the signing steps overwrite it)"
