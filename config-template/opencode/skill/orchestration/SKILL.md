---
name: orchestration
description: Use when a task is big enough to split across helper1/helper2 in parallel — how to plan the split, brief zero-context helpers, and integrate + verify their work.
---

This is a FLEXIBLE skill — a default playbook, not a rule set. Adapt the split, the depth, and the number of rounds to the task in front of you. Skip what doesn't apply.

You drive the work. `helper1` and `helper2` are local 30B coder subagents you spawn with the `task` tool. They are fast and parallel but weaker than you and have **zero context** — they cannot see this conversation, your reasoning, or each other. Treat them as capable strangers who only know what you write in the prompt. Your job is to plan the split, brief them precisely, then read, integrate, and verify what comes back. You synthesize; they execute.

## When to split (and when not to)

Split only when the work is **genuinely independent** — separate files, separate concerns, no shared state, no ordering dependency. Parallelism is your superpower for that; serializing independent work wastes it.

Do NOT split:
- A small task that's a handful of `read`/`edit`/`grep` calls — just do it yourself in one pass. Fanning it out is slower than doing it.
- Work where step B needs step A's output — that's sequential, not parallel.
- Anything you can answer directly without tools.

Good split candidates: research that covers multiple angles at once; editing two unrelated modules; "implement here while verify there"; building a feature whose pieces don't touch.

## The loop

Most non-trivial work follows four phases. You own synthesis; helpers own the legwork.

| Phase | Who | What |
|-------|-----|------|
| Research | helpers (parallel) | Find files, map the problem, report paths/line numbers/signatures |
| Synthesis | **you** | Read findings, decide the approach, write exact specs |
| Implementation | helpers | Make targeted changes per spec, self-verify, commit |
| Verification | helper (fresh) | Prove it actually works |

Concurrency rules:
- **Read-only research** — run both helpers in parallel freely. Cover different angles.
- **Writes to the same files** — one helper at a time. Concurrent edits to one file collide.
- **Verification** can run alongside implementation only if it touches a different file area.

To launch in parallel, make both `task` calls in a single message.

## Spawning helpers

- Give a helper a real task — investigate, implement, verify — not "read me this file" or "run this command." You can do trivial reads yourself.
- After you launch helpers, tell the user in one line what you kicked off, then end your turn. **Results arrive later as separate messages** — you do not have them yet. Never write up, predict, or fabricate a helper's findings before its message arrives. If the user asks mid-wait "is X done / what did it find," answer with status ("still running — that's one of the things it's checking"), not an invented result.
- If you sent a helper down the wrong path (you realize the approach is wrong, or the user changes the ask after launch), stop it rather than letting it finish — then re-brief with corrected instructions.

## Writing helper prompts — your most important job

A helper sees **only its prompt**. Every prompt is self-contained or the helper is flying blind.

After research comes back, **understand it yourself before directing the next step.** Never write "based on your findings, fix it" or "the helper found an issue, please fix it" — that hands your thinking back to a weaker model. Read the findings, form the plan, then hand over a concrete spec.

```
# Bad — lazy delegation, no real instruction
task(helper1, "Based on the research, fix the auth bug")

# Good — you did the synthesis, the spec is exact
task(helper1, "Fix the null pointer in src/auth/validate.ts:42. The `user` field on
Session (src/auth/types.ts:15) is undefined when a session expires but the token is
still cached. Add a null check before reading user.id — if null, return 401 with
'Session expired'. Run the auth tests, then commit only that file and report the hash.")
```

Every prompt should carry:
- **Purpose** so the helper calibrates depth: "this feeds a PR description — focus on user-facing changes," or "quick pre-merge check — just the happy path," or "I'm planning an implementation — report file paths, line numbers, and type signatures."
- **What "done" looks like** — the concrete end state.
- **Exact paths, names, and identifiers** — branch names, file paths, commit hashes, function names. No "the file we discussed."
- For research: "Report findings — do not modify files."
- For implementation: "Fix the root cause, not the symptom. Run the relevant tests + typecheck, commit only the files you changed, report the hash." (Self-verify is the helper's first QA pass; your verification phase is the second.)
- For verification: "Prove the code works, don't just confirm it exists. Try edge cases and error paths — don't only re-run what the implementer ran. Investigate any failure; don't wave it off as unrelated without evidence."

Good prompts:
- "Find all test files covering src/auth/. Report the test structure, what's covered, and any gap around session expiry. Do not modify files."
- "On a new branch fix/session-expiry off main, change validate.ts:42 as follows… Commit only that file. Report the hash."

Bad prompts (and why):
- "Fix the bug we discussed" — helper can't see the conversation.
- "Create a PR for the recent changes" — which changes? which branch? draft or ready?
- "Something's wrong with the tests, take a look" — no error, no path, no direction.

### Fresh spawn vs. follow-up

If a helper finished and you want it to keep going, a follow-up reuses its loaded context — good for **correcting its own work** ("the test you added fails at line 58 — fix the assertion") or extending what it just did. A brief follow-up is fine there; it remembers.

Spawn a **fresh** helper when:
- The next step is narrow but the prior context is broad and noisy — a clean slate is sharper.
- You want **verification of code another helper wrote** — a fresh pair of eyes won't carry the implementer's assumptions.
- A first attempt took the wrong approach entirely — don't let the failed path anchor the retry.
- It's an unrelated task.

## What helpers must do (bake into prompts)

Helpers default to overreach and sloppy commits, so spell these out:
- **Stay in scope.** Do exactly what was asked. Don't fix unrelated things you notice — list them as follow-ups in the report instead.
- **Commit hygiene.** Stage only the files actually changed — never `git add .` or `git add -A`. Clear, descriptive message. Report the commit hash.
- **No nesting.** A helper must not spawn its own subagents.
- **Bail loudly.** If a file is missing, requirements conflict, or another helper's changes left confusing file state on the branch — stop and report rather than guessing or "fixing" code it doesn't understand. Don't retry the same failed approach twice.
- **Report format.** (1) What it did/found — specific paths, line numbers, snippets. (2) A one-line summary you can relay to the user. Good: "Added Redis cache, tests pass, typecheck clean, committed abc123." Bad: "I looked at X, Y, Z; Y has the change."

## Verify before you relay

A helper's summary says what it **intended**, not always what it **did**. Before you tell the user something's done:
- Check the actual diff (`git diff` / `git show <hash>`), don't trust the prose.
- Run or have a fresh helper run the tests **with the feature exercised** — "tests pass" on untouched paths proves nothing.
- Run a typecheck and investigate errors instead of dismissing them.
- If something looks off, dig in. A verifier that rubber-stamps weak work defeats the whole point.

When a helper reports failure, that's normal — follow up the same helper (it holds the error context) with a corrected spec, or if a correction also fails, switch approach or surface it to the user.

## macOS note

Helpers run on macOS and use zsh/bash (the macOS default shell). When a prompt needs a shell example, prefer bash (`$VAR`, empty string / unset, `cat`) and tell the helper which shell you mean if it matters. The same `git add <specific file>` discipline applies.
