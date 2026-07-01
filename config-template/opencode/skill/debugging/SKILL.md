---
name: debugging
description: Use for ANY bug, test failure, or unexpected behavior — before proposing a fix.
---

SKILL: SYSTEMATIC DEBUGGING
Use for ANY bug, test failure, or unexpected behavior — BEFORE proposing a fix.
Rigid skill: follow it exactly; don't water down the discipline.

THE IRON LAW
- NO FIX WITHOUT ROOT-CAUSE INVESTIGATION FIRST. A symptom fix is a failure. If you haven't found
  the root cause, you may not propose a fix.

WHY
- Random fixes waste time and create new bugs; quick patches mask the real issue. Systematic is
  FASTER than guess-and-check thrashing — especially in an emergency, when "one quick fix" seems
  obvious, or when a previous fix didn't work.

PHASE 1 — ROOT CAUSE (before ANY fix)
- Read the error/stack trace completely — line numbers, paths, codes. It often contains the answer.
- Reproduce it reliably. Can't trigger it consistently? Gather more data — don't guess.
- Check what recently changed (diff, commits, new deps, config, environment).
- Multi-component system: ADD INSTRUMENTATION before fixing — log what enters and exits each
  component boundary, run once to see WHERE it breaks, then investigate that component.
- Trace the bad value backward to where it originates. Fix at the source, not the symptom.

PHASE 2 — PATTERN
- Find similar WORKING code in the same codebase. List every difference between working and broken,
  however small — don't assume "that can't matter." Following a reference? Read it completely.

PHASE 3 — HYPOTHESIS (scientific method)
- State ONE hypothesis clearly: "I think X is the cause because Y." Be specific.
- Test it with the SMALLEST possible change — one variable at a time.
- Worked? -> Phase 4. Didn't? -> form a NEW hypothesis. Do NOT stack more fixes on top.
- Don't understand something? Say so and investigate — don't pretend.

PHASE 4 — FIX
- Write a failing test that reproduces the bug FIRST (use the tdd skill). Have it before you fix.
- Implement ONE fix at the root cause. No "while I'm here" changes, no bundled refactors.
- Verify: the test passes, no other tests broke, the issue is actually resolved.
- Fix failed? STOP and count attempts. Under 3 -> return to Phase 1 with the new info. THREE OR MORE
  failed fixes = an ARCHITECTURE problem, not a hypothesis problem — stop fixing and raise it with
  the user (is this pattern sound, or are we fighting it by inertia?).

RED FLAGS — these thoughts mean STOP, return to Phase 1:
- "Quick fix now, investigate later" / "Just try changing X and see"
- "It's probably X, let me fix that" (a fix before tracing the data)
- "Skip the test, I'll verify manually" / "I don't understand it but this might work"
- "One more fix attempt" (after 2+) / each fix reveals a new problem elsewhere (-> architecture)

RATIONALIZATIONS (excuse -> reality):
- "Too simple to need the process" -> simple bugs have root causes too; the process is fast for them.
- "Emergency, no time" -> systematic is faster than thrashing.
- "I'll write the test after the fix works" -> untested fixes don't stick; test-first proves it.
- "I see the problem, let me fix it" -> seeing the symptom isn't understanding the cause.
