import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseInbound } from '../src/channels/weixin/ilink-api.mjs';
import { WeixinBot } from '../src/channels/weixin/weixin-bot.mjs';
import { SecretStore } from '../src/store/secret-store.mjs';
import { StateStore } from '../src/store/state-store.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}

function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitUntil timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('parseInbound 正确保留数字 0、msgid 与 seq 作为消息 ID', () => {
  const withZeroMsgId = parseInbound({
    msg_id: 0,
    from_user_id: 'u1',
    item_list: [{ text_item: { text: 'zero' } }],
  });
  assert.equal(withZeroMsgId.messageId, '0');

  const withMsgid = parseInbound({
    msgid: 98765,
    from_user_id: 'u1',
    item_list: [{ text_item: { text: 'alt-field' } }],
  });
  assert.equal(withMsgid.messageId, '98765');

  const withZeroSeq = parseInbound({
    seq: 0,
    from_user_id: 'u1',
    item_list: [{ text_item: { text: 'seq-zero' } }],
  });
  assert.equal(withZeroSeq.messageId, '0');

  const withoutId = parseInbound({
    from_user_id: 'u1',
    item_list: [{ text_item: { text: 'no-id' } }],
  });
  assert.equal(withoutId.messageId, '');
});

test('WeixinBot 重启不重放：游标即时落盘 + 跨重启去重 + stop 中断挂起轮询', async () => {
  const prevHome = process.env.AG_REMOTE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-wx-replay-'));
  process.env.AG_REMOTE_HOME = dir;

  try {
    const secretFile = path.join(dir, 'secrets.json');
    const stateFile = path.join(dir, 'state.json');

    const secrets1 = new SecretStore(secretFile);
    const state1 = new StateStore(stateFile);
    const botMeta = { id: 'wx-1', platform: 'weixin', alias: 'WX' };
    state1.upsertBot(botMeta);
    secrets1.set('wx-1', { botToken: 'tok-1', getUpdatesBuf: 'buf-0' });

    const dispatched = [];
    const sentCursors = [];
    let abortedInFlight = false;
    let phase = 1;

    const makeFetch = () => async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith('ilink/bot/msg/notifystart')) {
        return jsonResponse({ ret: 0 });
      }
      if (target.endsWith('ilink/bot/getupdates')) {
        const body = JSON.parse(init.body || '{}');
        sentCursors.push(body.get_updates_buf);
        if (phase === 1 && sentCursors.length === 1) {
          return jsonResponse({
            get_updates_buf: 'buf-1',
            msgs: [
              {
                msg_id: 101,
                from_user_id: 'u1',
                context_token: 'ct-1',
                item_list: [{ type: 1, text_item: { text: '最后一条消息' } }],
              },
            ],
          });
        }
        if (phase === 1) {
          // 模拟长轮询挂起，等待 stop() abort
          return new Promise((_, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => {
                abortedInFlight = true;
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
          });
        }
        if (phase === 2) {
          phase = 3;
          // 重启后即便服务器还推回 msg_id=101，也只应放行新消息 msg_id=102
          return jsonResponse({
            get_updates_buf: 'buf-2',
            msgs: [
              {
                msg_id: 101,
                from_user_id: 'u1',
                context_token: 'ct-1',
                item_list: [{ type: 1, text_item: { text: '最后一条消息' } }],
              },
              {
                msg_id: 102,
                from_user_id: 'u1',
                context_token: 'ct-2',
                item_list: [{ type: 1, text_item: { text: '重启后新消息' } }],
              },
            ],
          });
        }
        return new Promise((_, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
      }
      throw new Error(`unexpected fetch: ${target}`);
    };

    const hub = {
      async dispatch(payload) {
        dispatched.push({ text: payload.text, contextToken: payload.contextToken });
      },
    };

    const bot1 = new WeixinBot({
      bot: botMeta,
      secrets: secrets1.get('wx-1'),
      hub,
      logger: silentLogger,
      fetchImpl: makeFetch(),
      onCursor: (cursor) => {
        if (secrets1.get('wx-1')) secrets1.merge('wx-1', { getUpdatesBuf: cursor });
      },
      seenIds: state1.getSeenMessages('wx-1'),
      onSeen: (entries) => {
        if (state1.getBot('wx-1')) state1.setSeenMessages('wx-1', entries);
      },
    });

    await bot1.start();
    await waitUntil(() => dispatched.length === 1 && sentCursors.length >= 2);
    bot1.stop();
    await waitUntil(() => abortedInFlight);

    // 验证重启前游标和已见消息已经落盘
    const secretsAfterStop = new SecretStore(secretFile);
    const stateAfterStop = new StateStore(stateFile);
    assert.equal(secretsAfterStop.get('wx-1').getUpdatesBuf, 'buf-1');
    assert.deepEqual(
      stateAfterStop.getSeenMessages('wx-1').map((e) => e.id),
      ['101'],
    );

    // 模拟进程重启后重新实例化 SecretStore / StateStore / WeixinBot
    phase = 2;
    const bot2 = new WeixinBot({
      bot: botMeta,
      secrets: secretsAfterStop.get('wx-1'),
      hub,
      logger: silentLogger,
      fetchImpl: makeFetch(),
      onCursor: (cursor) => {
        if (secretsAfterStop.get('wx-1')) secretsAfterStop.merge('wx-1', { getUpdatesBuf: cursor });
      },
      seenIds: stateAfterStop.getSeenMessages('wx-1'),
      onSeen: (entries) => {
        if (stateAfterStop.getBot('wx-1')) stateAfterStop.setSeenMessages('wx-1', entries);
      },
    });

    await bot2.start();
    await waitUntil(() => dispatched.length === 2 && phase === 3);
    bot2.stop();

    assert.equal(sentCursors[0], 'buf-0');
    assert.equal(sentCursors[2], 'buf-1', '重启后的首次轮询必须带上上次落盘的新游标 buf-1');
    assert.deepEqual(
      dispatched.map((d) => d.text),
      ['最后一条消息', '重启后新消息'],
    );
    assert.equal(new SecretStore(secretFile).get('wx-1').getUpdatesBuf, 'buf-2');
    assert.deepEqual(
      new StateStore(stateFile).getSeenMessages('wx-1').map((e) => e.id),
      ['101', '102'],
    );
  } finally {
    if (prevHome === undefined) delete process.env.AG_REMOTE_HOME;
    else process.env.AG_REMOTE_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WeixinBot 无 server ID 时用时间戳兜底去重，且不误伤无时间戳的正常重复输入', async () => {
  const dispatched = [];
  const savedSeen = [];
  const hub = {
    async dispatch(payload) {
      dispatched.push(payload.text);
    },
  };

  const bot = new WeixinBot({
    bot: { id: 'wx-ts', platform: 'weixin', alias: 'WX' },
    secrets: {},
    hub,
    logger: silentLogger,
    onSeen: (entries) => savedSeen.push(entries),
  });

  // 缺 msg_id 但有 create_time_ms：第二遍重复投递必须拦截
  const withTs = {
    from_user_id: 'u1',
    create_time_ms: 1700000001234,
    item_list: [{ text_item: { text: '在吗' } }],
  };
  await bot._handle(withTs);
  await bot._handle(withTs);
  assert.deepEqual(dispatched, ['在吗']);
  assert.equal(savedSeen.length, 1);

  // 用已保存的 seenIds 重建实例后，再次投递仍应拦截
  const botRestarted = new WeixinBot({
    bot: { id: 'wx-ts', platform: 'weixin', alias: 'WX' },
    secrets: {},
    hub,
    logger: silentLogger,
    seenIds: savedSeen[0],
  });
  await botRestarted._handle(withTs);
  assert.deepEqual(dispatched, ['在吗']);

  // 既无 ID 又无时间戳：连续两次发送相同短文本不应误杀
  const bareMsg = {
    from_user_id: 'u1',
    item_list: [{ text_item: { text: '继续' } }],
  };
  await botRestarted._handle(bareMsg);
  await botRestarted._handle(bareMsg);
  assert.deepEqual(dispatched, ['在吗', '继续', '继续']);
});
