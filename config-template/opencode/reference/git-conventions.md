# git-conventions

Purpose: how to make git commits and GitHub PRs safely and cleanly — only when asked, never destructively.

Use the `bash` tool for all git and `gh` work. Both PowerShell and git-bash are available; prefer PowerShell, and use its `@'...'@` here-string for multi-line messages. For any GitHub task (issues, PRs, checks, releases, or reading a GitHub URL), use the `gh` CLI.

## Safety protocol (always)

- Commit ONLY when the user explicitly asks. If it's unclear, ask first — proactive commits are unwelcome.
- NEVER touch git config.
- NEVER run destructive/irreversible commands — `push --force`, `reset --hard`, `checkout .`, `restore .`, `clean -f`, `branch -D` — unless the user explicitly requests that exact action. They lose work; only run on direct instruction.
- NEVER force-push to `main`/`master`. If asked, warn first.
- NEVER skip hooks (`--no-verify`, `--no-gpg-sign`, etc.) unless explicitly requested.
- NEVER use interactive `-i` commands (`git rebase -i`, `git add -i`) — they block on input that can't be supplied. Don't use `--no-edit` with `git rebase` either (not a valid rebase flag).
- Stage specific files by name. Avoid `git add -A` / `git add .` — they sweep in secrets (`.env`, `credentials.json`) and large binaries. Never commit likely-secret files; warn if the user insists.
- Always create a NEW commit; never `--amend` unless explicitly asked. A failed pre-commit hook means the commit did NOT happen — `--amend` would then rewrite the PREVIOUS commit and destroy work. After a hook failure, fix the issue, re-stage, and make a NEW commit.
- Don't push unless the user asks.
- Don't create an empty commit when there's nothing to commit.

## Make a commit

1. Gather context in parallel (one message, multiple `bash` calls):
   - `git status` — see untracked files. Never use `-uall` (memory blowup on large repos).
   - `git diff HEAD` — staged + unstaged changes.
   - `git log --oneline -10` — match this repo's existing message style.
2. Draft the message:
   - Name the change type accurately: "add" = wholly new feature, "update" = enhancement to existing, "fix" = bug fix; also refactor/test/docs.
   - 1–2 sentences, focused on WHY over what.
   - Confirm no secret files are staged.
3. Stage the specific files and commit. Pass the message via a here-string so formatting survives. PowerShell — closing `'@` MUST be at column 0, no leading whitespace:
   ```powershell
   git add path/to/file1 path/to/file2
   git commit -m @'
   Commit message here.
   '@
   ```
   git-bash equivalent:
   ```bash
   git commit -m "$(cat <<'EOF'
   Commit message here.
   EOF
   )"
   ```
4. Run `git status` after the commit (sequentially — it depends on the commit landing) to confirm success.
5. If a pre-commit hook fails: fix it, re-stage, make a NEW commit. Do not amend.

Do NOT run extra code-exploration commands while committing — only git `bash` commands. Do NOT use the `todowrite` or `task` tools for committing.

## Create or update a PR

1. Gather context in parallel:
   - `git status` (no `-uall`).
   - `git diff HEAD`.
   - Check whether the branch tracks a remote and is current, so you know if a push is needed.
   - `git branch --show-current`.
   - `git log <base>...HEAD` and `git diff <base>...HEAD` for the FULL branch history (`<base>` = the default branch, usually `main`).
   - `gh pr view --json number` — does a PR already exist for this branch? In PowerShell: `gh pr view --json number 2>$null; if (-not $?) { "" }`.
2. Review EVERY commit that will be in the PR (all of them since the branch diverged — not just the latest), then draft a title and body.
   - Title: short, descriptive, under 70 chars. Put detail in the body, not the title.
3. Act in a single message:
   - If on the default branch, create a new branch first (prefix with the username, e.g. `username/feature-name`).
   - Push the branch (`-u` if it has no upstream yet).
   - If a PR already exists, update it with `gh pr edit`. Otherwise create one with `gh pr create`, body via here-string:
   ```powershell
   gh pr create --title "Short, descriptive title" --body @'
   ## Summary
   <1-3 bullet points>

   ## Test plan
   [Bulleted markdown checklist of TODOs for testing the PR]
   '@
   ```
   git-bash equivalent:
   ```bash
   gh pr create --title "Short, descriptive title" --body "$(cat <<'EOF'
   ## Summary
   <1-3 bullet points>

   ## Test plan
   [Bulleted markdown checklist of TODOs for testing the PR]
   EOF
   )"
   ```
4. Return the PR URL when done.

Do NOT use the `todowrite` or `task` tools for PR creation.

## Other

- View PR comments: `gh api repos/<owner>/<repo>/pulls/<number>/comments`.
