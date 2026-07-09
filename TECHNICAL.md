# Agent Omega — Technical Architecture

Developer-facing architecture reference for Agent Omega (A/O), a customized coding-agent
harness built on top of the open-source **opencode** engine and extended with a multi-model
council, persistent memory, an on-demand skill router, verify-and-iterate loops, an anonymous
web gateway, and an encrypted local secrets vault.

This document describes the *real* wiring as implemented in the source. Paths use `~` for your
home folder and are otherwise repo-relative.

---

## 1. The stack at a glance

Agent Omega is four cooperating processes plus a set of engine plugins:

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  Program.cs  —  C# WinForms host (frameless window)                           │
 │  ┌────────────────────────────────────────────────────────────────────────┐  │
 │  │  WebView2 control (Chromium)                                            │  │
 │  │    loads  file:///…/ui/app.html?ws=4599&token=<per-launch GUID>         │  │
 │  │    • window controls only via chrome.webview.postMessage               │  │
 │  │    • popups blocked, navigation locked to file:///, DevTools off        │  │
 │  └───────────────▲───────────────────────────────┬────────────────────────┘  │
 │   window ctl msgs│ (close/min/max/drag)          │                           │
 └──────────────────┼───────────────────────────────┼───────────────────────────┘
                    │                                │  ws://127.0.0.1:4599?token=…
                    │ spawns node + AO_WS_TOKEN      │  (loopback + token gated)
                    ▼                                ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  sidecar.mjs  —  Node ACP driver + WebSocket server (loopback only)           │
 │    • verifyClient rejects any local page lacking the launch token             │
 │    • reads DPAPI vault keys, injects them into the engine's env               │
 │    • speaks ACP as the CLIENT; bridges UI JSON <-> ACP                        │
 └───────────────────────────────────────┬──────────────────────────────────────┘
                    ACP over ndjson (stdin/stdout)  │  env: vault API keys
                                                     ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  opencode.exe  —  the engine (Bun-compiled binary), run as `opencode acp`     │
 │    • turns, tool calls, permissions, model/agent switching                    │
 │    • loads plugins + AGENTS.md system prompt from ~/.config/opencode/         │
 │    • shell tool BLANKS *_API_KEY from the model's shell env                    │
 └───────────────────────────────────────┬──────────────────────────────────────┘
                                          │  plugin hooks + tools
                                          ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  Plugins (config-template/opencode → ~/.config/opencode/)                     │
 │    council · engram · skill-router · iterate-loop · verify-guard              │
 │    web.py (anonymous web gateway, SSRF-guarded)                               │
 └──────────────────────────────────────────────────────────────────────────────┘
```

Key idea: **the C# host owns only the window.** Everything the user interacts with — turns,
streaming output, interactive permissions, model/agent switches, settings — flows over the
loopback WebSocket to the sidecar, which drives the engine over ACP (the Agent Client Protocol).

---

## 2. The host — `Program.cs`

A frameless C# WinForms application (`Program.cs`) that hosts a
single `WebView2` control docked to fill the window.

- **Frameless window.** `FormBorderStyle.None` with zero `Padding` — edge-to-edge, no bezel.
  `WS_THICKFRAME` is re-added via `CreateParams` so the OS sizing loop still exists, while
  `AppForm.WndProc` intercepts `WM_NCCALCSIZE` and zeroes the non-client area so the native
  frame draws nothing. Edge/corner **resize is driven from the UI**: a 6px hit-band in
  `ui/app.html` detects the pointer near an edge and posts a `resize` message with a direction;
  the host (`OnUiMessage`) maps it to the matching `HT*` hit-test code and hands off to the
  native sizing loop via `WM_NCLBUTTONDOWN`. Title-bar drag/minimize/maximize/close are also
  handled in C# via `OnUiMessage`.
- **Boots the UI.** On `Form.Load` it creates a WebView2 environment (user-data folder under
  `%TEMP%\agent-omega-webview2`), then navigates to
  `file:///…/ui/app.html?ws=4599&token=<WS_TOKEN>`. `WS_TOKEN` is a fresh `Guid` generated
  **per launch** — only the real window ever receives it.
- **Spawns the sidecar.** `StartSidecar()` launches
  `node sidecar.mjs <WORKDIR> <WS_PORT>` with
  `CreateNoWindow=true`, passing the token as the `AO_WS_TOKEN` environment variable (never on
  the command line). On `FormClosed` it kills the sidecar process tree.
- **Host bridge is window-controls only.** `WebMessageReceived` → `OnUiMessage` parses the JSON
  message and switches on `close` / `minimize` / `maximize` / `drag`. Nothing else crosses this
  channel — all engine I/O goes over the WebSocket, not through the host.

WebView2 hardening applied in `Form.Load` (all security-relevant):

| Setting | Effect |
|---|---|
| `NewWindowRequested` → `Handled = true` | Blocks `window.open` / `target=_blank` popups |
| `NavigationStarting` cancels non-`file:///`/`about:` URIs | UI can only ever load the local app |
| `AreDevToolsEnabled = false` | No DevTools inspection of the local UI |
| `AreBrowserAcceleratorKeysEnabled = false` | Kills Ctrl+P/F/R, F5 |
| `IsGeneralAutofillEnabled` / `IsPasswordAutosaveEnabled = false` | No autofill/password capture |
| `AllowExternalDrop = false` | Dropping a file cannot navigate the webview away |
| `AreDefaultContextMenusEnabled` / `IsStatusBarEnabled` / `IsZoomControlEnabled = false` | Locked-down chrome |

---

## 3. The sidecar — `sidecar.mjs`

A Node process (`sidecar.mjs`) that is both the **WebSocket server**
for the UI and the **ACP client** for the engine. It is the only component that talks to both
sides.

### 3.1 WebSocket server (the control socket)

- Binds `WebSocketServer({ host: '127.0.0.1', port: WS_PORT })` — **loopback only**, never
  exposed to the LAN.
- `verifyClient` reads the `token` query parameter and rejects any connection whose token does
  not equal `AO_WS_TOKEN`. If no token is set (a dev/standalone run) it allows connections. This
  stops any *other* local process or browser page from driving the engine.
- On `wss` error (e.g. port already in use by a second instance) it exits cleanly with code 1
  rather than crashing unhandled.
- Multiple UI windows can connect; the sidecar `broadcast()`s engine events to all clients and
  `send()`s point-to-point replies (e.g. settings queries).

### 3.2 Engine driver (ACP)

- The engine is the Bun-compiled binary `engine/opencode.exe`, spawned as
  `opencode acp --cwd <WORKDIR> --port <API_PORT>` with `stdio: ['pipe','pipe','inherit']`.
  `WORKDIR` defaults to `%LOCALAPPDATA%\AgentOmega\workspace` and is overridable via `--workdir`
  / `AGENT_OMEGA_WORKDIR` (open a real project). The shell (`Program.cs`) picks a free loopback
  port *pair* at launch — control socket on `P`, engine API on `P+1` — so a stale/second instance
  on 4599 can't wedge startup, and it redirects the sidecar+engine stderr to
  `~/.agent-omega\logs\sidecar.log` so a boot crash is diagnosable. The sidecar self-exits if the
  shell dies abnormally (`AO_PARENT_PID` liveness probe), so the engine is never orphaned.
  - **Test mode:** setting `AGENT_OMEGA_OPENCODE_SRC` to the `packages/opencode` dir runs the
    engine from source via `bun run … src/index.ts` instead, picking up engine edits without a
    binary rebuild. Unset in production → the compiled exe is used.
- ACP transport: `acp.ClientSideConnection` over `acp.ndJsonStream(engine.stdin, engine.stdout)`
  (newline-delimited JSON). The sidecar `initialize`s with `clientCapabilities.fs` (read + write
  text file), then creates a session (`conn.newSession`) and selects the model
  (`unstable_setSessionModel`).
- **`UIClient`** implements the ACP client callbacks the engine calls back into:
  - `requestPermission(p)` → broadcasts a `permission` message to the UI and returns a Promise
    stored in `pendingPerms` (resolved when the UI replies, or *cancelled* via `drainPerms()` if
    the UI disconnects mid-turn — the engine is never left blocked on a permission nobody can
    answer).
  - `sessionUpdate(pp)` → forwards live updates (`available_commands_update` becomes a
    `commands` message; everything else an `update` message).
  - `readTextFile` / `writeTextFile` → client-side filesystem for the engine.

### 3.3 UI → sidecar message protocol

The UI sends JSON over the WebSocket; the sidecar switches on `m.type`:

| Message | Action |
|---|---|
| `prompt` / `command` | Run a turn (`conn.prompt`); guarded by a `busy` flag; emits `turn-start`/`turn-end` |
| `permissionReply` | Resolve a pending `requestPermission` with the selected option |
| `setModel` / `setAgent` | `unstable_setSessionModel` / `setSessionConfigOption('mode')`; rolls back on failure |
| `getCouncilConfig` / `setCouncilConfig` | Read/merge/atomic-write `council/council.json`, field-validated |
| `vaultList` / `vaultSet` / `vaultRemove` | Manage vault keys via `secrets.ps1`; a set/remove triggers `restartEngine()` |
| `abort` | `conn.cancel`, drain permissions, clear busy |
| `new` | New session |

Sidecar → UI messages: `ready`, `update`, `permission`, `commands`, `turn-start`, `turn-end`,
`model`, `agent`, `error`, `engine-down`, `councilConfig`, `vaultKeys`.

Because the engine reads API keys **once at spawn**, changing a vault key requires a
`restartEngine()` (kill + re-spawn with a fresh `vaultEnv()`), which the sidecar does
automatically after a `vaultSet`/`vaultRemove` unless a turn is in progress.

---

## 4. The UI — `ui/app.html`

A single self-contained HTML/JS file (no framework, no build step). Two visual themes share one
DOM: a **CRT terminal** aesthetic (VT323 font, scanline/roll/vignette overlays) and a **Modern**
theme (`modern-theme.css`). All rendering is done by hand in vanilla JS.

- **Transport.** Reads `ws` and `token` from `location.search`, opens
  `ws://127.0.0.1:<port>?token=<token>`, and reconnects on close with a 1200ms backoff
  (`scheduleReconnect`). It waits for the `ready` message before flipping `connOpen` true.
- **`onWs(m)` router** dispatches the sidecar messages above into the render layer and connection
  state. `ready` carries the session id, model/agent lists, and command list.
- **ACP `sessionUpdate` router (`onUpdate`)** handles the engine's live update stream:
  `agent_message_chunk` (answer text), `agent_thought_chunk` (reasoning), `tool_call` /
  `tool_call_update` (rendered per-tool, keyed by `toolCallId` and merged in place),
  `plan`, `current_mode_update`, `usage_update` (token/cost meter),
  `available_commands_update`.
- **Rich render layer.** Streaming markdown, a syntax highlighter, unified-diff and
  oldString/newString LCS diff rendering, collapsible tool output, todo checklists,
  task/subagent progress, and the interactive **permission panel** (the key terminal-parity
  feature — the engine's `requestPermission` becomes clickable option buttons).
- **Input subsystem.** One unified capture-phase keydown pipeline; auto-growing textareas,
  persisted prompt history, `!` shell mode, a Ctrl+P command palette, and `/` + `@`
  autocomplete wired to the live `ready` data.
- **Host bridge.** `window.chrome.webview.postMessage({type})` is used *only* for window
  controls (`close`/`minimize`/`maximize`/`drag`).
- **XSS discipline.** Every model/tool/diff/permission string is HTML-escaped (`escapeHtml`,
  `hl()`, or `textContent`) before it can reach `innerHTML`.

---

## 5. The engine plugins

The plugins live in `config-template\opencode\` and are installed to
`~/.config/opencode/` (`~\.config\opencode\`). They're registered via the `plugin`
array in `opencode.json`; skills and commands are what opencode discovers by directory.

**Plugin authoring convention (important):** each plugin's `index.js` exports **only** its
default plugin function, because opencode treats *every* export of a plugin module as a separate
plugin. All importable/testable logic therefore lives in sibling `.mjs` files. Those `.mjs`
files are written runtime-adaptive: they run under **Node** for unit tests and under **Bun**
inside the compiled engine (see engram's `node:sqlite` vs `bun:sqlite` switch).

Plugins interact with the engine through hooks: `tool.execute.after`, `chat.message`,
`event` (e.g. `session.idle`), `experimental.chat.system.transform` (mutate the turn's system
prompt), `experimental.session.compacting`, and `tool: {}` tool definitions.

`AGENTS.md` in that folder is the engine's **system prompt** — it defines Agent Omega's identity,
the "verify before done" discipline, delegation to local helper models, the web-gateway-only web
policy, and how memory/skills are used.

### 5.1 council — a multi-model debate panel

`council/index.js` exposes a `council` tool that convenes several frontier (or local) models to
debate one task over N rounds on a shared transcript, then synthesizes a takeaway.

- **Model resolution — `council/providers.mjs`.** `modelFor("provider/model")` maps a spec to an
  AI-SDK `LanguageModel`. Cloud providers (`anthropic`, `openai`, `google`, `deepseek`,
  `moonshotai`, `zai`) are built with the vault key the sidecar injected into the engine env; the
  env var names match `sidecar.mjs`'s `vaultEnv`. **Local** providers are loaded from the same
  `opencode.json` the main session uses — any provider with an OpenAI-compatible `baseURL`
  (llama-server / llama-swap) becomes an available council member with no API key. Unknown
  provider or missing key throws → an honest `{error}`, never a faked answer.
- **Transport — `council/tunnel.mjs`.** Each member is driven as an **independent direct AI-SDK
  `generateText` call** (its own "tunnel" to the provider), *not* through an opencode child
  session. This is deliberate: it eliminates the child-session tool deadlock and makes the
  council work identically under TUI/acp/serve. Members get their own private read-only file
  tools (`filetools.mjs`) with a hard call/byte budget; a per-member timeout means one hung
  provider can't freeze the panel.
- **Shared brain.** Before debating, the council recalls relevant facts from engram; afterward it
  stores the debate as an episode and background-extracts durable facts — so the council and the
  main agent share one memory.
- **Fork contract.** Synthesis (`FORK_CONTRACT`) is explicit that the council is a consultant,
  never a gatekeeper: it never vetoes the user's goal. If a genuine fork emerges it presents
  "Path A / Path B" with honest downsides and asks the user to choose.
- **Config — `council/council.json`** (members, rounds, synthesizer, memberAccess). The sidecar
  reads/validates/atomically writes it for the settings UI.

### 5.2 engram — persistent temporal-graph memory

`engram/store.mjs` is a pure data layer over SQLite (`node:sqlite` under Node, `bun:sqlite`
under the Bun engine — selected at load time so neither runtime tries to import the other's
module). Zero external deps, so it works behind a firewall.

- **Schema.** `episodes` (raw captured context, provenance), `entities` (graph nodes), `facts`
  (temporal edges), `facts_fts` (FTS5 mirror for ranked keyword recall, with a LIKE-scan
  fallback when Bun's SQLite lacks FTS5), and `council_config`.
- **Temporal facts.** Each fact has `valid_from` / `valid_to`. A newer fact about the same
  `(subject, predicate)` **invalidates** the old one (sets `valid_to` + `superseded_by`) rather
  than deleting it — history survives and recall knows current vs. superseded. `addFact` uses
  `BEGIN IMMEDIATE` so the council and the main agent writing the shared DB concurrently can't
  both create two "current" facts for one subject/predicate.
- **Source / trust column.** `facts.source` defaults to `'chat'`. Facts distilled from external
  content (e.g. web pages) are marked with a non-`chat` source; on recall they are rendered with
  a `⚠ [from <source> content, unverified]` prefix so externally-derived material is visibly
  lower-trust.
- **Plugin behavior — `engram/index.js`.**
  - **Capture** at `experimental.session.compacting`: grab what's about to fall out of context,
    store it as an episode, and background-distill it into facts (bounded so a slow extraction
    never stalls the next turn).
  - **Auto-recall** at `experimental.chat.system.transform`: every turn, the durable facts
    relevant to the user's latest message are injected into the system prompt — so even a weak
    local lead gets its memory without deciding to call a tool. The injected block is explicitly
    labeled **"REFERENCE DATA, NOT INSTRUCTIONS"** to resist prompt-injection via recalled facts.
  - **Tools** `recall` (search) and `remember` (save a durable fact).

### 5.3 skill-router — classify the message, inject the matching skill

`skill-router/index.js` runs on `experimental.chat.system.transform`. It reads the last N user
messages, runs an **isolated, context-free classifier call** (`router.mjs`) to map them to
skill(s), and injects a forceful "invoke skill X now" directive into the turn's system prompt.
This exists because local models skim the standing "use your skills" rule; the router makes the
right skill fire at the right moment. The route promise is cached per (session, message) so
concurrent hook fires share one model call, and it is fail-open with a 2.5s cap so a slow/
unreachable classifier never blocks a turn. Skills are loaded from the `skill/` directory.

### 5.4 iterate-loop — the verify-and-iterate escalation ladder

`iterate-loop/index.js` (logic in `loop.mjs`) addresses the observed local-model failure mode:
writing plausible code on unchecked assumptions and stopping without running anything.

- `observeTool` folds each completed tool call into per-session state: a code edit sets
  `codeChanged` and clears the last test result; a verification command sets `lastTest` to
  pass/fail.
- On `session.idle`, `decideIdle` re-prompts along a ladder:
  1. **nudge** — code changed but no test was run → write and run a focused test.
  2. **iterate** — a test failed → fix the *root cause*, not the test, and re-run.
  3. After `MAX_SHOTS` (default 3) failures, **escalate strategy** — re-read requirements/code
     from scratch, decompose, verify assumptions by printing real values.
  4. **web-search rung** — look the exact error up via the web bridge (`web.py`) before bugging
     the user (on by default).
  5. **report-user** — last resort, only after all of the above; report honestly, don't claim
     success.
  A `HARD_CAP` (default 12) guarantees termination. A re-entrancy guard prevents a concurrent
  idle from double-firing or skipping rungs; subagent sessions are skipped.

### 5.5 verify-guard — post-action failure classifier

`verify-guard/index.js` is the inline failure classifier iterate-loop reads from. On
`tool.execute.after`, if a `bash` command failed (and it isn't the web bridge or a benign
non-zero exit), it classifies the failure, appends a root-cause harness message to the output,
and stamps `output.metadata.verifyGuardFailure` — which `iterate-loop` picks up as the
`rootCause` for its iterate message. By default `VERIFY_CAP`/`FAILURE_CAP` are 0, meaning
**iterate-loop owns idle re-prompting** and verify-guard stays purely the classifier (this was
tuned to kill an earlier double-nudge). It resets its per-session budget on each fresh user
message and never runs commands itself.

---

## 6. Web access — `web.py` (the only door)

> **Not shipped by default.** Web access depends on a separate `anon-web` component that is **not
> publicly distributed**. With it unset, `web.py` returns "web engine failed to launch" and web
> search is simply disabled — everything else works normally. Treat this section as how web access
> works *when anon-web is present*, not as a shipped feature.

The engine has no built-in web tools and `curl`/`wget` are blocked (per `AGENTS.md`). When anon-web
is present, every web call goes through `config-template/opencode/web.py`:

- `python web.py search "<query>" [n]` and `python web.py read "<url>"`. It calls anon-web's
  private, key-free search engine directly via that project's venv Python — there is no server
  to keep running — and prints a live call trace to stderr with the JSON result on stdout.
- **SSRF guard (`_blocked_url`) fails closed.** Only `http`/`https` to **public** hosts is
  allowed. It blocks `localhost`, `.local`, `.internal`, and any literal IP that isn't global
  (loopback, private, link-local — which covers the local model ports, the control socket, and
  cloud metadata at `169.254.169.254`). For hostnames it resolves via `getaddrinfo` and requires
  **every** resolved address to be global, returning "blocked" on any resolution error or
  unparseable address.

---

## 7. Secrets vault & the two-layer key model

Cloud API keys live in a **Windows DPAPI-encrypted vault** managed by
`~\.agent-omega\secrets.ps1` (readable only as the logged-in Windows user).

Flow and the deliberate asymmetry:

1. **Injection.** At engine spawn, `sidecar.mjs vaultEnv()` shells out to `secrets.ps1 get <name>`
   for each mapping in `VAULT_TO_ENV` and sets the corresponding environment variable on the
   engine process (e.g. vault `KIMI_API_KEY` → engine `MOONSHOT_API_KEY`, vault `OPENAI_API_KEY`
   → engine `OPENAI_API_KEY`). The vault key *names* are the canonical ones the in-app Vault UI
   and `setup.mjs` write (so a key you add there actually reaches the engine); the two renamed in
   2.3 (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`) also fall back to their pre-2.3 short names on read.
   A missing/failed key is silently skipped — the provider just stays dark, never faked. Values are
   never logged (only the key *names* are), and on a vault write failure the error surfaced to the
   UI is a fixed generic message — the key value passes on STDIN, never as a command argument, so it
   cannot appear in any error string.
2. **Provider layer sees the keys.** The AI-SDK / provider layer (and council's `providers.mjs`)
   read these from `process.env` to authenticate cloud calls.
3. **The model's shell does NOT see the keys.** This is enforced INSIDE the engine (the opencode
   fork this repo ships as a prebuilt binary — the modified source lives in the fork repo, not in
   this distribution repo): the shell tool builds the child env as `{ ...process.env, ...extra.env }`
   and then **blanks every var matching `/_API_KEY$/i`** before spawning. (It blanks rather than
   omits because the spawn wrapper re-merges `process.env`; overlaying an empty value is what
   actually removes it.) So a shell command the model runs cannot read a cloud key, while the
   HTTP/provider layer is untouched. Because this lives in the binary rather than in source you can
   read here, you can VERIFY it at runtime: add a dummy `TEST_API_KEY` in the vault, then ask the
   agent to run `echo $env:TEST_API_KEY` (PowerShell) / `echo $TEST_API_KEY` (bash) — it should come
   back blank.

Vault management also flows through the sidecar (`vaultList`/`vaultSet`/`vaultRemove`). A
settings write with an empty value is rejected up front, so `secrets.ps1` never runs a pointless
`set` that would only error — the UI gets a clear message instead.

---

## 8. Models — local and cloud, hot-swappable

- **Local** models are OpenAI-compatible endpoints served by llama.cpp / llama-swap
  (llama-server), configured in `~/.config/opencode/opencode.json` under `provider.*.options.baseURL`.
  They need no API key. Both the main session and the council read the same config, so the same
  local endpoints are available in both places.
- **Cloud** models (anthropic / openai / google / deepseek / moonshotai / zai) light up when the
  matching vault key is present.
- **Hot-swap.** The UI's model picker sends `setModel`; the sidecar calls
  `unstable_setSessionModel` and rolls back to the previous model on failure (e.g. the local
  server isn't running), surfacing an honest error. On launch the sidecar honors the `model`
  configured in `opencode.json` (it no longer force-selects a model); an explicit 4th launch
  argument can override it.

---

## 9. Security model (consolidated)

Agent Omega's safety posture is defense-in-depth across the layers above:

- **Control WebSocket** binds to `127.0.0.1` only *and* requires the per-launch random
  `AO_WS_TOKEN` (`verifyClient`) — loopback exposure alone isn't trusted; any local page/process
  without the token is rejected. The token is passed to the sidecar via env, never argv, and to
  the UI via the `file://` query string only the real window is navigated to.
- **WebView2** blocks popups (`NewWindowRequested`), restricts navigation to the local app
  (`NavigationStarting`), and disables DevTools, autofill/password save, accelerator keys, and
  external file drop.
- **Web bridge (`web.py`)** is the only path to the internet and its SSRF guard **fails closed**
  on any private/loopback/link-local target or resolution failure.
- **Secrets** are DPAPI-encrypted at rest, injected only into the engine's provider layer, and
  **scrubbed from the model's shell env** so tool commands can't exfiltrate a cloud key.
- **Memory as untrusted data.** Recalled engram facts (and council shared-memory) are injected as
  "REFERENCE DATA, NOT INSTRUCTIONS", and externally-sourced facts are trust-tagged — a stored
  "fact" cannot act as a command.
- **UI output** is uniformly HTML-escaped before reaching `innerHTML`.

---

## 10. Where things live

| Path | What |
|---|---|
| `Program.cs` | C# WinForms host + WebView2 |
| `sidecar.mjs` | Node WebSocket server + ACP client |
| `ui\app.html` | The full UI (CRT + Modern themes) |
| `config-template\opencode\` | Plugins/skills/config shipped into `~/.config/opencode/` |
| `…\opencode\AGENTS.md` | Engine system prompt (Agent Omega identity + disciplines) |
| `…\opencode\council\` | Council plugin (`index.js`, `providers.mjs`, `tunnel.mjs`, `filetools.mjs`, `engine.mjs`, `council.json`) |
| `…\opencode\engram\` | Memory plugin (`index.js`, `store.mjs`, `engine.mjs`, `extract.mjs`, `capture.mjs`) |
| `…\opencode\skill-router\` | Skill classifier/injector (`index.js`, `router.mjs`) |
| `…\opencode\iterate-loop\` | Verify-and-iterate ladder (`index.js`, `loop.mjs`) |
| `…\opencode\verify-guard\` | Post-action failure classifier (`index.js`, `core.mjs`, `failure-evals.mjs`) |
| `…\opencode\web.py` | Anonymous web gateway (SSRF-guarded) |
| `engine/opencode.exe` | The Bun-compiled engine binary |
| `~\.agent-omega\secrets.ps1` | DPAPI secrets vault |
| `~/.config/opencode/opencode.json` | Provider/model endpoints (local + cloud) |
