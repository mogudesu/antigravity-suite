#!/usr/bin/env node
/**
 * Stop (Antigravity protocol).
 *
 * Returns {} — Antigravity's Stop hook takes no decision field (the Claude
 * `{ decision: 'continue' }` shape is invalid here and is not emitted).
 *
 * Active capture runs by default: the finished turn is scanned for durable
 * facts ("remember", "from now on", "I prefer", "change the persona", "we
 * agreed", corrections) and each hit is queued as a candidate. Nothing is
 * written to memory here: candidates are adopted or rejected in /mnemon-review.
 */
import { readStdin, parseEvent, findTurnText, findUserTurnText, sessionId, runHook, openStore } from '../lib/hook.mjs';

const KEEP_PATTERNS = [
  /(记住|以后|今后|从现在起|下次|不要再|别再|总是|一律|一定要|我更喜欢|我偏好|我们约定|约定|默认用|规范是|标准是|人设改成|人设改为|永久记住|置顶)/,
  /(不对|其实|改成|纠正|应该是|更正)/,
  /(remember|from now on|going forward|from here on|always use|never use|i prefer|we agreed|by default|our convention|the convention is|change (?:the|your) persona|pin (?:this|that))/i,
  /(that's wrong|actually|instead of|please correct|correction:)/i,
];

const SKIP_PATTERNS = [
  /^\s*[$>#]/,           // shell prompts and headings
  /```/,                 // code fences
  /https?:\/\//,         // bare links
  /^\s*[{\[]/,           // raw JSON
];

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。．.!?！？；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const ASSISTANT_PREFIXES = /^\s*(好的|收到|明白了|已完成|完成了|搞定|没问题|当然|以下是|我来|我会|接下来|总结一下|让我|Sure\b|Okay\b|Done\b|I've\b|I have\b|Here'?s\b|Here is\b|Let me\b|I'll\b|I will\b)/i;

function candidatesFrom(text, fromUser = true, limit = 5) {
  const found = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.length < 12 || sentence.length > 400) continue;
    if (SKIP_PATTERNS.some((re) => re.test(sentence))) continue;
    // Without an explicit user field the fallback text is probably the model's
    // reply; drop its pleasantries instead of learning them as preferences.
    if (!fromUser && ASSISTANT_PREFIXES.test(sentence)) continue;
    if (!KEEP_PATTERNS.some((re) => re.test(sentence))) continue;
    if (found.some((f) => f.text === sentence)) continue;
    found.push({ text: sentence, reason: 'matched a durable-fact pattern in the finished turn' });
    if (found.length >= limit) break;
  }
  return found;
}

runHook('stop', async () => {
  const event = parseEvent(await readStdin());
  const engine = openStore();
  const config = engine.config();
  const session = sessionId(event);

  if (config.enhancements && config.enhancements.autoCapture) {
    const userText = findUserTurnText(event, { min: 12, max: 4 });
    const fromUser = userText.length > 0;
    const text = (fromUser ? userText : findTurnText(event, { min: 24, max: 4 })).join('\n');
    let queued = 0;
    for (const candidate of candidatesFrom(text, fromUser)) {
      const result = engine.addCandidate({ ...candidate, source: 'auto-capture', sessionId: session });
      if (result.action === 'queued') queued += 1;
    }
    if (queued > 0) engine.recordReceipt({ session, note: `active capture queued ${queued} candidate(s) for review` });
  }

  // Antigravity Stop takes an empty object: no decision, no injected message.
  return {};
});
