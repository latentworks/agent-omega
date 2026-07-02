---
name: writing-plans
description: Use AFTER a design/spec is approved (brainstorming hands off here) and BEFORE writing implementation code — turns an approved spec into a concrete, ordered, verifiable implementation plan.
---

This is a RIGID skill. Follow it exactly. It is the bridge between an approved design (from the
`brainstorming` skill) and writing code: you leave here with a plan, not with code.

WHY
- A local model that jumps from "design approved" straight to editing files loses the thread across
  multi-file work: it forgets a step, half-implements, and declares done. A written plan holds the
  whole task so each step is small, ordered, and independently checkable.

THE HARD GATE
- Do NOT edit implementation files until the plan below exists and the user has seen it. Writing the
  plan file itself is allowed (it is not implementation).

CHECKLIST — make a todowrite item per step, do them IN ORDER:
1. READ THE SPEC — open the approved spec (e.g. `docs/specs/YYYY-MM-DD-<topic>.md`). If there is no
   written spec, go back to the `brainstorming` skill; do not plan from memory.
2. RE-READ THE CODE the plan will touch — the exact files, functions, and interfaces. Confirm the
   real names, signatures, and data shapes the spec assumes actually exist; note any that don't.
3. WRITE THE PLAN to `docs/plans/YYYY-MM-DD-<topic>.md` as an ordered list of small steps. Each step:
   - the file(s) it touches and the concrete change,
   - the specific behavior it must produce,
   - HOW that step is verified — the real thing to run and the output that proves it (a passing
     executed test or the program's real output; "it compiles" is never verification),
   - what it depends on (so the order is a real dependency order, not a wish list).
4. SEQUENCE FOR EARLY PROOF — order steps so something runnable exists as soon as possible; put the
   riskiest / most-uncertain step early, not last. Prefer a thin end-to-end slice over a big-bang.
5. PLAN SELF-REVIEW — fresh eyes: any step with no verification? any hidden dependency out of order?
   any step doing more than one thing (split it)? any spec requirement with no step (add it)? Fix inline.
6. TRANSITION — hand off to implementation: use the `tdd` skill for each unit, and the
   `orchestration` skill if independent steps can be split across helper models. Execute the plan
   step by step, checking off each todowrite item only when its verification actually passed.

RED FLAGS — STOP, you are skipping the gate:
- Editing implementation code before the plan file exists
- A plan step whose "verification" is a build/typecheck/lint instead of running the real thing
- Planning from memory because "the spec is obvious"
- One giant step instead of small ordered ones
