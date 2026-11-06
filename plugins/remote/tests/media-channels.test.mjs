import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeishuBot, __test__ as feishuTest } from '../src/channels/feishu/feishu-bot.mjs';
import { OneBotChannel, parseOneBotEvent } from '../src/channels/qq/qq-onebot-bot.mjs';
import { QQOfficialBot } from '../src/channels/qq/qq-official-bot.mjs';
import { parseInbound } from '../src/channels/weixin/ilink-api.mjs';
import { sniffImageExt, sanitizeFileName, safeMediaUrl } from '../src/channels/shared/media.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-media-'));
process.env.AG_REMOTE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);
const PDF = Buffer.from('%PDF-1.4\nfake pdf body');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-media-src-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function tempFile(name, bytes) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function fakeFeishuClient({ bytes = PNG } = {}) {
  const calls = { downloads: [], messages: [], uploads: [] };
  const client = {
    im: {
      v1: {
        messageResource: {
          get: async (payload) => {
            calls.downloads.push(payload);
            return { writeFile: async (file) => fs.writeFileSync(file, bytes) };
          },
        },
        message: {
          create: async (payload) => {
            calls.messages.push(payload);
            return {};
          },
        },
        image: {
          create: async (payload) => {
            calls.uploads.push({ kind: 'image', payload });
            await drain(payload.data.image);
            return { image_key: 'img_key_1' };
          },
        },
        file: {
          create: async (payload) => {
            calls.uploads.push({ kind: 'file', payload });
            await drain(payload.data.file);
            return { file_key: 'file_key_1' };
          },
        },
      },
    },
  };
  return { client, calls };
}

function drain(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.resume();
  });
}

function makeFeishu({ client }) {
  const dispatched = [];
  const bot = new FeishuBot({
    bot: { id: 'feishu-1', alias: '飞书', groupAtOptional: false },
    secrets: {},
    hub: { dispatch: async (payload) => dispatched.push(payload) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  bot.client = client;
  bot.status = 'online';
  return { bot, dispatched };
}

function feishuEvent({ type, content, chatId = 'chat-1', messageId = 'msg-1' }) {
  return {
    message: {
      chat_id: chatId,
      chat_type: 'p2p',
      message_id: messageId,
      message_type: type,
      content: JSON.stringify(content),
    },
    sender: { sender_type: 'user' },
  };
}

test('飞书入站图片会下载到临时目录并作为附件投递', async () => {
  const { client, calls } = fakeFeishuClient({ bytes: PNG });
  const { bot, dispatched } = makeFeishu({ client });
  await bot._onMessage(feishuEvent({ type: 'image', content: { image_key: 'img_in_1' } }));

  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].text, /收到一张图片/);
  assert.equal(dispatched[0].attachments.length, 1);
  assert.ok(fs.existsSync(dispatched[0].attachments[0]));
  assert.equal(path.extname(dispatched[0].attachments[0]), '.png');
  assert.equal(calls.downloads[0].params.type, 'image');
  assert.equal(calls.downloads[0].path.file_key, 'img_in_1');
});

test('飞书入站文件保留文件名扩展名并作为附件投递', async () => {
  const { client, calls } = fakeFeishuClient({ bytes: PDF });
  const { bot, dispatched } = makeFeishu({ client });
  await bot._onMessage(feishuEvent({ type: 'file', content: { file_key: 'file_in_1', file_name: '周报.pdf' } }));

  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].text, /周报\.pdf/);
  assert.equal(dispatched[0].attachments.length, 1);
  assert.equal(path.extname(dispatched[0].attachments[0]), '.pdf');
  assert.equal(calls.downloads[0].params.type, 'file');
});

test('飞书富文本里的图片也会被提取下载', async () => {
  const { client } = fakeFeishuClient({ bytes: PNG });
  const { bot, dispatched } = makeFeishu({ client });
  await bot._onMessage(feishuEvent({
    type: 'post',
    content: { title: '看图', content: [[{ tag: 'text', text: '这张图' }, { tag: 'img', image_key: 'img_in_2' }]] },
  }));

  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].text, /看图/);
  assert.match(dispatched[0].text, /这张图/);
  assert.equal(dispatched[0].attachments.length, 1);
});

test('飞书出站图片走 image 上传 + 原生图片消息', async () => {
  const { client, calls } = fakeFeishuClient();
  const { bot } = makeFeishu({ client });
  const file = tempFile('reply.png', PNG);

  assert.equal(await bot.sendFile('chat-1', file, { caption: '给你' }), true);
  assert.equal(calls.uploads[0].kind, 'image');
  const imageMessage = calls.messages.find((item) => item.data.msg_type === 'image');
  assert.ok(imageMessage);
  assert.equal(JSON.parse(imageMessage.data.content).image_key, 'img_key_1');
  const textMessage = calls.messages.find((item) => item.data.msg_type === 'text');
  assert.equal(JSON.parse(textMessage.data.content).text, '给你');
});

test('飞书出站普通文件走 file 上传 + 原生文件消息', async () => {
  const { client, calls } = fakeFeishuClient();
  const { bot } = makeFeishu({ client });
  const file = tempFile('报告.pdf', PDF);

  assert.equal(await bot.sendFile('chat-1', file), true);
  assert.equal(calls.uploads[0].kind, 'file');
  assert.equal(calls.uploads[0].payload.data.file_type, 'pdf');
  assert.equal(calls.uploads[0].payload.data.file_name, '报告.pdf');
  const fileMessage = calls.messages.find((item) => item.data.msg_type === 'file');
  assert.equal(JSON.parse(fileMessage.data.content).file_key, 'file_key_1');
});

test('OneBot 图片/文件段会进入附件列表', () => {
  const parsed = parseOneBotEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 20001,
    message_id: 99,
    raw_message: '[CQ:image] [CQ:file]',
    message: [
      { type: 'image', data: { url: 'https://example.com/a.png', file: 'a.png' } },
      { type: 'file', data: { url: 'https://example.com/b.pdf', name: 'b.pdf' } },
    ],
  }, { selfId: '10000' });

  assert.equal(parsed.media.length, 2);
  assert.equal(parsed.media[0].kind, 'image');
  assert.equal(parsed.media[1].kind, 'file');
  assert.match(parsed.text, /\[图片\]/);
  assert.match(parsed.text, /\[文件/);
});

test('OneBot 入站图片会用安全下载器落盘', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      url: String(url),
      headers: { get: () => String(PNG.length) },
      arrayBuffer: async () => PNG,
    };
  };
  const channel = new OneBotChannel({
    bot: { id: 'qq-1' },
    secrets: {},
    hub: { dispatch: async () => {} },
    logger: { warn() {} },
    fetchImpl,
  });
  const files = await channel._downloadAll({
    chatId: 'private:20001',
    media: [{ kind: 'image', data: { url: 'https://example.com/a.png', file: 'a.png' } }],
  });

  assert.equal(calls.length, 1);
  assert.equal(files.length, 1);
  assert.ok(fs.existsSync(files[0]));
  assert.equal(path.extname(files[0]), '.png');
});

test('OneBot 出站图片通过 send_private_msg 发送 file:// 路径', async () => {
  const actions = [];
  const channel = new OneBotChannel({
    bot: { id: 'qq-1' },
    secrets: {},
    hub: {},
    logger: { warn() {} },
  });
  channel.socket = {
    readyState: 1,
    send: (raw) => {
      const payload = JSON.parse(raw);
      actions.push(payload);
      queueMicrotask(() => {
        const entry = channel.pending.get(payload.echo);
        if (entry) {
          channel.pending.delete(payload.echo);
          entry.resolve({ status: 'ok', retcode: 0, data: {} });
        }
      });
    },
  };
  const file = tempFile('qq-image.png', PNG);

  assert.equal(await channel.sendFile('private:20001', file), true);
  assert.equal(actions[0].action, 'send_private_msg');
  const segment = actions[0].params.message[0];
  assert.equal(segment.type, 'image');
  assert.match(segment.data.file, /^file:\/\//);
});

test('OneBot 出站普通文件通过 upload_private_file 发送', async () => {
  const actions = [];
  const channel = new OneBotChannel({ bot: { id: 'qq-1' }, secrets: {}, hub: {}, logger: { warn() {} } });
  channel.socket = {
    readyState: 1,
    send: (raw) => {
      const payload = JSON.parse(raw);
      actions.push(payload);
      queueMicrotask(() => {
        const entry = channel.pending.get(payload.echo);
        if (entry) {
          channel.pending.delete(payload.echo);
          entry.resolve({ status: 'ok', retcode: 0, data: {} });
        }
      });
    },
  };
  const file = tempFile('qq-file.pdf', PDF);

  assert.equal(await channel.sendFile('private:20001', file), true);
  assert.equal(actions[0].action, 'upload_private_file');
  assert.equal(actions[0].params.name, 'qq-file.pdf');
});

test('QQ 官方入站附件会下载并投递', async () => {
  const dispatched = [];
  const fetchImpl = async (url) => ({
    ok: true,
    url: String(url),
    headers: { get: () => String(PNG.length) },
    arrayBuffer: async () => PNG,
  });
  const bot = new QQOfficialBot({
    bot: { id: 'qq-off-1', groupAtOptional: true },
    secrets: {},
    hub: { dispatch: async (payload) => dispatched.push(payload) },
    logger: { debug() {}, warn() {} },
    fetchImpl,
  });
  await bot._onMessage({}, {
    id: 'm-1',
    content: '',
    replyTarget: { scope: 'c2c', id: 'user-1' },
    attachments: [{ url: 'https://example.com/a.png', filename: 'a.png', content_type: 'image/png' }],
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].attachments.length, 1);
  assert.equal(path.extname(dispatched[0].attachments[0]), '.png');
});

test('QQ 官方出站图片/文件调用 SDK 的 sendImage/sendFile', async () => {
  const sent = [];
  const bot = new QQOfficialBot({ bot: { id: 'qq-off-1' }, secrets: {}, hub: {}, logger: { warn() {} } });
  bot.targets.set('user-1', { scope: 'c2c', targetId: 'user-1' });
  bot.sdk = {
    sendImage: async (target, source, opts) => sent.push({ kind: 'image', target, source, opts }),
    sendFile: async (target, source, opts) => sent.push({ kind: 'file', target, source, opts }),
  };

  assert.equal(await bot.sendFile('user-1', tempFile('qq-official.png', PNG), { caption: '看图' }), true);
  assert.equal(await bot.sendFile('user-1', tempFile('qq-official.pdf', PDF)), true);
  assert.equal(sent[0].kind, 'image');
  assert.equal(sent[0].opts.content, '看图');
  assert.equal(sent[1].kind, 'file');
  assert.equal(sent[1].opts.fileName, 'qq-official.pdf');
});

test('媒体工具：文件名清洗、图片嗅探、内网 URL 拦截', () => {
  assert.equal(sanitizeFileName('../../evil\\x.png'), 'x.png');
  assert.equal(sanitizeFileName('', 'fallback'), 'fallback');
  assert.equal(sniffImageExt(PNG), '.png');
  assert.equal(sniffImageExt(PDF), '');
  assert.ok(safeMediaUrl('https://example.com/a.png'));
  assert.equal(safeMediaUrl('http://127.0.0.1/a.png'), null);
  assert.equal(safeMediaUrl('http://192.168.1.2/a.png'), null);
  assert.equal(safeMediaUrl('file:///C:/Windows/win.ini'), null);
});

test('飞书富文本解析提取图片 key', () => {
  const post = feishuTest.extractPost({
    title: '标题',
    content: [[{ tag: 'text', text: '正文' }, { tag: 'img', image_key: 'img_9' }]],
  });
  assert.equal(post.text.includes('正文'), true);
  assert.deepEqual(post.images, ['img_9']);
});

test('飞书 sticker 先试 file 再回退 image 下载', async () => {
  const tried = [];
  const client = {
    im: {
      v1: {
        messageResource: {
          get: async (payload) => {
            tried.push(payload.params.type);
            if (payload.params.type === 'file') throw new Error('not a file');
            return { writeFile: async (file) => fs.writeFileSync(file, PNG) };
          },
        },
        message: { create: async () => ({}) },
      },
    },
  };
  const { bot, dispatched } = makeFeishu({ client });
  await bot._onMessage(feishuEvent({ type: 'sticker', content: { file_key: 'sticker_1' } }));

  assert.deepEqual(tried, ['file', 'image']);
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].text, /表情包/);
  assert.equal(dispatched[0].attachments.length, 1);
  assert.equal(path.extname(dispatched[0].attachments[0]), '.png');
});

test('OneBot face / mface 会转成可读文本并下载表情包图片', () => {
  const parsed = parseOneBotEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 20001,
    message_id: 100,
    raw_message: '[CQ:face,id=179] [CQ:mface]',
    message: [
      { type: 'face', data: { id: 179 } },
      { type: 'mface', data: { summary: '猫猫', url: 'https://example.com/mface.png' } },
    ],
  }, { selfId: '10000' });

  assert.match(parsed.text, /😊/);
  assert.match(parsed.text, /表情包 猫猫/);
  assert.equal(parsed.media.length, 1);
  assert.equal(parsed.media[0].kind, 'image');
});

test('微信 sticker_item 会进入 stickers 并生成可读文本', () => {
  const inbound = parseInbound({
    msg_id: 'w1',
    from_user_id: 'u1',
    item_list: [{ type: 6, sticker_item: { text: '猫猫' } }],
  });
  assert.equal(inbound.stickers.length, 1);
  assert.match(inbound.text, /表情 猫猫/);
});

test('QQ 官方 msg_elements 里的附件也会被收集下载', async () => {
  const dispatched = [];
  const fetchImpl = async (url) => ({
    ok: true,
    url: String(url),
    headers: { get: () => String(PNG.length) },
    arrayBuffer: async () => PNG,
  });
  const bot = new QQOfficialBot({
    bot: { id: 'qq-off-2', groupAtOptional: true },
    secrets: {},
    hub: { dispatch: async (payload) => dispatched.push(payload) },
    logger: { debug() {}, warn() {} },
    fetchImpl,
  });
  await bot._onMessage({}, {
    id: 'm-2',
    content: '',
    replyTarget: { scope: 'c2c', id: 'user-2' },
    msg_elements: [{ attachments: [{ url: 'https://example.com/sticker.png', filename: 'sticker.png', content_type: 'image/png' }] }],
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].attachments.length, 1);
  assert.equal(path.extname(dispatched[0].attachments[0]), '.png');
});
