# Setup

Agent Omega is a Windows desktop app: a frameless **WebView2 shell** → a **Node sidecar** → the **`opencode` engine**, with a plugin config that lives in `~/.config/opencode`. This gets it running from a clone.

> A macOS build is planned — the full porting plan is in [`docs/MAC_BRANCH.md`](docs/MAC_BRANCH.md).

## macOS

Same model as Windows — **get the code and launch it from the terminal.** A locally-built app carries no quarantine flag, so macOS runs it directly; there is no "clickable installer" or code-signing requirement. The native build (`mac/AgentOmega.swift` — a Swift + WKWebView shell) targets **Apple Silicon (arm64), macOS 13+**, and is **self-contained at runtime** — no Node or Python needed (the sidecar and engine are compiled binaries; the vault uses the macOS Keychain).

**Build-time tools** (to build, not to run): Xcode Command Line Tools (`xcode-select --install`), [bun](https://bun.sh), and Node/npm.

1. Build the engine once so `engine/opencode` exists — [`docs/MAC_BRANCH.md`](docs/MAC_BRANCH.md) Phase 0 (`bun run packages/opencode/script/build.ts --single --skip-embed-web-ui` in the fork, then copy the result to `engine/opencode`). A *downloaded* engine binary is quarantined — clear it with `xattr -dr com.apple.quarantine engine/opencode` (the Mac analog of Windows "Unblock"); one you build locally isn't.
2. **Launch:** `sh mac/run.sh` — builds the self-contained `AgentOmega.app` once and launches it. (Equivalently: `sh mac/build-app.sh` then `open mac/build/AgentOmega.app`; or `sh mac/install.sh` to also copy it to `/Applications`.)
3. First run installs the config + Keychain vault into your home and shows how to add a model.
4. **Add a model** (same requirement as Windows — the agent needs one): open Settings (`⌃,`, the gear icon, or `/settings`) → **Vault** → paste an API key (Anthropic / OpenAI / Google / DeepSeek / Moonshot / Z.AI), or run a local server (llama.cpp / Ollama / LM Studio) and pick the `local` model.

**Optional — a signed, double-clickable build for non-technical people:** only if you want to hand a *downloaded* `.dmg` to someone who won't open a terminal, `mac/sign-notarize.sh` does the Developer-ID sign + notarize + staple (needs an Apple Developer ID, $99/yr). Not needed for the terminal launch above.

The rest of this document covers the **Windows** setup.

## 1. Prerequisites

| Need | Why | Check |
|---|---|---|
| **Windows 10/11** | the shell is WinForms + WebView2 | — |
| **.NET 8 SDK** | builds the shell | `dotnet --version` ≥ 8 |
| **Node.js 18+** | runs the sidecar + plugins | `node --version` |
| **WebView2 Runtime** | hosts the UI (preinstalled on most Win11) | [evergreen installer](https://developer.microsoft.com/microsoft-edge/webview2/) if missing |
| **Python 3.9+** *(optional)* | only for the built-in web search | `python --version` |

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

## 4. Install the plugin config

Copy the shipped config into opencode's config directory:

```powershell
Copy-Item -Recurse -Force config-template\opencode "$env:USERPROFILE\.config\opencode"
```

## 5. Get the engine

The `opencode` engine ships as a prebuilt binary. Because Agent Omega runs a **fork** of opencode, use **this repo's** release (not upstream):

- Download `opencode.exe` from this repo's **Releases**.
- Put it at `agent-omega\engine\opencode.exe` (beside the built app), or set the `AGENT_OMEGA_ENGINE` environment variable to its full path.

## 6. Configure your model + keys

Open `~/.config/opencode/opencode.json` and choose a setup:

**Cloud (simplest).** Set `"model"` to a provider you have a key for — e.g. `anthropic/claude-opus-4-8`, `openai/gpt-5.5`, `google/gemini-3.5-flash`. Provide the key either as an environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or via the encrypted vault (below).

**Local.** Point the `local` provider's `baseURL` at your llama.cpp / Ollama / LM Studio server (default `http://127.0.0.1:8080/v1`), give it a model id, and set `"model": "local/local-model"`. The `helper1` / `helper2` worker subagents also delegate to the `local` provider — so a cloud lead can hand grunt work down to a local model.

### The encrypted vault (recommended for keys)

Instead of plaintext environment variables, Agent Omega can read API keys from a **Windows-DPAPI-encrypted vault** at `~/.agent-omega/secrets.ps1` — keys are encrypted at rest, readable only by your Windows user, and never written into code, logs, or the model's shell. (Override the location with `AGENT_OMEGA_VAULT`.) See [TECHNICAL.md](TECHNICAL.md) for the two-layer key model.

## 7. Build + run

```
dotnet build -c Release
.\bin\Release\net8.0-windows\agent-omega.exe
```

The sidecar, UI, and engine are resolved relative to the exe; a scratch workspace is created at `~/.agent-omega/workspace`.

## Optional: built-in web search

The key-free web search uses the separate **anon-web** component. Install it, then set `AGENT_OMEGA_ANONWEB` (its path) and `AGENT_OMEGA_ANONWEB_VENV` (its venv Python). Without it, web search is simply disabled — nothing else is affected.

## Troubleshooting

- **"Could not select model" on launch** — the `"model"` in `opencode.json` points at a provider with no key or no reachable endpoint. Fix the model id or add the key, then relaunch.
- **First cloud call fails right after adding a key to the vault** — the engine reads keys at startup; restart the app once so it picks them up.
- **Blank window** — install the WebView2 Runtime (see prerequisites).
- **`helper1`/`helper2` delegation errors** — you have no `local` provider configured; either point `local.baseURL` at a running local server or just let the lead work inline.
