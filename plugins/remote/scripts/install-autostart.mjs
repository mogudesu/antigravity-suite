#!/usr/bin/env node
/**
 * 开机自启：在 Windows「启动」目录里放一个快捷方式，登录后自动拉起守护进程。
 *
 *   node scripts/install-autostart.mjs             # 安装
 *   node scripts/install-autostart.mjs --uninstall # 卸载
 *
 * 为什么要这一步：Antigravity 的 SessionStart 钩子在某些情况下不会触发（比如只是重启客户端），
 * 而面板注入是 hub 常驻在做。只要 hub 在跑，Antigravity 每次启动/换端口后 6 秒内面板就会自己回来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveInstalledDir } from '../src/update/updater.mjs';
import { paths } from '../src/store/paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 优先指向已安装的插件目录：仓库改了要先 sync，否则自启会一直跑旧代码
const installed = resolveInstalledDir();
const PLUGIN_ROOT = fs.existsSync(path.join(installed, 'plugin.json')) ? installed : ROOT;
const HUB = path.join(PLUGIN_ROOT, 'src', 'index.mjs');
const LOG_FILE = path.join(paths().logs, 'hub.log');
const uninstall = process.argv.includes('--uninstall');

if (process.platform !== 'win32') {
  console.log('这个脚本只处理 Windows 启动项；其它系统请用 systemd / launchd。');
  process.exit(0);
}

const startupDir = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
);
const shortcut = path.join(startupDir, 'antigravity-remote-mogu.lnk');

if (uninstall) {
  if (fs.existsSync(shortcut)) {
    fs.unlinkSync(shortcut);
    console.log('已移除开机自启：', shortcut);
  } else {
    console.log('没有找到自启项，无需移除');
  }
  process.exit(0);
}

const nodeExe = process.execPath;
if (!fs.existsSync(HUB)) {
  console.error('找不到入口文件：', HUB);
  process.exit(1);
}
fs.mkdirSync(startupDir, { recursive: true });
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

// 用 cmd 重定向日志：没有控制台输出缓冲，就不会因为误点控制台（QuickEdit）把整个 hub 冻住
const cmdExe = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const cmdArgs = `/c ""${nodeExe}" "${HUB}" >> "${LOG_FILE}" 2>&1"`;

const ps = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${shortcut.replace(/'/g, "''")}')
$sc.TargetPath = '${cmdExe.replace(/'/g, "''")}'
$sc.Arguments = '${cmdArgs.replace(/'/g, "''")}'
$sc.WorkingDirectory = '${PLUGIN_ROOT.replace(/'/g, "''")}'
$sc.WindowStyle = 7
$sc.Description = 'antigravity远程-mogu 守护进程'
$sc.Save()
`;

try {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
  console.log('✅ 已创建开机自启：', shortcut);
  console.log('   目标：', nodeExe, HUB);
  console.log('   日志：', LOG_FILE);
  console.log('   取消：node scripts/install-autostart.mjs --uninstall');
} catch (error) {
  console.error('创建快捷方式失败：', error?.message || error);
  process.exit(1);
}
