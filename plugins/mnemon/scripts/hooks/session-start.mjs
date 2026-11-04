#!/usr/bin/env node
/**
 * SessionStart (Antigravity protocol).
 *
 * Emits { injectSteps: [{ systemMessage }] }: the persona volume, the resident
 * memory block, pinned memories and the on-demand sources are attached as a
 * system message, so Antigravity never renders a fake user bubble.
 */
import { readStdin, runHook, openStore } from '../lib/hook.mjs';

runHook('session-start', async () => {
  await readStdin();
  const engine = openStore();
  const context = engine.buildTurnContext({ prompt: '' });
  const lines = [engine.formatContextBlock(context, { header: 'mnemon-session' })];
  if (context.pinned.length) lines.push(`${context.pinned.length} pinned memory item(s) are permanent and never become stale.`);
  const pending = context.counts.pendingCandidates;
  if (pending > 0) lines.push(`${pending} candidate fact(s) are queued for review — run /mnemon-review to adopt or reject them.`);
  return { injectSteps: [{ systemMessage: lines.join('\n') }] };
});
