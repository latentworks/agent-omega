# Self-Review & Task-Quality — Testing Methods & Results

A scientific record of a second, multi-day testing campaign, separate from the
harness-prompt tuning in **[EXPERIMENTS.md](EXPERIMENTS.md)**. That one asked whether the
*instructions* around a small model are load-bearing. This one asks a sharper, riskier
question about the **task-quality lifecycle** — the part of Agent Omega that has the model
review and improve its own code before that code is allowed to ship:

> When a local model checks its own work, can we guarantee it never ships something **worse**
> than its first attempt — and can we make it ship something **better**?

The honest starting point was uncomfortable: naively asking the model to self-review made
its output **worse about one time in five**. This document is the record of driving that
number down and understanding exactly why it moves. It is kept in the same spirit as the rest
of the repo — the methods matter more than the headline, the limitations are stated plainly,
and nothing is claimed that wasn't observed.

---

## Why self-review is hard (the core problem)

The reviewer is the **same model** as the author. It shares the author's blind spots. When a
small model is wrong on an edge case, it is often *confidently* wrong — and if you sample it
several times, every sample tends to agree on the **same** wrong answer. So the intuitive fix
("have the model double-check itself") can quietly make things worse: the second opinion is
drawn from the same flawed well as the first, and a bad "improvement" overwrites a good draft.

Early cross-model testing confirmed this is structural, not one model's quirk: the same
**silent wrong-consensus** wall reproduced across multiple model families. Any honest
self-review system has to be built to survive it.

We model the failures as two populations:

- **Splittable.** The drafts *disagree* on the hard input. A right answer exists somewhere in
  the pool — the job is to find it (by agreement or by reasoning).
- **Consistent-but-wrong.** Every draft shares the same blind spot and agrees on the wrong
  answer. No amount of voting helps; only an independent reasoning audit has any chance.

Different levers attack different populations. Knowing which population a failure belongs to is
half the work.

---

## The measurement discipline

The results are only as trustworthy as the way they were measured. Six rules governed every
run.

### 1. Behavior, not plumbing — code is executed, prose is ignored
Every judgment comes from **executing** the generated code on held-out inputs and comparing
its actual output to a reference. The model's explanation of its own work is never scored. A
module that fails to even load counts as wrong on every input — an un-runnable answer ships
broken. "It compiled," "exit 0," and "looks right" are never accepted as evidence.

### 2. References are independently verified before they are trusted
A measurement is worthless if the answer key is wrong. Each task's reference implementation is
checked against **hand-computed expectations** *and* a second independent oracle before it is
used. (Concrete example: the leap-year date validator's reference was cross-checked against the
language's own date library for every February-29 case — 1900 and 2100 are *not* leap years,
2000 *is* — so a subtle century-rule bug in the answer key could not silently corrupt the
whole run.)

### 3. The paired 2×2 — the only question that matters
The naive metric ("how often is the reviewed answer correct?") can look great while hiding
regressions on specific tasks. So every trial compares the shipped artifact against the **exact
raw draft it would have replaced**, on the **same** held-out inputs, and sorts the outcome into
four cells:

|                         | raw draft **right** | raw draft **wrong** |
|-------------------------|---------------------|---------------------|
| reviewed answer **right** | both-ok           | **rescue** (better) |
| reviewed answer **wrong** | **regression** (worse) | both-wrong    |

The safety property — call it **Gate-1** — is simply: **the regression cell must stay empty.**
The reviewed answer may never be wrong where the raw answer was right. The headline is the
regression rate, not the accuracy rate.

### 4. The never-probed partition — no teaching to the test
The system generates its own test probes **blindly from the specification**; it never sees the
grading inputs. To measure *honest generalization*, the headline numbers are reported only on
the partition of grading inputs that the mechanism **never generated as a probe** — i.e. inputs
it never got a chance to optimize against. An improvement that only shows up on inputs the
system already tested itself on is discarded as overfitting.

### 5. Adversarial verification — reviewers try to break it, with evidence
Risky changes and claimed results were checked by **independent frontier-model reviewers
prompted to refute**, not to agree. Each finding had to cite file-and-line evidence or it was
dropped — no hallucinated gaps. High-stakes claims went to a multi-reviewer panel under
majority rule. Frontier models were used **only** to read code and adjudicate; they were never
the system under test, which was always the local model.

### 6. Independent audit of the automated grading
On top of the deterministic execution grader, a **separate frontier judge** independently
adjudicated samples of the verdicts, as a check that the automated scoring agreed with a second,
unrelated method.

---

## The scale of the campaign

This ran as a continuous propose → measure → verify → keep-or-kill loop over several days.

- **50+ tracked experiments, levers, and fixes**, each with an explicit acceptance check.
- **Over a dozen numbered measurement waves** (internally r6 through r14), plus dedicated
  single-lever campaigns.
- **Levers built and measured end-to-end**, among them: an immutable-path guard, reviewer
  **diversity**, grounded **execution review**, review-route observability, a bounded
  artifact-**repair** loop, and several lifecycle-recovery fixes that make the review machinery
  fail safe instead of dead-locking.
- **Every persisted result was round-tripped** (write → read back → assert), and **every risky
  or claimed-done change was adversarially reviewed** before it was believed.

(For the parallel harness-tuning campaign — roughly 3,000 scored task runs across three models
— see **[EXPERIMENTS.md](EXPERIMENTS.md)**.)

---

## What the levers did

### Diversity — raise the ceiling by making the drafts explore differently
Instead of sampling one prompt several times (which tends to reproduce the same blind spot),
each draft is given a **distinct failure-mode focus** — one hunts boundary values, one hunts
format and structure violations, one enumerates every rule the spec implies, one validates by
reconstructing the canonical form, one thinks like an adversarial tester. The first draft is
left **plain** — it *is* the raw baseline — and it stays in the selection pool, so a correct raw
answer can never be removed from contention.

Effect on a genuinely hard, splittable task (Roman-numeral parsing with all the illegal-repeat,
illegal-subtraction, and range edges): the "beats raw" rate rose from ~0 to a **meaningful
minority** of trials, while the regression cell stayed **empty**.

This was then **confirmed on a second, independently-chosen hard task** — Semantic-Versioning
2.0.0 validation, which a much earlier round of testing had already flagged as a weak spot (the
no-leading-zeros-on-numeric-identifiers rule, the pre-release-vs-build-metadata boundary, the
strict identifier charset). Its answer key was verified against the *official* SemVer regular
expression plus a few hundred generated cases before a single model call was made. On this task
the raw single-shot draft was wrong about **half** the time; the reviewed answer was wrong about
**one time in twelve**, and — the number that matters — it was **never once worse than the raw
draft it replaced** (regression cell empty across every trial). One trial was a textbook *ceiling*
case: all of the diverse drafts happened to share the same blind spot, so there was no better
answer on the machine to find; the system correctly declined to "improve" and shipped the raw
answer unchanged. That two unrelated hard tasks — one hand-built, one chosen because it was a
known weak spot — give the **same** shape (beats raw a third-to-half of the time, regresses
never) is the strongest evidence here that the effect is real and not a quirk of one problem.

### Coverage — rank the right draft above the raw one
More adversarial test probes give the selector more discriminating inputs, so it more often
ranks a correct draft above the plain raw draft. Crucially, any dispute the model **cannot**
resolve is converted into a **bound**, not a guess — an unresolved dispute can only *reduce* the
benefit, never cause a regression. Doubling probe coverage lifted the beat-rate further, still
with **zero regressions** on the honest never-probed partition.

### Repair — a negative result, reported honestly
The plan was: when no draft is right, synthesize a corrected one. In practice this lever proved
**structurally starved**. It can only trigger when the system *detects* that its best draft is
wrong — and detecting that requires the model to have *reasoned out* the correct answer to hold
the draft against. On the hardest cases the model cannot do that (it is exactly as stumped as
its drafts), so the trigger never fired. Across every trial in two clean campaigns, repair was
attempted **zero** times. The bottleneck is not repair *generation* — it is the model's ability
to adjudicate its own hardest cases. We report this because a null result that explains *why* is
worth more than a lever that looks busy.

---

## Headline findings

- **Gate-1 held.** Across every clean trial — on **two** independent hard tasks and two easy ones
  — the reviewed answer was **never wrong where the raw answer was right**: zero regressions on the
  honest, never-probed partition. On a task the model already handles perfectly, the system
  correctly does no harm; on a hard task, it never makes things worse.
- **It genuinely beats raw on hard tasks** — a meaningful fraction of the time (roughly a
  **quarter to a half**), by finding a correct answer that the plain single-shot draft missed. This
  now holds on **two unrelated hard tasks**: the hand-built Roman-numeral parser and, independently,
  SemVer validation — a task singled out as a weak spot by earlier, separate testing. Same
  direction, same empty regression cell, comparable beat-rate on both.
- **The ceiling is honest and worth stating plainly.** The system beats the raw model **only
  where the local model can determine truth** — by agreement among diverse drafts, or by
  reasoning a dispute to a confident answer. On *uniformly-confused* cases — where the drafts
  disagree **and** the model cannot reason out which is right — there is simply no better answer
  available on the machine to ship, so the system safely **falls back to the raw answer**.
  Beating the raw model the large majority of the time is **not reachable with local-only
  tools**; that would require an adjudicator stronger than the model itself.

The practical upshot: the original "worse one time in five" problem is solved — the shipped
behavior is *never worse than raw, and better when it can be* — but the harder stretch goal of
"better almost always" runs into a real capability wall, not a tuning problem.

---

## A worked example of the discipline (a run we threw away)

One large measurement run was **discarded**, and how it was caught is a good illustration of the
"behavior, not plumbing" rule.

Chasing more coverage, a run was configured with far too many simultaneous probe-generation
calls. On a single local model that serves one request lane, this **flooded the server**: draft
generation timed out, and the number of drafts actually produced collapsed (in one trial, to a
single draft — not enough to review anything). The process still exited cleanly with code 0.

Nothing in the exit status revealed the problem. It was caught only by reading the **per-trial
output**: generation time pinned against a timeout ceiling, draft counts far below what was
requested. The run had measured a jammed pipe, not the lever. It was thrown out and re-run with
the request volume throttled to what the hardware can actually serve. A green exit code is not a
result.

---

## Limitations (honest, not fatal)

- **Small N per task.** The self-review campaigns use a handful of repeats per condition; they
  resolve direction and the paired cells reliably, but the *exact* beat-rate is noisy. Read the
  regression cell (which is robustly empty) and the direction, not the second decimal.
- **A small task set, and finding hard-enough tasks is itself hard.** Of four hand-built tasks,
  **two turned out too easy** — the local model simply gets an IP-address validator and a
  calendar-date validator right every time, so they produce no beat-rate signal (only a useful
  confirmation that the safety property does no harm). Only **two** landed in the band where
  self-review can actually add value. That band is real but **narrow**: it is the set of problems
  the model is *competent at but trips on the edges of*. Below it, the model is simply right and
  the system correctly does nothing; above it (problems the model cannot resolve at all), the drafts
  are uniformly confused and the system safely falls back to the raw answer. **The safety property
  holds across the whole spectrum; the upside only appears in the narrow middle band** — and, as the
  easy tasks showed, that band is harder to hit than one might expect, because this model is more
  capable than assumed on ordinary validators. Broadening the set of genuinely-hard tasks is the
  natural next step, and is itself non-trivial.
- **The battery and references are kept private** so future configurations cannot be tuned to
  the test — the same precaution taken with the harness-tuning battery.
- **The ceiling result is a property of local-only operation.** It says what a model can and
  cannot do when it must judge itself with no stronger help; it is not a claim about what is
  possible with an external adjudicator.

---

## From bench to production — wiring it into the engine

The measurement campaign above proves the **lever**: given the code, diverse drafts plus an
executed oracle beat the raw draft when truth is findable and never regress when it isn't.
Shipping that inside the real engine is a **second, harder problem**, and it is worth stating
plainly what makes it hard and how the safety property is preserved end-to-end.

The difficulty is the seam. At the point where the engine lets the model mark its work done, the
model hands over a **free-text summary** of what it did and a **workspace directory** — *not* the
code. So the production system has to answer two questions the bench never faced: **which file did
the model actually write**, and **is it safe to replace that file wholesale** with a better answer?
Both are load-bearing, because the swap primitive is a **whole-file overwrite** — the single most
dangerous operation in the system. Get the file wrong, or overwrite a file that contains more than
the one function under review, and you could *delete working code the model shipped*. That failure
mode would itself be a Gate-1 violation (shipping worse than raw), so it is gated as hard as the
scoring is.

Two positive gates, both of which must pass or the system does nothing but advise:

- **Which file — decided by version control, not by guessing.** The system asks git what changed in
  the workspace and only ever considers a file the model *actually modified* this task. If the
  workspace isn't a git repo, or nothing changed, or the change can't be pinned to exactly one
  function-shaped file, the swap is declined and the review degrades to **advice only** — it never
  touches disk. This replaced an earlier heuristic (matching the summary text against source) that
  an adversarial review defeated: a shared licence header or import block could fake a match, and
  real summaries could miss. Version control is authoritative where prose is not.
- **Safe to overwrite — only a pure single-function module qualifies.** A file is eligible for
  whole-file replacement only if the reviewed function is its **sole export of any kind** and it
  has **no side-effecting imports**. Anything more entangled — a second export, a class, a
  re-export, a bare `import "./setup"` — disqualifies the file and drops it to advice-only. This
  gate is deliberately built to **over-detect** complexity: when the parser is unsure whether a
  file is simple, it treats it as complex and declines. Erring toward "don't swap" can only cost an
  *opportunity*; erring the other way could cost *code*. (Getting this right took three passes — an
  export-counter that only saw the first of `export const a, b` slipped a hidden co-export past two
  earlier versions before the whole check was inverted to fail safe. The record is kept because the
  near-miss is the point: the swap primitive earns paranoia.)

Only when both gates pass **and** the executed oracle certifies — on **agreement among diverse
drafts**, never on a lone reasoning tie-break — that a candidate strictly out-scores the model's own
code does the system swap it in, verifying the write by reading the file back and byte-comparing,
and restoring the original if anything is off. **Everywhere else it keeps the model's code and
merely advises.** That is the production shape of the same guarantee: the model's own answer is the
floor that can never be shipped-below, and it is replaced only by a locally-certified better one.

The honest limitation carries straight through from the bench. The upside — an actual swap — is
rarest exactly where the model is *most* confused: on a maximally-ambiguous input the drafts split
hard, resolving the split is expensive, and a single-lane local model can time out mid-oracle. When
that happens the system sees **insufficient signal** and ships the model's code **unchanged**. So
under stall, the *benefit* evaporates but the *safety floor holds unconditionally* — the worst case
of a jammed oracle is "advise only, no harm," never a regression. Live end-to-end runs against the
80B confirmed both non-swap branches (a correct answer left untouched; an ambiguous one safely
degraded), and the swap-and-verify path is proven by executing the swapped code and round-tripping
it on held-out inputs. The one thing not captured is a *live* swap firing on the hardest case — for
the structural reason just given: that case degrades to safe before a swap can form.

---

## Reproducibility

The measurement harness runs **standalone** against any local model: it generates diverse
drafts, generates blind probes, executes everything on held-out inputs, applies the paired
2×2 against the raw baseline, and reports the regression and rescue rates on both the full grade
set and the never-probed partition. Each task is a self-contained specification, an
independently-verified reference, and a held-out grading set, so adding a new hard task is a
small, well-bounded change. The numbers printed at startup are the reference answers themselves —
so the answer key is auditable before a single model call is made.

> As the README puts it: when something here is real and measured, it gets documented — not
> before. This is one of those things.
