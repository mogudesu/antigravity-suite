/**
 * QQ OneBot v11（NapCat / Lagrange）：反向 WS 优先，也支持主动连。
 *
 * 这是「个人 QQ 号」的兼容通道；官方机器人走 qq-official-bot.mjs。
 * 关键：读循环绝不能 await 业务处理，否则会等不到自己发出的 echo 回执而自锁。
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Dedupe, mentionsBot, splitText, toPlainText } from '../shared/text.mjs';
import { IMAGE_EXT, MAX_MEDIA_BYTES, downloadToTemp, sanitizeFileName } from '../shared/media.mjs';

export function parseOneBotEvent(event, { selfId = '', groupAtRequired = true } = {}) {
  if (event?.post_type !== 'message') return null;
  const type = event.message_type;
  if (type !== 'private' && type !== 'group') return null;
  const senderId = String(event.user_id || '');
  if (selfId && senderId === String(selfId)) return null;

  const raw = String(event.raw_message || '');
  const segments = Array.isArray(event.message) ? event.message : [];
  if (type === 'group' && groupAtRequired) {
    const self = selfId || String(event.self_id || '');
    if (!mentionsBot(segments, self, raw)) return null;
  }

  const parts = [];
  const media = [];
  for (const segment of segments) {
    const data = segment?.data || {};
    if (segment.type === 'text') parts.push(String(data.text || ''));
    else if (segment.type === 'image') {
      parts.push('[图片]');
      media.push({ kind: 'image', data });
    } else if (segment.type === 'face') {
      parts.push(faceToText(data.id));
    } else if (segment.type === 'mface') {
      const summary = data.summary || data.emoji_id || '';
      parts.push(summary ? `[表情包 ${summary}]` : '[表情包]');
      if (data.url) media.push({ kind: 'image', data: { url: data.url, file: data.emoji_id || 'mface' } });
    } else if (segment.type === 'record') parts.push('[语音]');
    else if (segment.type === 'file') {
      parts.push(`[文件 ${data.file || data.name || ''}]`);
      media.push({ kind: 'file', data });
    }
  }
  let text = parts.join('').trim();
  if (!text) text = raw.replace(/\[CQ:[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text && !media.length) return null;

  const target = type === 'group' ? event.group_id : event.user_id;
  return {
    chatId: `${type}:${target}`,
    chatType: type,
    userId: senderId,
    senderName: event.sender?.card || event.sender?.nickname || '',
    messageId: String(event.message_id || ''),
    text,
    media,
  };
}

export class OneBotChannel {
  constructor({ bot, secrets, hub, logger = console, fetchImpl = fetch }) {
    this.bot = bot;
    this.secrets = secrets;
    this.hub = hub;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.server = null;
    this.socket = null;
    this.pending = new Map();
    this.dedupe = new Dedupe();
    this.status = 'offline';
    this.lastError = '';
  }

  async start() {
    const cfg = this.secrets || {};
    if (cfg.mode === 'forward') {
      if (!cfg.wsUrl) {
        this.status = 'need-credentials';
        return;
      }
      this._connectForward(cfg.wsUrl);
      return;
    }
    const port = Number(cfg.port || 8792);
    const path = cfg.path || '/onebot/ws';
    this.server = new WebSocketServer({ port, path });
    this.server.on('connection', (socket) => this._attach(socket));
    this.server.on('error', (error) => {
      this.status = 'error';
      this.lastError = error?.message || String(error);
    });
    this.status = 'listening';
    this.logger.info?.(`[qq-onebot] 等待 NapCat 反连 ws://127.0.0.1:${port}${path}`);
  }

  _attach(socket) {
    this.socket = socket;
    this.status = 'online';
    socket.on('message', (data) => {
      let payload;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      if (payload.echo) {
        const entry = this.pending.get(payload.echo);
        if (entry) {
          this.pending.delete(payload.echo);
          if (payload.retcode && payload.retcode !== 0) {
            entry.reject(new Error(payload.message || payload.wording || `OneBot 调用失败（${payload.retcode}）`));
          } else {
            entry.resolve(payload);
          }
        }
        return;
      }
      // 业务处理丢后台，读循环保持空闲
      this._onEvent(payload).catch((error) => this.logger.warn?.(`[qq-onebot] ${error?.message}`));
    });
    socket.on('close', () => {
      this.status = 'disconnected';
      this.socket = null;
    });
  }

  _connectForward(url) {
    const socket = new WebSocket(url, { headers: this.secrets.token ? { Authorization: `Bearer ${this.secrets.token}` } : {} });
    socket.on('open', () => {
      this.status = 'online';
      this.socket = socket;
    });
    socket.on('message', (data) => {
      try {
        const payload = JSON.parse(String(data));
        if (payload.echo) {
          const entry = this.pending.get(payload.echo);
          if (entry) {
            this.pending.delete(payload.echo);
            if (payload.retcode && payload.retcode !== 0) {
              entry.reject(new Error(payload.message || payload.wording || `OneBot 调用失败（${payload.retcode}）`));
            } else {
              entry.resolve(payload);
            }
          }
          return;
        }
        this._onEvent(payload).catch(() => {});
      } catch {
        /* ignore */
      }
    });
    socket.on('close', () => {
      this.status = 'disconnected';
      setTimeout(() => this._connectForward(url), 5000);
    });
    socket.on('error', () => {});
  }

  async _onEvent(event) {
    const parsed = parseOneBotEvent(event, {
      selfId: String(this.secrets?.selfId || ''),
      groupAtRequired: this.bot.groupAtOptional !== true,
    });
    if (!parsed) return;
    if (!this.dedupe.check(parsed.messageId)) return;
    const attachments = await this._downloadAll(parsed);
    let text = parsed.text || (attachments.length ? '（收到图片/文件）' : '（收到一条空消息）');
    if (parsed.media?.length && !attachments.length) text += '（附件下载失败，请重试）';
    await this.hub.dispatch({
      bot: this.bot,
      chatId: parsed.chatId,
      text,
      channel: this,
      messageId: parsed.messageId,
      senderName: parsed.senderName,
      attachments,
    });
  }

  /** 入站图片/文件落盘到临时目录，交给 Agent 直接读路径。 */
  async _downloadAll(parsed) {
    const items = Array.isArray(parsed.media) ? parsed.media : [];
    if (!items.length) return [];
    const saved = [];
    for (const [index, item] of items.entries()) {
      try {
        const url = await this._mediaUrl(item, parsed);
        if (!url) throw new Error('没有可下载的媒体地址');
        const fallbackName = item.kind === 'image' ? `image-${index + 1}.jpg` : `file-${index + 1}`;
        const name = sanitizeFileName(
          item.data?.name || item.data?.file_name || item.data?.file || fallbackName,
          fallbackName,
        );
        const result = await downloadToTemp(url, { fetchImpl: this.fetchImpl, prefix: 'qq', name, kind: item.kind });
        saved.push(result.file);
      } catch (error) {
        this.logger.warn?.(`[qq-onebot] 下载附件失败：${error?.message || error}`);
      }
    }
    return saved;
  }

  async _mediaUrl(item, parsed) {
    const data = item.data || {};
    for (const candidate of [data.url, data.file]) {
      if (/^https?:\/\//i.test(String(candidate || ''))) return candidate;
    }
    if (item.kind === 'image' && data.file) {
      const res = await this._call('get_image', { file: data.file });
      const payload = res?.data || {};
      return [payload.url, payload.file].find((value) => /^https?:\/\//i.test(String(value || ''))) || '';
    }
    if (item.kind === 'file') {
      const [type, target] = String(parsed.chatId || '').split(':');
      const action = type === 'group' ? 'get_group_file_url' : 'get_private_file_url';
      const params = type === 'group'
        ? { group_id: Number(target), file_id: data.file_id || data.file, busid: data.busid }
        : { user_id: Number(target), file_id: data.file_id || data.file };
      const res = await this._call(action, params);
      const payload = res?.data || {};
      return [payload.url, payload.file].find((value) => /^https?:\/\//i.test(String(value || ''))) || '';
    }
    return '';
  }

  async _call(action, params = {}, timeoutMs = 20000) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('OneBot 未连接');
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 调用超时：${action}`));
      }, timeoutMs);
      this.pending.set(echo, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ action, params, echo }));
    });
  }

  async _sendMessage(type, target, message, timeoutMs = 60000) {
    if (type === 'group') {
      await this._call('send_group_msg', { group_id: Number(target), message }, timeoutMs);
    } else {
      await this._call('send_private_msg', { user_id: Number(target), message }, timeoutMs);
    }
  }

  async sendText(chatId, text) {
    const [type, target] = chatId.split(':');
    const chunks = splitText(toPlainText(text), 1500);
    for (const chunk of chunks) {
      const message = [{ type: 'text', data: { text: chunk } }];
      if (type === 'group') await this._call('send_group_msg', { group_id: Number(target), message });
      else await this._call('send_private_msg', { user_id: Number(target), message });
    }
    return true;
  }

  /** QQ 不发"收到，正在思考"文本：过程态交给输入中提示，聊天记录里不再多一条。 */
  async sendAck() {
    return false;
  }

  async sendApproval(chatId, approval) {
    return this.sendText(
      chatId,
      [`⚠️ 需要确认：${approval.title}`, approval.detail || '', `回复 /allow ${approval.id} 或 /deny ${approval.id}`]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /** 出站图片走 image 气泡；普通文件走 upload_*_file。 */
  async sendFile(chatId, filePath, { caption = '' } = {}) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MEDIA_BYTES) return false;
    const [type, target] = String(chatId || '').split(':');
    if (!target) return false;
    const name = path.basename(filePath);
    try {
      if (IMAGE_EXT.test(name)) {
        const data = { file: pathToFileURL(filePath).href };
        try {
          await this._sendMessage(type, target, [{ type: 'image', data }], 120000);
        } catch {
          data.file = `base64://${fs.readFileSync(filePath).toString('base64')}`;
          await this._sendMessage(type, target, [{ type: 'image', data }], 120000);
        }
      } else if (type === 'group') {
        await this._call('upload_group_file', { group_id: Number(target), file: filePath, name }, 180000);
      } else {
        await this._call('upload_private_file', { user_id: Number(target), file: filePath, name }, 180000);
      }
      if (caption) await this.sendText(chatId, caption);
      return true;
    } catch (error) {
      this.logger.warn?.(`[qq-onebot] 发送文件失败：${error?.message || error}`);
      return false;
    }
  }

  describe() {
    return { status: this.status, lastError: this.lastError };
  }

  stop() {
    this.status = 'offline';
    try {
      this.socket?.close();
      this.server?.close();
    } catch {
      /* ignore */
    }
  }
}

const FACE_EMOJI = {
  0: '😊', 1: '😣', 2: '😍', 4: '😎', 5: '😭', 6: '😳', 7: '🤐', 8: '😴', 9: '😢', 10: '😰',
  11: '😡', 12: '🤗', 13: '⭐', 14: '🌟', 15: '🌙', 16: '👍', 18: '✊', 21: '😊', 23: '😢',
  25: '🤔', 26: '😱', 27: '😅', 28: '😁', 29: '🤮', 30: '💪', 32: '🎉', 33: '😤', 34: '😏',
  35: '🥺', 49: '🐷', 53: '🎂', 60: '☕', 63: '🌹', 66: '❤️', 74: '🌞', 75: '🌛', 76: '👏',
  78: '🤝', 79: '✌️', 85: '🎅', 89: '🍉', 96: '😓', 97: '😲', 100: '😂', 101: '😊', 104: '😭',
  106: '😱', 109: '😘', 111: '🥰', 179: '😊', 182: '🎵', 183: '🙏', 184: '🫶', 185: '👍', 186: '👎',
};

function faceToText(id) {
  const key = String(id ?? '');
  return FACE_EMOJI[key] || (key ? `【QQ表情 ${key}】` : '【表情】');
}
