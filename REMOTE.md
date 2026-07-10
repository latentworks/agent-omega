# Remote control (terminal attach)

> **Stable (v2.5.1).** Terminal rendering redesigned to a Claude-Code-style TUI — bordered input
> box, live spinner, tool/permission cards, `+`/`−` diff tinting, arrow-or-digit menus — attach to the
> live session, replay history, stream turns, approve permissions, switch models. Falls back to a plain
> scrolling log on dumb terminals / non-TTY (`ATTACH_PLAIN=1`).

Drive or watch a **running** Agent Omega from another device — your phone, a laptop — over SSH,
in a plain terminal. You join the **live session the desktop window is showing** (it never spins
up a new one), the recent thread pops up so you have context, and everything streams live:
prompts, output, and permission approvals. The UI is just text instead of the graphical window.

Nothing is exposed to the network. SSH is what gets you onto the machine; the attach client then
talks to the same loopback socket the desktop UI uses. Requires the desktop app to be running
(that's where the session lives — there's no cloud copy).

## One-time setup

1. **Tailscale** on both the desktop and the phone (same account). This is the encrypted, no-port-
   forward way to reach your machine from anywhere; the traffic is end-to-end encrypted and no
   relay sees it. (On the same Wi-Fi you can skip Tailscale and use the LAN IP.)
2. **An SSH server on the desktop:**
   - **Windows:** OpenSSH Server (Settings → Optional Features → *OpenSSH Server*, then start the
     `sshd` service). Already enabled on the dev machine.
   - **macOS:** System Settings → General → Sharing → **Remote Login** on. The `.app` bundles its own compiled sidecar, so the repo root has no `node_modules` — run `npm install` once at the repo root before `node scripts/attach.mjs` (the attach client needs the `ws` dependency).
   - **Linux:** install + enable OpenSSH server (`sudo apt install openssh-server && sudo systemctl enable --now ssh`, or the distro equivalent). Linux browser mode ships on the `linux-browser-mode` branch (not `main`): check out that branch and run `npm run start:linux`; attach the same way — the sidecar it launches writes the same descriptor.
3. **An SSH client on the phone** — e.g. **Termius**. Add the desktop's Tailscale name/IP.

## Install the `omg` command (one time, on the desktop)

```
node scripts/install-connect.mjs
```

Installs a short launcher **`omg`** (and `omega`) onto your PATH so you never type a long path again.
Open a new shell for it to take effect. `--remove` uninstalls; `--force` installs even if something
else named `omg` already exists.

## Using it

SSH into the desktop from Termius, then just:

```
omg                 # attach — auto-picks if one app is running
omg <selector>      # a port, a cwd substring, or a descriptor .json path
```

No-install fallback (always works): `node <repo>/scripts/attach.mjs [selector]`.

You land in a Claude-Code-style TUI — a header card, your recent thread, then a bordered input box.
**Termius tip:** set the host's *on-connect command* to `omg` to drop straight into the agent on SSH.

### Keys

| key / input | does |
|---|---|
| *type + Enter* | send a prompt |
| `\` + Enter, or `Ctrl+J` | newline (multi-line); a paste is inserted, never auto-sent |
| `↑` / `↓` | recall your recent prompts (history) |
| in a menu: `↑`/`↓` + Enter, or a digit | choose (permissions, `/model`) |
| `Esc` | abort the turn · deny a permission · cancel a menu |
| `Ctrl+C` ×2 | detach · `Ctrl+L` redraws a garbled screen |
| `/model` | list/switch model (`/model <n\|name>` is non-interactive) |
| `/commands` | list the agent's slash commands |
| `/abort` · `/new` · `/quit` | stop the turn · fresh session · detach |
| any other `/cmd` | forwarded to the agent (`/verify`, `/tdd`, …) |

Env knobs: `ATTACH_HISTORY=50` (replay depth) · `ATTACH_PLAIN=1` (force the plain log) ·
`ATTACH_ASCII=1` (ASCII glyphs for odd fonts) · `ATTACH_THOUGHTS=1` (show thinking) ·
`ATTACH_DEBUG=1` (raw frames).

## How it works (short version)

Each running sidecar writes a **user-only** descriptor at `~/.agent-omega/instances/<pid>.json`
(`{port, apiPort, token, pid, cwd}`) — the loopback port + launch token + the engine's API port —
and removes it on exit. `attach.mjs` scans that folder, keeps only the descriptors whose process is
still alive (so a stale/clobbered one can't misroute you), then connects to the loopback control
WebSocket (the same one the desktop UI uses, which is already multi-client and always hands a new
connection the *current* session) and pulls recent history from the engine's local REST API. So the
desktop window and the terminal are two live views of one session — type on either, it shows on
both. Per-instance descriptors mean several Agent Omegas (desktop app, a test, a harness) coexist
without clobbering each other — you pick which to attach to.

## Known limits / accepted gaps

- **Desktop app must be running.** You're remote-controlling the live instance, not resuming from a
  server. If it's closed, there's nothing to attach to.
- **One driver at a time.** Both views stream simultaneously, but if a turn is mid-flight a second
  prompt from the other device waits until it finishes (or `/abort`). Handing off (put phone down,
  use desktop) is seamless.
- **No network exposure by itself.** The socket stays loopback-bound; the descriptor is readable
  only by the logged-in user — the same trust level as that user, who can already reach loopback.
  Reaching the box is SSH's job, not this feature's. (Binding to a network interface would be a
  separate, opt-in step and is intentionally *not* done here.)
- **Multiple instances coexist.** Each writes its own `instances/<pid>.json`; attach lists the live
  ones (or takes a port/name selector). Stale descriptors from a crashed instance are ignored
  (the pid is checked) and cleaned up on the next normal exit.
- **Text, not graphics.** The desktop's graphical chrome (Ω globe, themes) stays on the desktop; the
  TUI carries the full *functional* session — streaming, tool cards, `+`/`−` diff coloring, menus. Only
  full syntax-highlighting of code blocks is dropped (a deliberate scope call).
- **No desktop "remote attached" indicator yet.** The attach is additive and local-only; a future
  polish could badge the window when a terminal is connected.
- **Cross-platform:** the client is plain Node, so the same `scripts/attach.mjs` works on the macOS
  build (`mac/AgentOmega.swift`) today — only enabling SSH differs per OS. Nothing platform-specific here.
