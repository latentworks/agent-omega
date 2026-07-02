# Linux Browser-Mode Setup

This path runs the existing Agent Omega core stack on Linux: `ui/app.html`, `sidecar.mjs`, the opencode config, and a Linux `opencode` engine. It does not ship a native Linux desktop shell; WinForms/WebView2 remains Windows-only.

## Prerequisites

| Need | Why | Check |
|---|---|---|
| git | clone the repo | `git --version` |
| Node.js 18+ | runs the sidecar, setup, and plugins | `node --version` |
| npm | installs sidecar and plugin dependencies | `npm --version` |
| xdg-open | opens browser mode from the launcher | `xdg-open --version` |
| Linux opencode engine | runs `opencode acp` | `opencode --help` or local binary |

## Install

```bash
npm install
npm install --prefix config-template/opencode
node setup.mjs --non-interactive --source local --url http://127.0.0.1:8080/v1
```

## Engine

Build it from the engine fork (same as the macOS flow, different target):

```bash
cd /path/to/opencode-fork
bun run packages/opencode/script/build.ts --single --skip-embed-web-ui   # add the linux target for your arch
# copy dist/opencode-linux-<arch>/bin/opencode to ./engine/opencode
```

Or provide an existing binary with one of these options:

```bash
export AGENT_OMEGA_ENGINE=/path/to/opencode
```

or place it at:

```bash
./engine/opencode
chmod +x ./engine/opencode
```

or install `opencode` on `PATH`.

If the engine is missing, browser mode still opens and the sidecar reports a clean `engine-down` message.

## Keys

Linux reads cloud API keys from normal environment variables first:

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export DEEPSEEK_API_KEY=...
export ZAI_API_KEY=...
export MOONSHOT_API_KEY=...
export GOOGLE_GENERATIVE_AI_API_KEY=...
```

The in-app Vault screen can also write a simple fallback file at `~/.agent-omega/vault.json` with mode `0600`. This is a local convenience fallback, not encrypted storage like the Windows DPAPI vault.

## Launch

```bash
npm run start:linux
```

The launcher starts `sidecar.mjs`, generates a local WebSocket token, and opens:

```text
ui/app.html?host=browser&ws=4599&token=...
```

By default each session runs in a scratch workspace at `~/.local/share/agent-omega/workspace`. To work on a real project:

```bash
AGENT_OMEGA_WORKDIR=/path/to/project npm run start:linux
```

Override the port if needed:

```bash
AGENT_OMEGA_PORT=4600 npm run start:linux
```

## Validate

```bash
npm run smoke:linux
npm run check:linux-portability
```

This confirms browser-mode portability for the existing Agent Omega core stack. It does not claim native Linux desktop portability.
