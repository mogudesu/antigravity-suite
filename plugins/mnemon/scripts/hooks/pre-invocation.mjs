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
import { readStdin, parseEvent, findTurnText, findUserTurnText, sessionId, runHook, openStore } from '../lib/hook.mjs';

runHook('pre-invocation', async () => {
  const event = parseEvent(await readStdin());
  const userText = findUserTurnText(event, { min: 8, max: 2 });
  const prompt = (userText.length ? userText : findTurnText(event, { min: 8, max: 2 })).join('\n').trim();
  if (!prompt) return {};

  const engine = openStore();
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
  return { injectSteps: [{ ephemeralMessage: block }] };
});
