#!/usr/bin/env node
/**
 * 一键安装：同步到插件目录 → 装运行时依赖 → 打印后续步骤。
 *
 *   node scripts/install-plugin.mjs            # 复制安装
 *   node scripts/install-plugin.mjs --link     # 目录联接（开发时改仓库即生效）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-remote-mogu');
const link = process.argv.includes('--link');

console.log('== 1/3 同步插件 ==');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-plugin.mjs'), ...(link ? ['--link'] : [])], {
  stdio: 'inherit',
  cwd: ROOT,
});

if (!link) {
  console.log('\n== 2/3 安装运行时依赖 ==');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    // Windows 上 npm 是 .cmd，必须走 shell，否则 spawnSync EINVAL
    execFileSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], { stdio: 'inherit', cwd: TARGET, shell: true });
  } catch (error) {
    console.error('依赖安装失败，请在插件目录手动执行 npm install --omit=dev');
    console.error(error?.message || error);
    process.exitCode = 1;
  }
} else {
  console.log('\n== 2/3 目录联接模式，依赖直接用仓库里的 node_modules ==');
}

console.log('\n== 3/3 完成 ==');
console.log(`插件目录：${TARGET}`);
console.log('接下来：');
console.log('  1) 重启 Antigravity（或让它重载插件）');
console.log('  2) 设置 → antigravity远程-mogu，或侧栏面板');
console.log('  3) 微信扫码 / QQ 扫码 / 飞书填凭据');
if (!fs.existsSync(path.join(TARGET, 'plugin.json'))) {
  console.error('⚠️ 目标目录里没有 plugin.json，同步可能失败了');
  process.exitCode = 1;
}
