import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  IlinkClient,
  aesEcbPaddedSize,
  parseMediaAesKey,
  encryptMedia,
  decryptMedia,
  mediaDownloadUrl,
  resolveUploadUrl,
} from '../src/channels/weixin/ilink-api.mjs';

test('aesEcbPaddedSize 与 PKCS#7 对齐', () => {
  assert.equal(aesEcbPaddedSize(0), 16);
  assert.equal(aesEcbPaddedSize(15), 16);
  assert.equal(aesEcbPaddedSize(16), 32);
  assert.equal(aesEcbPaddedSize(100), 112);
});

test('加密 → 解密 往返一致（含整块边界）', () => {
  for (const size of [1, 15, 16, 17, 1000, 64 * 1024]) {
    const plain = randomBytes(size);
    const key = randomBytes(16);
    const cipher = encryptMedia(plain, key);
    assert.equal(cipher.length, aesEcbPaddedSize(size), `密文长度不对：${size}`);
    assert.equal(cipher.length % 16, 0);
    const back = decryptMedia(cipher, key);
    assert.ok(back.equals(plain), `往返不一致：${size}`);
  }
});

test('解密用错密钥会失败', () => {
  const cipher = encryptMedia(randomBytes(64), randomBytes(16));
  assert.throws(() => decryptMedia(cipher, randomBytes(16)));
});

test('parseMediaAesKey 支持 hex 与 base64 两种形态', () => {
  const key = randomBytes(16);
  const hex = key.toString('hex');

  // image_item.aeskey 直给 32 位 hex
  assert.ok(parseMediaAesKey({ aeskey: hex }).equals(key));
  // media.aes_key = base64(hex ascii)，微信下发的就是这种
  const b64OfHex = Buffer.from(hex, 'utf8').toString('base64');
  assert.ok(parseMediaAesKey({ media: { aes_key: b64OfHex } }).equals(key));
  // media.aes_key = base64(raw16)
  const b64Raw = key.toString('base64');
  assert.ok(parseMediaAesKey({ media: { aes_key: b64Raw } }).equals(key));
  assert.throws(() => parseMediaAesKey({ media: {} }));
});

test('mediaDownloadUrl 只接受微信 CDN', () => {
  const url = mediaDownloadUrl({ encrypt_query_param: 'abc' });
  assert.ok(url.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc'));
  assert.throws(() => mediaDownloadUrl({ full_url: 'https://evil.com/c2c/x' }), /非微信 CDN/);
  assert.doesNotThrow(() => mediaDownloadUrl({ full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1' }));
});

test('resolveUploadUrl 只接受 /c2c/upload', () => {
  const url = resolveUploadUrl({ upload_param: 'p1' }, 'filekey1').toString();
  assert.ok(url.includes('/c2c/upload'));
  assert.ok(url.includes('encrypted_query_param=p1'));
  assert.ok(url.includes('filekey=filekey1'));
  assert.throws(() => resolveUploadUrl({ upload_full_url: 'https://evil.com/c2c/upload' }, 'k'), /非微信 CDN/);
  assert.throws(() => resolveUploadUrl({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/other' }, 'k'));
});

test('sendMedia 走完 getuploadurl → 加密上传 → sendmessage', async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || 'GET', body: options.body, headers: options.headers });
    if (target.includes('getuploadurl')) {
      return { ok: true, json: async () => ({ errcode: 0, upload_param: 'UP1' }) };
    }
    if (target.includes('/c2c/upload')) {
      const sent = Buffer.from(options.body);
      assert.equal(sent.length % 16, 0, '上传体必须是整块');
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'x-encrypted-param' ? 'DL1' : null) },
        json: async () => ({}),
      };
    }
    return { ok: true, json: async () => ({ ret: 0 }) };
  };

  const client = new IlinkClient({ token: 'tok', fetchImpl: fakeFetch });
  const bytes = Buffer.from('hello weixin media');
  const result = await client.sendMedia({ toUserId: 'u1', bytes, fileName: 'a.txt', kind: 'file' });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);

  const upload = JSON.parse(calls[0].body);
  assert.equal(upload.media_type, 3);
  assert.equal(upload.rawsize, bytes.length);
  assert.equal(upload.filesize, aesEcbPaddedSize(bytes.length));
  assert.match(upload.rawfilemd5, /^[0-9a-f]{32}$/);
  assert.match(upload.aeskey, /^[0-9a-f]{32}$/);

  const send = JSON.parse(calls[2].body);
  const item = send.msg.item_list[0];
  assert.equal(item.type, 4);
  assert.equal(item.file_item.file_name, 'a.txt');
  assert.equal(item.file_item.len, String(bytes.length));
  assert.equal(item.file_item.media.encrypt_query_param, 'DL1');
  assert.equal(item.file_item.media.encrypt_type, 1);

  // media.aes_key 是 base64(hex ascii)，能被自己解析回原 key
  const key = parseMediaAesKey({ media: item.file_item.media });
  assert.equal(key.length, 16);
});

test('sendMedia 图片走 type=2 image_item', async () => {
  let sendBody = null;
  const fakeFetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('getuploadurl')) return { ok: true, json: async () => ({ errcode: 0, upload_param: 'U' }) };
    if (target.includes('/c2c/upload')) return { ok: true, status: 200, headers: { get: () => 'DL' }, json: async () => ({}) };
    sendBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ret: 0 }) };
  };
  const client = new IlinkClient({ token: 't', fetchImpl: fakeFetch });
  await client.sendMedia({ toUserId: 'u1', bytes: Buffer.from([1, 2, 3]), fileName: 'x.png', kind: 'image' });
  const item = sendBody.msg.item_list[0];
  assert.equal(item.type, 2);
  assert.ok(item.image_item.mid_size > 0);
});

test('上传被拒会抛错而不是静默', async () => {
  const fakeFetch = async (url) => {
    const target = String(url);
    if (target.includes('getuploadurl')) return { ok: true, json: async () => ({ errcode: 0, upload_param: 'U' }) };
    return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) };
  };
  const client = new IlinkClient({ token: 't', fetchImpl: fakeFetch });
  await assert.rejects(
    client.sendMedia({ toUserId: 'u', bytes: Buffer.from('x'), fileName: 'a.bin' }),
    /上传失败/,
  );
});
