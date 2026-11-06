import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { compareVersion, pickRemoteComponent, checkForUpdate, applyUpdate } from '../src/update/updater.mjs';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function makeZip(sourceDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  if (process.platform === 'win32') {
    const script = `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'pipe' });
    return;
  }
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceDir, stdio: 'pipe' });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('compareVersion handles 0.x', () => {
  assert.ok(compareVersion('0.1.1', '0.1.0') > 0);
  assert.ok(compareVersion('0.2.0', '0.1.9') > 0);
  assert.equal(compareVersion('0.1.0', 'v0.1.0'), 0);
  assert.ok(compareVersion('0.1.0', '0.1.1') < 0);
});

test('pickRemoteComponent finds only the remote entry', () => {
  const manifest = { components: [
    { name: 'mnemon', version: '1.0.2' },
    { name: 'antigravity-remote-mogu', version: '0.1.1' },
  ] };
  assert.equal(pickRemoteComponent(manifest)?.version, '0.1.1');
  assert.equal(pickRemoteComponent({ components: [] }), null);
});

test('checkForUpdate reads the remote component version', async () => {
  const manifest = {
    notes: 'suite notes',
    components: [{ name: 'antigravity-remote-mogu', version: '0.1.1', zipUrl: 'https://github.com/o/r/releases/download/v1/a.zip', sha256: 'a'.repeat(64) }],
  };
  const fakeFetch = async () => new Response(JSON.stringify(manifest), { status: 200 });
  const info = await checkForUpdate({ currentVersion: '0.1.0', fetchImpl: fakeFetch });
  assert.equal(info.ok, true);
  assert.equal(info.latest, '0.1.1');
  assert.equal(info.hasUpdate, true);
  const same = await checkForUpdate({ currentVersion: '0.1.1', fetchImpl: fakeFetch });
  assert.equal(same.hasUpdate, false);
  const missing = await checkForUpdate({
    currentVersion: '0.1.0',
    fetchImpl: async () => new Response(JSON.stringify({ components: [] }), { status: 200 }),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /没有远程插件组件/);
});

test('applyUpdate downloads, verifies, backs up and replaces files', async () => {
  const root = tmpDir('ag-remote-update-test-');
  const installed = path.join(root, 'installed');
  const pkg = path.join(root, 'pkg');
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  writeJson(path.join(installed, 'plugin.json'), { name: 'antigravity-remote-mogu', version: '0.1.0' });
  fs.mkdirSync(path.join(installed, 'src'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'src', 'marker-old.txt'), 'old');
  writeJson(path.join(pkg, 'plugin.json'), { name: 'antigravity-remote-mogu', version: '0.1.1' });
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'src', 'marker-new.txt'), 'new');
  const zipPath = path.join(dist, 'pkg.zip');
  makeZip(pkg, zipPath);
  const digest = sha256(zipPath);
  const manifest = {
    notes: 'test release',
    components: [{ name: 'antigravity-remote-mogu', version: '0.1.1', zipUrl: '', sha256: digest }],
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/latest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (req.url === '/pkg.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(zipPath).size });
      res.end(fs.readFileSync(zipPath));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  manifest.components[0].zipUrl = `http://127.0.0.1:${port}/pkg.zip`;

  try {
    const backupRoot = path.join(root, 'backups');
    const result = await applyUpdate({
      currentVersion: '0.1.0',
      installedDir: installed,
      manifestUrl: `http://127.0.0.1:${port}/latest.json`,
      allowLocal: true,
      backupRoot,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.updated, true);
    assert.equal(result.from, '0.1.0');
    assert.equal(result.to, '0.1.1');
    const pkgNow = JSON.parse(fs.readFileSync(path.join(installed, 'plugin.json'), 'utf8'));
    assert.equal(pkgNow.version, '0.1.1');
    assert.equal(fs.readFileSync(path.join(installed, 'src', 'marker-new.txt'), 'utf8'), 'new');
    assert.ok(fs.existsSync(result.backup));
    const oldPkg = JSON.parse(fs.readFileSync(path.join(result.backup, 'plugin.json'), 'utf8'));
    assert.equal(oldPkg.version, '0.1.0');
    assert.equal(fs.readFileSync(path.join(result.backup, 'src', 'marker-old.txt'), 'utf8'), 'old');

    const noop = await applyUpdate({
      currentVersion: '0.1.1',
      installedDir: installed,
      manifestUrl: `http://127.0.0.1:${port}/latest.json`,
      allowLocal: true,
      backupRoot,
    });
    assert.equal(noop.updated, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
