/**
 * QQ 官方机器人（@tencent-connect/qqbot-nodejs）。
 *
 * 能力：私聊/群聊消息、Markdown 自动降级、群聊 @ 门禁、正在输入、卡片按钮。
 * 凭据：AppID + AppSecret（面板里填，或扫码一键创建后自动回填）。
 */
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import fs from 'node:fs';
import path from 'node:path';
import { splitText, toPlainText, Dedupe } from '../shared/text.mjs';
import { IMAGE_EXT, downloadToTemp, sanitizeFileName } from '../shared/media.mjs';

export class QQOfficialBot {
  constructor({ bot, secrets, hub, logger = console, fetchImpl = fetch }) {
    this.bot = bot;
    this.secrets = secrets;
    this.hub = hub;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.sdk = null;
    this.status = 'offline';
    this.lastError = '';
    this.dedupe = new Dedupe();
    this.targets = new Map(); // chatId -> replyTarget
  }

  async start() {
    const { appId, appSecret } = this.secrets || {};
    if (!appId || !appSecret) {
      this.status = 'need-credentials';
      return;
    }
    this.sdk = new QQBot({ appId, appSecret, logger: this.logger });
    this.sdk.on('message', async (ctx, message) => {
      try {
        await this._onMessage(ctx, message);
      } catch (error) {
        this.logger.error?.(`[qq] 处理消息失败：${error?.message || error}`);
      }
    });
    this.status = 'connecting';
    // 官方 SDK 的 start() 在网关 READY 之后并不落定；直接 await 它会永久卡住
    // hub 的 bootstrap（设置面板注入、会话镜像、生物钟、超时补发全都在它后面）。
    let failure = null;
    const starting = Promise.resolve()
      .then(() => this.sdk.start())
      .catch((error) => { failure = error; });
    await Promise.race([starting, new Promise((resolve) => setTimeout(resolve, 8000))]);
    if (failure) {
      this.status = 'error';
      this.lastError = failure?.message || String(failure);
      this.logger.error?.(`[qq] 启动失败：${this.lastError}`);
      return;
    }
    this.status = 'online';
    starting.catch((error) => {
      // 迟到的失败仍然要记下来，只是不再阻塞任何人
      this.status = 'error';
      this.lastError = error?.message || String(error);
      this.logger.error?.(`[qq] 启动失败：${this.lastError}`);
    });
  }

  stop() {
    this.status = 'offline';
    try {
      this.sdk?.stop?.();
    } catch {
      /* ignore */
    }
  }

  async _onMessage(ctx, message) {
    const scope = message?.replyTarget?.scope || 'c2c';
    const chatId = message?.replyTarget?.id || message?.replyTarget?.openid || message?.senderId || '';
    if (!chatId) return;
    if (!this.dedupe.check(message?.id || message?.messageId)) return;
    this.targets.set(chatId, message.replyTarget);

    // 群聊必须 @ 到机器人
    if (scope === 'group' && !this.bot.groupAtOptional) {
      const mentioned = Boolean(message?.mentioned) || Boolean(message?.mentions?.length);
      if (!mentioned) {
        this.logger.debug?.('[qq] 群里没 @ 我，忽略');
        return;
      }
    }

    let text = String(message?.content || '').trim();
    const mediaItems = collectAttachments(message);
    const hasMedia = mediaItems.length > 0;
    if (!text && !hasMedia) return;
    const attachments = hasMedia ? await this._downloadAll(mediaItems) : [];
    if (!text && attachments.length) text = '（收到图片/文件）';
    if (!text) text = '（收到一条空消息）';
    if (hasMedia && !attachments.length) text += '（附件下载失败，请重试）';

    await this.hub.dispatch({
      bot: this.bot,
      chatId,
      text,
      channel: this,
      messageId: message?.id || '',
      attachments,
    });
  }

  /** 入站图片/文件落盘到临时目录，交给 Agent 直接读路径。 */
  async _downloadAll(items) {
    const saved = [];
    for (const [index, item] of items.entries()) {
      try {
        const url = item?.url || item?.voice_wav_url;
        if (!url) throw new Error('没有附件下载地址');
        const contentType = String(item.content_type || '');
        const isImage = contentType.startsWith('image/') || IMAGE_EXT.test(String(item.filename || ''));
        const ext = imageExtFromMime(contentType) || path.extname(String(item.filename || '')) || (isImage ? '.jpg' : '.bin');
        const fallbackName = `${isImage ? 'image' : 'file'}-${index + 1}${ext}`;
        const name = sanitizeFileName(item.filename || fallbackName, fallbackName);
        const result = await downloadToTemp(url, {
          fetchImpl: this.fetchImpl,
          prefix: 'qqbot',
          name,
          kind: isImage ? 'image' : 'file',
        });
        saved.push(result.file);
      } catch (error) {
        this.logger.warn?.(`[qq] 下载附件失败：${error?.message || error}`);
      }
    }
    return saved;
  }

  async sendText(chatId, text) {
    const target = this.targets.get(chatId);
    if (!target) return false;
    for (const chunk of splitText(toPlainText(text), 1500)) {
      await this.sdk.sendText(target, chunk);
    }
    return true;
  }

  /** QQ 不发"收到，正在思考"文本：过程态交给输入中提示，聊天记录里不再多一条。 */
  async sendAck() {
    return false;
  }

  async beginTyping(chatId) {
    const target = this.targets.get(chatId);
    try {
      await this.sdk?.sendTyping?.(target);
    } catch {
      /* typing 是锦上添花 */
    }
  }

  async endTyping() {}

  async sendApproval(chatId, approval) {
    // QQ 官方私聊支持按钮；没有就用数字菜单兜底
    return this.sendText(
      chatId,
      [`⚠️ 需要确认：${approval.title}`, approval.detail || '', `回复 /allow ${approval.id} 或 /deny ${approval.id}`]
        .filter(Boolean)
        .join('\n'),
    );
  }

  async sendFile(chatId, filePath, { caption = '' } = {}) {
    const target = this.targets.get(chatId);
    if (!target || !filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return false;
    try {
      if (IMAGE_EXT.test(filePath)) {
        await this.sdk.sendImage(target, { localPath: filePath }, { content: caption });
      } else {
        await this.sdk.sendFile(target, { localPath: filePath }, { fileName: path.basename(filePath), content: caption });
      }
      return true;
    } catch (error) {
      this.logger.warn?.(`[qq] 发送文件失败：${error?.message || error}`);
      return false;
    }
  }

  describe() {
    return { status: this.status, lastError: this.lastError };
  }
}

function imageExtFromMime(contentType) {
  if (/jpeg|jpg/i.test(contentType)) return '.jpg';
  if (/png/i.test(contentType)) return '.png';
  if (/gif/i.test(contentType)) return '.gif';
  if (/webp/i.test(contentType)) return '.webp';
  if (/bmp/i.test(contentType)) return '.bmp';
  return '';
}

function collectAttachments(message) {
  const list = [
    ...(Array.isArray(message?.attachments) ? message.attachments : []),
    ...(Array.isArray(message?.msg_elements) ? message.msg_elements.flatMap((item) => item?.attachments || []) : []),
  ];
  const seen = new Set();
  return list.filter((item) => {
    const url = item?.url || item?.voice_wav_url;
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}
