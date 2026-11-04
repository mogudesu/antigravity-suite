---
name: mnemon-system
description: >-
  The Mnemon memory system as a whole: status, memory spaces, project documents, turn receipts, strategies,
  budgets, backup, export and import. Use when the user asks how memory is configured or stored, wants to see
  everything that is remembered, wants to change the memory strategy, or wants to move memory to another machine.
---

# The memory system

## Status first

`mnemon_memory_status` reports the data directory, the active strategy and enhancements, budgets, and counts of memories, spaces, documents and pending candidates. Report the data directory whenever the user asks where memory lives — every file is plain text under it.

## The four stores

| Store | File | Purpose |
| --- | --- | --- |
| Persona | `runtime/PERSONA.md` | Permanent AI persona: injected at SessionStart, never truncated |
| Runtime memory | `runtime/USER.md`, `runtime/MEMORY.md` | Resident every turn; keep it small and current |
| Project documents | `documents/<id>.md` | Searched, then read on demand; every write keeps a revision |
| Memory spaces | `spaces/<space>/memories.jsonl` | Durable facts, one JSON object per line; `pinned: true` = permanent |

Also on disk: `candidates/pending.jsonl` (facts awaiting review), `receipts/<date>.jsonl` (what each turn read and wrote), `receipts/heal-*.json` (recovery receipts), `revisions/` and `documents/.revisions/` (history), `snapshots/` (local daily gzip copy), `backups/`. With `--mirror-dir`, runtime volumes, space files and documents are mirrored to `<mirror>/latest/` and daily snapshots live in `<mirror>/snapshots/`.

## Durability

- Every write is atomic (temp file + fsync + rename) and mirrored immediately.
- `mnemon_memory_mirror_sync` forces a mirror pass and writes today's snapshot if missing.
- `mnemon_memory_verify_heal` checks every primary file and restores missing/zero-byte/corrupt ones from the mirror or newest snapshot; it also runs at startup.
- `mnemon_memory_backup_verify` decodes a `.json.gz` backup with a real gzip decoder and returns its SHA-256.

## Inspecting

- `mnemon_memory_space_list` — spaces with counts and last update.
- `mnemon_memory_list` — memories, newest first; filter by `space` or `tag`.
- `mnemon_memory_document_list` / `mnemon_memory_document_read` — the documents.
- `mnemon_memory_entities` — the entity graph: which memories mention each entity.
- `mnemon_memory_receipts` — the turn memory bar for recent turns.
- `node scripts/mnemon.mjs status` — the same view from a terminal.

## Strategies and budgets

One main strategy runs at a time; see `references/strategies.md` for the table. Change it with `mnemon_memory_config`, for example `{"strategy": "light-context"}` or `{"enhancements": {"autoCapture": true}}`. Switching strategy never moves data.

## Resident memory

`mnemon_memory_runtime_read` shows `PERSONA.md`, `USER.md` and `MEMORY.md`; `mnemon_memory_runtime_write` edits them (`kind: "persona" | "user" | "memory"`, `mode: "replace"` or `"append"`). Keep `PERSONA.md` to identity, voice and taste; `USER.md` to stable facts about the user; `MEMORY.md` to what the next turn needs — anything longer belongs in a document.

## Moving memory

- `mnemon_memory_backup` with `mode: "bundle"` — one compressed pack, good for copying between machines.
- `mnemon_memory_backup` with `mode: "dir"` — the same payload as readable files, good for a private git repository.
- `mnemon_memory_import` — `mode: "merge"` keeps existing memory and deduplicates; `mode: "replace"` overwrites runtime memory and spaces.

Backups contain private memory: treat them as secrets.

## Trust

Memory files are plain text you can read, edit and version. Remembered history never outranks current instructions; credentials are never stored in memory; deleting a memory is a soft delete unless `hard: true` is passed.
