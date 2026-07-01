# shell
Running zsh/bash correctly through the `bash` tool on macOS — syntax, useful command equivalents, exit-code traps, and what hangs.

This machine runs zsh (the macOS default login shell) and bash. Use the `bash` tool for terminal work: git, npm, docker, and standard Unix commands. Do NOT use the shell for file work — use the dedicated tools:
- Find files: `glob` (NOT `find` / `ls -R`)
- Search content: `grep` (NOT `grep`/`rg` through the shell)
- Read files: `read` (NOT `cat` / `head` / `tail`)
- Edit files: `edit`; create/overwrite files: `write` (NOT `>` / `tee` / `sed -i`)
- Talk to the user: just output text (NOT `echo` / `printf`)

The shell's working directory persists between calls; shell state (variables, functions, `export`ed env vars) does NOT. Don't prefix commands with `cd` — you're already in the project dir; use absolute paths instead.

## Before you run
- If the command creates dirs/files, confirm the parent exists first (`[ -d path ]` / `test -d path`).
- Quote any path containing spaces with double quotes (or use `~`/`$HOME` for the home dir).
- Write a short, clear description of what the command does.

## zsh/bash syntax
- Variables take `$`: `myVar="value"` (NO spaces around `=`). Interpolate in double quotes: `"Hi $name"`, `"val ${obj}"`; single quotes are literal (no expansion).
- Escape char is backslash `\`, not backtick.
- Commands are plain executables/builtins: `ls`, `cd`, `mkdir`, `rm`, `cat`. Prefer POSIX flags (`-r`, `-f`, `-p`).
- `|` pipes text (bytes/lines), not objects — filter/shape with `grep`, `cut`, `awk`, `sort`, `xargs`.
- Env vars: read `$NAME` (or `${NAME}`), set for the session `export NAME="value"`, set for one command inline `NAME=value cmd` (a real bash feature — use it).
- macOS settings live in `defaults` domains (`defaults read com.apple.finder`), not a registry — read/write with the `defaults` tool, not raw plist paths.
- Run a native binary whose path has spaces by quoting it: `"/Applications/My App.app/Contents/MacOS/app" arg1 arg2`.

## Handy command notes (macOS is BSD, not GNU — some flags differ)
- `head` / `tail` → `head -n N file` / `tail -n N file` (prefer the `read` tool)
- `which` → `command -v name` (portable) or `which name`
- `touch` → `touch path` (creates if absent, updates mtime if present; does NOT truncate)
- `wc -l` → `wc -l < file` (avoids the filename in output)
- `mkdir -p` → `mkdir -p path` (works as expected)
- `rm -rf` → `rm -rf path` (destructive — see the safety notes below)
- `ln -s` → `ln -s target link` (target first on macOS/BSD)
- `chmod` / `chown` → `chmod 755 path`, `chown user:group path` (real on macOS; use `sudo` only when genuinely required, and expect it to fail non-interactively)
- `2>/dev/null` → `2>/dev/null` (usually unnecessary — stderr is captured for you)
- inline env var → `VAR=x cmd` (native; no wrapper needed)
- macOS `sed`/`date`/`readlink` are BSD variants: `sed -i ''` needs an explicit backup-suffix arg, `date` uses `-v` for math, `readlink -f` is missing (use `grealpath` from coreutils if installed). Prefer the dedicated file tools over shell text-munging anyway.

## Exit codes (a trap)
Each command sets `$?` to its exit status (0 = success). In a pipeline `$?` reflects only the LAST command unless `set -o pipefail` is on — a failing `curl … | jq …` can report success because `jq` succeeded. Chain with `&&` (run next only on success) rather than `;` when a later step depends on an earlier one. To make a failure non-fatal, append `|| true`; to branch on it, use `if cmd; then …; else …; fi` (tests the exit status directly, no extra flags).

## Don't hang (the shell is non-interactive)
- NEVER run anything that reads from a TTY: `read` (the shell builtin), `sudo` with a password prompt, `ssh` to an unknown host (host-key prompt), `passwd`, or a bare pager (`less`, `man` without `| cat`). Add `--no-pager` to git, pipe to `cat`, or set `PAGER=cat`.
- Destructive commands run without confirmation — there is no "are you sure?" — so double-check `rm -rf`, `git clean`, and redirection (`>`) targets before running them.
- Never run editor-opening git commands: `git rebase -i`, `git add -i`, `git commit` without `-m`, etc. (they launch `$EDITOR` and block).
- For credentials/keys, pull from the local vault rather than prompting — don't echo secret values except where the immediate command needs them (see below).

## Multiline strings to native commands (commit messages, file bodies)
Use a quoted heredoc so `$` and backticks stay literal. Quote the delimiter (`<<'EOF'`) to suppress expansion; the closing `EOF` MUST sit on its own line with no trailing text:
```bash
git commit -F - <<'EOF'
Commit message here.
Second line with $literal dollar signs.
EOF
```
For a message on the command line, `git commit -m "$(cat <<'EOF' … EOF)"` also works. Prefer `<<'EOF'` (literal) over `<<EOF` (expanded) unless you actually need expansion. To stop flag parsing after a `--`, put option-like args after it: `git log -- --format-looking-path`.

## Running multiple commands
- Independent commands that can run in parallel → make multiple `bash` tool calls in one message.
- Commands that depend on each other → chain in one call with `&&` (`cmd1 && cmd2` runs cmd2 only if cmd1 succeeds) or `||` (`cmd1 || cmd2` runs cmd2 only if cmd1 fails).
- Use `;` only when commands must run in sequence but you don't care whether earlier ones fail.
- Do NOT separate commands with raw newlines meant as separators (newlines are fine *inside* quoted strings / heredocs).
- Run something in the background without blocking with `nohup cmd >log 2>&1 &` (detaches and survives the call); a plain `cmd &` also backgrounds it within the call.
- For big jobs you can offload, hand the unit of work to a subagent via the `task` tool (helper1 / helper2) rather than running everything inline.

## Secrets vault
Pull credentials from the local vault instead of hardcoding or prompting. On macOS the vault is backed by the login Keychain:
```bash
sh ~/.agent-omega/secrets.sh get KEY
```
That wrapper reads from the Keychain; the underlying call is `security find-generic-password -s agent-omega -a vault -w` (returns the stored value on stdout). Don't print a fetched secret except where the immediate command consumes it (e.g. `TOKEN=$(sh ~/.agent-omega/secrets.sh get GH_TOKEN) gh auth …`).

## git
- Prefer a new commit over amending.
- Before destructive ops (`git reset --hard`, `git push --force`, `git checkout -- …`), look for a safer path that reaches the same goal; only go destructive when it's genuinely best.
- Never skip hooks (`--no-verify`) or bypass signing (`--no-gpg-sign`, `-c commit.gpgsign=false`) unless explicitly asked. If a hook fails, fix the root cause.
