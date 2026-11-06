import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, helpText, menuText, runCommand, listWorkspaces } from '../src/harness/commands.mjs';

test('parseCommand 识别命令与别名', () => {
  assert.deepEqual(parseCommand('/status'), { command: 'status', arg: '' });
  assert.deepEqual(parseCommand('/m'), { command: 'menu', arg: '' });
  assert.deepEqual(parseCommand('/model 2'), { command: 'model', arg: '2' });
  assert.deepEqual(parseCommand('  /ws 3  '), { command: 'ws', arg: '3' });
  assert.equal(parseCommand('普通消息'), null);
  assert.equal(parseCommand('/unknown'), null);
});

test('helpText 列出全部命令', () => {
  const text = helpText();
  for (const cmd of ['/help', '/menu', '/new', '/ws', '/sessions', '/model', '/status', '/stop', '/steer', '/compact', '/history']) {
    assert.ok(text.includes(cmd), `缺少 ${cmd}`);
  }
});

test('menuText 有 6 个选项', () => {
  const text = menuText();
  for (const n of ['1.', '2.', '3.', '4.', '5.', '6.']) assert.ok(text.includes(n));
});

function fakeCtx(overrides = {}) {
  const state = {
    binding: { conversationId: 'conv-1', title: '对话一', model: 'Gemini 3.8 Flash 高' },
    getBinding: () => overrides.binding || { conversationId: 'conv-1', title: '对话一', model: 'Gemini 3.8 Flash 高' },
    setBinding: (botId, chatId, value) => {
      state.lastSet = value;
      return value;
    },
  };
  const index = {
    brainDir: '/tmp',
    get: () => ({ id: 'conv-1', title: '对话一', status: 'idle' }),
    statusOf: () => 'idle',
    list: () => [
      { id: 'conv-1', title: '对话一', status: 'idle', workspaces: ['F:/AI/nocode/nocode'], lastModified: '2026-11-01' },
      { id: 'conv-2', title: '对话二', status: 'idle', workspaces: ['F:/AI/nocode/nocode'], lastModified: '2026-10-30' },
    ],
  };
  const harness = { runs: new Map(), isRunning: () => false, submit: async () => ({ ok: true, answer: 'ok' }) };
  const workbench = {
    mutex: { run: (fn) => fn() },
    listModels: async () => ({
      ok: true,
      current: 'Gemini 3.8 Flash 高',
      items: ['Gemini 3.8 Flash 高', 'Claude Sonnet 5.5 中'],
    }),
    ensure: async () => ({ evaluate: async () => ({ ok: true, current: 'Gemini 3.8 Flash 高', items: [{ label: 'Gemini 3.8 Flash 高' }, { label: 'Claude Sonnet 5.5 中' }] }) }),
    newConversation: async ({ model }) => ({ ok: true, conversationId: 'conv-new', model }),
    stopGeneration: async () => ({ ok: true }),
    currentConversationId: async () => 'conv-1',
    sendPrompt: async () => ({ ok: true }),
    _selectModel: async (label) => ({ ok: true, current: label }),
  };
  return { workbench, index, state, bot: { id: 'bot-1', platform: 'feishu', alias: '测试', defaultWorkspace: 'F:/AI/nocode/nocode' }, chatId: 'chat-1', harness, ...overrides };
}

test('/status 显示绑定与模型', async () => {
  const result = await runCommand({ text: '/status', ctx: fakeCtx() });
  assert.equal(result.handled, true);
  assert.ok(result.reply.includes('对话一'));
  assert.ok(result.reply.includes('Gemini 3.8 Flash 高'));
  assert.ok(result.reply.includes('idle'));
});

test('/new 建会话并写绑定', async () => {
  const ctx = fakeCtx();
  const result = await runCommand({ text: '/new 新任务', ctx });
  assert.ok(result.reply.includes('已新建会话'));
  assert.equal(ctx.state.lastSet.conversationId, 'conv-new');
  assert.equal(ctx.state.lastSet.title, '新任务');
});

test('/sessions 列出会话并标记当前', async () => {
  const result = await runCommand({ text: '/sessions', ctx: fakeCtx() });
  assert.ok(result.reply.includes('对话一'));
  assert.ok(result.reply.includes('●'));
});

test('/session 2 接管第二个会话', async () => {
  const ctx = fakeCtx();
  await runCommand({ text: '/session 2', ctx });
  assert.equal(ctx.state.lastSet.conversationId, 'conv-2');
});

test('/models 列出模型', async () => {
  const result = await runCommand({ text: '/models', ctx: fakeCtx() });
  assert.ok(result.reply.includes('Gemini 3.8 Flash 高'));
  assert.ok(result.reply.includes('Claude Sonnet 5.5 中'));
});

test('/stop 返回已中止', async () => {
  const result = await runCommand({ text: '/stop', ctx: fakeCtx() });
  assert.ok(result.reply.includes('已请求中止'));
});

test('/help 与 /menu', async () => {
  assert.ok((await runCommand({ text: '/help', ctx: fakeCtx() })).reply.includes('/status'));
  const menu = await runCommand({ text: '/menu', ctx: fakeCtx() });
  assert.equal(menu.action, 'menu');
});

test('非命令不处理', async () => {
  const result = await runCommand({ text: '你好', ctx: fakeCtx() });
  assert.equal(result.handled, false);
});

test('listWorkspaces 汇总去重', () => {
  const workspaces = listWorkspaces(fakeCtx().index);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].count, 2);
});
