#!/usr/bin/env node
/**
 * 更新后的重启助手：等旧 hub 退出，再从插件目录拉起新 hub。
 * 由 /api/update/apply 以 detached 方式启动，不能依赖旧进程存活。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = process.argv[2];
const port = String(process.argv[3] || process.env.AG_REMOTE_PORT || 8791);
const logFile = process.argv[4] || path.join(os.homedir(), '.gemini', 'memory', 'antigravity-remote', 'logs', 'hub.log');

async function alive() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!dir || !fs.existsSync(path.join(dir, 'src', 'index.mjs'))) {
    process.exitCode = 1;
    return;
  }
  for (let i = 0; i < 80; i += 1) {
    if (!(await alive())) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (await alive()) {
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(dir, 'src', 'index.mjs')], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: dir,
    env: { ...process.env, AG_REMOTE_PORT: port },
  });
  child.unref();
  fs.closeSync(out);
  for (let i = 0; i < 60; i += 1) {
    if (await alive()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.exitCode = 1;
}

main().catch(() => {
  process.exitCode = 1;
});
