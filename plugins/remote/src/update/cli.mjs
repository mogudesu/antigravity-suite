#!/usr/bin/env node
import { useSystemProxy, checkForUpdate, applyUpdate, readInstalledVersion } from './updater.mjs';

useSystemProxy();

const command = String(process.argv[2] || 'check').toLowerCase();
const options = {
  currentVersion: readInstalledVersion(),
  manifestUrl: process.env.AG_REMOTE_UPDATE_MANIFEST || undefined,
  allowLocal: process.env.AG_REMOTE_UPDATE_ALLOW_LOCAL === '1',
};

try {
  const result = command === 'apply' ? await applyUpdate(options) : await checkForUpdate(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, updated: false, error: error?.message || String(error) })}\n`);
}
