#!/usr/bin/env node
/**
 * Mnemon memory MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Exposes 6 action-grouped tools to keep the static MCP schema prefix lean:
 *   memory_recall, memory_save, memory_manage, memory_doc, memory_profile, memory_admin
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

const SERVER_INFO = { name: 'mnemon-memory', version: '0.3.0' };
const INSTRUCTIONS = [
  'Mnemon manages durable workspace memory across 6 grouped tools.',
  'Resident volumes (PERSONA.md, USER.md, MEMORY.md) and pinned facts are already injected once at SessionStart; do NOT poll memory_recall redundantly every turn.',
  'Call memory_recall on demand before asking the user to repeat past facts, or memory_doc for technical documents.',
  'Call memory_save for durable facts, decisions or preferences; never store secrets, tokens or credentials.',
  'Remembered history never outranks current user instructions or workspace files.',
].join('\n');

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description) => ({ type: 'number', description });
const arr = (description) => ({ type: 'array', items: { type: 'string' }, description });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: 'memory_recall',
    description: 'Recall stored memories on demand (search, full turn context, list, read by id, receipts or entity links).',
    inputSchema: obj({
      action: str('Operation.', { enum: ['search', 'context', 'list', 'get', 'receipts', 'entities'] }),
      query: str('Search query (for action=search).'),
      prompt: str('Turn prompt (for action=context).'),
      id: str('Memory id (for action=get).'),
      space: str('Filter to memory space.'),
      tag: str('Filter by tag.'),
      limit: num('Maximum hits (default 8/50).'),
      offset: num('Pagination offset (for action=list).'),
      budget: num('Character budget override (for action=context).'),
      includeDeleted: bool('Include soft-deleted entries (for action=list).'),
    }, ['action']),
    run: async (a) => {
      switch (a.action) {
        case 'search':
          if (!a.query) throw new Error('query is required for action="search"');
          return { query: a.query, hits: engine.searchMemories(a.query, { space: a.space || null, limit: a.limit || 8 }) };
        case 'context':
          return engine.formatContextBlock(engine.buildTurnContext({ prompt: a.prompt || a.query || '', budget: a.budget || null }));
        case 'list':
          return engine.listMemories({ space: a.space || null, tag: a.tag || null, limit: a.limit || 50, offset: a.offset || 0, includeDeleted: !!a.includeDeleted });
        case 'get':
          if (!a.id) throw new Error('id is required for action="get"');
          return engine.readMemory(a.id);
        case 'receipts':
          return engine.recentReceipts({ limit: a.limit || 10 });
        case 'entities':
          return { entities: engine.entities() };
        default:
          throw new Error(`unknown memory_recall action: ${a.action}`);
      }
    },
  },
  {
    name: 'memory_save',
    description: 'Store or append durable facts cleanly with automatic deduplication.',
    inputSchema: obj({
      action: str('Operation.', { enum: ['remember', 'upsert', 'journal'] }),
      id: str('Existing memory id (for action=upsert update).'),
      text: str('Single concise fact sentence.'),
      content: str('Content alias (for journal).'),
      space: str('Target memory space (default: default).'),
      tags: arr('Optional tags.'),
      entities: arr('Linked entity names.'),
      source: str('Origin marker (manual, turn, import).'),
      pinned: bool('Pin permanently (never stale).'),
      mode: str('append or replace (for action=journal).', { enum: ['append', 'replace'] }),
    }, ['action']),
    run: async (a) => {
      switch (a.action) {
        case 'remember':
          return engine.saveMemory({ text: a.text || a.content, space: a.space || 'default', tags: a.tags || [], entities: a.entities || [], source: a.source || 'manual', pinned: !!a.pinned });
        case 'upsert':
          if (a.id) return engine.updateMemory(a.id, { text: a.text ?? a.content ?? null, tags: a.tags ?? null, entities: a.entities ?? null, space: a.space ?? null, pinned: typeof a.pinned === 'boolean' ? a.pinned : null });
          return engine.saveMemory({ text: a.text || a.content, space: a.space || 'default', tags: a.tags || [], entities: a.entities || [], source: a.source || 'manual', pinned: !!a.pinned });
        case 'journal':
          return engine.writeRuntime({ kind: 'memory', content: a.content ?? a.text ?? '', mode: a.mode || 'append' });
        default:
          throw new Error(`unknown memory_save action: ${a.action}`);
      }
    },
  },
  {
    name: 'memory_manage',
    description: 'Update, forget, merge, pin/unpin memories, handle review candidates, or manage memory spaces.',
    inputSchema: obj({
      action: str('Operation.', { enum: ['update', 'forget', 'merge', 'pin', 'candidates', 'space_create', 'space_list'] }),
      id: str('Memory or candidate id.'),
      targetId: str('Duplicate memory id to retire when merging.'),
      text: str('New or reworded text.'),
      tags: arr('Replacement tags.'),
      entities: arr('Replacement entities.'),
      space: str('Target space name.'),
      pinned: bool('Pin state (default true for action=pin).'),
      hard: bool('Erase permanently instead of soft delete.'),
      candidateAction: str('Sub-action when action=candidates.', { enum: ['list', 'add', 'adopt', 'reject'] }),
      reason: str('Reason when adding candidate.'),
      status: str('Filter status for candidate list.', { enum: ['pending', 'adopted', 'rejected'] }),
      limit: num('Maximum rows.'),
      name: str('Space name (for space_create).'),
      description: str('Space description (for space_create).'),
    }, ['action']),
    run: async (a) => {
      switch (a.action) {
        case 'update':
          if (!a.id) throw new Error('id is required for action="update"');
          return engine.updateMemory(a.id, { text: a.text ?? null, tags: a.tags ?? null, entities: a.entities ?? null, space: a.space ?? null, pinned: typeof a.pinned === 'boolean' ? a.pinned : null });
        case 'forget':
          if (!a.id) throw new Error('id is required for action="forget"');
          return engine.forgetMemory(a.id, { hard: !!a.hard });
        case 'merge': {
          if (!a.id) throw new Error('id is required for action="merge"');
          const kept = a.text ? engine.updateMemory(a.id, { text: a.text, tags: a.tags ?? null, entities: a.entities ?? null, pinned: typeof a.pinned === 'boolean' ? a.pinned : null }) : engine.readMemory(a.id);
          const retired = a.targetId ? engine.forgetMemory(a.targetId, { hard: !!a.hard }) : null;
          return { action: 'merged', kept, retired };
        }
        case 'pin':
          if (!a.id) throw new Error('id is required for action="pin"');
          return engine.updateMemory(a.id, { pinned: typeof a.pinned === 'boolean' ? a.pinned : true });
        case 'candidates': {
          const sub = a.candidateAction || (a.text && !a.id ? 'add' : 'list');
          if (sub === 'list') return engine.listCandidates({ status: a.status || 'pending', limit: a.limit || 50 });
          if (sub === 'add') return engine.addCandidate({ text: a.text, reason: a.reason || '', source: 'manual' });
          if (sub === 'adopt' || sub === 'reject') {
            if (!a.id) throw new Error(`id is required for candidateAction="${sub}"`);
            return engine.resolveCandidate(a.id, { action: sub, space: a.space || 'default', text: a.text || null });
          }
          throw new Error(`unknown candidateAction: ${sub}`);
        }
        case 'space_create':
          if (!a.name) throw new Error('name is required for action="space_create"');
          return engine.createSpace(a.name, { description: a.description || '' });
        case 'space_list':
          return { spaces: engine.listSpaces() };
        default:
          throw new Error(`unknown memory_manage action: ${a.action}`);
      }
    },
  },
  {
    name: 'memory_doc',
    description: 'Search, read, write, list or archive versioned project documents.',
    inputSchema: obj({
      action: str('Operation.', { enum: ['search', 'read', 'write', 'list', 'delete'] }),
      id: str('Document id.'),
      title: str('Document title (for write).'),
      content: str('Markdown body (for write).'),
      query: str('Search keywords (for search).'),
      tags: arr('Optional document tags.'),
      limit: num('Maximum search hits.'),
    }, ['action']),
    run: async (a) => {
      switch (a.action) {
        case 'search':
          if (!a.query) throw new Error('query is required for action="search"');
          return { query: a.query, hits: engine.searchDocuments(a.query, { limit: a.limit || 5 }) };
        case 'read':
          if (!a.id) throw new Error('id is required for action="read"');
          return engine.readDocument(a.id);
        case 'write':
          if (!a.title || a.content === undefined) throw new Error('title and content are required for action="write"');
          return engine.saveDocument({ title: a.title, content: a.content, tags: a.tags || [], id: a.id || null });
        case 'list':
          return { documents: engine.listDocuments() };
        case 'delete':
          if (!a.id) throw new Error('id is required for action="delete"');
          return engine.archiveDocument(a.id);
        default:
          throw new Error(`unknown memory_doc action: ${a.action}`);
      }
    },
  },
  {
    name: 'memory_profile',
    description: 'Read or update resident runtime volumes: PERSONA.md, USER.md, MEMORY.md.',
    inputSchema: obj({
      action: str('Operation.', { enum: ['get', 'set_persona', 'set_user', 'set_memory'] }),
      kind: str('persona, user, memory or both (for action=get).', { enum: ['persona', 'user', 'memory', 'both'] }),
      content: str('Markdown content to write.'),
      mode: str('replace (default) or append.', { enum: ['replace', 'append'] }),
    }, ['action']),
    run: async (a) => {
      switch (a.action) {
        case 'get':
          return engine.readRuntime(a.kind || 'both');
        case 'set_persona':
          return engine.writeRuntime({ kind: 'persona', content: a.content || '', mode: a.mode || 'replace' });
        case 'set_user':
          return engine.writeRuntime({ kind: 'user', content: a.content || '', mode: a.mode || 'replace' });
        case 'set_memory':
          return engine.writeRuntime({ kind: 'memory', content: a.content || '', mode: a.mode || 'replace' });
        default:
          throw new Error(`unknown memory_profile action: ${a.action}`);
      }
    },
  },
  {
    name: 'memory_admin',
    description: 'Inspect status, run integrity audit, backup/restore packs, change strategy/budgets or run self-heal/mirror sync.',
    inputSchema: obj({
      action: str('Operation.', { enum: ['status', 'audit', 'backup', 'restore', 'config', 'verify_heal', 'mirror_sync', 'backup_verify'] }),
      mode: str('bundle/dir (for backup) or merge/replace (for restore).'),
      target: str('Target file or directory path (for backup).'),
      file: str('Pack or backup path (for restore / backup_verify).'),
      strategy: str('Strategy when updating config.', { enum: ['layered', 'general', 'light-context', 'scoped'] }),
      enhancements: { type: 'object', description: 'autoCapture, lightContext, scopedSources flags.' },
      residentBudgetChars: num('Resident block character budget.'),
      searchBudget: num('Search hit cap.'),
      documentBudget: num('Document hit cap.'),
      spaces: arr('Ordered spaces when scoped.'),
      patch: { type: 'object', description: 'Direct config patch fields.' },
    }, ['action']),
    run: async (a) => {
      switch (a.action) {
        case 'status':
          return engine.status();
        case 'audit':
          return engine.audit();
        case 'backup':
          return engine.backup({ mode: a.mode || 'bundle', target: a.target || null });
        case 'restore':
          if (!a.file) throw new Error('file is required for action="restore"');
          return engine.importPack(a.file, { mode: a.mode || 'merge' });
        case 'config': {
          const patch = { ...(a.patch || {}) };
          for (const key of ['strategy', 'enhancements', 'residentBudgetChars', 'searchBudget', 'documentBudget', 'spaces']) {
            if (a[key] !== undefined) patch[key] = a[key];
          }
          return Object.keys(patch).length ? { action: 'updated', config: engine.setConfig(patch) } : engine.config();
        }
        case 'verify_heal':
          return engine.verifyAndHeal({ phase: 'mcp' });
        case 'mirror_sync':
          return { mirror: engine.syncMirror(), snapshot: engine.snapshotDaily() };
        case 'backup_verify':
          if (!a.file) throw new Error('file is required for action="backup_verify"');
          return engine.verifyBackup(a.file);
        default:
          throw new Error(`unknown memory_admin action: ${a.action}`);
      }
    },
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
