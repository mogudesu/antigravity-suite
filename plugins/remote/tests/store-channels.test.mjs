import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore, redact, maskSecret, isSensitiveKey } from '../src/store/secret-store.mjs';
import { StateStore } from '../src/store/state-store.mjs';
import { parseInbound, IlinkClient, __test__ as ilinkTest } from '../src/channels/weixin/ilink-api.mjs';
import { parseOneBotEvent } from '../src/channels/qq/qq-onebot-bot.mjs';
import { __test__ as feishuTest } from '../src/channels/feishu/feishu-bot.mjs';

test('maskSecret 保留首尾', () => {
  assert.equal(maskSecret('abcdefghij'), 'abc***hij');
  assert.equal(maskSecret('short'), '***');
  assert.equal(maskSecret(''), '');
});

test('redact 只脱敏敏感字段', () => {
  const source = { appId: 'cli_123', appSecret: 'verysecretvalue', nested: { botToken: 'tok_abcdefgh' }, list: [{ token: 'x12345678' }] };
  const out = redact(source);
  assert.equal(out.appId, 'cli_123');
  assert.equal(out.appSecret, 'ver***lue');
  assert.equal(out.nested.botToken, 'tok***fgh');
  assert.equal(out.list[0].token, 'x12***678');
  assert.equal(source.appSecret, 'verysecretvalue', 'redact 不能改动入参');
  assert.ok(isSensitiveKey('encodingAesKey'));
});

test('SecretStore 落盘并可重载', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-sec-'));
  const file = path.join(dir, 'secrets.json');
  const store = new SecretStore(file);
  store.set('bot-1', { appSecret: 's3cret', appId: 'cli_1' });
  assert.equal(store.get('bot-1').appId, 'cli_1');

  const reloaded = new SecretStore(file);
  assert.equal(reloaded.get('bot-1').appSecret, 's3cret');
  assert.equal(reloaded.remove('bot-1'), true);
  assert.equal(reloaded.get('bot-1'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('StateStore 绑定与 pending', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-state-'));
  const file = path.join(dir, 'state.json');
  const store = new StateStore(file);
  store.upsertBot({ id: 'bot-1', platform: 'feishu', alias: '飞书' });
  store.setBinding('bot-1', 'chat-1', { conversationId: 'conv-1', title: '对话一', model: 'M' });

  assert.equal(store.getBinding('bot-1', 'chat-1').conversationId, 'conv-1');
  assert.equal(store.listBindings('bot-1').length, 1);

  const reloaded = new StateStore(file);
  assert.equal(reloaded.getBinding('bot-1', 'chat-1').title, '对话一');

  reloaded.clearBinding('bot-1', 'chat-1');
  assert.equal(reloaded.getBinding('bot-1', 'chat-1'), null);

  reloaded.addDeferred({ botId: 'bot-1', chatId: 'chat-1', conversationId: 'conv-1' });
  assert.equal(reloaded.deferredCount, 1);
  assert.equal(reloaded.takeDeferred().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseInbound 提取文本/图片/语音', () => {
  const text = parseInbound({ msg_id: 'm1', from_user_id: 'u1', context_token: 'ct', item_list: [{ type: 1, text_item: { text: '你好' } }] });
  assert.equal(text.text, '你好');
  assert.equal(text.fromUserId, 'u1');
  assert.equal(text.contextToken, 'ct');

  const voice = parseInbound({ msg_id: 'm2', item_list: [{ type: 3, voice_item: { text: '语音转写' } }] });
  assert.equal(voice.text, '语音转写');

  const image = parseInbound({ msg_id: 'm3', item_list: [{ type: 2, image_item: { url: 'x' } }] });
  assert.equal(image.images.length, 1);
});

test('微信请求头符合 iLink 约定', () => {
  const headers = ilinkTest.headers('tok123');
  assert.equal(headers['iLink-App-Id'], 'bot');
  assert.equal(headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(headers.Authorization, 'Bearer tok123');
  assert.ok(headers['X-WECHAT-UIN']);
  assert.equal(ilinkTest.baseInfo().channel_version, '2.4.6');
});

test('拒绝非微信域名', () => {
  assert.throws(() => ilinkTest.assertWeixinHost(new URL('https://evil.com/x')), /非微信域名/);
  assert.doesNotThrow(() => ilinkTest.assertWeixinHost(new URL('https://ilinkai.weixin.qq.com/x')));
});

test('IlinkClient 用假 fetch 走完扫码流程', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
    return {
      ok: true,
      json: async () => ({ qrcode: 'qr-1', qrcode_img_content: 'https://x/qr.png', errcode: 0 }),
    };
  };
  const client = new IlinkClient({ fetchImpl: fakeFetch });
  const result = await client.beginLogin();
  assert.equal(result.qrcode, 'qr-1');
  assert.equal(calls[0].method, 'POST');
  assert.ok(calls[0].url.includes('get_bot_qrcode?bot_type=3'));
});

test('parseOneBotEvent 处理私聊/群聊/@', () => {
  const base = { post_type: 'message', self_id: 10000, user_id: 20001, message_id: 1, raw_message: 'hi', message: [{ type: 'text', data: { text: 'hi' } }] };
  assert.equal(parseOneBotEvent({ ...base, message_type: 'private' }, { selfId: '10000' }).chatId, 'private:20001');
  assert.equal(parseOneBotEvent({ ...base, message_type: 'group', group_id: 9 }, { selfId: '10000' }), null);
  const group = parseOneBotEvent(
    { ...base, message_type: 'group', group_id: 9, raw_message: '[CQ:at,qq=10000] hi', message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' hi' } }] },
    { selfId: '10000' },
  );
  assert.equal(group.chatId, 'group:9');
  assert.equal(parseOneBotEvent({ ...base, message_type: 'private', user_id: 10000 }, { selfId: '10000' }), null);
});

test('飞书富文本解析与卡片构建', () => {
  const text = feishuTest.extractPostText({ title: '标题', content: [[{ text: '第一行' }], [{ text: '第二行' }]] });
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('第一行'));

  const card = feishuTest.buildProgressCard('正在读取文件');
  assert.equal(card.header.template, 'blue');
  assert.ok(card.elements[0].text.content.includes('正在读取文件'));

  const result = feishuTest.buildResultCard('完成', { model: 'Gemini', elapsed: 3200 });
  assert.equal(result.header.template, 'green');
  assert.ok(result.elements.at(-1).elements[0].content.includes('Gemini'));

  const progress = feishuTest.renderProgress({ tools: [{ name: 'read_file' }], thinking: '想一想', answer: '半成品' });
  assert.ok(progress.includes('read_file'));
  assert.ok(progress.includes('想一想'));
});

test('normalizeRegisterResult 兼容 client_id/client_secret 与 appId/appSecret', async () => {
  const { normalizeRegisterResult } = await import('../src/channels/feishu/feishu-auth.mjs');
  const sdkShape = normalizeRegisterResult({ client_id: 'cli_x', client_secret: 'sec_y', user_info: { open_id: 'ou_1', name: '张三' } });
  assert.equal(sdkShape.appId, 'cli_x');
  assert.equal(sdkShape.appSecret, 'sec_y');
  assert.equal(sdkShape.ownerOpenId, 'ou_1');
  assert.equal(sdkShape.ownerName, '张三');

  const altShape = normalizeRegisterResult({ appId: 'a', appSecret: 'b' });
  assert.equal(altShape.appId, 'a');
  assert.equal(altShape.appSecret, 'b');

  const empty = normalizeRegisterResult(null);
  assert.equal(empty.appId, '');
  assert.equal(empty.appSecret, '');
});

test('state.json 损坏时从 .bak 恢复，不清零机器人', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-bak-'));
  const file = path.join(dir, 'state.json');
  const store = new StateStore(file);
  store.upsertBot({ id: 'bot-a', platform: 'feishu', alias: 'A' });
  store.upsertBot({ id: 'bot-b', platform: 'qq', alias: 'B' });
  assert.ok(fs.existsSync(`${file}.bak`), '覆盖前应该留备份');

  fs.writeFileSync(file, '{"bots": {"bot-a": '); // 模拟写坏
  const recovered = new StateStore(file);
  assert.ok(recovered.getBot('bot-a'), '应该从 .bak 恢复出机器人');
  fs.rmSync(dir, { recursive: true, force: true });
});
