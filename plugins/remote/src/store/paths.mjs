/**
 * 路径解析：插件目录、Antigravity 数据目录、本插件的私有状态目录。
 *
 * 所有路径都允许用环境变量覆盖，方便测试与多开。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function env(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export function homeDir() {
  return env('USERPROFILE', env('HOME', os.homedir()));
}

/** Antigravity 的用户数据目录（DevToolsActivePort、brain、conversations 都在这里）。 */
export function antigravityDataDir() {
  const override = env('AG_DATA_DIR', '');
  if (override) return override;
  if (process.platform === 'win32') {
    return path.join(env('APPDATA', path.join(homeDir(), 'AppData', 'Roaming')), 'Antigravity');
  }
  if (process.platform === 'darwin') {
    return path.join(homeDir(), 'Library', 'Application Support', 'Antigravity');
  }
  return path.join(homeDir(), '.config', 'Antigravity');
}

/** 会话索引与 brain 目录所在位置（~/.gemini/antigravity）。 */
export function geminiDir() {
  return env('AG_GEMINI_DIR', path.join(homeDir(), '.gemini', 'antigravity'));
}

/** 本插件私有状态：凭据、机器人配置、日志。 */
export function remoteHome() {
  const dir = env('AG_REMOTE_HOME', path.join(homeDir(), '.gemini', 'memory', 'antigravity-remote'));
  return dir;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function paths() {
  const home = remoteHome();
  return {
    home,
    secrets: path.join(home, 'secrets.json'),
    state: path.join(home, 'state.json'),
    logs: path.join(home, 'logs'),
    tmp: path.join(home, 'tmp'),
    brain: path.join(geminiDir(), 'brain'),
    summariesDb: path.join(geminiDir(), 'conversation_summaries.db'),
    devtoolsPort: path.join(antigravityDataDir(), 'DevToolsActivePort'),
  };
}

export function ensureRuntimeDirs() {
  const p = paths();
  ensureDir(p.home);
  ensureDir(p.logs);
  ensureDir(p.tmp);
  return p;
}
