import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const COMPONENT_NAME = 'antigravity-remote-mogu';
export const UPDATE_MANIFEST_URL = 'https://github.com/mogudesu/antigravity-suite/releases/latest/download/latest.json';
export const UPDATE_PAGE_URL = 'https://github.com/mogudesu/antigravity-suite/releases/latest';
const MAX_ZIP_BYTES = 120 * 1024 * 1024;

export function useSystemProxy() {
  const noProxy = new Set(String(process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((item) => item.trim()).filter(Boolean));
  noProxy.add('127.0.0.1');
  noProxy.add('localhost');
  const applyNoProxy = () => {
    process.env.NO_PROXY = [...noProxy].join(',');
    process.env.no_proxy = process.env.NO_PROXY;
  };
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    process.env.NODE_USE_ENV_PROXY = '1';
    applyNoProxy();
    return;
  }
  if (process.platform !== 'win32') return;
  try {
    const reg = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8', timeout: 4000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(reg)) return;
    const raw = (reg.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i) || [])[1] || '';
    const server = raw.split(';').map((part) => part.trim()).find((part) => part && !part.includes('='))
      || raw.split(';').map((part) => part.trim()).find((part) => /^https?=/.test(part))?.split('=').pop()
      || '';
    if (!/^[\w.-]+:\d+$/.test(server)) return;
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTPS_PROXY = `http://${server}`;
    process.env.HTTP_PROXY = `http://${server}`;
    applyNoProxy();
  } catch {}
}

export function compareVersion(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function pickRemoteComponent(manifest) {
  const items = Array.isArray(manifest?.components) ? manifest.components : [];
  return items.find((item) => item?.name === COMPONENT_NAME) || null;
}

export function pluginsRoot() {
  return process.env.AG_PLUGINS_DIR || path.join(os.homedir(), '.gemini', 'config', 'plugins');
}

export function resolveInstalledDir() {
  const override = String(process.env.AG_REMOTE_PLUGIN_DIR || '').trim();
  if (override) return override;
  const root = pluginsRoot();
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
        if (pkg.name === COMPONENT_NAME) return dir;
      } catch {}
    }
  } catch {}
  return path.join(root, COMPONENT_NAME);
}

export function readInstalledVersion(dir = resolveInstalledDir()) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).version || '').replace(/^v/i, '');
  } catch {
    return '';
  }
}

function allowDownload(url, allowLocal) {
  try {
    const parsed = new URL(String(url));
    if (allowLocal && parsed.hostname === '127.0.0.1') return true;
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

async function fetchJson(url, fetchImpl, timeoutMs, allowLocal) {
  if (!allowDownload(url, allowLocal)) throw new Error('更新地址不在允许范围内');
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'antigravity-remote-mogu' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`更新源 HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('更新清单过大');
  return JSON.parse(text);
}

export async function checkForUpdate({
  manifestUrl = UPDATE_MANIFEST_URL,
  currentVersion,
  fetchImpl = fetch,
  timeoutMs = 12000,
  allowLocal = false,
} = {}) {
  const current = String(currentVersion || readInstalledVersion() || '0.0.0').replace(/^v/i, '');
  try {
    const manifest = await fetchJson(manifestUrl, fetchImpl, timeoutMs, allowLocal);
    const component = pickRemoteComponent(manifest);
    if (!component) throw new Error('更新清单里没有远程插件组件');
    const latest = String(component.version || '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('更新清单版本不合法');
    return {
      ok: true,
      current,
      latest,
      hasUpdate: compareVersion(latest, current) > 0,
      url: UPDATE_PAGE_URL,
      zipUrl: String(component.zipUrl || ''),
      sha256: String(component.sha256 || '').toLowerCase(),
      notes: String(manifest.notes || ''),
      checkedAt: Date.now(),
      error: '',
    };
  } catch (error) {
    return {
      ok: false,
      current,
      latest: '',
      hasUpdate: false,
      url: UPDATE_PAGE_URL,
      zipUrl: '',
      sha256: '',
      notes: '',
      checkedAt: Date.now(),
      error: error?.message || String(error),
    };
  }
}

function listZipEntries(zipPath) {
  if (process.platform === 'win32') {
    const safeZip = zipPath.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[System.IO.Compression.ZipFile]::OpenRead('${safeZip}'); try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }`;
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    }).split(/\r?\n/);
  }
  return execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/);
}

function assertArchiveSafe(zipPath) {
  let listing = [];
  try {
    listing = listZipEntries(zipPath);
  } catch {
    throw new Error('无法读取更新包目录');
  }
  for (const raw of listing) {
    const entry = raw.trim().replace(/\\/g, '/');
    if (!entry) continue;
    if (/^[A-Za-z]:/.test(entry) || entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error(`更新包包含不安全路径：${entry}`);
    }
  }
}

function extractZip(zipPath, destination) {
  if (process.platform === 'win32') {
    const safeZip = zipPath.replace(/'/g, "''");
    const safeDest = destination.replace(/'/g, "''");
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${safeZip}' -DestinationPath '${safeDest}' -Force`,
    ], { stdio: 'pipe', timeout: 180000 });
    return;
  }
  try {
    execFileSync('unzip', ['-q', zipPath, '-d', destination], { stdio: 'pipe' });
  } catch {
    execFileSync('tar', ['-xf', zipPath, '-C', destination], { stdio: 'pipe' });
  }
}

function assertNoSymlinks(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`更新包包含符号链接：${entry.name}`);
      if (entry.isDirectory()) stack.push(full);
    }
  }
}

function findPackageRoot(extractDir, expectedName) {
  const candidates = [extractDir];
  for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(extractDir, entry.name));
  }
  const found = candidates.find((dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).name === expectedName;
    } catch {
      return false;
    }
  });
  if (!found) throw new Error(`更新包缺少 ${expectedName} 的 plugin.json`);
  return found;
}

// Node 25 的 fs.cpSync 在非 ASCII 路径上会静默崩溃，改用 readdir/copyFile
function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

export async function applyUpdate({
  manifestUrl = UPDATE_MANIFEST_URL,
  currentVersion,
  installedDir = resolveInstalledDir(),
  fetchImpl = fetch,
  backupRoot = path.join(os.homedir(), '.gemini', 'memory', 'antigravity-remote-backups'),
  allowLocal = false,
  timeoutMs = 120000,
} = {}) {
  const info = await checkForUpdate({ manifestUrl, currentVersion, fetchImpl, timeoutMs: 15000, allowLocal });
  if (!info.ok) return { ok: false, updated: false, error: info.error, current: info.current, latest: info.latest };
  if (!info.hasUpdate) {
    return { ok: true, updated: false, current: info.current, latest: info.latest, message: '已是最新版本' };
  }
  if (!info.zipUrl || !/^[a-f0-9]{64}$/.test(info.sha256)) {
    return { ok: false, updated: false, error: '更新清单缺少 zip 地址或 SHA-256' };
  }
  if (!allowDownload(info.zipUrl, allowLocal)) {
    return { ok: false, updated: false, error: '更新包地址不在允许范围内' };
  }
  if (!fs.existsSync(path.join(installedDir, 'plugin.json'))) {
    return { ok: false, updated: false, error: `找不到已安装插件：${installedDir}` };
  }

  const buffer = await (async () => {
    const res = await fetchImpl(info.zipUrl, {
      redirect: 'follow',
      headers: { 'user-agent': 'antigravity-remote-mogu' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`下载更新包失败：HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_ZIP_BYTES) throw new Error('更新包超过 120MB');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_ZIP_BYTES) throw new Error('更新包超过 120MB');
    return data;
  })();

  const actualSha = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actualSha !== info.sha256) {
    return { ok: false, updated: false, error: `更新包校验失败（sha256 ${actualSha}）` };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-remote-update-'));
  const zipPath = path.join(tempRoot, 'update.zip');
  const extractDir = path.join(tempRoot, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  fs.writeFileSync(zipPath, buffer);
  try {
    assertArchiveSafe(zipPath);
    extractZip(zipPath, extractDir);
    assertNoSymlinks(extractDir);
    const source = findPackageRoot(extractDir, COMPONENT_NAME);
    const remotePkg = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json'), 'utf8'));
    if (remotePkg.name !== COMPONENT_NAME) throw new Error('更新包插件标识不一致');
    if (String(remotePkg.version || '').replace(/^v/i, '') !== info.latest) {
      throw new Error('更新包版本与更新清单不一致');
    }

    const fromVersion = readInstalledVersion(installedDir) || info.current;
    fs.mkdirSync(backupRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(backupRoot, `${COMPONENT_NAME}-${fromVersion}-${stamp}`);
    copyTree(installedDir, backup);
    copyTree(source, installedDir);

    return {
      ok: true,
      updated: true,
      from: fromVersion,
      to: info.latest,
      backup,
      notes: info.notes,
      restartRequired: true,
      message: `已更新到 v${info.latest}，正在重启远程服务`,
    };
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
}
