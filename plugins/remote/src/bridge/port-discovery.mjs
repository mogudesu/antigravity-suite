/**
 * 自动发现 Antigravity 的 CDP 端口。
 *
 * Antigravity 每次启动都会把当前调试端口写进 <AppData>/Antigravity/DevToolsActivePort，
 * 第一行是端口，第二行是 browser 的 ws path。不需要用户手动开端口、也不需要 .env。
 *
 * 注意：DevToolsActivePort 不会在退出时删除，开机/重启后文件里很可能是上一次的旧端口。
 * 所以「有端口文件」不等于「端口活着」，必须探活后再判断。
 */
import fs from 'node:fs';
import { paths } from '../store/paths.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** 端口是否真的在监听（Electron 的 CDP 版本接口，不建 WS）。 */
export async function probeBrowser(port, { timeoutMs = 1500 } = {}) {
  if (!port) return false;
  const info = await fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs);
  return Boolean(info && info.webSocketDebuggerUrl);
}

function pickWorkbench(pages) {
  const local = pages.find((item) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(item.url || ''));
  if (local) return local;
  const titled = pages.find((item) => /Antigravity/i.test(item.title || ''));
  if (titled) return titled;
  // 启动早期可能出现 data:/file:/about: 这类占位页，连上去也操作不了工作台
  return pages.find((item) => !/^(data|file|about|chrome-extension|devtools):/i.test(item.url || '')) || null;
}

/**
 * 找到 Antigravity 工作台页面（不是 devtools、不是插件 iframe）。
 * 返回结构化原因：browser-down（端口没活）/ no-workbench-page（活着但还没有可用页面）。
 */
export async function findWorkbenchTargetDetailed(port) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(list)) return { ok: false, reason: 'browser-down' };
  const pages = list.filter(
    (item) => item.type === 'page' && item.webSocketDebuggerUrl && !String(item.url || '').startsWith('devtools://'),
  );
  const target = pickWorkbench(pages);
  if (!target) return { ok: false, reason: 'no-workbench-page' };
  return {
    ok: true,
    target: {
      id: target.id,
      title: target.title || '',
      url: target.url || '',
      wsUrl: target.webSocketDebuggerUrl,
    },
  };
}

/** 兼容旧调用：拿到页面目标或 null。 */
export async function findWorkbenchTarget(port) {
  const found = await findWorkbenchTargetDetailed(port);
  return found.ok ? found.target : null;
}

/**
 * 端口 + 目标页一起拿。
 * waitMs > 0 时轮询等待：开机时 Antigravity 可能是「先写端口文件、后建窗口」，
 * 或者干脆还没启动；这时应该等而不是立刻报错。
 */
export async function discoverWorkbench({ portFile, waitMs = 0, intervalMs = 400 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const info = readDevToolsPort(portFile);
    if (!info) {
      if (Date.now() >= deadline) return { ok: false, reason: 'no-port-file' };
      await sleep(intervalMs);
      continue;
    }
    const found = await findWorkbenchTargetDetailed(info.port);
    if (found.ok) return { ok: true, port: info.port, target: found.target };
    if (Date.now() >= deadline) return { ok: false, reason: found.reason, port: info.port };
    await sleep(intervalMs);
  }
}
