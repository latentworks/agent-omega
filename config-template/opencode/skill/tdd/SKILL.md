---
name: tdd
description: Use when implementing any feature or bugfix — before writing implementation code.
---

SKILL: TEST-DRIVEN DEVELOPMENT (TDD)
Use when implementing any feature or bugfix — BEFORE writing implementation code.
Rigid skill: follow it exactly. Violating the letter is violating the spirit.

THE IRON LAW
- NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
- Wrote code before the test? Delete it and start over — don't keep it "as reference," don't "adapt"
  it, don't even look at it. Implement fresh from the test.
- Core principle: if you didn't WATCH the test fail, you don't know it tests the right thing.

THE CYCLE — RED -> GREEN -> REFACTOR
- RED — write ONE minimal test for ONE behavior, clear name, against real code (avoid mocks unless
  unavoidable). It expresses what SHOULD happen.
- VERIFY RED (mandatory) — run it and watch it FAIL for the expected reason (feature missing, not a
  typo). Passes? You're testing existing behavior — fix the test. Errors? Fix and re-run until it
  fails correctly.
- GREEN — write the SIMPLEST code that makes it pass. Nothing more — no extra options, no "while I'm
  here" features, no refactoring other code (YAGNI).
- VERIFY GREEN (mandatory) — run it: the test passes, all other tests still pass, output is clean.
  If it fails, fix the CODE, not the test.
- REFACTOR — only once green: remove duplication, improve names, extract helpers. Keep tests green;
  don't add behavior.
- REPEAT — next failing test for the next behavior.

WHY ORDER MATTERS
- Tests written AFTER the code pass immediately — which proves nothing (may test the wrong thing,
  test the implementation not the behavior, or miss the edge cases you forgot). You never saw it
  catch anything. Test-first forces you to see it fail (proving it tests something) and forces
  edge-case discovery BEFORE implementing. Tests-after answer "what does this do?"; tests-first
  answer "what SHOULD this do?"

GOOD TESTS
- Minimal (one thing — if the name has "and," split it). Clearly named for the behavior. Show intent
  (demonstrate the desired API). Real code, not mocks of the thing under test.

RED FLAGS — these mean DELETE the code and start over with TDD:
- Code before the test / test added "later" / the test passed immediately / can't explain the failure
- "I already manually tested it" — ad-hoc isn't systematic; no record, can't re-run.
- "Keep it as reference / adapt the existing code" — you'll adapt it; that's testing after. Delete.
- "Already spent hours, deleting is wasteful" — sunk cost; unverified code is technical debt.
- "TDD is dogmatic, I'm being pragmatic / it's spirit not ritual / this is different because..."

WHEN STUCK
- Don't know how to test it -> write the wished-for API / the assertion first.
- Test too complicated -> the design is too complicated; simplify the interface.
- Must mock everything -> the code is too coupled; use dependency injection.

BUG FIXES
- Bug found = write a failing test reproducing it first, then follow the cycle. The test proves the
  fix and prevents the regression. Never fix a bug without a test.
