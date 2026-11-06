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

function useSystemProxy() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    process.env.NODE_USE_ENV_PROXY = "1";
    return;
  }
  if (process.platform !== "win32") return;
  try {
    const reg = execFileSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    ], { encoding: "utf8", timeout: 4000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(reg)) return;
    const raw = (reg.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i) || [])[1] || "";
    const server = raw.split(";").map((part) => part.trim()).find((part) => part && !part.includes("="))
      || raw.split(";").map((part) => part.trim()).find((part) => /^https?=/.test(part))?.split("=").pop()
      || "";
    if (!/^[\w.-]+:\d+$/.test(server)) return;
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.HTTPS_PROXY = `http://${server}`;
    process.env.HTTP_PROXY = `http://${server}`;
  } catch (error) {}
}

useSystemProxy();

const PLUGINS_ROOT = path.dirname(ROOT);
const BACKUP_ROOT = path.join(os.homedir(), ".gemini", "memory", "antigravity-theme-backups");
const COMPONENT_ORDER = [
  "antigravity-custom-wallpaper",
  "mnemon",
  "computer-use",
  "antigravity-browser-bridge",
];

function installedPlugins() {
  const found = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(PLUGINS_ROOT, { withFileTypes: true });
  } catch (error) {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PLUGINS_ROOT, entry.name);
    const pkg = readJson(path.join(dir, "plugin.json"), null);
    if (pkg?.name && !found.has(pkg.name)) found.set(pkg.name, { dir, pkg });
  }
  return found;
}

function manifestComponents(manifest, resolved) {
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(manifest?.components) ? manifest.components : []) {
    const name = String(raw?.name || "").trim();
    if (!name || seen.has(name)) continue;
    const componentVersion = normalizeVersion(raw?.version);
    const sha256 = String(raw?.sha256 || "").toLowerCase();
    if (!/^\d+\.\d+\.\d+$/.test(componentVersion) || !/^[a-f0-9]{64}$/.test(sha256)) continue;
    let zipUrl;
    try {
      zipUrl = new URL(String(raw?.zipUrl || ""), resolved.manifestUrl).href;
    } catch (error) {
      continue;
    }
    if (!allowedUrl(zipUrl)) continue;
    seen.add(name);
    items.push({
      name,
      displayName: String(raw?.displayName || name),
      version: componentVersion,
      zipUrl,
      sha256,
    });
  }
  if (!seen.has(LOCAL.name)) {
    items.unshift({
      name: LOCAL.name,
      displayName: LOCAL.displayName,
      version: resolved.version,
      zipUrl: resolved.zipUrl,
      sha256: resolved.sha256,
    });
  }
  const order = new Map(COMPONENT_ORDER.map((name, index) => [name, index]));
  items.sort((left, right) => (order.get(left.name) ?? 99) - (order.get(right.name) ?? 99));
  return items;
}

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
  let manifest;
  if (!manifestUrl) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("config/update.json 的 repo 格式应为 owner/repo");
    // releases/latest/download 是静态重定向，不占 api.github.com 的 60 次/小时配额
    manifestUrl = `https://github.com/${repo}/releases/latest/download/latest.json`;
    try {
      manifest = await fetchWithTimeout(manifestUrl, { json: true });
    } catch (error) {
      if (!/HTTP 404/.test(error?.message || "")) throw error;
      const release = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, { json: true });
      const asset = (release.assets || []).find((item) => item.name === "latest.json");
      if (!asset?.browser_download_url) {
        throw new Error("GitHub Release 缺少 latest.json 资产，请用 scripts/release.js 生成并上传");
      }
      manifestUrl = asset.browser_download_url;
      manifest = await fetchWithTimeout(manifestUrl, { json: true });
    }
  } else {
    manifest = await fetchWithTimeout(manifestUrl, { json: true });
  }
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

function evaluateComponents(manifest, resolved, installed = installedPlugins()) {
  return manifestComponents(manifest, resolved).map((item) => {
    const local = item.name === LOCAL.name ? { dir: ROOT, pkg: LOCAL } : installed.get(item.name);
    const installedVersion = normalizeVersion(local?.pkg?.version || "");
    return {
      ...item,
      displayName: item.displayName || local?.pkg?.displayName || item.name,
      installed: Boolean(local),
      installedVersion,
      available: Boolean(local) && isNewer(item.version, installedVersion),
    };
  });
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
    const components = evaluateComponents(resolved.manifest, resolved);
    const available = components.some((item) => item.available);
    const stateComponents = components.map(({ zipUrl, sha256, ...rest }) => rest);
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
      components,
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
      components: stateComponents,
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

function findPackageRoot(extractDir, expectedName) {
  const candidates = [extractDir];
  for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(extractDir, entry.name));
  }
  const found = candidates.find((dir) => readJson(path.join(dir, "plugin.json"), null)?.name === expectedName);
  if (!found) throw new Error(`更新包缺少 ${expectedName} 的 plugin.json`);
  return found;
}

// Node 25 的 fs.cpSync 在路径含非 ASCII 字符时会静默崩溃（exit 127）或漏复制，
// 这里用 readdir/copyFile 自行递归，确保中文插件目录也能正常备份与替换。
function copyTree(source, destination, filter) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (filter && !filter(from, to)) continue;
      copyTree(from, to, filter);
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyUpdate(source, destination, extraSkip = []) {
  const skip = new Set(["config", "snapshots", ".git", ".github", "dist", "__pycache__", ...extraSkip]);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    copyTree(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

function snapshotThemeLocal() {
  const files = new Map();
  for (const rel of ["config/config.json", "config/runtime.json", "scripts/prompts-custom.json"]) {
    const file = path.join(ROOT, rel);
    if (fs.existsSync(file)) files.set(rel, fs.readFileSync(file));
  }
  const cfg = readJson(path.join(ROOT, "config", "config.json"), {});
  const updateCfg = readJson(path.join(ROOT, "config", "update.json"), {});
  const wallpaperRel = String(cfg.wallpaperPath || "assets/wallpaper.jpg");
  const customWallpaper = wallpaperRel !== "assets/wallpaper.jpg" && !path.isAbsolute(wallpaperRel)
    ? { rel: wallpaperRel, data: fs.existsSync(path.join(ROOT, wallpaperRel)) ? fs.readFileSync(path.join(ROOT, wallpaperRel)) : null }
    : null;
  return { files, updateCfg, customWallpaper };
}

function restoreThemeLocal(saved) {
  for (const [rel, data] of saved.files) {
    const target = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  const sourceUpdate = readJson(path.join(ROOT, "config", "update.json"), {});
  const mergedUpdate = { ...sourceUpdate };
  for (const [key, value] of Object.entries(saved.updateCfg)) {
    if (value !== "" && value !== null && value !== undefined) mergedUpdate[key] = value;
  }
  fs.writeFileSync(path.join(ROOT, "config", "update.json"), `${JSON.stringify(mergedUpdate, null, 2)}\n`, "utf8");
  if (saved.customWallpaper?.data) {
    const target = path.join(ROOT, saved.customWallpaper.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, saved.customWallpaper.data);
  }
}

async function applyComponent(component) {
  const local = component.name === LOCAL.name ? { dir: ROOT, pkg: LOCAL } : installedPlugins().get(component.name);
  if (!local?.dir) throw new Error("未安装该插件，已跳过");
  const target = local.dir;
  const buffer = await fetchWithTimeout(component.zipUrl, { timeout: 60000 });
  const actualSha = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualSha !== component.sha256) {
    throw new Error(`更新包校验失败（sha256 ${actualSha}）`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-suite-update-"));
  const zipPath = path.join(tempRoot, "update.zip");
  const extractDir = path.join(tempRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  fs.writeFileSync(zipPath, buffer);

  try {
    assertArchiveSafe(zipPath);
    extractZip(zipPath, extractDir);
    assertNoSymlinks(extractDir);
    const source = findPackageRoot(extractDir, component.name);
    const remotePkg = readJson(path.join(source, "plugin.json"), {});
    if (remotePkg.name !== component.name) throw new Error("更新包插件标识与清单不一致");
    if (normalizeVersion(remotePkg.version) !== component.version) throw new Error("更新包版本与 latest.json 不一致");

    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fromVersion = normalizeVersion(local.pkg?.version);
    const backup = path.join(BACKUP_ROOT, `${component.name}-${fromVersion}-${stamp}`);
    copyTree(target, backup);

    const themeSaved = component.name === LOCAL.name ? snapshotThemeLocal() : null;
    copyUpdate(source, target, component.name === "antigravity-browser-bridge" ? [] : ["node_modules"]);
    if (themeSaved) restoreThemeLocal(themeSaved);

    return {
      name: component.name,
      displayName: component.displayName,
      from: fromVersion,
      to: component.version,
      updated: true,
      backup,
    };
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (error) {}
  }
}

async function applyUpdate() {
  const info = await checkUpdate();
  if (!info.ok) return info;
  const outdated = (info.components || []).filter((item) => item.available && item.installed);
  if (!outdated.length) {
    return { ok: true, updated: false, current: info.current, latest: info.latest, components: info.components || [], message: "已是最新版本" };
  }

  const results = [];
  for (const component of outdated) {
    try {
      results.push(await applyComponent(component));
    } catch (error) {
      results.push({
        name: component.name,
        displayName: component.displayName,
        from: component.installedVersion,
        to: component.version,
        updated: false,
        error: error?.message || String(error),
      });
    }
  }

  const updated = results.filter((item) => item.updated);
  const failed = results.filter((item) => !item.updated);
  const components = (info.components || []).map((item) => {
    const result = results.find((entry) => entry.name === item.name);
    return result?.updated ? { ...item, installedVersion: result.to, available: false } : item;
  });
  const remaining = components.some((item) => item.available && item.installed);
  const themeResult = results.find((item) => item.name === LOCAL.name);
  const themeNow = normalizeVersion(readJson(path.join(ROOT, "plugin.json"), {}).version) || info.current;

  writeState({
    configured: true,
    current: themeNow,
    latest: info.latest,
    available: remaining,
    appliedAt: new Date().toISOString(),
    from: themeResult?.from || info.current,
    to: info.latest,
    backup: themeResult?.backup || "",
    notes: info.notes,
    error: failed.map((item) => `${item.displayName}: ${item.error}`).join("；"),
    checkedAt: new Date().toISOString(),
    components: components.map(({ zipUrl, sha256, ...rest }) => rest),
  });

  return {
    ok: failed.length === 0,
    updated: updated.length > 0,
    current: themeNow,
    latest: info.latest,
    to: info.latest,
    from: themeResult?.from || info.current,
    backup: themeResult?.backup || "",
    components: results,
    count: updated.length,
    failed: failed.length,
    notes: info.notes,
    restartRequired: updated.length > 0,
    message: updated.length
      ? `已更新 ${updated.length} 个组件，重启 Antigravity 后生效${failed.length ? `；${failed.length} 个失败` : ""}`
      : "更新失败",
  };
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

if (require.main === module) {
  main().catch((error) => {
    emit({ ok: false, error: error?.message || String(error) });
    process.exitCode = 1;
  });
}

module.exports = { applyComponent, checkUpdate, evaluateComponents, manifestComponents, installedPlugins, normalizeVersion, isNewer };
