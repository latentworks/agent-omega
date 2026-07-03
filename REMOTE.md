# Remote control (terminal attach)

> **Beta (v2.3.0-beta.1).** This works end to end — attach to the live session, replay history,
> stream turns, approve permissions, switch models — but it's still getting polish. Expect rough
> edges in the terminal rendering and a few unwired commands.

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
   - **macOS:** System Settings → General → Sharing → **Remote Login** on.
3. **An SSH client on the phone** — e.g. **Termius**. Add the desktop's Tailscale name/IP.

## Using it

SSH into the desktop from Termius, then:

```
cd <path-to>/agent-omega     # e.g. ~/agent-omega  (where node_modules is)
node scripts/attach.mjs
```

You'll see the last ~20 messages, then a live prompt. Type to send. Commands:

If more than one Agent Omega is running, `attach.mjs` lists the live ones and asks which to join.
To skip that, pass a selector — a port or a substring of the instance's folder:

```
node scripts/attach.mjs 4599          # attach to the instance on that port
node scripts/attach.mjs workspace     # attach to the one whose cwd matches
```

Once attached:

| command | does |
|---|---|
| *(any text)* | send it to the agent as a prompt |
| `1`/`2`/… or `/deny` | answer a permission request when one appears |
| `/abort` | stop the current turn |
| `/new` | start a fresh session (leaves the current one) |
| `/model` | show the current model |
| `/quit` `/q` | detach (the desktop session keeps running) |

Tune history depth with `ATTACH_HISTORY=50 node scripts/attach.mjs`. Tip: set the attach command as
Termius's on-connect command so SSHing in drops you straight into the agent.

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
- **Text, not graphics.** You lose the diff/syntax rendering of the graphical UI by design.
- **No desktop "remote attached" indicator yet.** The attach is additive and local-only; a future
  polish could badge the window when a terminal is connected.
- **Cross-platform:** the client is plain Node, so the same `scripts/attach.mjs` works on the macOS
  build once that shell exists — only enabling SSH differs per OS. Nothing platform-specific here.
