---
name: skill-creator
description: Use when a reusable procedure or hard-won lesson emerges that should become a skill — to author a new one correctly and wire it in.
---

SKILL: CREATING A NEW SKILL
Flexible skill: adapt these principles to the situation.
Use when you've solved something in a repeatable way, or learned a rule worth keeping, and it should
become a reusable skill you can invoke later.

WHAT A SKILL IS
- A focused playbook for ONE kind of task or decision. It loads on demand, so it must be
  self-contained and TIGHT — not a dumping ground. A bloated skill the model won't follow is worse
  than no skill.

HOW TO WRITE ONE
- Name it kebab-case for what it DOES (e.g. "api-error-handling", not "misc-helpers").
- Frontmatter: exactly two fields — `name` and a one-line `description` that is the TRIGGER,
  concrete enough that you know exactly when it applies ("Use when ..."). State whether it is RIGID
  (follow exactly) or FLEXIBLE (adapt) in the FIRST line of the body, NOT the frontmatter.
- Body: the actual procedure — steps, rules, red flags, a short example if it helps. Imperative and
  specific. Cut anything not load-bearing.
- Keep it transferable — no project one-off trivia unless that's the whole point of the skill.

WHERE IT GOES / WIRING IT IN
   (Paths honor XDG_CONFIG_HOME — the launcher sets it on Mac and for any isolated instance, so
   writing to a bare ~/.config would land the skill where the engine never scans. Always use the
   `${XDG_CONFIG_HOME:-$HOME/.config}` form below.)
1. Create the folder + file:  ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skill/<name>/SKILL.md
   OpenCode auto-discovers every skill/<name>/SKILL.md and exposes it through your `skill` tool — no
   registry file to edit. A brand-new skill is picked up when OpenCode next starts.
2. (Optional but recommended) add a slash-command so the user can force it:
   ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/command/<name>.md  with frontmatter `description:` and a body of
   "Use the '<name>' skill, then follow it exactly, applied to: $ARGUMENTS".
   (The skill router also auto-registers it from the frontmatter, so it can fire automatically —
   there is no separate registry to maintain.)

VERIFY IT WORKS
- Restart OpenCode, then trigger it on a real example and confirm your `skill` tool now lists it and
  that invoking it loads the body and is FOLLOWED. A skill that never fires (weak trigger) or that
  gets ignored (too vague or too long) is a failed skill — fix the trigger wording or tighten the
  body.

WHEN NOT TO MAKE ONE
- One-off tasks, or anything the model already does well by default. Skills are for repeatable
  procedures and hard-won rules — not notes.
