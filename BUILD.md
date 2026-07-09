# Building Agent Omega — one codebase, two OS hosts

Agent Omega ships on **Windows and macOS from a single trunk**. This is the map of how that
works, so nobody has to re-derive it.

## The layout: ~80% shared, a thin per-OS host

```
SHARED (identical bytes on every OS)          PER-OS HOST (one file each)
  sidecar.mjs        engine driver              Program.cs            Windows shell (WinForms + WebView2)
  ui/                the web UI                  scripts/secrets.ps1   Windows vault (DPAPI)
  config-template/   plugins, skills, prompts    mac/AgentOmega.swift  macOS shell (AppKit + WKWebView)
  engine/            opencode fork (per-arch)    mac/secrets.sh        macOS vault (Keychain)
```

The host opens a window, loads the shared `ui/` into a webview, spawns the shared `sidecar.mjs`,
and provides a vault. **Everything below that line is the same on both OSes.** Where a shared
file must vary (engine filename, vault launcher, default paths) it branches on
`process.platform` inline — it is never forked.

## Build entrypoints (the "Makefile.Darwin / Makefile.Windows" pattern)

Each OS has a named entrypoint in the repo root that compiles *its* host and bundles the shared
core. Same convention, different toolchains (Swift vs .NET):

| | macOS / Linux | Windows |
|---|---|---|
| entrypoint | `make` (`Makefile`) | `.\build.ps1` |
| deps | `make deps` | `.\build.ps1 deps` |
| build | `make build` → `mac/build-app.sh` → `AgentOmega.app` | `.\build.ps1 build` → `dotnet build -c Release` → `agent-omega.exe` |
| run | `make run` | `.\build.ps1 run` |

The **engine** binary (`engine/opencode` on macOS, `engine/opencode.exe` on Windows) is built
once per architecture from the fork (see `docs/MAC_BRANCH.md` Phase 0) and is **not** committed —
it's fetched/built at setup time. `make engine` / `.\build.ps1 engine` just checks it's present.

## CI: one push, two jobs

`.github/workflows/build.yml` runs on every push/PR:
- **shared** (ubuntu, Node 24) — `node --check` the sidecar + every plugin, then **run the
  shared-core unit tests** (`node --test`, or `npm test`) that actually execute the pure-logic
  brain against real inputs, and validate config. (`node --check` only parses; the tests prove
  behavior. Node 24 because `engram/store.mjs` uses the built-in `node:sqlite`.)
- **macOS** — `swiftc -parse` the Swift host, lint the shell scripts, `plutil` the Info.plist.
- **Windows** — `dotnet build` the WinForms host.

So a single commit is proven to compile on both OSes automatically. (Producing a full *signed*
release bundle needs the engine binary + an Apple Developer ID, so that's a separate,
manually-triggered release job — not per-commit CI.)

## The workflow — and the one rule that keeps it sane

Everything lives on **one trunk (`main`)**. Both hosts coexist there and never conflict (they're
different files). Because of that:

- **A shared-code fix is made once and benefits both OSes.** (e.g. the engine-API auth fix lives
  in `sidecar.mjs` + `ui/app.html`, so it closes the same hole on Windows and macOS.)
- **A host fix touches only that host's file** (`Program.cs` or `mac/AgentOmega.swift`).

> **The rule:** never edit shared code on a divergent branch and leave it there. That's how the
> two OSes drift apart. Land shared changes on `main`; each OS's CI builds from the same commit.

If you later add Linux, it's a `linux/` host dir + a `build` target — the shared 80% is untouched
(`sidecar.mjs` already has the Linux/XDG branch).
