#!/bin/sh
# Launch Agent Omega on macOS from the terminal — the analog of running agent-omega.exe on
# Windows. Builds the self-contained .app once (if needed), then launches it. No signing or
# notarization is required: a locally-built app carries no quarantine flag, so macOS runs it
# like any other program you built yourself.
#
# Usage:  sh mac/run.sh            (build if needed, then launch)
#         sh mac/run.sh --rebuild  (force a rebuild first)
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$REPO/mac/build/AgentOmega.app"

case "${1:-}" in --rebuild) rm -rf "$APP" ;; esac
[ -d "$APP" ] || sh "$REPO/mac/build-app.sh"

echo "Launching Agent Omega ..."
open "$APP"
echo "First run installs the config + Keychain vault into your home and shows how to add a model."
