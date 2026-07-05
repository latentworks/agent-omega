---
description: List the config-defined slash commands (command/*.md) with descriptions, skill wiring, and any problems
---
Run this exact command with your bash tool, then show its stdout to the user VERBATIM — do not summarize, re-format, or omit lines:

node "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/commands-list.mjs"

If the command errors, show the exact error output instead and say the diagnostics script is missing or broken.

The script lists only the commands defined by files in `command/` — it is NOT the whole set. The engine also serves built-ins (`/init`, `/review`, `/customize-opencode`) and derives one slash command per installed skill (e.g. `/brainstorming`, `/verify`, `/orchestration`, `/writing-plans`). After showing the verbatim output, add one line telling the user those built-in and per-skill commands also exist, so they don't think the list is exhaustive.
