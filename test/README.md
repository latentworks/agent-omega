# UI test suite

`ui-suite.mjs` drives the **real** `ui/app.html` in a headless browser against a **real**
sidecar + engine over WebSocket, exercising the app as a user would: boot, real model turns,
command palette, every slash command, settings + all tabs, vault, model/effort/skin switching,
sessions workflows, `@`/`/` autocomplete, keyboard handling (Enter/Shift-Enter/Esc/shell-mode),
mid-turn abort, and the **permission flow with a canary** (asks the model to `rm -rf` a seeded
dir, Rejects at the panel, asserts the dir survives).

## Run

```bash
npm i -D playwright && npx playwright install chromium   # once
AO_REPO=$PWD node test/ui-suite.mjs
```

Needs a working engine at `engine/opencode` and cloud keys in the vault (uses deepseek by
default; the permission stage switches to deepseek-v4-pro, which reliably tool-calls). Real API
calls cost a few cents per run — it is NOT wired into CI for that reason. `AO_WS_PORT` overrides
the port; `AO_MODEL` the default model.

Also: `mac/AgentOmega.swift` has `AO_MENU_SELFTEST=1` — launches the real app, audits the AppKit
main menu, and drives Cmd+C copy through the responder chain into the WKWebView (the layer
Playwright can't reach). Prints `MENU_*` lines and exits.
