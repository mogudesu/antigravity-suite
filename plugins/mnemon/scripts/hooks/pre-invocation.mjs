#!/usr/bin/env node
/**
 * PreInvocation (Antigravity protocol).
 *
 * Emits { injectSteps: [{ ephemeralMessage }] }: the resident persona/USER/
 * MEMORY block is refreshed on every invocation, together with relevant
 * memories and project documents. It is attached for this turn only (used
 * once, never appended to the conversation history as a visible bubble).
 * Refreshing here—rather than relying only on SessionStart—keeps resumed and
 * long-running conversations grounded in the current persona files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readStdin, parseEvent, findTurnText, findUserTurnText, sessionId, runHook, openStore } from '../lib/hook.mjs';
import * as store from '../lib/store.mjs';

// One user turn fans out into many tool steps and this hook fires on each of
// them; repeating the same ~4.5KB block per step only inflates the context.
const REPEAT_WINDOW_MS = 120000;

function signaturePath() {
  return path.join(store.resolveDataDir(), '.recall-signature.json');
}

function alreadyInjected(signature) {
  try {
    const previous = JSON.parse(fs.readFileSync(signaturePath(), 'utf8'));
    return Boolean(
      previous &&
      previous.signature === signature &&
      Date.now() - Number(previous.at || 0) < REPEAT_WINDOW_MS
    );
  } catch {
    return false;
  }
}

function rememberSignature(signature) {
  try {
    store.writeText(signaturePath(), JSON.stringify({ signature, at: Date.now() }));
  } catch {
    /* recall still works without the dedupe stamp */
  }
}

runHook('pre-invocation', async () => {
  const event = parseEvent(await readStdin());
  const userText = findUserTurnText(event, { min: 8, max: 2 });
  const prompt = (userText.length ? userText : findTurnText(event, { min: 8, max: 2 })).join('\n').trim();
  if (!prompt) return {};

  const signature = `${sessionId(event)}|${createHash('sha1').update(prompt).digest('hex')}`;
  if (alreadyInjected(signature)) return {};

  const engine = openStore({ light: true });
  const context = engine.buildTurnContext({ prompt, session: sessionId(event) });
  const hasResident = Boolean(
    context.persona ||
    context.residentBase ||
    (Array.isArray(context.pinned) && context.pinned.length)
  );
  if (!context.relevant.length && !context.documents.length && !hasResident) return {};

  // The resident persona/USER/MEMORY block is refreshed every invocation, not
  // only at SessionStart: long conversations, resumed sessions and sessions
  // created before the persona was written must still be grounded.
  const block = engine.formatContextBlock(context, { header: 'mnemon-recall', includeUsage: false });
  rememberSignature(signature);
  return { injectSteps: [{ ephemeralMessage: block }] };
});
