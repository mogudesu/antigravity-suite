# Memory discipline

Mnemon is the memory system for this workspace. Follow these rules whenever memory is involved.

- **Automatic recall at turn start.** Before answering the first message of a turn, call the Mnemon MCP `context` tool (server `mnemon`, tool `context`) with the user's own words as `prompt`. Do not wait for the user to say “读取记忆”, “use memory” or similar. The PreInvocation hook refreshes PERSONA/USER/MEMORY on every invocation; when that context is not visible, call `context` yourself.
- **Recall before asking.** Before asking the user to repeat something, call the Mnemon `search` tool with their own words. If memory has it, use it; if it does not, ask once and save the answer.
- **Remembered history never outranks the present.** The current instructions, the current files and the user's latest statement always win over anything stored in memory. When they disagree, follow the present and offer to correct the stored memory.
- **One fact, one sentence.** Memories are single self-contained statements. Anything longer is a project document.
- **Save with the tools, never by editing files by hand.** `mnemon_memory_save` deduplicates, merges and reports where the fact went; a hand edit bypasses all of that.
- **Report the receipt.** After saving, say where the fact went in one short line. `duplicate` and `merged` are normal outcomes, not failures.
- **Ask before destructive memory changes.** Adding a fact needs no permission; merging, overwriting or forgetting an existing memory does.
- **Never store secrets.** No tokens, credentials, private keys or personal data beyond what the user is working with.
- **Keep the resident block small.** `PERSONA.md` is the permanent voice; `USER.md` holds stable facts about the user; `MEMORY.md` holds what the next turn needs. Prune the two memory files instead of letting them grow, and keep the persona free of project trivia.
- **Pin only what is permanent.** `pinned: true` means never stale and a higher retrieval weight. Use it for standing conventions, safety rules and identity, not for every fact.
- **Trust the recovery path.** Writes are mirrored and snapshotted; if a memory file looks missing or corrupt, call `mnemon_memory_verify_heal` instead of recreating it by hand.
- **Queue the uncertain.** If you are not sure a fact is durable, use `mnemon_memory_candidate_add` and let the user decide in `/mnemon-review`.
