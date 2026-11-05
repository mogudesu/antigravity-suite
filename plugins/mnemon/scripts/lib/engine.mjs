/**
 * Mnemon engine: the whole memory model, independent of MCP and of hooks.
 *
 * Memory volumes:
 *   PERSONA.md        AI persona and interaction style, permanent, never truncated
 *   USER.md           who the user is, injected every turn
 *   MEMORY.md         working memory, injected every turn
 *   project documents Markdown files, searched first and read when relevant
 *   memory spaces     durable facts, recalled on demand; items can be pinned
 *
 * Durability: every write is atomic (fsync + rename), mirrored to a second
 * directory tree, snapshotted once a day as a real gzip stream, and the primary
 * store is verified and healed from those copies on every startup.
 */
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as store from './store.mjs';
import { tokens, normalizeText, overlap, extractNumbers, hasNegation, redactSecrets, truncate, oneLine } from './tokenize.mjs';
import { DEFAULT_CONFIG, STRATEGIES, mergeConfig } from './config.mjs';

const PERSONA_TEMPLATE = `# PERSONA.md - AI persona and interaction style

<!-- Highest-priority resident volume: who the assistant is, how it speaks, what it
     values in code, and what it must never do. Injected on every SessionStart and
     never truncated by the resident budget. Edit it through mnemon_memory_runtime_write
     with kind: "persona". One short line per rule. -->

## Identity
- Name: (set one)
- Role: senior full-stack engineering partner

## Voice
- Answer in the user's language; keep progress updates short.
- State evidence before conclusions; say "I don't know" instead of guessing.

## Engineering taste
- Fix the root cause, not the symptom. Small, reviewable diffs.
- Verify with real commands before claiming success.

## Boundaries
- Never invent file contents, test results or command output.
- Never store secrets or credentials in memory.
`;

const USER_TEMPLATE = `# USER.md - who the agent is working with

<!-- Stable facts about the person: name, role, stack, preferences, how they like
     to be answered. Keep it to short one-line facts. Injected every turn. -->

`;

const MEMORY_TEMPLATE = `# MEMORY.md - working memory

<!-- Facts the next turn may need: current projects, decisions in flight,
     working agreements, constraints. Keep it small and current. Injected every turn. -->

`;

function uniq(values) {
  return [...new Set((values || []).filter((v) => v !== undefined && v !== null && String(v).trim() !== ''))];
}

/** Cheap change fingerprint for another process rewriting a store file. */
function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function recordVersion(record) {
  if (!record) return '';
  return `${record.updatedAt || ''}|${record.deletedAt || ''}|${record.pinned ? 1 : 0}`;
}

function mergeText(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return a;
  if (na.includes(nb)) return a;
  if (nb.includes(na)) return b;
  const base = a.length >= b.length ? a : b;
  const other = base === a ? b : a;
  const baseTokens = new Set(tokens(base));
  const extra = tokens(other).filter((t) => !baseTokens.has(t));
  return extra.length <= 2 ? base : `${base}；${other}`;
}

function daysSince(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : 1e9;
}

export class MnemonEngine {
  constructor({ dataDir, mirrorDir = null, workspaceDir = null, config = {}, register = false } = {}) {
    if (!dataDir) throw new Error('MnemonEngine requires a dataDir');
    this.dataDir = path.resolve(dataDir);
    this.mirrorDir = path.resolve(mirrorDir || store.defaultMirrorDir());
    this.workspaceDir = workspaceDir ? path.resolve(workspaceDir) : null;
    this.registerStore = !!register;
    this._config = null;
    this._configSig = null;
    this._spaces = new Map();
    // Last known on-disk version of each record, used to tell an external
    // rewrite apart from a local edit when two processes share one vault.
    this._spaceDisk = new Map();
    this._spaceSig = new Map();
    this._removed = new Map();
    this._hotReloads = 0;
    this._pendingConfig = config;
    this.lastHeal = null;
    this._writing = false;
  }

  get p() {
    const d = this.dataDir;
    return {
      root: d,
      config: path.join(d, 'config.json'),
      runtimeDir: path.join(d, 'runtime'),
      personaMd: path.join(d, 'runtime', 'PERSONA.md'),
      userMd: path.join(d, 'runtime', 'USER.md'),
      memoryMd: path.join(d, 'runtime', 'MEMORY.md'),
      revisions: path.join(d, 'revisions'),
      snapshots: path.join(d, 'snapshots'),
      spacesDir: path.join(d, 'spaces'),
      documentsDir: path.join(d, 'documents'),
      docRevisions: path.join(d, 'documents', '.revisions'),
      docArchive: path.join(d, 'documents', '.archive'),
      candidatesFile: path.join(d, 'candidates', 'pending.jsonl'),
      receiptsDir: path.join(d, 'receipts'),
      backupsDir: path.join(d, 'backups'),
      mirrorLatest: path.join(this.mirrorDir, 'latest'),
      mirrorSnapshots: path.join(this.mirrorDir, 'snapshots'),
    };
  }

  init({ light = false } = {}) {
    const p = this.p;
    for (const dir of [
      p.root, p.runtimeDir, p.revisions, p.snapshots, p.spacesDir, p.documentsDir,
      p.docRevisions, p.docArchive, path.dirname(p.candidatesFile), p.receiptsDir, p.backupsDir,
    ]) store.ensureDir(dir);
    // Read-only hooks fire on every tool step; a full heal + two-drive mirror sync
    // there costs more than the recall it produces, so it is throttled by a stamp.
    const healStamp = path.join(this.dataDir, '.last-heal');
    const stamp = Number(store.readText(healStamp, '0'));
    const recentlyHealed = Number.isFinite(stamp) && stamp > 0 && Date.now() - stamp < 10 * 60 * 1000;
    const skipHeavy = light && recentlyHealed;
    // Startup self-heal runs before anything is seeded, so a damaged volume is
    // restored from the mirror or the newest snapshot instead of being replaced.
    const heal = skipHeavy ? { healed: [], created: [] } : this.verifyAndHeal({ phase: 'startup' });
    if (!store.exists(p.config)) {
      store.writeJSON(p.config, mergeConfig({ ...DEFAULT_CONFIG, createdAt: store.nowISO() }, this._pendingConfig));
    }
    if (!store.exists(p.personaMd)) store.writeText(p.personaMd, PERSONA_TEMPLATE);
    if (!store.exists(p.userMd)) store.writeText(p.userMd, USER_TEMPLATE);
    if (!store.exists(p.memoryMd)) store.writeText(p.memoryMd, MEMORY_TEMPLATE);
    this.ensureSpace('default');
    // Only callers using the implicit ~/.mnemon location write the registry;
    // an explicit store is self-describing and must not touch other paths.
    if (this.registerStore) store.registerDataDir(this.dataDir, { workspaceDir: this.workspaceDir, mirrorDir: this.mirrorDir });
    if (!skipHeavy) {
      this.syncMirror();
      store.writeText(healStamp, String(Date.now()));
      if (heal.healed.length || heal.created.length) this.snapshotDaily();
    }
    return this;
  }

  // ---------------------------------------------------------------- config

  config() {
    const signature = fileSignature(this.p.config);
    if (!this._config || (this._configSig && signature !== this._configSig)) {
      const onDisk = store.readJSON(this.p.config, {}) || {};
      if (this._config) this._hotReloads += 1;
      this._config = mergeConfig({ ...DEFAULT_CONFIG, ...onDisk }, {});
      this._config.enhancements = { ...DEFAULT_CONFIG.enhancements, ...(onDisk.enhancements || {}) };
      this._configSig = signature;
    }
    return this._config;
  }

  setConfig(patch = {}) {
    const next = mergeConfig(this.config(), patch || {});
    if (patch.strategy && !STRATEGIES.includes(patch.strategy)) {
      throw new Error(`unknown strategy "${patch.strategy}" (expected one of ${STRATEGIES.join(', ')})`);
    }
    store.writeJSON(this.p.config, next);
    this._config = next;
    this._configSig = fileSignature(this.p.config);
    return next;
  }

  // --------------------------------------------------------------- runtime

  /** A runtime file that only holds the seeded headings and comments is blank. */
  _isBlankRuntime(text) {
    return !String(text || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('<!--') && !line.startsWith('-->'))
      .join('')
      .trim();
  }

  readRuntime(kind = 'both') {
    const persona = store.readText(this.p.personaMd, '');
    const user = store.readText(this.p.userMd, '');
    const memory = store.readText(this.p.memoryMd, '');
    if (kind === 'persona') return persona;
    if (kind === 'user') return user;
    if (kind === 'memory') return memory;
    return { persona, user, memory };
  }

  writeRuntime({ kind = 'memory', content = '', mode = 'replace' } = {}) {
    if (!['persona', 'user', 'memory'].includes(kind)) throw new Error('kind must be "persona", "user" or "memory"');
    const file = kind === 'persona' ? this.p.personaMd : kind === 'user' ? this.p.userMd : this.p.memoryMd;
    const previous = store.readText(file, '');
    if (previous.trim()) this._revision('runtime', kind, previous);
    const clean = this.config().redactSecrets ? redactSecrets(String(content).trim()) : String(content).trim();
    const text = mode === 'append' && previous.trim() ? `${previous.trimEnd()}\n${clean}\n` : `${clean}\n`;
    store.writeText(file, text);
    this._afterWrite();
    return { kind, mode, file, bytes: text.length, path: path.relative(this.dataDir, file) };
  }

  _revision(kind, id, content) {
    const dir = kind === 'runtime' ? this.p.revisions : path.join(this.p.docRevisions, id);
    store.ensureDir(dir);
    const name = `${store.nowISO().replace(/[:.]/g, '-')}-${store.slugify(id, 'rev')}.md`;
    store.writeText(path.join(dir, name), content);
    const keep = Math.max(1, Number(this.config().keepRevisions) || 20);
    const files = store.listFiles(dir, '.md');
    for (const stale of files.slice(0, Math.max(0, files.length - keep))) store.removeFile(path.join(dir, stale));
  }

  /** Restore a runtime volume exactly as backed up (no trim, no rewrite). */
  _restoreRuntime(kind, content) {
    const file = kind === 'persona' ? this.p.personaMd : kind === 'user' ? this.p.userMd : this.p.memoryMd;
    const previous = store.readText(file, '');
    if (previous.trim()) this._revision('runtime', kind, previous);
    store.writeText(file, String(content ?? ''));
    return { kind, bytes: String(content ?? '').length, path: path.relative(this.dataDir, file) };
  }

  // ---------------------------------------------------------------- spaces

  spaceNames() {
    const names = store.listDirs(this.p.spacesDir);
    if (!names.includes('default')) names.unshift('default');
    return names;
  }

  ensureSpace(name) {
    const clean = store.slugify(name, 'default');
    const dir = path.join(this.p.spacesDir, clean);
    store.ensureDir(dir);
    const meta = path.join(dir, 'meta.json');
    if (!store.exists(meta)) store.writeJSON(meta, { name: clean, description: '', createdAt: store.nowISO() });
    const file = path.join(dir, 'memories.jsonl');
    if (!store.exists(file)) store.writeText(file, '');
    return clean;
  }

  createSpace(name, { description = '' } = {}) {
    const clean = this.ensureSpace(name);
    const meta = path.join(this.p.spacesDir, clean, 'meta.json');
    const current = store.readJSON(meta, { name: clean, createdAt: store.nowISO() });
    store.writeJSON(meta, { ...current, description: description || current.description || '' });
    this._afterWrite();
    return { space: clean, description: description || current.description || '' };
  }

  listSpaces() {
    return this.spaceNames().map((name) => {
      const meta = store.readJSON(path.join(this.p.spacesDir, name, 'meta.json'), {}) || {};
      const list = this._loadSpace(name).filter((m) => !m.deletedAt);
      const last = list.map((m) => m.updatedAt).sort().pop() || null;
      return { name, description: meta.description || '', count: list.length, lastUpdated: last };
    });
  }

  _activeSpaces() {
    const cfg = this.config();
    if (cfg.enhancements && cfg.enhancements.scopedSources && Array.isArray(cfg.spaces) && cfg.spaces.length) {
      return cfg.spaces.map((s) => this.ensureSpace(s));
    }
    return this.spaceNames();
  }

  /**
   * Merge another process's writes into the cached list.
   *
   * Records already on disk are compared with the version we last saw. A local
   * edit wins over an unchanged disk copy; an external edit wins when the local
   * copy is untouched; if both changed the newer updatedAt wins. A record that
   * vanished from disk after we saw it there was hard-deleted elsewhere, so the
   * stale cache copy is dropped instead of resurrecting it on the next flush.
   */
  _syncSpace(clean) {
    const file = path.join(this.p.spacesDir, clean, 'memories.jsonl');
    const signature = fileSignature(file);
    const cached = this._spaces.get(clean);
    const knownSignature = this._spaceSig.get(clean);
    if (cached && knownSignature === signature) return cached;

    const disk = store.readJSONL(file);
    if (!cached) {
      this._spaces.set(clean, disk);
      this._spaceSig.set(clean, signature);
      this._spaceDisk.set(clean, new Map(disk.map((record) => [record.id, recordVersion(record)])));
      return disk;
    }

    const baseline = this._spaceDisk.get(clean) || new Map();
    const localById = new Map(cached.map((record) => [record.id, record]));
    const diskById = new Map(disk.map((record) => [record.id, record]));
    const merged = new Map(localById);
    for (const [id, local] of localById) {
      if (!diskById.has(id) && baseline.has(id)) merged.delete(id);
    }
    for (const [id, onDisk] of diskById) {
      const local = merged.get(id);
      if (!local) {
        merged.set(id, onDisk);
        continue;
      }
      const baseVersion = baseline.get(id);
      const localVersion = recordVersion(local);
      const diskVersion = recordVersion(onDisk);
      if (localVersion === baseVersion) merged.set(id, onDisk);
      else if (diskVersion === baseVersion) merged.set(id, local);
      else if (String(onDisk.updatedAt || '') > String(local.updatedAt || '')) merged.set(id, onDisk);
    }
    const list = [...merged.values()];
    this._spaces.set(clean, list);
    this._spaceSig.set(clean, signature);
    this._spaceDisk.set(clean, new Map(disk.map((record) => [record.id, recordVersion(record)])));
    this._hotReloads += 1;
    return list;
  }

  _loadSpace(name) {
    return this._syncSpace(this.ensureSpace(name));
  }

  _markRemoved(clean, id) {
    if (!this._removed.has(clean)) this._removed.set(clean, new Set());
    this._removed.get(clean).add(id);
  }

  _flushSpace(name) {
    const clean = this.ensureSpace(name);
    const file = path.join(this.p.spacesDir, clean, 'memories.jsonl');
    let list = this._syncSpace(clean);
    const removed = this._removed.get(clean);
    if (removed && removed.size) {
      list = list.filter((record) => !removed.has(record.id));
      this._spaces.set(clean, list);
      this._removed.delete(clean);
    }
    store.writeJSONL(file, list);
    this._spaceSig.set(clean, fileSignature(file));
    this._spaceDisk.set(clean, new Map(list.map((record) => [record.id, recordVersion(record)])));
    this._afterWrite();
  }

  _allMemories({ includeDeleted = false } = {}) {
    const out = [];
    for (const space of this.spaceNames()) {
      for (const m of this._loadSpace(space)) {
        if (!includeDeleted && m.deletedAt) continue;
        out.push({ ...m, space });
      }
    }
    return out;
  }

  _locate(id) {
    for (const space of this.spaceNames()) {
      const list = this._loadSpace(space);
      const index = list.findIndex((m) => m.id === id);
      if (index !== -1) return { space, list, index, record: list[index] };
    }
    return null;
  }

  // -------------------------------------------------------------- memories

  saveMemory({ text, space = 'default', tags = [], entities = [], source = 'manual', kind = 'fact', pinned = false } = {}) {
    let value = String(text || '').trim();
    if (!value) throw new Error('text is required');
    if (this.config().redactSecrets) value = redactSecrets(value);
    const clean = this.ensureSpace(space);
    const hash = normalizeText(value);

    // exact duplicate anywhere: report it instead of storing it twice
    for (const existing of this._allMemories({ includeDeleted: true })) {
      if (existing.deletedAt) continue;
      if (existing.hash === hash) {
        let pinnedNow = !!existing.pinned;
        if (pinned && !existing.pinned) {
          const found = this._locate(existing.id);
          if (found) {
            found.record.pinned = true;
            found.record.updatedAt = store.nowISO();
            this._flushSpace(found.space);
            pinnedNow = true;
          }
        }
        return { action: 'duplicate', id: existing.id, space: existing.space, text: existing.text, pinned: pinnedNow, note: 'identical memory already stored' };
      }
    }

    const list = this._loadSpace(clean);
    const valueTokens = tokens(value);
    const valueNumbers = extractNumbers(value);
    const threshold = Number(this.config().autoMergeThreshold) || 0.82;
    let best = null;
    let bestScore = 0;
    for (const m of list) {
      if (m.deletedAt) continue;
      const { jaccard: jac, containment } = overlap(valueTokens, tokens(m.text));
      const existingNumbers = extractNumbers(m.text);
      const numbersDiffer = valueNumbers.length > 0 && existingNumbers.length > 0 && valueNumbers.join(',') !== existingNumbers.join(',');
      const negationsDiffer = hasNegation(value) !== hasNegation(m.text);
      if (numbersDiffer || negationsDiffer) continue;
      const similar = jac >= threshold || containment >= 0.92;
      const rank = Math.max(jac, containment * 0.95);
      if (similar && rank > bestScore) {
        bestScore = rank;
        best = m;
      }
    }

    if (best) {
      const merged = mergeText(best.text, value);
      best.text = merged;
      best.hash = normalizeText(merged);
      best.updatedAt = store.nowISO();
      best.tags = uniq([...(best.tags || []), ...tags]);
      best.entities = uniq([...(best.entities || []), ...entities]);
      if (pinned) best.pinned = true;
      best.mergedFrom = [...(best.mergedFrom || []), { text: value, at: store.nowISO(), similarity: Number(bestScore.toFixed(3)) }];
      this._flushSpace(clean);
      return { action: 'merged', id: best.id, space: clean, text: best.text, similarity: Number(bestScore.toFixed(3)), pinned: !!best.pinned };
    }

    const record = {
      id: store.uid('mem'),
      kind,
      text: value,
      space: clean,
      tags: uniq(tags),
      entities: uniq(entities),
      source,
      hash,
      pinned: !!pinned,
      createdAt: store.nowISO(),
      updatedAt: store.nowISO(),
      accessedAt: null,
      accessCount: 0,
      deletedAt: null,
      mergedFrom: [],
    };
    list.push(record);
    this._flushSpace(clean);
    return {
      action: 'added',
      id: record.id,
      space: clean,
      text: record.text,
      pinned: record.pinned,
      path: path.join('spaces', clean, 'memories.jsonl'),
    };
  }

  searchMemories(query, { space = null, limit = 8, minScore = 0.01, touch = true } = {}) {
    const queryTokens = tokens(query);
    if (!queryTokens.length) return [];
    const spaces = space ? [this.ensureSpace(space)] : this._activeSpaces();
    const pool = [];
    for (const name of spaces) for (const m of this._loadSpace(name)) if (!m.deletedAt) pool.push({ ...m, space: name });
    if (!pool.length) return [];

    const df = new Map();
    for (const m of pool) for (const t of new Set(tokens(m.text))) df.set(t, (df.get(t) || 0) + 1);
    const total = pool.length;

    const scored = pool.map((m) => {
      const mt = new Set(tokens(`${m.text} ${(m.tags || []).join(' ')} ${(m.entities || []).join(' ')}`));
      let raw = 0;
      for (const t of queryTokens) if (mt.has(t)) raw += Math.log(1 + total / (1 + (df.get(t) || 0)));
      if (raw <= 0) return { ...m, score: 0 }; // no shared term: not a hit, however recent or often used
      const coverage = raw / Math.sqrt(queryTokens.length);
      const recency = 0.35 * Math.exp(-daysSince(m.updatedAt) / 120);
      const usage = 0.12 * Math.log(1 + (m.accessCount || 0));
      // Pinned facts are permanently maintained: they outrank equally relevant
      // transient facts instead of competing with them on recency alone.
      const pinnedBoost = m.pinned ? Number(this.config().pinnedBoost ?? 0.5) : 0;
      return { ...m, score: Number((coverage + recency + usage + pinnedBoost).toFixed(4)) };
    });

    const hits = scored.filter((m) => m.score > minScore).sort((a, b) => b.score - a.score).slice(0, limit);
    // Automatic recall is a read; recording usage would rewrite the space, fsync
    // both drives and re-decode two snapshots on every single tool step.
    if (touch) {
      const touched = new Set();
      for (const hit of hits) {
        const found = this._locate(hit.id);
        if (!found) continue;
        found.record.accessCount = (found.record.accessCount || 0) + 1;
        found.record.accessedAt = store.nowISO();
        touched.add(found.space);
      }
      for (const name of touched) this._flushSpace(name);
    }
    return hits.map(({ id, space, text, tags, entities, score, updatedAt, accessCount, pinned }) => ({ id, space, text, tags, entities, score, updatedAt, accessCount, pinned: !!pinned }));
  }

  listMemories({ space = null, tag = null, limit = 50, offset = 0, includeDeleted = false } = {}) {
    let all = this._allMemories({ includeDeleted });
    if (space) all = all.filter((m) => m.space === this.ensureSpace(space));
    if (tag) all = all.filter((m) => (m.tags || []).includes(tag));
    // Pinned memories stay at the top of the list; the rest is newest first.
    all.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { total: all.length, offset, items: all.slice(offset, offset + limit).map(({ id, space: s, text, tags, entities, updatedAt, accessCount, pinned, deletedAt }) => ({ id, space: s, text, tags, entities, updatedAt, accessCount, pinned: !!pinned, deletedAt: deletedAt || null })) };
  }

  readMemory(id) {
    const found = this._locate(id);
    if (!found) throw new Error(`memory not found: ${id}`);
    return { ...found.record, space: found.space };
  }

  updateMemory(id, { text = null, tags = null, entities = null, space = null, pinned = null } = {}) {
    const found = this._locate(id);
    if (!found) throw new Error(`memory not found: ${id}`);
    const record = found.record;
    const before = record.text;
    if (text !== null && String(text).trim()) {
      record.text = this.config().redactSecrets ? redactSecrets(String(text).trim()) : String(text).trim();
      record.hash = normalizeText(record.text);
    }
    if (Array.isArray(tags)) record.tags = uniq(tags);
    if (Array.isArray(entities)) record.entities = uniq(entities);
    if (typeof pinned === 'boolean') record.pinned = pinned;
    record.updatedAt = store.nowISO();
    if (space && this.ensureSpace(space) !== found.space) {
      const target = this.ensureSpace(space);
      found.list.splice(found.index, 1);
      this._markRemoved(found.space, id);
      record.space = target;
      this._flushSpace(found.space);
      this._loadSpace(target).push(record);
      this._flushSpace(target);
      return { action: 'moved', id, from: found.space, to: target, text: record.text, previousText: before };
    }
    this._flushSpace(found.space);
    return { action: 'updated', id, space: found.space, text: record.text, previousText: before };
  }

  forgetMemory(id, { hard = false } = {}) {
    const found = this._locate(id);
    if (!found) throw new Error(`memory not found: ${id}`);
    if (hard) {
      const [removed] = found.list.splice(found.index, 1);
      this._markRemoved(found.space, id);
      this._flushSpace(found.space);
      return { action: 'erased', id, space: found.space, text: removed.text };
    }
    found.record.deletedAt = store.nowISO();
    this._flushSpace(found.space);
    return { action: 'forgotten', id, space: found.space, text: found.record.text, note: 'soft delete; restore by clearing deletedAt or re-save the fact' };
  }

  // ------------------------------------------------------------- documents

  _parseFrontmatter(raw) {
    const text = String(raw || '');
    if (!text.startsWith('---')) return { meta: {}, body: text };
    const end = text.indexOf('\n---', 3);
    if (end === -1) return { meta: {}, body: text };
    const head = text.slice(3, end).trim();
    const body = text.slice(end + 4).replace(/^\s*\n/, '');
    const meta = {};
    for (const line of head.split('\n')) {
      const i = line.indexOf(':');
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      try {
        meta[key] = JSON.parse(value);
      } catch {
        meta[key] = value;
      }
    }
    return { meta, body };
  }

  saveDocument({ title, content, tags = [], id = null } = {}) {
    const docId = store.slugify(id || title, 'doc');
    const file = path.join(this.p.documentsDir, `${docId}.md`);
    const previousRaw = store.readText(file, '');
    const previous = previousRaw ? this._parseFrontmatter(previousRaw) : null;
    if (previousRaw.trim()) this._revision('document', docId, previousRaw);
    const now = store.nowISO();
    const createdAt = (previous && previous.meta.createdAt) || now;
    const allTags = uniq([...((previous && previous.meta.tags) || []), ...tags]);
    const body = this.config().redactSecrets ? redactSecrets(String(content || '').trim()) : String(content || '').trim();
    const front = ['---', `id: ${docId}`, `title: ${JSON.stringify(title || docId)}`, `tags: ${JSON.stringify(allTags)}`, `createdAt: ${createdAt}`, `updatedAt: ${now}`, '---', ''].join('\n');
    store.writeText(file, `${front}${body}\n`);
    this._afterWrite();
    return { action: previousRaw ? 'updated' : 'created', id: docId, title: title || docId, tags: allTags, updatedAt: now, bytes: body.length, path: path.relative(this.dataDir, file) };
  }

  listDocuments() {
    return store.listFiles(this.p.documentsDir, '.md').map((name) => {
      const raw = store.readText(path.join(this.p.documentsDir, name), '');
      const { meta, body } = this._parseFrontmatter(raw);
      return { id: meta.id || name.replace(/\.md$/, ''), title: meta.title || name.replace(/\.md$/, ''), tags: meta.tags || [], updatedAt: meta.updatedAt || null, chars: body.length };
    });
  }

  readDocument(id) {
    const docId = store.slugify(id, 'doc');
    const file = path.join(this.p.documentsDir, `${docId}.md`);
    const raw = store.readText(file, '');
    if (!raw) throw new Error(`document not found: ${id}`);
    const { meta, body } = this._parseFrontmatter(raw);
    return { id: meta.id || docId, title: meta.title || docId, tags: meta.tags || [], createdAt: meta.createdAt || null, updatedAt: meta.updatedAt || null, content: body };
  }

  searchDocuments(query, { limit = 5, minScore = 0.01 } = {}) {
    const queryTokens = tokens(query);
    if (!queryTokens.length) return [];
    const docs = store.listFiles(this.p.documentsDir, '.md').map((name) => {
      const raw = store.readText(path.join(this.p.documentsDir, name), '');
      const { meta, body } = this._parseFrontmatter(raw);
      return { id: meta.id || name.replace(/\.md$/, ''), title: meta.title || name.replace(/\.md$/, ''), tags: meta.tags || [], updatedAt: meta.updatedAt || null, body };
    });
    const scored = docs.map((doc) => {
      const docTokens = new Set(tokens(`${doc.title} ${doc.body}`));
      let hits = 0;
      for (const t of queryTokens) if (docTokens.has(t)) hits += 1;
      const score = Number(((hits / Math.sqrt(queryTokens.length)) + (doc.updatedAt ? 0.2 * Math.exp(-daysSince(doc.updatedAt) / 180) : 0)).toFixed(4));
      return { ...doc, score };
    });
    return scored
      .filter((d) => d.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ id, title, tags, updatedAt, body, score }) => ({ id, title, tags, updatedAt, score, snippet: this._snippet(body, queryTokens) }));
  }

  _snippet(body, queryTokens) {
    const flat = String(body || '').replace(/\s+/g, ' ').trim();
    const set = new Set(queryTokens);
    let bestIndex = -1;
    for (const t of set) {
      const i = flat.toLowerCase().indexOf(t);
      if (i !== -1 && (bestIndex === -1 || i < bestIndex)) bestIndex = i;
    }
    if (bestIndex === -1) return truncate(flat, 180);
    const start = Math.max(0, bestIndex - 60);
    return `${start > 0 ? '…' : ''}${truncate(flat.slice(start, start + 220), 220)}`;
  }

  archiveDocument(id) {
    const docId = store.slugify(id, 'doc');
    const file = path.join(this.p.documentsDir, `${docId}.md`);
    if (!store.exists(file)) throw new Error(`document not found: ${id}`);
    const target = path.join(this.p.docArchive, `${docId}.md`);
    store.writeText(target, store.readText(file, ''));
    store.removeFile(file);
    this._afterWrite();
    return { action: 'archived', id: docId, path: path.relative(this.dataDir, target) };
  }

  // ------------------------------------------------------------ candidates

  addCandidate({ text, reason = '', source = 'manual', sessionId = null } = {}) {
    const value = String(text || '').trim();
    if (!value) throw new Error('text is required');
    const hash = normalizeText(value);
    const list = store.readJSONL(this.p.candidatesFile);
    const existing = list.find((c) => c.status === 'pending' && c.hash === hash);
    if (existing) return { action: 'duplicate', id: existing.id, text: existing.text };
    const record = {
      id: store.uid('cand'),
      text: this.config().redactSecrets ? redactSecrets(value) : value,
      reason,
      source,
      sessionId,
      hash,
      createdAt: store.nowISO(),
      status: 'pending',
    };
    store.appendJSONL(this.p.candidatesFile, record);
    return { action: 'queued', id: record.id, text: record.text, reason };
  }

  listCandidates({ status = 'pending', limit = 50 } = {}) {
    const list = store.readJSONL(this.p.candidatesFile).filter((c) => !status || c.status === status);
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { total: list.length, items: list.slice(0, limit) };
  }

  resolveCandidate(id, { action = 'adopt', space = 'default', text = null } = {}) {
    const list = store.readJSONL(this.p.candidatesFile);
    const index = list.findIndex((c) => c.id === id);
    if (index === -1) throw new Error(`candidate not found: ${id}`);
    const candidate = list[index];
    if (!['adopt', 'reject'].includes(action)) throw new Error('action must be "adopt" or "reject"');
    if (action === 'reject') {
      list[index] = { ...candidate, status: 'rejected', resolvedAt: store.nowISO() };
      store.writeJSONL(this.p.candidatesFile, list);
      return { action: 'rejected', id, text: candidate.text };
    }
    const saved = this.saveMemory({ text: text || candidate.text, space, source: 'candidate', tags: candidate.reason ? ['captured'] : [] });
    list[index] = { ...candidate, status: 'adopted', resolvedAt: store.nowISO(), memoryId: saved.id, space: saved.space };
    store.writeJSONL(this.p.candidatesFile, list);
    return { action: 'adopted', id, memory: saved };
  }

  // -------------------------------------------------------------- receipts

  recordReceipt({ session = null, read = [], wrote = [], note = '' } = {}) {
    if (!read.length && !wrote.length && !note) return null;
    const stamp = store.nowISO();
    const file = path.join(this.p.receiptsDir, `${stamp.slice(0, 10)}.jsonl`);
    const record = { ts: stamp, session, read, wrote, note };
    store.appendJSONL(file, record);
    return record;
  }

  recentReceipts({ limit = 10, day = null } = {}) {
    const target = day || store.nowISO().slice(0, 10);
    const files = [target];
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (!day) files.push(yesterday);
    const out = [];
    for (const f of files) out.push(...store.readJSONL(path.join(this.p.receiptsDir, `${f}.jsonl`)));
    out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return { total: out.length, items: out.slice(0, limit) };
  }

  // ---------------------------------------------------------------- context

  counts() {
    const memories = this._allMemories().length;
    return {
      memories,
      pinned: this._allMemories().filter((m) => m.pinned).length,
      spaces: this.spaceNames().length,
      documents: this.listDocuments().length,
      pendingCandidates: this.listCandidates({ limit: 1e6 }).total,
    };
  }

  buildTurnContext({ prompt = '', session = null, budget = null } = {}) {
    const cfg = this.config();
    let budgetChars = Number(budget ?? cfg.residentBudgetChars) || 6000;
    if (cfg.enhancements.lightContext || cfg.strategy === 'light-context') budgetChars = Math.round(budgetChars / 2);

    const { persona, user, memory } = this.readRuntime();
    // PERSONA.md is the permanent volume: it is never shortened by the budget,
    // which only governs USER.md + MEMORY.md.
    const personaText = String(persona || '').trim();
    let residentBase = [user.trim(), memory.trim()].filter(Boolean).join('\n\n');
    if (residentBase.length > budgetChars) residentBase = `${truncate(residentBase, budgetChars)}\n…(resident memory truncated to the ${budgetChars}-character budget)`;
    const resident = [personaText, residentBase].filter(Boolean).join('\n\n');

    const relevant = prompt ? this.searchMemories(prompt, { limit: cfg.searchBudget, touch: false }) : [];
    const documents = prompt ? this.searchDocuments(prompt, { limit: cfg.documentBudget }) : [];
    const pinned = this._allMemories()
      .filter((m) => m.pinned)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 30)
      .map(({ id, space, text, updatedAt }) => ({ id, space, text, updatedAt }));
    const receipts = { read: [...relevant.map((r) => r.id), ...documents.map((d) => d.id)], wrote: [] };
    if (receipts.read.length) this.recordReceipt({ session, read: receipts.read, note: 'turn context' });

    return { strategy: cfg.strategy, enhancements: cfg.enhancements, budgetChars, resident, persona: personaText, residentBase, pinned, relevant, documents, receipts, counts: this.counts() };
  }

  formatContextBlock(context, { header = 'mnemon-memory', includeUsage = true } = {}) {
    const lines = [`<${header} strategy="${context.strategy}" budget="${context.budgetChars}">`];
    if (context.persona) {
      lines.push('## Persona (PERSONA.md · permanent, never truncated)');
      lines.push(context.persona);
    }
    if (context.residentBase) {
      lines.push('## Resident memory (USER.md + MEMORY.md)');
      lines.push(context.residentBase);
    } else if (!context.persona && context.resident) {
      lines.push('## Resident memory', context.resident);
    }
    if (context.pinned && context.pinned.length) {
      lines.push('## Pinned memory (permanent, never stale)');
      for (const m of context.pinned) lines.push(`- [${m.id}] (${m.space}) ${oneLine(m.text, 300)}`);
    }
    if (context.relevant && context.relevant.length) {
      lines.push('## Relevant memory recalled for this turn');
      for (const m of context.relevant) lines.push(`- [${m.id}] (${m.space}, score ${m.score}${m.pinned ? ', pinned' : ''}) ${oneLine(m.text, 300)}`);
    }
    if (context.documents && context.documents.length) {
      lines.push('## Project documents (read on demand)');
      for (const d of context.documents) lines.push(`- ${d.id} — ${oneLine(d.title, 90)} — ${oneLine(d.snippet, 140)} — read with mnemon_memory_document_read`);
    }
    if (includeUsage) {
      lines.push('## How to use this memory');
      lines.push('- Recall more: mnemon_memory_search · Recall a whole turn: mnemon_memory_context');
      lines.push('- Save a fact: mnemon_memory_save (deduplicates and reports where it went)');
      lines.push('- Slash commands: /mnemon · /mnemon-remember · /mnemon-review · /mnemon-' + 'system' + ' · /mnemon-evolve');
      lines.push('- Remembered history never outranks the current instructions or the workspace files.');
    }
    if (context.counts) {
      const c = context.counts;
      lines.push(`## Status: ${c.memories} memories · ${c.spaces} spaces · ${c.documents} documents · ${c.pendingCandidates} candidates awaiting review`);
    }
    lines.push(`</${header}>`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ audit

  audit() {
    const cfg = this.config();
    const all = this._allMemories();
    const withTokens = all.map((m) => ({ ...m, tokenSet: new Set(tokens(m.text)) }));
    const duplicates = [];
    const conflicts = [];
    for (let i = 0; i < withTokens.length; i += 1) {
      for (let j = i + 1; j < withTokens.length; j += 1) {
        const a = withTokens[i];
        const b = withTokens[j];
        const { jaccard: score, containment } = overlap(a.tokenSet, b.tokenSet);
        if (score >= Number(cfg.duplicateThreshold) || a.hash === b.hash) {
          duplicates.push({ a: { id: a.id, space: a.space, text: a.text }, b: { id: b.id, space: b.space, text: b.text }, similarity: Number(score.toFixed(3)) });
          continue;
        }
        if (containment >= Number(cfg.conflictContainment)) {
          const numA = extractNumbers(a.text);
          const numB = extractNumbers(b.text);
          const numbersDiffer = numA.length && numB.length && numA.join(',') !== numB.join(',');
          if (hasNegation(a.text) !== hasNegation(b.text) || numbersDiffer) {
            conflicts.push({
              a: { id: a.id, space: a.space, text: a.text },
              b: { id: b.id, space: b.space, text: b.text },
              similarity: Number(score.toFixed(3)),
              reason: numbersDiffer ? 'same subject, different numbers' : 'one side is negated',
            });
          }
        }
      }
    }
    const stale = all
      .filter((m) => !m.pinned && daysSince(m.updatedAt) > Number(cfg.staleAfterDays) && (m.accessCount || 0) <= 1)
      .map((m) => ({ id: m.id, space: m.space, text: m.text, updatedAt: m.updatedAt, ageDays: Math.round(daysSince(m.updatedAt)) }));
    const emptySpaces = this.listSpaces().filter((s) => s.count === 0).map((s) => s.name);
    return {
      generatedAt: store.nowISO(),
      counts: this.counts(),
      duplicates: duplicates.slice(0, 25),
      conflicts: conflicts.slice(0, 25),
      stale: stale.slice(0, 25),
      emptySpaces,
      advice: duplicates.length || conflicts.length
        ? 'Run /mnemon-review to adopt a reconciliation plan: merge duplicates, then decide each conflict.'
        : 'No duplicates or conflicts found.',
    };
  }

  entities() {
    const graph = new Map();
    for (const m of this._allMemories()) {
      for (const entity of m.entities || []) {
        if (!graph.has(entity)) graph.set(entity, []);
        graph.get(entity).push({ id: m.id, space: m.space, text: oneLine(m.text, 160) });
      }
    }
    return [...graph.entries()].map(([entity, links]) => ({ entity, links })).sort((a, b) => b.links.length - a.links.length);
  }

  // ----------------------------------------------------------- portability

  pack() {
    const spaces = {};
    for (const name of this.spaceNames()) spaces[name] = this._loadSpace(name);
    const { persona, user, memory } = this.readRuntime();
    return {
      format: 'mnemon-pack',
      formatVersion: 2,
      exportedAt: store.nowISO(),
      config: this.config(),
      runtime: { persona, user, memory },
      spaces,
      documents: store.listFiles(this.p.documentsDir, '.md').map((name) => {
        const raw = store.readText(path.join(this.p.documentsDir, name), '');
        const { meta, body } = this._parseFrontmatter(raw);
        return { id: meta.id || name.replace(/\.md$/, ''), title: meta.title || name, tags: meta.tags || [], createdAt: meta.createdAt || null, updatedAt: meta.updatedAt || null, content: body };
      }),
      candidates: store.readJSONL(this.p.candidatesFile).filter((c) => c.status === 'pending'),
    };
  }

  /** Serialize the pack exactly once so the gzip payload is reproducible. */
  _packBuffer(pack = null) {
    return Buffer.from(`${JSON.stringify(pack || this.pack(), null, 2)}\n`, 'utf8');
  }

  backup({ mode = 'bundle', target = null } = {}) {
    const pack = this.pack();
    const stamp = store.nowISO().replace(/[:.]/g, '-');
    if (mode === 'dir') {
      const dir = path.resolve(target || path.join(this.p.backupsDir, `pack-${stamp}`));
      store.ensureDir(dir);
      store.writeJSON(path.join(dir, 'mnemon-pack.json'), pack);
      store.writeText(path.join(dir, 'runtime', 'PERSONA.md'), `${pack.runtime.persona || ''}`);
      store.writeText(path.join(dir, 'runtime', 'USER.md'), `${pack.runtime.user || ''}`);
      store.writeText(path.join(dir, 'runtime', 'MEMORY.md'), `${pack.runtime.memory || ''}`);
      for (const [name, list] of Object.entries(pack.spaces)) store.writeJSONL(path.join(dir, 'spaces', name, 'memories.jsonl'), list);
      for (const doc of pack.documents) store.writeText(path.join(dir, 'documents', `${doc.id}.md`), `# ${doc.title}\n\n${doc.content}\n`);
      return { mode: 'dir', target: dir, memories: Object.values(pack.spaces).reduce((n, l) => n + l.length, 0), documents: pack.documents.length };
    }
    const file = path.resolve(target || path.join(this.p.backupsDir, `mnemon-backup-${stamp}.json.gz`));
    const payload = this._packBuffer(pack);
    const body = zlib.gzipSync(payload, { level: 9 });
    store.writeBytes(file, body); // raw bytes: never a UTF-8 string round trip
    const check = this.verifyBackup(file);
    if (!check.valid) throw new Error(`backup verification failed for ${file}: ${check.reason}`);
    return {
      mode: 'bundle',
      target: file,
      bytes: payload.length,
      compressedBytes: body.length,
      sha256: check.sha256,
      gzipValid: true,
      memories: Object.values(pack.spaces).reduce((n, l) => n + l.length, 0),
      documents: pack.documents.length,
    };
  }

  /** Decode a .json.gz backup with a real gzip decoder and check the payload. */
  verifyBackup(file) {
    const raw = store.readBytes(path.resolve(file));
    if (!raw || !raw.length) return { valid: false, reason: 'missing or empty file', file: path.resolve(file) };
    if (!store.isGzip(raw)) return { valid: false, reason: 'not a gzip stream (bad magic bytes)', file: path.resolve(file) };
    let payload;
    try {
      payload = zlib.gunzipSync(raw);
    } catch (error) {
      return { valid: false, reason: `gzip decode failed: ${error.message}`, file: path.resolve(file) };
    }
    let pack;
    try {
      pack = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      return { valid: false, reason: `payload is not JSON: ${error.message}`, file: path.resolve(file) };
    }
    if (!pack || pack.format !== 'mnemon-pack') return { valid: false, reason: 'payload is not a mnemon pack', file: path.resolve(file) };
    return {
      valid: true,
      file: path.resolve(file),
      formatVersion: pack.formatVersion || 1,
      bytes: payload.length,
      compressedBytes: raw.length,
      sha256: store.sha256(payload),
      memories: Object.values(pack.spaces || {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
      documents: (pack.documents || []).length,
      exportedAt: pack.exportedAt || null,
    };
  }

  importPack(file, { mode = 'merge' } = {}) {
    const absolute = path.resolve(file);
    const raw = store.readBytes(absolute);
    if (!raw || !raw.length) throw new Error(`backup not found or empty: ${file}`);
    let json;
    if (store.isGzip(raw)) {
      try {
        json = zlib.gunzipSync(raw).toString('utf8');
      } catch (error) {
        throw new Error(`cannot decode gzip backup ${file}: ${error.message}`);
      }
    } else {
      json = raw.toString('utf8');
    }
    const pack = JSON.parse(json);
    if (pack.format !== 'mnemon-pack') throw new Error('not a mnemon pack');
    const summary = { mode, added: 0, merged: 0, duplicate: 0, documents: 0 };
    this._writing = true;
    try {
      if (mode === 'replace') {
        this._restoreRuntime('persona', pack.runtime?.persona ?? '');
        this._restoreRuntime('user', pack.runtime?.user ?? '');
        this._restoreRuntime('memory', pack.runtime?.memory ?? '');
      } else if (pack.runtime) {
        const current = this.readRuntime();
        if (this._isBlankRuntime(current.persona) && pack.runtime.persona) this.writeRuntime({ kind: 'persona', content: pack.runtime.persona });
        if (this._isBlankRuntime(current.user) && pack.runtime.user) this.writeRuntime({ kind: 'user', content: pack.runtime.user });
        if (this._isBlankRuntime(current.memory) && pack.runtime.memory) this.writeRuntime({ kind: 'memory', content: pack.runtime.memory });
      }
      for (const [space, list] of Object.entries(pack.spaces || {})) {
        this.ensureSpace(space);
        if (mode === 'replace') {
          this._spaces.set(space, []);
          this._spaceDisk.set(space, new Map());
          store.writeJSONL(path.join(this.p.spacesDir, space, 'memories.jsonl'), []);
          this._spaceSig.set(space, fileSignature(path.join(this.p.spacesDir, space, 'memories.jsonl')));
        }
        for (const m of list) {
          const result = this.saveMemory({ text: m.text, space, tags: m.tags || [], entities: m.entities || [], source: 'import', pinned: !!m.pinned });
          if (summary[result.action] !== undefined) summary[result.action] += 1;
        }
      }
      for (const doc of pack.documents || []) {
        this.saveDocument({ id: doc.id, title: doc.title, content: doc.content, tags: doc.tags || [] });
        summary.documents += 1;
      }
    } finally {
      this._writing = false;
    }
    this._afterWrite();
    return summary;
  }

  // ------------------------------------------------------- mirror and heal

  /** Relative paths that are mirrored to the second store. */
  _mirrorRelFiles() {
    const rel = ['runtime/PERSONA.md', 'runtime/USER.md', 'runtime/MEMORY.md'];
    for (const space of this.spaceNames()) {
      rel.push(`spaces/${space}/memories.jsonl`, `spaces/${space}/meta.json`);
    }
    for (const doc of store.listFiles(this.p.documentsDir, '.md')) rel.push(`documents/${doc}`);
    return rel;
  }

  _sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.equals(b);
  }

  /**
   * Realtime mirror: copy runtime volumes, space files and documents to
   * <mirror>/latest preserving their relative paths. Only changed files are
   * rewritten; files removed from the primary set are pruned from the mirror.
   */
  syncMirror() {
    const latest = this.p.mirrorLatest;
    store.ensureDir(latest);
    let copied = 0;
    let unchanged = 0;
    const relFiles = this._mirrorRelFiles();
    for (const rel of relFiles) {
      const src = path.join(this.dataDir, rel);
      const dst = path.join(latest, rel);
      const bytes = store.readBytes(src);
      if (!bytes) continue;
      if (this._sameBytes(bytes, store.readBytes(dst))) {
        unchanged += 1;
        continue;
      }
      store.writeBytes(dst, bytes);
      copied += 1;
    }
    let pruned = 0;
    const current = new Set(relFiles.map((r) => r.replace(/\\/g, '/')));
    for (const doc of store.listFiles(path.join(latest, 'documents'), '.md')) {
      if (!current.has(`documents/${doc}`)) {
        store.removeFile(path.join(latest, 'documents', doc));
        pruned += 1;
      }
    }
    for (const space of store.listDirs(path.join(latest, 'spaces'))) {
      if (!store.exists(path.join(this.p.spacesDir, space))) {
        for (const file of store.listFiles(path.join(latest, 'spaces', space))) {
          store.removeFile(path.join(latest, 'spaces', space, file));
        }
        try {
          fs.rmdirSync(path.join(latest, 'spaces', space));
        } catch {
          /* directory not empty or already gone */
        }
        pruned += 1;
      }
    }
    return { mirrorDir: this.mirrorDir, latest, files: relFiles.length, copied, unchanged, pruned };
  }

  _snapshotName(day = store.nowISO().slice(0, 10)) {
    return `mnemon-${day}.json.gz`;
  }

  /** Validate a snapshot file by really decoding it. */
  verifySnapshot(file) {
    const raw = store.readBytes(file);
    if (!raw || !raw.length) return { valid: false, reason: 'missing or empty file' };
    if (!store.isGzip(raw)) return { valid: false, reason: 'not a gzip stream' };
    try {
      const payload = zlib.gunzipSync(raw);
      const pack = JSON.parse(payload.toString('utf8'));
      if (pack.format !== 'mnemon-pack') return { valid: false, reason: 'not a mnemon pack' };
      return { valid: true, bytes: payload.length, compressedBytes: raw.length, sha256: store.sha256(payload) };
    } catch (error) {
      return { valid: false, reason: error.message };
    }
  }

  /**
   * One verified snapshot per day, written to both drives, retaining the newest
   * `snapshotRetention` (30) days on each.
   */
  snapshotDaily({ verify = false } = {}) {
    const day = store.nowISO().slice(0, 10);
    const name = this._snapshotName(day);
    const targets = [path.join(this.p.mirrorSnapshots, name), path.join(this.p.snapshots, name)];
    let created = false;
    let payload = null;
    for (const target of targets) {
      // Decoding both daily snapshots (gunzip + parse + sha256) on every write was
      // the hot path cost; presence is enough until an explicit verify is asked for.
      const inPlace = verify
        ? this.verifySnapshot(target).valid
        : store.statSize(target) > 64;
      if (inPlace) continue;
      if (!payload) {
        payload = this._packBuffer();
        const gz = zlib.gzipSync(payload, { level: 9 });
        for (const t of targets) store.writeBytes(t, gz);
      }
      created = true;
      break;
    }
    const keep = Math.max(1, Number(this.config().snapshotRetention) || 30);
    const pruned = [];
    for (const dir of [this.p.mirrorSnapshots, this.p.snapshots]) {
      const files = store.listFiles(dir, '.json.gz').sort();
      for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
        if (store.removeFile(path.join(dir, stale))) pruned.push(path.join(dir, stale));
      }
    }
    return { created, day, targets, pruned };
  }

  _afterWrite() {
    if (this._writing) return;
    this._writing = true;
    try {
      this.syncMirror();
      this.snapshotDaily();
    } catch (error) {
      process.stderr.write(`mnemon: mirror/snapshot failed: ${error && error.message ? error.message : error}\n`);
    } finally {
      this._writing = false;
    }
  }

  _primaryDamage(rel, file) {
    const size = store.statSize(file);
    if (size === -1) return 'missing';
    if (size === 0) return 'zero-bytes';
    const raw = store.readText(file, '');
    if (rel.endsWith('.json')) {
      try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? null : 'corrupt-json';
      } catch {
        return 'corrupt-json';
      }
    }
    if (rel.endsWith('.jsonl')) {
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          JSON.parse(t);
        } catch {
          return 'corrupt-jsonl';
        }
      }
      return null;
    }
    return null;
  }

  _snapshotPacks() {
    const candidates = [];
    for (const dir of [this.p.mirrorSnapshots, this.p.snapshots]) {
      for (const name of store.listFiles(dir, '.json.gz').sort().reverse()) {
        if (candidates.length >= 40) break;
        const file = path.join(dir, name);
        const check = this.verifySnapshot(file);
        if (!check.valid) continue;
        try {
          const raw = store.readBytes(file);
          candidates.push({ file, pack: JSON.parse(zlib.gunzipSync(raw).toString('utf8')) });
        } catch {
          /* skip an unreadable snapshot and try the next one */
        }
      }
    }
    return candidates;
  }

  _snapshotContent(pack, rel) {
    if (rel === 'config.json') return pack.config ? `${JSON.stringify(pack.config, null, 2)}\n` : null;
    if (rel === 'runtime/PERSONA.md') return pack.runtime && pack.runtime.persona ? pack.runtime.persona : null;
    if (rel === 'runtime/USER.md') return pack.runtime && pack.runtime.user ? pack.runtime.user : null;
    if (rel === 'runtime/MEMORY.md') return pack.runtime && pack.runtime.memory ? pack.runtime.memory : null;
    const spaceFile = /^spaces\/([^/]+)\/(memories\.jsonl|meta\.json)$/.exec(rel);
    if (spaceFile) {
      const [, space, kind] = spaceFile;
      if (kind === 'memories.jsonl') {
        const list = pack.spaces && pack.spaces[space];
        return Array.isArray(list) ? list.map((v) => JSON.stringify(v)).join('\n') + (list.length ? '\n' : '') : null;
      }
      return `${JSON.stringify({ name: space, description: '', createdAt: pack.exportedAt || store.nowISO() }, null, 2)}\n`;
    }
    const docFile = /^documents\/(.+)\.md$/.exec(rel);
    if (docFile) {
      const doc = (pack.documents || []).find((d) => d.id === docFile[1]);
      if (!doc) return null;
      const front = ['---', `id: ${doc.id}`, `title: ${JSON.stringify(doc.title || doc.id)}`, `tags: ${JSON.stringify(doc.tags || [])}`, `createdAt: ${doc.createdAt || pack.exportedAt || store.nowISO()}`, `updatedAt: ${doc.updatedAt || pack.exportedAt || store.nowISO()}`, '---', ''].join('\n');
      return `${front}${doc.content || ''}\n`;
    }
    return null;
  }

  /**
   * Startup self-heal. For every primary file that is missing, zero bytes or
   * corrupt JSON/JSONL, restore the newest good copy from <mirror>/latest and
   * then from the newest verified snapshot. Writes a recovery receipt.
   */
  verifyAndHeal({ phase = 'manual', session = null } = {}) {
    const p = this.p;
    const expected = [p.config, p.personaMd, p.userMd, p.memoryMd];
    // Also consider spaces and documents that exist only in the mirror, so a
    // whole directory that vanished is restored rather than silently skipped.
    const spaces = new Set(store.listDirs(p.spacesDir));
    for (const space of store.listDirs(path.join(p.mirrorLatest, 'spaces'))) spaces.add(space);
    if (!spaces.size) spaces.add('default');
    for (const space of spaces) {
      expected.push(path.join(p.spacesDir, space, 'meta.json'), path.join(p.spacesDir, space, 'memories.jsonl'));
    }
    const docNames = new Set(store.listFiles(p.documentsDir, '.md'));
    for (const doc of store.listFiles(path.join(p.mirrorLatest, 'documents'), '.md')) docNames.add(doc);
    for (const doc of docNames) expected.push(path.join(p.documentsDir, doc));

    const healed = [];
    const created = [];
    const failed = [];
    let checked = 0;
    let packs = null;

    for (const file of expected) {
      const rel = path.relative(this.dataDir, file).split(path.sep).join('/');
      checked += 1;
      const damage = this._primaryDamage(rel, file);
      if (!damage) continue;

      let content = null;
      let source = null;
      const mirrorFile = path.join(p.mirrorLatest, rel);
      const mirrorRaw = store.readBytes(mirrorFile);
      const size = store.statSize(mirrorFile);
      if (mirrorRaw && size > 0) {
        const mirrorDamage = this._primaryDamage(rel, mirrorFile);
        if (!mirrorDamage) {
          content = mirrorRaw;
          source = `mirror:${mirrorFile}`;
        }
      }
      if (content === null) {
        if (!packs) packs = this._snapshotPacks();
        for (const candidate of packs) {
          const fromSnapshot = this._snapshotContent(candidate.pack, rel);
          if (fromSnapshot && fromSnapshot.length) {
            content = Buffer.from(fromSnapshot, 'utf8');
            source = `snapshot:${candidate.file}`;
            break;
          }
        }
      }

      // An empty memories.jsonl is a valid empty space, not damage: only heal it
      // when a mirror or snapshot copy actually has content to restore.
      if (content === null && damage === 'zero-bytes' && rel.endsWith('/memories.jsonl')) continue;

      if (content === null) {
        // Nothing recoverable. Recreate the file so the store stays consistent,
        // and report it: an empty memory space is normal, a lost document is not.
        if (rel.endsWith('/memories.jsonl')) {
          content = Buffer.from('');
          source = 'recreated:empty-space';
        } else if (rel.endsWith('meta.json')) {
          const space = rel.split('/')[1];
          content = Buffer.from(`${JSON.stringify({ name: space, description: '', createdAt: store.nowISO() }, null, 2)}\n`, 'utf8');
          source = 'recreated:space-meta';
        } else if (rel === 'runtime/PERSONA.md') {
          content = Buffer.from(PERSONA_TEMPLATE, 'utf8');
          source = 'seeded:template';
        } else if (rel === 'runtime/USER.md') {
          content = Buffer.from(USER_TEMPLATE, 'utf8');
          source = 'seeded:template';
        } else if (rel === 'runtime/MEMORY.md') {
          content = Buffer.from(MEMORY_TEMPLATE, 'utf8');
          source = 'seeded:template';
        } else if (rel === 'config.json') {
          content = Buffer.from(`${JSON.stringify(mergeConfig({ ...DEFAULT_CONFIG, createdAt: store.nowISO() }, this._pendingConfig), null, 2)}\n`, 'utf8');
          source = 'recreated:default-config';
        } else {
          failed.push({ path: rel, reason: damage, note: 'no mirror or snapshot copy available' });
          continue;
        }
        created.push({ path: rel, reason: damage, source });
      } else {
        healed.push({ path: rel, reason: damage, source });
      }
      store.writeBytes(file, content);
    }

    if (healed.length || created.length) {
      for (const entry of [...healed, ...created]) {
        if (entry.path === 'config.json') {
          this._config = null;
          this._configSig = null;
          continue;
        }
        const spaceFile = /^spaces\/([^/]+)\/memories\.jsonl$/.exec(entry.path);
        if (spaceFile) {
          this._spaces.delete(spaceFile[1]);
          this._spaceSig.delete(spaceFile[1]);
          this._spaceDisk.delete(spaceFile[1]);
          this._removed.delete(spaceFile[1]);
        }
      }
    }

    let receipt = null;
    if (healed.length || created.length || failed.length) {
      const record = {
        ts: store.nowISO(),
        phase,
        session,
        dataDir: this.dataDir,
        mirrorDir: this.mirrorDir,
        checked,
        healed,
        created,
        failed,
      };
      const name = `heal-${record.ts.replace(/[:.]/g, '-')}.json`;
      store.writeJSON(path.join(p.receiptsDir, name), record);
      try {
        this.recordReceipt({
          session,
          wrote: healed.map((h) => h.path),
          note: `verifyAndHeal(${phase}): ${healed.length} restored, ${created.length} recreated, ${failed.length} failed`,
        });
      } catch {
        /* the heal itself must never fail because a receipt could not be written */
      }
      receipt = { ...record, file: path.join(p.receiptsDir, name) };
    }

    this.lastHeal = receipt ? { ts: receipt.ts, phase, healed: healed.length, created: created.length, failed: failed.length } : this.lastHeal;
    if (healed.length) this.syncMirror();
    return { checked, healed, created, failed, receipt };
  }

  mirrorStatus() {
    const snapshotFiles = store.listFiles(this.p.mirrorSnapshots, '.json.gz');
    return {
      mirrorDir: this.mirrorDir,
      latestDir: this.p.mirrorLatest,
      snapshotsDir: this.p.mirrorSnapshots,
      latestFiles: this._mirrorRelFiles().filter((rel) => store.exists(path.join(this.p.mirrorLatest, rel))).length,
      expectedFiles: this._mirrorRelFiles().length,
      snapshots: snapshotFiles,
      lastSnapshot: snapshotFiles.length ? snapshotFiles[snapshotFiles.length - 1] : null,
      lastHeal: this.lastHeal,
    };
  }

  status() {
    const cfg = this.config();
    return {
      dataDir: this.dataDir,
      mirrorDir: this.mirrorDir,
      workspaceDir: this.workspaceDir,
      strategy: cfg.strategy,
      enhancements: cfg.enhancements,
      scope: cfg.scope,
      budgets: { residentChars: cfg.residentBudgetChars, search: cfg.searchBudget, documents: cfg.documentBudget },
      writePolicy: cfg.writePolicy,
      counts: this.counts(),
      spaces: this.listSpaces(),
      hotReloads: this._hotReloads,
      mirror: this.mirrorStatus(),
      paths: {
        persona: 'runtime/PERSONA.md',
        runtime: ['runtime/PERSONA.md', 'runtime/USER.md', 'runtime/MEMORY.md'],
        spaces: 'spaces/<space>/memories.jsonl',
        documents: 'documents/<id>.md',
        candidates: 'candidates/pending.jsonl',
        receipts: 'receipts/<date>.jsonl',
        snapshots: 'snapshots/mnemon-YYYY-MM-DD.json.gz (+ mirror snapshot)',
      },
    };
  }
}

export function openEngine({ dataDir, mirrorDir = null, workspaceDir = null, config = {}, register = false, light = false } = {}) {
  return new MnemonEngine({ dataDir: dataDir || store.resolveDataDir(), mirrorDir: mirrorDir || store.resolveMirrorDir(), workspaceDir, config, register }).init({ light });
}
