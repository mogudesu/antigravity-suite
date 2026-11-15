#!/usr/bin/env node
/**
 * SessionStart (Antigravity protocol).
 *
 * Emits { injectSteps: [{ systemMessage: { systemMessage: block } }] }:
 * Antigravity requires the nested systemMessage object. Context formatting is
 * deterministic so identical vault state produces byte-identical prefix blocks.
 */
import { readStdin, runHook, openStore } from '../lib/hook.mjs';

runHook('session-start', async () => {
  await readStdin();
  const engine = openStore();
  const context = engine.buildTurnContext({ prompt: '', deterministic: true });
  const block = engine.formatContextBlock(context, { header: 'mnemon-session', deterministic: true });
  return { injectSteps: [{ systemMessage: { systemMessage: block } }] };
});
