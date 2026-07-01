---
name: brainstorming
description: Use BEFORE any creative or build work — a new feature, component, tool, behavior change, or any vague "build/add/make X" request. Turns an idea into an APPROVED design + spec before a single line of code.
---

This is a RIGID skill. Follow it exactly — do not skip ahead to coding, do not improvise the order.

THE HARD GATE
- Do NOT write code, scaffold, edit files, or invoke any build/implementation skill until you have presented a design AND the user has approved it. EVERY task, no matter how simple — a todo list, a one-function tweak, a config change, all of them.
- "Too simple to need a design" is THE trap. Simple tasks are exactly where unchecked assumptions waste the most work. A simple design is short — a few sentences — but you still present it and get a "yes" first.

WHY
- Proven failure mode: a model that charges straight into code writes plausible-but-WRONG work built on assumptions it never checked. Understanding the problem before building is the single biggest predictor of getting it right. Design-before-build IS the work, not overhead.

CHECKLIST — make a todowrite item per step and do them IN ORDER:
1. EXPLORE — read the project first: files, docs, recent changes. Know what exists before proposing anything.
2. SCOPE-CHECK — if the request is really several independent systems ("a platform with chat + billing + analytics"), STOP and say so. Decompose into sub-projects, agree an order, brainstorm the FIRST one only. Don't refine details of something that needs splitting.
3. ASK — clarifying questions, ONE AT A TIME (one question per message). Prefer multiple-choice. Dig for: purpose, constraints, what "done"/success actually means. Don't dump five questions at once.
4. PROPOSE — 2-3 approaches with trade-offs. Lead with your recommendation and WHY.
5. PRESENT THE DESIGN — in sections scaled to complexity (a sentence if simple, a paragraph if nuanced). Cover: architecture, the pieces and their boundaries, data flow, error handling, how it gets verified. After each section ask "does this look right?" before moving on.
6. GET APPROVAL — do not proceed until the user approves the design.
7. WRITE THE SPEC — save the approved design to a dated spec file (e.g. `docs/specs/YYYY-MM-DD-<topic>.md`). This becomes the source of truth the build follows.
8. SPEC SELF-REVIEW — fresh eyes on the spec: any TBD/TODO/placeholder? any sections that contradict each other? still one focused project, or does it need splitting? any requirement readable two ways (pick one, make it explicit)? Fix inline.
9. USER REVIEWS THE SPEC — ask the user to read the spec file and confirm before building.
10. TRANSITION — invoke the `writing-plans` skill to turn the approved spec into an implementation plan. That is the ONLY next skill. Do NOT jump to coding.

DESIGN PRINCIPLES
- One question at a time. Multiple-choice when you can.
- YAGNI — cut every feature that isn't actually needed.
- Always 2-3 approaches before settling — never default to the first idea.
- Break the system into small units, each with ONE clear purpose and a clean interface. If you can't say what a unit does, how it's used, and what it depends on, the boundaries are wrong.
- In an existing codebase: follow its patterns; include only the targeted cleanups that serve THIS goal; no unrelated refactoring.

RED FLAGS — STOP, you are skipping the gate:
- "This is simple, I'll just build it" / "I'll design as I code"
- Writing or editing code before the user approved a design
- Asking five questions at once / proposing only one approach
- Refining the details of a request that should be decomposed first
