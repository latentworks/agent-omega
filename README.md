# Agent Omega

A desktop coding agent that runs on your own machine. Agent Omega is a frameless
desktop app — a single quiet window — that ships on Windows and macOS from a
single trunk, wired to a coding engine that reads and writes your files, runs
commands, searches your code, and reaches the web. You talk to it; it does the
work.

The point isn't a bigger model. The point is the **harness** around the model:
skills it can load on demand, real tools, persistent memory, a verify-before-done
discipline, an iterate-and-fix loop, and an optional multi-model council. The bet
Agent Omega makes is that a smaller, local, or rate-limited model — driven well
through that harness — can reach results people usually assume require a frontier
model and a full token budget. Not by magic, and not every time. By working the
way a careful engineer works: try, check the real output, fix, and try again.

---

## What it is (honestly)

Agent Omega is **built on [opencode](https://github.com/sst/opencode)**, the
open-source coding-agent engine. It is a fork, extended — not a from-scratch
engine. opencode does the hard part: the agent loop, tool calls, provider
plumbing, the ACP protocol. Agent Omega wraps and extends it with a desktop shell,
an encrypted secrets vault, anonymous web access, a skill and memory system, model
delegation, and the council. Credit where it's due: without opencode there is no
Agent Omega.

The shape of the thing:

- A **frameless C# WinForms + WebView2 window** (`Program.cs`) — the shell. It
  owns the window and its title-bar controls and nothing else.
- A **Node sidecar** (`sidecar.mjs`) — the driver. It spawns the opencode engine,
  speaks its protocol as the client, and bridges everything to the UI over a
  local WebSocket (loopback only, gated by a per-launch token so nothing else on
  the machine can talk to it).
- The **opencode engine** — the brain, running your chosen model.

The behaviors it layers on top borrow openly from two places that got a lot right —
the tool discipline of OpenAI's **Codex** and the working style of Anthropic's
**Claude Code** — plus the owner's own workflows for verification, delegation, and
memory. These are ideas **blended and integrated**, not invented here. The value
Agent Omega claims is in the integration: getting these patterns to work together
in one hot-swappable, local-first tool.

---

## Who it's for

Two people, mainly:

- **The dev hopping provider to provider on free tokens.** You keep a stack of free
  or trial API tiers and rotate through them. Agent Omega lets you drop any of them
  in as the driving model — or run fully local and spend nothing — and keep the same
  harness, skills, and memory across all of them.
- **The dev who hits the token wall mid-task.** You're doing real work on a base
  Codex or GPT tier and you run out of runway halfway through. Instead of switching
  platforms and losing your context, you swap the model underneath — to another
  provider or to a local model on your own hardware — and keep going in the same
  window, same conversation, same project.

In both cases the win is the same: the work is anchored to the harness, not to any
one model or vendor.

---

## Anonymity and safety — the first pillar

This is a first-class concern, not a footnote.

- **Local secrets vault.** Your API keys live in a per-user secrets store —
  Windows DPAPI, the macOS login Keychain, or (on Linux) environment variables plus a
  plaintext fallback file with 0600 permissions — each readable only as your own OS user.
  Agent Omega reads a key out of the vault and
  hands it to the engine's environment at launch — the key never gets written into
  code, into config you might commit, or into logs. A missing key is simply skipped
  (that provider stays dark); nothing is ever faked to cover a gap.
- **Key-free anonymous web access.** *(Requires a separate `anon-web` component that isn't
  publicly distributed — so web search is **disabled by default** in this build.)* Where present,
  the agent has no raw internet access; every web search and page read goes through a local
  gateway that reaches a private, key-free search engine — no account, no API key, no per-query
  identity trailing back to you.
- **A fully-local option.** Point Agent Omega at models running on your own machine
  (or your own boxes on your LAN) and your code, your prompts, and your files never
  leave your hardware. No cloud provider sees the work at all.
- **A control channel that stays local.** The window and the engine talk over a
  loopback-only socket, and only the real app window holds the token to use it.
  It is not exposed to your network.

The safety model is narrow and deliberate: protect your machine from damage, protect
your private data, and report honestly. Destructive or hard-to-reverse actions pause
for your say-so; reading and local edits just happen.

---

## A short feature tour

- **Hot-swappable models.** Switch the driving model mid-session from a menu —
  local or cloud, whichever you've wired up. The conversation continues.
- **The council.** Optionally have several models weigh in on a problem before the
  lead acts, then synthesize their views. Ensemble and "fusion" approaches like this
  are well-established and not novel — Agent Omega's contribution is making it a
  practical, configurable, hot-swappable part of a working tool (roster, rounds,
  and synthesizer all editable from the UI).
- **Skills.** Task-specific procedures the agent loads on demand — debugging,
  test-driven development, code review, verification, running an app, and more —
  so the right method is applied to the right kind of work.
- **Persistent memory.** A file-based memory that carries across sessions plus an
  automatic long-term store, so the agent builds up context about you and your
  projects instead of starting cold every time.
- **Delegation to helper models.** The lead can hand self-contained grunt work —
  broad searches, mechanical multi-file edits, boilerplate, independent review — to
  fast local helper models, keeping its own context clean.
- **Verify before done.** A built-in discipline: the agent is expected to run the
  real thing and observe the real output before it calls anything finished — not to
  stop at a green-looking edit it never ran.
- **Interactive permissions.** When the agent wants to do something with blast
  radius, you get an in-app prompt to approve or decline it.

---

## Quick start

Agent Omega ships on Windows and macOS. On Windows it expects .NET 8, Node.js, and
the WebView2 runtime; on macOS it's a self-contained Swift + WKWebView build (Apple
Silicon, macOS 13+). Full setup — dependencies, building the shell, wiring your
models, and stocking the vault — lives in **[SETUP.md](SETUP.md)**.

The short version: build the WinForms app, make sure Node and the opencode engine
binary are in place, add at least one model (a local one needs nothing but the model
running; a cloud one needs its key in the vault), and launch. The window comes up,
the sidecar starts the engine, and you're talking to it.

Running a local model? The default configuration is the **evidence-backed 30–35B
tune** — which models to use, the serving flags that matter (thinking mode is not
optional on reasoning models), and the benchmark rigor behind it all live in
**[TUNES.md](TUNES.md)**. Tunes for larger models (DeepSeek-class) are next.

---

## Coming soon (V3)

Roadmap — flagged as what's ahead, not shipped yet:

- **A council that doesn't just discuss but builds** — carrying a task through to a verified,
  working result, with real end-to-end examples to back the claim.
- **Linux** — a native build/branch is in progress (the app is already largely
  cross-platform under the desktop shell).
- **A richer graphical workspace** — an editor-style view in the spirit of Cursor / Codex,
  alongside the current terminal-first UI.
- **More themes** beyond the CRT + Modern pair.
- **Ongoing improvement testing** — the agent's behavior (skills, tools, verification) is under a
  continuous test-and-improve loop, so expect steady updates.

Watch this repo for updates. When something here is real and measured, it gets documented — not before.

---

## Credits

- **[opencode](https://github.com/sst/opencode)** — the open-source engine Agent
  Omega is built on. The foundation this whole thing stands on.
- **OpenAI Codex** and **Anthropic Claude Code** — the coding-agent patterns Agent
  Omega learned from and integrated. Ideas borrowed and blended, not invented here.
- The desktop shell, secrets vault, web gateway, skill and memory system, council
  integration, and the owner's own workflows are the local additions on top.
