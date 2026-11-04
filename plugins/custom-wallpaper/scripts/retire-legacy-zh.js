#!/usr/bin/env node
/**
 * Antigravity 星夜主题引擎 v3.0 · Module 2
 * retire-legacy-zh.js — safely retire the external Chinese translation plugin
 * (`antigravity2.0-ChinesePlugin` / `injector_zh.py`).
 *
 * Safety contract
 * - Only processes whose command line contains one of the legacy needles are
 *   ever targeted. Everything else is listed in `processes.scanned` but never
 *   touched.
 * - Dry-run is the default. `--apply` is required to stop processes / move the
 *   startup shortcut. Nothing is deleted: the shortcut is renamed to
 *   `AntigravityChinesePlugin.lnk.retired`, the project folder is preserved.
 * - Graceful first: `taskkill /PID <pid> /T` (no /F), then a forced kill only if
 *   the process is still alive after the grace period.
 * - Always prints a single JSON status object.
 *
 * CLI
 *   node scripts/retire-legacy-zh.js                 # dry-run (default, safe)
 *   node scripts/retire-legacy-zh.js --apply         # stop processes + archive shortcut
 *   node scripts/retire-legacy-zh.js --pretty
 *   node scripts/retire-legacy-zh.js --no-shortcut --apply
 *   node scripts/retire-legacy-zh.js --grace=5000
 *
 * Library
 *   const { retireLegacyChinesePlugin, findLegacyProcesses, moveStartupShortcut,
 *           isLegacyCommand, DEFAULT_PATHS } = require('./retire-legacy-zh');
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = '3.0.0';

const DEFAULT_PATHS = {
  startupShortcut: path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AntigravityChinesePlugin.lnk'
  ),
  legacyProjectDir: 'C:\\Users\\25350\\.gemini\\antigravity\\scratch\\antigravity2.0-ChinesePlugin',
  retiredShortcut: 'C:\\Users\\25350\\.gemini\\antigravity\\scratch\\antigravity2.0-ChinesePlugin\\AntigravityChinesePlugin.lnk.retired',
  needles: ['antigravity2.0-ChinesePlugin', 'injector_zh.py'],
  graceMs: 3000
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (error) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin as last resort */ }
  }
}

function powershell(script, timeout) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', script
  ];
  const out = execFileSync('powershell.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeout || 25000,
    maxBuffer: 32 * 1024 * 1024
  });
  return String(out).replace(/^\uFEFF/, '');
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// process discovery
// ---------------------------------------------------------------------------

function isLegacyCommand(commandLine, needles) {
  if (!commandLine) return null;
  const haystack = String(commandLine).toLowerCase();
  const list = needles || DEFAULT_PATHS.needles;
  for (let i = 0; i < list.length; i += 1) {
    const needle = String(list[i]).toLowerCase();
    if (needle && haystack.includes(needle)) return list[i];
  }
  return null;
}

function scanProcesses() {
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$ErrorActionPreference="Stop";',
    'try { $p = Get-CimInstance Win32_Process } catch { $p = Get-WmiObject Win32_Process };',
    '$p | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
  ].join(' ');
  const raw = powershell(script).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function findLegacyProcesses(options) {
  const opts = Object.assign({}, DEFAULT_PATHS, options || {});
  const all = scanProcesses();
  const selfPids = new Set([process.pid, process.ppid]);
  const matched = [];

  for (const proc of all) {
    const pid = Number(proc.ProcessId);
    const cmd = proc.CommandLine || '';
    if (!pid) continue;
    if (selfPids.has(pid)) continue;
    // Never target the retirer itself or its own CLI invocation.
    if (/retire-legacy-zh/i.test(cmd)) continue;
    const hit = isLegacyCommand(cmd, opts.needles);
    if (!hit) continue;
    matched.push({
      pid: pid,
      parentPid: Number(proc.ParentProcessId) || null,
      name: proc.Name || null,
      matchedBy: hit,
      commandLine: cmd.length > 600 ? cmd.slice(0, 600) + '…' : cmd
    });
  }

  return { scanned: all.length, matched };
}

// ---------------------------------------------------------------------------
// process termination (graceful first)
// ---------------------------------------------------------------------------

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function taskkill(pid, force) {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  try {
    execFileSync('taskkill', args, { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    return true;
  } catch (error) {
    return false;
  }
}

function stopProcess(pid, graceMs) {
  const result = {
    pid,
    gracefulRequested: taskkill(pid, false),
    graceful: false,
    forced: false,
    stopped: false
  };

  const deadline = Date.now() + Math.max(0, graceMs || 0);
  while (Date.now() <= deadline) {
    if (!isAlive(pid)) {
      result.graceful = true;
      result.stopped = true;
      return result;
    }
    sleepSync(120);
  }

  if (isAlive(pid)) {
    result.forced = taskkill(pid, true);
    const forcedDeadline = Date.now() + 1500;
    while (Date.now() <= forcedDeadline) {
      if (!isAlive(pid)) break;
      sleepSync(100);
    }
  }

  result.stopped = !isAlive(pid);
  return result;
}

// ---------------------------------------------------------------------------
// startup shortcut
// ---------------------------------------------------------------------------

function inspectShortcut(shortcutPath) {
  const info = { path: shortcutPath, exists: false, size: null, target: null, arguments: null, workingDirectory: null };
  if (!fs.existsSync(shortcutPath)) return info;
  info.exists = true;
  try { info.size = fs.statSync(shortcutPath).size; } catch (error) { /* ignore */ }

  const script = [
    '$ErrorActionPreference="SilentlyContinue";',
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(shortcutPath)});`,
    'if ($s) {',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '@($s.TargetPath, $s.Arguments, $s.WorkingDirectory) -join [char]10',
    '}'
  ].join(' ');
  try {
    const parts = powershell(script, 15000).replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
    info.target = (parts[0] || '').trim() || null;
    info.arguments = (parts[1] || '').trim() || null;
    info.workingDirectory = (parts[2] || '').trim() || null;
  } catch (error) {
    info.targetError = String(error.message || error).slice(0, 200);
  }
  return info;
}

function moveStartupShortcut(options) {
  const opts = Object.assign({}, DEFAULT_PATHS, options || {});
  const apply = !!opts.apply;
  const source = opts.startupShortcut;
  const target = opts.retiredShortcut;

  const report = {
    source,
    target,
    apply,
    status: 'unknown',
    shortcutExists: fs.existsSync(source),
    retiredExists: fs.existsSync(target),
    moved: false
  };

  if (!report.shortcutExists) {
    report.status = report.retiredExists ? 'already-retired' : 'absent';
    return report;
  }

  report.shortcut = inspectShortcut(source);
  const shortcutBlob = [
    report.shortcut.target,
    report.shortcut.arguments,
    report.shortcut.workingDirectory
  ].filter(Boolean).join(' ').toLowerCase();
  report.targetMatchesLegacy = shortcutBlob
    ? shortcutBlob.includes('antigravity2.0-chineseplugin') ||
      shortcutBlob.includes('antigravitychineseplugin') ||
      shortcutBlob.includes('injector_zh.py')
    : null;

  if (!apply) {
    report.status = 'would-move';
    return report;
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const backup = `${target}.bak-${stamp()}`;
      fs.renameSync(target, backup);
      report.previousRetiredBackup = backup;
    }
    fs.renameSync(source, target);
    report.moved = true;
    report.status = 'moved';
    report.movedAt = new Date().toISOString();
    report.retiredExists = true;
    report.shortcutExists = false;
  } catch (error) {
    report.status = 'error';
    report.error = String(error.message || error);
  }
  return report;
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

function retireLegacyChinesePlugin(options) {
  const opts = Object.assign({}, DEFAULT_PATHS, options || {});
  const apply = !!opts.apply;
  const startedAt = new Date().toISOString();

  const report = {
    tool: 'retire-legacy-zh',
    version: VERSION,
    mode: apply ? 'apply' : 'dry-run',
    platform: process.platform,
    startedAt,
    needles: opts.needles,
    ok: false,
    errors: [],
    processes: { scanned: 0, matched: [], stopped: [] },
    shortcut: null,
    legacyProjectDir: opts.legacyProjectDir,
    legacyProjectExists: fs.existsSync(opts.legacyProjectDir)
  };

  if (process.platform !== 'win32') {
    report.errors.push('unsupported-platform: retire-legacy-zh only targets Windows');
    report.finishedAt = new Date().toISOString();
    return report;
  }

  try {
    const found = findLegacyProcesses(opts);
    report.processes.scanned = found.scanned;
    report.processes.matched = found.matched;
    if (!apply) {
      report.processes.wouldStop = found.matched.map((p) => p.pid);
    }
  } catch (error) {
    report.errors.push('process-scan: ' + String(error.message || error).slice(0, 400));
  }

  if (apply && report.processes.matched.length) {
    for (const proc of report.processes.matched) {
      try {
        report.processes.stopped.push(Object.assign({ name: proc.name }, stopProcess(proc.pid, opts.graceMs)));
      } catch (error) {
        report.processes.stopped.push({ pid: proc.pid, stopped: false, error: String(error.message || error) });
      }
    }
  }

  if (opts.skipShortcut) {
    report.shortcut = { status: 'skipped' };
  } else {
    try {
      report.shortcut = moveStartupShortcut(opts);
    } catch (error) {
      report.shortcut = { status: 'error', error: String(error.message || error) };
    }
  }

  const shortcutStatus = report.shortcut && report.shortcut.status;
  report.ok = report.errors.length === 0 && shortcutStatus !== 'error';
  report.finishedAt = new Date().toISOString();
  report.summary = {
    matched: report.processes.matched.length,
    stopped: report.processes.stopped.filter((p) => p.stopped).length,
    failed: report.processes.stopped.filter((p) => !p.stopped).length,
    shortcut: shortcutStatus || null
  };
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { apply: false, pretty: false, skipShortcut: false, graceMs: DEFAULT_PATHS.graceMs, help: false };
  let hasApply = false;
  let hasDryRun = false;

  for (const arg of argv) {
    if (arg === '--apply') hasApply = true;
    else if (arg === '--dry-run') hasDryRun = true;
    else if (arg === '--pretty') opts.pretty = true;
    else if (arg === '--no-shortcut') opts.skipShortcut = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--grace=')) opts.graceMs = Math.max(0, parseInt(arg.slice(8), 10) || 0);
    else if (arg.startsWith('--startup=')) opts.startupShortcut = arg.slice(10);
    else if (arg.startsWith('--retired=')) opts.retiredShortcut = arg.slice(10);
    else if (arg.startsWith('--project=')) opts.legacyProjectDir = arg.slice(10);
    else if (arg.trim()) {
      return { error: 'unknown-argument: ' + arg };
    }
  }

  // Dry-run wins if both flags are supplied: never destructive by accident.
  opts.apply = hasApply && !hasDryRun;
  if (hasApply && hasDryRun) opts.warning = 'both --apply and --dry-run supplied; running dry-run';
  return opts;
}

function usage() {
  return [
    'Usage: node scripts/retire-legacy-zh.js [--apply] [--dry-run] [--pretty] [--no-shortcut] [--grace=ms]',
    '',
    '  (default)      dry-run: scan only, no process is stopped, shortcut untouched',
    '  --apply        gracefully stop legacy processes and archive the startup shortcut',
    '  --dry-run      force dry-run even if --apply is present',
    '  --no-shortcut  do not inspect/move the startup shortcut',
    '  --grace=1500   ms to wait for a graceful stop before forcing',
    '',
    'Only command lines containing antigravity2.0-ChinesePlugin or injector_zh.py are targeted.'
  ].join('\n');
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stdout.write(JSON.stringify({ ok: false, error: opts.error, usage: usage() }, null, 2) + '\n');
    return 2;
  }
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }

  const report = retireLegacyChinesePlugin(opts);
  if (opts.warning) report.warning = opts.warning;
  if (opts.graceMs !== DEFAULT_PATHS.graceMs) report.graceMs = opts.graceMs;

  process.stdout.write(JSON.stringify(report, null, opts.pretty ? 2 : 0) + '\n');
  return report.ok ? 0 : 1;
}

module.exports = {
  VERSION,
  DEFAULT_PATHS,
  isLegacyCommand,
  findLegacyProcesses,
  stopProcess,
  moveStartupShortcut,
  inspectShortcut,
  retireLegacyChinesePlugin,
  parseArgs
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
