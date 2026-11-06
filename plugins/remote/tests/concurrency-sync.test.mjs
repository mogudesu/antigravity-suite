import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/bridge/cdp-executor.mjs';
import { RemoteHarness } from '../src/harness/adapter.mjs';
import { SessionSync } from '../src/harness/session-sync.mjs';
import { FeishuBot } from '../src/channels/feishu/feishu-bot.mjs';
import { QQOfficialBot } from '../src/channels/qq/qq-official-bot.mjs';
import { OneBotChannel } from '../src/channels/qq/qq-onebot-bot.mjs';
import { WeixinBot } from '../src/channels/weixin/weixin-bot.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeState() {
  const bindings = new Map();
  return {
    bots: [],
    listBots() {
      return this.bots;
    },
    getBinding(botId, chatId) {
      return bindings.get(`${botId}:${chatId}`) || null;
    },
    setBinding(botId, chatId, value) {
      bindings.set(`${botId}:${chatId}`, value);
      return value;
    },
    listBindings() {
      return [...bindings.entries()].map(([key, value]) => ({ key, chatId: key.slice(key.indexOf(':') + 1), ...value }));
    },
    addDeferred() {},
    takeDeferred() {
      return [];
    },
    get deferredCount() {
      return 0;
    },
  };
}

const fakeIndex = {
  brainDir: '',
  list: () => [{ id: 'conv-1', title: '会话一', workspace: '', status: 'idle' }],
  statusOf: () => 'idle',
  get: () => ({ id: 'conv-1', status: 'idle' }),
  transcriptPath: (id) => path.join(os.tmpdir(), `${id}.jsonl`),
};

test('三个聊天同一毫秒提交，界面动作严格串行（零串台）', async () => {
  const workbench = new Workbench();
  let active = 0;
  let maxActive = 0;
  workbench._switchTo = async (id) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(15);
    active -= 1;
    return { ok: true, id };
  };
  workbench._submit = async (text) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(15);
    active -= 1;
    return { ok: true, text };
  };
  workbench.snapshot = async () => ({ conversationId: 'conv-1', model: 'M' });
  workbench.newConversation = async () => ({ ok: true, conversationId: 'conv-1' });

  const harness = new RemoteHarness({ workbench, index: fakeIndex, state: makeState(), logger: { warn() {}, info() {}, debug() {} } });
  harness._watch = async () => ({ ok: true, answer: 'done', progress: {}, timedOut: false });

  const bots = [1, 2, 3].map((n) => ({ id: `bot-${n}`, platform: 'feishu', defaultWorkspace: '' }));
  const results = await Promise.all(
    bots.map((bot, i) =>
      harness.submit({ bot, chatId: `chat-${i}`, text: `问题 ${i}`, mode: 'queue' }),
    ),
  );

  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(maxActive, 1, `出现并发：maxActive=${maxActive}`);
});

test('同一会话第二次提交会先等前一轮结束（排队模式）', async () => {
  const workbench = new Workbench();
  workbench._submit = async () => ({ ok: true });
  workbench.snapshot = async () => ({ conversationId: 'conv-1', model: '' });
  workbench._switchTo = async () => ({ ok: true });

  const state = makeState();
  state.setBinding('bot-1', 'chat-1', { conversationId: 'conv-1', model: '' });
  const harness = new RemoteHarness({ workbench, index: fakeIndex, state, logger: { warn() {}, info() {}, debug() {} } });
  harness._watch = async () => ({ ok: true, answer: 'x', progress: {}, timedOut: false });

  let waited = 0;
  harness._waitIdle = async () => {
    waited += 1;
    return true;
  };
  // 手动占住这个会话，模拟"正在跑"
  harness.runs.set('conv-1', { startedAt: Date.now(), botId: 'bot-1', chatId: 'chat-1' });

  const bot = { id: 'bot-1', platform: 'feishu' };
  await harness.submit({ bot, chatId: 'chat-1', text: '第二句', mode: 'queue' });
  assert.equal(waited, 1, '排队模式应该先等 idle');
});

test('插话模式不等待，直接发', async () => {
  const workbench = new Workbench();
  let sent = 0;
  workbench._submit = async () => {
    sent += 1;
    return { ok: true };
  };
  workbench.snapshot = async () => ({ conversationId: 'conv-1', model: '' });
  workbench._switchTo = async () => ({ ok: true });

  const state = makeState();
  state.setBinding('bot-1', 'chat-1', { conversationId: 'conv-1', model: '' });
  const harness = new RemoteHarness({ workbench, index: fakeIndex, state, logger: { warn() {}, info() {}, debug() {} } });
  harness._waitIdle = async () => {
    throw new Error('插话模式不该等');
  };
  harness.runs.set('conv-1', { startedAt: Date.now() });

  const result = await harness.submit({ bot: { id: 'bot-1', platform: 'feishu' }, chatId: 'chat-1', text: '换个方向', mode: 'steer' });
  assert.equal(result.ok, true);
  assert.equal(sent, 1);
});

test('飞书群聊没 @ 机器人时 100% 静默', async () => {
  const dispatched = [];
  const hub = { dispatch: async (payload) => dispatched.push(payload) };
  const bot = new FeishuBot({
    bot: { id: 'fs-1', alias: '小助手' },
    secrets: { appId: 'a', appSecret: 'b', botOpenId: 'ou_bot' },
    hub,
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  });

  const groupMessage = (mentions) => ({
    message: {
      message_id: `m-${Math.random()}`,
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '大家好' }),
      mentions,
    },
    sender: { sender_type: 'user' },
  });

  await bot._onMessage(groupMessage([]));
  assert.equal(dispatched.length, 0, '没 @ 不该触发');

  await bot._onMessage(groupMessage([{ key: '@_user_1', name: '小助手', id: { open_id: 'ou_bot' } }]));
  assert.equal(dispatched.length, 1, '@ 了应该触发');

  // 私聊不需要 @
  await bot._onMessage({
    message: { message_id: 'p1', chat_id: 'oc_p2p', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '你好' }), mentions: [] },
    sender: { sender_type: 'user' },
  });
  assert.equal(dispatched.length, 2);
});

test('飞书机器人自己发的消息不处理', async () => {
  const dispatched = [];
  const bot = new FeishuBot({
    bot: { id: 'fs-1' },
    secrets: { appId: 'a', appSecret: 'b' },
    hub: { dispatch: async (p) => dispatched.push(p) },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  });
  await bot._onMessage({
    message: { message_id: 'x', chat_id: 'c', chat_type: 'p2p', message_type: 'text', content: '{}' },
    sender: { sender_type: 'app' },
  });
  assert.equal(dispatched.length, 0);
});

test('SessionSync 只镜像桌面输入，不回显手机自己发的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-sync-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');

  const state = makeState();
  state.bots = [{ id: 'bot-1', platform: 'feishu', syncEnabled: true }];
  state.setBinding('bot-1', 'chat-1', { conversationId: 'conv-1' });

  const index = { ...fakeIndex, transcriptPath: () => transcript };
  const sent = [];
  const sync = new SessionSync({ state, index, logger: { debug() {} } });
  sync.sendTo = async (payload) => sent.push(payload);
  sync.outbound.set('conv-1', new Set(['手机发的这句']));

  // 先跑一次建立 offset
  await sync.tick();
  const base = fs.statSync(transcript).size;

  const steps = [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>手机发的这句</USER_REQUEST>' },
    { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>桌面上敲的问题</USER_REQUEST>' },
    { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: '桌面这轮的答复' },
  ];
  fs.appendFileSync(transcript, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  assert.ok(fs.statSync(transcript).size > base);

  await sync.tick();
  const texts = sent.map((item) => item.text);
  assert.equal(texts.length, 2, `应该只镜像 2 条，实际：${JSON.stringify(texts)}`);
  assert.ok(texts[0].includes('桌面上敲的问题'));
  assert.ok(texts[1].includes('桌面这轮的答复'));
  assert.ok(!texts.some((t) => t.includes('手机发的这句')), '不该回显手机自己发的');

  // 再跑一次不应该重复镜像
  await sync.tick();
  assert.equal(sent.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('飞书回执只用表情回应，不发文字', async () => {
  const calls = [];
  const bot = new FeishuBot({
    bot: { id: 'fs-ack', alias: '小助手' },
    secrets: { appId: 'a', appSecret: 'b' },
    hub: { dispatch: async () => ({}) },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  });
  bot.client = {
    im: { v1: {
      messageReaction: { create: async (payload) => { calls.push({ kind: 'reaction', payload }); return {}; } },
      message: {
        reply: async (payload) => { calls.push({ kind: 'reply', payload }); return { data: { message_id: 'x' } }; },
        create: async (payload) => { calls.push({ kind: 'create', payload }); return { data: { message_id: 'om_new' } }; },
        patch: async (payload) => { calls.push({ kind: 'patch', payload }); return {}; },
      },
    } },
  };
  bot.lastInbound.set('oc_1', 'om_user');

  const ok = await bot.sendAck('oc_1', '收到，正在思考…');
  assert.equal(ok, true);
  assert.equal(calls.length, 1, '回执只应该有一个动作');
  assert.equal(calls[0].kind, 'reaction', '回执应该是表情回应');
  assert.equal(calls[0].payload.path.message_id, 'om_user');
  assert.equal(calls[0].payload.data.reaction_type.emoji_type, 'Get', '默认用 Get（飞书里的「收到」）');
  assert.equal(calls.filter((c) => c.kind === 'create' || c.kind === 'reply').length, 0, '不应该发任何文字消息');

  // 正式答复才发文字
  await bot.sendFinal('oc_1', '你好！请问有什么我可以帮你的？');
  const texts = calls.filter((c) => c.kind === 'create');
  assert.equal(texts.length, 1, '正式答复应该是一条普通文本');
  assert.equal(texts[0].payload.data.msg_type, 'text');
  assert.ok(texts[0].payload.data.content.includes('请问有什么我可以帮你的'));
});

test('表情类型被拒时自动退回 OK', async () => {
  const used = [];
  const bot = new FeishuBot({
    bot: { id: 'fs-ack3', ackEmoji: '不存在的表情' },
    secrets: { appId: 'a', appSecret: 'b' },
    hub: { dispatch: async () => ({}) },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  });
  bot.client = {
    im: { v1: { messageReaction: {
      create: async ({ data }) => {
        const emoji = data.reaction_type.emoji_type;
        used.push(emoji);
        if (emoji !== 'OK') throw Object.assign(new Error('invalid'), { response: { data: { code: 231001 } } });
        return {};
      },
    } } },
  };
  bot.lastInbound.set('oc_3', 'om_user3');
  const ok = await bot.sendAck('oc_3', '');
  assert.equal(ok, true);
  assert.deepEqual(used, ['不存在的表情', 'OK'], '失败后应该退回 OK');
});

test('没有收到过消息时表情回应直接跳过', async () => {
  const calls = [];
  const bot = new FeishuBot({
    bot: { id: 'fs-ack2' },
    secrets: { appId: 'a', appSecret: 'b' },
    hub: { dispatch: async () => ({}) },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  });
  bot.client = { im: { v1: { messageReaction: { create: async (p) => { calls.push(p); return {}; } } } } };
  const ok = await bot.sendAck('oc_unknown', '收到');
  assert.equal(ok, false);
  assert.equal(calls.length, 0);
});

/* -------------------------------------------------- 超时补发（deferred flush） */

function deferredHarness({ conv, lines, status = 'idle' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-defer-'));
  const logs = path.join(dir, conv, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

  const queue = [{ botId: 'bot-1', chatId: 'chat-1', conversationId: conv, startedAt: Date.now() - 60000 }];
  const state = makeState();
  state.addDeferred = (item) => queue.push(item);
  state.takeDeferred = () => queue.splice(0, queue.length);

  const harness = new RemoteHarness({
    workbench: { _switchTo: async () => ({ ok: true }), snapshot: async () => ({ conversationId: conv }) },
    index: { ...fakeIndex, brainDir: dir, statusOf: () => status },
    state,
    logger: { warn() {}, info() {}, debug() {} },
  });
  return { harness, dir, queue };
}

const DEFER_USER = {
  step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
  content: '<USER_REQUEST>检查四个插件并推送 github</USER_REQUEST>',
};

test('补发能取到「早已跑完」的答案，不再静默丢弃', async () => {
  const { harness, dir } = deferredHarness({
    conv: 'conv-done',
    lines: [
      DEFER_USER,
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '四个插件都已更新，已推送 github' },
    ],
  });
  const delivered = [];
  await harness.flushDeferred(async (item, answer) => delivered.push({ item, answer }));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(delivered.length, 1, `补发应该送达 1 条，实际 ${delivered.length}`);
  assert.ok(delivered[0].answer.includes('已推送 github'), `答案内容不对：${delivered[0].answer}`);
});

test('补发取不到结果也要通知，不能让人干等', async () => {
  const { harness, dir } = deferredHarness({ conv: 'conv-empty', lines: [DEFER_USER] });
  const delivered = [];
  await harness.flushDeferred(async (item, answer) => delivered.push({ item, answer }));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(delivered.length, 1, '没结果也必须送达一条');
  assert.ok(delivered[0].answer.includes('没有取到结果'), `提示语不对：${delivered[0].answer}`);
});

test('对话还在跑时补发要留在队列里，不能丢', async () => {
  const { harness, dir, queue } = deferredHarness({
    conv: 'conv-busy',
    lines: [DEFER_USER],
    status: 'running',
  });
  const delivered = [];
  await harness.flushDeferred(async (item, answer) => delivered.push({ item, answer }));
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(delivered.length, 0, '还在跑就不该送达');
  assert.equal(queue.length, 1, `条目应留在队列里等下一轮，实际 ${queue.length}`);
});

/* -------------------------------------------------- 绝不劫持当前对话 */

test('切换失败时绝不把消息发到当前对话', async () => {
  const wb = new Workbench();
  wb._switchTo = async () => ({ ok: false, reason: 'desktop-busy' });
  let submitted = 0;
  wb._submit = async () => { submitted += 1; return { ok: true }; };

  const out = await wb.sendPrompt({ conversationId: 'conv-bound', text: '你好' });
  assert.equal(out.ok, false, '切换失败必须整体失败');
  assert.equal(out.reason, 'desktop-busy');
  assert.equal(submitted, 0, '切换失败就不该发出任何消息');
});

test('已有绑定时发到别的对话不会悄悄改写绑定', async () => {
  const state = makeState();
  state.setBinding('bot-1', 'chat-1', { conversationId: 'conv-bound' });

  const workbench = new Workbench();
  workbench.sendPrompt = async () => ({ ok: true, conversationId: 'conv-other' });

  const harness = new RemoteHarness({ workbench, index: fakeIndex, state, logger: { warn() {}, info() {}, debug() {} } });
  const out = await harness.submit({ bot: { id: 'bot-1' }, chatId: 'chat-1', text: '你好' });

  assert.equal(out.ok, false, '发错对话必须报错');
  assert.equal(out.error, 'switch：wrong-conversation');
  assert.equal(state.getBinding('bot-1', 'chat-1').conversationId, 'conv-bound', '绑定必须保持不变');
});

test('桌面正忙时 _switchTo 必须失败（旧行为是 ok:true 的 busy-skip）', async () => {
  const wb = new Workbench();
  const busyState = { conversationId: 'conv-current', hasInput: true, busy: true };
  wb.ensure = async () => ({ evaluate: async () => busyState, clickAt: async () => {} });

  // 让 20s 的等待窗口立刻到期，避免测试真的等
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => (t += 30000);
  let out;
  try {
    out = await wb._switchTo('conv-bound');
  } finally {
    Date.now = realNow;
  }
  assert.equal(out.ok, false, '忙的时候不能假装切换成功');
  assert.equal(out.reason, 'desktop-busy');
  assert.equal(out.actual, 'conv-current');
});

test('clearAck 撤掉刚加的表情，且只撤一次', async () => {
  const deletes = [];
  const bot = new FeishuBot({ bot: { id: 'fs-ack4' }, secrets: {}, hub: {}, logger: { debug() {}, warn() {} } });
  bot.client = { im: { v1: { messageReaction: {
    create: async () => ({ data: { reaction_id: 'r_1' } }),
    delete: async (payload) => { deletes.push(payload); return {}; },
  } } } };
  bot.lastInbound.set('oc_4', 'om_user4');

  assert.equal(await bot.sendAck('oc_4', ''), true);
  assert.equal(await bot.clearAck('oc_4'), true, '思考结束后应能撤掉表情');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].path.message_id, 'om_user4');
  assert.equal(deletes[0].path.reaction_id, 'r_1', '这个 SDK 是按 reaction_id 删的');
  assert.equal(await bot.clearAck('oc_4'), false, '没有回执时不该再发请求');
});

test('QQ 与微信不再发送「收到，正在思考」文本', async () => {
  let sent = 0;
  const make = (Ctor) => {
    const ch = new Ctor({ bot: { id: 'x' }, secrets: {}, hub: {}, logger: { debug() {}, warn() {} } });
    ch.sendText = async () => { sent += 1; return true; };
    return ch;
  };
  for (const Ctor of [QQOfficialBot, OneBotChannel, WeixinBot]) {
    const ch = make(Ctor);
    assert.equal(await ch.sendAck('chat', '收到，正在思考…'), false);
  }
  assert.equal(sent, 0, '三个渠道都不该再发回执文本');
});
