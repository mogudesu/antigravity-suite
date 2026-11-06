#!/usr/bin/env node
/**
 * SessionStart 钩子：确保守护进程在线，并把面板注入 Antigravity 设置页。
 *
 * 钩子有时限（35s），所以：拉起进程不等待、注入失败只记日志，绝不阻塞会话启动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/store/paths.mjs';
import { readDevToolsPort } from '../src/bridge/port-discovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB_ENTRY = path.join(ROOT, 'src', 'index.mjs');
const PORT = Number(process.env.AG_REMOTE_PORT || 8791);
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;

async function hubAlive() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(HEALTH, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function startHub() {
  const logDir = paths().logs;
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'hub.log'), 'a');
  const child = spawn(process.execPath, [HUB_ENTRY], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, AG_REMOTE_PORT: String(PORT) },
    cwd: ROOT,
  });
  child.unref();
  return child.pid;
}

async function main() {
  const port = readDevToolsPort();
  if (!port) {
    console.error('[antigravity-remote-mogu] 没读到 DevToolsActivePort：Antigravity 可能还没启动完成');
  }
  if (!(await hubAlive())) {
    const pid = startHub();
    console.log(`[antigravity-remote-mogu] 守护进程已拉起（pid=${pid}）`);
    // 给进程一点时间起 HTTP
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await hubAlive()) break;
    }
  } else {
    console.log('[antigravity-remote-mogu] 守护进程已在运行');
  }

  // 注入设置页（失败不影响会话）
  try {
    const { SettingsInjector } = await import('../src/ui/settings-injector.mjs');
    const injector = new SettingsInjector({ panelUrl: `http://127.0.0.1:${PORT}/ui/panel.html` });
    const result = await injector.ensure();
    console.log('[antigravity-remote-mogu] 设置页注入：', JSON.stringify(result));
  } catch (error) {
    console.error('[antigravity-remote-mogu] 设置页注入失败：', error?.message || error);
  }
}

main().catch((error) => {
  console.error('[antigravity-remote-mogu] 钩子异常：', error?.message || error);
  process.exit(0); // 钩子失败不能挡住会话
});
