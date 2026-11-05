#!/usr/bin/env node
/**
 * End-to-end self test: drives the engine and every hook against throwaway data
 * and mirror directories, then asserts the observable results.
 *
 *   node scripts/selftest.mjs
 *
 * Covers: runtime volumes incl. PERSONA.md, pinned memories, gzip backup
 * roundtrip (real zlib decode + checksum), dual-drive mirror, daily snapshots,
 * startup verifyAndHeal(), and the Antigravity hook protocol shapes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openEngine } from './lib/engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-selftest-'));
const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-selftest-mirror-'));

let passed = 0;
let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const engine = openEngine({ dataDir: tmp, mirrorDir: mirror, workspaceDir: pluginRoot });

// ---------------------------------------------------------------- runtime
check('PERSONA.md template seeded on first run', fs.readFileSync(path.join(tmp, 'runtime', 'PERSONA.md'), 'utf8').includes('PERSONA.md'));
check('USER.md and MEMORY.md seeded', fs.existsSync(path.join(tmp, 'runtime', 'USER.md')) && fs.existsSync(path.join(tmp, 'runtime', 'MEMORY.md')));
check('requested data dirs exist (spaces/documents/revisions/snapshots)', ['spaces', 'documents', 'revisions', 'snapshots'].every((d) => fs.existsSync(path.join(tmp, d))));

engine.writeRuntime({ kind: 'persona', content: '# PERSONA.md\n- Name: Mnemosyne\n- Voice: direct, evidence first.' });
engine.writeRuntime({ kind: 'user', content: '# USER.md\n- Name: Ada\n- Prefers short answers.' });
engine.writeRuntime({ kind: 'memory', content: '# MEMORY.md\n- Working on the Antigravity memory plugin.' });
check('runtime write/read round trip', engine.readRuntime('user').includes('Ada'));
check('persona is a first-class runtime volume', engine.readRuntime('persona').includes('Mnemosyne'));
check('runtime revision snapshot created', fs.readdirSync(path.join(tmp, 'revisions')).length >= 1);
check('persona survives a token-tight resident budget', (() => {
  const block = engine.formatContextBlock(engine.buildTurnContext({ prompt: '', budget: 20 }), { header: 'tight' });
  return block.includes('Mnemosyne') && block.includes('resident memory truncated');
})(), 'persona must never be truncated while USER/MEMORY are');

// --------------------------------------------------------------- memories
const first = engine.saveMemory({ text: '提交信息使用 Conventional Commits 风格', space: 'work', tags: ['git'], entities: ['Conventional Commits'] });
check('save adds a new memory', first.action === 'added' && first.space === 'work', JSON.stringify(first));
const again = engine.saveMemory({ text: '提交信息使用 Conventional Commits 风格', space: 'work' });
check('identical fact is reported as duplicate', again.action === 'duplicate' && again.id === first.id, JSON.stringify(again));
const near = engine.saveMemory({ text: '提交信息使用 Conventional Commits 风格，scope 用模块名', space: 'work' });
check('near-duplicate merges instead of duplicating', near.action === 'merged' && near.id === first.id, JSON.stringify(near));
const second = engine.saveMemory({ text: 'Node runtime is pinned to 24.19.0 in this project', space: 'work', tags: ['toolchain'] });
check('second fact added', second.action === 'added');
const third = engine.saveMemory({ text: 'Node runtime is pinned to 22.19.0 in this project', space: 'work' });
check('conflicting fact stored separately for later reconciliation', third.action === 'added');

const pinnedFact = engine.saveMemory({ text: 'Pinned deployment policy: staging deploys happen on Tuesdays after review', space: 'work', pinned: true });
check('pinned memory is stored with pinned=true', pinnedFact.action === 'added' && pinnedFact.pinned === true, JSON.stringify(pinnedFact));
const plainFact = engine.saveMemory({ text: 'Deployment policy for legacy vendors is documented in the archive', space: 'work' });
check('unpinned control memory added', plainFact.action === 'added');
const pinnedAgain = engine.saveMemory({ text: plainFact.text, space: 'work', pinned: true });
check('re-saving an existing fact with pinned=true pins it', pinnedAgain.action === 'duplicate' && pinnedAgain.pinned === true && engine.readMemory(plainFact.id).pinned === true, JSON.stringify(pinnedAgain));
const pinnedHits = engine.searchMemories('deployment policy', { limit: 5 });
check('pinned memory gets the retrieval weight boost', pinnedHits.length >= 2 && pinnedHits[0].id === pinnedFact.id && pinnedHits[0].pinned === true, JSON.stringify(pinnedHits.map((h) => [h.id, h.score, h.pinned])));
const unpinned = engine.updateMemory(plainFact.id, { pinned: false });
check('update can unpin an existing memory', unpinned.action === 'updated' && engine.readMemory(plainFact.id).pinned === false);

const zhHits = engine.searchMemories('提交信息 风格', { limit: 5 });
check('Chinese search recalls the right memory', zhHits.length > 0 && zhHits.some((h) => h.id === first.id), JSON.stringify(zhHits.map((h) => h.id)));
const enHits = engine.searchMemories('node runtime version', { limit: 5 });
check('English search recalls the right memory', enHits.length >= 2, JSON.stringify(enHits.map((h) => h.text)));
check('search bumps access counters', engine.readMemory(second.id).accessCount >= 1);

const accessBeforeAutoRecall = engine.readMemory(second.id).accessCount;
engine.buildTurnContext({ prompt: 'node runtime version', session: 'recall-touch-test' });
check('automatic recall does not rewrite usage', engine.readMemory(second.id).accessCount === accessBeforeAutoRecall);

const updated = engine.updateMemory(second.id, { text: 'Node runtime is pinned to 24.19.0 and pnpm is the package manager' });
check('update rewrites and keeps the previous wording', updated.action === 'updated' && updated.previousText.includes('24.19.0'));

// -------------------------------------------------- multi-process hot sync
// Two engines model two Antigravity windows sharing one vault. The long-lived
// engine must observe the peer before it flushes, not overwrite it with cache.
const peer = openEngine({ dataDir: tmp, mirrorDir: mirror });
const peerFact = peer.saveMemory({ text: 'Peer window fact: staging deploy requires a canary window', space: 'work' });
const seenPeer = engine.listMemories({ space: 'work', limit: 200 }).items.some((m) => m.id === peerFact.id);
check('long-lived engine hot-reloads a peer write', seenPeer);
const localFact = engine.saveMemory({ text: 'Local window fact: release notes are drafted in the weekly review', space: 'work' });
const workAfterFlush = readJsonl(path.join(tmp, 'spaces', 'work', 'memories.jsonl'));
check('local flush preserves the peer record', workAfterFlush.some((m) => m.id === peerFact.id), JSON.stringify(workAfterFlush.map((m) => m.id)));
check('local flush persists its own record', workAfterFlush.some((m) => m.id === localFact.id));
peer.updateMemory(peerFact.id, { text: 'Peer window fact: staging deploy requires a canary window and a rollback plan' });
engine.updateMemory(localFact.id, { text: 'Local window fact: release notes are drafted in the weekly review and signed off' });
const workConflict = readJsonl(path.join(tmp, 'spaces', 'work', 'memories.jsonl'));
check('concurrent edits merge without losing either side', workConflict.find((m) => m.id === peerFact.id).text.includes('rollback plan') && workConflict.find((m) => m.id === localFact.id).text.includes('signed off'), JSON.stringify(workConflict.filter((m) => [peerFact.id, localFact.id].includes(m.id))));
peer.forgetMemory(peerFact.id, { hard: true });
const afterPeerDelete = engine.listMemories({ space: 'work', limit: 200 }).items;
check('a peer hard delete is not resurrected from cache', !afterPeerDelete.some((m) => m.id === peerFact.id));
engine.saveMemory({ text: 'Post-delete probe fact: the vault stays writable after a peer deletion', space: 'work' });
check('next local write still omits the peer-deleted record', !readJsonl(path.join(tmp, 'spaces', 'work', 'memories.jsonl')).some((m) => m.id === peerFact.id));
const peerBudget = peer.config().searchBudget;
peer.setConfig({ searchBudget: peerBudget + 1 });
check('config changes from another process hot-reload', engine.config().searchBudget === peerBudget + 1);
peer.setConfig({ searchBudget: peerBudget });

// --------------------------------------------------------------- documents
engine.saveDocument({ title: 'Memory plugin design notes', content: 'Resident memory is injected every turn. Documents are searched first.', tags: ['design'] });
engine.saveDocument({ title: 'Memory plugin design notes', content: 'Resident memory is injected every turn. Documents are searched first and read on demand.', tags: ['design'] });
check('document update keeps one file', engine.listDocuments().length === 1);
check('document revision kept on update', fs.readdirSync(path.join(tmp, 'documents', '.revisions', 'memory-plugin-design-notes')).length >= 1);
const docHits = engine.searchDocuments('documents searched first', { limit: 3 });
check('document search returns a snippet', docHits.length === 1 && docHits[0].snippet.length > 0);

// -------------------------------------------------------------- candidates
const queued = engine.addCandidate({ text: 'Ada wants Chinese replies by default', reason: 'stated as a preference', source: 'manual' });
check('candidate queued', queued.action === 'queued');
const adopted = engine.resolveCandidate(queued.id, { action: 'adopt', space: 'profile' });
check('candidate adopt writes a memory and links it', adopted.action === 'adopted' && adopted.memory.action === 'added', JSON.stringify(adopted));

// ----------------------------------------------------------------- context
const context = engine.buildTurnContext({ prompt: 'How should I write commit messages?', session: 'selftest' });
check('turn context carries the resident block', context.resident.includes('Ada'));
check('turn context carries persona and pinned lists', context.persona.includes('Mnemosyne') && context.pinned.length >= 1);
check('turn context recalls relevant memory', context.relevant.some((r) => r.id === first.id));
check('turn context records a read receipt', engine.recentReceipts({ limit: 5 }).items.some((r) => r.read.includes(first.id)));
check('formatted block is tagged for the model', engine.formatContextBlock(context).startsWith('<mnemon-memory'));

// ------------------------------------------------------------------- audit
// A duplicate that reached the store by another path and old, unpinned records
// are exactly what audit exists to find; a pinned record must never go stale.
const spaceFile = path.join(tmp, 'spaces', 'work', 'memories.jsonl');
const legacy = JSON.parse(fs.readFileSync(spaceFile, 'utf8').trim().split('\n')[0]);
fs.appendFileSync(spaceFile, `${JSON.stringify({ ...legacy, id: 'mem_legacy_duplicate' })}\n`);
const rawRecords = readJsonl(spaceFile);
for (const record of rawRecords) {
  if (record.id === pinnedFact.id) {
    record.updatedAt = '2020-01-01T00:00:00.000Z';
    record.accessCount = 0;
  }
}
rawRecords.push({
  id: 'mem_legacy_stale', kind: 'fact', text: 'Legacy deploy token rotates every 30 days in the old pipeline',
  space: 'work', tags: [], entities: [], source: 'selftest', hash: 'legacystaletoken', pinned: false,
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
  accessedAt: null, accessCount: 0, deletedAt: null, mergedFrom: [],
});
fs.writeFileSync(spaceFile, `${rawRecords.map((r) => JSON.stringify(r)).join('\n')}\n`);
const reopened = openEngine({ dataDir: tmp, mirrorDir: mirror });
const audit = reopened.audit();
check('audit detects duplicates', audit.duplicates.length >= 1, JSON.stringify(audit.duplicates.slice(0, 1)));
check('audit detects the numeric conflict', audit.conflicts.some((c) => c.reason === 'same subject, different numbers'), JSON.stringify(audit.conflicts));
check('audit reports counts', audit.counts.memories >= 3);
check('pinned memory is never listed as stale', !audit.stale.some((s) => s.id === pinnedFact.id), JSON.stringify(audit.stale.map((s) => s.id)));
check('unpinned old memory is listed as stale (control)', audit.stale.some((s) => s.id === 'mem_legacy_stale'), JSON.stringify(audit.stale.map((s) => s.id)));

const forgotten = reopened.forgetMemory(third.id);
check('forget soft deletes', forgotten.action === 'forgotten' && !reopened.listMemories({}).items.some((m) => m.id === third.id));
check('soft deleted memory can be listed explicitly', reopened.listMemories({ includeDeleted: true }).items.some((m) => m.id === third.id));

// ------------------------------------------------------------- portability
const bundle = reopened.backup({ mode: 'bundle' });
check('bundle backup written', fs.existsSync(bundle.target) && bundle.compressedBytes > 0, JSON.stringify(bundle));
const gzBytes = fs.readFileSync(bundle.target);
check('backup has gzip magic bytes', gzBytes[0] === 0x1f && gzBytes[1] === 0x8b, gzBytes.subarray(0, 4).toString('hex'));
let payload = null;
try {
  payload = zlib.gunzipSync(gzBytes);
} catch (error) {
  payload = null;
  process.stdout.write(`       gunzip failed: ${error.message}\n`);
}
check('backup decodes with a real gzip decoder', !!payload, 'zlib.gunzipSync threw');
check('backup payload is valid JSON mnemon-pack', !!payload && (() => { try { return JSON.parse(payload.toString('utf8')).format === 'mnemon-pack'; } catch { return false; } })());
check('backup is byte-for-byte recoverable (sha256)', !!payload && sha256(payload) === bundle.sha256 && payload.length === bundle.bytes, payload ? `${sha256(payload)} vs ${bundle.sha256}` : 'no payload');
const verify = reopened.verifyBackup(bundle.target);
check('backup_verify reports valid', verify.valid === true && verify.memories >= 4, JSON.stringify(verify));

const dirPack = reopened.backup({ mode: 'dir' });
check('readable pack written', fs.existsSync(path.join(dirPack.target, 'runtime', 'PERSONA.md')) && fs.existsSync(path.join(dirPack.target, 'mnemon-pack.json')));
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-import-'));
const restored = openEngine({ dataDir: target, mirrorDir: path.join(target, 'mirror') });
const summary = restored.importPack(bundle.target, { mode: 'replace' });
check('import restores memories', restored.listMemories({ limit: 100 }).total >= 4, JSON.stringify(summary));
check('import restores runtime memory', restored.readRuntime('user').includes('Ada'));
check('import restores PERSONA.md byte-for-byte', restored.readRuntime('persona') === reopened.readRuntime('persona'));

// ------------------------------------------------------- mirror + snapshots
const mirrorRun = reopened.syncMirror();
const snapRun = reopened.snapshotDaily();
check('mirror copies runtime volumes', fs.readFileSync(path.join(mirror, 'latest', 'runtime', 'PERSONA.md'), 'utf8') === fs.readFileSync(path.join(tmp, 'runtime', 'PERSONA.md'), 'utf8'), JSON.stringify(mirrorRun));
check('mirror copies spaces and documents', fs.existsSync(path.join(mirror, 'latest', 'spaces', 'work', 'memories.jsonl')) && fs.existsSync(path.join(mirror, 'latest', 'documents', 'memory-plugin-design-notes.md')));
check('daily snapshot exists on both drives', fs.existsSync(snapRun.targets[0]) && fs.existsSync(snapRun.targets[1]), JSON.stringify(snapRun));
const snapAgain = reopened.snapshotDaily();
check('daily snapshot is idempotent within one day', snapAgain.created === false, JSON.stringify(snapAgain));
fs.unlinkSync(snapRun.targets[0]);
const snapRepaired = reopened.snapshotDaily();
check('a missing snapshot is recreated', snapRepaired.created === true && fs.existsSync(snapRun.targets[0]) && fs.existsSync(snapRun.targets[1]), JSON.stringify(snapRepaired));
const snapCheck = reopened.verifySnapshot(snapRun.targets[0]);
check('daily snapshot decodes as valid gzip', snapCheck.valid === true && snapCheck.bytes > 0, JSON.stringify(snapCheck));

const archived = reopened.archiveDocument('memory-plugin-design-notes');
check('archived document leaves the active set', reopened.listDocuments().length === 0 && fs.existsSync(path.join(tmp, 'documents', '.archive', 'memory-plugin-design-notes.md')) && archived.action === 'archived');

// refresh today's snapshot so the recovery tests exercise the newest content
for (const dir of [path.join(mirror, 'snapshots'), path.join(tmp, 'snapshots')]) {
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json.gz'))) fs.unlinkSync(path.join(dir, name));
}
reopened.snapshotDaily();

// ------------------------------------------------------------- self-healing
const memoryMd = path.join(tmp, 'runtime', 'MEMORY.md');
const memoryBefore = fs.readFileSync(memoryMd, 'utf8');
const healedEngine = (() => {
  fs.unlinkSync(memoryMd);
  return openEngine({ dataDir: tmp, mirrorDir: mirror });
})();
check('startup verifyAndHeal restores a deleted primary file', fs.readFileSync(memoryMd, 'utf8') === memoryBefore && !!healedEngine.lastHeal && healedEngine.lastHeal.healed >= 1, JSON.stringify(healedEngine.lastHeal));

const memorySnapshotCase = (() => {
  fs.unlinkSync(memoryMd);
  fs.unlinkSync(path.join(mirror, 'latest', 'runtime', 'MEMORY.md'));
  const report = healedEngine.verifyAndHeal({ phase: 'selftest-snapshot' });
  const hit = report.healed.find((h) => h.path === 'runtime/MEMORY.md');
  return { report, hit };
})();
check('self-heal falls back to the newest gzip snapshot', fs.readFileSync(memoryMd, 'utf8') === memoryBefore && memorySnapshotCase.hit && memorySnapshotCase.hit.source.startsWith('snapshot:'), JSON.stringify(memorySnapshotCase.hit));

const workFile = path.join(tmp, 'spaces', 'work', 'memories.jsonl');
const linesBefore = readJsonl(workFile).length;
fs.writeFileSync(workFile, '');
const truncReport = healedEngine.verifyAndHeal({ phase: 'selftest-truncate' });
check('self-heal restores a zero-byte memories.jsonl', readJsonl(workFile).length === linesBefore && truncReport.healed.some((h) => h.path === 'spaces/work/memories.jsonl'), JSON.stringify(truncReport.healed));

const configFile = path.join(tmp, 'config.json');
fs.writeFileSync(configFile, '{ this is not json');
const configReport = healedEngine.verifyAndHeal({ phase: 'selftest-config' });
let configOk = false;
try {
  configOk = !!JSON.parse(fs.readFileSync(configFile, 'utf8')).strategy;
} catch {
  configOk = false;
}
check('self-heal restores a corrupt config.json', configOk && configReport.healed.some((h) => h.path === 'config.json'), JSON.stringify(configReport.healed));
check('self-heal writes a recovery receipt', !!configReport.receipt && fs.existsSync(configReport.receipt.file) && JSON.parse(fs.readFileSync(configReport.receipt.file, 'utf8')).healed.length >= 1, JSON.stringify(configReport.receipt && configReport.receipt.file));
const healthy = healedEngine.verifyAndHeal({ phase: 'selftest-healthy' });
check('verifyAndHeal leaves a healthy store untouched', healthy.healed.length === 0 && healthy.created.length === 0 && healthy.failed.length === 0, JSON.stringify(healthy));

// snapshot retention: keep only the newest 30
for (let i = 1; i <= 31; i += 1) {
  fs.writeFileSync(path.join(mirror, 'snapshots', `mnemon-2020-01-${String(i).padStart(2, '0')}.json.gz`), 'stale');
}
for (let i = 1; i <= 8; i += 1) fs.writeFileSync(path.join(mirror, 'snapshots', `mnemon-2020-02-0${i}.json.gz`), 'stale');
healedEngine.snapshotDaily();
check('snapshot retention keeps 30 files', fs.readdirSync(path.join(mirror, 'snapshots')).filter((n) => n.endsWith('.json.gz')).length === 30, String(fs.readdirSync(path.join(mirror, 'snapshots')).length));

// ------------------------------------------------------------------- hooks
const hookEnv = { ...process.env, MNEMON_DATA_DIR: tmp, MNEMON_MIRROR_DIR: mirror };
const runHook = (script, event) => {
  const result = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', 'hooks', script)], {
    input: JSON.stringify(event),
    env: hookEnv,
    encoding: 'utf8',
    timeout: 20000,
  });
  let json = null;
  try {
    json = JSON.parse((result.stdout || '').trim() || '{}');
  } catch {
    json = null;
  }
  return { code: result.status, json, stderr: result.stderr, stdout: result.stdout };
};

const start = runHook('session-start.mjs', { event: 'SessionStart', sessionId: 'selftest' });
check('SessionStart exits 0 with JSON', start.code === 0 && !!start.json, start.stderr);
check('SessionStart returns injectSteps[0].systemMessage', !!start.json && typeof start.json.injectSteps[0].systemMessage === 'string' && start.json.injectSteps[0].systemMessage.includes('mnemon-session'), start.stdout);
check('SessionStart emits no visible userMessage bubble', !!start.json && start.json.injectSteps[0].userMessage === undefined && start.json.userMessage === undefined, start.stdout);
check('SessionStart injects persona and pinned memory', !!start.json && start.json.injectSteps[0].systemMessage.includes('Mnemosyne') && start.json.injectSteps[0].systemMessage.includes('Pinned memory'), start.stdout.slice(0, 400));

const pre = runHook('pre-invocation.mjs', { event: 'PreInvocation', sessionId: 'selftest', prompt: 'How should I write commit messages?' });
check('PreInvocation injects recalled memory', !!pre.json && !!pre.json.injectSteps && pre.json.injectSteps[0].ephemeralMessage.includes('mnemon-recall'), pre.stdout);
check('PreInvocation uses ephemeralMessage only', !!pre.json && pre.json.injectSteps[0].systemMessage === undefined && pre.json.injectSteps[0].userMessage === undefined, pre.stdout);
const preRepeat = runHook('pre-invocation.mjs', { event: 'PreInvocation', sessionId: 'selftest', prompt: 'How should I write commit messages?' });
check('PreInvocation skips a repeated tool step in the same turn',
  preRepeat.code === 0 && !!preRepeat.json && preRepeat.json.injectSteps === undefined,
  preRepeat.stdout.slice(0, 200));
const preMiss = runHook('pre-invocation.mjs', { event: 'PreInvocation', prompt: 'zzzz unrelated zzzz' });
check('PreInvocation refreshes resident memory without keyword hits',
  preMiss.code === 0 && !!preMiss.json && !!preMiss.json.injectSteps &&
  preMiss.json.injectSteps[0].ephemeralMessage.includes('mnemon-recall') &&
  preMiss.json.injectSteps[0].ephemeralMessage.includes('Mnemosyne') &&
  preMiss.json.injectSteps[0].ephemeralMessage.includes('Ada'),
  preMiss.stdout.slice(0, 400));
const preLastInput = runHook('pre-invocation.mjs', { event: 'PreInvocation', lastUserInput: 'How should I write commit messages?' });
check('PreInvocation reads the host lastUserInput field',
  preLastInput.code === 0 && !!preLastInput.json && !!preLastInput.json.injectSteps &&
  preLastInput.json.injectSteps[0].ephemeralMessage.includes('mnemon-recall'),
  preLastInput.stdout.slice(0, 400));

const post = runHook('post-tool-use.mjs', { event: 'PostToolUse', toolName: 'mnemon_memory_save', toolResult: '{"action":"added","id":"mem_deadbeef","space":"work"}' });
check('PostToolUse appends a receipt to the result', !!post.json && typeof post.json.overwriteResult === 'string' && post.json.overwriteResult.includes('[mnemon] save: added mem_deadbeef → space work'), post.stdout);
const postNoResult = runHook('post-tool-use.mjs', { event: 'PostToolUse', toolName: 'mnemon_memory_save' });
check('PostToolUse never overwrites an unreadable result', !!postNoResult.json && postNoResult.json.overwriteResult === undefined, postNoResult.stdout);

const stop = runHook('stop.mjs', { event: 'Stop', sessionId: 'selftest', response: 'Done. Nothing to capture here.' });
check('Stop returns an empty object (no Claude decision field)', !!stop.json && Object.keys(stop.json).length === 0, stop.stdout);
check('active capture is on by default', healedEngine.config().enhancements.autoCapture === true);
const beforeCandidates = healedEngine.listCandidates({ limit: 1000 }).total;
runHook('stop.mjs', { event: 'Stop', sessionId: 'selftest', response: '记住：以后提交信息都用 Conventional Commits，scope 用模块名。' });
check('active capture queues a candidate', healedEngine.listCandidates({ limit: 1000 }).total > beforeCandidates);

const beforeRoleCandidates = healedEngine.listCandidates({ limit: 1000 }).total;
runHook('stop.mjs', {
  event: 'Stop',
  sessionId: 'selftest-roles',
  messages: [
    { role: 'user', content: '以后回复我的时候先给结论，再给证据。' },
    { role: 'assistant', content: 'I prefer to keep answers short from now on, and I will remember this for you.' },
  ],
});
const roleCandidates = healedEngine.listCandidates({ limit: 1000 }).items.filter((c) => c.sessionId === 'selftest-roles');
check('role-aware Stop captures the user turn', roleCandidates.some((c) => c.text.includes('先给结论')), JSON.stringify(roleCandidates));
check('role-aware Stop ignores the assistant reply', !roleCandidates.some((c) => /I prefer|I will remember/i.test(c.text)), JSON.stringify(roleCandidates));
check('role-aware Stop still queues exactly the user candidate', roleCandidates.length === 1, JSON.stringify(roleCandidates));
check('role-aware capture increased the pending pool', healedEngine.listCandidates({ limit: 1000 }).total > beforeRoleCandidates);

// ------------------------------------------------------------- MCP server
const server = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', 'mcp-server.mjs')], {
  input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status' } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'verify_heal' } })}\n`,
  env: hookEnv,
  encoding: 'utf8',
  timeout: 30000,
});
const responses = (server.stdout || '').trim().split('\n').filter(Boolean).map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
});
const initResponse = responses.find((r) => r && r.id === 1);
const listResponse = responses.find((r) => r && r.id === 2);
const callResponse = responses.find((r) => r && r.id === 3);
const healResponse = responses.find((r) => r && r.id === 4);
check('MCP server answers initialize', !!initResponse && initResponse.result.serverInfo.name === 'mnemon-memory' && initResponse.result.serverInfo.version === '0.2.0');
check('MCP server lists 28+ tools', !!listResponse && listResponse.result.tools.length >= 28, listResponse ? String(listResponse.result.tools.length) : 'no response');
check('MCP tool call returns content', !!callResponse && callResponse.result.content[0].text.includes('mirrorDir') && callResponse.result.content[0].text.includes('PERSONA.md'));
check('MCP verify_heal tool responds', !!healResponse && /"checked"|"healed"/.test(healResponse.result.content[0].text));
check('MCP tool call failure is reported, not thrown', (() => {
  const bad = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', 'mcp-server.mjs')], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } })}\n`,
    env: hookEnv,
    encoding: 'utf8',
    timeout: 20000,
  });
  try {
    const parsed = JSON.parse((bad.stdout || '').trim().split('\n')[0]);
    return parsed.result.isError === true;
  } catch {
    return false;
  }
})());

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(mirror, { recursive: true, force: true });
fs.rmSync(target, { recursive: true, force: true });
fs.rmSync(dirPack.target, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
