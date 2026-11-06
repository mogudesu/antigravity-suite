import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranscriptWatcher, extractUserRequest, stripUserMetadata } from '../src/bridge/transcript-watcher.mjs';

function makeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-tr-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return { dir, file };
}

const USER = {
  step_index: 0,
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  status: 'DONE',
  content: '<USER_REQUEST>\n修一下登录\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>',
};
const PLANNER = {
  step_index: 1,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  content: '先看 auth.js',
  thinking: '需要定位登录入口',
  tool_calls: [{ name: 'read_file', args: { Path: 'auth.js' } }],
};
const FINAL = {
  step_index: 3,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  content: '改好了，`auth.js` 里补了空值判断。',
};

test('extractUserRequest 去掉包裹与元数据', () => {
  assert.equal(extractUserRequest(USER.content), '修一下登录');
  assert.equal(stripUserMetadata(USER.content), '修一下登录');
});

test('watcher 汇总最终答复与过程', async () => {
  const { file, dir } = makeTranscript([USER, PLANNER, FINAL]);
  const watcher = new TranscriptWatcher({ file, pollMs: 50 });
  watcher.start();
  await new Promise((r) => setTimeout(r, 150));
  watcher.stop();

  assert.equal(watcher.steps.length, 3);
  assert.equal(watcher.finalAnswer(), '改好了，`auth.js` 里补了空值判断。');
  const progress = watcher.progress();
  assert.ok(progress.thinking.includes('登录入口'));
  assert.equal(progress.tools[0].name, 'read_file');
  assert.equal(progress.running, false);
  assert.ok(watcher.isSettled());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watcher 增量追加只发新步骤', async () => {
  const { file, dir } = makeTranscript([USER, PLANNER]);
  const watcher = new TranscriptWatcher({ file, pollMs: 40 });
  const seen = [];
  watcher.on('step', (step) => seen.push(step.step_index));
  watcher.start();
  await new Promise((r) => setTimeout(r, 120));
  fs.appendFileSync(file, `${JSON.stringify(FINAL)}\n`);
  await new Promise((r) => setTimeout(r, 200));
  watcher.stop();
  assert.deepEqual(seen, [0, 1, 3]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('truncated content 会从 full 文件回补', async () => {
  const { file, dir } = makeTranscript([
    USER,
    { ...FINAL, content: '截断…', truncated_fields: ['content'] },
  ]);
  const full = path.join(dir, 'transcript_full.jsonl');
  fs.writeFileSync(full, `${JSON.stringify({ ...FINAL, content: '完整正文'.repeat(50) })}\n`);
  const watcher = new TranscriptWatcher({ file, pollMs: 40 });
  watcher.start();
  await new Promise((r) => setTimeout(r, 150));
  watcher.stop();
  assert.ok(watcher.finalAnswer().length > 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('RUNNING 步骤视为未结束', async () => {
  const { file, dir } = makeTranscript([
    USER,
    { ...PLANNER, status: 'RUNNING', content: '' },
  ]);
  const watcher = new TranscriptWatcher({ file, pollMs: 40 });
  watcher.start();
  await new Promise((r) => setTimeout(r, 150));
  watcher.stop();
  assert.equal(watcher.progress().running, true);
  assert.equal(watcher.isSettled(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
