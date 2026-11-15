/**
 * 微信机器人控制器：扫码登录 → 长轮询 → 交给 hub → 回推（含"正在输入"、长文本切分、图片/文件直传）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IlinkClient, parseInbound } from './ilink-api.mjs';
import { splitText, toPlainText, Dedupe } from '../shared/text.mjs';
import { downloadToTemp } from '../shared/media.mjs';
import { paths, ensureRuntimeDirs } from '../../store/paths.mjs';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export class WeixinBot {
  constructor({ bot, secrets, hub, logger = console, fetchImpl = fetch, onCursor = null, seenIds = [], onSeen = null }) {
    this.bot = bot;
    this.secrets = secrets || {};
    this.hub = hub;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.onCursor = typeof onCursor === 'function' ? onCursor : null;
    this.client = null;
    this.running = false;
    this._abortController = null;
    this.dedupe = new Dedupe({ limit: 200, initial: seenIds, onChange: onSeen });
    this.typingTickets = new Map();
    this.status = 'offline';
    this.lastError = '';
  }

  async start() {
    if (this.running) return;
    const token = this.secrets?.botToken;
    if (!token) {
      this.status = 'need-scan';
      return;
    }
    this.client = new IlinkClient({ baseUrl: this.secrets.baseUrl || undefined, token, fetchImpl: this.fetchImpl });
    this.running = true;
    this._abortController = new AbortController();
    try {
      await this.client.notifyStart();
      if (!this.running) return;
      this.status = 'online';
    } catch (error) {
      if (!this.running) return;
      if (error?.code === 'session-expired') {
        this.status = 'need-scan';
        this.lastError = 'errcode -14：微信会话过期，请在面板重新扫码';
        this.running = false;
        return;
      }
      this.status = 'reconnecting';
      this.lastError = error?.message || String(error);
    }
    if (this.running) this._loop();
  }

  stop() {
    this.running = false;
    this.status = 'offline';
    try {
      this._abortController?.abort();
    } catch {
      /* ignore */
    }
    this._abortController = null;
  }

  async _loop() {
    let cursor = this.secrets?.getUpdatesBuf || '';
    const signal = this._abortController?.signal;
    while (this.running) {
      try {
        const { messages, cursor: next } = await this.client.getUpdates({ cursor, timeoutMs: 35000, signal });
        if (!this.running) break;
        if (next && next !== cursor) {
          cursor = next;
          this.secrets.getUpdatesBuf = next;
          try {
            await this.onCursor?.(next);
          } catch (error) {
            this.logger.warn?.(`[weixin] 游标落盘失败：${error?.message || error}`);
          }
        }
        for (const message of messages) {
          if (!this.running) break;
          await this._handle(message);
        }
        if (!this.running) break;
        this.status = 'online';
        this.lastError = '';
      } catch (error) {
        if (!this.running) break;
        if (error?.code === 'session-expired') {
          this.status = 'need-scan';
          this.lastError = 'errcode -14：微信会话过期，请在面板重新扫码';
          this.logger.warn?.(`[weixin] ${this.lastError}`);
          this.running = false;
          return;
        }
        this.status = 'reconnecting';
        this.lastError = error?.message || String(error);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  }

  async _handle(message) {
    const inbound = parseInbound(message);
    const hasMedia = inbound.images.length || inbound.files.length || inbound.stickers.length;
    if (!inbound.text && !hasMedia) return;
    const rawTs = message?.create_time_ms ?? message?.create_time ?? message?.timestamp ?? '';
    const dedupeKey =
      inbound.messageId ||
      (rawTs !== '' ? `ts:${inbound.fromUserId}:${rawTs}:${inbound.text.slice(0, 80)}:${hasMedia ? 1 : 0}` : '');
    if (!this.dedupe.check(dedupeKey)) return;
    if (this.bot.ownerUserId && inbound.fromUserId && this.bot.ownerUserId !== inbound.fromUserId) {
      this.logger.info?.(`[weixin] 忽略非主人消息：${inbound.fromUserId}`);
      return;
    }

    const attachments = await this._downloadAll(inbound);
    let text = inbound.text || (attachments.length ? '（我发了图片/文件，路径在下面）' : '（收到一条空消息）');
    if (hasMedia && !attachments.length) text += '（附件下载失败，请重试）';

    await this.hub.dispatch({
      bot: this.bot,
      chatId: inbound.fromUserId,
      text,
      contextToken: inbound.contextToken,
      attachments,
      quoted: inbound.quoted,
      channel: this,
    });
  }

  /** 入站图片/文件落盘到临时目录，交给 Agent 直接读路径。 */
  async _downloadAll(inbound) {
    const items = [
      ...inbound.images.map((item) => ({ item, kind: 'image' })),
      ...inbound.files.map((item) => ({ item, kind: 'file' })),
      ...inbound.stickers.map((item) => ({ item, kind: 'image' })),
    ];
    if (!items.length) return [];
    const dir = ensureRuntimeDirs().tmp;
    const saved = [];
    for (const [index, { item, kind }] of items.entries()) {
      try {
        if (kind === 'image' && (item.url || item.full_url) && !(item.media || item.aeskey)) {
          const result = await downloadToTemp(item.url || item.full_url, { prefix: 'wx', name: 'sticker', kind: 'image' });
          saved.push(result.file);
          continue;
        }
        const bytes = await this.client.downloadMedia({ item });
        if (bytes.length > MAX_MEDIA_BYTES) {
          this.logger.warn?.('[weixin] 媒体过大，跳过', bytes.length);
          continue;
        }
        const name = item.file_name || item.name || `${kind}-${index + 1}`;
        const ext = path.extname(name) || (kind === 'image' ? '.jpg' : '.bin');
        const file = path.join(dir, `wx-${Date.now()}-${randomUUID().slice(0, 6)}${ext}`);
        fs.writeFileSync(file, bytes);
        saved.push(file);
      } catch (error) {
        this.logger.warn?.(`[weixin] 下载媒体失败：${error?.message || error}`);
      }
    }
    return saved;
  }

  async _typing(toUserId, contextToken, on) {
    try {
      let ticket = this.typingTickets.get(toUserId);
      if (!ticket) {
        const config = await this.client.getConfig({ toUserId, contextToken });
        ticket = config.typingTicket;
        if (ticket) this.typingTickets.set(toUserId, ticket);
      }
      if (ticket) await this.client.sendTyping({ toUserId, typingTicket: ticket, status: on ? 1 : 2 });
    } catch (error) {
      this.logger.debug?.(`[weixin] typing 失败：${error?.message}`);
    }
  }

  /** 由 hub 调用的统一出口。 */
  async sendText(chatId, text, { contextToken = '' } = {}) {
    const chunks = splitText(toPlainText(text), 1800);
    for (const chunk of chunks) {
      await this.client.sendText({ toUserId: chatId, text: chunk, contextToken });
    }
    return true;
  }

  /** 出站图片/文件：getuploadurl + AES-128-ECB + CDN 上传 + 原生气泡。 */
  async sendFile(chatId, filePath, { caption = '', contextToken = '' } = {}) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES) return false;
    const bytes = fs.readFileSync(filePath);
    const kind = IMAGE_EXT.test(filePath) ? 'image' : 'file';
    try {
      await this.client.sendMedia({
        toUserId: chatId,
        bytes,
        fileName: path.basename(filePath),
        kind,
        contextToken,
      });
      if (caption) await this.sendText(chatId, caption, { contextToken });
      return true;
    } catch (error) {
      this.logger.warn?.(`[weixin] 发送文件失败：${error?.message || error}`);
      return false;
    }
  }

  /** 微信不发"收到，正在思考"文本：用输入中状态代替，聊天记录里只留正式答复。 */
  async sendAck() {
    return false;
  }

  async beginTyping(chatId, contextToken = '') {
    await this._typing(chatId, contextToken, true);
  }

  async endTyping(chatId) {
    await this._typing(chatId, '', false);
  }

  describe() {
    return { status: this.status, lastError: this.lastError, tmpDir: paths().tmp };
  }
}
