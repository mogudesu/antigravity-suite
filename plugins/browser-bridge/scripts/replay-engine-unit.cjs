'use strict';
/**
 * 回放引擎纯逻辑单测：参数插值、过滤器、数组保留、嵌套步骤插值。
 * 不启动浏览器，可随时运行：node scripts/replay-engine-unit.cjs
 */
const assert = require('assert');
const {
  interpolateString,
  interpolateValue,
  interpolateSteps,
} = require('../mcp-server/recordings.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + '  —— ' + e.message);
  }
}

check('基础 {{key}} 替换', () => {
  assert.strictEqual(interpolateString('q={{keyword}}', { keyword: '机械键盘' }, {}), 'q=机械键盘');
});

check('未在 vars 时使用参数默认值', () => {
  const defs = { keyword: { default: '今日科技热点' } };
  assert.strictEqual(interpolateString('{{keyword}}', {}, defs), '今日科技热点');
});

check('未知变量原样保留给运行时', () => {
  assert.strictEqual(interpolateString('{{item}}/{{index}}', {}, {}), '{{item}}/{{index}}');
});

check('过滤器 url / json / upper', () => {
  const vars = { term: '发光 蘑菇', obj: { a: 1 } };
  assert.strictEqual(interpolateString('{{term|url}}', vars, {}), encodeURIComponent('发光 蘑菇'));
  assert.strictEqual(interpolateString('{{obj|json}}', vars, {}), '{"a":1}');
  assert.strictEqual(interpolateString('{{term|upper}}', vars, {}), '发光 蘑菇');
});

check('整串 {{arrayVar}} 保留数组类型（loop.items 关键）', () => {
  const terms = ['one', 'two', 'three'];
  const v = interpolateValue('{{terms}}', { terms }, {});
  assert.ok(Array.isArray(v));
  assert.deepStrictEqual(v, terms);
});

check('对象深度插值与数组元素插值', () => {
  const vars = { keyword: 'abc', terms: ['x', 'y'] };
  const out = interpolateValue({ url: '?q={{keyword}}', items: '{{terms}}', nested: { text: '{{keyword}}' } }, vars, {});
  assert.strictEqual(out.url, '?q=abc');
  assert.deepStrictEqual(out.items, ['x', 'y']);
  assert.strictEqual(out.nested.text, 'abc');
});

check('嵌套子步骤也被插值，未定义变量保留', () => {
  const steps = [{
    type: 'loop', items: '{{terms}}', var: 'term', synthesized: true,
    steps: [
      { type: 'type', value: '{{term}}' },
      { type: 'assert', expression: '(() => v === {{term|json}})()' },
      { type: 'note', note: '{{missing}}' },
    ],
  }];
  const out = interpolateSteps(steps, { terms: ['a b', 'c'] }, {});
  assert.deepStrictEqual(out[0].items, ['a b', 'c']);
  assert.strictEqual(out[0].steps[0].value, '{{term}}');
  assert.strictEqual(out[0].steps[1].expression, '(() => v === {{term|json}})()');
  assert.strictEqual(out[0].steps[2].note, '{{missing}}');
});

check('非字符串字段保持原类型', () => {
  const out = interpolateSteps([{ type: 'throttle', ms: 1500, soft: false, count: 3 }], {}, {});
  assert.strictEqual(out[0].ms, 1500);
  assert.strictEqual(out[0].soft, false);
  assert.strictEqual(out[0].count, 3);
});

check('vars 覆盖默认值', () => {
  const defs = { keyword: { default: '默认词' } };
  assert.strictEqual(interpolateString('{{keyword}}', { keyword: '新词' }, defs), '新词');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
