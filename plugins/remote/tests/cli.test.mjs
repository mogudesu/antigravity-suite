import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('update CLI reads the installed version and suite manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-remote-cli-test-'));
  const installed = path.join(root, 'installed');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'plugin.json'), JSON.stringify({ name: 'antigravity-remote-mogu', version: '0.1.0' }));
  const manifest = {
    notes: 'test',
    components: [{ name: 'antigravity-remote-mogu', version: '0.1.1', zipUrl: 'https://github.com/o/r/a.zip', sha256: 'a'.repeat(64) }],
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(manifest));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.resolve('src/update/cli.mjs'), 'check'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        AG_REMOTE_PLUGIN_DIR: installed,
        AG_REMOTE_UPDATE_MANIFEST: `http://127.0.0.1:${port}/latest.json`,
        AG_REMOTE_UPDATE_ALLOW_LOCAL: '1',
        NO_PROXY: '127.0.0.1,localhost',
      },
      timeout: 60000,
    });
    const info = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    assert.equal(info.ok, true, info.error);
    assert.equal(info.current, '0.1.0');
    assert.equal(info.latest, '0.1.1');
    assert.equal(info.hasUpdate, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
