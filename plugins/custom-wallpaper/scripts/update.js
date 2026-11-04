#!/usr/bin/env node
"use strict";

/**
 * 星夜美化插件更新器。
 *
 * 发行方式：GitHub Releases 上传 zip + latest.json；latest.json 必须包含
 * version / zipUrl / sha256。用户端只在用户点击“立即更新”时替换文件，
 * 更新前完整备份插件目录，并保留本地配置、壁纸、提示词与快照。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const LOCAL = readJson(path.join(ROOT, "plugin.json"), {});
const UPDATE_CFG = readJson(path.join(ROOT, "config", "update.json"), {});
const STATE_FILE = path.join(ROOT, "config", "update-state.json");
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["github.com", "api.github.com"]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function log(message) {
  process.stderr.write(`[starlight-update] ${message}\n`);
}

function writeState(patch) {
  const previous = readJson(STATE_FILE, {});
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function versionParts(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(candidate, current) {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function normalizeVersion(value) {
  return String(value || "").replace(/^v/i, "").trim();
}

function allowedUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_HOSTS.has(host) || host.endsWith(".githubusercontent.com");
  } catch (error) {
    return false;
  }
}

async function fetchWithTimeout(url, { timeout = 20000, json = false } = {}) {
  if (!allowedUrl(url)) throw new Error(`不允许的更新地址：${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "antigravity-starlight-updater/1.0",
        accept: json ? "application/json" : "*/*",
      },
    });
    if (!response.ok) throw new Error(`更新服务 HTTP ${response.status}`);
    if (!allowedUrl(response.url || url)) throw new Error("更新地址重定向到了非 GitHub 域名");
    if (json) {
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error("latest.json 过大");
      return JSON.parse(text);
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_ZIP_BYTES) throw new Error("更新包超过 50MB");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ZIP_BYTES) throw new Error("更新包超过 50MB");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveManifest() {
  const configuredUrl = String(UPDATE_CFG.manifestUrl || "").trim();
  const repo = String(UPDATE_CFG.repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  if (!configuredUrl && !repo) {
    throw Object.assign(new Error("未配置更新源，请在 config/update.json 填写 repo 或 manifestUrl"), { configured: false });
  }

  let manifestUrl = configuredUrl;
  if (!manifestUrl) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("config/update.json 的 repo 格式应为 owner/repo");
    const release = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, { json: true });
    const asset = (release.assets || []).find((item) => item.name === "latest.json");
    if (!asset?.browser_download_url) {
      throw new Error("GitHub Release 缺少 latest.json 资产，请用 scripts/release.js 生成并上传");
    }
    manifestUrl = asset.browser_download_url;
  }

  const manifest = await fetchWithTimeout(manifestUrl, { json: true });
  if (manifest?.name && manifest.name !== LOCAL.name) {
    throw new Error("latest.json 的插件标识与当前插件不一致");
  }
  const version = normalizeVersion(manifest.version);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("latest.json 缺少合法的 version");
  const sha256 = String(manifest.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("latest.json 缺少合法的 sha256");
  const zipUrl = new URL(String(manifest.zipUrl || manifest.downloadUrl || ""), manifestUrl).href;
  if (!allowedUrl(zipUrl)) throw new Error("latest.json 的 zipUrl 不是 GitHub HTTPS 地址");

  return {
    manifestUrl,
    manifest,
    version,
    zipUrl,
    sha256,
    notes: String(manifest.notes || "").slice(0, 6000),
    publishedAt: String(manifest.publishedAt || ""),
  };
}

async function checkUpdate() {
  const current = normalizeVersion(LOCAL.version);
  if (!UPDATE_CFG.repo && !UPDATE_CFG.manifestUrl) {
    const message = "未配置更新源，请在 config/update.json 填写 repo 或 manifestUrl";
    writeState({ configured: false, current, error: message, checkedAt: new Date().toISOString() });
    return { ok: true, configured: false, current, available: false, error: message };
  }
  try {
    const resolved = await resolveManifest();
    const available = isNewer(resolved.version, current);
    const result = {
      ok: true,
      configured: true,
      current,
      latest: resolved.version,
      available,
      notes: resolved.notes,
      publishedAt: resolved.publishedAt,
      zipUrl: resolved.zipUrl,
      sha256: resolved.sha256,
      manifestUrl: resolved.manifestUrl,
      restartRequired: false,
    };
    writeState({
      configured: true,
      current,
      latest: resolved.version,
      available,
      notes: resolved.notes,
      publishedAt: resolved.publishedAt,
      manifestUrl: resolved.manifestUrl,
      error: "",
      checkedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    const message = error?.message || String(error);
    writeState({ configured: true, current, available: false, error: message, checkedAt: new Date().toISOString() });
    return { ok: false, configured: true, current, available: false, error: message };
  }
}

function listZipEntries(zipPath) {
  if (process.platform === "win32") {
    const safeZip = zipPath.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[System.IO.Compression.ZipFile]::OpenRead('${safeZip}'); try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }`;
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }).split(/\r?\n/);
  }
  return execFileSync("tar", ["-tf", zipPath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split(/\r?\n/);
}

function assertArchiveSafe(zipPath) {
  let listing = [];
  try {
    listing = listZipEntries(zipPath);
  } catch (error) {
    throw new Error("无法读取更新包目录");
  }
  for (const raw of listing) {
    const entry = raw.trim().replace(/\\/g, "/");
    if (!entry) continue;
    if (/^[A-Za-z]:/.test(entry) || entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error(`更新包包含不安全路径：${entry}`);
    }
  }
}

function extractZip(zipPath, destination) {
  if (process.platform === "win32") {
    const safeZip = zipPath.replace(/'/g, "''");
    const safeDest = destination.replace(/'/g, "''");
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${safeZip}' -DestinationPath '${safeDest}' -Force`,
    ], { stdio: "pipe" });
    return;
  }
  try {
    execFileSync("unzip", ["-q", zipPath, "-d", destination], { stdio: "pipe" });
  } catch (error) {
    execFileSync("tar", ["-xf", zipPath, "-C", destination], { stdio: "pipe" });
  }
}

function assertNoSymlinks(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`更新包包含符号链接：${entry.name}`);
      if (entry.isDirectory()) stack.push(full);
    }
  }
}

function findPluginRoot(extractDir) {
  const candidates = [extractDir];
  for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(extractDir, entry.name));
  }
  const found = candidates.find((dir) =>
    fs.existsSync(path.join(dir, "plugin.json")) && fs.existsSync(path.join(dir, "scripts", "apply.js")));
  if (!found) throw new Error("更新包缺少 plugin.json 或 scripts/apply.js");
  return found;
}

function copyUpdate(source, destination) {
  const skip = new Set(["config", "snapshots", ".git", ".github", "node_modules", "dist"]);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    fs.cpSync(path.join(source, entry.name), path.join(destination, entry.name), {
      recursive: true,
      force: true,
      dereference: false,
    });
  }
}

async function applyUpdate() {
  const info = await checkUpdate();
  if (!info.ok) return info;
  if (!info.available) {
    return { ok: true, updated: false, current: info.current, latest: info.latest, message: "已是最新版本" };
  }

  const resolved = await resolveManifest();
  const currentVersion = normalizeVersion(LOCAL.version);
  const buffer = await fetchWithTimeout(resolved.zipUrl, { timeout: 60000 });
  const actualSha = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualSha !== resolved.sha256) {
    throw new Error(`更新包校验失败（sha256 ${actualSha}）`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-starlight-update-"));
  const zipPath = path.join(tempRoot, "update.zip");
  const extractDir = path.join(tempRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  fs.writeFileSync(zipPath, buffer);

  try {
    assertArchiveSafe(zipPath);
    extractZip(zipPath, extractDir);
    assertNoSymlinks(extractDir);
    const source = findPluginRoot(extractDir);
    const remotePkg = readJson(path.join(source, "plugin.json"), {});
    if (remotePkg.name !== LOCAL.name) throw new Error("更新包插件标识与当前插件不一致");
    if (normalizeVersion(remotePkg.version) !== resolved.version) throw new Error("更新包版本与 latest.json 不一致");

    const backupRoot = path.join(os.homedir(), ".gemini", "memory", "antigravity-theme-backups");
    fs.mkdirSync(backupRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(backupRoot, `${LOCAL.name}-${currentVersion}-${stamp}`);
    fs.cpSync(ROOT, backup, { recursive: true, force: true });

    const preserveFiles = ["config/config.json", "config/runtime.json", "scripts/prompts-custom.json"];
    const saved = new Map();
    for (const rel of preserveFiles) {
      const file = path.join(ROOT, rel);
      if (fs.existsSync(file)) saved.set(rel, fs.readFileSync(file));
    }
    const currentCfg = readJson(path.join(ROOT, "config", "config.json"), {});
    const currentUpdate = readJson(path.join(ROOT, "config", "update.json"), {});
    const sourceUpdate = readJson(path.join(source, "config", "update.json"), {});
    const wallpaperRel = String(currentCfg.wallpaperPath || "assets/wallpaper.jpg");
    const customWallpaper = wallpaperRel !== "assets/wallpaper.jpg" && !path.isAbsolute(wallpaperRel)
      ? { rel: wallpaperRel, data: fs.existsSync(path.join(ROOT, wallpaperRel)) ? fs.readFileSync(path.join(ROOT, wallpaperRel)) : null }
      : null;

    copyUpdate(source, ROOT);

    for (const [rel, data] of saved) {
      const target = path.join(ROOT, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    const mergedUpdate = { ...sourceUpdate };
    for (const [key, value] of Object.entries(currentUpdate)) {
      if (value !== "" && value !== null && value !== undefined) mergedUpdate[key] = value;
    }
    fs.writeFileSync(path.join(ROOT, "config", "update.json"), `${JSON.stringify(mergedUpdate, null, 2)}\n`, "utf8");
    if (customWallpaper?.data) {
      const target = path.join(ROOT, customWallpaper.rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, customWallpaper.data);
    }

    writeState({
      configured: true,
      current: resolved.version,
      latest: resolved.version,
      available: false,
      appliedAt: new Date().toISOString(),
      from: currentVersion,
      to: resolved.version,
      backup,
      notes: resolved.notes,
      error: "",
    });

    return {
      ok: true,
      updated: true,
      from: currentVersion,
      to: resolved.version,
      backup,
      notes: resolved.notes,
      restartRequired: true,
      message: "更新完成，重启 Antigravity 后生效",
    };
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (error) {}
  }
}

async function main() {
  const command = String(process.argv[2] || "status").toLowerCase();
  if (command === "check") {
    emit(await checkUpdate());
    return;
  }
  if (command === "apply") {
    try {
      emit(await applyUpdate());
    } catch (error) {
      emit({ ok: false, error: error?.message || String(error) });
      process.exitCode = 1;
    }
    return;
  }
  const state = readJson(STATE_FILE, {});
  emit({
    ok: true,
    configured: Boolean(UPDATE_CFG.repo || UPDATE_CFG.manifestUrl),
    current: normalizeVersion(LOCAL.version),
    ...state,
  });
}

main().catch((error) => {
  emit({ ok: false, error: error?.message || String(error) });
  process.exitCode = 1;
});
