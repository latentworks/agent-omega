---
description: List every active slash command, its description, skill wiring, and any problems
---
Run this exact command with your bash tool, then show its stdout to the user VERBATIM — do not summarize, re-format, or omit lines:

node "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/commands-list.mjs"

If the command errors, show the exact error output instead and say the diagnostics script is missing or broken.
