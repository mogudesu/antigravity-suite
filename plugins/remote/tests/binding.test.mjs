import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHarness } from '../src/harness/adapter.mjs';

function harnessWith(workbench) {
  return new RemoteHarness({
    workbench,
    index: { get: () => null, list: () => [] },
    state: {},
    logger: { warn() {}, info() {}, error() {} },
  });
}

test('未绑定时自动新开对话，不沿用当前旧对话', async () => {
  const calls = [];
  const harness = harnessWith({
    snapshot: async () => ({ conversationId: 'old-conversation', hasInput: true, busy: false }),
    newConversation: async () => {
      calls.push('new');
      return { ok: true, conversationId: 'new-conversation' };
    },
  });
  assert.equal(await harness._resolveConversation({ id: 'bot-1' }), 'new-conversation');
  assert.deepEqual(calls, ['new']);
});

test('界面停在新建空对话时直接使用，不重复新建', async () => {
  let created = 0;
  const harness = harnessWith({
    snapshot: async () => ({ conversationId: '', hasInput: true, busy: false }),
    newConversation: async () => {
      created += 1;
      return { ok: true, conversationId: 'never' };
    },
  });
  assert.equal(await harness._resolveConversation({ id: 'bot-1' }), '');
  assert.equal(created, 0);
});

test('新开对话失败时回退当前对话，不丢消息', async () => {
  const harness = harnessWith({
    snapshot: async () => ({ conversationId: 'old-conversation', hasInput: true, busy: false }),
    newConversation: async () => ({ ok: false, reason: 'no-button' }),
  });
  assert.equal(await harness._resolveConversation({ id: 'bot-1' }), 'old-conversation');
});
