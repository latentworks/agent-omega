# Agent Omega — Windows-Dependency Inventory for a macOS Port

Scope: every Windows-specific dependency in the tree at `C:\Users\user\agent-omega`,
excluding `node_modules/` and `.git/`. Each item cites `file:line` and the Mac
equivalent / change needed. Counts and the blocker shortlist are at the end.

Legend for how "hard" an item is:
- **[SWAP]** mechanical (rename, path, add a mac branch) — low risk.
- **[WORK]** real engineering (rewrite a subsystem / crypto / native UI).
- **[NOOP]** already cross-platform or a Windows-only no-op on mac; listed for completeness.

---

## A. WinForms / WebView2 / Windows-only .NET (the C# desktop shell)

The host process (`Program.cs`) and its project file are an entirely Windows-only
WinForms + WebView2 application. On macOS none of WinForms, WebView2, or the Win32
P/Invoke calls exist. The whole shell has to be re-hosted on a mac-capable web
container (WKWebView via Avalonia / Photino / .NET MAUI, or drop C# and use Tauri /
Electron). Individual lines below, but treat this section as one rewrite.

| # | file:line | Item | Mac equivalent / change needed |
|---|---|---|---|
| A1 | `AgentOmega.csproj:3` | `<OutputType>WinExe</OutputType>` | **[WORK]** No `WinExe` GUI subsystem on mac; produce a mac app bundle (`.app`) from whatever UI framework replaces WinForms. |
| A2 | `AgentOmega.csproj:4` | `<TargetFramework>net8.0-windows</TargetFramework>` | **[WORK]** Retarget to cross-platform `net8.0` (or `net8.0-macos` for MAUI). The `-windows` TFM pulls in the Windows Desktop pack. |
| A3 | `AgentOmega.csproj:5` | `<UseWindowsForms>true</UseWindowsForms>` | **[WORK]** WinForms is Windows-only. Remove; adopt a mac UI toolkit (Avalonia / MAUI / Photino / Tauri). |
| A4 | `AgentOmega.csproj:9` | `<ApplicationIcon>ftp.ico</ApplicationIcon>` | **[SWAP]** `.ico` is a Windows format. Provide `.icns` and set it in the mac bundle's `Info.plist`. |
| A5 | `AgentOmega.csproj:15` | `PackageReference Microsoft.Web.WebView2` | **[WORK]** WebView2 (Edge/Chromium host) is Windows-only. Use WKWebView (native) or a cross-platform web host (Photino/Avalonia.WebView/Tauri). |
| A6 | `Program.cs:3` | `using System.Drawing;` | **[SWAP]** WinForms drawing types (`Color`, `Size`, `Rectangle`, `Icon`, `Point`) — replace with the mac toolkit's equivalents. |
| A7 | `Program.cs:5` | `using System.Runtime.InteropServices;` | **[WORK]** Only present for the `user32.dll` P/Invokes below; drops out with the native-drag rewrite. |
| A8 | `Program.cs:6` | `using System.Windows.Forms;` | **[WORK]** Windows-only namespace (Form, Application, Screen, etc.). |
| A9 | `Program.cs:7-8` | `using Microsoft.Web.WebView2.WinForms; / .Core;` | **[WORK]** WebView2 API surface — replaced by the mac web host's API. |
| A10 | `Program.cs:16` | `[DllImport("user32.dll")] ReleaseCapture()` | **[WORK]** Win32 P/Invoke for frameless-window drag. Mac: use the toolkit's window-drag API (e.g. WKWebView + `-[NSWindow performWindowDragWithEvent:]`, or `data-tauri-drag-region`). |
| A11 | `Program.cs:17` | `[DllImport("user32.dll")] SendMessage(...)` | **[WORK]** Same as A10 — Win32 window-message send; no mac equivalent. |
| A12 | `Program.cs:18` | `WM_NCLBUTTONDOWN = 0xA1, HTCAPTION = 0x2` | **[WORK]** Win32 non-client hit-test constants used for title-bar drag. |
| A13 | `Program.cs:34-36` | `Application.SetHighDpiMode / EnableVisualStyles / SetCompatibleTextRenderingDefault` | **[WORK]** WinForms app bootstrap — replaced by the mac toolkit's app init. |
| A14 | `Program.cs:39` | `AppDomain.CurrentDomain.BaseDirectory.Replace("\\", "/") + "ui/app.html..."` (file:// URL) | **[SWAP]** Backslash→slash conversion is Windows-path-shaped. On mac paths already use `/`; build the `file://` URL with `Uri`/`Path` instead of a manual replace. |
| A15 | `Program.cs:46-55` | `new AppForm { FormBorderStyle, StartPosition, BackColor, MinimumSize, Padding }` + `new Icon(ico)` | **[WORK]** WinForms `Form` window + `.ico` load. Rebuild as the mac window; load `.icns`. |
| A16 | `Program.cs:57-58` | `new WebView2 { Dock = DockStyle.Fill }` added to form Controls | **[WORK]** WebView2 control docking — replaced by the mac web view. |
| A17 | `Program.cs:62-63` | `CoreWebView2Environment.CreateAsync(null, Path.Combine(Path.GetTempPath(), "agent-omega-webview2"))` + `EnsureCoreWebView2Async` | **[WORK]** WebView2 user-data-folder init. Mac web host manages its own data dir; `Path.GetTempPath()` itself is cross-platform. |
| A18 | `Program.cs:65-75` | `c.Settings.*` (context menus, devtools, autofill, accelerator keys), `NewWindowRequested`, `NavigationStarting`, `WebMessageReceived` | **[WORK]** WebView2 hardening + host bridge — must be re-expressed against WKWebView/Tauri message + navigation APIs. |
| A19 | `Program.cs:107-137` | `OnUiMessage` window-control handler using `Screen.FromHandle`, `FormWindowState`, `_form.Bounds` | **[WORK]** WinForms window state/geometry + `Screen` — rebuild with mac window APIs. |
| A20 | `Program.cs:130` | `Screen.FromHandle(_form.Handle).WorkingArea` | **[WORK]** WinForms multi-monitor query — mac: `NSScreen.visibleFrame`. |
| A21 | `Program.cs:133-134` | `ReleaseCapture(); SendMessage(_form.Handle, WM_NCLBUTTONDOWN, HTCAPTION, ...)` (drag) | **[WORK]** Native drag via Win32 — see A10. |
| A22 | `Program.cs:149-168` | `class AppForm : Form` — `WndProc` / `WM_NCHITTEST` / `HTLEFT..HTBOTTOMRIGHT` edge-resize hit-testing | **[WORK]** Win32 message loop for frameless-window edge resizing. Mac: native resizable window or the toolkit's resize handling; the whole hand-rolled hit-test goes away. |
| A23 | `Program.cs:31` | `[STAThread]` on `Main` | **[SWAP]** Windows COM single-thread-apartment attribute; harmless/irrelevant on mac, remove with the WinForms rewrite. |

Cross-platform-already inside the shell (no change, listed so they aren't re-flagged):
- `Program.cs:21` `Path.Combine(AppContext.BaseDirectory, "sidecar.mjs")` — **[NOOP]** `AppContext.BaseDirectory` is cross-platform.
- `Program.cs:22` `Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)` — **[NOOP]** resolves to `$HOME` on mac.
- `Program.cs:20/90` `const string NODE = "node"` spawned via PATH — **[NOOP]** works on mac if Node is installed (see C2).

---

## B. PowerShell invocations + DPAPI secrets vault (real code)

The secrets vault is Windows DPAPI encryption driven by a PowerShell script
(`secrets.ps1`). Four live `execFileSync('powershell', ...)` call sites in the
sidecar shell out to it. DPAPI and `powershell` do not exist on stock macOS.

| # | file:line | Item | Mac equivalent / change needed |
|---|---|---|---|
| B1 | `sidecar.mjs:48` | `SECRETS_PS1 = ... path.join(os.homedir(), '.agent-omega', 'secrets.ps1')` | **[WORK]** `.ps1` vault script assumption. Mac: a shell/binary vault backed by macOS Keychain (`security add-generic-password` / `find-generic-password`), or `libsecret`-style abstraction. |
| B2 | `sidecar.mjs:62` | `execFileSync('powershell', ['-NoProfile','-File',SECRETS_PS1,'get',vaultName])` (vaultEnv) | **[WORK]** Replace `powershell` + script with the mac vault CLI. Also the `-NoProfile` flag is PS-specific. |
| B3 | `sidecar.mjs:131` | `execFileSync('powershell', [...,'list'])` (vaultListNames) | **[WORK]** Same — list keys via Keychain. |
| B4 | `sidecar.mjs:270` | `execFileSync('powershell', [...,'set',name,value])` (vaultSet) | **[WORK]** Same — write key via Keychain. |
| B5 | `sidecar.mjs:280` | `execFileSync('powershell', [...,'rm',name])` (vaultRemove) | **[WORK]** Same — delete key via Keychain. |
| B6 | `TECHNICAL.md:323-324, 328, 343, 400` | Docs: "Windows DPAPI-encrypted vault", `~\.agent-omega\secrets.ps1`, hang-on-interactive-prompt note | **[SWAP]** Doc rewrite to describe the Keychain-backed vault + mac path. |
| B7 | `TECHNICAL.md:335-339` | Engine fork `shell.ts` blanks `*_API_KEY` env before spawning the model's shell | **[WORK]** Not Windows-specific logic, but it lives in the forked engine binary that must be rebuilt for mac (see C1). Verify the env-scrub still behaves under a darwin build. |

Cross-platform-already:
- `council/filetools.mjs:13` `const HOME = process.env.USERPROFILE || process.env.HOME || ''` — **[NOOP]** already falls back to `HOME`; works on mac.
- `web.py` uses `subprocess.run([VENV, ...])` with an env-var-configured Python path — **[NOOP]** cross-platform; no PowerShell/DPAPI.

---

## C. Engine binary + `.exe` / `node.exe` assumptions

| # | file:line | Item | Mac equivalent / change needed |
|---|---|---|---|
| C1 | `sidecar.mjs:13` | `ENGINE = ... path.join(import.meta.dirname, 'engine', 'opencode.exe')` | **[WORK]** Hardcoded `opencode.exe`. Mac needs a darwin-arm64/x64 build of the opencode engine binary named `opencode` (no `.exe`), and this default must branch on `process.platform` (or resolve `opencode` + `opencode.exe`). Producing/shipping the mac engine build is real work. |
| C2 | `Program.cs:20` / `TECHNICAL.md:73` | `const string NODE = "node"` resolved via PATH; docs cite `C:\Program Files\nodejs\node.exe` | **[SWAP]** The code already uses bare `node` via PATH (fine on mac). Only the doc's hardcoded Windows path needs updating. |
| C3 | `TECHNICAL.md:39, 114-115, 399` | Docs reference `opencode.exe` / `<engine>/bin/opencode.exe` | **[SWAP]** Doc rewrite to platform-neutral binary name. |
| C4 | `sidecar.mjs:186` | `spawn(cmd, [...], { windowsHide: true, ... })` | **[NOOP]** `windowsHide` is ignored on non-Windows; harmless. Leave or drop. |
| C5 | `.gitignore:34` | `*.exe` ignore rule | **[NOOP]** Harmless on mac; may want to also ignore the mac binary name. |
| C6 | `AGENTS.md:17` (engine fork ref `opencode-fork/.../tool/shell.ts`) | Doc pointer to the forked engine | **[NOOP]** doc pointer; engine rebuild tracked under C1. |

Cross-platform-already (paths built with `os.homedir()` / `path.join`, no drive letters):
- `sidecar.mjs:19` `path.join(os.homedir(), '.agent-omega', 'workspace')` — **[NOOP]**
- `sidecar.mjs:49` `path.join(os.homedir(), '.config', 'opencode', 'council', 'council.json')` — **[NOOP]**
- `council/providers.mjs:29` `path.join(os.homedir(), '.config', 'opencode', 'opencode.json')` — **[NOOP]**

---

## D. Path / shell-command assumptions in engine config & plugins

| # | file:line | Item | Mac equivalent / change needed |
|---|---|---|---|
| D1 | `config-template/opencode/opencode.json:93` | bash deny `"diskpart*"` | **[SWAP]** `diskpart` is Windows. Mac equivalent to also deny: `diskutil`. |
| D2 | `opencode.json:96-97` | bash deny `"reg add*"`, `"reg delete*"` | **[SWAP]** Windows registry editor. No mac registry; optionally deny `defaults write` / `defaults delete`. |
| D3 | `opencode.json:102-103` | bash deny `"Invoke-WebRequest*"`, `"Invoke-RestMethod*"` | **[SWAP]** PowerShell cmdlets — irrelevant on mac (already denies `curl`/`wget` at :100-101, which is what matters on mac). Keep or drop. |
| D4 | `opencode.json:105` | bash deny `"*secrets.ps1*"` | **[SWAP]** Update the guard to the mac vault CLI/path name (tie to B1). |
| D5 | `opencode.json:128-131` | bash deny `"*del /s*"`, `"*del /q*"`, `"*rmdir /s*"`, `"*rd /s*"` | **[SWAP]** Windows `cmd` builtins. On mac the dangerous form is `rm -rf` (already gated at :114-119). These become dead rules; add nothing new. |
| D6 | `verify-guard/core.mjs:37` | verify-pattern `/(^|\s)\.\\\S+/  // .\run.ps1 (Windows)` | **[NOOP]** Matches `.\script` (Windows launch). Won't match mac's `./script` (already covered at :36). Harmless dead pattern; optional cleanup. |
| D7 | `verify-guard/core.mjs:35` | verify-pattern `/(invoke-pester|pester)/i` (PowerShell test runner) | **[NOOP]** Pester only runs on PowerShell; harmless dead pattern on mac. |

---

## E. PowerShell-centric prompt/skill/reference content (shapes agent behavior)

Not executable dependencies, but the engine system prompt, skills, and reference
shelf instruct the model to prefer PowerShell and describe a Windows shell. On mac
these must be rewritten to zsh/bash so the agent emits correct commands. This is
real content work (the agent will give wrong shell advice otherwise), not a code swap.

| # | file:line | Item | Mac equivalent / change needed |
|---|---|---|---|
| E1 | `AGENTS.md:1` | "run shell commands (PowerShell and bash are both available)" | **[SWAP]** Reword to zsh/bash (mac default shell). |
| E2 | `reference/powershell.md` (whole file, 1-70) | Entire "PowerShell through the bash tool on Windows" guide, incl. registry PSDrive (`:24`), `& "C:\Program Files\..."` (`:25`), cmdlet/Unix-equivalent table | **[WORK]** Replace with a zsh/bash reference (or delete). `AGENTS.md:145` advertises "the full PowerShell guide" on the reference shelf — update that pointer too. |
| E3 | `reference/git-conventions.md:5, 30-36, 57, 64-72` | "prefer PowerShell, use `@'...'@` here-strings"; PowerShell commit/PR examples | **[SWAP]** Prefer bash heredoc (already shown as the alternative in the same file); flip the default. |
| E4 | `reference/anthropic-api.md:17-20, 25` | `powershell` install block + `powershell -NoProfile -File "~\.agent-omega\secrets.ps1" get ...` | **[SWAP]** Mac vault fetch command (Keychain CLI) + neutral install block. |
| E5 | `skill/run-app/SKILL.md:30, 35, 45, 52-53, 79, 82` | `Start-Process`/`Start-Job`, `smoke.ps1`, `$LASTEXITCODE`, `Get-Content`, `.\src`, `$env:PORT` examples | **[SWAP]** zsh/bash equivalents (`&`/`nohup`, `smoke.sh`, `$?`, `cat`, `./src`, `PORT=...`). |
| E6 | `skill/code-review/SKILL.md:20` | a ```powershell fenced example block | **[SWAP]** Convert to bash. |
| E7 | `skill/orchestration/SKILL.md:110` | "Helpers run on Windows 11 and can use PowerShell or git-bash"; `$env:VAR`, `$null`, `Get-Content` | **[SWAP]** Update to mac/zsh. |
| E8 | `skill/verify/SKILL.md:56, 96` | "in PowerShell, `Invoke-RestMethod`"; "PowerShell: `New-TemporaryFile`" | **[SWAP]** `curl`; `mktemp` (git-bash form already given). |

---

## COUNTS PER CATEGORY

| Category | Change-needed items | of which [WORK] | [NOOP]/dead |
|---|---|---|---|
| A. WinForms / WebView2 / Win32 .NET shell | 23 | ~18 | 3 cross-platform-already |
| B. PowerShell + DPAPI vault | 7 | 6 | 2 cross-platform-already |
| C. Engine binary / `.exe` / `node.exe` | 6 (C1-C3 real, C4-C6 noop) | 1 (C1) | 3+ path items already OK |
| D. Config/plugin shell-command assumptions | 7 | 0 | 2 dead patterns |
| E. PowerShell prompt/skill/reference content | 8 | 2 (E2 heavy) | 0 |
| **Total distinct Windows-touch points** | **~51** | **~27 real work** | ~10 no-ops |

(UI folder — `ui/app.html`, `ui/*.js`, `ui/*.css` — was swept and contains **no**
Windows-specific path/exe/platform assumptions; it is pure portable web and needs no
change beyond being hosted by the new mac web container.)

---

## BIGGEST BLOCKERS (real work, not mechanical swaps)

1. **The entire C# WinForms + WebView2 desktop shell (Category A — `Program.cs`
   + `AgentOmega.csproj`).** WebView2 and WinForms are Windows-only, and the
   frameless-window drag/resize is hand-rolled Win32 P/Invoke (`user32.dll`
   `ReleaseCapture`/`SendMessage`, `WM_NCHITTEST` hit-testing). There is no port —
   the shell must be **rebuilt** on a mac web host (WKWebView via Avalonia / Photino /
   .NET MAUI, or drop C# for Tauri/Electron), re-implementing the title-bar controls,
   drag, edge-resize, WebView hardening, and the `WebMessageReceived` bridge. This is
   the single largest piece of the port.

2. **The DPAPI + PowerShell secrets vault (Category B — `secrets.ps1` and the four
   `execFileSync('powershell', ...)` sites in `sidecar.mjs`).** DPAPI is Windows-only
   OS-level encryption and `powershell` isn't on mac. This must be re-implemented
   against the **macOS Keychain** (`security` CLI or a native Keychain binding),
   preserving the get/list/set/remove contract and the "never log values / don't hang
   on empty value" guarantees. Real security work, not a rename.

3. **A macOS build of the opencode engine binary (Category C — `sidecar.mjs:13`
   `engine/opencode.exe`).** The sidecar spawns a hardcoded `opencode.exe`; mac needs a
   darwin-arm64 (and x64) build of the (forked) engine, the spawn path made
   platform-aware, and the engine's env-scrub (`shell.ts` blanking `*_API_KEY`,
   TECHNICAL.md:335) re-verified under the mac build. Producing and packaging that
   binary is a genuine build-pipeline task.

4. **The PowerShell-first agent brain (Category E — `AGENTS.md`, `reference/powershell.md`,
   the run-app/orchestration/verify/code-review skills, git & anthropic references).**
   The model is told PowerShell is the preferred shell and given a full PowerShell
   guide; on mac it would emit broken commands. Rewriting this guidance to zsh/bash
   (and replacing the whole `powershell.md` reference) is real prompt-engineering
   content work that directly affects agent correctness — easy to overlook because
   it's "just docs," but it changes runtime behavior.

5. **Packaging / distribution (spans A4, C1, and app-bundle mechanics).** Icons
   (`.ico`→`.icns`), a signed/notarized `.app` bundle, bundling Node + the mac engine
   binary, and first-run setup replace the current Windows `WinExe` + `ftp.ico` model.
   Not conceptually hard but non-trivial and required before it runs on a stranger's Mac.
