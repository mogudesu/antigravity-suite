import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const NODE = process.execPath;
const ROOT = path.resolve(import.meta.dirname, '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

async function waitHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('守护进程没起来');
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('守护进程 API：健康检查 / 机器人 CRUD / 脱敏 / 校验', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-api-'));
  const child = spawn(NODE, [path.join(ROOT, 'src', 'index.mjs')], {
    env: { ...process.env, AG_REMOTE_PORT: String(PORT), AG_REMOTE_HOME: home },
    stdio: 'ignore',
    cwd: ROOT,
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  });

  const health = await waitHealth();
  assert.equal(health.ok, true);
  assert.equal(health.version, PKG_VERSION);
  assert.ok(Array.isArray(health.bots));

  // 新建机器人（凭据会被脱敏返回）
  const created = await api('/api/bots', {
    method: 'POST',
    body: { platform: 'feishu', alias: '测试飞书', secrets: { appId: 'cli_abc123', appSecret: 'verysecretvalue' } },
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.bot.alias, '测试飞书');
  assert.equal(created.data.bot.secrets.appId, 'cli_abc123');
  assert.equal(created.data.bot.secrets.appSecret, 'ver***lue', '返回必须脱敏');

  const list = await api('/api/bots');
  assert.equal(list.data.bots.length, 1);
  assert.equal(list.data.bots[0].secrets.appSecret, 'ver***lue');

  // 凭据文件确实落盘在临时 home 下
  const secretsFile = path.join(home, 'secrets.json');
  assert.ok(fs.existsSync(secretsFile));
  const raw = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
  const stored = Object.values(raw)[0];
  assert.equal(stored.appSecret, 'verysecretvalue', '落盘的是明文（本机私有目录）');

  // 校验接口：假凭据应返回 ok:false 而不是 500
  const verify = await api('/api/verify', {
    method: 'POST',
    body: { platform: 'feishu', secrets: { appId: 'bad', appSecret: 'bad' } },
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.data.ok, false);

  // 不支持的平台
  const bad = await api('/api/scan', { method: 'POST', body: { platform: 'telegram' } });
  assert.equal(bad.status, 400);

  // 扫码会话：撤销未知会话不报错，查询未知会话 404（面板切平台会用到 DELETE）
  const cancelled = await api('/api/scan/not-exist-id', { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.cancelled, false);
  const missing = await api('/api/scan/not-exist-id');
  assert.equal(missing.status, 404);

  // 会话索引可读
  const convs = await api('/api/conversations?limit=3');
  assert.equal(convs.data.ok, true);
  assert.ok(Array.isArray(convs.data.items));

  // 删除
  const botId = created.data.bot.id;
  const removed = await api(`/api/bots/${botId}`, { method: 'DELETE' });
  assert.equal(removed.data.ok, true);
  const after = await api('/api/bots');
  assert.equal(after.data.bots.length, 0);

  // 临时目录可能被子进程短暂占用，清理失败不影响结论
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
