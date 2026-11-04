/**
 * Shared helpers for the lifecycle hooks.
 *
 * Hook contract: read the event JSON from stdin, write one JSON object to
 * stdout, always exit 0. A hook that fails is ignored by Antigravity, so every
 * hook here fails open and never throws.
 */
import { openEngine } from './engine.mjs';
import * as store from './store.mjs';

export async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function parseEvent(raw) {
  try {
    const parsed = JSON.parse(String(raw || '').trim() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { raw: String(raw || '') };
  }
}

export function emit(payload) {
  try {
    process.stdout.write(JSON.stringify(payload));
  } catch {
    /* stdout already closed: nothing useful left to do */
  }
}

export function collectStrings(value, out = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    if (value.trim().length >= 8) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
  return out;
}

/** The most substantial strings in an event, longest first. */
export function findTurnText(event, { min = 16, max = 3 } = {}) {
  const strings = collectStrings(event)
    .map((s) => s.trim())
    .filter((s) => s.length >= min)
    .sort((a, b) => b.length - a.length);
  return strings.slice(0, max);
}

const USER_TEXT_KEYS = [
  'userPrompt',
  'userMessage',
  'lastUserInput',
  'lastUserMessage',
  'lastUserPrompt',
  'prompt',
  'request.prompt',
  'request.userMessage',
  'input',
];

/**
 * User-authored text only. Assistant replies and injected system blocks must
 * never be mined for "remember this" style preferences: the model repeating a
 * rule is not the user stating it. Returns [] when the event carries no role
 * information, so callers can decide whether to fall back.
 */
export function findUserTurnText(event, { min = 12, max = 4 } = {}) {
  const found = [];
  for (const key of USER_TEXT_KEYS) {
    const value = pick(event, [key]);
    if (typeof value === 'string') {
      if (value.trim().length >= min) found.push(value.trim());
    } else if (value && typeof value === 'object') {
      collectStrings(value).forEach((s) => { if (s.trim().length >= min) found.push(s.trim()); });
    }
  }
  const buckets = [event?.messages, event?.conversation?.messages, event?.history, event?.turns];
  for (const list of buckets) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (!message || typeof message !== 'object') continue;
      const role = String(message.role || message.author || message.sender || message.type || '').toLowerCase();
      if (!/(user|human|prompt|request)/.test(role)) continue;
      const content = message.content ?? message.text ?? message.parts ?? message.message;
      collectStrings(content).forEach((s) => { if (s.trim().length >= min) found.push(s.trim()); });
    }
  }
  return [...new Set(found)].slice(0, max);
}

export function pick(event, keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), event);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

export function sessionId(event) {
  const value = pick(event, ['sessionId', 'session_id', 'conversationId', 'conversation_id', 'session.id', 'conversation.id']);
  return value ? String(value) : null;
}

export function openStore() {
  // Hooks receive the same --data-dir / --mirror-dir flags as the MCP server,
  // so a hook and the server can never disagree about where memory lives.
  return openEngine({
    dataDir: store.resolveDataDir(),
    mirrorDir: store.resolveMirrorDir(),
    register: !store.hasExplicitStore(),
  });
}

/** Run a hook body, failing open with an empty JSON object. */
export async function runHook(name, body) {
  try {
    const result = await body();
    emit(result || {});
  } catch (error) {
    process.stderr.write(`mnemon ${name} hook: ${error && error.message ? error.message : error}\n`);
    emit({});
  }
  process.exit(0);
}
