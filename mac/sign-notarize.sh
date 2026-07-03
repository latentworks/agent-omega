#!/bin/sh
# Developer-ID sign + notarize + staple + .dmg for AgentOmega.app.
# Run AFTER build-app.sh, on a Mac with Xcode + a Developer ID Application certificate.
# This is the ONE step that needs an Apple Developer account ($99/yr).
#
# One-time: create a notarytool credential profile:
#   xcrun notarytool store-credentials ao-notary --apple-id you@example.com \
#          --team-id TEAMID --password <app-specific-password>
#
# Then:
#   DEV_ID="Developer ID Application: Your Name (TEAMID)" NOTARY_PROFILE="ao-notary" sh mac/sign-notarize.sh
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MAC="$REPO/mac"
APP="$MAC/build/AgentOmega.app"
ENT="$MAC/AgentOmega.entitlements"
DMG="$MAC/build/AgentOmega.dmg"
: "${DEV_ID:?set DEV_ID to your 'Developer ID Application: …' identity (see: security find-identity -v -p codesigning)}"
: "${NOTARY_PROFILE:?set NOTARY_PROFILE to a notarytool keychain profile}"
[ -d "$APP" ] || { echo "missing $APP — run build-app.sh first"; exit 1; }

echo "[1/6] sign inner Mach-O binaries (inside-out), hardened runtime + JIT entitlements"
for b in \
  "$APP/Contents/Resources/engine/opencode" \
  "$APP/Contents/Resources/sidecar" \
  "$APP/Contents/MacOS/AgentOmega"; do
  codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$DEV_ID" "$b"
done

echo "[2/6] sign nested Mach-O libs (hardened runtime + timestamp, NO app entitlements), then the outer .app + verify the seal"
find "$APP/Contents/Resources" -type f \( -name '*.node' -o -name '*.dylib' \) -exec codesign --force --timestamp --options runtime --sign "$DEV_ID" {} +
codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$DEV_ID" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "[3/6] notarize the .app (submit a zip + wait) and staple the ticket onto the .app"
rm -f "$APP.zip"
ditto -c -k --keepParent "$APP" "$APP.zip"
xcrun notarytool submit "$APP.zip" --keychain-profile "$NOTARY_PROFILE" --wait
rm -f "$APP.zip"
xcrun stapler staple "$APP"

echo "[4/6] build a .dmg from the now-stapled .app (drag-to-Applications)"
rm -f "$DMG"
STAGE="$(mktemp -d)"; cp -R "$APP" "$STAGE/AgentOmega.app"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Agent Omega" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

echo "[5/6] notarize (submit + wait) and staple the .dmg"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"

echo "[6/6] verify Gatekeeper acceptance"
if ! spctl -a -t exec -vv "$APP"; then echo "FAILED: Gatekeeper rejected $APP" >&2; exit 1; fi
xcrun stapler validate "$DMG"
echo "done -> $DMG  (signed, notarized, stapled — opens by double-click after download)"
