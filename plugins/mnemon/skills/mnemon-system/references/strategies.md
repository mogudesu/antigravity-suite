# Strategies and enhancements

One main strategy runs at a time. Switching never moves data.

| Strategy | Resident | On demand | Use when |
| --- | --- | --- | --- |
| `layered` (default) | `PERSONA.md` + `USER.md` + `MEMORY.md` | project documents and memory spaces, searched per turn | the usual case: persona and stable preferences stay in context, evidence is pulled only when a question needs it |
| `general` | runtime memory inside one budget | every available source competes inside that budget | the store is small and the model should decide what to use |
| `light-context` | runtime memory at half budget | memory spaces only | long sessions where resident context should stay minimal |
| `scoped` | an explicit order of sources | the same order, restricted to a writable subset | several projects share one store and must not bleed into each other |

## Enhancements

| Enhancement | Default | Effect |
| --- | --- | --- |
| `autoCapture` | off | the Stop hook scans the finished turn for durable facts and queues them as candidates; nothing is written to memory without review |
| `lightContext` | off | caps the injected resident block at half the configured budget |
| `scopedSources` | off | restricts on-demand search to the spaces listed in `config.spaces` |

## Budgets

| Setting | Default | Meaning |
| --- | --- | --- |
| `residentBudgetChars` | 6000 | characters of runtime memory injected per turn |
| `searchBudget` | 8 | memories injected per turn by the PreInvocation hook |
| `documentBudget` | 3 | document hits injected per turn |
| `keepRevisions` | 20 | revisions kept per runtime file and per document |
| `staleAfterDays` | 180 | age after which a never-recalled memory is reported as stale |
| `redactSecrets` | on | scrub key-shaped strings before anything is written |
