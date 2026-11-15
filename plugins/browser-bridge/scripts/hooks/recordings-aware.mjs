#!/usr/bin/env node
/**
 * Antigravity lifecycle hook（SessionStart / PreInvocation）。
 *
 * 目标：录制完成后不需要用户主动问「看到刚才的录制了吗」——
 * 只要出现新的录制文件，就在下一轮模型调用前注入一条 ephemeral 提示，
 * 让 Agent 知道最新录制的 recordingId、标题、步数和轨迹路径。
 *
 * 契约：stdin 读事件 JSON，stdout 输出一个 JSON 对象，永远 exit 0（失败即静默）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TITLE_MAX = 60;
const INTENT_WINDOW_MS = 10 * 60 * 1000;
const SESSION_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

const RECORDINGS_DIR = process.env.AG_BRIDGE_RECORDINGS_DIR ||
  path.join(os.homedir(), '.gemini', 'memory', 'browser-bridge', 'recordings');
const STATE_FILE = path.join(path.dirname(RECORDINGS_DIR), 'recording-hook-state.json');

function quiet(payload = {}) {
  try {
    process.stdout.write(JSON.stringify(payload));
  } catch {
    /* stdout 已关闭 */
  }
  process.exit(0);
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function parseEvent(raw) {
  try {
    const parsed = JSON.parse(String(raw || '').trim() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* 状态写失败只影响去重，不影响提示 */
  }
}

function latestRecording() {
  let entries;
  try {
    entries = fs.readdirSync(RECORDINGS_DIR).filter((name) => name.toLowerCase().endsWith('.json'));
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    const file = path.join(RECORDINGS_DIR, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, name, mtimeMs: stat.mtimeMs };
    } catch {
      /* 跳过读不到的条目 */
    }
  }
  if (!best) return null;
  let recording = {};
  try {
    recording = JSON.parse(fs.readFileSync(best.file, 'utf8')) || {};
  } catch {
    recording = {};
  }
  const steps = Array.isArray(recording.steps) ? recording.steps : [];
  return {
    id: String(recording.recordingId || best.name.replace(/\.json$/i, '')),
    title: String(recording.title || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX),
    stepCount: steps.length,
    stoppedAt: recording.stoppedAt || new Date(best.mtimeMs).toISOString(),
    file: best.file,
    mtimeMs: best.mtimeMs,
  };
}

function userPrompt(event) {
  const keys = ['lastUserInput', 'userPrompt', 'lastUserMessage', 'lastUserPrompt', 'prompt'];
  for (const key of keys) {
    const value = event && event[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const list of [event && event.messages, event && event.history, event && event.turns]) {
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const msg = list[i];
      if (!msg || typeof msg !== 'object') continue;
      const role = String(msg.role || msg.author || '').toLowerCase();
      if (!/user|human|prompt/.test(role)) continue;
      const content = msg.content ?? msg.text;
      if (typeof content === 'string' && content.trim()) return content.trim();
    }
  }
  return '';
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function summary(rec) {
  const when = formatWhen(rec.stoppedAt);
  return `rec=${rec.id} · 《${rec.title || '未命名录制'}》 · ${rec.stepCount} 步${when ? " · " + when : ""}`;
}

function hint(rec) {
  return [
    `[browser-bridge] ${summary(rec)}`,
    `轨迹文件：${rec.file}`,
    '如需读取/回放/编译 Skill：先 browser_record_list(action="get", recordingId="latest") 读轨迹，',
    '回放用 browser_record_replay(recordingId="latest")；用户没提录制时不要主动执行。',
  ].join('\n');
}

function recordNotified(state, sessions, sess, sessionKey, rec, markIntent) {
  const now = Date.now();
  const prevIds = (sess.notifiedIds && typeof sess.notifiedIds === 'object') ? sess.notifiedIds : {};
  const nextIds = Object.assign({}, prevIds, { [rec.id]: now });
  const idKeys = Object.keys(nextIds);
  if (idKeys.length > 50) {
    idKeys.sort((a, b) => Number(nextIds[a] || 0) - Number(nextIds[b] || 0));
    for (let i = 0; i < idKeys.length - 50; i += 1) delete nextIds[idKeys[i]];
  }
  const nextSessions = Object.assign({}, sessions, {
    [sessionKey]: {
      lastNotifiedId: rec.id,
      lastNotifiedMtime: Math.max(Number(sess.lastNotifiedMtime || 0), rec.mtimeMs),
      notifiedIds: nextIds,
      intentNotify: markIntent ? { id: rec.id, at: now } : sess.intentNotify,
      updatedAt: now,
    },
  });
  const keys = Object.keys(nextSessions);
  if (keys.length > 50) {
    keys.sort((a, b) => Number(nextSessions[a].updatedAt || 0) - Number(nextSessions[b].updatedAt || 0));
    for (let i = 0; i < keys.length - 50; i += 1) delete nextSessions[keys[i]];
  }
  const next = Object.assign({}, state, {
    lastNotifiedId: rec.id,
    lastNotifiedMtime: Math.max(Number(state.lastNotifiedMtime || 0), rec.mtimeMs),
    sessions: nextSessions,
  });
  writeState(next);
}

async function main() {
  const event = parseEvent(await readStdin());
  const hookName = String(
    event.hook_event_name || event.hookEventName || event.eventName || event.event || event.hook || event.name || ''
  ).trim().toLowerCase();
  const rec = latestRecording();
  if (!rec) return quiet();

  const prompt = userPrompt(event);
  const sessionKey = String(
    event.sessionId || event.session_id || event.conversationId || event.conversation_id || 'default'
  ).replace(/[^a-zA-Z0-9._-]/g, '_');
  const intent = /录制|录了|录好|录屏|回放|复现|生成.{0,6}skill|刚才.{0,6}操作|record|replay/i.test(prompt);
  const state = readState();
  const sessions = (state.sessions && typeof state.sessions === 'object') ? state.sessions : {};
  const sess = sessions[sessionKey] || {};
  const notifiedIds = (sess.notifiedIds && typeof sess.notifiedIds === 'object') ? sess.notifiedIds : {};
  const alreadyNotifiedInSession = Boolean(notifiedIds[rec.id]) || sess.lastNotifiedId === rec.id;

  const isSessionStart =
    hookName === 'sessionstart' ||
    hookName === 'session_start' ||
    hookName.includes('sessionstart') ||
    hookName.includes('session_start');

  if (isSessionStart) {
    // 新会话里给一次嵌套格式系统提示；只提示一周内的录制，且同一会话同一录制不重复注入
    if (Date.now() - rec.mtimeMs > SESSION_FRESH_MS) return quiet();
    if (alreadyNotifiedInSession) return quiet();
    recordNotified(state, sessions, sess, sessionKey, rec, false);
    return quiet({ injectSteps: [{ systemMessage: { systemMessage: hint(rec) } }] });
  }

  // 普通工具续跑（无新用户输入或明确标注工具继续）不注入 ephemeralMessage，避免破坏提示词缓存
  const isToolContinuation =
    !prompt ||
    event.isToolContinuation === true ||
    String(event.turnType || event.trigger || '').toLowerCase() === 'tool_result';
  if (isToolContinuation) return quiet();

  // 同一会话对同一 recordingId 仅通知一次（无论 SessionStart 或 PreInvocation）
  if (alreadyNotifiedInSession) return quiet();

  const ageMs = Date.now() - rec.mtimeMs;
  const isFreshNew = ageMs <= INTENT_WINDOW_MS && rec.mtimeMs > Number(sess.lastNotifiedMtime || state.lastNotifiedMtime || 0);
  if (!isFreshNew && !intent) return quiet();

  recordNotified(state, sessions, sess, sessionKey, rec, intent);
  return quiet({ injectSteps: [{ ephemeralMessage: hint(rec) }] });
}

main().catch(() => quiet());
