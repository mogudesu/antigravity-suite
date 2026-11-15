import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { discoverWorkbench, findWorkbenchTargetDetailed, probeBrowser } from '../src/bridge/port-discovery.mjs';
import { Workbench } from '../src/bridge/cdp-executor.mjs';

function tempPortFile(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-port-'));
  const file = path.join(dir, 'DevToolsActivePort');
  fs.writeFileSync(file, `${port}\n/devtools/browser/fake\n`);
  return file;
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function jsonResponse(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const PAGE = (url = 'https://127.0.0.1:60829/', title = 'Antigravity') => ({
  id: 'PAGE1',
  type: 'page',
  title,
  url,
  webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/PAGE1',
});

test('没有端口文件时报 no-port-file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-port-'));
  const found = await discoverWorkbench({ portFile: path.join(dir, 'DevToolsActivePort'), waitMs: 0 });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'no-port-file');
});

test('端口文件是旧的（端口没监听）时报 browser-down，而不是「端口在」', async () => {
  const server = await listen((req, res) => jsonResponse(res, []));
  const port = server.port;
  await server.close();
  const found = await discoverWorkbench({ portFile: tempPortFile(port), waitMs: 0 });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'browser-down');
  assert.equal(found.port, port);
});

test('优先选 127.0.0.1 的工作台页，忽略 data: 占位页', async () => {
  const server = await listen((req, res) => {
    if (req.url === '/json/list') {
      return jsonResponse(res, [
        { id: 'DATA', type: 'page', title: 'data', url: 'data:text/html,<p>x', webSocketDebuggerUrl: 'ws://x' },
        PAGE(),
        { id: 'IFRAME', type: 'iframe', url: 'plugin://x', webSocketDebuggerUrl: 'ws://y' },
      ]);
    }
    if (req.url === '/json/version') return jsonResponse(res, { webSocketDebuggerUrl: 'ws://browser' });
    res.writeHead(404);
    return res.end();
  });
  const file = tempPortFile(server.port);
  assert.equal(await probeBrowser(server.port), true);
  const found = await discoverWorkbench({ portFile: file, waitMs: 0 });
  assert.equal(found.ok, true);
  assert.equal(found.target.id, 'PAGE1');
  assert.equal(found.target.wsUrl, PAGE().webSocketDebuggerUrl);
  await server.close();
});

test('浏览器在但没有可用页面时报 no-workbench-page', async () => {
  const server = await listen((req, res) => jsonResponse(res, []));
  const found = await discoverWorkbench({ portFile: tempPortFile(server.port), waitMs: 0 });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'no-workbench-page');
  await server.close();
});

test('waitMs 会等待启动期出现的页面', async () => {
  let ready = false;
  setTimeout(() => {
    ready = true;
  }, 600);
  const server = await listen((req, res) => jsonResponse(res, ready ? [PAGE()] : []));
  const started = Date.now();
  const found = await discoverWorkbench({ portFile: tempPortFile(server.port), waitMs: 4000 });
  assert.equal(found.ok, true);
  assert.equal(found.target.id, 'PAGE1');
  assert.ok(Date.now() - started >= 300);
  await server.close();
});

test('Workbench.ensure 对旧端口文件给出可执行的错误，而不是「端口在」', async () => {
  const server = await listen((req, res) => jsonResponse(res, []));
  const port = server.port;
  await server.close();
  const workbench = new Workbench({
    portFile: tempPortFile(port),
    autoLaunch: false,
    logger: { info() {}, warn() {} },
  });
  await assert.rejects(() => workbench.ensure(), /没有响应|旧文件/);
});

test('findWorkbenchTargetDetailed 区分端口没活和没有页面', async () => {
  const down = await findWorkbenchTargetDetailed(1);
  assert.equal(down.reason, 'browser-down');
  const server = await listen((req, res) => jsonResponse(res, []));
  const empty = await findWorkbenchTargetDetailed(server.port);
  assert.equal(empty.reason, 'no-workbench-page');
  await server.close();
});
