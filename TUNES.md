# Model Tunes

Agent Omega's default configuration (the operating instructions, skills, and behavior plugins in
`config-template/opencode/`) is not guesswork — it is **tuned per model class and benchmarked to
back it up**. Each tune states which local models it targets, how to serve them, and the evidence
standard it passed. Pick the tune that matches the model you run.

> The full test battery and scoring oracles are kept private on purpose: publishing them would let
> future configs "teach to the test." What we publish is the method, the rigor, and the results.

---

## 30–35B tune — current default (v1, 2026-07)

**Target models (GGUF, Unsloth Dynamic quants recommended):**

| Model | Class | Quant tested | Notes |
|---|---|---|---|
| Qwen3-Coder-30B-A3B-Instruct | coder (MoE, 3B active) | UD-Q4_K_XL | agentic out of the box |
| Qwen3.6-35B-A3B | general + reasoning (MoE, 3B active) | UD-Q4_K_XL | **requires thinking ON** (below) |

Both are ~19–23 GB at Q4 — comfortable on 32 GB-class unified-memory machines or a 24 GB+ GPU
with room for KV cache.

**Serving (llama.cpp / llama-server):**

```
llama-server --jinja -fa on -ngl 999 -c 65536 -m <model>.gguf
# reasoning models (Qwen3.6 family) additionally need:
#   --reasoning-format deepseek
```

**The finding that matters most — thinking mode is not a taste setting:**

- **Reasoning models (Qwen3.6-35B): keep thinking ON for agentic work.** With thinking disabled
  the model answers in chat and *skips the agentic loop entirely* — no file reads, no tool calls,
  no artifacts written. In our battery the same task went from a hard fail (0/4, zero tool calls)
  to a clean pass (tools used, artifact written) purely by re-enabling thinking. Budget for it:
  thinking costs latency and tokens; that is the price of a small model doing diligent work.
- **Coder models (Qwen3-Coder-30B): no thinking needed.** They are trained agentic and go
  straight to tools.

**If you serve multiple models from one server** (llama-swap or similar): pin the agent's model so
other traffic cannot evict it mid-task. A model swap during an agent turn looks like a mysterious
timeout. In llama-swap terms: put the agent models in a group with `swap: false`,
`exclusive: false`, `persistent: true`.

**Evidence behind this tune:**

- Behavior battery across **8 failure-mode categories** (verification, root-cause debugging,
  grounding/anti-hallucination, error recovery, task decomposition, skill use, honesty, safety),
  every task scored by deterministic oracles bound to the observed tool-call ledger — never by
  the model's own claims.
- **Paired statistics** (bootstrap + permutation, p<0.05), repeated runs (N=3), a **held-out task
  gate** against overfitting, and adversarial review of any candidate improvement before
  acceptance. A hard safety floor rejects any change that regresses safety tasks.
- Result: the shipped configuration scored **0.844 / 1.0** on the 35B (thinking on). **Over 30
  enhancement candidates** — human-curated and frontier-model-generated, tested across both model
  sizes on this rig — produced **zero statistically significant improvements**; several regressed.
  Attempts to strengthen the repair hooks beyond the shipped design *lowered* scores.
- Conclusion: for the 30–35B class, this configuration measures at or near the ceiling of what
  prompt- and hook-level tuning can deliver. It ships as-is, as the tuned default.

---

## DeepSeek-class, budget tier — validated: the default tune transfers (2026-07)

The same battery and improvement loop were run against **deepseek-v4-flash** (the cheapest
DeepSeek tier) as the first cloud class. Outcome:

- **24 further enhancement candidates** (curated + frontier-generated) — **zero** beat the
  default configuration on quality; the safety floor caught and blocked one regression.
- A **token-cost tie-breaker** was live for this run (a change that keeps quality statistically
  flat but cuts total tokens ≥10% counts as a win): no candidate qualified — every added
  instruction *increased* token spend more than it saved.
- Cross-class scoreboard on identical tasks: **the tuned local 35B (0.844) outscored
  deepseek-v4-flash (0.781)** — the local tune beats the budget frontier tier outright.
- Conclusion: use the default tune unchanged with DeepSeek-class budget models. No
  class-specific configuration earned its way in.

---

## Roadmap

- **Larger-model tunes are next** (DeepSeek pro tier and other 70B+ / large-MoE models). Thinking
  policy, tool-call templates, and token budgets all shift at that scale — each tune will ship
  with the same evidence standard before it earns a name here.
- Tunes are additive: the goal is a small menu where you pick your model class and get a
  configuration that has already been fought over so you don't have to.
