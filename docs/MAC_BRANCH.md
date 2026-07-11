# Agent Omega — macOS Install Branch Plan

> **Historical plan, implemented on `main`.** The current Apple Silicon shell,
> Keychain vault, and packaging path live under `mac/`; see `SETUP.md` and
> `mac/build-app.sh`. The production engine source and native macOS assets are
> public at [`latentworks/opencode-omega`](https://github.com/latentworks/opencode-omega).

Investigation + concrete port plan for a dedicated **macOS** build of Agent Omega
(Apple Silicon `darwin-arm64` **and** Intel `darwin-x64`). At the time of this
investigation Agent Omega was Windows-only: a C# WinForms + WebView2 shell, a Node ACP sidecar, a Bun-compiled
`opencode` engine, a DPAPI/PowerShell secrets vault, and a set of Node/Python engine
plugins.

The good news up front: **the app is already ~75% portable.** The engine, the sidecar,
the entire web UI, the plugins, and the config are cross-platform or trivially made so.
The Windows lock-in is concentrated in exactly three places — **the shell, the vault
backend, and the compiled engine binary** — plus a layer of shell-flavor prompt text.

---

## 0. TL;DR

- **What carries over unchanged:** the whole `ui/` folder (single-file `app.html` + its
  `.js`/`.css`), all six engine plugins, `web.py`, `council.json`/`opencode.json`, and
  ~95% of `sidecar.mjs`.
- **What must be replaced:** (1) the **shell** — C# WinForms/WebView2 has no macOS
  runtime; (2) the **vault** — DPAPI/`secrets.ps1` → macOS Keychain; (3) the **engine
  binary** — the Windows `.exe` cannot run, need a `darwin` Mach-O build of the fork;
  (4) **PowerShell → zsh/bash** in the prompt/skill text the model reads.
- **Recommended shell:** **native Swift + WKWebView** (smallest bundle, cleanest
  notarization, 1:1 host-bridge mapping), with **Electron as the pragmatic fallback**
  if WebKit rendering parity bites or you want to unify all OSes under one shell.
- **Rough effort:** **~2–3 weeks (≈10–15 focused days)** to a signed, notarized first
  build with the Swift route; **~1.5–2 weeks** with Electron (less shell + notarization
  effort, at the cost of a ~200 MB bundle). The shell and the notarization/entitlements
  pass are the two real time-sinks; the sidecar/vault/config work is only a few days.

---

## 1. What's already cross-platform (carries over unchanged)

Confirmed by reading the source:

### 1.1 The Node sidecar — `sidecar.mjs` (~95% portable)
Pure Node. It uses only cross-platform primitives: `node:child_process`, `node:stream`,
`node:fs`, `node:path`, `node:os` (`os.homedir()`), the `ws` package, and
`@agentclientprotocol/sdk`. The WebSocket server binds `127.0.0.1` (loopback — identical
on macOS), the ACP transport is ndjson over stdin/stdout (OS-agnostic), and the working
dir is `os.homedir()/.agent-omega/workspace` (resolves correctly on macOS). The token is
passed via the `AO_WS_TOKEN` env var, not argv — also identical.

**Only two lines in the sidecar are Windows-flavored** and both are easy branches:
- **Engine path default** (line 13): `path.join(import.meta.dirname, 'engine', 'opencode.exe')`
  — hardcodes `.exe`. Needs a platform branch (`.exe` on win32, no suffix on darwin). It's
  already overridable via `AGENT_OMEGA_ENGINE`, so the fix is just a better default.
- **Vault shell-outs** (`vaultEnv`, `vaultListNames`, `vaultSet`, `vaultRemove`) call
  `execFileSync('powershell', ['-File', secrets.ps1, ...])`. These get abstracted behind a
  tiny vault interface (see §2.2). Everything else in the sidecar is untouched.

### 1.2 The web UI — the whole `ui/` folder
`app.html` is a **single self-contained HTML/JS/CSS file, no framework, no build step** —
inherently portable. Its `.js` companions (`ao-boot-3.js`, `omega-globe.js`,
`command-discovery.js`, `crt-settings.js`, `command-discovery.js`) and `modern-theme.css`
are plain browser code. Transport is a loopback WebSocket read from
`location.search` (`?ws=<port>&token=<token>`) — **host-agnostic; any webview that can open
`ws://127.0.0.1` works**, which all shell candidates do.

The UI touches the host in exactly **one narrow seam**: `window.chrome.webview` (a WebView2
global) for:
- **Window controls** — `post({type:'close'|'minimize'|'maximize'|'drag'})` in
  `app.html` (line 405).
- **An `api-get` host proxy** in `command-discovery.js` (lines 67, 74) — sends
  `{type:'api-get',...}` and listens for `api-result` replies. **Note: this is a dead/no-op
  path today** — `Program.cs`'s `OnUiMessage` only handles close/min/max/drag, so the
  Windows host never answers `api-get` (the UI just falls back to a direct `fetch`). The Mac
  shim only needs to *not crash* on it.

So the UI carries over **byte-for-byte**; the only adaptation is a ~20-line injected shim
that re-creates `window.chrome.webview` (see §2.1). The CSS already uses `-webkit-`
scrollbar styling, which is a *point in WebKit's favor*, not against it.

### 1.3 The engine plugins — all five
`council`, `engram`, `skill-router`, `iterate-loop`, `verify-guard` are pure Node/Bun with
**zero external deps** and are already written **runtime-adaptive** (e.g. engram's
`node:sqlite` under Node for tests vs `bun:sqlite` inside the compiled engine). `council.json`,
`opencode.json`, the `skill/` + `command/` + `themes/` folders, and `AGENTS.md` are all
plain data/text. `filetools.mjs` already does `process.env.USERPROFILE || process.env.HOME`
— **it's already cross-platform.** These install to `~/.config/opencode/` on both OSes.

### 1.4 `web.py` — the web gateway
Env-driven: the anon-web venv Python path comes from `AGENT_OMEGA_ANONWEB_VENV`, so it just
points at the macOS venv. The SSRF guard is pure `socket`/`ipaddress` — OS-agnostic. Carries
over; only the env var value differs.

### 1.5 Home-relative / env-driven paths
`~/.agent-omega/workspace`, `~/.config/opencode/`, `~/.config/opencode/council/council.json`,
and the vault path (`AGENT_OMEGA_VAULT`) are all `os.homedir()`-relative or env-overridable.
These resolve to `/Users/<name>/...` on macOS with no change.

---

## 2. What's Windows-locked and must be replaced

### 2.1 THE SHELL — C# WinForms + WebView2 (no macOS runtime)

`Program.cs` is `net8.0-**windows**`, `UseWindowsForms`, `Microsoft.Web.WebView2.WinForms`,
and P/Invokes `user32.dll` (`ReleaseCapture`/`SendMessage` for frameless drag, `WM_NCHITTEST`
for edge-resize). **None of this exists on macOS.** The shell must be rebuilt natively. Its
job is small and well-defined, which makes the port tractable — it must:

1. Host the WebView loading `file://…/ui/app.html?ws=<port>&token=<GUID>`.
2. Generate a per-launch random token, spawn `node sidecar.mjs <WORKDIR> <PORT>` with
   `AO_WS_TOKEN=<token>` in the env, and kill it on close.
3. Provide a frameless window with custom drag + resize and close/min/max controls.
4. Bridge **window controls only** back from the UI (re-create `window.chrome.webview`).
5. Apply the WebView hardening (no popups, navigation locked to `file://`, no DevTools/
   autofill).

#### The four realistic options, judged against *this* app

| Criterion | (a) Swift + WKWebView | (b) Electron | (c) Tauri | (d) .NET MAUI / Avalonia |
|---|---|---|---|---|
| Reuse `app.html` as-is | Yes (+shim) | **Yes, identical** | Yes (+shim) | Yes (+shim) |
| Renderer | WebKit (Safari) | **Chromium** (= WebView2) | WebKit (system) | CEF (big) or immature native webview |
| Rendering-parity risk | Low–moderate | **None** | Low–moderate | Varies / weakest |
| Bundle size | **~5–15 MB** | ~150–250 MB | ~10–40 MB | 40–200 MB |
| Spawn Node sidecar | `Foundation.Process` — easy | trivial (Electron *is* Node) | Rust `Command` — easy | `System.Diagnostics.Process` |
| Host bridge | `WKScriptMessageHandler` (1:1) | preload + `ipcRenderer` | `@tauri-apps/api` invoke | `HybridWebView`/JS interop |
| Frameless + traffic lights | **Solved AppKit pattern** | `frame:false`/`titleBarStyle` | `decorations:false` | fiddly on Catalyst |
| Notarization | **Cleanest (one native app)** | **electron-builder automates** | supported, younger toolchain | workable, awkward |
| New toolchain added | Swift/AppKit | Node/Electron (already have Node) | **Rust** (3rd language) | C#/.NET (already have it) |
| Code shared w/ Win shell | none | none | none | **none in practice** (Win is WinForms) |

**Honest notes per option:**

- **(a) Swift + WKWebView** — Smallest bundle (uses the OS's WebKit, ships no runtime),
  best-in-class notarization (a single signed native binary), and the host bridge is a
  *direct* swap: `window.chrome.webview.postMessage` → inject a shim onto
  `window.webkit.messageHandlers.host.postMessage`, received by a `WKScriptMessageHandler`;
  host→page replies go back via `evaluateJavaScript` dispatching to the shim's listeners
  (~20 lines of injected JS via `WKUserScript` at document-start). Frameless `NSWindow`
  with transparent titlebar + movable-by-background + traffic-light insets is a standard
  AppKit recipe, replacing the entire `WM_NCHITTEST`/`ReleaseCapture` block for free.
  Window controls map straight to `NSWindow` (`performClose:`, `miniaturize:`, `zoom:`,
  `performWindowDragWithEvent:`). **The one real risk is rendering parity:** `app.html` was
  tuned against Chromium (WebView2). WebKit differences to smoke-test — `backdrop-filter`,
  `mix-blend-mode:screen` (CRT grille overlay), CSS keyframe animations, Google-Fonts
  network load, `::-webkit-scrollbar` (this one *is* WebKit, so it's fine). Most of the CRT
  styling is more WebKit-friendly than not, so risk is low but non-zero.

- **(b) Electron** — **Zero rendering risk** (same Chromium engine as WebView2, so the CRT
  UI renders pixel-identical), the least effort to first-run, and `electron-builder` turns
  `.dmg` + Developer-ID signing + notarization into one config block. Spawning the sidecar
  is native (Electron embeds Node; you could even run the sidecar in-process, though keeping
  it a `child_process` preserves the current architecture 1:1). **Costs:** a ~150–250 MB
  bundle (ships full Chromium + Node) — heavy for an app whose whole pitch is "a single
  quiet window" — plus higher RAM and a philosophical mismatch with the minimalist ethos.
  It's the **fast, safe path** if the Swift rendering risk is unacceptable or if you later
  want one shell across Win/Mac/Linux.

- **(c) Tauri** — Small bundle like Swift, but uses the **same system WebKit** on macOS, so
  it carries the *identical* rendering-parity caveat as (a) **without** (a)'s advantage of
  being the platform-native path. It adds **Rust** as a third toolchain (on top of C# +
  Node), and fitting a pre-built single-file `app.html` with a custom host bridge into
  Tauri's asset-pipeline/`invoke` model is more adaptation than Swift's tiny shim. Only
  worth it if you specifically want a Rust backend — you don't; the sidecar already *is* the
  backend.

- **(d) .NET MAUI / Avalonia** — The *only* theoretical draw is "keep everything in C#," but
  **the Windows shell is WinForms, not MAUI/Avalonia**, so there is **nothing to actually
  share** unless you also rewrite the working Windows shell. On macOS both frameworks fall
  back to WKWebView (MAUI via Mac Catalyst) or bundle CEF (Avalonia's webview story is weak
  and heavy). Frameless + traffic-light integration is the fiddliest of all four, and
  notarization means fighting the framework. **Highest risk for the least payoff.** Rejected
  unless the goal becomes "one shared C# shell for all OSes," which would mean rewriting
  Windows too — a much larger project.

#### RECOMMENDATION: **Swift + WKWebView (primary), Electron (fallback)**

**Reasoning.** The Windows and Mac shells share **no code regardless of choice** (WinForms
C# vs anything Mac), which removes the *only* reason to tolerate MAUI/Avalonia's weak macOS
webview. Given that, pick on merit: **Swift + WKWebView** gives the smallest bundle (matching
the "single quiet window" identity), the cleanest single-artifact notarization, a 1:1
host-bridge mapping, and the platform-native frameless-window story — while the sidecar (the
actual backend) stays exactly as-is. The lone risk is WebKit rendering parity, and the
mitigation is built-in: **if the CRT UI misbehaves under WebKit, fall back to Electron** for
guaranteed Chromium parity and near-automated notarization, accepting the larger bundle.
That's an honest hedge, not hand-waving — decide it with a half-day WebKit smoke test of
`app.html` before committing to Phase 3.

### 2.2 THE VAULT — DPAPI / `secrets.ps1` → macOS Keychain

**Today (Windows):** `~/.agent-omega/secrets.ps1` stores one DPAPI-encrypted file
(`vault.dat`), scoped to the logged-in Windows user, exposing `get`/`set`/`list`/`rm`. The
sidecar shells out `powershell -NoProfile -File secrets.ps1 <cmd>` in `vaultEnv()` (inject
keys into the engine env at spawn) and in the `vaultList`/`vaultSet`/`vaultRemove` handlers.

**On macOS:** the direct analog is the **login Keychain** (encrypted at rest, unlocked by the
user's login), reached via the `security` CLI (or Keychain Services from Swift).

**Concrete swap — mirror the single-file model exactly.** DPAPI stores the whole vault as one
encrypted blob; do the same in Keychain to sidestep the "enumerate all items" problem the
`security` CLI is bad at. Store **one** generic-password item (service `agent-omega`, account
`vault`) whose secret value is the same JSON `{NAME: value, ...}` map. Provide a small
`secrets.sh` (zsh/bash) that mirrors `secrets.ps1`'s exact contract:

- `get NAME`  → `security find-generic-password -s agent-omega -a vault -w` → parse JSON → print value
- `set NAME V`→ read blob, JSON-merge `NAME=V`, `security add-generic-password -U -s agent-omega -a vault -w <json>`
- `list`      → print the JSON keys (names only, never values) — sentinel `(vault empty)`
- `rm NAME`   → read blob, delete key, re-`add -U`

**How the sidecar reads it:** unchanged in shape. Abstract the four vault call-sites behind a
tiny `vault` module with a `win32` impl (`powershell -File secrets.ps1`) and a `darwin` impl
(`/bin/sh secrets.sh`, or call `security` directly from Node via `execFileSync`). The
`VAULT_TO_ENV` mapping, the injection into the engine env, the "names only, never values"
logging, and the empty-value guard (which would hang an interactive prompt) all stay
identical — only the executable + args differ. Keychain encryption + login-scoping preserve
the "readable only as this user, encrypted at rest, never written to disk in the clear"
guarantee that is the vault's whole point.

### 2.3 PowerShell → zsh/bash (the prompt/skill layer the model reads)

Beyond the sidecar's vault shell-outs (covered above), PowerShell appears in the
**config-template the model reads and acts on** — these are prompt/doc edits, not code, but
they matter for the agent actually working on a Mac (where the engine's shell tool runs
zsh/bash):

- `reference/powershell.md` → a `reference/shell.md` (zsh/bash conventions), and the
  platform-shell guidance in `AGENTS.md`.
- Example commands in `skill/run-app/SKILL.md`, `skill/code-review/SKILL.md`, and
  `reference/git-conventions.md` (all currently show ```powershell blocks).
- `reference/anthropic-api.md` tells the model to fetch the key via
  `powershell … secrets.ps1 get ANTHROPIC_API_KEY` → replace with the macOS equivalent
  (`sh ~/.agent-omega/secrets.sh get …` or `security find-generic-password …`).

Ship these as a **darwin variant of the config-template** (or platform-conditional sections),
so the model is told the truth about its shell on each OS.

### 2.4 THE ENGINE — need a `darwin` build of the *fork*

The engine is a **Bun-compiled binary** shipped as a **GitHub Release download** (`.exe` is
git-ignored, fetched at install). The Windows Mach-O... — the Windows `opencode.exe` **cannot
run on macOS**. You need `darwin-arm64` (Apple Silicon) **and** `darwin-x64` (Intel) builds.

**Critical nuance:** Agent Omega ships a **customized fork** of opencode (the shell tool that
blanks `*_API_KEY` from the model's shell env is a fork edit, and the binary is rebuilt from
that fork — not upstream). So you **cannot grab sst/opencode's stock darwin release** — you
must build **your fork** for darwin. Bun cross-compiles standalone executables:

```
bun build --compile --target=bun-darwin-arm64  …   # Apple Silicon
bun build --compile --target=bun-darwin-x64    …   # Intel
# optional: lipo the two into one universal Mach-O
```

This can run **from the existing Windows/Linux dev box** (Bun cross-compiles) or natively on
a Mac. Output is `opencode` (no `.exe`), placed at `engine/opencode` — which the sidecar's
platform-aware ENGINE default (§1.1) then resolves. **Gatekeeper caveat:** a Bun binary
*downloaded* from a Release gets a quarantine xattr and Gatekeeper blocks it. **Preferred:
bundle the signed engine binary inside the notarized `.app`** so one notarization covers it
(see §3) — rather than fetching it at install and fighting quarantine. Node itself is still a
runtime prerequisite (as on Windows); Bun is only needed for the `AGENT_OMEGA_OPENCODE_SRC`
test-mode path, not production.

---

## 3. Packaging — `.app`, `.dmg`, signing, notarization, Gatekeeper

This is the second real time-sink (first-timers always lose a day or two here).

**Bundle layout (`AgentOmega.app/Contents/`):**
```
MacOS/AgentOmega            ← the Swift host binary (or Electron main)
Resources/
  ui/                        ← app.html + js/css (unchanged)
  sidecar.mjs
  config-template/opencode/  ← plugins, skills, AGENTS.md, web.py, opencode.json
  engine/opencode            ← the signed darwin Mach-O (universal or per-arch)
  AgentOmega.icns            ← converted from ftp.ico via `iconutil`/`sips`
Info.plist                   ← bundle id, version, LSMinimumSystemVersion, icon
```

**Signing (Developer ID Application cert, requires Apple Developer Program, $99/yr):**
- Sign **inner** Mach-O binaries first (the `engine/opencode` Bun binary, any `.dylib`,
  the Node you bundle if you bundle one), **then** the outer app. Avoid `codesign --deep`
  (Apple discourages it); sign inside-out.
- Enable the **hardened runtime** (`--options runtime`). Bun and Node **JIT**, so under the
  hardened runtime you will almost certainly need the entitlements
  `com.apple.security.cs.allow-jit` and/or `com.apple.security.cs.allow-unsigned-executable-memory`,
  plus `com.apple.security.cs.disable-library-validation` (the app spawns a separately-signed
  engine + Node). This entitlements dance is the classic notarization time-sink — budget for
  iteration.

**Notarization + Gatekeeper:**
- `xcrun notarytool submit AgentOmega.dmg --wait` (with an app-specific password or an App
  Store Connect API key), then `xcrun stapler staple` the `.app` and the `.dmg`.
- Ship as a **`.dmg`** (via `create-dmg` or `hdiutil`). Once notarized + stapled, Gatekeeper
  passes on first launch — no "unidentified developer / cannot be opened" wall.
- **Hard requirement: a Mac to build.** `codesign`, `notarytool`, `stapler`, `iconutil`,
  `lipo`, `hdiutil` are all macOS-only. The Bun engine *cross-compiles* from any OS, but the
  **app packaging/signing/notarization must happen on a Mac.**

If you go **Electron**, `electron-builder` collapses most of this (`.dmg`, Developer-ID
signing, hardened-runtime entitlements, and `notarytool` submission) into one config block —
which is a real part of Electron's appeal for this port.

---

## 4. Phased plan, effort, and shared vs forked

### Phased plan (Swift route)

| Phase | Work | Effort | Shared/Forked |
|---|---|---|---|
| **0. Darwin engine** | Cross-compile the fork with `bun build --target=bun-darwin-arm64` + `-x64` (optionally `lipo` to universal); verify `opencode acp` runs on a Mac and speaks ACP. | **0.5–1 day** | engine **source** SHARED; binary asset forked per-arch |
| **1. Sidecar portability** | Platform-aware ENGINE default (`.exe` vs none); abstract the 4 vault call-sites behind a `vault` interface. Everything else already portable. | **2–4 hrs** | **SHARED** (one file, platform branch) |
| **2. Vault backend** | `secrets.sh` over the `security` CLI, single-JSON-blob Keychain item mirroring `secrets.ps1`'s get/set/list/rm; wire the darwin `vault` impl. | **3–6 hrs** | **FORKED** (behind shared iface) |
| **3. The Mac shell** | Swift + WKWebView: frameless `NSWindow` + traffic lights/drag; `loadFileURL` (with `allowingReadAccessTo` the `ui/` dir); inject the `window.chrome.webview` shim → `WKScriptMessageHandler`; spawn/kill the node sidecar with `AO_WS_TOKEN`+WORKDIR+port; pass `ws`+`token` via the `file://` query string; apply the WebView hardening. **+ WebKit rendering-parity QA.** | **3–6 days** | **FORKED** (no code shared w/ WinForms) |
| **4. Config-template darwin variant** | `reference/shell.md` (zsh/bash), platform-shell note in `AGENTS.md`, macOS example commands in run-app/code-review/git-conventions/anthropic-api, point `AGENT_OMEGA_ANONWEB_VENV` at the mac venv. | **0.5–1 day** | partially **SHARED** (prompt/doc) |
| **5. Packaging + signing + notarization** | `Info.plist`, `.icns`, bundle sidecar+config+engine+ui into `Resources`, sign inner-out + hardened runtime + JIT entitlements, `notarytool` + `stapler`, `.dmg`. First-time entitlements/notarization debugging. | **2–4 days** | **FORKED** (whole pipeline) |

**Total (Swift): ~10–15 focused days (≈2–3 weeks).** The shell (Phase 3) and
packaging/notarization (Phase 5) are the bulk; sidecar + vault + config are only a few days
combined.

**Electron variant:** Phase 3 shrinks to ~2–3 days (`electron-builder` scaffold + a preload
host-bridge shim, guaranteed Chromium parity so little QA), and Phase 5's notarization is
largely automated — **total ~1.5–2 weeks**, trading a ~200 MB bundle for less effort and
zero rendering risk.

### Shared vs forked (write-once vs per-OS)

**SHARED across both branches (write once):**
- `sidecar.mjs` (one file; a `win32`/`darwin` branch for the engine suffix + the vault
  backend selector).
- The **entire `ui/`** (app.html + all js/css). The host-bridge difference is handled by an
  *injected shim*, not a fork of the UI.
- **All six engine plugins** + `council.json` + `opencode.json` + `web.py` + skills/commands/
  themes (pure Node/Bun/Python, already runtime-adaptive and env-driven).
- The **engine source** (the fork). Only the *compiled binary* differs per arch.

**FORKED (per-OS):**
- **The shell** — `Program.cs` (WinForms/WebView2) vs the Swift/WKWebView (or Electron)
  host. Different language + framework; nothing shared.
- **The vault backend implementation** — `secrets.ps1`/DPAPI vs `secrets.sh`/Keychain
  (behind a shared sidecar interface, so the *seam* is shared even though the impls aren't).
- **The shell-conventions docs + example commands** in the config-template (powershell.md vs
  shell.md; the ```powershell blocks in AGENTS.md/skills).
- **The packaging/signing pipeline** — `.csproj`/`.exe`/WebView2-runtime dep vs
  `.app`/`.dmg`/`codesign`/`notarytool`.
- **The compiled engine binary asset** (`opencode.exe` vs `opencode` darwin arm64/x64).

---

## 5. Risks & honest unknowns

- **WebKit rendering parity (Swift/Tauri).** The CRT theme is Chromium-tuned. Mitigation:
  a half-day WebKit smoke test of `app.html` **before** committing to Phase 3; Electron is
  the guaranteed-parity fallback. This is the single decision that can flip the whole shell
  choice, so make it first.
- **Hardened-runtime entitlements for Bun + Node JIT.** The most likely notarization
  snag — expect a few iterations on `allow-jit` / `allow-unsigned-executable-memory` /
  `disable-library-validation`. Not hard, just fiddly and first-time-costly.
- **Quarantine on a downloaded engine binary.** Avoid entirely by bundling the signed engine
  *inside* the notarized `.app` rather than fetching it from a Release at install time.
- **Apple Developer Program + a physical Mac** are hard prerequisites for signing/
  notarization/packaging (the engine can cross-compile off-Mac, the app cannot be packaged
  off-Mac).
- **Node as a runtime prerequisite** on the user's Mac (same posture as Windows) — or bundle
  a Node runtime into `Resources` (adds size + one more binary to sign).
