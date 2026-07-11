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

This is an optional paid/API end-to-end suite, not a release gate. The v2.6 release
record lists the exact checks that were run and the surfaces that remain unverified:
[`docs/releases/v2.6.2.md`](../docs/releases/v2.6.2.md).

## v2.6 lifecycle and router logic checks

These focused tests use fakes and injected fetches; they do not require a paid
provider, a running local model, or a desktop window:

```bash
node --test test/logic/task-quality-lifecycle.test.mjs test/logic/task-quality-plugin.test.mjs test/logic/router.test.mjs test/logic/router-config.test.mjs
```

They cover the engine-facing task-quality contract: one structured terminal
review submission; required read-only workspace evidence for completed-artifact
review; rejection of contradictory `pass` results that contain findings; exact
plan-generation approval from an external user; the settled
`awaiting-artifact-review` boundary; durable execution
receipts with no unresolved execution before artifact review; transform-resolved
task-agent and built-in child-read provenance; and firewalls between plan text,
artifact text, receipts, and builder context. The router checks bind
classification to the active local model, require an explicit local fallback for
cloud-led turns, scope failure cooldowns to the classifier endpoint/model/provider
instead of globally poisoning other routes, and exclude internal subagent messages.

## v2.6.1 final Windows live evidence

The final packaged engine exercised in the Windows app was
`0.0.0-omega-task-quality-202607111649`, SHA-256
`4a1c01e4c3192fb7aaac924e1aeccf9190936ad35a092e22fc9260b618eb3799`.
Earlier local-model runs on the same engine path produced one direct final-agent task receipt, one
attested child read, and zero pending execution. HSS and same-model CRAP both
reached the isolated artifact path. The final local CRAP reviewer returned an
incomplete structured result and the lifecycle closed as
`artifact-review-failed`; HSS also rejected observed extra-tool and
missing-artifact cases. Those are verified fail-closed outcomes, not positive
terminal artifact authorization. The final exact-message handoff and unsettled
scope-revocation hardening was verified through deterministic full hook-order
tests rather than another local-model load. See the release record for the
remaining verification gaps.

Also: `mac/AgentOmega.swift` has `AO_MENU_SELFTEST=1` — launches the real app, audits the AppKit
main menu, and drives Cmd+C copy through the responder chain into the WKWebView (the layer
Playwright can't reach). Prints `MENU_*` lines and exits.
