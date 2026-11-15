#!/usr/bin/env node
/**
 * PreInvocation (Antigravity protocol).
 *
 * Resident context is injected once at SessionStart and stays cache-stable
 * across all turns. Injecting ephemeralMessage on PreInvocation churns the
 * prompt cache prefix on every step, so this hook returns {} by default and
 * keeps any per-session signature stamps isolated under signatures/<sid>.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readStdin, parseEvent, findUserTurnText, sessionId, runHook } from '../lib/hook.mjs';
import * as store from '../lib/store.mjs';

const MAX_SIGNATURE_FILES = 50;

function signaturePath(sid) {
  const cleanId = store.slugify(sid || 'default', 'default');
  return path.join(store.resolveDataDir(), 'signatures', `${cleanId}.json`);
}

function pruneOldSignatures(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => {
        const full = path.join(dir, d.name);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of entries.slice(MAX_SIGNATURE_FILES)) {
      store.removeFile(stale.full);
    }
  } catch {
    /* best effort cleanup */
  }
}

function rememberSessionSignature(sid, signature) {
  try {
    const file = signaturePath(sid);
    const dir = path.dirname(file);
    store.ensureDir(dir);
    store.writeText(file, JSON.stringify({ sessionId: sid, signature, at: Date.now() }));
    pruneOldSignatures(dir);
  } catch {
    /* ignore */
  }
}

runHook('pre-invocation', async () => {
  const event = parseEvent(await readStdin());
  const userText = findUserTurnText(event, { min: 1, max: 2 });
  if (!userText.length) return {};

  const sid = sessionId(event);
  const signature = `${sid}|${createHash('sha1').update(userText.join('\n')).digest('hex')}`;
  rememberSessionSignature(sid, signature);
  return {};
});
