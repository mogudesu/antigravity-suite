#!/usr/bin/env node
"use strict";

/**
 * 生成 GitHub Release 资产：
 *   dist/antigravity-starlight-mogu-<version>.zip
 *   dist/latest.json
 *
 * 用法：
 *   node scripts/release.js --repo owner/repo
 *   node scripts/release.js --repo owner/repo --notes "修复壁纸"
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
const notes = String(arg("notes", process.env.RELEASE_NOTES || `Starlight ${version}`)).slice(0, 6000);
const zipName = `antigravity-starlight-mogu-${version}.zip`;
const zipPath = path.join(outDir, zipName);
const manifestPath = path.join(outDir, "latest.json");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ag-starlight-release-"));

const excluded = new Set([".git", ".github", "node_modules", "dist", "snapshots", "__pycache__"]);
const excludedFiles = /(?:^|[\\/])(?:runtime\.json|update-state\.json|.*\.pyc|.*\.log|.*\.tmp|.*\.bak)$/i;

function copyFilter(source) {
  const rel = path.relative(ROOT, source);
  if (!rel) return true;
  const parts = rel.split(path.sep);
  if (parts.some((part) => excluded.has(part))) return false;
  if (excludedFiles.test(rel)) return false;
  return true;
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

try {
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(ROOT, staging, { recursive: true, filter: copyFilter });
  fs.writeFileSync(
    path.join(staging, "config", "update.json"),
    `${JSON.stringify({ repo, manifestUrl: "", assetName: zipName, autoCheck: true }, null, 2)}\n`,
    "utf8",
  );
  fs.rmSync(zipPath, { force: true });
  zipDirectory(staging, zipPath);
  const bytes = fs.readFileSync(zipPath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    name: pkg.name,
    displayName: pkg.displayName,
    version,
    publishedAt: new Date().toISOString(),
    notes,
    zipUrl: `https://github.com/${repo}/releases/download/v${version}/${zipName}`,
    sha256,
    minAppVersion: "2.28.0",
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, repo, version, zip: zipPath, manifest: manifestPath, sha256, bytes: bytes.length }, null, 2));
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
