---
name: verify
description: Use to PROVE a change actually works before claiming done — runtime observation at the real surface is the only evidence; tests/typecheck/build prove code-correctness, not feature-correctness.
---

This is a RIGID skill. Follow it exactly — do not improvise the procedure, skip steps, or substitute your own shortcut. The order and the rules below are the point.

**Verification is runtime observation.** Build the app, run it, drive it to where the changed code executes, and capture what you see. That capture is your evidence. Nothing else is.

**Tests/typecheck/build prove code-correctness, not feature-correctness.** A green test suite, a clean typecheck, a successful build — these say the code compiles and matches its asserted shape. They do NOT say the feature does what it should at the surface a user touches. So:

- **Don't run tests. Don't typecheck. Don't treat a clean build as the verdict.** Running them here proves you can run CI — not that the change works. Not as a warm-up, not "just to be sure," not as a regression sweep after. The time goes to running the app.
- **Don't import-and-call.** Writing a tiny script that imports the changed function and prints its output is a unit test you wrote. The function did what the function does — you knew that from reading it. The app never ran. Whatever calls that function in the real codebase ends at a CLI, a socket, or a window. Go there.
- If you genuinely cannot exercise the surface, **say so explicitly** — report BLOCKED with exactly where it stopped. Never claim success because the code "looks right" or CI is green.

## 1. Find the change

The scope is what you're verifying — usually a diff, sometimes just "does X work." In a git repo, establish the full range (a branch may be many commits, or the change may still be uncommitted). Use the bash tool (zsh/bash, the macOS default shell):

```bash
git log --oneline @{u}..        # count commits (if upstream set)
git diff @{u}.. --stat          # full range, not HEAD~1
git diff origin/HEAD... --stat  # no upstream: committed vs base
git diff HEAD --stat            # uncommitted: working tree vs HEAD
```

State the commit count. Large diff truncating? Redirect to a file (`git diff > diff.txt`) then read it. Repo but no diff from any of these → say so, stop. **No repo → the scope is whatever the user named; ask if they didn't.**

**The diff is ground truth. Any description is a claim about it.** Read both. If they disagree, that is itself a finding.

## 2. Find the surface

The surface is where a user — human or programmatic — meets the change. That is where you observe.

| Change reaches | Surface | You |
|---|---|---|
| CLI / TUI | terminal | type the command, capture the output |
| Server / API | socket | send the request, capture the response body |
| GUI / web | the running page | drive it, read what renders, capture it |
| Library / module | public boundary | sample code through the public export — import the package, not its internal files |
| Prompt / agent config | the agent | run the agent, capture its behavior |

**Internal function? Not a surface.** Something in the repo calls it, and that caller ends at one of the rows above. Follow it there. A bash security gate's surface is not the function's return value — it's the CLI prompting or auto-allowing when you type the command.

**No runtime surface at all** — docs-only, type declarations with no emit, build config with no behavioral diff — report **SKIP — no runtime surface: (reason).** Don't run tests to fill the space.

**Tests in the diff are the author's evidence, not a surface.** Tests-only change → SKIP, one line. Mixed source+tests → verify the source, ignore the test files. Reading a test to learn *what* to check is fine — it's a spec — but then go run the app. Checking that assertions match source is code review, not verification.

## 3. Get a handle (stand up the surface)

Find how to build and launch before you drive. Check the repo's own docs/scripts first: `README`, `package.json` scripts, `Makefile`, `justfile`. Note the recipe — the build command, the launch command, the URL/port, and the text that signals "ready."

Per surface type:
- **Web / GUI** → start the dev server (e.g. `npm run dev`), wait for the ready signal, then drive the page at its URL.
- **CLI / TUI** → identify the entry point (e.g. `node ./cli.js`, `python -m app`, `./target/debug/app`) and run it in the terminal.
- **API** → start the server, then hit it. NOTE: `curl` / `wget` are blocked by the harness (they'd bypass the anonymity gateway), so probe localhost with the runtime you already have — e.g. `node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(e);process.exit(1)})"` or `python3 -c "import urllib.request;print(urllib.request.urlopen('http://localhost:3000/health').read().decode())"`. That reaches your own server and reads the real response.

Timebox the cold start to ~15 min. If you cannot get it up — missing dep, build broke, launch won't come up — report **BLOCKED** with exactly where it stopped. That is not a verdict on the change.

**Authentication.** If the surface is behind a login, you must get past it before you can verify — an auth wall is not a PASS and not a FAIL of the feature. Find the login route, the credentials (from the project's own test fixtures / `.env` / config, or ask the user — the app's key vault is off-limits to you and holds only provider keys anyway; never hardcode or echo a secret), and the post-login signal (a redirect, a "Welcome" element, a set cookie/token). Drive the login, confirm the signal, then proceed. If you can't authenticate, that's BLOCKED — say so.

## 4. Drive it

Take the smallest path that makes the changed code execute:

- Changed a flag? Run with it.
- Changed a handler? Hit that route.
- Changed error handling? Trigger the error.
- Changed an internal function? Find the CLI command / request / render that reaches it, and run that.

**Read your plan back before running.** If every step is build / typecheck / run-test-file, you've planned a CI rerun, not a verification. Find a step that reaches the surface, or report BLOCKED.

**End-to-end, through the real interface.** Pieces passing in isolation does not mean the flow works — seams are where bugs hide. If users click buttons, test by clicking buttons (drive the page), not by hitting the API underneath. For web/GUI, monitor for regressions in neighboring features while you're in there, not just the changed one.

**Destructive path?** If the change touches code that deletes, publishes, sends, or writes outside the workspace and there's no dry-run or safe target, do NOT drive it live. Verify what you can around it and state plainly which path you did not exercise and why.

## 5. Push on it (probe)

The claim checking out is the first half, not the job. The description is what the author intended; your value is what they didn't test. Probe *around* the change, at the same surface you just drove:

- **New flag / option** → empty value, passed twice, conflicting flag, typo'd (does the error name it?)
- **New handler / route** → wrong method, malformed body, missing required field, oversized payload
- **Changed error path** → the adjacent errors it didn't touch — did the refactor catch them too, or only the one in the diff?
- **Interactive / TUI** → Ctrl-C mid-op, resize, paste garbage, rapid-fire a key, Esc at the wrong moment
- **State / persistence** → do it twice, do it with stale state underneath, do it in two sessions at once
- **Web** → reload mid-flow, bad input in the form, the empty/error/loading states, a narrow viewport

Pick the probes the change points at — not a checklist. At least one. A probe that finds nothing is still a step worth recording: "🔍 passed `--from ''` → clean `error: --from requires a value`, exit 2." That the author didn't test it is exactly why it's worth knowing it holds. Still not a test run — you're at the surface, typing what a user would type wrong.

**Note everything that made you pause.** You're the only reviewer who actually *ran* it. Anything that made you work around, retry, or go "huh" is information the author doesn't have. Don't filter for "is this a bug" — filter for "would I mention this if they were sitting next to me."

## 6. Capture

Stdout, response bodies, page text, terminal dumps — captured output is evidence; your memory is not. Something unexpected? Don't route around it — capture it, note it, decide whether it's the change or the environment. Unrelated breakage is a finding, not noise.

Isolate shared state. You share ports, temp dirs, and lockfiles with the host machine — bind a non-default port, use a fresh temp dir (`mktemp -d`), and clean up servers/processes you started when done.

## 7. Report (inline, final message)

```
## Verification: <one-line what changed>

Verdict: PASS | FAIL | BLOCKED | SKIP

Claim: <what it's supposed to do — your read of the diff and/or the
stated claim; note any mismatch>

Method: <how you got a handle — what you launched, how>

### Steps
1. ✅/❌/⚠️/🔍 <what you did to the RUNNING app> → <what you observed>
   <evidence: the app's own output — terminal dump, response body, rendered text>

🔍 marks a probe — a step off the happy path, trying to break it. At
least one. A Steps list that's all ✅ with no 🔍 is a happy-path
replay: still PASS, but you stopped at the first half. Build / install
/ launch are setup, not steps. Test runs and typecheck never go here.

### Findings
<Things you noticed — not just bugs: friction, surprises, anything a
first-time user would trip on. Each probe gets a line even when it
held. Claim/diff mismatch, pre-existing breakage, and env notes
belong here too. Lead with ⚠️ for anything worth interrupting the
reviewer over. Empty is fine if truly nothing stuck out.>
```

**Verdicts:**
- **PASS** — you ran the app, the change did what it should at its surface. Not: tests pass, builds clean, code looks right.
- **FAIL** — you ran it and it doesn't. Or it breaks something else. Or claim and diff disagree materially.
- **BLOCKED** — couldn't reach a state where the change is observable (build broke, missing dep, auth wall, handle wouldn't come up). Not a verdict on the change. Say exactly where it stopped.
- **SKIP** — no runtime surface exists (docs-only, types-only, tests-only). One line why.

No partial pass — "3 of 4 passed" is FAIL until 4 pass or the gap is explained away. **When in doubt, FAIL.** A false PASS ships broken code; a false FAIL costs one more look. Ambiguous output is FAIL with the raw capture attached — don't interpret it into a PASS.
