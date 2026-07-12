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

## v2.7.2 candidate evidence

`npm test` passed 179/179 on the v2.7.2 candidate. The paired engine full
typecheck passed, and its focused terminal processor, loader attestation, and
direct-dispatch suites passed 22/22. Those deterministic checks prove the
held-terminal contract: ordinary plugins cannot receive terminal evidence;
raw approval-bound text never persists or streams before the loader-attested
lifecycle hook explicitly releases a safe replacement; and a missing release
fails closed as fixed lifecycle feedback. A fresh Windows Release output
contained exactly one bundled engine executable and no ignored local backups.
The optional paid suite above and the retained Qwen3.6-35B campaign remain
required before claiming live desktop or live-model proof.

## v2.6 lifecycle and router logic checks

These focused tests use fakes and injected fetches; they do not require a paid
provider, a running local model, or a desktop window:

```bash
node --test test/logic/task-quality-lifecycle.test.mjs test/logic/task-quality-plugin.test.mjs test/logic/task-quality-compat.test.mjs test/logic/task-quality-reviewer.test.mjs test/logic/sidecar-session-protocol.test.mjs test/logic/router.test.mjs test/logic/router-config.test.mjs
```

They cover the engine-facing task-quality contract: structured HSS submission;
bounded verbatim Unicode CRAP reports with exact digest binding; rejection of
empty, oversized, malformed, or mismatched reports; idempotent durable delivery
by review identity with no model-authored receipt; causal repair at the next
checkpoint; artifact closure only after a new post-delivery receipt; required
read-only workspace evidence for structured completed-artifact review;
rejection of contradictory `pass` results that contain findings; exact
plan-generation approval from an external user; the settled
`awaiting-artifact-review` boundary; durable execution
receipts with no unresolved execution before artifact review; transform-resolved
task-agent and built-in child-read provenance; and firewalls between plan text,
artifact text, receipts, and builder context. They also cover the engine-owned
terminal hook: an ordinary stopped plan is durable before the exact routed
parent may enter plan review, while an approval-bound final candidate is held
out of the transcript until review selects safe text; only a settled receipt
can close artifact review. Protocol negotiation fails closed
unless protocol 2 and all ten task-quality features are present. The router checks bind
classification to the active local model, require an explicit local fallback for
cloud-led turns, scope failure cooldowns to the classifier endpoint/model/provider
instead of globally poisoning other routes, and exclude internal subagent messages.

## Protocol 2 Windows pre-release evidence

The final Windows development engine used for protocol 2 verification was
`0.0.0-omega-202607112023`, SHA-256
`8aafd5439a3794302c31d94c2dca89575f8d3d00c40fa248ee3b4c3e5b953b43`.
With all helpers disabled, one local Qwen3-Coder 30B model acted as both the
context-bearing builder and the context-free CRAP reviewer for 20 sequential
randomized plan lifecycles. All 20 reached `awaiting-approval` with exactly one
durable review turn, preserved both randomized facts in the report and repaired
plan, repaired the deliberately ambiguous overflow behavior, bound the delivery
message to the engine review identity and digest, and ended with zero pending
executions. The minimum observed free RAM was 16.5 GiB. This proves the
same-model plan-review handoff on that Windows/local-model path; it does not by
itself claim protocol 2 artifact, HSS, cloud-provider, macOS, or Linux live proof.

For the same source state, `npm test` passed 167/167. The engine and plugin
typechecks passed; focused engine reviewer/message-write/SDK tests passed 34/34,
and global protocol/identity tests passed 4/4.

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
