#!/bin/sh
# Install Agent Omega on macOS by BUILDING it locally — no Apple Developer ID needed
# (a locally-built app isn't quarantined, so it opens without the Gatekeeper wall).
# For distributing to other people, use mac/sign-notarize.sh instead.
#
# Prerequisites (build-time only — the finished app needs none of these):
#   - Xcode Command Line Tools   (swiftc)         xcode-select --install
#   - bun                        (sidecar+engine) https://bun.sh
#   - node + npm                 (plugin deps)
#   - the engine binary already built at engine/opencode  (see docs/MAC_BRANCH.md, Phase 0)
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"

command -v swiftc >/dev/null 2>&1 || { echo "missing swiftc — run: xcode-select --install"; exit 1; }
[ -f "$REPO/engine/opencode" ] || { echo "missing engine/opencode — build it first (docs/MAC_BRANCH.md Phase 0)"; exit 1; }

echo "Building AgentOmega.app ..."
sh "$REPO/mac/build-app.sh"

APP="$REPO/mac/build/AgentOmega.app"
DEST="/Applications/AgentOmega.app"
echo "Installing to $DEST ..."
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo ""
echo "Done. Launch Agent Omega from /Applications (or: open '$DEST')."
echo "First run installs the config + vault into your home and shows how to add an API key."
