# Memory index

This file is your curated, file-based memory index. It is loaded into your context at the
start of every session. Keep it to one line per memory — a pointer, never the full content.

Each memory is a separate file in this `memory/` folder, with frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance>
metadata:
  type: user | feedback | project | reference
---

<the one fact; for feedback/project add **Why:** and **How to apply:** lines. Link related
memories with [[their-name]].>
```

When a task relates to an entry below, read that memory file before acting. Add a new memory
by creating `memory/<slug>.md` and adding a one-line pointer here:

`- [Title](slug.md) — one-line hook`

(This index ships empty. Your entries go below.)
