#!/bin/sh
# Assemble AgentOmega.app (UNSIGNED, self-contained) from the repo — run on macOS.
# Produces a bundle that needs NO system Node: the sidecar is bun-compiled into a standalone
# binary, the engine is already a standalone binary, and first-run provisioning (in the shell)
# installs the config + vault into the user's home. Signing/notarization is a separate step
# (mac/sign-notarize.sh) that needs an Apple Developer ID.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MAC="$REPO/mac"
APP="$MAC/build/AgentOmega.app"
ENGINE_BIN="$REPO/engine/opencode"
export PATH="$HOME/.bun/bin:$PATH"

command -v bun >/dev/null 2>&1 || { echo "bun not found on PATH — needed to compile the sidecar"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm not found on PATH — needed for plugin deps"; exit 1; }
[ -f "$ENGINE_BIN" ] || { echo "missing $ENGINE_BIN — build the engine first:"; echo "  bun run packages/opencode/script/build.ts --single --skip-embed-web-ui  (in the fork)"; exit 1; }

echo "[1/7] compile shell (Swift, min macOS 13 to match Info.plist + the engine)"
swiftc -target arm64-apple-macos13 "$MAC/AgentOmega.swift" -o "$MAC/AgentOmega" -framework AppKit -framework WebKit
# NOTE: this build is Apple Silicon (arm64) only. For Intel/universal, also build an x86_64
# engine (bun build --compile --target=bun-darwin-x64) + x86_64 shell/sidecar and lipo them.

echo "[2/7] compile sidecar (bun --compile — standalone, no Node runtime)"
bun build --compile "$REPO/sidecar.mjs" --outfile "$MAC/sidecar-bin" >/dev/null

echo "[3/7] install config-template plugin deps (so council/engram import at engine load)"
( cd "$REPO/config-template/opencode" && npm install --no-audit --no-fund --loglevel=error )

echo "[4/7] bundle skeleton"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$MAC/AgentOmega"  "$APP/Contents/MacOS/AgentOmega"
cp "$MAC/Info.plist"  "$APP/Contents/Info.plist"
cp "$MAC/sidecar-bin" "$APP/Contents/Resources/sidecar"; chmod +x "$APP/Contents/Resources/sidecar"

echo "[5/7] icon (ftp.ico -> AgentOmega.icns, best-effort)"
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

echo "[6/7] resources (ui, config-template incl node_modules, engine, secrets.sh)"
cp -R "$REPO/ui"              "$APP/Contents/Resources/ui"
cp -R "$REPO/config-template" "$APP/Contents/Resources/config-template"
cp    "$MAC/secrets.sh"       "$APP/Contents/Resources/secrets.sh"; chmod +x "$APP/Contents/Resources/secrets.sh"
mkdir -p "$APP/Contents/Resources/engine"
cp "$ENGINE_BIN" "$APP/Contents/Resources/engine/opencode"; chmod +x "$APP/Contents/Resources/engine/opencode"

echo "[7/7] arch check"
for b in "MacOS/AgentOmega" "Resources/sidecar" "Resources/engine/opencode"; do
  echo "  $b: $(lipo -archs "$APP/Contents/$b" 2>/dev/null || echo '?')"
done
echo "done -> $APP  ($(du -sh "$APP" | cut -f1))"
