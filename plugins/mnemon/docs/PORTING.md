# Porting notes: dsh-mnemon → an Antigravity plugin

The reference is [`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon), a composable, view-based context system
for DeepSeek Harness. Its model is kept; its packaging is replaced with the Antigravity plugin format.

## What maps to what

| dsh-mnemon | Here | Notes |
| --- | --- | --- |
| Runtime memory (`USER.md`, `MEMORY.md`) | `runtime/USER.md`, `runtime/MEMORY.md` | Same two files, same "resident every turn" role |
| AI persona | `runtime/PERSONA.md` | Added here: a permanent volume injected as a system message and never truncated by the budget |
| Project Documents (Markdown, search, revisions, archiving) | `documents/<id>.md` with `.revisions/` and `.archive/` | Frontmatter carries id, title, tags and timestamps |
| Memory Spaces (durable evidence) | `spaces/<space>/memories.jsonl` | One JSON object per memory: text, tags, entities, source, access counters, `pinned` |
| Memory Space Providers (Mnemon Native, Mem0, Honcho, …) | Local store only | Antigravity plugins ship no provider SDK; the engine exposes the same operations so a provider can be added later |
| Sources (own memory and its operations) | MCP tools grouped per source | Memories, documents, spaces, candidates, receipts |
| Strategies (layered, general, auto-capture, light-context, scoped) | `config.strategy` + `config.enhancements` | Four strategies and three enhancements, switchable without moving data |
| Core validating a turn into one immutable View | `buildTurnContext()` → `formatContextBlock()` | The hook injects the formatted view for the turn |
| Host pinning the View to the turn | `SessionStart` / `PreInvocation` `injectSteps` | The host pins the injected step to that turn |
| Turn memory bar under each reply | `PostToolUse` receipt line + `receipts/<date>.jsonl` | Appends `[mnemon] save: added mem_… → space …` to the tool result |
| Brain mark: hand a reply to a task Agent | `/mnemon-remember` + the `memory-curator` agent | Distil, deduplicate, write, report the receipt |
| Memory System page (status, graph, edit) | the `/mnemon-system` skill plus the `status`, `entities`, `list`, `read`, `update` tools | Text-based instead of a WebUI |
| Skills page with versions, tests and backtests | the `/mnemon-evolve` skill plus revision history | A diff-and-backtest workflow the user adopts explicitly |
| One-click install from skills.sh / GitHub | Antigravity plugin components and `agy plugin install` | Skills, agents, rules and hooks are the plugin's own components |
| Storage: global / per workspace / custom, ZIP backup | One data directory, `MNEMON_DATA_DIR`, bundle or directory backup | `~/.mnemon/data` by default, registered in `~/.mnemon/registry.json` only when no explicit `--data-dir`/`--mirror-dir` is passed |
| Durability | atomic writes + dual-drive mirror + daily gzip snapshot + `verifyAndHeal()` | Added here: a second directory tree keeps a live mirror and 30 daily `.json.gz` snapshots; startup repairs a damaged primary store with a receipt |
| Plugins page to compose strategies and enhancements | the `config` tool and `config.json` | Same switches, without a page |
| Extension SDK for custom Sources and Strategies | `scripts/lib/engine.mjs` | A dependency-free Node module; the MCP server, hooks and CLI are thin layers |

## What is deliberately different

- **No WebUI.** An Antigravity plugin bundles skills, MCP servers, agents, rules and hooks — there is no panel to
  draw in. The memory system is reachable through skills, tools and the CLI instead, and the data is plain text.
- **No third-party providers.** The reference offers eight Provider backends; this port keeps a local store and
  keeps the same operation surface, so a provider can be added as a separate component later.
- **Active capture is on by default, but never writes memory.** The `Stop` hook queues durable-looking sentences
  as candidates; nothing reaches memory until the user adopts it in `/mnemon-review`. Set
  `enhancements.autoCapture: false` to turn the scan off.
- **No model calls.** Search is lexical (words, plus character bigrams for Chinese) with recency and usage
  ranking. That keeps the plugin dependency-free and predictable; there is no embedding index.
- **Skills evolution is a workflow, not a service.** `/mnemon-evolve` drafts a diff with the evidence cited and a
  backtest tally, and applies it only when the user adopts it.

## Data model

```jsonc
// spaces/<space>/memories.jsonl — one line per memory
{
  "id": "mem_1f2e3d4c5b",
  "kind": "fact",
  "text": "Deploys use pnpm",
  "space": "toolchain",
  "tags": ["deploy"],
  "entities": ["pnpm"],
  "source": "manual | turn | hook | import | candidate | cli",
  "hash": "…",                 // normalized text, for exact-duplicate detection
  "createdAt": "…", "updatedAt": "…",
  "accessedAt": "…", "accessCount": 3,
  "deletedAt": null,           // soft delete
  "mergedFrom": [{ "text": "…", "at": "…", "similarity": 0.94 }]
}
```

Writing a fact runs three checks in order: exact duplicate anywhere, near-duplicate in the same space
(Jaccard ≥ 0.82 or containment ≥ 0.92, unless the numbers or the negation differ), otherwise a new memory. A
near-duplicate merges into the existing wording and records what it absorbed in `mergedFrom`, so nothing is lost.
