#!/usr/bin/env node
/**
 * 把仓库同步到 Antigravity 插件目录（~/.gemini/config/plugins/antigravity-remote-mogu）。
 *
 *   node scripts/sync-plugin.mjs            # 复制
 *   node scripts/sync-plugin.mjs --dry      # 只看要做什么
 *   node scripts/sync-plugin.mjs --link     # 用目录联接（开发时改仓库即生效）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-remote-mogu');
const SKIP = new Set(['node_modules', '.git', 'legacy-python', 'docs', '.pytest_cache', 'dist']);

const args = new Set(process.argv.slice(2));
const dry = args.has('--dry');
const link = args.has('--link');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

console.log(`源目录：${ROOT}`);
console.log(`插件目录：${TARGET}`);

if (dry) {
  console.log('（dry-run，不做任何修改）');
  process.exit(0);
}

if (link) {
  const existing = fs.lstatSync(TARGET, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    // 目录联接只能用 rmdir 删链接本身；递归删除会误删源仓库内容
    execFileSync('cmd', ['/c', 'rmdir', TARGET], { stdio: 'inherit' });
  } else if (existing) {
    console.log('目标已存在，先移除旧的副本：', TARGET);
    fs.rmSync(TARGET, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', TARGET, ROOT], { stdio: 'inherit' });
    console.log('✅ 已创建目录联接（改仓库即生效）');
    console.warn('⚠️ Antigravity 的插件列表只扫描真实目录，目录联接会被跳过；');
    console.warn('   需要插件出现在「自定义配置 → 已安装」时，请改用默认复制模式。');
  } catch (error) {
    console.error('目录联接失败，请以管理员身份运行，或改用普通同步：', error?.message);
    process.exit(1);
  }
} else {
  const existing = fs.lstatSync(TARGET, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    // 复制模式不能写穿目录联接，否则会改到源仓库；先删联接再建真实目录
    execFileSync('cmd', ['/c', 'rmdir', TARGET], { stdio: 'inherit' });
    console.log('已移除旧的目录联接，改为真实目录副本（插件列表可见）');
  }
  copyDir(ROOT, TARGET);
  console.log('✅ 已同步（不含 node_modules，插件目录内需 npm install --omit=dev）');
}

console.log('\n下一步：');
console.log('  1) 在插件目录执行 npm install --omit=dev');
console.log('  2) 重启 Antigravity（或让它重载插件）');
console.log('  3) 打开 设置 → antigravity远程-mogu');
