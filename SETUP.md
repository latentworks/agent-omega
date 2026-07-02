# Setup

Agent Omega is a desktop app: a frameless **WebView shell** → a **Node sidecar** → the **`opencode` engine**, with a plugin config that lives in `~/.config/opencode`. This gets it running from a clone.

## macOS

Same model as Windows — **get the code and launch it from the terminal.** A locally-built app carries no quarantine flag, so macOS runs it directly; there is no "clickable installer" or code-signing requirement. The native build (`mac/AgentOmega.swift` — a Swift + WKWebView shell) targets **Apple Silicon (arm64), macOS 13+**, and is **self-contained at runtime** — no Node or Python needed (the sidecar and engine are compiled binaries; the vault uses the macOS Keychain).

**Build-time tools** (to build, not to run): Xcode Command Line Tools (`xcode-select --install`), [bun](https://bun.sh), and Node/npm.

1. Get the engine so `engine/opencode` exists. **Easiest: download the prebuilt `opencode-darwin-arm64` from the [v2.2.1 release assets](https://github.com/latentworks/agent-omega/releases/tag/v2.2.1)** and verify it against the release's `SHA256SUMS`. (Building from source requires the engine fork, which is not public.) Or build the engine once so `engine/opencode` exists — [`docs/MAC_BRANCH.md`](docs/MAC_BRANCH.md) Phase 0 (`bun run packages/opencode/script/build.ts --single --skip-embed-web-ui` in the fork, then copy the result to `engine/opencode`). A *downloaded* engine binary is quarantined — clear it with `xattr -dr com.apple.quarantine engine/opencode` (the Mac analog of Windows "Unblock"); one you build locally isn't. A downloaded binary should also be checksum-verified: compare `shasum -a 256 engine/opencode` against the SHA-256 published with the release you took it from.
2. **Launch:** `sh mac/run.sh` — builds the self-contained `AgentOmega.app` once and launches it. (Equivalently: `sh mac/build-app.sh` then `open mac/build/AgentOmega.app`; or `sh mac/install.sh` to also copy it to `/Applications`.)
3. First run installs the config + Keychain vault into your home and shows how to add a model.
4. **Add a model** (same requirement as Windows — the agent needs one): open Settings (`⌃,`, the gear icon, or `/settings`) → **Vault** → paste an API key (Anthropic / OpenAI / Google / DeepSeek / Moonshot / Z.AI), or run a local server (llama.cpp / Ollama / LM Studio) and pick the `local` model. **Local models need a large context window** — Agent Omega's system prompt is big, so start your server with plenty of context (e.g. `llama-server -c 32768 --parallel 2`; llama.cpp divides `-c` across parallel slots). A too-small context fails every turn with "context size exceeded". Verified working locally with Qwen2.5-1.5B-Instruct on an 8 GB M-series Mac.

By default each session runs in a scratch workspace at `~/Library/Application Support/AgentOmega/workspace`. To work on a real project, launch with `AGENT_OMEGA_WORKDIR=/path/to/project sh mac/run.sh`. Logs: `~/Library/Logs/AgentOmega/sidecar.log`.

**Optional — web search:** the agent's `web.py` gateway needs the separate anon-web component (same as Windows — not publicly distributed). If you have it, put the `anonweb/` package at `~/anon-web/anonweb/`, then `python3 -m venv ~/anon-web/.venv` and `~/anon-web/.venv/bin/pip install lxml trafilatura readability-lxml`. The shell auto-detects `~/anon-web` on launch and wires `AGENT_OMEGA_ANONWEB`/`_VENV`; without it, web search is simply disabled (nothing else is affected).

**Optional — a signed, double-clickable build for non-technical people:** only if you want to hand a *downloaded* `.dmg` to someone who won't open a terminal, `mac/sign-notarize.sh` does the Developer-ID sign + notarize + staple (needs an Apple Developer ID, $99/yr). Not needed for the terminal launch above.

The rest of this document covers the **Windows** setup.

## 1. Prerequisites

| Need | Why | Check |
|---|---|---|
| **Windows 10/11** | the shell is WinForms + WebView2 | — |
| **git** | clone the repo (or download the ZIP) | `git --version` |
| **.NET 8 SDK** | builds the shell | `dotnet --version` ≥ 8 |
| **Node.js 18+** (20 LTS recommended) | runs the sidecar + plugins | `node --version` |
| **WebView2 Runtime** | hosts the UI (preinstalled on most Win11) | [evergreen installer](https://developer.microsoft.com/microsoft-edge/webview2/) if missing |
| **Python 3.9+** *(optional)* | required by the separate anon-web component for web search only | `python --version` |

> The plugin install may print a harmless `EBADENGINE` warning from a transitive dependency (`ini`) whose `engines` field lags current Node — safe to ignore.

## 2. Get the code

```
git clone https://github.com/latentworks/agent-omega.git
cd agent-omega
```

## 3. Install dependencies

```
npm install                                     # sidecar deps (ws + the ACP sdk)
npm install --prefix config-template/opencode   # plugin deps
```

## Quick setup (recommended)

After step 3, run the wizard instead of steps 4 and 6 by hand (you still need step 5 — the engine). It installs the plugin config + the encrypted vault, checks the engine, and configures your model + API key interactively:

```
node setup.mjs
```

It'll ask whether you're running a local model, Claude, ChatGPT, or another cloud provider, store your key in the encrypted vault, and set the default model. The wizard replaces the config + vault + model work (**steps 4 and 6**). You still need the **engine** (step 5 — only if the wizard reports one missing) and the **build** (step 7). The manual steps 4–6 below are what it automates.

## 4. Install the plugin config

Copy the shipped config into opencode's config directory, and the encrypted vault script into place:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode" | Out-Null
Copy-Item -Recurse -Force config-template\opencode\* "$env:USERPROFILE\.config\opencode"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agent-omega" | Out-Null
Copy-Item -Force scripts\secrets.ps1 "$env:USERPROFILE\.agent-omega\secrets.ps1"
```

## 5. Get the engine

The `opencode` engine ships as a prebuilt binary. Because Agent Omega runs a **fork** of opencode, use **this repo's** release (not upstream):

- Download **`opencode.exe`** from the [v2.2.0 release](https://github.com/latentworks/agent-omega/releases/tag/v2.2.0). (The engine binary is unchanged in 2.2.1 — the v2.2.0 asset is still current.)
- **Verify the download** before you trust it (it's an unsigned binary you're about to run with your privileges). The SHA-256 for the `opencode.exe` is:
  ```
  2277235acbfbf6970e760b18f33e0171e006758ae755a31b3940ad784e6e01ab
  ```
  Check it: `Get-FileHash .\engine\opencode.exe -Algorithm SHA256` and confirm the hash matches. If it doesn't match, do NOT run it — re-download.
- Put it in an **`engine\` folder at the repo root** (`agent-omega\engine\opencode.exe`) — the build (step 7) copies it beside the exe automatically.
- (Alternative, works any time: `setx AGENT_OMEGA_ENGINE "C:\full\path\to\opencode.exe"`, then reopen your terminal.)

## 6. Configure your model + keys

Open `%USERPROFILE%\.config\opencode\opencode.json` (that's what `~/.config/opencode/` means — `~` is your user folder, `C:\Users\<name>`) and choose a setup:

**Cloud (simplest).** Set `"model"` to a provider you have a key for — e.g. `anthropic/claude-opus-4-8`, `openai/gpt-5.5`, `google/gemini-3.5-flash`. Provide the key either as an environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or via the encrypted vault (below).

**Local.** Point the `local` provider's `baseURL` at your llama.cpp / Ollama / LM Studio server (default `http://127.0.0.1:8080/v1`), give it a model id, and set `"model": "local/local-model"`. The `helper1` / `helper2` worker subagents also delegate to the `local` provider — so a cloud lead can hand grunt work down to a local model.

### The encrypted vault (recommended for keys)

Instead of plaintext environment variables, Agent Omega can read API keys from a **Windows-DPAPI-encrypted vault** at `~/.agent-omega/secrets.ps1` — keys are encrypted at rest, readable only by your Windows user, and never written into code, logs, or the model's shell. The easiest way to add keys is the **wizard** (`node setup.mjs`) or the app's **Settings → Vault** screen — both store them under the exact names the engine expects. (Override the vault location with `AGENT_OMEGA_VAULT`.) See [TECHNICAL.md](TECHNICAL.md) for the two-layer key model.

## 7. Build + run

```
dotnet build -c Release
.\bin\Release\net8.0-windows\agent-omega.exe
```

The sidecar, UI, and engine are resolved relative to the exe.

### Working on a real project (vs the scratch workspace)

By default each session runs in a scratch workspace at `%LOCALAPPDATA%\AgentOmega\workspace`. To point Agent Omega at an actual project, launch it with a workdir:

```
.\bin\Release\net8.0-windows\agent-omega.exe --workdir "C:\path\to\your\project"
```

(Or set `AGENT_OMEGA_WORKDIR` before launching.) The agent then reads, writes, and runs commands in that folder.

### Optional: smoke-test your install

Before relying on it, confirm the wiring is sound (no app launch, no model spend):

```
node scripts\smoke.mjs
```

It checks Node, the config install, the vault script, the engine binary, plugin deps, and that the shipped plugins parse and their endpoints resolve — and prints PASS/FAIL per check.

## Optional: built-in web search

The key-free web search relies on a separate **anon-web** component, which is **not publicly distributed** — so web search is unavailable in this build unless you already have it. If you do, set `AGENT_OMEGA_ANONWEB` (its path) and `AGENT_OMEGA_ANONWEB_VENV` (its venv Python). Without it, web search is disabled: the agent is told it has no web access and continues without it, and the iterate-loop's "search the web" escalation rung is skipped automatically (it never sends the agent to a dead bridge).

## Advanced: environment overrides

All optional — the defaults are derived from your `opencode.json`, so you normally set none of these:

- `AGENT_OMEGA_WORKDIR` — the project folder to work in (same as `--workdir`).
- `ROUTER_EXTRACT_URL`, `ROUTER_MODEL` — override the skill-router's classify endpoint/model (default: your `local` provider's `baseURL` + model).
- `ENGRAM_EXTRACT_URL`, `ENGRAM_MODEL` — override the memory distiller's endpoint/model (same default).
- `ITERATE_WEB_SEARCH=0|1` — force the iterate-loop web-search rung off/on (default: on only if anon-web is configured).

## Upgrading

To move to a newer version, `git pull` and re-run `node setup.mjs`. The wizard detects an existing Agent Omega install and **updates the plugin/skill code in place while preserving your data** — it does not touch your `opencode.json`, your council roster (`council/council.json`), your memory (`memory/` and the engram database). Then re-run the build (step 7) and grab the matching engine binary if the release changed (step 5). Never hand-delete `~/.config/opencode` to "reinstall" — that wipes your memory and configuration.

## Uninstalling

Deleting the cloned repo removes the app, but three things live outside it and persist until you remove them:

- `~/.agent-omega\` — the encrypted key vault (`vault.dat`), the vault script, and logs.
- `%LOCALAPPDATA%\AgentOmega\` — the scratch workspace.
- `~/.config\opencode\` — the plugin config, your `opencode.json`, and the engram memory database.
- `%TEMP%\agent-omega-webview2\` — the WebView2 browser profile.

Remove those folders to fully uninstall. `vault.dat` holds your API keys (DPAPI-encrypted, readable only by your Windows user) — delete it to erase them.

## Troubleshooting

- **"Could not select model" on launch** — the `"model"` in `opencode.json` points at a provider with no key or no reachable endpoint. Fix the model id or add the key, then relaunch.
- **A crash / "engine exited" you can't explain** — the sidecar and engine now log to `~/.agent-omega\logs\sidecar.log`. Open it (the engine-down message also names the path) — the real error is there.
- **First cloud call fails right after adding a key** — adding a key in Settings → Vault reloads the engine automatically and keeps your current conversation; if the very first call still fails, restart the app once.
- **Blank window** — install the WebView2 Runtime (see prerequisites).
- **`helper1`/`helper2` delegation errors** — you have no `local` provider configured; either point `local.baseURL` at a running local server or just let the lead work inline.
- **Engine won't start / "engine-down" right after downloading it** — Windows SmartScreen/antivirus may have quarantined the unsigned `opencode.exe`. Run `Unblock-File .\engine\opencode.exe`, and allowlist it in your antivirus if needed.
- **Behind a corporate proxy** — `npm install` and the engine download honor `HTTP_PROXY`/`HTTPS_PROXY`; set those (or `npm config set proxy <url>`) before steps 3 and 5.
