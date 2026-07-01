---
name: code-review
description: Use to review a diff for real bugs across multiple angles, then verify each finding as confirmed / plausible / refuted before reporting it.
---

This is a FLEXIBLE skill — adapt it to the situation. The procedure below is the
full version; scale it to the size of the diff and how thorough the user wants
you to be. A 10-line change needs one careful pass, not a subagent swarm. A
500-line change across many files wants the fan-out. Default to medium effort;
go heavier when the user says so or the diff is large/risky.

Core loop, always: **gather the diff → find candidates across angles → verify
each as confirmed/plausible/refuted → report only what survives.** Never report
a raw finder hit without verifying it.

## Step 1 — Gather the diff

One bash call. Cover both committed and uncommitted work:

```bash
git diff "@{upstream}...HEAD"; git diff HEAD
```

If the user named a target (a branch, a PR, `main`), diff against that instead,
e.g. `git diff main...HEAD`. If `gh` is needed for a PR target, use it.

Skip test/fixture hunks unless the change is *about* tests: `test/`, `spec/`,
`__tests__/`, `*_test.*`, `*.test.*`, `fixtures/`, `testdata/`.

## Step 2 — Find candidates (the angles)

Read every hunk line by line. Then `read` the **enclosing function** for each
hunk — bugs in unchanged lines of a touched function are in scope, because the
PR re-exposes or fails to fix them. For each candidate produce: `file:line`, a
one-line summary, and a concrete **failure scenario** (the input/state/timing
that makes it wrong). A candidate with no nameable failure scenario is not a
candidate — drop it.

Run these as independent angles. Don't let one angle's conclusion suppress
another's — if two angles flag the same line for different reasons, keep both.

**Correctness (the priority).** For each touched line ask: what input, state,
timing, or platform makes this wrong? Hunt for:
- inverted or wrong conditions, off-by-one on a boundary the code doesn't exclude
- null/undefined/nil deref where adjacent code shows the value can be absent
  (error handlers, cold cache, missing optional field)
- a removed or weakened guard
- falsy-zero / empty-string treated as "missing"
- missing `await` / unhandled promise / forgotten error return
- wrong-variable copy-paste (right shape, wrong name)
- error swallowed in a catch that should propagate
- regex/allowlist that lost an anchor or has unescaped metacharacters
- concurrency races, retry storms, partial-failure paths

**Reuse.** New code that reimplements a helper/util that already exists in the
repo. Grep for it before claiming it's novel.

**Simplification.** Logic that's tangled for no reason — a branch that can't be
taken, a redundant check, dead code the diff leaves behind.

**Efficiency.** Accidental O(n²), a query or read in a loop, repeated work that
should be hoisted. Only flag if it's a real, reachable cost.

**Altitude.** Is this solved at the wrong layer — a special-case patch where the
real fix is one level up, duplication that signals a missing abstraction?

**Conventions.** Does it break a pattern the surrounding code clearly follows
(error handling, naming, logging, how this codebase does the thing)? Match the
repo, not your defaults.

For a small diff, run these angles yourself in one pass. For a large diff,
fan out: dispatch the angles across the `task` tool using the `helper1` /
`helper2` subagents, each returning its candidate list. Tell each helper the
exact diff range and which angles to run, and to return `file:line + summary +
failure_scenario` per candidate — nothing pre-filtered. Finders that silently
drop half-believed candidates are the dominant cause of misses: pass everything
with a nameable failure scenario to Step 3 and let verification decide.

## Step 3 — Verify each candidate (confirmed / plausible / refuted)

This is the gate. Re-read the actual code for each candidate and classify:

- **CONFIRMED** — you can name the inputs/state that trigger it and the wrong
  output or crash. Quote the offending line.
- **PLAUSIBLE** — the mechanism is real but the trigger is uncertain (depends on
  timing, env, config). State what would confirm it. Realistic-but-rare paths
  (concurrency races, nil on an error path, falsy-zero, off-by-one on an
  un-excluded boundary, a lost regex anchor) are PLAUSIBLE — do **not** refute
  them just for being "speculative" or "runtime-dependent."
- **REFUTED** — drop it. Only refute when the code disproves it: it's factually
  wrong (quote the actual line), provably impossible (a type/constant/invariant
  rules it out — show it), already handled in this diff (cite the guard), or
  pure style with no observable effect.

Tune the bias to effort. **Precision mode** (small/medium reviews): when in
doubt, drop it — every reported finding should be one a maintainer would act on.
**Recall mode** (the user wants thoroughness, or the diff is large/risky): when
in doubt, keep it as PLAUSIBLE — a missed bug ships, so err toward surfacing.

## Step 4 — Report

Order by severity, most serious first. One finding per line:

```
path/to/file.ext:123 — [CONFIRMED] what's wrong and the concrete failure
```

Include the failure scenario, not just a label. Group correctness bugs above
cleanups (reuse/simplification/efficiency/altitude/conventions). Keep it tight:
a focused review surfaces a handful of real findings, not fifteen maybes. If
nothing survives verification, say so plainly — `(no issues found)` is a valid
result.

## Optional modes

**Post to a PR (`--comment`).** If the target is a GitHub PR, post each finding
as an inline comment with `gh api repos/{owner}/{repo}/pulls/{pr}/comments`
(one call per finding; add a suggestion block only when it fully fixes the
issue). If the target isn't a PR, just print the findings and note that
`--comment` was ignored.

**Apply the fixes (`--fix`).** After the report, fix each finding directly in
the working tree — correctness bugs and cleanups alike — using `edit`. Skip any
fix that would change intended behavior, reach well outside the reviewed diff,
or that you now judge a false positive; note the skip rather than forcing it.
End with a one-paragraph summary of what was fixed and what was skipped.
