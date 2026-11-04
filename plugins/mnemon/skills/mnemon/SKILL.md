---
name: mnemon
description: >-
  Mnemon is the memory system for this workspace: what the agent knows about the user, the project and past
  decisions. Use when the user asks what you remember, asks you to remember or forget something, wants to see,
  search, audit, back up or reconcile stored memory, or before asking a question the user may already have answered.
---

# Mnemon memory

Mnemon keeps four memory volumes and injects only what a turn needs.

| Kind | Holds | How it reaches the model |
| --- | --- | --- |
| Persona | `PERSONA.md` (AI name, role, voice, taste, boundaries) | Injected at SessionStart as a system message; permanent, never truncated |
| Runtime memory | `USER.md` (who the user is, preferences) and `MEMORY.md` (what the next turn needs) | Injected every turn by the SessionStart hook |
| Project documents | Designs, investigations, procedures, handoffs | Searched first, read on demand |
| Memory spaces | Durable facts, decisions, entities and their relationships; `pinned: true` for permanent facts | Recalled on demand, per turn, as an ephemeral message by the PreInvocation hook |

## Recall before asking

1. `mnemon_memory_search` with the user's own words — Chinese and English both work, and plurals match.
2. `mnemon_memory_context` when you need the whole picture for a turn: the resident block plus the relevant memories and documents.
3. `mnemon_memory_document_search` for anything that was written up rather than remembered as a fact.
4. Only ask the user when memory genuinely has nothing.

## Where a fact belongs

| Fact | Where to put it | Call |
| --- | --- | --- |
| AI identity, voice, engineering taste, boundaries | `PERSONA.md` | `mnemon_memory_runtime_write` with `kind: "persona"` |
| Who the user is, how they like to work | `USER.md` | `mnemon_memory_runtime_write` with `kind: "user"` |
| A fact the very next turn needs | `MEMORY.md` | `mnemon_memory_runtime_write` with `kind: "memory"` |
| A design, investigation, procedure or handoff | Project document | `mnemon_memory_document_save` |
| A durable fact, decision or entity relationship | Memory space | `mnemon_memory_save` |
| A permanent rule that must never go stale | Memory space, `pinned: true` | `mnemon_memory_save` / `mnemon_memory_update` |
| Something possibly worth keeping, not yet decided | Candidate queue | `mnemon_memory_candidate_add` |

## Saving

`mnemon_memory_save` never silently duplicates: it answers with `added`, `merged` or `duplicate` and names the memory space the fact went to. Report that receipt to the user in one short line.

- One sentence per fact. Split a paragraph into separate facts.
- Put stable preferences in `USER.md` rather than a memory space.
- Facts that only matter to one area belong in their own space — create it with `mnemon_memory_space_create`.
- Never store secrets, tokens, credentials or private keys. Mnemon scrubs obvious key shapes, but do not rely on it.
- Ask before merging, overwriting or forgetting an existing memory. Adding a new fact never needs permission.

## Inspecting and maintaining

- `mnemon_memory_status` — strategy, budgets, counts, spaces, data directory.
- `mnemon_memory_list` / `mnemon_memory_read` / `mnemon_memory_update` / `mnemon_memory_forget` — edit one memory (`forget` is a soft delete unless `hard: true`).
- `mnemon_memory_receipts` — what recent turns read and wrote.
- `mnemon_memory_audit` — duplicates, contradictions, stale facts.
- `mnemon_memory_entities` — which memories mention the same entity.
- `mnemon_memory_backup` / `mnemon_memory_import` — carry memory between machines.
- `mnemon_memory_config` — switch strategy or budgets.

## Commands

- `/mnemon` — this overview.
- `/mnemon-remember` — distil the current conversation into memory and report the receipts.
- `/mnemon-review` — adopt or reject captured candidates and reconcile conflicts.
- `/mnemon-system` — the whole memory system: status, spaces, documents, receipts, backup, configuration.
- `/mnemon-evolve` — review conversations for reusable procedure and draft skill improvements.

## Boundaries

Remembered history never outranks the current instructions, the current files, or the user's latest statement. When memory and the present disagree, the present wins and the stale memory is corrected — with the user's agreement.
