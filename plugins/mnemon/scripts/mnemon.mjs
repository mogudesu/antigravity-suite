#!/usr/bin/env node
/**
 * Mnemon command line: inspect and edit the same store the agent uses.
 *
 *   node scripts/mnemon.mjs status
 *   node scripts/mnemon.mjs search "commit style"
 *   node scripts/mnemon.mjs save "Prefers Conventional Commits" --space work
 *   node scripts/mnemon.mjs audit
 *   node scripts/mnemon.mjs backup
 */
import path from 'node:path';
import { openEngine } from './lib/engine.mjs';
import * as store from './lib/store.mjs';

const argv = process.argv.slice(2);
const command = argv[0] || 'status';
const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i += 1) {
  const token = argv[i];
  if (token.startsWith('--')) {
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) flags[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
    else flags[key] = true;
  } else {
    positional.push(token);
  }
}

const engine = openEngine({ dataDir: store.resolveDataDir(argv), mirrorDir: store.resolveMirrorDir(argv), workspaceDir: process.cwd(), register: !store.hasExplicitStore(argv) });
const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);

const commands = {
  status: () => engine.status(),
  search: () => ({ query: positional.join(' '), hits: engine.searchMemories(positional.join(' '), { space: flags.space || null, limit: Number(flags.limit) || 8 }) }),
  save: () => engine.saveMemory({ text: positional.join(' '), space: flags.space || 'default', tags: flags.tags ? String(flags.tags).split(',') : [], entities: flags.entities ? String(flags.entities).split(',') : [], source: 'cli', pinned: !!flags.pinned }),
  list: () => engine.listMemories({ space: flags.space || null, tag: flags.tag || null, limit: Number(flags.limit) || 50 }),
  read: () => engine.readMemory(positional[0]),
  forget: () => engine.forgetMemory(positional[0], { hard: !!flags.hard }),
  spaces: () => ({ spaces: engine.listSpaces() }),
  'space-create': () => engine.createSpace(positional[0], { description: flags.description || '' }),
  documents: () => ({ documents: engine.listDocuments() }),
  'document-read': () => engine.readDocument(positional[0]),
  'document-save': () => engine.saveDocument({ title: flags.title || positional[0], content: store.readText(flags.file || positional[1] || ''), tags: flags.tags ? String(flags.tags).split(',') : [] }),
  candidates: () => engine.listCandidates({ status: flags.status || 'pending' }),
  'candidate-add': () => engine.addCandidate({ text: positional.join(' '), reason: flags.reason || '', source: 'cli' }),
  'candidate-adopt': () => engine.resolveCandidate(positional[0], { action: 'adopt', space: flags.space || 'default' }),
  'candidate-reject': () => engine.resolveCandidate(positional[0], { action: 'reject' }),
  receipts: () => engine.recentReceipts({ limit: Number(flags.limit) || 10 }),
  audit: () => engine.audit(),
  entities: () => ({ entities: engine.entities() }),
  context: () => engine.formatContextBlock(engine.buildTurnContext({ prompt: positional.join(' ') })),
  config: () => (Object.keys(flags).length ? { config: engine.setConfig(flags) } : engine.config()),
  paths: () => ({ dataDir: engine.dataDir, mirrorDir: engine.mirrorDir, files: engine.p }),
  runtime: () => engine.readRuntime(flags.kind || 'both'),
  'runtime-write': () => engine.writeRuntime({ kind: flags.kind || 'memory', content: store.readText(flags.file || positional[0] || ''), mode: flags.mode || 'replace' }),
  'runtime-write-json': () => {
    const source = flags.file || positional[0];
    const payload = JSON.parse(store.readText(source, '{}'));
    const written = [];
    for (const kind of ['persona', 'user', 'memory']) {
      if (typeof payload[kind] === 'string') {
        written.push(engine.writeRuntime({ kind, content: payload[kind], mode: flags.mode || 'replace' }));
      }
    }
    return { written };
  },
  backup: () => engine.backup({ mode: flags.dir ? 'dir' : 'bundle', target: flags.out || null }),
  'verify-backup': () => engine.verifyBackup(positional[0] || flags.file),
  mirror: () => ({ mirror: engine.syncMirror(), snapshot: engine.snapshotDaily() }),
  verify: () => engine.verifyAndHeal({ phase: 'cli' }),
  import: () => engine.importPack(positional[0], { mode: flags.mode || 'merge' }),
  help: () => `Mnemon CLI\n\ncommands: ${Object.keys(commands).filter((c) => c !== 'help').join(', ')}\n\nflags: --space --tag --limit --hard --pinned --tags --entities --title --file --kind --mode --status --out --dir --data-dir --mirror-dir`,
};

const run = commands[command];
if (!run) {
  print(`Unknown command "${command}".\n\n${commands.help()}`);
  process.exit(1);
}
try {
  print(run());
} catch (error) {
  print(`mnemon: ${error.message}`);
  process.exit(1);
}
