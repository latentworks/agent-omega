# Harness Experiments — Methods & Results

> ## ⚠️ FINDINGS INVALIDATED — confound discovered 2026-07-03 (kept up for transparency)
>
> **Every experiment below is confounded; its conclusions should not be relied on.** The runs did
> not control for the largest variable in the system prompt: the underlying **opencode engine
> silently injects its own ~1,400-word base system prompt** (*"You are opencode, an interactive
> CLI tool…"*) **ahead of** Agent Omega's `AGENTS.md`, in **every** condition — the "full harness"
> control *and* every "instructions stubbed", "gutted", "both stripped", and "reworded" ablation
> alike.
>
> Consequence: **no run ever executed without a complete coding-agent system prompt.** These tables
> measure the *marginal* effect of the Agent Omega layer stacked on top of opencode's prompt — not
> whether Agent Omega's harness is load-bearing (H2), not that it is a local optimum (the aggregate
> finding), and not the cross-model ordering, all of which assumed the ablated conditions were
> prompt-light. They were not. This also explains the live symptom that triggered the finding:
> models identified *as opencode* and behaved nearly the same with or without Agent Omega's prompt —
> opencode's base prompt was doing the work the entire time.
>
> **Fix:** on 2026-07-03 the engine was patched (`session/system.ts` → `provider()` returns `[]`) so
> it no longer emits opencode's base prompt; Agent Omega's `AGENTS.md` is now the sole system-prompt
> voice (verified: identity resolves to "Agent Omega", opencode base string absent from the assembled
> prompt, tool use intact). **Every experiment here must be re-run against that corrected baseline
> before any conclusion is trusted.** The original text is preserved below, unedited.

A scientific summary of the testing behind the shipped configuration (see [TUNES.md](TUNES.md)
for the practical guidance it produced). Roughly **3,000 scored task runs** across three models,
probing the harness from every direction it can be probed: adding to it, removing from it, and
rewriting it.

## Research question

Agent Omega's bet is that a well-designed harness lets small/cheap models do careful agentic
work. Two rival explanations exist for any fixed harness: it is **load-bearing** (the behaviors
collapse without it) or it is **stifling/dead weight** (the model was already capable and the
scaffolding just costs tokens). We tested both, plus the space between.

## Hypotheses

- **H1 (additive):** further curated or AI-generated harness edits can improve agentic behavior.
- **H2 (ablation):** removing harness components degrades agentic behavior (load-bearing), or
  does not (stifling).
- **H3 (form):** content-preserving rewrites of the harness change outcomes (form-sensitivity).
- **H4 (cost):** some edits reduce token cost without affecting quality.

## Method

**Task battery.** 16 tasks across 8 failure-mode categories (verification, root-cause debugging,
grounding/anti-hallucination, error recovery, decomposition, skill use, honesty, safety), each a
real miniature repository engineered to *provoke* its failure mode (e.g. planted files whose
contents contradict the obvious prior). The agent runs in the real engine with real tools.

**Scoring.** Deterministic oracles score each run 0–1 on a per-task ladder. Oracles inspect only
observed evidence: files round-tripped from disk and the tool-call ledger. The model's prose
claims never score. (The battery and oracles are kept private so future configurations cannot be
tuned to the test.)

**Statistics.** Every comparison is paired on identical tasks: per-task deltas, percentile
bootstrap + sign-flip permutation (2,000 iterations each, α=0.05, one-sided), N=2–4 repeats per
task per condition. Acceptance additionally required: a held-out task subset to move the same
direction (anti-overfit gate), no regression on safety tasks (hard floor), and survival of an
adversarial review by independent skeptic models prompted to refute the result. A token-cost
tie-breaker (H4) accepted quality-neutral changes only for a statistically significant ≥10%
cost reduction.

**Search procedure (H1).** A propose → test → keep-if-better loop: human-curated proposals
first, then frontier-model-generated proposals targeting the weakest categories, repeated until
the proposal space was exhausted (up to 4 generated batches per model).

**Models.** Qwen3-Coder-30B-A3B and Qwen3.6-35B-A3B (local, Q4 GGUF, consumer unified-memory
hardware) and deepseek-v4-flash (cloud). The 35B ran with thinking enabled — required for
agentic tool use on reasoning models (established in a controlled config comparison: the same
task went 0/4 → 4/4 on tool engagement purely by enabling thinking).

## Results

**H1 — rejected.** ~55 additive candidates across the three models (curated + generated):
**zero** produced a statistically significant improvement. Deltas clustered in ±0.1 with p ≥
0.26 throughout. An instrumented variant of the repair loop (injecting the exact failure output
into re-prompts) *regressed* (−0.078) and was reverted. The safety floor rejected 3 candidates
outright; the held-out gate rejected every candidate that passed the seen set.

**H2 — load-bearing, not stifling** (ablation, deepseek-v4-flash, paired, N=3):

| Condition | Quality | Δ vs full |
|---|---|---|
| Full harness (control) | 0.833 | — |
| Plugins disabled | 0.807 | −0.026 |
| Instructions stubbed | 0.745 | −0.089 |
| Both stripped | 0.750 | −0.083 |

No stripped condition improved on the control; the instruction file carries most of the value.
Individual drops do not reach significance at this N; the consistent ordering across independent
conditions is the evidential weight.

**H3 — form matters, and the shipped form won** (paraphrase test, same design):

| Condition | Quality | Δ vs full |
|---|---|---|
| Full harness (control) | 0.828 | — |
| Restructured (all rules kept, reworded) | 0.766 | −0.063 |
| Condensed (all rules kept, 79% length) | 0.781 | −0.047 |

A frontier model's faithful rewrite of the instructions underperformed the original. Notably,
instructed to halve the document without dropping rules, it could only reach 79% — the file is
not padded.

**H4 — no qualifying cost win.** Every additive candidate *increased* token cost (+5% to +63%);
the tie-breaker never fired. Instructions cost more tokens than they save.

**Cross-model.** On identical tasks: local 35B 0.844; deepseek-v4-flash 0.77–0.83 across four
baselines; local 30B 0.65–0.71 (early 30B runs were partially deflated by an infrastructure bug,
found and fixed mid-campaign — see Limitations). In the matched-conditions comparison the tuned
local 35B outscored the budget cloud tier; flash's later baselines narrow that margin, so the
ordering is well-supported and the exact margin is not.

**The aggregate finding:** across ~60 perturbations in three directions — add, remove, rewrite —
**not one scored above the control.** Random perturbations of a config on a slope would
sometimes land uphill; all-downhill-everywhere is the signature of a local optimum. The shipped
harness is at or near that optimum, in both content and form, for this model class.

## Limitations (honest, not fatal)

- **Statistical power.** N=2–4 per task per condition resolves effects of roughly ±0.1; small
  real effects (±0.05) would be invisible. The all-directions-downhill pattern mitigates but
  does not eliminate this.
- **Home-turf bias.** The battery was designed around the failure modes the harness targets, so
  it measures the harness on ground it was built for. An external benchmark (SWE-bench-class) is
  the natural independent check and has not yet been run for these configs.
- **Ablation/paraphrase ran on the cloud model only** (chosen for speed and cost); confirmation
  on the local flagship is pending. All findings that were tested across models transferred.
- **Persistent memory accumulates across runs** (the agent may recall prior answers). This is
  the shipped behavior and applies equally to all conditions of a paired comparison, but it adds
  a slow drift between campaigns and inflates repeat-run baselines slightly.
- **The token-cost measure** counts generated output and tool traffic, not the fixed instruction
  context — so the true cost of instruction files is understated in H4/H2 token columns.
- Single quantization per model; single harness lineage (a differently-designed harness could
  sit at a different optimum).

## Conclusion

For 30–35B-class local models and budget-tier cloud models, the shipped configuration behaves as
a measured local optimum: additions don't help, removals hurt, and rewrites of equal content
hurt. Its value concentrates in the operating instructions rather than the runtime plugins, and
its specific wording is part of the tune. Remaining upside for this class most plausibly lives
outside prompt-and-hook space (base model capability), which is where subsequent tunes look next.
