# powershell
Running PowerShell correctly through the `bash` tool on Windows — syntax, Unix-command equivalents, exit-code traps, and what hangs.

This machine runs both PowerShell 7+ (`pwsh`) and git-bash. Use the `bash` tool for terminal work: git, npm, docker, and PS cmdlets. Do NOT use the shell for file work — use the dedicated tools:
- Find files: `glob` (NOT `Get-ChildItem -Recurse`)
- Search content: `grep` (NOT `Select-String`)
- Read files: `read` (NOT `Get-Content`)
- Edit files: `edit`; create/overwrite files: `write` (NOT `Set-Content` / `Out-File`)
- Talk to the user: just output text (NOT `Write-Output` / `Write-Host`)

The shell's working directory persists between calls; shell state (variables, functions) does NOT. Don't prefix commands with `cd` / `Set-Location` — you're already in the project dir; use absolute paths instead.

## Before you run
- If the command creates dirs/files, confirm the parent exists first (`Test-Path`).
- Quote any path containing spaces with double quotes.
- Write a short, clear description of what the command does.

## PowerShell syntax
- Variables take `$`: `$myVar = "value"`. Interpolate in double quotes: `"Hi $name"`, `"val $($obj.Prop)"`.
- Escape char is backtick `` ` ``, not backslash.
- Cmdlets are Verb-Noun: `Get-ChildItem`, `Set-Location`, `New-Item`, `Remove-Item`. Aliases: `ls`, `cd`, `cat`, `rm`.
- `|` pipes objects, not text — filter/shape with `Where-Object`, `Select-Object`, `ForEach-Object`.
- Env vars: read `$env:NAME`, set `$env:NAME = "value"` (NOT `Set-Variable`, NOT bash `export`).
- Registry: use PSDrive prefixes `HKLM:\SOFTWARE\...`, `HKCU:\...` — NOT raw `HKEY_LOCAL_MACHINE\...`.
- Run a native exe whose path has spaces via the call operator: `& "C:\Program Files\App\app.exe" arg1 arg2`.

## Unix commands that don't exist in PowerShell — use these
- `head` / `tail` → `Get-Content file -TotalCount N` / `-Tail N`; piped: `| Select-Object -First N` / `-Last N`
- `which` → `(Get-Command name).Source`
- `touch` → `if (-not (Test-Path path)) { New-Item -ItemType File path }`  (NEVER `New-Item -Force` on a file — it truncates existing content)
- `wc -l` → `(Get-Content file | Measure-Object -Line).Lines`
- `mkdir -p` → `New-Item -ItemType Directory -Force path`  (`-p` is not a PS flag)
- `rm -rf` → `Remove-Item -Recurse -Force path`
- `ln -s` → `New-Item -ItemType SymbolicLink -Path link -Target target`
- `chmod` / `chown` → N/A on Windows; use `icacls` only if you must change ACLs
- `2>/dev/null` → `2>$null` (usually unnecessary — stderr is captured for you)
- `VAR=x cmd` → `$env:VAR = 'x'; cmd` (no inline env-var prefix in PS)
- Bash control flow (`if [ -f x ]`, `for x in *`, backtick command substitution) is a PS parse error → use `if (Test-Path x)`, `foreach ($x in ...)`, `$(cmd)`

## Exit codes (a trap)
`-ErrorAction SilentlyContinue` hides error *output* but the cmdlet still fails and the call reports exit 1. To make a failure truly non-fatal, promote it to terminating and swallow it: `try { Cmdlet ... -ErrorAction Stop } catch {}`. Without `-ErrorAction Stop`, non-terminating errors skip `catch` and still exit 1.

## Don't hang (the shell is non-interactive)
- NEVER use `Read-Host`, `Get-Credential`, `Out-GridView`, `$Host.UI.PromptForChoice`, or `pause`.
- Destructive cmdlets (`Remove-Item`, `Stop-Process`, `Clear-Content`, …) may prompt — add `-Confirm:$false` when you mean it to proceed; `-Force` for read-only/hidden items.
- Never run editor-opening git commands: `git rebase -i`, `git add -i`, etc.
- For credentials/keys, pull from the local vault rather than prompting — don't echo secret values except where the immediate command needs them.

## Multiline strings to native exes (commit messages, file bodies)
Use a single-quoted here-string so `$` and backticks stay literal. The closing `'@` MUST sit at column 0 on its own line (indenting it is a parse error):
```powershell
git commit -m @'
Commit message here.
Second line with $literal dollar signs.
'@
```
Prefer `@'...'@` (literal) over `@"..."@` (interpolated) unless you actually need expansion. For args containing `-`, `@`, or other operator chars, use the stop-parsing token: `git log --% --format=%H`.

## Running multiple commands
- Independent commands that can run in parallel → make multiple `bash` tool calls in one message.
- Commands that depend on each other → chain in one call. `pwsh` 7+ supports `&&` and `||` like bash (`cmd1 && cmd2` runs cmd2 only if cmd1 succeeds). Ternary `$c ? $a : $b`, null-coalescing `??`, and null-conditional `?.` are available.
- Use `;` only when commands must run in sequence but you don't care whether earlier ones fail.
- Do NOT separate commands with raw newlines (newlines are fine *inside* quoted strings / here-strings).
- For big jobs you can offload, hand the unit of work to a subagent via the `task` tool (helper1 / helper2) rather than running everything inline.

## git
- Prefer a new commit over amending.
- Before destructive ops (`git reset --hard`, `git push --force`, `git checkout -- …`), look for a safer path that reaches the same goal; only go destructive when it's genuinely best.
- Never skip hooks (`--no-verify`) or bypass signing (`--no-gpg-sign`, `-c commit.gpgsign=false`) unless explicitly asked. If a hook fails, fix the root cause.
