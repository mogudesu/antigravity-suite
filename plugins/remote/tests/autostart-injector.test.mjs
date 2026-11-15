import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SettingsInjector } from '../src/ui/settings-injector.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('SettingsInjector.ensure skips full script injection when already active or dialog closed', async () => {
  const calls = [];
  let pageHasAgb = false;
  let dialogOpen = false;
  let injected = false;
  const fakeClient = {
    async evaluate(expr) {
      calls.push(expr);
      if (expr.includes('window.__AGB_URL__ ===')) {
        if (!pageHasAgb) return null;
        if (!dialogOpen || injected) return { ok: true, reused: true, dialog: dialogOpen, injected };
        return null;
      }
      if (expr.startsWith('window.__AGB_DISABLED__ = false')) return false;
      pageHasAgb = true;
      injected = dialogOpen;
      return { ok: true, dialog: dialogOpen, injected };
    },
  };
  const injector = new SettingsInjector({
    workbench: { ensure: async () => fakeClient },
    panelUrl: 'http://127.0.0.1:18791/ui/panel.html',
  });

  const first = await injector.ensure();
  assert.equal(first.ok, true);
  assert.equal(calls.length, 2); // probe(null) + full buildScript

  calls.length = 0;
  const second = await injector.ensure();
  assert.equal(second.reused, true);
  assert.equal(calls.length, 1); // probe only, no buildScript

  dialogOpen = true;
  injected = false;
  calls.length = 0;
  const whenDialogNeedsInject = await injector.ensure();
  assert.equal(whenDialogNeedsInject.injected, true);
  assert.equal(calls.length, 2); // probe(null) + full buildScript

  calls.length = 0;
  const reusedOpen = await injector.ensure();
  assert.equal(reusedOpen.reused, true);
  assert.equal(calls.length, 1);
});

test('autostart-hook emits valid {} on stdout, logs to stderr, and reuses running hub', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'autostart-hook.mjs')], {
        env: { ...process.env, AG_REMOTE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {});
    assert.match(result.stderr, /直接复用/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
