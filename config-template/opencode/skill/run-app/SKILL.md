---
name: run-app
description: Use when you must launch and drive the real app (web server, CLI, TUI, browser-driven UI) to observe its behavior — covers backgrounding, readiness, driving, and teardown.
---

This is a FLEXIBLE skill — a kit of patterns, not a fixed script. Pick the shape that matches the app, take the pattern below, and adapt it to what's actually in front of you.

**Running means launching the actual app and interacting with it** — not the test suite, not importing an internal function and printing its return. The app as a user (human or programmatic) would meet it: the CLI at its command, the server at its socket, the TUI in its terminal, the page in a browser. Launching with no interaction only proves the entrypoint resolves — that's typechecking with extra steps. Drive it to a point where a user would see something real, then read what came back.

## First: is the launch path already written down?

Before improvising, look for an existing recipe — the verified path costs nothing to reuse and saves you rediscovering ports, env vars, and quirks.

1. Check for a project skill that already launches this app: `glob` for `**/SKILL.md` and read any whose description mentions running/starting/driving the app. If one fits, follow it verbatim — don't paraphrase, don't skip its setup steps.
2. Check `package.json` `scripts`, a `Makefile`/`justfile`, `README`/`CONTRIBUTING`, and any `.env.example`. The run command, port, and required env vars are usually there.
3. Mega-repo with several plausible entrypoints and no clear match → ask the user which unit to run rather than guessing.

Nothing written down → use the patterns below.

## The universal loop

Every shape is the same four beats. Only the mechanics differ.

1. **Launch** in the background so your shell stays free (a foreground `npm start` that blocks the shell is useless to you).
2. **Wait for readiness** by polling a real signal — never a fixed sleep. Poll the port, a log line, or an on-screen marker; it returns the instant the app is up and fails loudly if it never comes.
3. **Drive** one representative path that exercises the change — not the whole app, one path that proves it works.
4. **Tear down** the process you started, before relaunching, or the next run collides (port in use, stale session).

Backgrounding is shell-specific on Windows:
- **PowerShell:** `Start-Process` (or `Start-Job`) launches detached; redirect output to a file you can read.
- **git-bash:** `cmd &> /tmp/app.log &` plus `$!` for the PID, exactly like Linux.

Use whichever the rest of the recipe is written in. git-bash gives you the familiar `&` / `$!` / `pkill` / `tmux` toolset; reach for it for TUIs and poll-loops.

If the launch + poll + smoke sequence grows past a few lines, `write` it to a `smoke.ps1` or `smoke.sh` in this skill's directory and just run that — one command, exit code tells you if the app is healthy.

---

## Shape: CLI tool

Simplest case — usually no background process, no port, no lifecycle. Focus on getting the binary reachable, then a couple of real invocations.

1. Get it on PATH: installed (`pip install -e .`, `npm link`), run via a runner (`npx`, `uv run`), or built to a path (`./target/release/foo`, `dist/cli.js`). Confirm with `--version`.
2. Run two or three representative commands covering the main use cases. Read stdout against what you expect.
3. Check the **exit code** when it carries meaning (a linter returns non-zero on findings). In PowerShell that's `$LASTEXITCODE`; in git-bash, `$?`.
4. If the tool reads **stdin**, exercise that path too.

```powershell
pip install -e .
mytool --version            # → mytool 0.3.1
mytool process input.json   # → Processed 42 records, wrote output.json
Get-Content input.json | mytool process -   # stdin path
mytool lint .\src; $LASTEXITCODE            # 0 clean, 1 issues found
```

Keep it tight — `--help` covers every flag; you only need enough to prove it builds, runs, and the change shows up.

---

## Shape: Web server / API

The defining concern is **lifecycle**: start in the background, confirm it's up, hit it, shut it down cleanly.

```bash
# git-bash — background, capture PID, poll readiness
npm run dev &> /tmp/api.log &
SERVER_PID=$!
timeout 30 bash -c 'until curl -sf http://localhost:3000/health >/dev/null; do sleep 0.5; done'

curl http://localhost:3000/health
# → {"status":"ok","version":"1.2.3"}

# hit the route your change actually touched, read the body
curl -s http://localhost:3000/api/items | head

kill $SERVER_PID          # or, PID lost: pkill -f "tsx watch src/index.ts"
```

PowerShell equivalents when you prefer it: `Start-Process node -ArgumentList ... -RedirectStandardOutput`, poll with `Invoke-RestMethod` in a `do { } until`, hit routes with `Invoke-RestMethod`/`Invoke-WebRequest`, stop with `Stop-Process`.

Nail down and, if useful, record:
- **Port**, and how to override it (`PORT=4000 npm run dev` / `$env:PORT=4000`).
- **What "ready" means** — a health endpoint or a specific log line in `/tmp/api.log`.
- **Required env vars** — DB URL, API keys (pull secrets from the vault, never hardcode).
- **Dependent services** (Postgres/Redis): the `docker run` or compose command that brings them up first.

A page or endpoint can return its shell while every data call 500s — read the actual body, and skim the log, before calling it up.

---

## Shape: TUI / interactive terminal app

Editors, REPLs, curses UIs take over the terminal, so the bash tool can't drive them directly. Wrap them in **tmux** (run it through git-bash): start detached, send keys, capture the pane.

```bash
tmux new-session -d -s app -x 120 -y 40 './myapp'

# poll for the ready marker, then read the screen
timeout 10 bash -c 'until tmux capture-pane -t app -p | grep -q "Ready"; do sleep 0.2; done'
tmux capture-pane -t app -p

# drive: open Settings, toggle an option, confirm it took
tmux send-keys -t app 's'
timeout 5 bash -c 'until tmux capture-pane -t app -p | grep -q "Settings"; do sleep 0.2; done'
tmux send-keys -t app 'Down' 'Down' 'Space'
timeout 5 bash -c 'until tmux capture-pane -t app -p | grep -qF "[x]"; do sleep 0.2; done'
tmux capture-pane -t app -p

tmux send-keys -t app 'q'
tmux kill-session -t app 2>/dev/null || true   # fallback if the quit key didn't take
```

Watch for:
- **Terminal size** — some TUIs hide content when narrow. Set a known-good `-x`/`-y`.
- **The keybindings** — this is the app's "API." Note the keys you used (navigate / select / the screen you needed / quit).
- **Capture readability** — `capture-pane -e` keeps escape sequences, `-J` joins wrapped lines.
- More than a couple of poll lines → fold them into a `wait_for()` in a `driver.sh` beside this skill.

---

## Shape: Browser-driven web app

A dev server serves HTML to a browser. You can't open a window, so "run it" means: start the dev server, drive a **headless browser via a Playwright script**, and capture a screenshot that proves the page rendered.

**Step 1 — dev server**, backgrounded and polled (same as the server shape):

```bash
npm run dev &> /tmp/dev.log &
echo $! > /tmp/dev.pid
timeout 30 bash -c 'until curl -sf http://localhost:3000 >/dev/null; do sleep 1; done'
# stop before relaunching: kill $(cat /tmp/dev.pid)   (else EADDRINUSE)
```

**Step 2 — drive it.** There's no built-in browser tool, so `write` a small Playwright script and run it with `node` (needs Playwright installed; if it isn't, `npm i -D playwright && npx playwright install chromium`). The pattern is always: `goto` → wait for the element you need → act → screenshot → check console errors.

```js
// write to drive.mjs, then: node drive.mjs
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const page = await b.newPage();
const errs = [];
page.on('console', m => m.type() === 'error' && errs.push(m.text()));

await page.goto('http://localhost:3000');
await page.getByText('Dashboard').waitFor();          // wait for the element, never a raw sleep
await page.screenshot({ path: 'before.png' });

await page.getByRole('button', { name: 'New item' }).click();
await page.fill('input[name="title"]', 'Smoke test'); // fill/type, not el.value= (won't fire React onChange)
await page.keyboard.press('Enter');
await page.getByText('Smoke test').waitFor();
await page.screenshot({ path: 'after.png' });

console.log('console errors:', errs);                 // a shell can render while every fetch 500s
await b.close();
```

Then **`read` the screenshot** — a blank frame is a failed launch, not a pass. Use `page.locator(sel).screenshot()` to crop to one component when the change is localized.

Record only the project-specific bits — the framework handles the mechanics:
- **Dev command + port + the stop line**, and any env vars it needs.
- **Auth** — whatever yields a logged-in session: a cookie to set, a fill/click login sequence, or a helper that does the API dance and emits the cookie.
- **One representative path** ending in a screenshot. Not the whole app.

Recurring gotchas: React controlled inputs need `fill`/`type` (assigning `.value` skips onChange); websocket/long-poll pages never go network-idle, so wait for a concrete element, not idle; Vite/Next compile routes on first hit, so the first `goto` can take 10s+ (the element wait absorbs it, a fixed sleep doesn't).

---

## When the shape doesn't match cleanly

Start from the closest shape and adapt — the four beats hold for anything. Heavy work (writing the Playwright driver, standing up dependent services, exercising many paths) is a clean unit to hand to a **helper subagent** via the task tool. And when you had to fight to get it running — installed packages, set env vars, patched config, wrote a driver — capture that working sequence as a project skill or note so the next run starts from a known-good path instead of rediscovering it.
