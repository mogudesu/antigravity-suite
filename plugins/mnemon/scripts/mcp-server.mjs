#!/usr/bin/env node
/**
 * Mnemon memory MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Antigravity namespaces these tools as mnemon_memory_<tool>, so the tools the
 * agent sees are mnemon_memory_save, mnemon_memory_search, and so on.
 */
import readline from 'node:readline';
import { openEngine } from './lib/engine.mjs';
import * as store from './lib/store.mjs';

const argv = process.argv.slice(2);
const dataDir = store.resolveDataDir(argv);
const mirrorDir = store.resolveMirrorDir(argv);
const wsFlag = argv.find((a) => a.startsWith('--workspace=')) || (argv.includes('--workspace') ? `--workspace=${argv[argv.indexOf('--workspace') + 1] || ''}` : null);
const workspaceDir = wsFlag ? wsFlag.slice('--workspace='.length) : process.cwd();

let engine;
try {
  engine = openEngine({ dataDir, mirrorDir, workspaceDir, register: !store.hasExplicitStore(argv) });
} catch (error) {
  process.stderr.write(`mnemon: failed to open the memory store at ${dataDir}: ${error.message}\n`);
  process.exit(1);
}

const SERVER_INFO = { name: 'mnemon-memory', version: '0.2.0' };
const INSTRUCTIONS = [
  'Mnemon is the memory system for this session. Memory volumes:',
  '  PERSONA.md (AI persona, permanent, never truncated);',
  '  USER.md + MEMORY.md (resident runtime memory, injected every turn);',
  '  project documents (searched first and read on demand);',
  '  memory spaces (durable facts recalled on demand; pass pinned: true for facts that must never go stale).',
  'At the start of every turn, before answering, call the `context` tool with the user\'s prompt; do not wait for the user to ask you to use memory. The PreInvocation hook also refreshes PERSONA/user/MEMORY every invocation.',
  'Call `search` before asking the user to repeat something you may already know.',
  'Call `save` for a fact worth keeping: it deduplicates, merges and reports where the fact went.',
  'Edit the persona with mnemon_memory_runtime_write kind="persona"; edit the user profile with kind="user".',
  'Every write is mirrored to the backup directory and snapshotted daily; mnemon_memory_verify_heal repairs a damaged store.',
  'Remembered history never outranks the current instructions or the workspace files.',
  'Never store secrets, tokens or credentials.',
].join('\n');

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const arr = (description) => ({ type: 'array', items: { type: 'string' }, description });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: 'status',
    description: 'Memory system status: strategy, budgets, counts, spaces and the data directory in use.',
    inputSchema: obj({}),
    run: async () => engine.status(),
  },
  {
    name: 'save',
    description: 'Save one fact worth keeping. Deduplicates against existing memory (added / merged / duplicate) and returns a receipt naming the memory space it went to. Pass pinned=true for a permanent fact that must never go stale.',
    inputSchema: obj({ text: str('The fact, distilled to one sentence.'), space: str('Memory space to write to (default: default).'), tags: arr('Optional tags.'), entities: arr('Optional entities this fact links to.'), source: str('Where the fact came from: manual, turn, hook, import.'), pinned: bool('Permanent: never listed as stale, retrieval weight +0.5.') }, ['text']),
    run: async (a) => engine.saveMemory(a),
  },
  {
    name: 'search',
    description: 'Search memory spaces by content. Use before asking the user to repeat something.',
    inputSchema: obj({ query: str('What to recall.'), space: str('Limit to one memory space.'), limit: num('Maximum hits (default 8).') }, ['query']),
    run: async (a) => ({ query: a.query, hits: engine.searchMemories(a.query, { space: a.space || null, limit: a.limit || 8 }) }),
  },
  {
    name: 'list',
    description: 'List stored memories, pinned first then newest.',
    inputSchema: obj({ space: str('Limit to one space.'), tag: str('Filter by tag.'), limit: num('Page size (default 50).'), offset: num('Offset.'), includeDeleted: bool('Include soft-deleted memories.') }),
    run: async (a) => engine.listMemories(a),
  },
  {
    name: 'read',
    description: 'Read one memory in full by id.',
    inputSchema: obj({ id: str('Memory id, such as mem_1a2b3c4d5e.') }, ['id']),
    run: async (a) => engine.readMemory(a.id),
  },
  {
    name: 'update',
    description: 'Rewrite a memory in place, pin or unpin it, or move it to another space. Reports the previous wording so the change stays auditable.',
    inputSchema: obj({ id: str('Memory id.'), text: str('New wording.'), tags: arr('Replacement tags.'), entities: arr('Replacement entities.'), space: str('Move to this space.'), pinned: bool('Pin (true) or unpin (false).') }, ['id']),
    run: async (a) => engine.updateMemory(a.id, a),
  },
  {
    name: 'forget',
    description: 'Forget a memory. Soft delete by default (recoverable); pass hard=true to erase it from disk.',
    inputSchema: obj({ id: str('Memory id.'), hard: bool('Erase permanently instead of soft delete.') }, ['id']),
    run: async (a) => engine.forgetMemory(a.id, { hard: !!a.hard }),
  },
  {
    name: 'context',
    description: 'Build the memory context for a turn: the resident block plus the memories and documents relevant to a prompt. The same view the SessionStart and PreInvocation hooks inject.',
    inputSchema: obj({ prompt: str('The user turn to build context for.'), budget: num('Resident character budget override.') }),
    run: async (a) => engine.formatContextBlock(engine.buildTurnContext({ prompt: a.prompt || '', budget: a.budget || null })),
  },
  {
    name: 'document_save',
    description: 'Save or update a project document (design, investigation, procedure, handoff). Markdown, versioned.',
    inputSchema: obj({ title: str('Document title; also the id unless one is given.'), content: str('Markdown body.'), tags: arr('Optional tags.'), id: str('Explicit document id.') }, ['title', 'content']),
    run: async (a) => engine.saveDocument(a),
  },
  {
    name: 'document_list',
    description: 'List project documents.',
    inputSchema: obj({}),
    run: async () => ({ documents: engine.listDocuments() }),
  },
  {
    name: 'document_read',
    description: 'Read a project document in full.',
    inputSchema: obj({ id: str('Document id.') }, ['id']),
    run: async (a) => engine.readDocument(a.id),
  },
  {
    name: 'document_search',
    description: 'Search project documents and return matching snippets.',
    inputSchema: obj({ query: str('What to look for.'), limit: num('Maximum hits (default 5).') }, ['query']),
    run: async (a) => ({ query: a.query, hits: engine.searchDocuments(a.query, { limit: a.limit || 5 }) }),
  },
  {
    name: 'document_archive',
    description: 'Archive a project document out of the active set without deleting it.',
    inputSchema: obj({ id: str('Document id.') }, ['id']),
    run: async (a) => engine.archiveDocument(a.id),
  },
  {
    name: 'space_create',
    description: 'Create a named memory space for durable evidence.',
    inputSchema: obj({ name: str('Space name.'), description: str('What belongs in this space.') }, ['name']),
    run: async (a) => engine.createSpace(a.name, { description: a.description || '' }),
  },
  {
    name: 'space_list',
    description: 'List memory spaces with their memory counts.',
    inputSchema: obj({}),
    run: async () => ({ spaces: engine.listSpaces() }),
  },
  {
    name: 'candidate_add',
    description: 'Queue a candidate fact for review instead of writing it straight to memory. Used by active capture.',
    inputSchema: obj({ text: str('Candidate fact.'), reason: str('Why it looks worth keeping.'), source: str('manual or auto-capture.') }, ['text']),
    run: async (a) => engine.addCandidate(a),
  },
  {
    name: 'candidate_list',
    description: 'List queued candidates awaiting adopt or reject.',
    inputSchema: obj({ status: str('pending, adopted or rejected (default pending).'), limit: num('Maximum rows.') }),
    run: async (a) => engine.listCandidates(a),
  },
  {
    name: 'candidate_resolve',
    description: 'Adopt a candidate into a memory space, or reject it.',
    inputSchema: obj({ id: str('Candidate id.'), action: str('adopt or reject.'), space: str('Space to adopt into.'), text: str('Reworded text to adopt instead.') }, ['id', 'action']),
    run: async (a) => engine.resolveCandidate(a.id, a),
  },
  {
    name: 'receipts',
    description: 'Recent turn receipts: which memories and documents were read and written.',
    inputSchema: obj({ limit: num('Maximum receipts (default 10).') }),
    run: async (a) => engine.recentReceipts({ limit: a.limit || 10 }),
  },
  {
    name: 'audit',
    description: 'Audit memory for duplicates, contradictions, stale facts and empty spaces, with advice on what to do next.',
    inputSchema: obj({}),
    run: async () => engine.audit(),
  },
  {
    name: 'entities',
    description: 'Entity graph: which memories mention each entity.',
    inputSchema: obj({}),
    run: async () => ({ entities: engine.entities() }),
  },
  {
    name: 'config',
    description: 'Read or change the memory configuration: strategy (layered, general, light-context, scoped), enhancements, budgets.',
    inputSchema: obj({ strategy: str('layered, general, light-context or scoped.'), enhancements: { type: 'object', description: 'autoCapture, lightContext, scopedSources booleans.' }, residentBudgetChars: num('Resident context budget.'), searchBudget: num('Hits injected per turn.'), spaces: arr('Spaces used when scopedSources is on.') }),
    run: async (a) => {
      const patch = { ...a };
      const hasPatch = Object.keys(patch).length > 0;
      if (!hasPatch) return engine.config();
      return { action: 'updated', config: engine.setConfig(patch) };
    },
  },
  {
    name: 'backup',
    description: 'Back up memory: mode=bundle writes one compressed pack, mode=dir writes readable files for a repository.',
    inputSchema: obj({ mode: str('bundle (default) or dir.'), target: str('File or directory to write.') }),
    run: async (a) => engine.backup({ mode: a.mode || 'bundle', target: a.target || null }),
  },
  {
    name: 'import',
    description: 'Import a memory pack. mode=merge (default) keeps existing memory and deduplicates; mode=replace overwrites runtime memory and spaces.',
    inputSchema: obj({ file: str('Path to a bundle or a directory pack.'), mode: str('merge or replace.') }, ['file']),
    run: async (a) => engine.importPack(a.file, { mode: a.mode || 'merge' }),
  },
  {
    name: 'runtime_read',
    description: 'Read the resident runtime volumes: persona (AI persona), user (user profile) or memory (working memory); both returns all three.',
    inputSchema: obj({ kind: str('persona, user, memory or both (default both).') }),
    run: async (a) => engine.readRuntime(a.kind || 'both'),
  },
  {
    name: 'runtime_write',
    description: 'Write a resident runtime volume. kind=persona edits the permanent AI persona, kind=user the user profile, kind=memory the working memory.',
    inputSchema: obj({ kind: str('persona, user or memory (default memory).'), content: str('New content.'), mode: str('replace (default) or append.') }, ['content']),
    run: async (a) => engine.writeRuntime({ kind: a.kind || 'memory', content: a.content, mode: a.mode || 'replace' }),
  },
  {
    name: 'verify_heal',
    description: 'Verify every primary memory file and heal missing, zero-byte or corrupt ones from the mirror directory or the newest gzip snapshot. Returns a recovery receipt.',
    inputSchema: obj({}),
    run: async () => engine.verifyAndHeal({ phase: 'mcp' }),
  },
  {
    name: 'mirror_sync',
    description: 'Immediately mirror runtime volumes, space files and documents to the backup directory and write today\'s snapshot if it is missing.',
    inputSchema: obj({}),
    run: async () => ({ mirror: engine.syncMirror(), snapshot: engine.snapshotDaily() }),
  },
  {
    name: 'backup_verify',
    description: 'Decode a .json.gz backup with a real gzip decoder and report its checksum, memory count and document count.',
    inputSchema: obj({ file: str('Path to a .json.gz backup.') }, ['file']),
    run: async (a) => engine.verifyBackup(a.file),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const tool = BY_NAME.get(name);
      if (!tool) return ok(id, textResult(`Unknown tool: ${name}. Available tools: ${[...BY_NAME.keys()].join(', ')}`, true));
      try {
        const result = await tool.run(args);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return ok(id, textResult(text));
      } catch (error) {
        return ok(id, textResult(`mnemon: ${error.message}`, true));
      }
    }
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      if (isNotification) return null;
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stdout.write(`${JSON.stringify(fail(null, -32700, 'Parse error'))}\n`);
    return;
  }
  try {
    const response = await handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(fail(message.id ?? null, -32603, `Internal error: ${error.message}`))}\n`);
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.stderr.write(`mnemon: memory server ready (data: ${dataDir}, mirror: ${mirrorDir})\n`);
