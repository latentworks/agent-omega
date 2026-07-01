#!/bin/sh
# Assemble AgentOmega.app (UNSIGNED) from the repo — run on macOS.
# Signing/notarization (Phase 5) is a separate step that needs an Apple Developer ID.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MAC="$REPO/mac"
APP="$MAC/build/AgentOmega.app"
ENGINE_BIN="$REPO/engine/opencode"

[ -f "$ENGINE_BIN" ] || { echo "missing $ENGINE_BIN — build the engine first"; exit 1; }

echo "[1/5] compile shell"
swiftc "$MAC/AgentOmega.swift" -o "$MAC/AgentOmega" -framework AppKit -framework WebKit

echo "[2/5] bundle skeleton"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$MAC/AgentOmega"  "$APP/Contents/MacOS/AgentOmega"
cp "$MAC/Info.plist"  "$APP/Contents/Info.plist"

echo "[3/5] icon (ftp.ico -> AgentOmega.icns, best-effort)"
TMP="$(mktemp -d)"
if sips -s format png "$REPO/ftp.ico" --out "$TMP/icon.png" >/dev/null 2>&1; then
  mkdir -p "$TMP/AgentOmega.iconset"
  for s in 16 32 64 128 256 512; do
    sips -z "$s" "$s" "$TMP/icon.png" --out "$TMP/AgentOmega.iconset/icon_${s}x${s}.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$TMP/AgentOmega.iconset" -o "$APP/Contents/Resources/AgentOmega.icns" 2>/dev/null \
    || sips -s format icns "$TMP/icon.png" --out "$APP/Contents/Resources/AgentOmega.icns" >/dev/null 2>&1 || true
fi
rm -rf "$TMP"

echo "[4/5] resources (ui, sidecar, node_modules, config-template, engine)"
cp -R "$REPO/ui"              "$APP/Contents/Resources/ui"
cp    "$REPO/sidecar.mjs"     "$APP/Contents/Resources/sidecar.mjs"
cp -R "$REPO/node_modules"    "$APP/Contents/Resources/node_modules"
cp -R "$REPO/config-template" "$APP/Contents/Resources/config-template"
mkdir -p "$APP/Contents/Resources/engine"
cp "$ENGINE_BIN" "$APP/Contents/Resources/engine/opencode"
chmod +x "$APP/Contents/Resources/engine/opencode"

echo "[5/5] done -> $APP"
du -sh "$APP"
