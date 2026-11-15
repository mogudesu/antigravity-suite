import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Mutex,
  extractEffort,
  modelBaseName,
  modelKey,
  normalizeLiveModels,
  sameModel,
  sameModelExact,
} from '../src/bridge/cdp-executor.mjs';

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

test('extractEffort 与 modelBaseName 处理中英文及 XHigh 思考强度', () => {
  assert.equal(extractEffort('Gemini 4 Hydrogen (XHigh)'), 'xhigh');
  assert.equal(extractEffort('Claude Sonnet 5.5 中 New'), 'medium');
  assert.equal(extractEffort('GPT-OSS 120B (Low) Unavailable'), 'low');
  assert.equal(modelBaseName('Gemini 4 Hydrogen (XHigh) New'), 'Gemini 4 Hydrogen');
  assert.equal(modelKey('Gemini 4 Hydrogen (XHigh)'), 'gemini 4 hydrogen');
});

test('sameModelExact 同时校验基础模型与思考强度', () => {
  assert.equal(sameModelExact('Gemini 4 Hydrogen 高', 'Gemini 4 Hydrogen (High)'), true);
  assert.equal(sameModelExact('Gemini 4 Hydrogen 中', 'Gemini 4 Hydrogen (High)'), false);
  assert.equal(sameModelExact('Gemini 4 Hydrogen (XHigh)', 'Gemini 4 Hydrogen High'), false);
  assert.equal(sameModelExact('Gemini 4 Hydrogen (High)', 'Gemini 4 Hydrogen'), true);
});

test('normalizeLiveModels 过滤禁用/Unavailable 并按组排序与规范化 current', () => {
  const res = normalizeLiveModels({
    currentRaw: 'Gemini 4 Hydrogen 高',
    configs: [
      { label: 'Gemini 4 Hydrogen (Low)', model: 'm1-low', quota: 0.9 },
      { label: 'Gemini 4 Hydrogen (High)', model: 'm1-high', quota: 0.9, tagTitle: 'New' },
      { label: 'Gemini 4 Carbon', model: 'm-disabled', disabled: true, quota: 1 },
      { label: 'Legacy Model', model: 'm-unavail', tagTitle: 'Unavailable', quota: 0.5 },
      { label: 'Claude Sonnet 5.5 (Medium)', model: 'c1', quota: 0.6 },
    ],
    sorts: [
      {
        name: 'Claude',
        groups: [{ modelLabels: ['Claude Sonnet 5.5 (Medium)'] }],
      },
      {
        name: 'Gemini',
        groups: [{ modelLabels: ['Gemini 4 Hydrogen (High)', 'Gemini 4 Hydrogen (Low)'] }],
      },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.source, 'language-server');
  assert.equal(res.current, 'Gemini 4 Hydrogen (High)');
  assert.equal(res.currentRaw, 'Gemini 4 Hydrogen 高');
  assert.deepEqual(res.items, [
    'Claude Sonnet 5.5 (Medium)',
    'Gemini 4 Hydrogen (High)',
    'Gemini 4 Hydrogen (Low)',
  ]);
  assert.equal(res.models.length, 3);
  assert.equal(res.models[1].tag, 'New');
  assert.equal(res.models[1].quota, 0.9);
});
