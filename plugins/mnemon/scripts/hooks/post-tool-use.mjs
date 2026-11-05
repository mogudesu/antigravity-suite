#!/usr/bin/env node
/**
 * PostToolUse: the turn memory bar.
 *
 * After any mnemon_memory_* tool call, append a one-line receipt to the tool
 * result and record it, so the conversation shows what memory the turn touched.
 * If the original result cannot be read from the event, the hook leaves the
 * result untouched rather than risk replacing it.
 */
import { readStdin, parseEvent, pick, sessionId, runHook, openStore } from '../lib/hook.mjs';

function asJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value;
  return null;
}

function summarize(toolName, payload) {
  const short = String(toolName || 'memory').replace(/^mcp:/, '').replace(/^mnemon_memory_/, '');
  const data = asJson(payload);
  if (!data) return `${short}: recorded`;
  if (typeof data.action === 'string') {
    const where = data.space ? ` → space ${data.space}` : data.to ? ` → space ${data.to}` : '';
    const what = data.id || data.memoryId || '';
    return `${short}: ${data.action}${what ? ` ${what}` : ''}${where}`;
  }
  if (Array.isArray(data.hits)) return `${short}: recalled ${data.hits.length} memory hit(s)`;
  if (Array.isArray(data.items)) return `${short}: ${data.items.length} item(s)`;
  if (typeof data.total === 'number') return `${short}: ${data.total} item(s)`;
  return `${short}: done`;
}

runHook('post-tool-use', async () => {
  const event = parseEvent(await readStdin());
  const toolName = pick(event, ['toolName', 'tool_name', 'name', 'tool.name']);
  const rawResult = pick(event, ['toolResult', 'tool_result', 'result', 'output', 'tool.output']);
  const rawInput = pick(event, ['toolInput', 'tool_input', 'arguments', 'tool.input']);

  const engine = openStore({ light: true });
  const receipt = summarize(toolName, rawResult ?? rawInput);
  engine.recordReceipt({ session: sessionId(event), read: [], wrote: [], note: receipt });

  if (typeof rawResult !== 'string' || !rawResult.trim()) return {};
  return { overwriteResult: `${rawResult.trimEnd()}\n\n[mnemon] ${receipt}` };
});
