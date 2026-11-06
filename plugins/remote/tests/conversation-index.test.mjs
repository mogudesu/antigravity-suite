import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ConversationIndex, decodeWorkspace } from '../src/bridge/conversation-index.mjs';
import { paths } from '../src/store/paths.mjs';

test('decodeWorkspace 还原盘符路径', () => {
  assert.equal(decodeWorkspace('file:///f%3A/AI/nocode/nocode'), 'F:/AI/nocode/nocode');
  assert.equal(decodeWorkspace('file:///f:/AI/nocode/nocode'), 'F:/AI/nocode/nocode');
});

const hasDb = fs.existsSync(paths().summariesDb);

test('读真实会话索引：有标题、工作区与状态', { skip: !hasDb && '本机没有 conversation_summaries.db' }, () => {
  const index = new ConversationIndex();
  const items = index.list({ limit: 5 });
  assert.ok(items.length > 0, '应该至少有一个会话');
  const first = items[0];
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.ok(['idle', 'running', 'waiting', 'queued', 'unknown'].includes(first.status));
  assert.ok(first.title.length >= 0);
  assert.ok(first.lastModified);
  // 按时间倒序
  if (items.length > 1) assert.ok(items[0].lastModified >= items[1].lastModified);
  index.close();
});

test('按工作区过滤', { skip: !hasDb && '本机没有 conversation_summaries.db' }, () => {
  const index = new ConversationIndex();
  const all = index.list({ limit: 50 });
  const withWs = all.find((item) => item.workspace);
  if (withWs) {
    const filtered = index.list({ limit: 50, workspace: withWs.workspace });
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every((item) => item.workspaces.includes(withWs.workspace)));
  }
  index.close();
});

test('get() 返回单个会话', { skip: !hasDb && '本机没有 conversation_summaries.db' }, () => {
  const index = new ConversationIndex();
  const [first] = index.list({ limit: 1 });
  const one = index.get(first.id);
  assert.equal(one.id, first.id);
  assert.equal(index.get('not-exist-id'), null);
  index.close();
});
