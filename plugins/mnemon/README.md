# Mnemon Memory

Layered, composable memory for Antigravity, as a single versioned plugin.

An agent that starts every session from scratch keeps asking what it was already told. Putting everything into one
memory store is no better: it either floods each turn or misses what matters. Mnemon gives Antigravity memory that is
**layered**, **visible** and **composable**:

- **The right memory for each turn.** Preferences and working facts stay in context. Project documents and long-term
  evidence are searched only when a question needs them.
- **You can see what a turn used.** Every memory tool call gets a receipt line naming what was read or written, and
  `mnemon_memory_receipts` lists them per turn.
- **Save in one step.** `/mnemon-remember` distils the conversation, deduplicates against what is already stored and
  reports the memory space each fact went to.
- **Permanent persona.** `PERSONA.md` is a first-class volume: it is injected at every session start and is never
  truncated by the resident budget. Facts can be marked `pinned: true` to never go stale and rank higher in recall.
- **Hard to lose.** Every write is atomic (temp file + fsync + rename), mirrored to a second directory tree and
  snapshotted once a day as a real gzip pack (30 kept). Startup checks the primary store and heals missing,
  zero-byte or corrupt files from the mirror or the newest snapshot, with a recovery receipt.
- **Compose it.** Four strategies and three enhancements, switchable without moving any data.
- **Keep data where you want it.** Plain text under one data directory, with a compressed pack or a readable
  directory export for moving between machines.
- **Extend it.** The memory engine is an ordinary Node module; the MCP server, the hooks and the CLI are thin
  layers over it.

Ported from the DeepSeek Harness memory plugin [`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon) to the
Antigravity plugin format. See [`docs/PORTING.md`](docs/PORTING.md) for the concept-by-concept mapping.

## What the plugin bundles

| Component | File | What it does |
| --- | --- | --- |
| Skills | `skills/` | Five skills: the overview, save-to-memory, review and reconcile, the memory system, skill evolution |
| MCP server | `mcp_config.json` | 29 `mnemon_memory_*` tools for search, save, edit, documents, spaces, candidates, receipts, audit, backup, mirror and self-heal |
| Agents | `agents/` | `memory-curator` (writes and deduplicates) and `memory-auditor` (read-only review) |
| Rules | `rules/` | Always-on memory discipline, plus a glob-scoped rule for the memory files |
| Hooks | `hooks.json` | `SessionStart` injects the initial system message, `PreInvocation` refreshes PERSONA/USER/MEMORY plus relevant recall as an ephemeral message on every invocation, `PostToolUse` writes receipts, `Stop` captures candidates and returns `{}` |

## Install

Requires **Node.js 18 or later** on `PATH` (the MCP server and the hooks are Node scripts).

**Antigravity App / IDE** — put the plugin folder in one of these places and it activates there:

- Workspace: `.agents/plugins/antigravity长期记忆-mogu/` in the project root.
- Global: `~/.gemini/config/plugins/antigravity长期记忆-mogu/`.

**Antigravity CLI**

```sh
agy plugin validate --strict ./mnemon   # manifest, skills, rules, MCP and hooks
agy plugin install ./mnemon             # install into the local profile
agy plugin list                         # confirm it is enabled and see its components
```

Then open **Customizations > Installed** (or the CLI `/plugin` manager) and enable it. Its skills appear in the
Customizations dropdown, the tools appear on the plugin's MCP tab, and the hooks run while the plugin is enabled.

## Quick start

1. Tell a conversation something worth keeping: *"Remember that this project deploys with pnpm and Node 24."*
2. Run `/mnemon-remember` — it distils the facts, deduplicates, and answers with a receipt per fact:
   `added "Deploys use pnpm" → space toolchain (mem_1f2e3d4c5b)`.
3. Start a new conversation. `PERSONA.md`, `USER.md` and `MEMORY.md` are injected as a system message, pinned
   memories are listed, and relevant memories for your first question are recalled by the `PreInvocation` hook as
   an ephemeral message (no fake user bubble).
4. Run `/mnemon-review` at the end of a session to adopt or reject anything captured and to reconcile conflicts.
5. Run `/mnemon-system` to see status, spaces, documents and receipts — or from a terminal:

```sh
node scripts/mnemon.mjs status
node scripts/mnemon.mjs search "commit style"
node scripts/mnemon.mjs audit
```

## 快速开始（中文）

1. 对对话说一句值得记住的事，例如「记住：这个项目用 pnpm 和 Node 24 部署」。
2. 运行 `/mnemon-remember`：它会把事实压缩成一句话、与已有记忆去重，并逐条回报写到了哪个记忆空间。
3. 新开或继续一个会话：`SessionStart` 先注入一次 system message；每次模型调用前 `PreInvocation` 会把当前的 `PERSONA.md`、`USER.md`、`MEMORY.md` 与置顶记忆刷新成 ephemeralMessage，并附带与当前问题相关的记忆/文档，因此旧会话和普通问候也会自动带上人设，不需要用户先要求“读取记忆”，也不会产生伪造的用户气泡。
4. 会话结束运行 `/mnemon-review`：采纳或驳回本轮捕获的候选事实，并处理互相矛盾的记忆。
5. `/mnemon-system` 查看状态、记忆空间、项目文档与回执；也可以在终端用 `node scripts/mnemon.mjs status`。

记忆默认存放在 `~/.mnemon/data`（可用 `MNEMON_DATA_DIR` 环境变量改路径），全部是纯文本，可读可编辑可版本化。生产部署建议用 `--mirror-dir` 指向第二块盘，Mnemon 会实时镜像并在每天首次写入时生成一份可校验的 `.json.gz` 快照，启动时自动自愈。

## The memory volumes

| Volume | Keep here | How it reaches the agent |
| --- | --- | --- |
| **PERSONA.md** | AI name, role, voice, engineering taste, boundaries | Injected at SessionStart; permanent, never truncated |
| **Runtime memory** | User profile and working agreements, facts needed on the next turn | Injected every turn as compact `USER.md` and `MEMORY.md` |
| **Project documents** | Designs, investigations, procedures and handoffs | Searched first, then read when relevant |
| **Memory spaces** | Durable facts, decisions, entities and their relationships; `pinned: true` for permanent ones | Recalled on demand, per turn; pinned facts never go stale |

The default **layered** strategy keeps the persona and runtime memory resident and reads the other sources on
demand. The **general** strategy offers every source inside one budget, **light-context** caps the resident block,
and **scoped** composes an explicit order of sources. Switching strategy never moves data.

## MCP tools

Namespaced by Antigravity as `mnemon_memory_<tool>`.

| Group | Tools |
| --- | --- |
| Status and config | `status`, `config`, `entities` |
| Memories | `save`, `search`, `list`, `read`, `update`, `forget` |
| Turn context | `context`, `receipts` |
| Documents | `document_save`, `document_list`, `document_read`, `document_search`, `document_archive` |
| Spaces | `space_create`, `space_list` |
| Candidates | `candidate_add`, `candidate_list`, `candidate_resolve` |
| Maintenance | `audit`, `backup`, `backup_verify`, `import`, `mirror_sync`, `verify_heal` |
| Resident memory | `runtime_read`, `runtime_write` (`kind: persona / user / memory`) |

`save` is the interesting one: it reports `added`, `merged` or `duplicate`, so the agent can save aggressively
without ever creating a second copy of the same fact.

## Slash commands

`/mnemon` · `/mnemon-remember` · `/mnemon-review` · `/mnemon-system` · `/mnemon-evolve`

## Where memory lives

Everything is plain text under one data directory (default `~/.mnemon/data`, override with `MNEMON_DATA_DIR` or
`--data-dir`):

```
<data>/
├── config.json                     # strategy, enhancements, budgets
├── runtime/PERSONA.md              # permanent AI persona, never truncated
├── runtime/USER.md, MEMORY.md      # resident memory
├── revisions/                      # history of every runtime write
├── snapshots/                      # local copy of the daily .json.gz snapshot
├── spaces/<space>/memories.jsonl   # durable facts, one JSON object per line
├── documents/<id>.md               # project documents (+ .revisions/, .archive/)
├── candidates/pending.jsonl        # facts awaiting review
├── receipts/<date>.jsonl           # what each turn read and wrote
├── receipts/heal-*.json            # recovery receipts from verifyAndHeal
└── backups/                        # packs written by backup
```

With `--mirror-dir` (or `MNEMON_MIRROR_DIR`) the same runtime volumes, `spaces/*/memories.jsonl` and
`documents/*.md` are mirrored to `<mirror>/latest/`, and `<mirror>/snapshots/mnemon-YYYY-MM-DD.json.gz` holds the
last 30 daily snapshots. A hook and the MCP server share the same flags, so they always agree on both paths; the
registry (`~/.mnemon/registry.json`) is only written when no explicit location is passed.

## Backup and self-healing

- `backup` writes a real gzip stream with `fs.writeFileSync` on a raw Buffer, `fsync`, then an atomic rename.
  `backup_verify` decodes it with `zlib.gunzipSync` and reports the SHA-256 of the uncompressed payload.
- `verify_heal` (also run at every startup) checks `config.json`, all three runtime volumes, every space file and
  every document. A missing, zero-byte or corrupt file is restored from `<mirror>/latest/` first and from the newest
  verified snapshot second; the recovery is recorded in `receipts/heal-*.json`.

## Strategies, enhancements and budgets

| Strategy | Resident | On demand |
| --- | --- | --- |
| `layered` (default) | `PERSONA.md` + `USER.md` + `MEMORY.md` | documents and spaces, searched per turn |
| `general` | runtime memory in one budget | every source inside that budget |
| `light-context` | runtime memory at half budget | memory spaces only |
| `scoped` | an explicit source order | that order, writable subset only |

`PERSONA.md` is outside the budget: only `USER.md` + `MEMORY.md` are truncated. Pinned memories never appear in
`audit`'s stale list and receive a `+0.5` retrieval weight boost.

Enhancements: `autoCapture` (Stop hook queues candidate facts — on by default), `lightContext`, `scopedSources`.
Budgets: `residentBudgetChars` 6000, `searchBudget` 8, `documentBudget` 3, `keepRevisions` 20, `staleAfterDays` 180,
`snapshotRetention` 30.

Change any of them with the `config` tool, for example `{"strategy": "light-context"}` or
`{"enhancements": {"autoCapture": true}}`. The full table ships as the `references/strategies.md` file inside the
memory-system skill.

## Trust and security

- Runtime memory and documents are local files; no provider, no network call, no model call for search.
- Remembered history never outranks the current instructions, the workspace files or the user's latest statement.
- Key-shaped strings are scrubbed before anything is written (`redactSecrets`), but do not rely on it: never store
  secrets in memory.
- Adding a fact needs no permission; merging, overwriting or forgetting an existing memory is proposed and applied
  only with agreement.
- `forget` is a soft delete unless `hard: true` is passed. Backups contain private memory — treat them as secrets.

## Development

```sh
node scripts/validate.mjs --strict ./       # structural check of the manifest and every component
node scripts/selftest.mjs                   # 78 assertions across the engine, the hooks and the MCP server
```

`validate.mjs` mirrors the checklist Antigravity applies with `agy plugin validate --strict`: manifest schema and
reserved names, skill frontmatter against folder names, rule trigger modes and the comma-separated `globs` string,
MCP server shape (`mcp_config.json` or legacy `mcp.json`), hook wrapping rules, and that every referenced script
(with quoted absolute paths) exists.

## Compatibility

- Node.js 18+; no runtime dependencies, no install step, no network access.
- Cross-platform. `hooks.json` and `mcp_config.json` may use relative Node scripts or, as in a fixed Windows
  deployment, quoted absolute paths to `node.exe`, the scripts, `--data-dir` and `--mirror-dir`.
- Antigravity plugin components only — skills, MCP server, agents, rules and hooks. There is deliberately no custom
  UI pane: the memory system is reachable through the skills, the tools and the CLI.

## Before publishing

1. `node scripts/validate.mjs --strict ./` exits 0, and `agy plugin validate --strict ./mnemon` agrees.
2. Fill in `author` (and `homepage` / `repository` if you have them) in `plugin.json`.
3. `node scripts/selftest.mjs` passes.
4. Submit through the Antigravity Marketplace partner intake form if you want it listed.

## License

MIT. Ported from `dsh-mnemon` (MIT); see `docs/PORTING.md`.
