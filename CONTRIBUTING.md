# Contributing to Agent Omega

Thanks for your interest in Agent Omega! Contributions of all kinds are
welcome -- bug reports, fixes, docs, and features. This guide keeps things
short so you can get going quickly.

## Repo layout

- **Root** -- the Agent Omega desktop app: the C# .NET (WinForms/WebView2)
  shell, the Node.js sidecar, and the Python web bridge.
- **config-template/opencode/** -- the plugin and agent configuration that
  ships with the app (shipped source, safe to edit).
- **docs/** -- documentation, including setup and architecture notes.

## Built on opencode

Agent Omega wraps the open-source, MIT-licensed **opencode** engine. The core
agent runtime lives upstream, so if you hit something that's really an
engine-level bug or feature request (not part of Agent Omega's shell, sidecar,
config, or bridge), it likely belongs upstream at the opencode project rather
than here. When in doubt, open an issue here and we'll help route it.

## Getting set up

Setup and how to run the app locally are covered in **SETUP.md**. Start there
before making changes so your environment matches what the app expects.

## Making changes

1. Fork and branch from the default branch.
2. Keep changes focused -- one logical change per pull request.
3. Match the existing style of the file you're editing.
4. Test your change against the real app path, not just a build succeeding.
5. Open a pull request with a clear description of what and why.

## Reporting bugs

Open an issue with what you expected, what actually happened, and the steps to
reproduce. Screenshots or logs help a lot.

Happy hacking!
