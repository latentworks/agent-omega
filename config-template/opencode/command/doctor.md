---
description: Read-only health check — config, plugins, skills, commands, providers, local models, permissions, memory
---
Run this exact command with your bash tool, then show its stdout to the user VERBATIM — do not summarize, re-format, or omit lines:

node "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/doctor.mjs"

If the command errors, show the exact error output instead and say the diagnostics script is missing or broken. Do not attempt to fix anything it reports unless the user asks.
