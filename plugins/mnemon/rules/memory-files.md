---
trigger: glob
globs: "**/PERSONA.md, **/USER.md, **/MEMORY.md, **/mnemon-vault/**, **/.mnemon/**"
description: Conventions for the plain-text memory files Mnemon keeps on disk.
---

- These files are Mnemon's store, not scratch space: write them through `mnemon_memory_runtime_write` (`kind: persona | user | memory`), `mnemon_memory_save` or the `mnemon` CLI so revisions, mirroring and receipts stay consistent.
- `PERSONA.md` is the permanent AI persona: name, role, voice, engineering taste, boundaries. It is injected at every SessionStart and never truncated by the resident budget — keep it precise and free of project trivia.
- `USER.md` holds stable facts about the user; `MEMORY.md` holds what the next turn needs. Neither should grow into a document — move anything longer into a project document.
- One fact per line. Keep the existing headings; append under them rather than rewriting the file.
- Mark a durable fact with `pinned: true` only when it must never go stale (standing conventions, safety rules, identity). Pinned facts bypass the stale list and rank higher in recall.
- Never write secrets, tokens or credentials into these files.
- Files under `revisions/`, `documents/.revisions/` and `documents/.archive/` are history: read them to recover an earlier wording, but do not edit or delete them.
