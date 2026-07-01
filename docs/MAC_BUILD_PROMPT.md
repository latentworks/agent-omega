<!--
HOW TO USE THIS FILE
====================
This is the kickoff prompt for building the macOS branch of Agent Omega in a
fresh Claude Code (or similar) session ON THE MAC.

1. Get this repo onto the Mac (it has ssh). From the Mac, pull it off the
   Windows box, e.g.:
       rsync -avz --exclude node_modules --exclude bin --exclude obj \
             <winuser>@<windows-host>:/c/Users/user/agent-omega/  ~/agent-omega/
   (or scp -r, or git clone if it's been pushed to a remote).
2. cd ~/agent-omega and start Claude Code there.
3. Paste EVERYTHING below the line as your first message (or tell the agent:
   "follow docs/MAC_BUILD_PROMPT.md").
-->

---

# MISSION: Build the macOS branch of Agent Omega (autonomous, self-verifying)

You are an autonomous build agent on a Mac. Build a **native macOS version of Agent Omega** — a desktop coding-agent app that is currently Windows-only — to feature parity with the Windows build. Work **mostly autonomously**: make reasonable calls and keep moving. But follow the gated build workflow, **prove behavior (never plumbing)**, and **adversarially self-verify every piece with subagents**. Stop only for the human decisions and one-way actions flagged below.

## 0. Orient yourself — before anything else
1. **Confirm you're inside the repo.** You should see `README.md`, `TECHNICAL.md`, `Program.cs`, `sidecar.mjs`, `ui/`, `config-template/`, and `docs/`. If not, get the repo first — it lives at `~/agent-omega` (or `C:/Users/user/agent-omega`) on the Windows box; pull it over SSH (`rsync`/`scp`) or clone it.
2. **Read these first — they are the authoritative plan from prior investigation:**
   - `docs/MAC_BRANCH.md` — full port plan, recommended approach, effort estimate.
   - `docs/mac-porting-inventory.md` — every Windows-specific dependency, `file:line`, with its Mac equivalent.
   - `TECHNICAL.md` — the architecture. `README.md` — what the app is + its honest framing.
3. `git checkout -b mac` — do ALL work on a `mac` branch. Never break the Windows code.

## 1. Build-environment audit (you don't know what's installed — find out, then tell the user)
Before building, inventory this Mac's toolchain and report in plain English what's present, what's missing, and what each missing piece is for. Check:
- **Arch:** `uname -m` (arm64 = Apple Silicon, x86_64 = Intel) — you need the matching engine build.
- **Xcode Command Line Tools:** `xcode-select -p`, `swiftc --version` (for the Swift shell).
- **Full Xcode:** `xcodebuild -version` (only for signing/notarization/packaging).
- **Homebrew:** `brew --version` (your installer for the rest).
- **Node 18+:** `node --version` (runs the sidecar + plugins — carries over from Windows).
- **Bun:** `bun --version` (compiles the engine fork into a macOS binary).
- **git**, and whether an **Apple Developer ID** exists (needed to notarize a distributable `.app`).

Install the safe, reversible pieces yourself (Command Line Tools via `xcode-select --install`; Node/Bun/git via Homebrew). **PAUSE and ask** before anything heavy or account-bound: full Xcode from the App Store, or anything using the user's Apple Developer account / notarization credentials.

## 2. What carries over vs what you rebuild
**Reuse UNCHANGED (~75% of the app — do NOT rewrite):** the Node sidecar (`sidecar.mjs`), the entire web UI (`ui/`), the five plugins (`config-template/opencode/{council,engram,skill-router,iterate-loop,verify-guard}`), `web.py`, and the config. They're already env-driven and home-relative.

**The three hard swaps (the real work):**
1. **The shell.** `Program.cs` (C# WinForms + WebView2) has no macOS runtime. Rebuild natively — **recommended: Swift + WKWebView** (smallest bundle, cleanest notarization, ~20-line host-bridge shim). **First do a WebKit smoke test:** load `ui/app.html` in a bare WKWebView and confirm the CRT theme (scanlines, glow, the Ω globe) renders faithfully. If WebKit mangles it, switch to **Electron** (guaranteed Chromium parity) before investing in Swift.
2. **The vault.** Windows DPAPI + PowerShell `secrets.ps1` → **macOS Keychain** via the `security` CLI. Preserve the exact get/list/set/remove contract the sidecar expects and the never-log / never-hang guarantees. Single-encrypted-blob model to dodge Keychain's per-item enumerate friction.
3. **The engine.** The Windows `opencode.exe` won't run, and you CANNOT use upstream opencode's Mac release — Agent Omega ships a **fork**. Build your own: `bun build --compile --target=bun-darwin-arm64` (or `-x64`) against the fork's `packages/opencode`. Bundle it **signed inside the `.app`** so Gatekeeper doesn't quarantine it. (The fork source is on the Windows box under `opencode-fork/` — pull it over too if it isn't already alongside this repo.)

Also rewrite any prompt/skill/reference doc that prefers **PowerShell** to **zsh/bash** for the Mac (inventory doc, category E) — that's runtime correctness, not just docs.

## 3. How to work — the workflow (non-negotiable)
- **Gated + incremental, riskiest real work first:** the WebKit smoke test, then the shell↔sidecar↔engine end-to-end path. Polish last. The UI already exists — don't rebuild it for a dopamine hit.
- **Prove BEHAVIOR, never plumbing.** A stage passes only on the correct observed OUTPUT for a real input — never "it compiled" / "the app launched." Bars:
  - **Shell:** the `.app` launches, WKWebView loads `ui/app.html`, connects to the sidecar over the loopback WebSocket, and **drives one real agent turn end-to-end** (type a prompt → see the model respond).
  - **Vault:** **round-trip** — store a secret in Keychain, read it back, assert the value, confirm the engine picks it up.
  - **Engine:** it runs a real prompt and returns a completion.
- **Adversarially self-verify with subagents.** After each piece, spawn subagent(s) whose job is to **try to BREAK it**, not admire it. Every finding cites `file:line` + a repro or it's dropped (no hallucinated gaps). Scale to stakes: one skeptic for a small slice; a 3–5 subagent panel for the risky paths (shell bridge, vault, notarization). A subagent's "done" is a claim — re-run the real thing yourself before believing it.
- If `~/.claude/hooks/build-mark.sh` exists, mark `active` at the start and `proven` only after the real shipping path is run and behavior verified.

## 4. Report to the user like this
The user does not read code. When something breaks or there's a real fork in the road, bring the **problem in plain English** — what's supposed to happen, what's happening instead and why (as a concept, not code) — then decide together. Never veto the goal; if a path looks risky, flag it as a gut-check and let the user choose, then go all-in. Check in at the natural gates: environment audit, smoke-test result, shell hosting the UI, first end-to-end turn, vault working, signed build.

## 5. Guardrails
- Work on the `mac` branch. Keep the SHARED code (sidecar/UI/plugins/config) working for BOTH OSes — factor per-OS differences cleanly; don't fork shared files.
- Never print, commit, or log secrets/keys.
- One-way / outward actions — pushing to GitHub, publishing a release, using the user's Apple Developer identity or notarization — **get explicit OK first**. Everything local is yours to run.
- **Start now with sections 0 and 1, and report the environment audit before building.**
