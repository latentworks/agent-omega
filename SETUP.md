# Setup

Agent Omega is a Windows desktop app: a frameless **WebView2 shell** → a **Node sidecar** → the **`opencode` engine**, with a plugin config that lives in `~/.config/opencode`. This gets it running from a clone.

> A macOS build is planned — the full porting plan is in [`docs/MAC_BRANCH.md`](docs/MAC_BRANCH.md).

## 1. Prerequisites

| Need | Why | Check |
|---|---|---|
| **Windows 10/11** | the shell is WinForms + WebView2 | — |
| **.NET 8 SDK** | builds the shell | `dotnet --version` ≥ 8 |
| **Node.js 18+** (20 LTS recommended) | runs the sidecar + plugins | `node --version` |
| **WebView2 Runtime** | hosts the UI (preinstalled on most Win11) | [evergreen installer](https://developer.microsoft.com/microsoft-edge/webview2/) if missing |
| **Python 3.9+** *(optional)* | required by the separate anon-web component for web search only | `python --version` |

> On Node 18/19 the plugin install may print a harmless `EBADENGINE` warning from a transitive dependency — safe to ignore (Node 20 LTS avoids it).

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

After step 3, run the wizard instead of steps 4–6 by hand. It installs the plugin config + the encrypted vault, checks the engine, and configures your model + API key interactively:

```
node setup.mjs
```

It'll ask whether you're running a local model, Claude, ChatGPT, or another cloud provider, store your key in the encrypted vault, and set the default model. The wizard replaces the config + vault + model work (**steps 4 and 6**). You still need the **engine** (step 5 — only if the wizard reports one missing) and the **build** (step 7). The manual steps 4–6 below are what it automates.

## 4. Install the plugin config

Copy the shipped config into opencode's config directory, and the encrypted vault script into place:

```powershell
Copy-Item -Recurse -Force config-template\opencode "$env:USERPROFILE\.config\opencode"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agent-omega" | Out-Null
Copy-Item -Force scripts\secrets.ps1 "$env:USERPROFILE\.agent-omega\secrets.ps1"
```

## 5. Get the engine

The `opencode` engine ships as a prebuilt binary. Because Agent Omega runs a **fork** of opencode, use **this repo's** release (not upstream):

- Download **`opencode.exe`** from the [v2.1.0 release](https://github.com/latentworks/agent-omega/releases/tag/v2.1.0).
- Put it in an **`engine\` folder at the repo root** (`agent-omega\engine\opencode.exe`) — the build (step 7) copies it beside the exe automatically.
- (Alternative, works any time: `setx AGENT_OMEGA_ENGINE "C:\full\path\to\opencode.exe"`, then reopen your terminal.)

## 6. Configure your model + keys

Open `~/.config/opencode/opencode.json` and choose a setup:

**Cloud (simplest).** Set `"model"` to a provider you have a key for — e.g. `anthropic/claude-opus-4-8`, `openai/gpt-5.5`, `google/gemini-3.5-flash`. Provide the key either as an environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or via the encrypted vault (below).

**Local.** Point the `local` provider's `baseURL` at your llama.cpp / Ollama / LM Studio server (default `http://127.0.0.1:8080/v1`), give it a model id, and set `"model": "local/local-model"`. The `helper1` / `helper2` worker subagents also delegate to the `local` provider — so a cloud lead can hand grunt work down to a local model.

### The encrypted vault (recommended for keys)

Instead of plaintext environment variables, Agent Omega can read API keys from a **Windows-DPAPI-encrypted vault** at `~/.agent-omega/secrets.ps1` — keys are encrypted at rest, readable only by your Windows user, and never written into code, logs, or the model's shell. The easiest way to add keys is the **wizard** (`node setup.mjs`) or the app's **Settings → Vault** screen — both store them under the exact names the engine expects. (Override the vault location with `AGENT_OMEGA_VAULT`.) See [TECHNICAL.md](TECHNICAL.md) for the two-layer key model.

## 7. Build + run

```
dotnet build -c Release
.\bin\Release\net8.0-windows\agent-omega.exe
```

The sidecar, UI, and engine are resolved relative to the exe; a scratch workspace is created at `~/.agent-omega/workspace`.

## Optional: built-in web search

The key-free web search relies on a separate **anon-web** component, which is **not publicly distributed** — so web search is unavailable in this build unless you already have it. If you do, set `AGENT_OMEGA_ANONWEB` (its path) and `AGENT_OMEGA_ANONWEB_VENV` (its venv Python). Without it, web search is simply disabled — nothing else is affected.

## Troubleshooting

- **"Could not select model" on launch** — the `"model"` in `opencode.json` points at a provider with no key or no reachable endpoint. Fix the model id or add the key, then relaunch.
- **First cloud call fails right after adding a key to the vault** — the engine reads keys at startup; restart the app once so it picks them up.
- **Blank window** — install the WebView2 Runtime (see prerequisites).
- **`helper1`/`helper2` delegation errors** — you have no `local` provider configured; either point `local.baseURL` at a running local server or just let the lead work inline.
