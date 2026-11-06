/**
 * 自动发现 Antigravity 的 CDP 端口。
 *
 * Antigravity 每次启动都会把当前调试端口写进 <AppData>/Antigravity/DevToolsActivePort，
 * 第一行是端口，第二行是 browser 的 ws path。不需要用户手动开端口、也不需要 .env。
 */
import fs from 'node:fs';
import { paths } from '../store/paths.mjs';

export function readDevToolsPort(file = paths().devtoolsPort) {
  try {
    const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim());
    const port = Number.parseInt(raw[0] || '', 10);
    if (!Number.isFinite(port) || port <= 0) return null;
    return { port, browserPath: raw[1] || '', file };
  } catch {
    return null;
  }
}

async function fetchJson(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 找到 Antigravity 工作台页面（不是 devtools、不是插件 iframe）。 */
export async function findWorkbenchTarget(port) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(list)) return null;
  const pages = list.filter((item) => item.type === 'page' && !String(item.url || '').startsWith('devtools://'));
  const local = pages.find((item) => /^https?:\/\/127\.0\.0\.1/.test(item.url || ''));
  const titled = pages.find((item) => /Antigravity/i.test(item.title || ''));
  const target = local || titled || pages[0];
  if (!target || !target.webSocketDebuggerUrl) return null;
  return {
    id: target.id,
    title: target.title || '',
    url: target.url || '',
    wsUrl: target.webSocketDebuggerUrl,
  };
}

/** 端口 + 目标页一起拿。端口文件可能刚被重写，读不到就返回 null。 */
export async function discoverWorkbench({ portFile } = {}) {
  const info = readDevToolsPort(portFile);
  if (!info) return { ok: false, reason: 'no-port-file' };
  const target = await findWorkbenchTarget(info.port);
  if (!target) return { ok: false, reason: 'no-workbench-page', port: info.port };
  return { ok: true, port: info.port, target };
}
