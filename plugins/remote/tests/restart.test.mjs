import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('restart helper waits for the old hub, then starts the new one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-remote-restart-test-'));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const pidFile = path.join(root, 'stub.pid');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.mjs'), `
import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.env.AG_REMOTE_PORT);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, stub: true }));
});
server.listen(port, '127.0.0.1');
setTimeout(() => process.exit(0), 8000).unref();
`);

  let oldServer;
  let helper;
  let stubPid = 0;
  try {
    oldServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, old: true }));
    });
    await new Promise((resolve) => oldServer.listen(port, '127.0.0.1', resolve));

    helper = spawn(process.execPath, [
      path.resolve('src/update/restart-hub.mjs'),
      root,
      String(port),
      path.join(root, 'hub.log'),
    ], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await new Promise((resolve) => oldServer.close(resolve));

    let online = null;
    for (let i = 0; i < 30; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
        const data = await res.json();
        if (data.stub) { online = data; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    assert.ok(online, 'new hub did not come up');
    stubPid = Number(fs.readFileSync(pidFile, 'utf8')) || 0;
  } finally {
    if (stubPid) {
      try { process.kill(stubPid); } catch {}
    }
    try { helper?.kill(); } catch {}
    try { oldServer?.close(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 600));
    for (let i = 0; i < 6; i += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
});
