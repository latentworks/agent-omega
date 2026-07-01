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

echo "[1/5] sign inner Mach-O binaries (inside-out), hardened runtime + JIT entitlements"
for b in \
  "$APP/Contents/Resources/engine/opencode" \
  "$APP/Contents/Resources/sidecar" \
  "$APP/Contents/MacOS/AgentOmega"; do
  codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$DEV_ID" "$b"
done

echo "[2/5] sign the outer .app + verify the seal"
codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$DEV_ID" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "[3/5] build a .dmg (drag-to-Applications)"
rm -f "$DMG"
STAGE="$(mktemp -d)"; cp -R "$APP" "$STAGE/AgentOmega.app"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Agent Omega" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

echo "[4/5] notarize (submit + wait) and staple both .app and .dmg"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler staple "$DMG"

echo "[5/5] verify Gatekeeper acceptance"
spctl -a -t exec -vv "$APP" || true
xcrun stapler validate "$DMG"
echo "done -> $DMG  (signed, notarized, stapled — opens by double-click after download)"
