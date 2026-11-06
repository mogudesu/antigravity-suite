#!/usr/bin/env node
"use strict";

/**
 * 生成 GitHub Release 套装资产：
 *   dist/antigravity-starlight-mogu-<v>.zip
 *   dist/antigravity-mnemon-<v>.zip
 *   dist/antigravity-computer-use-<v>.zip
 *   dist/antigravity-browser-bridge-<v>.zip
 *   dist/latest.json（含 components 列表）
 *
 * 用法：
 *   node scripts/release.js --repo owner/repo
 *   node scripts/release.js --repo owner/repo --plugins-dir ~/.gemini/config/plugins
 *   node scripts/release.js --repo owner/repo --notes "修复..."
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
const version = String(pkg.version || "").replace(/^v/i, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("plugin.json version must be semver, got: " + pkg.version);
  process.exit(1);
}

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const repo = String(arg("repo", process.env.GITHUB_REPOSITORY || "")).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error("缺少 --repo owner/repo（或 GITHUB_REPOSITORY）");
  process.exit(1);
}

const outDir = path.resolve(ROOT, arg("out", "dist"));
const pluginsDir = path.resolve(arg("plugins-dir", path.dirname(ROOT)));
const explicitNotes = String(arg("notes", process.env.RELEASE_NOTES || "")).slice(0, 6000);

const COMPONENTS = [
  { name: "antigravity-custom-wallpaper", zipBase: "antigravity-starlight-mogu", theme: true, nodeModules: false },
  { name: "mnemon", zipBase: "antigravity-mnemon", nodeModules: false },
  { name: "computer-use", zipBase: "antigravity-computer-use", nodeModules: false },
  { name: "antigravity-browser-bridge", zipBase: "antigravity-browser-bridge", nodeModules: true },
];

const excludedDirs = new Set([".git", ".github", "dist", "snapshots", "__pycache__", ".venv"]);
const excludedFiles = /(?:^|[\\/])(?:runtime\.json|update-state\.json|.*\.pyc|.*\.log|.*\.tmp|.*\.bak)$/i;

function findPluginDir(name) {
  if (!fs.existsSync(pluginsDir)) return "";
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginsDir, entry.name);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
      if (meta.name === name) return dir;
    } catch (error) {}
  }
  return "";
}

function copyFilter(sourceRoot, includeNodeModules) {
  return (source) => {
    const rel = path.relative(sourceRoot, source);
    if (!rel) return true;
    const parts = rel.split(path.sep);
    if (parts.some((part) => excludedDirs.has(part))) return false;
    if (!includeNodeModules && parts.includes("node_modules")) return false;
    if (excludedFiles.test(rel)) return false;
    return true;
  };
}

function zipDirectory(source, target) {
  const entries = fs.readdirSync(source);
  try {
    execFileSync("tar", ["-a", "-c", "-f", target, "-C", source, ...entries], { stdio: "pipe" });
    return;
  } catch (error) {
    const safeSource = source.replace(/'/g, "''");
    const safeTarget = target.replace(/'/g, "''");
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${safeSource}\\*' -DestinationPath '${safeTarget}' -Force`,
    ], { stdio: "pipe" });
  }
}

function buildComponent(spec) {
  const source = spec.theme ? ROOT : findPluginDir(spec.name);
  if (!source) {
    console.error(`[release] 跳过 ${spec.name}：未在同级插件目录找到（可用 --plugins-dir 指定）`);
    return null;
  }
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(source, "plugin.json"), "utf8"));
  } catch (error) {
    console.error(`[release] 跳过 ${spec.name}：plugin.json 无法读取`);
    return null;
  }
  const componentVersion = String(meta.version || "").replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(componentVersion)) {
    console.error(`[release] 跳过 ${spec.name}：plugin.json 版本不合法`);
    return null;
  }
  const zipName = `${spec.zipBase}-${componentVersion}.zip`;
  const zipPath = path.join(outDir, zipName);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ag-suite-release-"));
  try {
    fs.cpSync(source, staging, { recursive: true, filter: copyFilter(source, spec.nodeModules) });
    if (spec.theme) {
      fs.mkdirSync(path.join(staging, "config"), { recursive: true });
      fs.writeFileSync(
        path.join(staging, "config", "update.json"),
        `${JSON.stringify({ repo, manifestUrl: "", assetName: zipName, autoCheck: true }, null, 2)}\n`,
        "utf8",
      );
    }
    fs.rmSync(zipPath, { force: true });
    zipDirectory(staging, zipPath);
    const bytes = fs.readFileSync(zipPath);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    return {
      name: spec.name,
      displayName: meta.displayName || spec.name,
      version: componentVersion,
      zipName,
      zipPath,
      sha256,
      bytes: bytes.length,
      zipUrl: `https://github.com/${repo}/releases/download/v${version}/${zipName}`,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

try {
  fs.mkdirSync(outDir, { recursive: true });
  const built = COMPONENTS.map(buildComponent).filter(Boolean);
  const theme = built.find((item) => item.name === pkg.name);
  if (!theme) {
    console.error("[release] 主题插件打包失败");
    process.exit(1);
  }
  const notes = explicitNotes || `Antigravity Suite v${version}: ${built.map((item) => `${item.displayName} v${item.version}`).join(", ")}`;
  const manifest = {
    name: pkg.name,
    displayName: pkg.displayName,
    version,
    publishedAt: new Date().toISOString(),
    notes,
    zipUrl: theme.zipUrl,
    sha256: theme.sha256,
    minAppVersion: "2.28.0",
    components: built.map((item) => ({
      name: item.name,
      displayName: item.displayName,
      version: item.version,
      zipUrl: item.zipUrl,
      sha256: item.sha256,
    })),
  };
  const manifestPath = path.join(outDir, "latest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    repo,
    version,
    outDir,
    manifest: manifestPath,
    components: built.map((item) => ({ name: item.name, version: item.version, zip: item.zipPath, sha256: item.sha256, bytes: item.bytes })),
  }, null, 2));
} catch (error) {
  console.error(`[release] ${error?.message || error}`);
  process.exit(1);
}
