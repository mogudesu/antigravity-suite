/**
 * 微信官方 iLink Bot 协议客户端（协议版本 2.4.6）。
 *
 * 全流程免 PC 微信、免公网：
 *   get_bot_qrcode → 手机扫码 → get_qrcode_status 轮询到 confirmed 拿到 bot_token
 *   → getupdates 35s 长轮询收消息 → sendmessage 回消息 / sendtyping 维持"正在输入"
 *
 * 注意：所有请求必须打到 *.weixin.qq.com，这里做了域名校验，避免把 token 发错地方。
 */
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export const WEIXIN_BASE = 'https://ilinkai.weixin.qq.com/';
export const PROTOCOL_VERSION = '2.4.6';
export const BOT_TYPE = '3';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const LONG_POLL_MS = 35_000;

export class WeixinApiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'WeixinApiError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function assertWeixinHost(url) {
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.weixin.qq.com')) {
    throw new WeixinApiError('untrusted-host', `拒绝访问非微信域名：${host}`);
  }
}

function baseInfo() {
  return { channel_version: PROTOCOL_VERSION, bot_agent: 'antigravity-remote-mogu/2.0' };
}

function headers(token) {
  const common = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  };
  if (!token) return common;
  return {
    ...common,
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
    Authorization: `Bearer ${token}`,
  };
}

async function request({ baseUrl = WEIXIN_BASE, endpoint, method = 'POST', body, token, timeoutMs = 15_000, signal, fetchImpl = fetch }) {
  const url = new URL(endpoint, baseUrl);
  assertWeixinHost(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      method,
      headers: headers(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!res.ok) throw new WeixinApiError('http-error', `微信服务 HTTP ${res.status}`, { status: res.status });
    const data = await res.json();
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new WeixinApiError('timeout', '微信服务请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export class IlinkClient {
  constructor({ baseUrl = WEIXIN_BASE, token = '', fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  /** 申请扫码二维码。 */
  async beginLogin({ botType = BOT_TYPE, localTokens = [], signal } = {}) {
    const data = await request({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      body: { local_token_list: localTokens.slice(-10) },
      timeoutMs: 10_000,
      signal,
    });
    if (data?.errcode && data.errcode !== 0) {
      throw new WeixinApiError('qr-rejected', `微信拒绝了二维码申请（${data.errcode}）`);
    }
    const qrcode = String(data?.qrcode || '').trim();
    if (!qrcode) throw new WeixinApiError('invalid-qr', '微信没有返回二维码令牌');
    return { qrcode, qrcodeImage: String(data?.qrcode_img_content || '').trim() };
  }

  /** 轮询扫码状态：wait / scaned / confirmed / expired。 */
  async pollLogin({ qrcode, verifyCode = '', signal } = {}) {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const data = await request({ baseUrl: this.baseUrl, endpoint, method: 'GET', timeoutMs: LONG_POLL_MS, signal });
    const status = String(data?.status || data?.state || 'wait').toLowerCase();
    return {
      status,
      botToken: data?.bot_token || '',
      botId: data?.ilink_bot_id || '',
      userId: data?.ilink_user_id || '',
      baseUrl: data?.baseurl || data?.base_url || this.baseUrl,
      errcode: data?.errcode ?? 0,
    };
  }

  /** 35s 长轮询收消息。 */
  async getUpdates({ cursor = '', timeoutMs = LONG_POLL_MS, signal } = {}) {
    try {
      const data = await request({
        baseUrl: this.baseUrl,
        fetchImpl: this.fetchImpl,
        endpoint: 'ilink/bot/getupdates',
        body: { get_updates_buf: cursor, base_info: baseInfo() },
        token: this.token,
        timeoutMs,
        signal,
      });
      if (data?.errcode === -14) throw new WeixinApiError('session-expired', '微信会话已过期，需要重新扫码');
      return {
        messages: Array.isArray(data?.msgs) ? data.msgs : [],
        cursor: data?.get_updates_buf ?? cursor,
        raw: data,
      };
    } catch (error) {
      if (error instanceof WeixinApiError && error.code === 'timeout') {
        return { messages: [], cursor, timedOut: true };
      }
      throw error;
    }
  }

  /** 取 typing_ticket（用于"正在输入"）。 */
  async getConfig({ toUserId, contextToken = '', signal } = {}) {
    const data = await request({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      endpoint: 'ilink/bot/getconfig',
      token: this.token,
      body: { ilink_user_id: toUserId, ...(contextToken ? { context_token: contextToken } : {}), base_info: baseInfo() },
      timeoutMs: 10_000,
      signal,
    });
    return { typingTicket: String(data?.typing_ticket || '') };
  }

  /** status: 1 开始输入，2 结束。 */
  async sendTyping({ toUserId, typingTicket, status, signal } = {}) {
    if (!toUserId || !typingTicket) return false;
    await request({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      endpoint: 'ilink/bot/sendtyping',
      token: this.token,
      body: { ilink_user_id: toUserId, typing_ticket: typingTicket, status, base_info: baseInfo() },
      timeoutMs: 10_000,
      signal,
    });
    return true;
  }

  /** 发文本（微信单条不建议超过 1800 字，调用方负责切分）。 */
  async sendText({ toUserId, text, contextToken = '', runId = '', signal } = {}) {
    const clientId = `agb-weixin-${randomUUID()}`;
    const data = await request({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      endpoint: 'ilink/bot/sendmessage',
      token: this.token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          ...(contextToken ? { context_token: contextToken } : {}),
          ...(runId ? { run_id: runId } : {}),
        },
        base_info: baseInfo(),
      },
      signal,
    });
    if (data?.ret !== undefined && data.ret !== 0) {
      throw new WeixinApiError('send-rejected', `微信拒绝了消息（ret=${data.ret}）`);
    }
    return { messageId: clientId };
  }

  /** 上线通知：iLink 要求先 notifystart 再开始收消息（-14 = token 过期）。 */
  async notifyStart({ signal } = {}) {
    const data = await request({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      endpoint: 'ilink/bot/msg/notifystart',
      token: this.token,
      body: { base_info: baseInfo() },
      timeoutMs: 10_000,
      signal,
    });
    const code = data?.errcode ?? data?.ret ?? 0;
    if (code !== 0) {
      throw new WeixinApiError(code === -14 ? 'session-expired' : 'start-rejected', `微信上线失败（${code}）`);
    }
    return true;
  }

  /**
   * 发图片 / 文件：getuploadurl → AES-128-ECB 加密上传 CDN → sendmessage 带 media。
   * @param {{toUserId: string, bytes: Buffer, fileName: string, kind?: 'image'|'file', contextToken?: string}} options
   */
  async sendMedia({ toUserId, bytes, fileName, kind = 'file', contextToken = '', signal } = {}) {
    if (!toUserId || !Buffer.isBuffer(bytes) || !bytes.length) {
      throw new WeixinApiError('invalid-media', 'toUserId 与文件内容必填');
    }
    const mediaType = kind === 'image' ? 1 : 3;
    const fileKey = randomBytes(16).toString('hex');
    const aesKey = randomBytes(16);
    const ciphertextSize = aesEcbPaddedSize(bytes.byteLength);

    const uploadInfo = await request({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      endpoint: 'ilink/bot/getuploadurl',
      token: this.token,
      body: {
        filekey: fileKey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: bytes.byteLength,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: ciphertextSize,
        no_need_thumb: true,
        aeskey: aesKey.toString('hex'),
        base_info: baseInfo(),
      },
      timeoutMs: 20_000,
      signal,
    });
    if ((uploadInfo?.errcode ?? 0) !== 0 || (uploadInfo?.ret ?? 0) !== 0) {
      throw new WeixinApiError('upload-url-rejected', '微信拒绝了文件上传申请');
    }

    const uploadUrl = resolveUploadUrl(uploadInfo, fileKey);
    const ciphertext = encryptMedia(bytes, aesKey);
    const res = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(ciphertextSize) },
      body: ciphertext,
      redirect: 'error',
      signal,
    });
    if (!res.ok) throw new WeixinApiError('upload-failed', `文件上传失败（HTTP ${res.status}）`);
    const downloadParam = res.headers.get('x-encrypted-param');
    if (!downloadParam) throw new WeixinApiError('invalid-upload-response', '上传响应缺少 x-encrypted-param');

    const media = {
      encrypt_query_param: downloadParam,
      aes_key: Buffer.from(aesKey.toString('hex'), 'utf8').toString('base64'),
      encrypt_type: 1,
    };
    const item =
      kind === 'image'
        ? { type: 2, image_item: { media, mid_size: ciphertextSize } }
        : { type: 4, file_item: { media, file_name: fileName, len: String(bytes.byteLength) } };

    const sent = await request({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      endpoint: 'ilink/bot/sendmessage',
      token: this.token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: `agb-weixin-${randomUUID()}`,
          message_type: 2,
          message_state: 2,
          item_list: [item],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
        base_info: baseInfo(),
      },
      signal,
    });
    if ((sent?.ret ?? 0) !== 0) throw new WeixinApiError('send-rejected', `微信拒绝了文件消息（ret=${sent.ret}）`);
    return { ok: true, mediaType, size: bytes.byteLength, ciphertextSize };
  }

  /** 下载并解密入站图片/文件。 */
  async downloadMedia({ item, signal } = {}) {
    const media = item?.media || item;
    const key = parseMediaAesKey(item);
    const url = mediaDownloadUrl(media);
    const res = await this.fetchImpl(url, { signal, redirect: 'manual' });
    if (!res.ok) throw new WeixinApiError('download-failed', `媒体下载失败（HTTP ${res.status}）`);
    const ciphertext = Buffer.from(await res.arrayBuffer());
    return decryptMedia(ciphertext, key);
  }
}

// ---------------------------------------------------------------- 媒体加解密

export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CDN_HOST = 'novac2c.cdn.weixin.qq.com';

/** AES-128-ECB + PKCS#7 加密后的字节数（末位补 1 字节，所以是 size+1 向上取整）。 */
export function aesEcbPaddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16;
}

/** 从 image_item / file_item 里解析 16 字节 AES 密钥。 */
export function parseMediaAesKey(item) {
  const directHex = item?.aeskey || item?.media?.aeskey;
  if (typeof directHex === 'string' && /^[0-9a-fA-F]{32}$/.test(directHex.trim())) {
    return Buffer.from(directHex.trim(), 'hex');
  }
  const raw = item?.media?.aes_key;
  if (typeof raw !== 'string' || !raw) throw new WeixinApiError('invalid-media-key', '缺少媒体密钥');
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString('utf8');
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex');
  throw new WeixinApiError('invalid-media-key', '媒体密钥格式不对');
}

export function encryptMedia(bytes, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

export function decryptMedia(ciphertext, key) {
  const data = Buffer.from(ciphertext);
  const aesKey = Buffer.from(key);
  if (aesKey.length !== 16 || !data.length || data.length % 16 !== 0) {
    throw new WeixinApiError('invalid-ciphertext', '媒体密文或密钥无效');
  }
  const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function mediaDownloadUrl(media) {
  const query = media?.encrypt_query_param;
  if (query) return `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(query)}`;
  const full = String(media?.full_url || '');
  if (!full) throw new WeixinApiError('missing-media-url', '媒体没有下载地址');
  const url = new URL(full);
  if (url.protocol !== 'https:' || url.hostname !== CDN_HOST || !url.pathname.startsWith('/c2c/')) {
    throw new WeixinApiError('untrusted-media-url', `拒绝非微信 CDN 地址：${url.host}`);
  }
  return url.toString();
}

export function resolveUploadUrl(info, fileKey) {
  const full = info?.upload_full_url;
  const target = full
    ? new URL(full)
    : (() => {
        const url = new URL(`${CDN_BASE}/upload`);
        url.searchParams.set('encrypted_query_param', String(info?.upload_param || ''));
        url.searchParams.set('filekey', fileKey);
        return url;
      })();
  if (target.protocol !== 'https:' || target.hostname !== CDN_HOST || target.pathname !== '/c2c/upload') {
    throw new WeixinApiError('untrusted-upload-url', `拒绝非微信 CDN 上传地址：${target.host}`);
  }
  return target;
}

/** 从 getupdates 的一条消息里取出文本、发送者、引用。 */
export function parseInbound(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const texts = [];
  const images = [];
  const files = [];
  const stickers = [];
  let voiceText = '';
  for (const item of items) {
    if (item?.text_item?.text) texts.push(String(item.text_item.text));
    if (item?.voice_item) voiceText = String(item.voice_item.text || '');
    if (item?.image_item) images.push(item.image_item);
    if (item?.file_item) files.push(item.file_item);
    if (item?.sticker_item) stickers.push(item.sticker_item);
    if (item?.emoji_item) stickers.push(item.emoji_item);
    if (item?.emoji) stickers.push(item.emoji);
    for (const [key, value] of Object.entries(item || {})) {
      if (['type', 'text_item', 'voice_item', 'image_item', 'file_item', 'sticker_item', 'emoji_item', 'emoji'].includes(key)) continue;
      if (value && typeof value === 'object' && /sticker|emoji|emotion|expression/i.test(key)) stickers.push(value);
    }
  }
  if (stickers.length) {
    const labels = stickers.map((item) => item.text || item.desc || item.emoji_name || item.name || '').filter(Boolean);
    texts.push(labels.length ? labels.map((label) => `[表情 ${label}]`).join('') : '[表情包]');
  }
  const text = (texts.join('\n') || voiceText || '').trim();
  return {
    messageId: String(message?.msg_id || message?.message_id || message?.client_id || ''),
    fromUserId: String(message?.from_user_id || message?.sender || ''),
    contextToken: String(message?.context_token || ''),
    text,
    images,
    files,
    stickers,
    voiceText,
    quoted: message?.ref_msg || null,
    raw: message,
  };
}

export const __test__ = { baseInfo, headers, assertWeixinHost };
