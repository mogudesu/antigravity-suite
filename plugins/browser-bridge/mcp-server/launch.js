"use strict";

/**
 * browser_launch 的本地实现：定位 Edge / Chrome / 自定义浏览器、拼装启动命令、
 * 拉起进程并等待扩展握手。支持 dryRun：只返回将要执行的命令行，不真正启动浏览器。
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const KNOWN_PATHS = {
  edge: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  chrome: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

if (process.env["PROGRAMFILES(X86)"]) {
  KNOWN_PATHS.edge.push(path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"));
  KNOWN_PATHS.chrome.push(path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"));
}
if (process.env.LOCALAPPDATA) {
  KNOWN_PATHS.edge.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"));
  KNOWN_PATHS.chrome.push(path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function quoteArg(v) {
  const s = String(v);
  return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

function formatCommand(exe, argv) {
  return [quoteArg(exe)].concat(argv.map(quoteArg)).join(" ");
}

function normalizeBrowser(value) {
  const b = String(value || "edge").toLowerCase();
  if (b === "edge" || b === "chrome" || b === "custom") return b;
  return null;
}

/** executablePath 指向 msedge.exe / chrome.exe 时，省略 browser 也能推断出正确目标。 */
function detectBrowserKind(exe) {
  const base = path.basename(String(exe || "")).toLowerCase();
  if (base.indexOf("msedge") !== -1) return "edge";
  if (base.indexOf("chrome") !== -1) return "chrome";
  return null;
}

function resolveBrowser(args) {
  const explicit = args.browser ? normalizeBrowser(args.browser) : "";
  if (args.browser && !explicit) {
    return { error: { code: "BAD_BROWSER", message: `browser 只能是 edge / chrome / custom，收到：${args.browser}` } };
  }

  const custom = args.executablePath ? String(args.executablePath).trim() : "";
  if (custom) {
    const exe = path.resolve(custom);
    const browser = explicit || detectBrowserKind(exe) || "custom";
    return { browser, exe, candidates: [exe], source: "executablePath", exists: fs.existsSync(exe) };
  }
  if (explicit === "custom") {
    return { error: { code: "EXE_REQUIRED", message: "browser=custom 时必须提供 executablePath，例如 C:\\Program Files\\...\\browser.exe" } };
  }

  const browser = explicit || "edge";
  const candidates = KNOWN_PATHS[browser];
  const exe = candidates.find((p) => fs.existsSync(p));
  return { browser, exe: exe || candidates[0], candidates, source: "known-path", exists: !!exe };
}

function buildArgs(args) {
  const argv = ["--no-first-run", "--no-default-browser-check"];
  const profile = args.profileDirectory ? String(args.profileDirectory).trim() : "";
  if (profile) argv.push("--profile-directory=" + profile);
  const url = args.url ? String(args.url).trim() : "";
  argv.push(url || "about:blank");
  return { argv, profile, url: url || "about:blank" };
}

function extensionGuide(rootDir, port) {
  const extensionPath = path.join(rootDir, "extension");
  const setupScript = path.join(rootDir, "scripts", "open-edge-extension-setup.ps1");
  const setupCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File "${setupScript}"`;
  return {
    extensionPath,
    setupScript,
    setupCommand,
    extensionMissing: true,
    instructions: [
      "浏览器已经启动，但没有等到扩展握手（扩展可能尚未安装或未启用）。首次使用只需安装一次：",
      "1) 打开 edge://extensions（Chrome 用 chrome://extensions），开启右上角「开发人员模式」；",
      "2) 点「加载解压缩的扩展」，选择目录：" + extensionPath,
      "3) 确认「antigravity浏览器控制」已启用，点工具栏图标打开弹窗，端口填 " + port + "（默认 8767），点「重连」；",
      "4) 也可以运行：" + setupCommand + "（自动打开 edge://extensions 并定位扩展目录）。",
    ].join("\n"),
  };
}

function spawnDetached(exe, argv) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, argv, { detached: true, stdio: "ignore", windowsHide: false });
    } catch (e) {
      return reject(e);
    }
    let settled = false;
    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch (e) { /* ignore */ }
      resolve({ pid: child.pid });
    });
  });
}

async function waitForClient(listClients, wantBrowser, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    let list = [];
    try { list = (await listClients()) || []; } catch (e) { list = []; }
    const hit = wantBrowser
      ? list.find((c) => String(c.browser || "").toLowerCase() === wantBrowser)
      : list[0];
    if (hit) return { client: hit, clients: list };
    if (Date.now() >= deadline) return { client: null, clients: list };
    await sleep(150);
  }
}

/**
 * @param {object} args  MCP 工具参数
 * @param {object} deps  { rootDir, port, listClients }
 * @returns {Promise<object>} 直接作为工具结果返回的对象
 */
async function runBrowserLaunch(args, deps) {
  const rootDir = deps.rootDir;
  const port = deps.port;
  const a = args && typeof args === "object" ? args : {};
  const dryRun = a.dryRun === true || process.env.AG_BRIDGE_DRY_RUN === "1";
  const waitConnectMs = Number.isFinite(Number(a.waitConnectMs))
    ? Math.max(0, Math.min(120000, Number(a.waitConnectMs)))
    : 8000;
  const resolved = resolveBrowser(a);
  if (resolved.error) {
    return { ok: false, stage: "bad-arguments", code: resolved.error.code, error: resolved.error.message };
  }

  const built = buildArgs(a);
  const commandLine = formatCommand(resolved.exe, built.argv);

  if (dryRun) {
    return {
      ok: resolved.exists,
      dryRun: true,
      launched: false,
      stage: "dry-run",
      browser: resolved.browser,
      executablePath: resolved.exe,
      executableExists: resolved.exists,
      candidates: resolved.candidates,
      profileDirectory: built.profile || null,
      url: built.url,
      waitConnectMs,
      commandLine,
      message: resolved.exists
        ? "dry-run：仅校验启动命令，未真正启动浏览器。"
        : "dry-run：目标浏览器可执行文件不存在，未启动。" + " 候选路径：" + resolved.candidates.join(" | "),
    };
  }

  if (!resolved.exists) {
    const guide = extensionGuide(rootDir, port);
    return {
      ok: false,
      stage: "browser-not-found",
      code: "BROWSER_NOT_FOUND",
      browser: resolved.browser,
      executablePath: resolved.exe,
      candidates: resolved.candidates,
      error: `找不到 ${resolved.browser} 的可执行文件：${resolved.exe}`,
      hint: "请安装对应浏览器，或传入 executablePath 指定真实路径。",
      ...guide,
    };
  }

  const wantBrowser = resolved.browser === "custom" ? null : resolved.browser;
  let existing = [];
  try { existing = (await deps.listClients()) || []; } catch (e) { existing = []; }
  const already = wantBrowser
    ? existing.find((c) => String(c.browser || "").toLowerCase() === wantBrowser)
    : existing[0];
  if (already) {
    return {
      ok: true,
      launched: false,
      stage: "already-connected",
      browser: already.browser,
      executablePath: resolved.exe,
      profileDirectory: built.profile || null,
      url: built.url,
      clients: existing,
      message: `${already.browser} 扩展已连接，无需重复启动浏览器。`,
    };
  }

  let pid = null;
  try {
    const launched = await spawnDetached(resolved.exe, built.argv);
    pid = launched.pid;
  } catch (e) {
    const guide = extensionGuide(rootDir, port);
    return {
      ok: false,
      stage: "spawn-failed",
      code: "SPAWN_FAILED",
      browser: resolved.browser,
      executablePath: resolved.exe,
      commandLine,
      error: `启动 ${resolved.browser} 失败：${(e && e.message) || e}`,
      ...guide,
    };
  }

  const waited = await waitForClient(deps.listClients, wantBrowser, waitConnectMs);
  if (waited.client) {
    return {
      ok: true,
      launched: true,
      stage: "connected",
      pid,
      browser: waited.client.browser,
      executablePath: resolved.exe,
      profileDirectory: built.profile || null,
      url: built.url,
      waitConnectMs,
      clients: waited.clients,
      message: `${waited.client.browser} 已启动且扩展握手成功。`,
    };
  }

  const guide = extensionGuide(rootDir, port);
  return {
    ok: false,
    launched: true,
    stage: "launched-without-extension",
    pid,
    browser: resolved.browser,
    executablePath: resolved.exe,
    profileDirectory: built.profile || null,
    url: built.url,
    waitConnectMs,
    clients: waited.clients,
    message: `已启动 ${resolved.browser}（pid ${pid}），但在 ${waitConnectMs} ms 内没有等到扩展握手。`,
    ...guide,
  };
}

module.exports = { runBrowserLaunch, resolveBrowser, buildArgs, formatCommand, extensionGuide, KNOWN_PATHS };
