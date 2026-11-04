/**
 * Mnemon storage helpers.
 *
 * Everything Mnemon writes lives under one data directory. Writes are atomic
 * (temp file + fsync + rename) so a crashed hook can never truncate a memory
 * file. Binary payloads (gzip snapshots, backups) go through writeBytes:
 * writing a gzip stream as UTF-8 text corrupts it, which is exactly the bug
 * this module exists to prevent.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function fsyncDir(dir) {
  // Best effort: fsync the directory so the rename itself survives a crash.
  // Windows does not allow opening a directory for fsync, hence the guard.
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* directory fsync is not supported on every platform */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function readText(p, fallback = '') {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return fallback;
  }
}

/** Read raw bytes; null when the file is missing or unreadable. */
export function readBytes(p) {
  try {
    const buf = fs.readFileSync(p);
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  } catch {
    return null;
  }
}

/** Atomic binary write: temp file, fsync, rename. Never writes text-mode. */
export function writeBytes(p, buffer) {
  ensureDir(path.dirname(p));
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, p);
    fsyncDir(path.dirname(p));
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function writeText(p, text) {
  writeBytes(p, Buffer.from(String(text), 'utf8'));
}

export function readJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(p, value) {
  writeText(p, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJSONL(p, value) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, `${JSON.stringify(value)}\n`, 'utf8');
}

export function writeJSONL(p, values) {
  writeText(p, values.map((v) => JSON.stringify(v)).join('\n') + (values.length ? '\n' : ''));
}

export function readJSONL(p) {
  const raw = readText(p, '');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed line, keep the rest readable */
    }
  }
  return out;
}

export function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

export function listFiles(dir, ext = null) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && (!ext || d.name.endsWith(ext)))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function removeFile(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export function statSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

export function nowISO() {
  return new Date().toISOString();
}

export function sha1(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

export function slugify(text, fallback = 'untitled') {
  const base = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || fallback;
}

export function isGzip(buffer) {
  return !!buffer && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/** Default location: a per-user Mnemon home, independent of the workspace. */
export function mnemonHome() {
  return path.join(os.homedir(), '.mnemon');
}

export function defaultDataDir() {
  return path.join(mnemonHome(), 'data');
}

/** Second drive (well, second directory tree) that mirrors the memory vault. */
export function defaultMirrorDir() {
  return path.join(os.homedir(), 'Documents', 'Antigravity-Memory-Backup');
}

export function registryPath() {
  return path.join(mnemonHome(), 'registry.json');
}

/**
 * Data directory resolution, shared by the MCP server and every hook so both
 * always read and write the same store:
 *   --data-dir <path>  >  --data-dir=<path>  >  MNEMON_DATA_DIR  >  registry  >  ~/.mnemon/data
 * The registry is written by the MCP server on startup, so hooks follow a
 * custom data directory configured for the server.
 */
export function resolveDataDir(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--data-dir');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const inline = argv.find((a) => a.startsWith('--data-dir='));
  if (inline) return path.resolve(inline.slice('--data-dir='.length));
  if (process.env.MNEMON_DATA_DIR) return path.resolve(process.env.MNEMON_DATA_DIR);
  const reg = readJSON(registryPath(), null);
  if (reg && typeof reg.dataDir === 'string' && exists(reg.dataDir)) return reg.dataDir;
  return defaultDataDir();
}

/**
 * Mirror directory resolution:
 *   --mirror-dir <path> > --mirror-dir=<path> > MNEMON_MIRROR_DIR > registry > ~/Documents/Antigravity-Memory-Backup
 */
export function resolveMirrorDir(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--mirror-dir');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const inline = argv.find((a) => a.startsWith('--mirror-dir='));
  if (inline) return path.resolve(inline.slice('--mirror-dir='.length));
  if (process.env.MNEMON_MIRROR_DIR) return path.resolve(process.env.MNEMON_MIRROR_DIR);
  const reg = readJSON(registryPath(), null);
  if (reg && typeof reg.mirrorDir === 'string' && reg.mirrorDir) return path.resolve(reg.mirrorDir);
  return defaultMirrorDir();
}

export function registerDataDir(dataDir, extra = {}) {
  try {
    ensureDir(mnemonHome());
    writeJSON(registryPath(), { dataDir, updatedAt: nowISO(), ...extra });
  } catch {
    /* registry is a convenience only; never fail a run because of it */
  }
}

/** True when a caller passed an explicit store location (flag or environment). */
export function hasExplicitStore(argv = process.argv.slice(2)) {
  const flag = argv.some(
    (a) => a === '--data-dir' || a.startsWith('--data-dir=') || a === '--mirror-dir' || a.startsWith('--mirror-dir='),
  );
  return flag || !!process.env.MNEMON_DATA_DIR || !!process.env.MNEMON_MIRROR_DIR;
}
