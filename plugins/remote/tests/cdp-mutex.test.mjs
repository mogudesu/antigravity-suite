import test from 'node:test';
import assert from 'node:assert/strict';
import { Mutex, modelKey, sameModel } from '../src/bridge/cdp-executor.mjs';

test('Mutex 严格串行，不重叠', async () => {
  const mutex = new Mutex();
  const events = [];
  const task = (name, ms) =>
    mutex.run(async () => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      events.push(`${name}:end`);
    });

  await Promise.all([task('a', 40), task('b', 10), task('c', 5)]);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});

test('Mutex 前一个任务抛错也不阻塞后续', async () => {
  const mutex = new Mutex();
  await assert.rejects(mutex.run(async () => { throw new Error('boom'); }));
  const value = await mutex.run(async () => 42);
  assert.equal(value, 42);
});

test('Mutex 并发 20 个任务不交错', async () => {
  const mutex = new Mutex();
  let active = 0;
  let maxActive = 0;
  const jobs = Array.from({ length: 20 }, () =>
    mutex.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    }),
  );
  await Promise.all(jobs);
  assert.equal(maxActive, 1, `出现了并发：maxActive=${maxActive}`);
});

test('modelKey 忽略思考强度与角标', () => {
  assert.equal(modelKey('Claude Sonnet 5.5 中 New'), 'claude sonnet 5.5');
  assert.equal(modelKey('Claude Sonnet 5.5 高'), 'claude sonnet 5.5');
  assert.equal(modelKey('GPT-OSS 120B (Medium)'), 'gpt-oss 120b');
  assert.equal(modelKey('Gemini 3.8 Flash 高'), 'gemini 3.8 flash');
});

test('sameModel 只在模型相同（忽略强度）时为真', () => {
  assert.equal(sameModel('Claude Sonnet 5.5 高', 'Claude Sonnet 5.5 中'), true);
  assert.equal(sameModel('Gemini 4 Argon 高', 'Gemini 3.8 Flash 高'), false);
  assert.equal(sameModel('', 'x'), false);
  assert.equal(sameModel('Claude Opus 5.5', 'Claude Sonnet 5.5'), false);
});
