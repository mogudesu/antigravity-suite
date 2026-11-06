import test from 'node:test';
import assert from 'node:assert/strict';
import { splitText, toPlainText, stripMentions, Dedupe, mentionsBot } from '../src/channels/shared/text.mjs';

test('splitText 短文本原样返回', () => {
  assert.deepEqual(splitText('hello', 100), ['hello']);
  assert.deepEqual(splitText('   ', 100), []);
});

test('splitText 按行切分且不超限', () => {
  const body = Array.from({ length: 120 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  const chunks = splitText(body, 300);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 320, `超长：${chunk.length}`);
});

test('splitText 断开代码块时补 fence', () => {
  const body = `前言\n\`\`\`js\n${Array.from({ length: 60 }, (_, i) => `console.log(${i})`).join('\n')}\n\`\`\`\n结尾`;
  const chunks = splitText(body, 200);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0, -1)) {
    assert.equal(chunk.split('```').length % 2, 1, `代码块没闭合：${chunk.slice(-40)}`);
  }
});

test('toPlainText 去掉 Markdown 语法', () => {
  const md = '# 标题\n**粗** *斜* `code`\n- 项\n> 引用\n```js\nlet a=1\n```';
  const text = toPlainText(md);
  assert.ok(!text.includes('**'));
  assert.ok(!text.includes('```'));
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('let a=1'));
});

test('stripMentions 去掉 @占位符', () => {
  assert.equal(stripMentions('@_user_1 看一下', ['@_user_1']), '看一下');
});

test('Dedupe 只放行一次', () => {
  const dedupe = new Dedupe(3);
  assert.equal(dedupe.check('a'), true);
  assert.equal(dedupe.check('a'), false);
  assert.equal(dedupe.check('b'), true);
  assert.equal(dedupe.check(''), true); // 空 id 不拦
});

test('mentionsBot 判定', () => {
  assert.equal(mentionsBot([{ type: 'at', data: { qq: '1' } }], '1'), true);
  assert.equal(mentionsBot([{ type: 'text', data: { text: 'hi' } }], '1', ''), false);
  assert.equal(mentionsBot([], '1', '[CQ:at,qq=1] hi'), true);
  assert.equal(mentionsBot([], '', ''), true); // 不知道 selfId 时不拦
});
