/**
 * 在 Antigravity 没运行时，按用户消息的需求把它拉起来。
 *
 * Windows 上直接 spawn Antigravity.exe 会静默退出（Electron 单实例/工作目录问题），
 * 必须交给 explorer.exe 代启动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { homeDir } from '../store/paths.mjs';

export function antigravityExeCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
  return [
    process.env.AG_EXE || '',
    path.join(local, 'Programs', 'antigravity', 'Antigravity.exe'),
    path.join(local, 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(local, 'Programs', 'Antigravity IDE', 'Antigravity.exe'),
    path.join(local, 'Programs', 'antigravity-ide', 'Antigravity.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'Antigravity.exe'),
  ].filter(Boolean);
}

export function findAntigravityExe() {
  for (const candidate of antigravityExeCandidates()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续找下一个 */
    }
  }
  return '';
}

export function isAntigravityRunning() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => resolve(!error && /Antigravity\.exe/i.test(String(stdout || ''))),
    );
  });
}

/** 返回 { ok, exe, reason }；进程拉起是异步的，调用方需要自己等 CDP。 */
export function launchAntigravity() {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' };
  const exe = findAntigravityExe();
  if (!exe) return { ok: false, reason: 'exe-not-found' };
  try {
    const child = spawn('explorer.exe', [exe], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, exe };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error), exe };
  }
}
